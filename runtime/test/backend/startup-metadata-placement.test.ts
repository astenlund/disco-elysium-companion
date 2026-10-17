import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openBackend, privateStartupMetadataPlacement } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { ProcessSupervisor, SupervisorError } from '../../src/process.ts';
import { SessionHost } from '../../src/session-host.ts';
import { FakeProvider, instructionHash } from '../client/support.ts';
import { companionFixture } from '../support/companion.ts';

test('private placement selector opens exactly one worker at its selected marker boundary', { timeout: 180000 }, async () => {
  for (const placement of ['postGuard', 'postMarker'] as const) {
    const fixture = await companionFixture('runtime-owned-empty');
    let backend: RuntimeBackend | null = null;
    let markerStarted = false;
    const metadataSpawnAfterMarker: boolean[] = [];
    const originalSpawn = ProcessSupervisor.prototype.spawn;
    ProcessSupervisor.prototype.spawn = function (...args: Parameters<ProcessSupervisor['spawn']>) {
      if (args[0] === 'startupMetadata') { metadataSpawnAfterMarker.push(markerStarted); }
      return originalSpawn.call(this, args[0], args[1]);
    };
    try {
      await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
      backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true,
        ...(placement === 'postGuard' ? { [privateStartupMetadataPlacement]: 'postGuard' as const } : {}),
        onStartupPhase: phase => { if (phase === 'runtimeMarker') { markerStarted = true; } } });
      assert.deepEqual(metadataSpawnAfterMarker, [placement === 'postMarker']);
      await assert.rejects(backend.supervisor.verifyQuiescent('startupMetadata'), SupervisorError);
      await backend.closeStartupWorkers();
      await backend.supervisor.verifyQuiescent('startupMetadata');
      await backend.shutdown(true);
      backend = null;
    } finally {
      ProcessSupervisor.prototype.spawn = originalSpawn;
      try { if (backend !== null) { await backend.shutdown(true); } }
      finally { await fixture.close(); }
    }
  }
});

test('absent temporary root keeps the entire startup on one-shot transports', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  const opened: string[] = [];
  const originalSpawn = ProcessSupervisor.prototype.spawn;
  ProcessSupervisor.prototype.spawn = function (...args: Parameters<ProcessSupervisor['spawn']>) {
    if (args[0].startsWith('startup')) { opened.push(args[0]); }
    return originalSpawn.call(this, args[0], args[1]);
  };
  try {
    const temporary = path.join(fixture.root, '.tmp');
    assert.equal(path.dirname(temporary), fixture.root);
    assert.deepEqual(await fs.readdir(temporary), ['state-extraction-v2-entry-fence.lock']);
    const lock = path.join(temporary, 'state-extraction-v2-entry-fence.lock');
    const lockInfo = await fs.lstat(lock);
    assert.equal(lockInfo.isFile() && !lockInfo.isSymbolicLink(), true);
    await fs.unlink(lock);
    await fs.rmdir(temporary);
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true });
    assert.deepEqual(opened, []);
    await backend.closeStartupWorkers();
    await backend.shutdown(true);
    backend = null;
  } finally {
    ProcessSupervisor.prototype.spawn = originalSpawn;
    try { if (backend !== null) { await backend.shutdown(true); } }
    finally { await fixture.close(); }
  }
});

test('private early placement keeps non-owner chat closed to the provider', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime');
  let backend: RuntimeBackend | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true,
      [privateStartupMetadataPlacement]: 'postGuard' });
    const result = await backend.startup({ kind: 'chat' });
    assert.equal(result.notOwner, true);
    await backend.supervisor.verifyQuiescent('provider');
    await backend.closeStartupWorkers();
    await backend.supervisor.verifyQuiescent('startupMetadata');
    await backend.shutdown(true);
    const marker = JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'runtime.json'), 'utf8')) as { cleanShutdown: boolean };
    assert.equal(marker.cleanShutdown, true);
    backend = null;
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});

test('private early placement stops workers after provider start refusal', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  let host: SessionHost | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true,
      [privateStartupMetadataPlacement]: 'postGuard' });
    assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
    const provider = new FakeProvider();
    provider.failAll = true;
    host = new SessionHost({ backend, provider, instructionsSha256: instructionHash,
      providerTerminated: async () => backend!.supervisor.verifyQuiescent('provider'),
      verifyTools: async () => backend!.supervisor.verifyQuiescent('provider'),
      closeTools: async () => {}, delay: async () => {} });
    assert.equal(await host.start(), false);
    assert.equal(host.status.provider.state, 'failed');
    assert.equal(provider.sessions.length, 0);
    assert.ok(provider.calls.length > 0 && provider.calls.every(value => value === null));
    assert.equal((await backend.sessions.readBinding()).status, 'absent');
    await backend.closeStartupWorkers();
    await backend.supervisor.verifyQuiescent('startupMetadata');
    await host.shutdown();
    const marker = JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'runtime.json'), 'utf8')) as { cleanShutdown: boolean };
    assert.equal(marker.cleanShutdown, true);
    host = null;
    backend = null;
  } finally {
    if (host !== null) { await host.shutdown(); }
    else if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
