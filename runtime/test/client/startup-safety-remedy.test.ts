import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startChatProvider } from '../../src/runtime.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { runTextClient } from '../../src/text-client.ts';
import { FakeBackend, FakeProvider, instructionHash, until } from './support.ts';

function startupModel() {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { nativeHelper: { verifyLive: async () => {} }, verifyQuiescent: async () => {} }, closeStartupWorkers: async () => {} });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });

  return { backend, provider, host };
}

async function attachNotices(host: SessionHost): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  const attached = await host.attachVerified(event => { events.push(event); });
  assert.equal(attached.result, 'attached');
  await until(() => events.some(event => event.type === 'notice' && event.code === 'providerSafetyRefused'));

  return events;
}

const refusals = (events: readonly HostEvent[]) => events.flatMap(event => event.type === 'notice' && event.code === 'providerSafetyRefused' ? [event.reason] : []);

test('an unavailable safety check at provider start names /new as its recheck, and /new recovers once it is available', async () => {
  // Arrange
  const { backend, provider, host } = startupModel();
  backend.unavailable = true;

  // Act
  const started = await startChatProvider(host, backend.asRuntime());
  const events = await attachNotices(host);
  const refusedSubmission = host.submitChat({ text: 'question', questionOverride: false }).result;
  const stillUnavailable = await host.startNewAgentSession();
  backend.unavailable = false;
  const recovered = await host.startNewAgentSession();

  // Assert
  assert.equal(started.result, 'ready');
  assert.deepEqual(refusals(events), ['retryable']);
  assert.notEqual(refusedSubmission, 'admitted');
  assert.equal(stillUnavailable, 'providerUnavailable');
  assert.equal(recovered, 'started');
  assert.equal(provider.calls.length, 1);
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

test('a readable safety record that refuses the provider start requires a restart because /new cannot discharge it', async () => {
  // Arrange
  const { backend, provider, host } = startupModel();
  backend.safetyValue = { ...backend.safetyValue, pendingCheck: '7'.repeat(32) };

  // Act
  const started = await startChatProvider(host, backend.asRuntime());
  const events = await attachNotices(host);
  const retried = await host.startNewAgentSession();

  // Assert
  assert.equal(started.result, 'ready');
  assert.deepEqual(refusals(events), ['restartRequired']);
  assert.equal(retried, 'providerUnavailable');
  assert.equal(provider.calls.length, 0);
  await host.shutdown();
});

test('a final attachment safety block requires a restart', async () => {
  // Arrange
  const { backend, host } = startupModel();
  let safetyCalls = 0;
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => { safetyCalls += 1; if (safetyCalls === 3) { throw new Error('Final safety refused.'); } return providerSafety(); } });

  // Act
  const started = await startChatProvider(host, backend.asRuntime());
  const events = await attachNotices(host);
  const retried = await host.startNewAgentSession();

  // Assert
  assert.equal(started.result, 'ready');
  assert.deepEqual(refusals(events), ['restartRequired']);
  assert.equal(retried, 'providerUnavailable');
  await host.shutdown();
});

test('text client renders each provider safety refusal with its remedy', async () => {
  for (const item of [
    { arrange: (backend: FakeBackend) => { backend.unavailable = true; }, text: '/new rechecks it; if it stays unavailable, use /quit and run repair after exit.' },
    { arrange: (backend: FakeBackend) => { backend.safetyValue = { ...backend.safetyValue, pendingCheck: '7'.repeat(32) }; },
      text: 'Use /quit and restart chat to attempt recovery; if it remains unavailable, run repair after exit.' },
  ]) {
    // Arrange
    const { backend, host } = startupModel();
    item.arrange(backend);
    await startChatProvider(host, backend.asRuntime());
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer) => { rendered += chunk.toString('utf8'); });

    // Act
    const running = runTextClient(host, { input, output, terminal: false });
    await until(() => rendered.includes('[Provider start refused'));
    input.write('/quit\n');
    await running;

    // Assert
    assert.ok(rendered.includes(item.text), rendered);
  }
});
