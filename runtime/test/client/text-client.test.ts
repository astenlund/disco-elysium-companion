import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PendingStateCheckError } from '../../src/backend/api.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { SessionHostV1 } from '../../src/session-host-contract.ts';
import { initialCapacity } from '../../src/capacity.ts';
import type { DialogAnswer } from '../../src/provider.ts';
import { credentialSourceLabel, formatCapacity, runTextClient } from '../../src/text-client.ts';
import { deferred, FakeBackend, FakeProvider, instructionHash, until } from './support.ts';

function clientStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk: Buffer) => { rendered += chunk.toString('utf8'); });
  return { input, output, read: () => rendered };
}

test('credential source renders SDK metadata without inferring authentication kind', () => {
  assert.equal(credentialSourceLabel(null), 'unavailable');
  assert.equal(credentialSourceLabel('none'), 'no API key reported; non-API-key method unspecified');
  assert.equal(credentialSourceLabel('environment'), 'environment');
});

test('text client reports internal attachment cancellation without an already-attached claim', async () => {
  const host = { requiresVerifiedAttach: true, attachVerified: async () => ({ result: 'attachCancelled' as const }), shutdown: async () => {} } as unknown as SessionHostV1;
  const { input, output } = clientStreams();
  await assert.rejects(runTextClient(host, { input, output, terminal: false }), /Client attachment was cancelled/);
});

test('text client renders previews and routes numbered, free-text and override input', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  await host.start();
  provider.current.action = async request => {
    assert.equal(request.playerText, 'literal @path /command');
    assert.deepEqual(request.override, { model: 'override', effort: 'high' });
    const answer = await request.askUser([
      { question: 'Select?', header: 'Selection', multiSelect: false, options: [{ label: 'First', description: 'one', preview: 'preview evidence' }, { label: 'Second', description: 'two' }] },
      { question: 'Explain?', header: 'Explanation', multiSelect: false, options: [{ label: 'Option A', description: 'a' }, { label: 'Option B', description: 'b' }] },
    ]);
    assert.deepEqual(answer, { answers: { 'Select?': 'Second', 'Explain?': 'free text' } });
    return { kind: 'completed', text: 'done' };
  };
  const { input, output, read } = clientStreams();
  let attached = 0;
  const running = runTextClient(host, { input, output, terminal: false, onAttached: () => { attached += 1; assert.equal(read(), ''); } });
  input.write('/think literal @path /command\n');
  await until(() => read().includes('preview evidence'));
  input.write('2\n');
  await until(() => read().includes('Explain?'));
  input.write('free text\n');
  await until(() => read().includes('done'));
  input.write('/quit\n');
  await running;
  assert.ok(read().includes('2. Second: two'));
  assert.equal(attached, 1);
  assert.equal(backend.acquisitionCount, 1);
  assert.equal(backend.events.at(-1), 'shutdown');
});

const prototypeNamedQuestions = [
  { question: '__proto__', header: 'Prototype', multiSelect: false, options: [{ label: 'First', description: 'one' }, { label: 'Second', description: 'two' }] },
  { question: 'Explain?', header: 'Explanation', multiSelect: false, options: [{ label: 'Option A', description: 'a' }, { label: 'Option B', description: 'b' }] },
];

function prototypeDialogHost() {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  return { provider, host };
}

function onlyAnswers(received: readonly DialogAnswer[]): Readonly<Record<string, string>> {
  assert.equal(received.length, 1);
  const [answer] = received;
  assert.ok(answer !== undefined && 'answers' in answer, 'the dialog was answered rather than cancelled');
  return answer.answers;
}

function assertOwnAnswer(answers: Readonly<Record<string, string>>, question: string, expected: string): void {
  assert.ok(Object.hasOwn(answers, question), `answer for ${question} is an own property`);
  assert.equal(Object.getOwnPropertyDescriptor(answers, question)?.value, expected);
}

test('text client answers a question whose text is __proto__ by number', async () => {
  // Arrange
  const { provider, host } = prototypeDialogHost();
  await host.start();
  const received: DialogAnswer[] = [];
  provider.current.action = async request => { received.push(await request.askUser(prototypeNamedQuestions)); return { kind: 'completed', text: 'done' }; };
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });

  // Act
  input.write('Ask me.\n');
  await until(() => read().includes('2. Second: two'));
  input.write('2\n');
  await until(() => read().includes('Explain?'));
  input.write('free text\n');
  await until(() => read().includes('done'));
  input.write('/quit\n');
  await running;

  // Assert
  const answers = onlyAnswers(received);
  assertOwnAnswer(answers, '__proto__', 'Second');
  assertOwnAnswer(answers, 'Explain?', 'free text');
  assert.doesNotMatch(read(), /Dialog answer: invalidAnswer/);
});

test('text client re-asks a __proto__ dialog from a fresh answer set after a refused answer', async () => {
  // Arrange
  const { provider, host } = prototypeDialogHost();
  await host.start();
  const answerDialog = host.answerDialog.bind(host);
  let refusals = 1;
  host.answerDialog = input => { if (refusals > 0 && !('cancelled' in input)) { refusals -= 1; return 'invalidAnswer'; } return answerDialog(input); };
  const received: DialogAnswer[] = [];
  provider.current.action = async request => { received.push(await request.askUser(prototypeNamedQuestions)); return { kind: 'completed', text: 'done' }; };
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });

  // Act
  input.write('Ask me.\n');
  await until(() => read().includes('2. Second: two'));
  input.write('2\n');
  await until(() => read().includes('Explain?'));
  input.write('first attempt\n');
  await until(() => read().includes('Dialog answer: invalidAnswer.'));
  await until(() => read().split('2. Second: two').length === 3);
  input.write('1\n');
  await until(() => read().split('Explain?').length === 3);
  input.write('second attempt\n');
  await until(() => read().includes('done'));
  input.write('/quit\n');
  await running;

  // Assert
  assert.equal(refusals, 0);
  const answers = onlyAnswers(received);
  assertOwnAnswer(answers, '__proto__', 'First');
  assertOwnAnswer(answers, 'Explain?', 'second attempt');
});

test('text client cancels a __proto__ dialog', async () => {
  // Arrange
  const { provider, host } = prototypeDialogHost();
  await host.start();
  const received: DialogAnswer[] = [];
  provider.current.action = async request => { received.push(await request.askUser(prototypeNamedQuestions)); return { kind: 'completed', text: 'done' }; };
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });

  // Act
  input.write('Ask me.\n');
  await until(() => read().includes('2. Second: two'));
  input.write('/cancel\n');
  await until(() => read().includes('done'));
  input.write('/quit\n');
  await running;

  // Assert
  assert.deepEqual(received, [{ cancelled: true }]);
});

test('text client explains the blocked pending-check restart without resending', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  backend.acquire = async () => {
    backend.acquisitionCount += 1;
    backend.safetyValue = { ...backend.safetyValue, pendingCheck: '7'.repeat(32) };
    Object.assign(backend.status, {
      freshness: { ...backend.status.freshness, state: 'failed', class: 'journal', reason: 'settlementPending' },
      stateSafety: { state: 'recovering', correction: null },
    });
    host.statusChanged();
    throw new PendingStateCheckError();
  };
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });
  input.write('Original private question.\n');
  await until(() => read().includes('restart chat'));
  assert.match(read(), /State validation was interrupted/);
  assert.match(read(), /question was not resent/);
  assert.equal(provider.current.requests.length, 0);
  assert.equal(backend.ackCount, 0);
  input.write('Resubmit without restart.\n');
  await until(() => read().includes('Question not sent: notReady'));
  assert.equal(backend.acquisitionCount, 1);
  input.write('/quit\n');
  await running;
});

test('text client names what may still be finishing after an interrupt during acquisition', async () => {
  // Arrange
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  const acquisition = deferred<void>();
  backend.acquireWait = acquisition.promise;
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });
  input.write('Original question.\n');
  await until(() => backend.acquisitionCount === 1);

  // Act
  assert.equal(await host.interrupt(), 'interrupted');
  await until(() => read().includes('Turn interrupted'));
  input.write('Second question.\n');
  await until(() => read().includes('Question not sent: turnInProgress'));
  acquisition.resolve();
  await until(() => !host.turnInProgress);

  // Assert
  assert.match(read(), /state check or the provider may still be finishing/);
  assert.match(read(), /was not automatically resent/);
  assert.doesNotMatch(read(), /Turn failed: interrupted/);
  assert.equal(provider.current.requests.length, 0);
  input.write('/quit\n');
  await running;
});

test('text client gives the same interrupt notice while the provider is still settling', async () => {
  // Arrange
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  const settled = deferred<void>();
  let sent = false;
  provider.current.interrupt = async () => true;
  provider.current.action = async () => { sent = true; await settled.promise; return { kind: 'failed', code: 'interrupted', retryable: true }; };
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });
  input.write('Original question.\n');
  await until(() => sent);

  // Act
  assert.equal(await host.interrupt(), 'interrupted');
  await until(() => read().includes('Turn interrupted'));
  input.write('Second question.\n');
  await until(() => read().includes('Question not sent: turnInProgress'));
  settled.resolve();
  await until(() => !host.turnInProgress);

  // Assert
  assert.match(read(), /state check or the provider may still be finishing/);
  assert.doesNotMatch(read(), /Turn failed: interrupted/);
  input.write('/quit\n');
  await running;
});

test('text client shows operational warnings and named-root remediation on every status surface', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {},
    verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  const { input, output, read } = clientStreams();
  const running = runTextClient(host, { input, output, terminal: false });
  await until(() => read().includes('operational: current; warnings: none'));
  const attachment = read();
  Object.assign(backend.status, { operational: { state: 'unknown', warnings: [
    { code: 'pipeline-reaper-discovery-limit-exceeded', detail: 'tmp' },
    { code: 'pipeline-reaper-discovery-limit-exceeded', detail: 'state' },
  ] } });
  host.statusChanged();
  await until(() => read().includes('reduce the state root below its discovery ceilings'));
  const changed = read().slice(attachment.length);
  assert.match(changed, /operational: unknown/);
  assert.ok(changed.includes('pipeline-reaper-discovery-limit-exceeded (detail: tmp)'));
  assert.ok(changed.includes('pipeline-reaper-discovery-limit-exceeded (detail: state)'));
  assert.match(changed, /Stop all companion processes, reduce the tmp root below its discovery ceilings, and rerun/);
  assert.match(changed, /Stop all companion processes, reduce the state root below its discovery ceilings, and rerun/);
  const warningCount = read().split('pipeline-reaper-discovery-limit-exceeded').length - 1;
  input.write('/status\n');
  await until(() => read().split('pipeline-reaper-discovery-limit-exceeded').length - 1 > warningCount);
  Object.assign(backend.status, { operational: { state: 'current', warnings: [] } });
  host.statusChanged();
  await until(() => read().split('operational: current; warnings: none').length >= 3);
  assert.match(read().trimEnd().split('\n').at(-1)!, /operational: current; warnings: none/);
  input.write('/quit\n');
  await running;
});

test('text client directs a restart while an unfinished repair holds state validation', async () => {
  // Arrange
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, providerTerminated: async () => {},
    verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  const remedy = 'State validation waits for an unfinished repair. Use /quit and restart chat to attempt recovery; if it remains unavailable, run repair after exit.';
  Object.assign(backend.status, { journal: { state: 'fault', fault: 'repairFailed', unacknowledgedEvents: 0 },
    stateSafety: { state: 'recovering', correction: { correctionId: '8'.repeat(32), reason: 'coreRejected' }, carryRelease: 'none' } });
  host.statusChanged();
  const { input, output, read } = clientStreams();

  // Act
  const running = runTextClient(host, { input, output, terminal: false });
  await until(() => read().includes('Enter a question.'));
  const attachment = read();
  host.invalidate('coreRejected');
  await until(() => read().includes('Earlier state-based guidance may be unreliable'));
  input.write('/status\n');
  await until(() => read().split(remedy).length - 1 >= 2);
  const pending = read();
  Object.assign(backend.status, { journal: { state: 'healthy', fault: null, unacknowledgedEvents: 0 } });
  host.statusChanged();
  await until(() => read().length > pending.length && read().endsWith('\n') && read().slice(pending.length).includes('journal: healthy'));
  const cleared = read().slice(pending.length);
  input.write('/quit\n');
  await running;

  // Assert
  assert.ok(attachment.includes(`journal: fault (repairFailed)`));
  assert.ok(attachment.includes(remedy));
  assert.ok(pending.slice(attachment.length).includes(remedy));
  assert.equal(cleared.includes('unfinished repair'), false);
});

test('capacity readout keeps fixed slot order and labels each unknown obligation', () => {
  const initial = initialCapacity();
  assert.match(formatCapacity(initial), /unacknowledgedEvents=unknown/);
  assert.match(formatCapacity(initial), /historyDisclosure=unknown/);
  const capacity = { ...initial, release: { state: 'exhausted' as const, reason: null, dimensions: ['freeSpace', 'documentBytes'] as const },
    ordinary: { state: 'unavailable' as const, reason: 'scopeAuthority' as const, dimensions: [] as const },
    owed: { ...initial.owed, unacknowledgedEvents: 3, safetyObligation: true } };
  const rendered = formatCapacity(capacity);
  assert.ok(rendered.indexOf('capacity exhausted (release: freeSpace, documentBytes)') < rendered.indexOf('capacity unavailable (ordinary: scopeAuthority)'));
  assert.match(rendered, /unacknowledgedEvents=3/);
  assert.match(rendered, /safetyObligation=true/);
  for (const key of ['pendingOutboxRecords', 'unfinishedOperations', 'protectedHandoffs', 'historyDisclosure']) { assert.match(rendered, new RegExp(key + '=unknown')); }
  assert.doesNotMatch(rendered, /\/new/);
  assert.doesNotMatch(rendered, /journal is full/);
});
