import assert from 'node:assert/strict';
import test from 'node:test';

import { DataRootUnavailableError, type PathInspector } from '../../src/admission.ts';
import { initializeRuntimeMarker } from '../../src/backend/marker-bootstrap.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import type { ProcessSupervisor } from '../../src/process.ts';
import { parseRuntimeRecord, type RuntimeRecord } from '../../src/runtime-records.ts';
import type { RuntimeScope } from '../../src/scope.ts';
import type { ScopeStorage, StoredDocument } from '../../src/storage.ts';

function fixture(failureAt: string | null = null, failure: Error = new Error('Fixture refusal.')) {
  const calls: string[] = [];
  const step = (name: string) => { calls.push(name); if (name === failureAt) { throw failure; } };
  const prior = parseRuntimeRecord(parseStrictJson(Buffer.from(stringifyJson({ runtimeInstanceId: '1'.repeat(32), startedAt: '2026-10-09T00:00:00.0000000Z', cleanShutdown: true, watcher: null }))));
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
  const supervisor = { async verifyQuiescent(role: string) { assert.equal(role, 'watcher'); step('watcher'); }, async admitStartup() { step('admit'); } } as unknown as ProcessSupervisor;
  const dependencies = { scope: { companionRoot: 'C:/private-marker-unit' } as RuntimeScope, guard: { held: true }, inspector: {} as PathInspector, supervisor, storage, resources };
  const cleanup = async () => { step('cleanup'); return { removed: [] as string[] }; };
  return { calls, dependencies, cleanup };
}

test('common command bootstrap completes cleanup before Marker reservation, watcher reconciliation and publication', async () => {
  const f = fixture(); const result = await initializeRuntimeMarker(f.dependencies, f.cleanup);
  assert.deepEqual(f.calls, ['cleanup', 'transition', 'reserve', 'read', 'watcher', 'admit', 'write']);
  assert.equal(result.sha256, 'b'.repeat(64)); assert.equal(result.runtime.cleanShutdown, false);
});

for (const failureAt of ['cleanup', 'reserve', 'read', 'watcher', 'admit', 'write']) {
  test('common command bootstrap stops dependent work after ' + failureAt + ' refusal', async () => {
    const error = failureAt === 'cleanup' ? new DataRootUnavailableError('Cleanup refusal.') : failureAt === 'reserve'
      ? new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: ['inventory'] }, 'runtimeMarker') : new Error('Fixture refusal.');
    const f = fixture(failureAt, error);
    await assert.rejects(initializeRuntimeMarker(f.dependencies, f.cleanup), caught => caught === error);
    const order = ['cleanup', 'transition', 'reserve', 'read', 'watcher', 'admit', 'write'];
    assert.deepEqual(f.calls, order.slice(0, order.indexOf(failureAt) + 1));
  });
}

test('chat worker opens alongside marker publication but is returned only after both complete', async () => {
  const f = fixture();
  const opening = Promise.withResolvers<{ close(): Promise<void> }>();
  const worker = { async close() {} };
  const pending = initializeRuntimeMarker(f.dependencies, f.cleanup, async () => {
    f.calls.push('prepare');
    return async () => { f.calls.push('open'); return opening.promise; };
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.includes('write'));
  assert.ok(f.calls.includes('open'));
  assert.ok(f.calls.indexOf('prepare') < f.calls.indexOf('write'));
  opening.resolve(worker);
  assert.equal((await pending).startupWorker, worker);
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
