import assert from 'node:assert/strict';
import test from 'node:test';

import { PendingStateCheckError } from '../../src/backend/api.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { indexCurrentBinding } from '../../src/session-records.ts';
import type { StartupPhase } from '../../src/startup-progress.ts';
import { recoveryFingerprint } from '../../src/window-recovery.ts';
import { deferred, FakeBackend, FakeProvider, flush, generation, instructionHash, timestamp, until } from './support.ts';

async function fixture(declarations: ConstructorParameters<typeof FakeProvider>[0] = {}): Promise<{ host: SessionHost; backend: FakeBackend; provider: FakeProvider; events: HostEvent[] }> {
  const backend = new FakeBackend();
  const provider = new FakeProvider(declarations);
  const events: HostEvent[] = [];
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  assert.equal(host.attach(event => events.push(event)).result, 'attached');
  await flush();
  return { host, backend, provider, events };
}

test('initial startup phase callback brackets provider start and binding without following later sessions', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const phases: StartupPhase[] = [];
  const start = provider.start.bind(provider);
  provider.start = async resume => {
    assert.equal(phases.at(-1), 'providerStart');
    return start(resume);
  };
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(phase => phases.push(phase)), true);
  assert.deepEqual(phases, ['providerStart', 'providerBinding']);
  assert.equal(backend.binding?.providerSessionId, provider.current.providerSessionId);
  provider.start = start;
  assert.equal(await host.startNewAgentSession(), 'started');
  assert.deepEqual(phases, ['providerStart', 'providerBinding']);
  await host.shutdown();
});

test('throwing startup phase callback cannot prevent provider start or durable binding', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(() => { throw new Error('progress callback failed'); }), true);
  assert.equal(provider.calls.length, 1);
  assert.equal(backend.binding?.providerSessionId, provider.current.providerSessionId);
  assert.equal(host.status.provider.state, 'ready');
  await host.shutdown();
});

test('failed startup resume reports immediate fallback separately from delayed retries', async () => {
  const backend = new FakeBackend();
  backend.binding = { agentSessionVersion: 1, providerId: 'fake', providerSessionId: 'stored-session', createdAt: timestamp,
    turnsCompleted: 0, needsState: true, instructionsSha256: instructionHash, stateGeneration: generation };
  const provider = new FakeProvider();
  provider.failures.add('stored-session');
  const phases: StartupPhase[] = [];
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(phase => phases.push(phase)), true);
  assert.deepEqual(provider.calls, ['stored-session', null]);
  assert.deepEqual(phases, ['providerStart', 'providerFallback', 'providerStart', 'providerBinding']);
  assert.equal(backend.binding?.providerSessionId, provider.current.providerSessionId);
  await host.shutdown();
});

test('one admitted interaction has exact identity on events and no queued second turn', async () => {
  const { host, backend, provider, events } = await fixture();
  const completion = deferred<{ kind: 'completed'; text: string }>();
  provider.current.action = async request => { request.onSignal({ kind: 'text', fragment: 'hello' }); return completion.promise; };
  const admitted = host.submitChat({ text: 'first', questionOverride: false });
  assert.equal(admitted.result, 'admitted');
  assert.deepEqual(host.submitChat({ text: 'second', questionOverride: false }), { result: 'turnInProgress' });
  assert.equal(host.attach(() => {}).result, 'clientAlreadyAttached');
  await until(() => provider.current.requests.length === 1);
  completion.resolve({ kind: 'completed', text: 'hello' });
  await until(() => !host.turnInProgress);
  assert.equal(backend.acquisitionCount, 1);
  assert.equal(backend.ackCount, 1);
  const turnEvents = events.filter(event => event.type.startsWith('turn.'));
  assert.deepEqual(turnEvents.map(event => event.type), ['turn.started', 'turn.delta', 'turn.completed']);
  if (admitted.result === 'admitted') { for (const event of turnEvents) { assert.equal('interactionId' in event && event.interactionId, admitted.interactionId); assert.equal('ingressOrder' in event && event.ingressOrder, admitted.ingressOrder); } }
  assert.ok(backend.events.indexOf('markSent') < backend.events.indexOf('ack-start'));
  await host.shutdown();
  assert.equal(backend.acquisitionCount, 1);
});

test('an incompatible current provider stays failed without reconnecting or acknowledging', async () => {
  const { host, backend, provider, events } = await fixture();
  provider.current.action = async (_request, session) => {
    session.exit('providerUnavailable');
    return { kind: 'failed', code: 'providerError', retryable: false };
  };
  assert.equal(host.submitChat({ text: 'first', questionOverride: false }).result, 'admitted');
  await until(() => !host.turnInProgress);
  assert.equal(host.status.provider.state, 'failed');
  assert.equal(backend.ackCount, 0);
  assert.equal(provider.calls.length, 1);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 1);
  assert.equal(events.some(event => event.type === 'notice' && event.code === 'sessionReconnected'), false);
  assert.equal(host.submitChat({ text: 'again', questionOverride: false }).result, 'providerUnavailable');
  assert.equal(await host.startNewAgentSession(), 'providerUnavailable');
  assert.equal(await host.resumeAgentSession(provider.current.providerSessionId), 'providerUnavailable');
  assert.equal(await host.start(), false);
  assert.equal(provider.calls.length, 1);
  await host.shutdown();
});

test('a late incompatible exit from a replaced provider cannot fail the current session', async () => {
  const { host, provider } = await fixture();
  const earlier = provider.current;
  assert.equal(await host.startNewAgentSession(), 'started');
  earlier.exit('providerUnavailable');
  assert.equal(host.status.provider.state, 'ready');
  assert.equal(provider.calls.length, 2);
  await host.shutdown();
});

test('detaching preserves one dialog, its snapshot and exact correlated answer', async () => {
  const { host, provider, events } = await fixture();
  provider.current.action = async request => {
    const answer = await request.askUser([{ question: 'Choose one?', header: 'Choice', options: [{ label: 'First', description: 'One' }, { label: 'Second', description: 'Two' }], multiSelect: false }]);
    assert.deepEqual(answer, { answers: { 'Choose one?': 'My answer' } });
    return { kind: 'completed', text: 'done' };
  };
  host.submitChat({ text: 'ask', questionOverride: false });
  await until(() => events.some(event => event.type === 'dialog.requested'));
  host.detach();
  const attached = host.attach(event => events.push(event));
  assert.equal(attached.result, 'attached');
  if (attached.result !== 'attached') { assert.fail(); }
  const dialog = attached.snapshot.openDialog;
  assert.ok(dialog);
  assert.equal(host.answerDialog({ dialogId: 'unknown', cancelled: true }), 'unknownDialog');
  assert.equal(host.answerDialog({ dialogId: dialog.dialogId, answers: {} }), 'invalidAnswer');
  assert.equal(host.answerDialog({ dialogId: dialog.dialogId, answers: { 'Choose one?': 'My answer' } }), 'accepted');
  await until(() => !host.turnInProgress);
  assert.equal(events.filter(event => event.type === 'dialog.closed').length, 1);
  await host.shutdown();
});

test('capabilities disable only their own paths', async () => {
  const { host, provider, events } = await fixture({ streamingText: false, questionOverride: false, interrupt: false, resume: false, dialogs: false, compactionBoundaries: false });
  assert.deepEqual(host.submitChat({ text: 'override', questionOverride: true }), { result: 'capabilityUnavailable' });
  assert.equal(await host.resumeAgentSession('session-1'), 'capabilityUnavailable');
  provider.current.action = async request => {
    request.onSignal({ kind: 'text', fragment: 'hidden' });
    assert.deepEqual(await request.askUser([]), { cancelled: true });
    assert.equal(await host.interrupt(), 'capabilityUnavailable');
    return { kind: 'completed', text: 'complete' };
  };
  host.submitChat({ text: 'plain', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(events.filter(event => event.type === 'turn.delta').length, 0);
  assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
  await host.shutdown();
});

test('interrupt during acquisition emits one terminal and sends and acknowledges nothing', async () => {
  const { host, backend, provider, events } = await fixture();
  const wait = deferred<void>(); backend.acquireWait = wait.promise;
  host.submitChat({ text: 'question', questionOverride: false });
  await until(() => backend.acquisitionCount === 1);
  assert.equal(await host.interrupt(), 'interrupted');
  wait.resolve();
  await until(() => !host.turnInProgress);
  assert.equal(backend.ackCount, 0);
  assert.equal(provider.current.requests.length, 0);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 1);
  await host.shutdown();
});

test('a completed turn cannot be interrupted while acknowledgement is pending', async () => {
  const { host, backend, provider, events } = await fixture();
  const ack = deferred<void>(); backend.ackWait = ack.promise;
  try {
    assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
    await until(() => backend.events.includes('ack-start'));
    assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
    assert.equal(host.turnInProgress, true);
    assert.equal(await host.interrupt(), 'noTurnInProgress');
    assert.equal(provider.current.interruptCount, 0);
    ack.resolve();
    await until(() => !host.turnInProgress);
    assert.equal(backend.ackCount, 1);
    assert.equal(backend.binding?.turnsCompleted, 1);
    assert.equal(events.filter(event => event.type === 'turn.failed').length, 0);
  } finally { ack.resolve(); await host.shutdown(); }
});

test('shutdown drains a completed turn before closing provider and backend authority', async () => {
  const { host, backend, provider, events } = await fixture();
  const ack = deferred<void>(); backend.ackWait = ack.promise;
  try {
    assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
    await until(() => backend.events.includes('ack-start'));
    const stopping = host.shutdown();
    await flush();
    assert.equal(provider.current.closed, false);
    assert.equal(backend.events.includes('stopping'), false);
    ack.resolve();
    await stopping;
    assert.equal(backend.ackCount, 1);
    assert.ok(backend.events.indexOf('ack-end') < backend.events.indexOf('stopping'));
    assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
    assert.equal(events.filter(event => event.type === 'turn.failed').length, 0);
  } finally { ack.resolve(); await host.shutdown(); }
});

test('rejection immediately suppresses the active instance and replaces its history after acquisition', async () => {
  const { host, backend, provider, events } = await fixture();
  const wait = deferred<void>(); backend.acquireWait = wait.promise;
  host.submitChat({ text: 'question', questionOverride: false });
  await until(() => backend.acquisitionCount === 1);
  const old = provider.current;
  backend.safetyValue = { ...backend.safetyValue, generation: '3'.repeat(32) };
  host.invalidate('coreRejected');
  assert.equal(host.isProviderCurrent(old.providerInstanceId), false);
  wait.resolve();
  await until(() => provider.sessions.length === 2 && host.status.provider.state === 'ready');
  assert.equal(backend.ackCount, 0);
  assert.equal(old.requests.length, 0);
  assert.equal(events.filter(event => event.type === 'turn.failed' && event.code === 'stateInvalidated').length, 1);
  assert.equal(provider.calls.at(-1), null);
  await host.shutdown();
});

test('override-reset exit preserves successful acknowledgement before reconnect binding', async () => {
  const { host, backend, provider, events } = await fixture();
  const ack = deferred<void>(); backend.ackWait = ack.promise;
  provider.current.action = async (_request, session) => { session.exit('overrideReset'); return { kind: 'completed', text: 'completed override' }; };
  host.submitChat({ text: 'question', questionOverride: true });
  await until(() => backend.events.includes('ack-start'));
  assert.equal(provider.sessions.length, 1);
  ack.resolve();
  await until(() => provider.sessions.length === 2 && host.status.provider.state === 'ready');
  assert.equal(backend.ackCount, 1);
  assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 0);
  assert.deepEqual(provider.calls, [null, 'session-1']);
  assert.ok(backend.events.lastIndexOf('bind:session-1:1:true') > backend.events.indexOf('ack-end'));
  await host.shutdown();
});

test('named resumes admit index, generation and instructions before calling provider', async () => {
  const { host, backend, provider } = await fixture();
  assert.equal(await host.resumeAgentSession('absent'), 'unknownSession');
  const binding = backend.binding!;
  backend.index = indexCurrentBinding(backend.index, { ...binding, providerSessionId: 'old-generation', stateGeneration: '9'.repeat(32) }, timestamp);
  backend.index = indexCurrentBinding(backend.index, { ...binding, providerSessionId: 'old-instructions', instructionsSha256: '8'.repeat(64) }, timestamp);
  assert.equal(await host.resumeAgentSession('old-generation'), 'stateInvalidated');
  assert.equal(await host.resumeAgentSession('old-instructions'), 'instructionsChanged');
  assert.equal(provider.calls.length, 1);
  backend.index = indexCurrentBinding(backend.index, { ...binding, providerSessionId: 'valid-session' }, timestamp);
  assert.equal(await host.resumeAgentSession('valid-session'), 'resumed');
  assert.equal(backend.binding?.needsState, true);
  assert.equal(backend.binding?.stateGeneration, generation);
  await host.shutdown();
});

test('failed admitted named resume restores the previous logical binding', async () => {
  const { host, backend, provider } = await fixture();
  const previous = backend.binding!;
  backend.index = indexCurrentBinding(backend.index, { ...previous, providerSessionId: 'unavailable-session' }, timestamp);
  provider.failures.add('unavailable-session');
  assert.equal(await host.resumeAgentSession('unavailable-session'), 'unknownSession');
  assert.equal(backend.binding?.providerSessionId, previous.providerSessionId);
  assert.deepEqual(provider.calls, [null, 'unavailable-session', previous.providerSessionId]);
  assert.equal(host.status.provider.state, 'ready');
  await host.shutdown();
});

test('unsent override setup failure keeps its redelivery mark and does not spend a window attempt', async () => {
  const { host, backend, provider, events } = await fixture();
  const session = provider.current;
  session.sendTurn = async () => { session.exit('overrideReset'); return { kind: 'failed', code: 'providerError', retryable: true }; };
  host.submitChat({ text: 'question', questionOverride: true });
  await until(() => provider.sessions.length === 2 && host.status.provider.state === 'ready');
  assert.ok(backend.events.includes('markSent'));
  assert.equal(backend.ackCount, 0);
  assert.equal(host.status.windowRecovery?.descendingFailures, 0);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 1);
  assert.equal(provider.current.requests.length, 0);
  await host.shutdown();
});

test('actual provider start failures exhaust the documented delays and report unavailable', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider(); provider.failAll = true;
  const delays: number[] = [];
  const phases: StartupPhase[] = [];
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {},
    delay: async milliseconds => { delays.push(milliseconds); } });
  assert.equal(await host.start(phase => phases.push(phase)), false);
  assert.deepEqual(delays, [1000, 5000, 30000]);
  assert.equal(provider.calls.length, 4);
  assert.deepEqual(phases, ['providerStart', 'providerRetry', 'providerStart', 'providerRetry', 'providerStart', 'providerRetry', 'providerStart']);
  assert.equal(host.status.provider.state, 'failed');
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'providerUnavailable');
  await host.shutdown();
});

test('shutdown retains ownership until an overlapping session start has stopped', async () => {
  const { host, backend, provider } = await fixture();
  const gate = deferred<void>();
  const start = provider.start.bind(provider);
  let starting = false;
  provider.start = async resume => { starting = true; await gate.promise; return start(resume); };
  const replacement = host.startNewAgentSession();
  await until(() => starting);
  const closing = host.shutdown();
  await flush();
  assert.equal(backend.events.includes('shutdown'), false);
  gate.resolve();
  assert.equal(await replacement, 'providerUnavailable');
  await closing;
  assert.equal(provider.current.closed, true);
  assert.equal(backend.events.at(-1), 'shutdown');
});

test('same question window exhaustion is bounded across reconnect and no automatic resend occurs', async () => {
  const { host, backend, provider, events } = await fixture();
  provider.current.action = async () => ({ kind: 'failed', code: 'contextExhausted', retryable: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(host.submitChat({ text: 'same question', questionOverride: false }).result, 'admitted');
    await until(() => !host.turnInProgress);
    if (attempt === 1) {
      provider.configure = session => { session.action = async () => ({ kind: 'failed', code: 'contextExhausted', retryable: true }); };
      provider.current.exit('subprocessExited');
      await until(() => provider.sessions.length === 2 && host.status.provider.state === 'ready');
    }
  }
  assert.equal(provider.sessions.reduce((count, session) => count + session.requests.length, 0), 4);
  assert.equal(host.status.windowRecovery?.state, 'exhausted');
  host.submitChat({ text: 'same question', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(provider.sessions.reduce((count, session) => count + session.requests.length, 0), 4);
  assert.equal(backend.acquisitionCount, 5);
  assert.equal(backend.ackCount, 0);
  const failed = events.filter(event => event.type === 'turn.failed');
  assert.equal(failed.length, 5);
  assert.equal(failed.at(-1)?.retryable, false);
  await host.shutdown();
});

test('failed next-candidate inspection preserves the provider contextExhausted terminal', async () => {
  const { host, backend, provider, events } = await fixture();
  provider.current.action = async () => {
    backend.preview = async () => { throw new Error('Candidate authority became unavailable.'); };
    return { kind: 'failed', code: 'contextExhausted', retryable: true };
  };
  host.submitChat({ text: 'question', questionOverride: false });
  await until(() => !host.turnInProgress);
  const failed = events.filter(event => event.type === 'turn.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.code, 'contextExhausted');
  assert.equal(failed[0]?.retryable, false);
  assert.equal(backend.ackCount, 0);
  await host.shutdown();
});

test('compaction during a successful turn retains needsState after acknowledgement', async () => {
  const { host, backend, provider } = await fixture();
  provider.current.action = async request => { request.onSignal({ kind: 'compaction' }); return { kind: 'completed', text: 'complete' }; };
  host.submitChat({ text: 'question', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(backend.binding?.turnsCompleted, 1);
  assert.equal(backend.binding?.needsState, true);
  await host.shutdown();
});

test('compaction arriving during acknowledgement cannot regress the completed-turn binding', async () => {
  const { host, backend, provider } = await fixture();
  const ack = deferred<void>(); backend.ackWait = ack.promise;
  host.submitChat({ text: 'question', questionOverride: false });
  await until(() => backend.events.includes('ack-start'));
  host.passiveSignal(provider.current.providerInstanceId, { kind: 'compaction' });
  ack.resolve();
  await until(() => !host.turnInProgress);
  assert.equal(backend.binding?.turnsCompleted, 1);
  assert.equal(backend.binding?.needsState, true);
  assert.deepEqual(backend.events.filter(event => event.startsWith('bind:')).slice(-2), ['bind:session-1:1:false', 'bind:session-1:1:true']);
  await host.shutdown();
});

test('compaction during provider setup reaches the actual send gate with needsState set', async () => {
  const { host, backend, provider } = await fixture();
  host.submitChat({ text: 'first', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(backend.binding?.needsState, false);
  let needsStateAtSend: boolean | null = null;
  const copy = backend.copyForSend.bind(backend);
  backend.copyForSend = async (handle, binding, identity) => { needsStateAtSend = binding.needsState; return copy(handle, binding, identity); };
  provider.current.beforeSend = async () => { host.passiveSignal(provider.current.providerInstanceId, { kind: 'compaction' }); };
  host.submitChat({ text: 'second', questionOverride: true });
  await until(() => !host.turnInProgress);
  assert.equal(needsStateAtSend, true);
  assert.equal(backend.binding?.needsState, true);
  await host.shutdown();
});

test('required send-time capacity refusal emits one non-retryable capacity terminal', async () => {
  const { host, backend, provider, events } = await fixture();
  let sent = 0;
  provider.current.action = async () => { sent++; return { kind: 'completed', text: 'unexpected' }; };
  backend.markSent = async () => {
    Object.assign(backend.status, { capacity: { ...backend.status.capacity, runtimeMarker: { state: 'exhausted', reason: null, dimensions: ['freeSpace'] } } });
    host.statusChanged();
    return true;
  };
  backend.copyForSend = async () => { throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['freeSpace'] }, 'runtimeMarker'); };
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await until(() => !host.turnInProgress);
  const failures = events.filter(event => event.type === 'turn.failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, 'capacityBlocked');
  assert.equal(failures[0]?.retryable, false);
  assert.equal(sent, 0);
  assert.equal(backend.ackCount, 0);
  assert.equal(host.submitChat({ text: 'next question', questionOverride: false }).result, 'notReady');
  await host.shutdown();
});

test('required compaction binding capacity refusal retains its typed failure', async () => {
  const { host, backend, provider, events } = await fixture();
  backend.sessions.bind = async () => {
    Object.assign(backend.status, { capacity: { ...backend.status.capacity, ordinary: { state: 'exhausted', reason: null, dimensions: ['freeSpace'] } } });
    throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['freeSpace'] }, 'ordinary');
  };
  provider.current.beforeSend = async () => { host.passiveSignal(provider.current.providerInstanceId, { kind: 'compaction' }); };
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await until(() => !host.turnInProgress);
  const failures = events.filter(event => event.type === 'turn.failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, 'capacityBlocked');
  assert.equal(failures[0]?.retryable, false);
  assert.equal(backend.ackCount, 0);
  assert.equal(host.submitChat({ text: 'next question', questionOverride: false }).result, 'notReady');
  await host.shutdown();
});

test('post-send capacity refusal takes precedence over failed provider outcomes but not an issued terminal', async () => {
  const cases = [
    { name: 'provider', outcome: { kind: 'failed', code: 'providerError', retryable: true }, code: 'capacityBlocked', retryable: false, interrupt: false },
    { name: 'window', outcome: { kind: 'failed', code: 'contextExhausted', retryable: true }, code: 'capacityBlocked', retryable: false, interrupt: false },
    { name: 'completed', outcome: { kind: 'completed', text: 'answer' }, code: 'capacityBlocked', retryable: false, interrupt: false },
    { name: 'interrupted', outcome: { kind: 'failed', code: 'providerError', retryable: true }, code: 'interrupted', retryable: true, interrupt: true },
  ] as const;
  for (const scenario of cases) {
    const { host, backend, provider, events } = await fixture();
    const release = deferred<void>();
    let sentActions = 0;
    backend.sessions.bind = async () => {
      Object.assign(backend.status, { capacity: { ...backend.status.capacity, ordinary: { state: 'exhausted', reason: null, dimensions: ['freeSpace'] } } });
      throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['freeSpace'] }, 'ordinary');
    };
    provider.current.action = async request => {
      sentActions++;
      request.onSignal({ kind: 'compaction' });
      await release.promise;
      return scenario.outcome;
    };
    try {
      assert.equal(host.submitChat({ text: scenario.name, questionOverride: false }).result, 'admitted');
      await until(() => host.status.capacity.ordinary.state === 'exhausted');
      assert.equal(sentActions, 1);
      if (scenario.interrupt) { assert.equal(await host.interrupt(), 'interrupted'); }
      release.resolve();
      await until(() => !host.turnInProgress);
      const failures = events.filter(event => event.type === 'turn.failed');
      assert.equal(failures.length, 1, scenario.name);
      assert.equal(failures[0]?.code, scenario.code, scenario.name);
      assert.equal(failures[0]?.retryable, scenario.retryable, scenario.name);
      assert.equal(events.filter(event => event.type === 'turn.completed').length, 0, scenario.name);
      assert.equal(backend.ackCount, 0, scenario.name);
      assert.equal(host.submitChat({ text: 'next', questionOverride: false }).result, 'notReady', scenario.name);
    } finally { release.resolve(); await host.shutdown(); }
  }
});

test('a completed answer without durable acknowledgement preserves the opening counter', async () => {
  const { host, backend, events } = await fixture();
  backend.failAck = true;
  host.submitChat({ text: 'first', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
  assert.equal(backend.binding?.turnsCompleted, 0);
  assert.equal(backend.ackCount, 0);
  backend.failAck = false;
  host.submitChat({ text: 'second', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(backend.binding?.turnsCompleted, 1);
  assert.equal(backend.ackCount, 1);
  await host.shutdown();
});

test('pre-send disclosure uses its actual candidate and current provider source ignores old instances', async () => {
  const { host, backend, provider } = await fixture();
  backend.fallback = true;
  const original = provider.current;
  host.passiveSignal(original.providerInstanceId, { kind: 'source', credentialSource: 'none' });
  assert.equal(host.status.provider.credentialSource, 'none');
  host.submitChat({ text: 'question', questionOverride: false });
  await until(() => !host.turnInProgress);
  assert.equal(backend.copied?.disclosureOnly, true);
  assert.equal(await host.startNewAgentSession(), 'started');
  host.passiveSignal(original.providerInstanceId, { kind: 'source', credentialSource: 'old-source' });
  assert.equal(host.status.provider.credentialSource, null);
  assert.equal(host.status.windowRecovery, null);
  await host.shutdown();
});

for (const stage of ['acquisition', 'sendFallback'] as const) {
  for (const outcome of ['success', 'contextExhausted'] as const) {
    test(`the ${stage} disclosure after a window failure is sent and preserves the ladder on ${outcome}`, async () => {
      const { host, backend, provider } = await fixture();
      provider.current.action = async () => ({ kind: 'failed', code: 'contextExhausted', retryable: true });
      assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
      await until(() => !host.turnInProgress);
      backend.disclosureOnly = stage === 'acquisition';
      backend.fallback = stage === 'sendFallback';
      provider.current.action = async request => {
        assert.equal(request.contextBlock, '<companion-turn-context>disclosure</companion-turn-context>');
        return outcome === 'success' ? { kind: 'completed', text: 'Validation is pending.' } : { kind: 'failed', code: 'contextExhausted', retryable: true };
      };
      assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
      await until(() => !host.turnInProgress);
      assert.equal(provider.current.requests.length, 2);
      assert.equal(backend.copied?.disclosureOnly, true);
      assert.equal(backend.copied?.candidate.shape, 1);
      assert.equal(backend.ackCount, 0);
      assert.equal(backend.binding?.turnsCompleted, 0);
      assert.equal(host.status.windowRecovery?.descendingFailures, outcome === 'success' ? 1 : 2);
      assert.equal(host.status.windowRecovery?.revalidationAvailable, true);
      backend.disclosureOnly = false; backend.fallback = false;
      provider.current.action = async () => ({ kind: 'completed', text: 'Current state is available.' });
      assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
      await until(() => !host.turnInProgress);
      assert.equal(provider.current.requests.length, 3);
      assert.equal(backend.copied?.candidate.shape, 2);
      assert.equal(backend.ackCount, 1);
      assert.equal(host.status.windowRecovery?.descendingFailures, outcome === 'success' ? 1 : 2);
      await host.shutdown();
    });
  }
}

test('unavailable safety prevents any provider startup', async () => {
  const backend = new FakeBackend(); backend.unavailable = true;
  const provider = new FakeProvider();
  const phases: StartupPhase[] = [];
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(phase => phases.push(phase)), false);
  assert.deepEqual(phases, []);
  assert.equal(provider.calls.length, 0);
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'notReady');
  assert.equal(host.attach(() => {}).result, 'attached');
  await host.shutdown();
});

test('unresolved checked operation forbids provider start before any subprocess exists', async () => {
  const backend = new FakeBackend(); backend.safetyValue = { ...backend.safetyValue, pendingCheck: '5'.repeat(32) };
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), false);
  assert.equal(provider.calls.length, 0);
  await host.shutdown();
});

test('a pending checked turn blocks later client operations without changing its provider', async () => {
  const { host, backend, provider, events } = await fixture();
  const session = provider.current;
  const binding = backend.binding;
  const indexed = backend.index;
  backend.acquire = async () => {
    backend.acquisitionCount += 1;
    backend.safetyValue = { ...backend.safetyValue, pendingCheck: '7'.repeat(32) };
    Object.assign(backend.status, { capacity: { ...backend.status.capacity, ordinary: { state: 'exhausted', reason: null, dimensions: ['freeSpace'] } },
      freshness: { ...backend.status.freshness, state: 'failed', class: 'journal', reason: 'settlementPending' },
      stateSafety: { state: 'recovering', correction: null },
    });
    host.statusChanged();
    throw new PendingStateCheckError();
  };
  assert.equal(host.submitChat({ text: 'original question', questionOverride: false }).result, 'admitted');
  await until(() => !host.turnInProgress);
  const statusAt = events.findIndex(event => event.type === 'status.changed' && event.status.stateSafety.state === 'recovering');
  const failedAt = events.findIndex(event => event.type === 'turn.failed');
  assert.ok(statusAt >= 0 && failedAt > statusAt);
  const failure = events[failedAt];
  assert.ok(failure?.type === 'turn.failed');
  assert.equal(failure.code, 'stateInvalidated');
  assert.equal(failure.retryable, false);
  assert.equal(host.status.capacity.ordinary.state, 'exhausted');
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 1);
  assert.equal(provider.current.requests.length, 0);
  assert.equal(backend.ackCount, 0);
  assert.deepEqual(host.submitChat({ text: 'another question', questionOverride: false }), { result: 'notReady' });
  assert.deepEqual(host.submitChat({ text: '', questionOverride: false }), { result: 'invalidInput' });
  assert.equal(backend.acquisitionCount, 1);
  assert.equal(await host.startNewAgentSession(), 'providerUnavailable');
  assert.equal(await host.resumeAgentSession(session.providerSessionId), 'stateInvalidated');
  assert.equal(provider.calls.length, 1);
  assert.equal(session.closed, false);
  assert.deepEqual(backend.binding, binding);
  assert.deepEqual(backend.index, indexed);
  host.detach();
  const attached = host.attach(event => events.push(event));
  assert.equal(attached.result, 'attached');
  if (attached.result !== 'attached') { assert.fail(); }
  assert.equal(attached.snapshot.status.stateSafety.state, 'recovering');
  assert.equal(await host.interrupt(), 'noTurnInProgress');
  assert.equal(host.answerDialog({ dialogId: 'ended', cancelled: true }), 'unknownDialog');
  session.exit('subprocessExited');
  await until(() => host.status.provider.state === 'failed');
  assert.equal(provider.calls.length, 1);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 1);
  assert.equal(events.some(event => event.type === 'notice' && event.code === 'sessionReconnected'), false);
  assert.deepEqual(host.submitChat({ text: 'after exit', questionOverride: false }), { result: 'notReady' });
  await host.shutdown();
});

test('send-time relevance replaces the unsent baseline even when candidate bytes stay equal', async () => {
  const { host, backend, provider } = await fixture();
  let relevance = recoveryFingerprint('preview-content');
  const preview = backend.preview.bind(backend);
  backend.preview = async (...args) => ({ ...await preview(...args), relevanceFingerprint: relevance });
  const copy = backend.copyForSend.bind(backend);
  backend.copyForSend = async (...args) => {
    const context = await copy(...args);
    relevance = recoveryFingerprint('actual-send-content');
    return { ...context, relevanceFingerprint: relevance };
  };
  provider.current.action = async () => ({ kind: 'failed', code: 'contextExhausted', retryable: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(host.submitChat({ text: 'same question', questionOverride: false }).result, 'admitted');
    await until(() => !host.turnInProgress);
  }
  assert.equal(provider.current.requests.length, 2);
  assert.equal(backend.acquisitionCount, 2);
  assert.equal(backend.ackCount, 0);
  assert.equal(host.status.windowRecovery?.descendingFailures, 2);
  assert.equal(host.status.windowRecovery?.revalidationAvailable, true);
  await host.shutdown();
});

for (const stage of ['copy', 'enqueue'] as const) {
  test(`compaction during send-time ${stage} prevents a state-omitting enqueue`, async () => {
    const { host, backend, provider, events } = await fixture();
    assert.equal(host.submitChat({ text: 'opening', questionOverride: false }).result, 'admitted');
    await until(() => !host.turnInProgress);
    assert.equal(backend.binding?.needsState, false);

    const preview = backend.preview.bind(backend);
    backend.preview = async (...args) => {
      const result = await preview(...args);
      return { ...result, preview: { candidates: [{ ...result.preview.candidates[0]!, eventCount: 0, stateIncluded: false }] } };
    };
    const entered = deferred<void>();
    const release = deferred<void>();
    if (stage === 'copy') {
      const copy = backend.copyForSend.bind(backend);
      backend.copyForSend = async (...args) => {
        const result = await copy(...args);
        entered.resolve();
        await release.promise;

        return result;
      };
    } else {
      provider.current.afterPrepare = async () => {
        provider.current.requests.at(-1)!.onSignal({ kind: 'compaction' });
        await until(() => backend.binding?.needsState === true);
      };
    }
    let delivered = 0;
    provider.current.action = async () => { delivered += 1; return { kind: 'completed', text: 'unsafe answer' }; };
    assert.equal(host.submitChat({ text: 'next', questionOverride: false }).result, 'admitted');
    if (stage === 'copy') {
      await entered.promise;
      provider.current.requests.at(-1)!.onSignal({ kind: 'compaction' });
      await until(() => backend.binding?.needsState === true);
      release.resolve();
    }
    await until(() => !host.turnInProgress);
    assert.equal(delivered, 0);
    assert.equal(backend.ackCount, 1);
    assert.equal(backend.binding?.needsState, true);
    assert.equal(events.filter(event => event.type === 'turn.failed').at(-1)?.code, 'providerError');
    await host.shutdown();
  });
}

test('a required capacity refusal is reported after status and blocks later input without changing the provider session', async () => {
  const { host, backend, provider, events } = await fixture();
  const prior = provider.current;
  backend.acquire = async () => {
    backend.acquisitionCount += 1;
    Object.assign(backend.status, { capacity: { ...backend.status.capacity, ordinary: { state: 'unavailable', reason: 'scopeAuthority', dimensions: [] } } });
    throw new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: ['scopeAuthority'] }, 'ordinary');
  };
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await until(() => !host.turnInProgress);
  const statusAt = events.findIndex(event => event.type === 'status.changed' && event.status.capacity.ordinary.state === 'unavailable');
  const failedAt = events.findIndex(event => event.type === 'turn.failed');
  assert.ok(statusAt >= 0 && failedAt > statusAt);
  const failure = events[failedAt];
  assert.ok(failure?.type === 'turn.failed');
  assert.equal(failure.code, 'capacityBlocked');
  assert.equal(failure.retryable, false);
  assert.equal(provider.current.requests.length, 0);
  assert.equal(backend.ackCount, 0);
  assert.deepEqual(host.submitChat({ text: 'again', questionOverride: false }), { result: 'notReady' });
  assert.equal(backend.acquisitionCount, 1);
  assert.equal(await host.startNewAgentSession(), 'started');
  assert.equal(host.status.capacity.ordinary.state, 'unavailable');
  assert.deepEqual(host.submitChat({ text: 'after new', questionOverride: false }), { result: 'notReady' });
  assert.equal(prior.closed, true);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 1);
  await host.shutdown();
});

test('an optional sent-mark capacity failure may complete one admitted turn but blocks later input', async () => {
  const { host, backend, provider, events } = await fixture();
  backend.markSent = async () => {
    backend.events.push('markSent');
    Object.assign(backend.status, { capacity: { ...backend.status.capacity, ordinary: { state: 'exhausted', reason: null, dimensions: ['freeSpace'] } } });
    host.statusChanged();
    return false;
  };
  assert.equal(host.submitChat({ text: 'one send', questionOverride: false }).result, 'admitted');
  await until(() => !host.turnInProgress);
  assert.equal(provider.current.requests.length, 1);
  assert.equal(backend.ackCount, 1);
  assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
  assert.equal(events.filter(event => event.type === 'turn.failed').length, 0);
  assert.deepEqual(host.submitChat({ text: 'later', questionOverride: false }), { result: 'notReady' });
  assert.equal(backend.acquisitionCount, 1);
  await host.shutdown();
});
