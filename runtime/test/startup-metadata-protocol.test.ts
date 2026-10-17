import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import { encodeStartupMetadataFrame, FramedReplies, parseStartupMetadataReply, StartupMetadataSession } from '../src/startup-metadata.ts';

const resourceScript = fileURLToPath(new URL('../scripts/resource-lifecycle/Get-ResourceInventory.ps1', import.meta.url));
const eventScript = fileURLToPath(new URL('../scripts/Get-EventMetadata.ps1', import.meta.url));

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
  header.writeUInt32BE(131073);
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
  assert.throws(() => parseStartupMetadataReply(Buffer.alloc(65537), id, 'admit'), DataRootUnavailableError);
});

test('inventory replies require complete bounded current observations', () => {
  const id = 'a'.repeat(32);
  const result = { uncompactedEvents: 0, retainedHandoffs: 0, retainedHandoffIdentitySha256: 'b'.repeat(64), potentialHandoffs: 0,
    fullTerminalOperations: 0, unfinishedOperations: 0, invalidEvents: 0, invalidOperations: 0, pendingOutbox: 0,
    uncertainWorkspace: false, freeBytes: '1024' };
  const frame = (value: unknown) => Buffer.from(JSON.stringify(value));
  const reply = (value: unknown) => ({ version: 1, id, op: 'inventory', status: 'ok', result: value });
  assert.deepEqual(JSON.parse(parseStartupMetadataReply(frame(reply(result)), id, 'inventory').stdout.toString('utf8')), result);
  assert.equal(parseStartupMetadataReply(frame({ version: 1, id, op: 'inventory', status: 'error', code: 'inventoryUnavailable' }), id, 'inventory').exitCode, 1);
  for (const invalid of [
    { ...result, freeBytes: '-1' },
    { ...result, uncertainWorkspace: 'false' },
    { ...result, retainedHandoffIdentitySha256: 'B'.repeat(64) },
    { ...result, pendingOutbox: -1 },
    { ...result, pendingOutbox: 1.5 },
    { ...result, pendingOutbox: Number.MAX_SAFE_INTEGER + 1 },
    { ...result, extra: true },
    { ...result, freeBytes: undefined },
  ]) {
    assert.throws(() => parseStartupMetadataReply(frame(reply(invalid)), id, 'inventory'), DataRootUnavailableError);
  }
  assert.throws(() => parseStartupMetadataReply(frame({ version: 1, id, op: 'inventory', status: 'error', code: 'hashUnavailable' }), id, 'inventory'));
});

test('event batch reply keeps exact bounded compressed bytes', () => {
  const id = 'a'.repeat(32);
  const bytes = Buffer.from([1, 2, 3, 4]);
  const value = { compressedBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  const frame = (result: unknown) => Buffer.from(JSON.stringify({ version: 1, id, op: 'eventBatch', status: 'ok', result }));
  assert.deepEqual(parseStartupMetadataReply(frame(value), id, 'eventBatch').stdout, bytes);
  for (const invalid of [{ ...value, sha256: '0'.repeat(64) }, { ...value, compressedBase64: '!' },
    { ...value, extra: true }, { ...value, compressedBase64: Buffer.alloc(65537).toString('base64') }]) {
    assert.throws(() => parseStartupMetadataReply(frame(invalid), id, 'eventBatch'), DataRootUnavailableError);
  }
  assert.equal(parseStartupMetadataReply(Buffer.from(JSON.stringify({ version: 1, id, op: 'eventBatch', status: 'error',
    code: 'inspectionUnavailable' })), id, 'eventBatch').exitCode, 1);
});

test('worker source proof requires four exact hashes', () => {
  const id = 'a'.repeat(32);
  const evidence = { scopeSha256: 'a'.repeat(64), metadataSha256: 'b'.repeat(64),
    coreReplySha256: 'c'.repeat(64), mutationSha256: 'd'.repeat(64) };
  const frame = (result: unknown) => Buffer.from(JSON.stringify({ version: 1, id, op: 'sourceEvidence', status: 'ok', result }));
  assert.deepEqual(JSON.parse(parseStartupMetadataReply(frame(evidence), id, 'sourceEvidence').stdout.toString('utf8')), evidence);
  for (const invalid of [{ ...evidence, metadataSha256: 'B'.repeat(64) }, { ...evidence, extra: true },
    { ...evidence, mutationSha256: null }]) {
    assert.throws(() => parseStartupMetadataReply(frame(invalid), id, 'sourceEvidence'), DataRootUnavailableError);
  }
  assert.equal(parseStartupMetadataReply(Buffer.from(JSON.stringify({ version: 1, id, op: 'sourceEvidence', status: 'error',
    code: 'sourceUnavailable' })), id, 'sourceEvidence').exitCode, 1);
});

test('job observation replies keep the exact bounded job envelope', () => {
  const id = 'a'.repeat(32);
  const name = 'Global' + String.fromCharCode(92) + 'game-companion-process-' + '0'.repeat(32) + '-publication';
  const result = { jobs: [{ name, state: 'absent', processes: null }] };
  const reply = (value: unknown) => Buffer.from(JSON.stringify({ version: 1, id, op: 'jobBatch', status: 'ok', result: value }));
  assert.deepEqual(JSON.parse(parseStartupMetadataReply(reply(result), id, 'jobBatch').stdout.toString('utf8')), result);
  assert.equal(parseStartupMetadataReply(Buffer.from(JSON.stringify({ version: 1, id, op: 'jobBatch', status: 'error',
    code: 'jobUnavailable' })), id, 'jobBatch').exitCode, 1);
  for (const invalid of [{ jobs: [] }, { jobs: result.jobs, extra: true }, { jobs: Array(10).fill(result.jobs[0]) }]) {
    assert.throws(() => parseStartupMetadataReply(reply(invalid), id, 'jobBatch'), DataRootUnavailableError);
  }
});

test('only bounded read-only metadata operations use the startup worker', async () => {
  const routed: string[] = [];
  const prototype = Object.create(StartupMetadataSession.prototype) as StartupMetadataSession;
  const session = {
    supports: prototype.supports.bind(prototype), canFallBack: false,
    invoke: async () => { routed.push('worker'); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    close: async () => {},
  } as unknown as StartupMetadataSession;
  const supervisor = {
    run: async () => { routed.push('one-shot'); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
  } as unknown as ProcessSupervisor;
  const inspector = new PathInspector(supervisor);
  inspector.attachStartupSession(session);
  const common = ['-Root', 'root', '-ScopeSha256', 'f'.repeat(64), '-CompanionRoot', 'companion', '-Mode'];
  await inspector.metadata(resourceScript, [...common, 'Inventory'], 'root');
  await inspector.metadata(resourceScript, [...common, 'Marker'], 'root');
  await inspector.metadata(eventScript, ['-Root', 'root', '-Batch'], 'root', 30000, Buffer.from('[]'));
  await inspector.metadata(eventScript, ['-Root', 'root', '-Batch'], 'root', 30000, Buffer.alloc(1048577));
  await inspector.metadata(resourceScript, [...common, 'Event'], 'root', 30000, Buffer.from('{}'));
  await inspector.metadata(resourceScript, ['-Root', 'root', '-ScopeSha256', 'f'.repeat(64), '-Mode', 'Quarantine'],
    'root', 30000, Buffer.from('[]'));
  await inspector.closeStartupSession();
  assert.deepEqual(routed, ['worker', 'worker', 'worker', 'one-shot', 'one-shot', 'one-shot']);
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

test('startup close drains queued worker calls before one-shot inspection resumes', async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let callCount = 0;
  const session = {
    supports: () => true,
    canFallBack: false,
    invoke: async () => {
      callCount += 1;
      if (callCount === 1) { await firstGate; }
      order.push('worker');
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    close: async () => { order.push('close'); },
  } as unknown as StartupMetadataSession;
  const supervisor = {
    run: async () => { order.push('one-shot'); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
  } as unknown as ProcessSupervisor;
  const inspector = new PathInspector(supervisor);
  inspector.attachStartupSession(session);
  const first = inspector.metadata('worker', [], 'root');
  const second = inspector.metadata('worker', [], 'root');
  const closing = inspector.closeStartupSession();
  const after = inspector.metadata('worker', [], 'root');
  releaseFirst();
  await Promise.all([first, second, closing, after]);
  assert.deepEqual(order, ['worker', 'worker', 'close', 'one-shot']);
});
