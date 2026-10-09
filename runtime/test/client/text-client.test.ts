import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PendingStateCheckError } from '../../src/backend/api.ts';
import { SessionHost } from '../../src/session-host.ts';
import { initialCapacity } from '../../src/capacity.ts';
import { credentialSourceLabel, formatCapacity, runTextClient } from '../../src/text-client.ts';
import { FakeBackend, FakeProvider, instructionHash, until } from './support.ts';

test('credential source renders SDK metadata without inferring authentication kind', () => {
  assert.equal(credentialSourceLabel(null), 'unavailable');
  assert.equal(credentialSourceLabel('none'), 'no API key reported; non-API-key method unspecified');
  assert.equal(credentialSourceLabel('environment'), 'environment');
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
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
  const running = runTextClient(host, { input, output, terminal: false });
  input.write('/think literal @path /command\n');
  await until(() => text.includes('preview evidence'));
  input.write('2\n');
  await until(() => text.includes('Explain?'));
  input.write('free text\n');
  await until(() => text.includes('done'));
  input.write('/quit\n');
  await running;
  assert.ok(text.includes('2. Second: two'));
  assert.equal(backend.acquisitionCount, 1);
  assert.equal(backend.events.at(-1), 'shutdown');
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
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk: Buffer) => { rendered += chunk.toString('utf8'); });
  const running = runTextClient(host, { input, output, terminal: false });
  input.write('Original private question.\n');
  await until(() => rendered.includes('restart chat'));
  assert.match(rendered, /State validation was interrupted/);
  assert.match(rendered, /question was not resent/);
  assert.equal(provider.current.requests.length, 0);
  assert.equal(backend.ackCount, 0);
  input.write('Resubmit without restart.\n');
  await until(() => rendered.includes('Question not sent: notReady'));
  assert.equal(backend.acquisitionCount, 1);
  input.write('/quit\n');
  await running;
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
