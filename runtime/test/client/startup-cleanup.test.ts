import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeBackend } from '../../src/backend/api.ts';
import type { FileToolAdapter } from '../../src/file-tool-adapter.ts';
import { cleanupFailedChatRuntime } from '../../src/runtime.ts';
import type { SessionHost } from '../../src/session-host.ts';

test('worker close failure still shuts down a started host', async () => {
  const order: string[] = [];
  const closeFailure = new Error('Worker close failed.');
  const backend = { closeStartupMetadata: async () => { order.push('worker'); throw closeFailure; } } as unknown as RuntimeBackend;
  const host = { shutdown: async () => { order.push('host'); } } as unknown as SessionHost;
  await assert.rejects(cleanupFailedChatRuntime(new Error('Startup failed.'), backend, host, null), error => error === closeFailure);
  assert.deepEqual(order, ['worker', 'host']);
});

test('worker close failure still stops an opened backend without a host', async () => {
  const order: string[] = [];
  const closeFailure = new Error('Worker close failed.');
  const backend = {
    closeStartupMetadata: async () => { order.push('worker'); throw closeFailure; },
    beginShutdown: async () => { order.push('watcher and core'); },
    supervisor: { verifyQuiescent: async () => { order.push('provider'); } },
    shutdown: async () => { order.push('backend'); },
  } as unknown as RuntimeBackend;
  const files = { verifyQuiescent: async () => { order.push('tools verified'); },
    close: async () => { order.push('tools closed'); } } as unknown as FileToolAdapter;
  await assert.rejects(cleanupFailedChatRuntime(new Error('Startup failed.'), backend, null, files), error => error === closeFailure);
  assert.deepEqual(order, ['worker', 'watcher and core', 'provider', 'tools verified', 'backend', 'tools closed']);
});

test('successful cleanup preserves the original startup failure', async () => {
  const startupFailure = new Error('Startup failed.');
  const backend = { closeStartupMetadata: async () => {} } as unknown as RuntimeBackend;
  const host = { shutdown: async () => {} } as unknown as SessionHost;
  await assert.rejects(cleanupFailedChatRuntime(startupFailure, backend, host, null), error => error === startupFailure);
});
