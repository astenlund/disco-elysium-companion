import assert from 'node:assert/strict';
import test from 'node:test';

import { DataRootUnavailableError, type PathInspector } from '../../src/admission.ts';
import { initializeRuntimeMarker } from '../../src/backend/marker-bootstrap.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import type { ProcessSupervisor } from '../../src/process.ts';
import { parseRuntimeRecord, type RuntimeRecord } from '../../src/runtime-records.ts';
import type { RuntimeScope } from '../../src/scope.ts';
import type { StartupMetadataSession } from '../../src/startup-metadata.ts';
import { observeStartupWorkerSources, type StartupWorkerEvidence } from '../../src/startup-worker-sources.ts';
import type { ScopeStorage, StoredDocument } from '../../src/storage.ts';

function fixture(failureAt: string | null = null, failure: Error = new Error('Fixture refusal.'),
  early?: { readonly source: 'present' | 'absent' | 'bindingDrift' | 'sourceDrift'; readonly matches: boolean; readonly guardHeld?: boolean;
    readonly guardLoss?: 'duringAdmission' | 'duringSource' | 'afterProof'; readonly exitAfterAdmission?: boolean }, withWatcher = false) {
  const calls: string[] = [];
  const step = (name: string) => { calls.push(name); if (name === failureAt) { throw failure; } };
  const guard = { held: early?.guardHeld ?? true };
  let workerLive = true;
  const prior = parseRuntimeRecord(parseStrictJson(Buffer.from(stringifyJson({ runtimeInstanceId: '1'.repeat(32), startedAt: '2026-10-09T00:00:00.0000000Z',
    cleanShutdown: true, watcher: withWatcher ? { pid: 1234, created: '1234' } : null }))));
  const previous: StoredDocument<RuntimeRecord> = { status: 'valid', sha256: 'a'.repeat(64), value: prior };
  const resources = {
    async withTransition<T>(kind: string, action: () => Promise<T>): Promise<T> { assert.equal(kind, 'runtimeMarker'); step('transition'); return action(); },
    async reserveRuntimeMarker() { step('reserve'); },
  };
  const storage = {
    async read(relative: string, profile: string, parse: typeof parseRuntimeRecord) {
      assert.equal(relative, 'runtime.json'); assert.equal(profile, 'config'); assert.equal(parse, parseRuntimeRecord); step('read'); return previous;
    },
    async write(relative: string, value: RuntimeRecord, profile: string, expected: string) {
      assert.equal(relative, 'runtime.json'); assert.equal(profile, 'config'); assert.equal(expected, previous.sha256);
      const record = parseRuntimeRecord(parseStrictJson(Buffer.from(stringifyJson(value))));
      assert.equal(record.cleanShutdown, false); assert.equal(record.watcher, null); assert.notEqual(record.runtimeInstanceId, prior.runtimeInstanceId);
      step('write'); return 'b'.repeat(64);
    },
  } as unknown as Pick<ScopeStorage, 'read' | 'write'>;
  const supervisor = { async observeJobAbsent(role: string) { assert.equal(role, 'watcher'); return true; },
    async verifyQuiescent(role: string) { assert.equal(role, 'watcher'); step('watcher'); },
    async admitStartup(allowOwnedMetadata: boolean) {
      assert.equal(allowOwnedMetadata, early !== undefined);
      step('admit');
      if (early?.guardLoss === 'duringAdmission') { guard.held = false; }
      if (early?.exitAfterAdmission === true) { workerLive = false; }
    } } as unknown as ProcessSupervisor;
  const scope = { companionRoot: 'C:/private-marker-unit', dataRoot: 'C:/private-marker-unit/data', bindingSha256: 'c'.repeat(64) } as RuntimeScope;
  const inspector = { async metadata() {
    step('source');
    if (early?.guardLoss === 'duringSource') { guard.held = false; }
    const value = early?.source === 'absent' ? { status: 'absent' } : { status: 'present',
      scopeSha256: early?.source === 'bindingDrift' ? 'd'.repeat(64) : scope.bindingSha256,
      metadataSha256: early?.source === 'sourceDrift' ? '1'.repeat(64) : 'e'.repeat(64),
      coreReplySha256: 'f'.repeat(64), mutationSha256: '0'.repeat(64) };
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) };
  } } as unknown as PathInspector;
  const earlyMetadata = early === undefined ? null : { matchesStartupEvidence: (_scope: RuntimeScope, evidence: { metadataSha256: string }) =>
    early.matches && workerLive && evidence.metadataSha256 === 'e'.repeat(64) } as unknown as StartupMetadataSession;
  const dependencies = { scope, guard, inspector, supervisor, storage, resources, earlyMetadata };
  const cleanup = async () => { step('cleanup'); return { removed: [] as string[] }; };
  const prepare = async (prove?: (evidence: StartupWorkerEvidence) => void) => {
    step('prepare');
    const evidence = await observeStartupWorkerSources(inspector, scope);
    if (evidence === null) { return null; }
    prove?.(evidence);
    if (early?.guardLoss === 'afterProof') { guard.held = false; }
    return async () => { step('open'); return { async close() {} }; };
  };
  return { calls, dependencies, cleanup, prepare };
}

test('common command bootstrap relies on all-role admission when no watcher was recorded', async () => {
  const f = fixture(); const result = await initializeRuntimeMarker(f.dependencies, f.cleanup);
  assert.deepEqual(f.calls, ['cleanup', 'transition', 'reserve', 'read', 'admit', 'write']);
  assert.equal(result.sha256, 'b'.repeat(64)); assert.equal(result.runtime.cleanShutdown, false);
});

test('a recorded watcher still receives orphan reconciliation before all-role admission', async () => {
  const f = fixture(null, undefined, undefined, true);
  await initializeRuntimeMarker(f.dependencies, f.cleanup);
  assert.deepEqual(f.calls, ['cleanup', 'transition', 'reserve', 'read', 'watcher', 'admit', 'write']);
});

for (const failureAt of ['cleanup', 'reserve', 'read', 'admit', 'write']) {
  test('common command bootstrap stops dependent work after ' + failureAt + ' refusal', async () => {
    const error = failureAt === 'cleanup' ? new DataRootUnavailableError('Cleanup refusal.') : failureAt === 'reserve'
      ? new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: ['inventory'] }, 'runtimeMarker') : new Error('Fixture refusal.');
    const f = fixture(failureAt, error);
    await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup), caught => caught === error);
    const order = ['cleanup', 'transition', 'reserve', 'read', 'admit', 'write'];
    assert.deepEqual(f.calls, order.slice(0, order.indexOf(failureAt) + 1));
  });
}

test('recorded watcher reconciliation refusal leaves the old marker intact', async () => {
  const error = new Error('Watcher reconciliation unavailable.');
  const f = fixture('watcher', error, undefined, true);
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup), caught => caught === error);
  assert.deepEqual(f.calls, ['cleanup', 'transition', 'reserve', 'read', 'watcher']);
});

test('chat worker opens alongside marker publication but is returned only after both complete', async () => {
  const f = fixture();
  const opening = Promise.withResolvers<{ close(): Promise<void> }>();
  const writing = Promise.withResolvers<void>();
  const write = f.dependencies.storage.write.bind(f.dependencies.storage);
  Object.assign(f.dependencies.storage, { write: async (...args: Parameters<typeof write>) => { const sha256 = await write(...args); await writing.promise; return sha256; } });
  const worker = { async close() {} };
  let settled = false;
  const pending = initializeRuntimeMarker(f.dependencies, f.cleanup, async () => {
    f.calls.push('prepare');
    return async () => { f.calls.push('open'); return opening.promise; };
  }).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.includes('write'));
  assert.ok(f.calls.includes('open'));
  assert.ok(f.calls.indexOf('prepare') < f.calls.indexOf('write'));
  opening.resolve(worker);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'The worker was returned before marker publication completed.');
  writing.resolve();
  const result = await pending;
  assert.equal(result.startupWorker, worker);
  assert.equal(result.sha256, 'b'.repeat(64));
});

test('marker refusal closes a worker that finished opening', async () => {
  const error = new Error('Marker publication refused.');
  const f = fixture('write', error);
  let closed = false;
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, async () => async () => ({
    async close() { closed = true; },
  })), caught => caught === error);
  assert.equal(closed, true);
});

test('worker preparation refusal leaves the prior marker unchanged', async () => {
  const error = new Error('Worker source unavailable.');
  const f = fixture();
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, async () => { throw error; }), caught => caught === error);
  assert.equal(f.calls.includes('write'), false);
});

test('worker opening refusal follows a completed dirty marker publication', async () => {
  const error = new Error('Worker hello unavailable.');
  const f = fixture();
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, async () => async () => { throw error; }), caught => caught === error);
  assert.equal(f.calls.includes('write'), true);
});

test('early metadata receives fresh source proof after native all-role admission and before marker publication', async () => {
  const f = fixture(null, undefined, { source: 'present', matches: true });
  await initializeRuntimeMarker(f.dependencies, f.cleanup, f.prepare);
  assert.deepEqual(f.calls, ['cleanup', 'transition', 'reserve', 'read', 'admit', 'prepare', 'source', 'write', 'open']);
});

for (const source of ['absent', 'bindingDrift', 'sourceDrift'] as const) {
  test('early metadata refuses ' + source + ' source evidence before marker publication', async () => {
    const f = fixture(null, undefined, { source, matches: true });
    await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, f.prepare), DataRootUnavailableError);
    assert.equal(f.calls.includes('admit'), true);
    assert.equal(f.calls.includes('write'), false);
    assert.equal(f.calls.includes('open'), false);
  });
}

test('early metadata refuses guard loss before, during or after fresh proof', async () => {
  for (const early of [{ source: 'present', matches: true, guardHeld: false },
    { source: 'present', matches: true, guardLoss: 'duringAdmission' },
    { source: 'present', matches: true, guardLoss: 'duringSource' },
    { source: 'present', matches: true, guardLoss: 'afterProof' }] as const) {
    const f = fixture(null, undefined, early);
    await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, f.prepare));
    assert.equal(f.calls.includes('write'), false);
    assert.equal(f.calls.includes('open'), false);
  }
});

test('native admission refusal cannot run the later source observation', async () => {
  const failure = new Error('Native membership unavailable.');
  const f = fixture('admit', failure, { source: 'present', matches: true });
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, f.prepare), caught => caught === failure);
  assert.equal(f.calls.includes('source'), false);
  assert.equal(f.calls.includes('write'), false);
  assert.equal(f.calls.includes('open'), false);
});

test('early metadata requires a successful proof-bearing preparation', async () => {
  const f = fixture(null, undefined, { source: 'present', matches: true });
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup), DataRootUnavailableError);
  assert.equal(f.calls.includes('admit'), false);
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, async () => null), DataRootUnavailableError);
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, async () => async () => ({ async close() {} })), DataRootUnavailableError);
  assert.equal(f.calls.includes('write'), false);
  assert.equal(f.calls.includes('open'), false);
});

test('worker exit after native admission refuses later source proof', async () => {
  const f = fixture(null, undefined, { source: 'present', matches: true, exitAfterAdmission: true });
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, f.prepare), DataRootUnavailableError);
  assert.equal(f.calls.includes('source'), true);
  assert.equal(f.calls.includes('write'), false);
  assert.equal(f.calls.includes('open'), false);
});

test('marker publication failure closes the reused early worker', async () => {
  const failure = new Error('Marker publication failed.');
  const f = fixture('write', failure, { source: 'present', matches: true });
  let closed = false;
  await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup, async prove => {
    const prepared = await f.prepare(prove);
    assert.ok(prepared);
    return async () => ({ async close() { closed = true; } });
  }), caught => caught === failure);
  assert.equal(closed, true);
});
