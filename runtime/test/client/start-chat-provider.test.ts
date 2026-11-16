import assert from 'node:assert/strict';
import test from 'node:test';

import { startChatProvider } from '../../src/runtime.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { StartupPhase } from '../../src/startup-progress.ts';
import { FakeBackend, FakeProvider, instructionHash } from './support.ts';

test('a provider whose every start fails makes chat startup providerUnavailable after closing the startup workers', async () => {
  // Arrange
  const backend = new FakeBackend();
  let workerClosures = 0;
  Object.assign(backend, { supervisor: { nativeHelper: { verifyLive: async () => {} }, verifyQuiescent: async () => {} },
    closeStartupWorkers: async () => { workerClosures += 1; } });
  const provider = new FakeProvider();
  provider.failAll = true;
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  const phases: StartupPhase[] = [];

  // Act
  const started = await startChatProvider(host, backend.asRuntime(), phase => phases.push(phase));

  // Assert
  assert.equal(started.result, 'providerUnavailable');
  assert.equal(provider.calls.length, 4);
  assert.equal(host.status.provider.state, 'failed');
  assert.equal(workerClosures, 1);
  assert.equal(phases.at(-1), 'startupWorkerClosure');
  assert.equal(phases.includes('attachmentSafety'), false);
  assert.notEqual((await host.attachVerified(() => {})).result, 'attached');
});
