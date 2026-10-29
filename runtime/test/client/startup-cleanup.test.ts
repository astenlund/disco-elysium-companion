import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeBackend } from '../../src/backend/api.ts';
import type { FileToolAdapter } from '../../src/file-tool-adapter.ts';
import { NativeHelperUnavailableError } from '../../src/native-helper-error.ts';
import { cleanupFailedChatRuntime } from '../../src/runtime.ts';
import type { SessionHost } from '../../src/session-host.ts';

test('worker close failure still shuts down a started host', async () => {
  const order: string[] = [];
  const closeFailure = new Error('Worker close failed.');
  const backend = { closeStartupWorkers: async () => { order.push('worker'); throw closeFailure; } } as unknown as RuntimeBackend;
  const host = { shutdown: async () => { order.push('host'); } } as unknown as SessionHost;
  await assert.rejects(cleanupFailedChatRuntime(new Error('Startup failed.'), backend, host, null), error => error === closeFailure);
  assert.deepEqual(order, ['worker', 'host']);
});

test('worker close failure still stops an opened backend without a host', async () => {
  const order: string[] = [];
  const closeFailure = new Error('Worker close failed.');
  const backend = {
    closeStartupWorkers: async () => { order.push('worker'); throw closeFailure; },
    beginShutdown: async () => { order.push('watcher and core'); },
    supervisor: { nativeHelper: { verifyLive: async () => {} }, verifyQuiescent: async () => { order.push('provider'); } },
    shutdown: async () => { order.push('backend'); },
  } as unknown as RuntimeBackend;
  const files = { verifyQuiescent: async () => { order.push('tools verified'); },
    release: async () => { order.push('tools released'); } } as unknown as FileToolAdapter;
  await assert.rejects(cleanupFailedChatRuntime(new Error('Startup failed.'), backend, null, files), error => error === closeFailure);
  assert.deepEqual(order, ['worker', 'watcher and core', 'provider', 'tools verified', 'backend', 'tools released']);
});

test('an unproved pending provider stop closes workers, then fails closed without shutdown', async () => {
  const order: string[] = [];
  const stopFailure = new Error('The pending provider could not be positively stopped.');
  const pending = { cancel: async () => { order.push('candidate'); throw stopFailure; } };
  const backend = {
    closeStartupWorkers: async () => { order.push('worker'); },
    beginShutdown: async () => { order.push('watcher and core'); },
    supervisor: { nativeHelper: { verifyLive: async () => {} }, verifyQuiescent: async () => { order.push('provider'); } },
    shutdown: async () => { order.push('backend'); },
  } as unknown as RuntimeBackend;
  await assert.rejects(cleanupFailedChatRuntime(new Error('Startup failed.'), backend, null, null, undefined, pending), error => error === stopFailure);
  assert.deepEqual(order, ['candidate', 'worker']);
});

test('a stopped pending provider lets cleanup shut down and keep the original failure', async () => {
  const order: string[] = [];
  const startupFailure = new Error('Startup failed.');
  const pending = { cancel: async () => { order.push('candidate'); } };
  const backend = {
    closeStartupWorkers: async () => { order.push('worker'); },
    beginShutdown: async () => { order.push('watcher and core'); },
    supervisor: { nativeHelper: { verifyLive: async () => {} }, verifyQuiescent: async () => { order.push('provider'); } },
    shutdown: async () => { order.push('backend'); },
  } as unknown as RuntimeBackend;
  await assert.rejects(cleanupFailedChatRuntime(startupFailure, backend, null, null, undefined, pending), error => error === startupFailure);
  assert.deepEqual(order, ['candidate', 'worker', 'watcher and core', 'provider', 'backend']);
});

test('successful cleanup preserves the original startup failure', async () => {
  const startupFailure = new Error('Startup failed.');
  const backend = { closeStartupWorkers: async () => {} } as unknown as RuntimeBackend;
  const host = { shutdown: async () => {} } as unknown as SessionHost;
  await assert.rejects(cleanupFailedChatRuntime(startupFailure, backend, host, null), error => error === startupFailure);
});

test('failed startup reports worker closure before cleanup even if the phase callback throws', async () => {
  const order: string[] = [];
  const startupFailure = new Error('Instruction preparation failed.');
  const backend = { closeStartupWorkers: async () => { order.push('worker'); } } as unknown as RuntimeBackend;
  const host = { shutdown: async () => { order.push('host'); } } as unknown as SessionHost;
  await assert.rejects(cleanupFailedChatRuntime(startupFailure, backend, host, null, phase => {
    order.push(`phase:${phase}`);
    throw new Error('Progress callback failed.');
  }), error => error === startupFailure);
  assert.deepEqual(order, ['phase:startupWorkerClosure', 'worker', 'host']);
});

test('cleanup without an opened backend reports no worker closure', async () => {
  const phases: string[] = [];
  const startupFailure = new Error('Backend open failed.');
  await assert.rejects(cleanupFailedChatRuntime(startupFailure, null, null, null, phase => phases.push(phase)), error => error === startupFailure);
  assert.deepEqual(phases, []);
});

function exhaustibleBackend(exhausted: boolean): RuntimeBackend {
  return { closeStartupWorkers: async () => {}, supervisor: { nativeHelper: { exhausted } } } as unknown as RuntimeBackend;
}

test('a cleanup that fails while the helper is exhausted keeps the start failure as the helper refusal', async () => {
  // Arrange
  const startupFailure = new Error('Provider launch refused.');
  const shutdownFailure = new Error('Native process metadata is unavailable.');
  const host = { shutdown: async () => { throw shutdownFailure; } } as unknown as SessionHost;

  // Act
  const [exhausted, serving] = await Promise.allSettled([cleanupFailedChatRuntime(startupFailure, exhaustibleBackend(true), host, null),
    cleanupFailedChatRuntime(startupFailure, exhaustibleBackend(false), host, null)]);

  // Assert
  assert.ok(exhausted.status === 'rejected' && exhausted.reason instanceof NativeHelperUnavailableError && exhausted.reason.reason === 'unavailable'
    && exhausted.reason.cause === startupFailure);
  assert.ok(serving.status === 'rejected' && serving.reason === shutdownFailure);
});

test('an unproved pending provider stop while the helper is exhausted keeps the start failure as the helper refusal', async () => {
  // Arrange
  const startupFailure = new NativeHelperUnavailableError('bindFailed');
  const pending = { cancel: async () => { throw new Error('The pending provider could not be positively stopped.'); } };
  const host = { shutdown: async () => { assert.fail('An unproved candidate stop must not shut down.'); } } as unknown as SessionHost;

  // Act
  const reported = cleanupFailedChatRuntime(startupFailure, exhaustibleBackend(true), host, null, undefined, pending);

  // Assert
  await assert.rejects(reported, error => error === startupFailure);
});
