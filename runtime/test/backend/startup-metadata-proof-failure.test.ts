import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openBackend, privateStartupMetadataPlacement } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { takeInstanceGuard } from '../../src/guard.ts';
import { ProcessSupervisor, processRoles } from '../../src/process.ts';
import { StartupMetadataSession } from '../../src/startup-metadata.ts';
import { companionFixture, type CompanionFixture } from '../support/companion.ts';

async function cleanMarkerFixture(): Promise<{ fixture: CompanionFixture; dataRoot: string }> {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root });
    const dataRoot = backend.scope.dataRoot;
    await backend.shutdown(true);
    backend = null;
    return { fixture, dataRoot };
  } catch (error) {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
    throw error;
  }
}

test('failed post-admission worker proof preserves marker and verifies worker stop', { timeout: 180000 }, async () => {
  const { fixture, dataRoot } = await cleanMarkerFixture();
  const originalMatches = StartupMetadataSession.prototype.matchesStartupEvidence;
  try {
    const marker = path.join(dataRoot, 'runtime.json');
    const before = await fs.readFile(marker);
    let proofs = 0;
    StartupMetadataSession.prototype.matchesStartupEvidence = function () { proofs++; return false; };
    try { await assert.rejects(openBackend({ companionRoot: fixture.root, startupMetadata: true, [privateStartupMetadataPlacement]: 'postGuard' })); }
    finally { StartupMetadataSession.prototype.matchesStartupEvidence = originalMatches; }
    assert.ok(proofs > 0);
    assert.deepEqual(await fs.readFile(marker), before);
    const supervisor = await ProcessSupervisor.create(dataRoot);
    await supervisor.verifyQuiescent('startupMetadata');
    const guard = await takeInstanceGuard(dataRoot, () => { throw new Error('Private guard was lost.'); });
    assert.equal(guard.held, true);
    await guard.release();
  } finally {
    StartupMetadataSession.prototype.matchesStartupEvidence = originalMatches;
    await fixture.close();
  }
});

test('invalid prior marker stops the private early worker before guard release', { timeout: 180000 }, async () => {
  const { fixture, dataRoot } = await cleanMarkerFixture();
  const marker = path.join(dataRoot, 'runtime.json');
  const invalid = Buffer.from('invalid marker');
  const originalSpawn = ProcessSupervisor.prototype.spawn;
  let metadataSpawns = 0;
  try {
    await fs.writeFile(marker, invalid);
    ProcessSupervisor.prototype.spawn = function (...args: Parameters<ProcessSupervisor['spawn']>) {
      if (args[0] === 'startupMetadata') { metadataSpawns += 1; }
      return originalSpawn.call(this, args[0], args[1]);
    };
    try {
      await assert.rejects(openBackend({ companionRoot: fixture.root, startupMetadata: true,
        [privateStartupMetadataPlacement]: 'postGuard' }));
    } finally { ProcessSupervisor.prototype.spawn = originalSpawn; }
    assert.equal(metadataSpawns, 1);
    assert.deepEqual(await fs.readFile(marker), invalid);
    const supervisor = await ProcessSupervisor.create(dataRoot);
    await supervisor.verifyQuiescentMany(processRoles);
    const guard = await takeInstanceGuard(dataRoot, () => { throw new Error('Private guard was lost.'); });
    assert.equal(guard.held, true);
    await guard.release();
  } finally {
    ProcessSupervisor.prototype.spawn = originalSpawn;
    await fixture.close();
  }
});

test('watcher reconciliation refusal stops the private early worker before guard release', { timeout: 180000 }, async () => {
  const { fixture, dataRoot } = await cleanMarkerFixture();
  const marker = path.join(dataRoot, 'runtime.json');
  const originalSpawn = ProcessSupervisor.prototype.spawn;
  const originalObserve = ProcessSupervisor.prototype.observeJobAbsent;
  const originalRun = ProcessSupervisor.prototype.run;
  let metadataSpawns = 0;
  let orphanAttempts = 0;
  try {
    const previous = JSON.parse(await fs.readFile(marker, 'utf8')) as Record<string, unknown>;
    const recorded = Buffer.from(JSON.stringify({ ...previous, watcher: { pid: 1234, created: '1234' } }));
    await fs.writeFile(marker, recorded);
    ProcessSupervisor.prototype.spawn = function (...args: Parameters<ProcessSupervisor['spawn']>) {
      if (args[0] === 'startupMetadata') { metadataSpawns += 1; }
      return originalSpawn.call(this, args[0], args[1]);
    };
    ProcessSupervisor.prototype.observeJobAbsent = function (role) {
      if (role === 'watcher') { return Promise.resolve(false); }
      return originalObserve.call(this, role);
    };
    ProcessSupervisor.prototype.run = function (...args: Parameters<ProcessSupervisor['run']>) {
      if (args[0] === 'metadata' && path.basename(args[1].args[2] ?? '') === 'Stop-OrphanWatcher.ps1') {
        orphanAttempts += 1;
        return Promise.reject(new Error('Private watcher reconciliation refusal.'));
      }
      return originalRun.apply(this, args);
    };
    try {
      await assert.rejects(openBackend({ companionRoot: fixture.root, startupMetadata: true,
        [privateStartupMetadataPlacement]: 'postGuard' }));
    } finally {
      ProcessSupervisor.prototype.spawn = originalSpawn;
      ProcessSupervisor.prototype.observeJobAbsent = originalObserve;
      ProcessSupervisor.prototype.run = originalRun;
    }
    assert.equal(metadataSpawns, 1);
    assert.equal(orphanAttempts, 1);
    assert.deepEqual(await fs.readFile(marker), recorded);
    const supervisor = await ProcessSupervisor.create(dataRoot);
    await supervisor.verifyQuiescentMany(processRoles);
    const guard = await takeInstanceGuard(dataRoot, () => { throw new Error('Private guard was lost.'); });
    assert.equal(guard.held, true);
    await guard.release();
  } finally {
    ProcessSupervisor.prototype.spawn = originalSpawn;
    ProcessSupervisor.prototype.observeJobAbsent = originalObserve;
    ProcessSupervisor.prototype.run = originalRun;
    await fixture.close();
  }
});
