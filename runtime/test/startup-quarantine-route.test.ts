import assert from 'node:assert/strict';
import test from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import { FilePublisher, PublicationError } from '../src/files.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import type { RuntimeScope } from '../src/scope.ts';
import type { StartupMutationSession } from '../src/startup-mutation.ts';

const root = 'C:/private/runtime-data';
const scope = { companionRoot: 'C:/private', dataRoot: root, bindingSha256: 'a'.repeat(64) } as RuntimeScope;
const input = Buffer.from('[]');
const result = { exitCode: 0, stdout: Buffer.from('{"removed":0,"remaining":0}'), stderr: Buffer.alloc(0) };

test('quarantine trim shares publication ownership and queue without permissive retry', async () => {
  const guard = { held: true };
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const session = { canFallBack: false, close: async () => {}, trimQuarantine: async () => {
    calls += 1;
    started();
    await gate;
    return result;
  } } as unknown as StartupMutationSession;
  const publisher = new FilePublisher({ root, guard, inspector: {} as PathInspector, supervisor: {} as ProcessSupervisor,
    preflight: async () => {}, invalidate: () => {} });
  publisher.attachStartupMutationSession(session);
  const first = publisher.trimStartupQuarantine(scope, input);
  const after = publisher.exclusive(async () => 'after');
  await entered;
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, result);
  assert.equal(await after, 'after');
  guard.held = false;
  await assert.rejects(publisher.trimStartupQuarantine(scope, input), PublicationError);
  assert.equal(calls, 1);
  await publisher.closeStartupMutationSession();
});

test('quarantine worker failure and foreign scope do not select a one-shot retry', async () => {
  const guard = { held: true };
  let calls = 0;
  const session = { canFallBack: false, close: async () => {}, trimQuarantine: async () => {
    calls += 1;
    throw new Error('lost worker reply');
  } } as unknown as StartupMutationSession;
  const publisher = new FilePublisher({ root, guard, inspector: {} as PathInspector, supervisor: {} as ProcessSupervisor,
    preflight: async () => {}, invalidate: () => {} });
  publisher.attachStartupMutationSession(session);
  await assert.rejects(publisher.trimStartupQuarantine({ ...scope, dataRoot: 'C:/foreign' }, input), PublicationError);
  assert.equal(calls, 0);
  await assert.rejects(publisher.trimStartupQuarantine(scope, input), /lost worker reply/);
  assert.equal(calls, 1);
  await publisher.closeStartupMutationSession();
});

test('verified worker closure restores the one-shot maintenance route', async () => {
  const publisher = new FilePublisher({ root, guard: { held: true }, inspector: {} as PathInspector,
    supervisor: {} as ProcessSupervisor, preflight: async () => {}, invalidate: () => {} });
  const session = { canFallBack: false, close: async () => {}, trimQuarantine: async () => result } as unknown as StartupMutationSession;
  publisher.attachStartupMutationSession(session);
  await publisher.closeStartupMutationSession();
  assert.equal(await publisher.trimStartupQuarantine(scope, input), null);
});

test('a queued trim refuses a worker closure race before later one-shot maintenance', async () => {
  const publisher = new FilePublisher({ root, guard: { held: true }, inspector: {} as PathInspector,
    supervisor: {} as ProcessSupervisor, preflight: async () => {}, invalidate: () => {} });
  let trims = 0;
  const session = { canFallBack: false, close: async () => {}, trimQuarantine: async () => { trims += 1; return result; } } as unknown as StartupMutationSession;
  publisher.attachStartupMutationSession(session);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocking = publisher.exclusive(async () => { entered(); await gate; });
  await started;
  const queued = assert.rejects(publisher.trimStartupQuarantine(scope, input), PublicationError);
  const closing = publisher.closeStartupMutationSession();
  release();
  await blocking;
  await queued;
  await closing;
  assert.equal(trims, 0);
  assert.equal(await publisher.trimStartupQuarantine(scope, input), null);
});
