import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { DataRootUnavailableError } from '../src/admission.ts';
import { encodeStartupMetadataFrame, FramedReplies, parseStartupMetadataReply } from '../src/startup-metadata.ts';

function workerStream() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let kills = 0;
  let resolveTermination!: (exit: { code: number; signal: null; failure: null }) => void;
  const terminated = new Promise<{ code: number; signal: null; failure: null }>(resolve => { resolveTermination = resolve; });
  const child = { stdout, stderr, terminated, kill: () => { kills += 1; return true; } };
  return { child, stdout, stderr, kills: () => kills, terminate: () => { stdout.end(); stderr.end(); resolveTermination({ code: 0, signal: null, failure: null }); } };
}

function framed(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

test('framed worker accepts fragmented replies and rejects unsolicited output', async () => {
  const worker = workerStream();
  const replies = new FramedReplies(worker.child);
  const payload = Buffer.from('{"version":1}', 'utf8');
  const bytes = framed(payload);
  const pending = replies.next(1000);
  worker.stdout.write(bytes.subarray(0, 2));
  worker.stdout.write(bytes.subarray(2, 5));
  worker.stdout.write(bytes.subarray(5));
  assert.deepEqual(await pending, payload);
  worker.stdout.write(framed(Buffer.from('{"unexpected":true}', 'utf8')));
  assert.ok(replies.fault instanceof DataRootUnavailableError);
  assert.equal(worker.kills(), 1);
  worker.terminate();
});

test('framed worker rejects oversized output and timed-out or noisy replies', async () => {
  const oversized = workerStream();
  const output = new FramedReplies(oversized.child);
  const pending = output.next(1000);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(65537);
  oversized.stdout.write(header);
  await assert.rejects(pending, DataRootUnavailableError);
  assert.equal(oversized.kills(), 1);
  oversized.terminate();

  const timed = workerStream();
  const waiting = new FramedReplies(timed.child);
  await assert.rejects(waiting.next(5), DataRootUnavailableError);
  assert.equal(timed.kills(), 1);
  timed.terminate();

  const noisy = workerStream();
  const noise = new FramedReplies(noisy.child);
  const response = noise.next(1000);
  noisy.stderr.write('unexpected');
  await assert.rejects(response, DataRootUnavailableError);
  assert.equal(noisy.kills(), 1);
  noisy.terminate();
});

test('reply parser refuses wrong correlation, duplicate fields, and unrecognized outcomes', () => {
  const id = 'a'.repeat(32);
  const good = Buffer.from(JSON.stringify({ version: 1, id, op: 'admit', status: 'ok', result: { paths: [] } }));
  assert.deepEqual(JSON.parse(parseStartupMetadataReply(good, id, 'admit').stdout.toString('utf8')), { paths: [] });
  for (const value of [
    { version: 1, id: 'b'.repeat(32), op: 'admit', status: 'ok', result: { paths: [] } },
    { version: 1, id, op: 'hash', status: 'ok', result: { paths: [] } },
    { version: 1, id, op: 'admit', status: 'ok', result: { paths: [] }, extra: true },
    { version: 1, id, op: 'admit', status: 'error', code: 'hashUnavailable' },
  ]) {
    assert.throws(() => parseStartupMetadataReply(Buffer.from(JSON.stringify(value)), id, 'admit'));
  }
  assert.throws(() => parseStartupMetadataReply(Buffer.from('{"version":1,"version":1,"id":"' + id + '"}', 'utf8'), id, 'admit'));
});

test('hash transport admits a full decoded control input without losing the framed bound', () => {
  const inputBase64 = Buffer.alloc(1048576).toString('base64');
  const encoded = encodeStartupMetadataFrame({ version: 1, id: 'a'.repeat(32), op: 'hash', root: 'C:/private', remainingMs: 30000,
    inputBase64, inputSha256: 'b'.repeat(64), scopeSha256: null });
  assert.ok(encoded.length > 1048576);
  assert.ok(encoded.length <= 2097156);
  assert.equal(encoded.readUInt32BE(0), encoded.length - 4);
  assert.throws(() => encodeStartupMetadataFrame({ inputBase64: Buffer.alloc(2097152).toString('base64') }));
});
