import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SessionHost } from '../../src/session-host.ts';
import { credentialSourceLabel, runTextClient } from '../../src/text-client.ts';
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
