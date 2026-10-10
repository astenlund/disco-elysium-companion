import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { DataRootUnavailableError, PathInspector } from '../../src/admission.ts';
import type { RuntimeConfig } from '../../src/config.ts';
import { Deadline } from '../../src/deadline.ts';
import { takeInstanceGuard } from '../../src/guard.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { ProcessSupervisor, readProcessIdentity, SupervisorError } from '../../src/process.ts';
import { readScope, scopeComponents, type RuntimeScope } from '../../src/scope.ts';
import { cleanupPublicationResidue } from '../../src/platform/publication-residue.ts';
import { readAdmittedRuntimeStatus, readRuntimeStatus } from '../../src/platform/status.ts';
import { reconcileWatcherOrphan } from '../../src/platform/watcher-supervisor.ts';
import { companionFixture } from '../support/companion.ts';
import { deferredRepair, repair } from '../backend/authority-fixtures.ts';

const now = '2026-10-08T01:00:00.0000000Z';
const game = 'platform-fixture';
const config: RuntimeConfig = { configVersion: 1, adapter: game, game, provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } };
const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));

async function seedScope(root: string, inspector: PathInspector, principal = 'fixture-principal'): Promise<RuntimeScope> {
  const dataRoot = path.join(root, ...scopeComponents(game, principal));
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'scope.json'), stringifyJson({ runtimeScopeVersion: 1, game, principal }));
  const scope = await readScope(inspector, { companionRoot: root, dataRoot, game, principal });
  assert.notEqual(scope, null);
  return scope!;
}

async function snapshot(root: string): Promise<readonly [string, string][]> {
  const files: [string, string][] = [];
  async function visit(relative: string): Promise<void> {
    const children = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const child of children) {
      const name = path.join(relative, child.name);
      if (child.isDirectory()) { await visit(name); }
      else { files.push([name, (await fs.readFile(path.join(root, name))).toString('base64')]); }
    }
  }
  await visit('');
  return files.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

describe('native runtime platform', () => {
  it('removes only admitted publication residue and preserves authoritative targets and unknown files', { timeout: 180000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    const scope = await seedScope(fixture.root, inspector);
    const guard = await takeInstanceGuard(scope.dataRoot, error => { throw error; });
    try {
      await fs.mkdir(path.join(scope.dataRoot, 'journal', 'events'), { recursive: true });
      await fs.mkdir(path.join(scope.dataRoot, 'operations'));
      const residue = ['runtime.json.' + '1'.repeat(32) + '.tmp', 'runtime.json.' + '2'.repeat(32) + '.bak',
        'journal/events/0000000000000001.json.' + '3'.repeat(32) + '.tmp', 'operations/jr-' + '4'.repeat(32) + '.json.' + '5'.repeat(32) + '.bak', 'prepared-context.txt'];
      for (const name of residue) { await fs.writeFile(path.join(scope.dataRoot, name), 'untrusted residue'); }
      await fs.writeFile(path.join(scope.dataRoot, 'runtime.json'), 'authoritative bytes');
      const unknown = 'unknown.json.' + 'a'.repeat(32) + '.tmp';
      await fs.writeFile(path.join(scope.dataRoot, unknown), 'unowned bytes');
      const result = await cleanupPublicationResidue(scope, guard, inspector, supervisor);
      assert.deepEqual([...result.removed].sort(), residue.map(name => path.normalize(name)).sort());
      assert.equal(await fs.readFile(path.join(scope.dataRoot, 'runtime.json'), 'utf8'), 'authoritative bytes');
      assert.equal(await fs.readFile(path.join(scope.dataRoot, unknown), 'utf8'), 'unowned bytes');
      assert.deepEqual((await cleanupPublicationResidue(scope, guard, inspector, supervisor)).removed, []);
    } finally { await guard.release(); await fixture.close(); }
  });

  it('rejects linked residue and lost binding before deleting any candidates', { timeout: 120000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    const scope = await seedScope(fixture.root, inspector);
    const guard = await takeInstanceGuard(scope.dataRoot, error => { throw error; });
    try {
      const first = path.join(scope.dataRoot, 'runtime.json.' + '1'.repeat(32) + '.tmp');
      const linked = path.join(scope.dataRoot, 'runtime.json.' + '2'.repeat(32) + '.bak');
      const sentinel = path.join(fixture.root, 'sentinel');
      await fs.writeFile(first, 'keep until complete admission');
      await fs.writeFile(sentinel, 'outside scope');
      await fs.link(sentinel, linked);
      await assert.rejects(cleanupPublicationResidue(scope, guard, inspector, supervisor), DataRootUnavailableError);
      assert.equal(await fs.readFile(first, 'utf8'), 'keep until complete admission');
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside scope');
      await fs.unlink(linked);
      await fs.writeFile(path.join(scope.dataRoot, 'scope.json'), '{}');
      await assert.rejects(cleanupPublicationResidue(scope, guard, inspector, supervisor), DataRootUnavailableError);
      assert.equal(await fs.readFile(first, 'utf8'), 'keep until complete admission');
      await assert.rejects(cleanupPublicationResidue(scope, { held: false }, inspector, supervisor), DataRootUnavailableError);
    } finally { await guard.release(); await fixture.close(); }
  });

  it('reads initialized and uninitialized status beside a held writer guard without changing files', { timeout: 240000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    await fs.mkdir(path.join(fixture.root, 'runtime'));
    await fs.writeFile(path.join(fixture.root, 'runtime', 'companion.config.json'), stringifyJson(config));
    try {
      const initial = await snapshot(fixture.root);
      const empty = await readRuntimeStatus(fixture.root);
      assert.equal(empty.initialized, false);
      assert.equal(empty.capacity, 'unavailable');
      assert.match(empty.liveStateNotice, /capacity/);
      assert.deepEqual(await snapshot(fixture.root), initial);
      const reply = await inspector.metadata(path.join(scripts, 'Get-Principal.ps1'), [], fixture.root);
      const principal = parseStrictJson(reply.stdout) as { sid: string };
      const scope = await seedScope(fixture.root, inspector, principal.sid);
      const guard = await takeInstanceGuard(scope.dataRoot, error => { throw error; });
      try {
        await fs.mkdir(path.join(scope.dataRoot, 'journal', 'events'), { recursive: true });
        await fs.mkdir(path.join(scope.dataRoot, 'operations'));
        await fs.writeFile(path.join(scope.dataRoot, 'runtime.json'), stringifyJson({ runtimeInstanceId: '1'.repeat(32), startedAt: now, cleanShutdown: false, watcher: null }));
        await fs.writeFile(path.join(scope.dataRoot, 'state-safety.json'), stringifyJson({ stateSafetyVersion: 1, generation: '2'.repeat(32), pendingCheck: null, correction: null, recoveryWitness: null }));
        await fs.writeFile(path.join(scope.dataRoot, 'journal', 'journal.json'), stringifyJson({ journalVersion: 1, journalId: 'journal', createdAt: now, highWaterSequence: 0, historyVerified: false }));
        await fs.writeFile(path.join(scope.dataRoot, 'journal', 'cursor-agent-session.json'), stringifyJson({ cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: 0, lastSentSequence: 0, lastAcceptedRevision: null, updatedAt: now }));
        const deferredRecord = deferredRepair();
        await fs.writeFile(path.join(scope.dataRoot, 'operations', deferredRecord.operationId + '.json'), stringifyJson({ ...deferredRecord, scopeSha256: scope.bindingSha256 }, 'state-event'));
        const ordinaryRepair = repair();
        for (let index = 1; index <= 19; index++) {
          const operationId = `jr-${'f'.repeat(30)}${index.toString(16).padStart(2, '0')}`;
          await fs.writeFile(path.join(scope.dataRoot, 'operations', `${operationId}.json`),
            stringifyJson({ ...ordinaryRepair, operationId, scopeSha256: scope.bindingSha256 }, 'state-event'));
        }
        const before = await snapshot(fixture.root);
        const status = await readAdmittedRuntimeStatus(scope, inspector, config, Deadline.after(120000));
        assert.equal(status.consistency, 'stable');
        assert.equal(status.initialized, true);
        assert.equal(status.operations.records.length, 20);
        assert.equal(status.runtime.status, 'valid');
        if (status.runtime.status === 'valid') { assert.equal(status.runtime.value.cleanShutdown, false); }
        assert.equal(status.journal.state, 'repairing');
        assert.equal(status.journal.historyVerified, false);
        assert.equal(status.journal.unacknowledgedEvents, 0);
        assert.equal(status.stateSafety.state, 'unavailable');
        assert.equal(status.stateSafety.carryRelease, 'unavailable');
        assert.equal(status.operations.records[0]!.carryRelease, 'waitingReplacement');
        for (const key of ['consumer', 'freshness', 'operational', 'watcher', 'provider', 'windowRecovery', 'capacity'] as const) { assert.equal(status[key], 'unavailable'); }
        assert.deepEqual(await snapshot(fixture.root), before);
        const broken = 'jr-' + '3'.repeat(32) + '.json';
        await fs.writeFile(path.join(scope.dataRoot, 'operations', broken), '{');
        const damaged = await readRuntimeStatus(fixture.root);
        assert.deepEqual(damaged.operations.unavailable, [broken]);
        assert.equal(damaged.journal.fault, 'repairFailed');
        assert.equal(damaged.stateSafety.pendingOperationSafety, true);
        assert.equal(await fs.readFile(path.join(scope.dataRoot, 'operations', broken), 'utf8'), '{');
      } finally { await guard.release(); }
    } finally { await fixture.close(); }
  });

  it('matches the recorded creation identity and kills the orphan job with its descendant', { timeout: 90000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const ownerScript = fileURLToPath(new URL('../fixtures/job-owner.ps1', import.meta.url));
    const owner = spawn('pwsh', ['-NoProfile', '-File', ownerScript, '-JobName', supervisor.jobName('watcher'), '-Mode', 'Tree', '-FixtureRoot', fixture.root],
      { windowsHide: true, shell: false, cwd: fixture.root, stdio: 'ignore' });
    const closed = new Promise<void>((resolve, reject) => { owner.once('close', () => resolve()); owner.once('error', reject); });
    try {
      let descendant: { pid: number; created: string } | null = null;
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        try { descendant = JSON.parse(await fs.readFile(path.join(fixture.root, 'descendant.json'), 'utf8')) as { pid: number; created: string }; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.notEqual(descendant, null);
      const identity = await readProcessIdentity(owner.pid!);
      assert.notEqual(identity, null);
      const previous = { runtimeInstanceId: 'a'.repeat(32), startedAt: now, cleanShutdown: false, watcher: identity! };
      await assert.rejects(reconcileWatcherOrphan({ ...previous, watcher: { ...identity!, created: (BigInt(identity!.created) + 1n).toString() } }, supervisor, fixture.root), SupervisorError);
      assert.deepEqual(await readProcessIdentity(owner.pid!), identity);
      await reconcileWatcherOrphan(previous, supervisor, fixture.root);
      await closed;
      assert.equal(await readProcessIdentity(owner.pid!), null);
      assert.equal(await readProcessIdentity(descendant!.pid), null);
      await reconcileWatcherOrphan(previous, supervisor, fixture.root);
    } finally { owner.kill(); await closed; await fixture.close(); }
  });
});
