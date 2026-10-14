import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseStrictJson } from '../src/json.ts';
import { StartupCoreReplySession } from '../src/startup-core-reply.ts';
import { StartupMutationSession } from '../src/startup-mutation.ts';
import type { StartupWorkerReply, StartupWorkerTransport } from '../src/startup-worker-transport.ts';

const root = 'C:/private-startup';
const reader = fileURLToPath(new URL('../scripts/Read-CoreReply.ps1', import.meta.url));
const writer = fileURLToPath(new URL('../scripts/Write-RuntimeFile.ps1', import.meta.url));
const codec = fileURLToPath(new URL('../scripts/Invoke-PayloadCodec.ps1', import.meta.url));
const parsed = (value: unknown) => parseStrictJson(Buffer.from(JSON.stringify(value)));

function fakeTransport(reply: StartupWorkerReply) {
  let invalidated = 0;
  const calls: { operation: string; fields: Record<string, unknown>; timeout: number }[] = [];
  const transport = { canFallBack: false, async request(operation: string, fields: Record<string, unknown>, timeout: number) {
    calls.push({ operation, fields, timeout }); return reply;
  }, async invalidate() { invalidated++; }, async close() {} } as unknown as StartupWorkerTransport;
  return { transport, calls, invalidated: () => invalidated };
}

test('core reply session preserves validated refusal and invalidates unknown worker output', async () => {
  const refused = fakeTransport({ status: 'error', code: 'coreReplyInvalid' });
  const session = Object.assign(Object.create(StartupCoreReplySession.prototype), { transport: refused.transport, companionRoot: root }) as StartupCoreReplySession;
  const args = ['-CompanionRoot', root, '-Operation', 'Consumer'];
  const input = Buffer.from(JSON.stringify({ exitCode: 0, stdout: '{}', stderr: '' }));
  const result = await session.invoke(reader, args, root, 30000, input);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr.toString('utf8').trim(), 'Read-CoreReply: core-reply-invalid');
  assert.deepEqual(refused.calls.map(call => call.operation), ['validateCore']);
  assert.equal(refused.invalidated(), 0);

  const accepted = fakeTransport({ status: 'ok', result: parsed({ coreReplyVersion: 1, success: true, class: null,
    reason: null, targetIdentitySha256: null, data: {} }) });
  const valid = Object.assign(Object.create(StartupCoreReplySession.prototype), { transport: accepted.transport, companionRoot: root }) as StartupCoreReplySession;
  assert.equal((await valid.invoke(reader, args, root, 30000, input)).exitCode, 0);
  assert.equal(accepted.invalidated(), 0);

  for (const reply of [{ status: 'error', code: 'unexpected' } as const,
    { status: 'ok', result: parsed({ coreReplyVersion: 1, success: true }) } as const]) {
    const fault = fakeTransport(reply);
    const active = Object.assign(Object.create(StartupCoreReplySession.prototype), { transport: fault.transport, companionRoot: root }) as StartupCoreReplySession;
    await assert.rejects(active.invoke(reader, args, root, 30000, input));
    assert.equal(fault.invalidated(), 1);
  }
});

test('mutation session maps native refusal codes and rejects malformed success', async () => {
  const writeOptions = { command: 'pwsh', cwd: root, args: ['-NoProfile', '-File', writer, '-Root', root,
    '-Target', root + '/probe.json', '-InputFile', root + '/probe.json.' + '1'.repeat(32) + '.tmp',
    '-Sha256', 'a'.repeat(64), '-Profile', 'config', '-CreateOnly'] };
  const codecOptions = { command: 'pwsh', cwd: root, args: ['-NoProfile', '-File', codec, '-Root', root,
    '-Target', root + '/codec.json', '-InputFile', root + '/codec.json.' + '1'.repeat(32) + '.tmp',
    '-InputSha256', 'a'.repeat(64), '-ControlFile', root + '/codec.json.' + '2'.repeat(32) + '.tmp',
    '-ControlSha256', 'b'.repeat(64)] };
  for (const [options, code, expected] of [
    [writeOptions, 'publicationFailed', 'Write-RuntimeFile: publication-failed'],
    [codecOptions, 'documentInvalid', 'Invoke-PayloadCodec: document-invalid'],
    [codecOptions, 'codecUnavailable', 'Invoke-PayloadCodec: codec-unavailable'],
  ] as const) {
    const fixture = fakeTransport({ status: 'error', code });
    const session = Object.assign(Object.create(StartupMutationSession.prototype), { transport: fixture.transport, root }) as StartupMutationSession;
    const result = await session.invoke(options, 120000);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr.toString('utf8').trim(), expected);
    assert.equal(fixture.calls[0]?.timeout, 30000);
    assert.equal(fixture.invalidated(), 0);
  }

  const malformed = fakeTransport({ status: 'ok', result: parsed({ published: true }) });
  const session = Object.assign(Object.create(StartupMutationSession.prototype), { transport: malformed.transport, root }) as StartupMutationSession;
  await assert.rejects(session.invoke(writeOptions, 30000));
  assert.equal(malformed.invalidated(), 1);
});
