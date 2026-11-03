import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startChatProvider } from '../../src/runtime.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { indexCurrentBinding } from '../../src/session-records.ts';
import { formatStatus, runTextClient } from '../../src/text-client.ts';
import { FakeBackend, FakeProvider, generation, instructionHash, invalidateWhenReady, timestamp, until } from './support.ts';

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

// The safety record reads as busy, the transient sharing-violation condition, until the test clears it.
function busySafety(backend: FakeBackend): { clear: () => void } {
  let busy = true;
  const safety = backend.safety.bind(backend);
  Object.assign(backend, { safety: async () => { if (busy) { throw Object.assign(new Error('The safety record is in use.'), { code: 'EBUSY' }); } return safety(); } });

  return { clear: () => { busy = false; } };
}

test('a transiently busy safety read at provider start names /new as its recheck, and /new recovers once it clears', async () => {
  // Arrange
  const { backend, provider, host } = startupModel();
  const busy = busySafety(backend);

  // Act
  const started = await startChatProvider(host, backend.asRuntime());
  const events = await attachNotices(host);
  const refusedSubmission = host.submitChat({ text: 'question', questionOverride: false }).result;
  const stillUnavailable = await host.startNewAgentSession();
  busy.clear();
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

test('the remedy follows the error that refused the start, not a later safety read', async () => {
  for (const item of [{ name: 'busy refusal that has already cleared', expected: 'retryable' }, { name: 'durable refusal before a busy read', expected: 'restartRequired' }] as const) {
    // Arrange
    const { backend, host } = startupModel();
    const providerSafety = backend.providerSafety.bind(backend);
    let calls = 0;
    if (item.expected === 'retryable') {
      Object.assign(backend, { providerSafety: async () => { calls++; if (calls === 1) { throw Object.assign(new Error('The safety record is in use.'), { code: 'EBUSY' }); } return providerSafety(); } });
    } else {
      backend.safetyValue = { ...backend.safetyValue, pendingCheck: '7'.repeat(32) };
      busySafety(backend);
      Object.assign(backend, { providerSafety: async () => { throw new Error('Provider history admission is unresolved.'); } });
    }

    // Act
    await startChatProvider(host, backend.asRuntime());
    const events = await attachNotices(host);
    const retried = await host.startNewAgentSession();

    // Assert
    assert.deepEqual(refusals(events), [item.expected], item.name);
    assert.equal(retried, item.expected === 'retryable' ? 'started' : 'providerUnavailable', item.name);
    await host.shutdown();
  }
});

test('a safety read failure that is not known to be transient requires a restart', async () => {
  // Arrange
  const { backend, provider, host } = startupModel();
  backend.unavailable = true;

  // Act
  const started = await startChatProvider(host, backend.asRuntime());
  const events = await attachNotices(host);

  // Assert
  assert.equal(started.result, 'ready');
  assert.deepEqual(refusals(events), ['restartRequired']);
  assert.equal(provider.calls.length, 0);
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

const restartText = 'Use /quit and restart chat to attempt recovery; if it remains unavailable, run repair after exit.';
const recheckText = '/new rechecks it; if it stays unavailable, use /quit and run repair after exit.';

test('the live status keeps a retryable refusal through a failed recheck and clears it once the host becomes ready', async () => {
  // Arrange
  const { backend, host } = startupModel();
  const busy = busySafety(backend);

  // Act
  await startChatProvider(host, backend.asRuntime());
  await attachNotices(host);
  const afterRefusal = host.status.provider.safetyRefusal;
  const failedRecheck = await host.startNewAgentSession();
  const afterFailedRecheck = host.status;
  busy.clear();
  const recovered = await host.startNewAgentSession();

  // Assert
  assert.equal(afterRefusal, 'retryable');
  assert.equal(failedRecheck, 'providerUnavailable');
  assert.equal(afterFailedRecheck.provider.safetyRefusal, 'retryable');
  assert.ok(formatStatus(afterFailedRecheck).includes(recheckText));
  assert.equal(recovered, 'started');
  assert.equal(host.status.provider.safetyRefusal, null);
  assert.ok(!formatStatus(host.status).includes('Provider start refused'));
  await host.shutdown();
});

test('the live status keeps a durable refusal through the recheck path of /new', async () => {
  // Arrange
  const { backend, host } = startupModel();
  backend.safetyValue = { ...backend.safetyValue, pendingCheck: '7'.repeat(32) };

  // Act
  await startChatProvider(host, backend.asRuntime());
  await attachNotices(host);
  const retried = await host.startNewAgentSession();

  // Assert
  assert.equal(retried, 'providerUnavailable');
  assert.equal(host.status.provider.state, 'failed');
  assert.equal(host.status.provider.safetyRefusal, 'restartRequired');
  assert.ok(formatStatus(host.status).includes(restartText));
  await host.shutdown();
});

test('the live status keeps the refusal of an invalidated initial start through the outright refusal of /new', async () => {
  // Arrange
  const { backend, host } = startupModel();
  host.invalidate('contextUncertain');

  // Act
  await startChatProvider(host, backend.asRuntime());
  await attachNotices(host);
  const retried = await host.startNewAgentSession();

  // Assert
  assert.equal(retried, 'providerUnavailable');
  assert.equal(host.status.provider.safetyRefusal, 'restartRequired');
  assert.ok(formatStatus(host.status).includes(restartText));
  await host.shutdown();
});

test('the live status keeps a final attachment refusal, and /status repeats it after the notice', async () => {
  // Arrange
  const { backend, host } = startupModel();
  let safetyCalls = 0;
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => { safetyCalls += 1; if (safetyCalls === 3) { throw new Error('Final safety refused.'); } return providerSafety(); } });
  await startChatProvider(host, backend.asRuntime());
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk: Buffer) => { rendered += chunk.toString('utf8'); });

  // Act
  const running = runTextClient(host, { input, output, terminal: false });
  await until(() => rendered.includes('[Provider start refused'));
  const beforeStatus = rendered.length;
  input.write('/status\n');
  await until(() => rendered.length > beforeStatus && rendered.slice(beforeStatus).includes(restartText));
  input.write('/quit\n');
  await running;

  // Assert
  assert.equal(host.status.provider.safetyRefusal, 'restartRequired');
  assert.ok(rendered.slice(beforeStatus).includes('provider: failed'), rendered);
});

test('the remedy persists while the lifecycle reports a started provider but an invalidation keeps the host unready', async () => {
  // Arrange: the host is invalidated in the status change that reports the bound provider ready, before start resolves.
  const { backend, host } = startupModel();
  const hook = invalidateWhenReady(host);

  // Act
  await startChatProvider(host, backend.asRuntime());
  const events = await attachNotices(host);

  // Assert
  assert.equal(hook.invalidated, true);
  assert.deepEqual(refusals(events), ['restartRequired']);
  assert.equal(host.status.provider.state, 'ready');
  assert.equal(host.status.provider.safetyRefusal, 'restartRequired');
  assert.ok(formatStatus(host.status).includes(restartText));
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'notReady');
  await host.shutdown();
});

test('an invalidation in the status change that reports the /new provider ready keeps the remedy and refuses /new', async () => {
  // Arrange: a retryable refusal is kept; once the safety read clears, /new is invalidated as its provider reports ready.
  const { backend, host } = startupModel();
  const busy = busySafety(backend);
  await startChatProvider(host, backend.asRuntime());
  await attachNotices(host);
  busy.clear();
  const hook = invalidateWhenReady(host);

  // Act
  const retried = await host.startNewAgentSession();

  // Assert
  assert.equal(hook.invalidated, true);
  assert.equal(retried, 'providerUnavailable');
  assert.equal(host.status.provider.safetyRefusal, 'retryable');
  assert.ok(formatStatus(host.status).includes(recheckText));
  await host.shutdown();
});

test('no status change shows the provider ready beside the kept remedy while the host becomes ready again', async () => {
  const recoveries: readonly { readonly name: string; readonly recover: (host: SessionHost, backend: FakeBackend) => Promise<unknown> }[] = [
    { name: '/new', recover: host => host.startNewAgentSession() },
    { name: 'named resume', recover: (host, backend) => {
      backend.index = indexCurrentBinding(backend.index, { agentSessionVersion: 1, providerId: 'fake', providerSessionId: 'valid-session', createdAt: timestamp, turnsCompleted: 0,
        needsState: true, instructionsSha256: instructionHash, stateGeneration: generation }, timestamp);
      return host.resumeAgentSession('valid-session');
    } },
    { name: 'replacement after an invalidation', recover: async host => { host.invalidate('contextUncertain'); await until(() => host.status.provider.safetyRefusal === null); } },
  ];
  for (const item of recoveries) {
    // Arrange: a retryable refusal is kept, then the safety read clears.
    const { backend, host } = startupModel();
    const busy = busySafety(backend);
    await startChatProvider(host, backend.asRuntime());
    const events = await attachNotices(host);
    busy.clear();

    // Act
    await item.recover(host, backend);

    // Assert
    const statuses = events.flatMap(event => event.type === 'status.changed' ? [event.status.provider] : []);
    assert.equal(host.status.provider.state, 'ready', item.name);
    assert.equal(host.status.provider.safetyRefusal, null, item.name);
    assert.deepEqual(statuses.filter(provider => provider.state === 'ready' && provider.safetyRefusal !== null), [], item.name);
    assert.deepEqual(statuses.at(-1), host.status.provider, item.name);
    await host.shutdown();
  }
});

test('the attach snapshot and every later status change carry the kept remedy', async () => {
  // Arrange
  const { backend, host } = startupModel();
  busySafety(backend);
  await startChatProvider(host, backend.asRuntime());
  const events: HostEvent[] = [];

  // Act
  const attached = await host.attachVerified(event => { events.push(event); });
  await until(() => events.some(event => event.type === 'notice' && event.code === 'providerSafetyRefused'));
  const retried = await host.startNewAgentSession();

  // Assert
  assert.equal(attached.result, 'attached');
  assert.equal(attached.result === 'attached' ? attached.snapshot.status.provider.safetyRefusal : null, 'retryable');
  assert.equal(retried, 'providerUnavailable');
  const changes = events.flatMap(event => event.type === 'status.changed' ? [event.status] : []);
  assert.ok(changes.length > 0);
  assert.ok(changes.every(status => status.provider.safetyRefusal === 'retryable'));
  await host.shutdown();
});

test('text client renders each provider safety refusal with its remedy', async () => {
  for (const item of [
    { arrange: (backend: FakeBackend) => { busySafety(backend); }, text: '/new rechecks it; if it stays unavailable, use /quit and run repair after exit.' },
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
