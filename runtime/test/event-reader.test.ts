import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { EventReader, type EventReadRequest } from '../src/event-reader.ts';
import { eventFileName } from '../src/journal-records.ts';
import { jsonBudgets, stringifyJson } from '../src/json.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import { journalEvent } from './support/journal-event.ts';

function fixture(count: number) {
  const root = path.resolve('event-reader-fixture');
  const requests: EventReadRequest[] = Array.from({ length: count }, (_, index) => ({ path: eventFileName(index + 1), sequence: index + 1 }));
  const state = { fail: false, malformed: false, wrongRequest: false, prefix: 512, onHash: () => {}, onMetadata: () => {}, transform: (bytes: Buffer): Buffer => bytes,
    calls: [] as string[], timeouts: [] as number[], batches: [] as EventReadRequest[][], hashes: new Map(requests.map(request => [path.join(root, request.path), '1'.repeat(64)])) };
  const inspector = new PathInspector({} as ProcessSupervisor);
  inspector.metadata = async (script, args, _cwd, _timeout, input) => {
    const name = path.basename(script);
    state.calls.push(name);
    state.timeouts.push(_timeout!);
    if (state.fail) { throw new Error('fixture metadata unavailable'); }
    let value: unknown;
    if (name === 'Get-FileHashes.ps1') {
      state.onHash();
      assert.ok(input);
      const targets: string[] = JSON.parse(Buffer.from(input).toString('utf8'));
      value = { requestSha256: state.wrongRequest ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex'), sha256: targets.map(target => state.hashes.get(target) ?? null) };
    } else {
      state.onMetadata();
      const targets: EventReadRequest[] = JSON.parse(input === undefined ? args[3]! : Buffer.from(input).toString('utf8'));
      state.batches.push(targets);
      const documents = targets.slice(0, state.prefix).map(target => ({ path: target.path, status: state.hashes.has(target.path) ? 'valid' : 'absent', sha256: state.hashes.get(target.path) ?? null, metadata: state.hashes.has(target.path) ? journalEvent(target.sequence) : null }));
      value = input === undefined ? { documents } : { requestSha256: state.wrongRequest ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex'), documents };
    }
    const encoded = Buffer.from(stringifyJson(state.malformed ? {} : value));
    return { exitCode: 0, stdout: name === 'Get-EventMetadata.ps1' && input !== undefined ? state.transform(deflateSync(encoded)) : encoded, stderr: Buffer.alloc(0) };
  };
  return { root, requests, state, reader: new EventReader(root, inspector) };
}

describe('journal exact-content validation cache', () => {
  it('reduces repeated 128-event parsing calls and revalidates changed or absent bytes', async () => {
    const { root, requests, state, reader } = fixture(128);
    const first = await reader.readInventory(requests);
    assert.equal(first.length, 128);
    assert.equal(state.calls.length, 1);
    state.calls.length = 0;
    (first[0] as { metadata: unknown }).metadata = { principal: 'caller mutation' };
    const second = await reader.readInventory(requests);
    const observed = second[0]!;
    assert.equal(observed.status === 'valid' && observed.metadata.principal, 'principal');
    assert.deepEqual(state.calls, ['Get-FileHashes.ps1']);
    state.calls.length = 0;
    state.hashes.set(path.join(root, requests[0]!.path), '2'.repeat(64));
    state.hashes.delete(path.join(root, requests[1]!.path));
    const changed = await reader.readInventory(requests);
    assert.equal(changed[0]!.sha256, '2'.repeat(64));
    assert.equal(changed[1]!.status, 'absent');
    assert.deepEqual(state.calls, ['Get-FileHashes.ps1', 'Get-EventMetadata.ps1']);
  });

  it('drops all reuse after I/O failure, malformed results or explicit invalidation', async () => {
    const { requests, state, reader } = fixture(1);
    for (const fault of ['io', 'malformed', 'uncorrelated', 'invalidated'] as const) {
      await reader.readInventory(requests);
      state.fail = fault === 'io';
      state.malformed = fault === 'malformed';
      state.wrongRequest = fault === 'uncorrelated';
      state.onHash = fault === 'invalidated' ? () => reader.invalidate() : () => {};
      await assert.rejects(reader.readInventory(requests));
      state.fail = false; state.malformed = false; state.wrongRequest = false; state.onHash = () => {};
      state.calls.length = 0;
      await reader.readInventory(requests);
      assert.deepEqual(state.calls, ['Get-EventMetadata.ps1']);
    }
    reader.invalidate();
    state.calls.length = 0;
    await reader.readInventory(requests);
    assert.deepEqual(state.calls, ['Get-EventMetadata.ps1']);
  });

  it('keeps one deadline and rejects wrong sequence or duplicate inventory entries', async () => {
    const { requests, state, reader } = fixture(1025);
    await reader.readInventory(requests);
    let now = 0;
    const deadline = Deadline.after(100, () => now);
    state.calls.length = 0;
    state.onHash = () => { now += 60; };
    await assert.rejects(reader.readInventory(requests, deadline), DeadlineExceededError);
    assert.equal(state.calls.length, 2);
    await assert.rejects(reader.readInventory([requests[0]!, requests[0]!]), DataRootUnavailableError);
    await assert.rejects(reader.readInventory([{ path: requests[0]!.path, sequence: 0 }]), DataRootUnavailableError);
  });

  it('reuses a complete retained inventory only after hashing every event', async () => {
    const { requests, state, reader } = fixture(8192);
    await reader.readInventory(requests);
    assert.equal(state.calls.length, 16);
    state.calls.length = 0;
    const inventory = await reader.readInventory(requests);
    assert.equal(inventory.length, 8192);
    assert.deepEqual(state.calls, Array.from({ length: 16 }, () => 'Get-FileHashes.ps1'));
  });

  it('keeps direct reads compatible and follows only complete nonempty prefixes', async () => {
    const { requests, state, reader } = fixture(5);
    assert.equal((await reader.read(requests)).length, 5);
    state.calls.length = 0;
    state.batches.length = 0;
    state.prefix = 2;
    assert.deepEqual((await reader.readInventory(requests)).map(value => value.path), state.batches[0]!.map(value => value.path));
    assert.deepEqual(state.batches.map(batch => batch.map(value => value.sequence)), [[1, 2, 3, 4, 5], [3, 4, 5], [5]]);
    state.prefix = 0;
    reader.invalidate();
    await assert.rejects(reader.readInventory(requests), /incomplete or uncorrelated/);
  });

  it('charges cold prefix reads to one deadline and drops partial success on failure', async () => {
    const { requests, state, reader } = fixture(3);
    state.prefix = 1;
    let now = 0;
    state.onMetadata = () => { now += 60; };
    await assert.rejects(reader.readInventory(requests, Deadline.after(100, () => now)), DeadlineExceededError);
    assert.deepEqual(state.timeouts, [100, 40]);
    state.onMetadata = () => {};
    state.calls.length = 0;
    assert.equal((await reader.readInventory(requests)).length, 3);
    assert.deepEqual(state.calls, Array.from({ length: 3 }, () => 'Get-EventMetadata.ps1'));
  });

  it('rejects corrupt compression, trailing streams, excessive expansion and every JSON budget', async () => {
    const faults: [string, (bytes: Buffer) => Buffer][] = [
      ['malformed compression', () => Buffer.from('invalid')],
      ['truncated stream', bytes => bytes.subarray(0, bytes.length - 1)],
      ['checksum corruption', bytes => { const result = Buffer.from(bytes); result[result.length - 1]! ^= 1; return result; }],
      ['trailing byte', bytes => Buffer.concat([bytes, Buffer.from([0])])],
      ['second stream', bytes => Buffer.concat([bytes, bytes])],
      ['wire bytes', () => Buffer.alloc(65_537)],
      ['expanded bytes', () => deflateSync(Buffer.alloc(jsonBudgets.config.maxBytes + 1, 32))],
      ['decoded text', () => deflateSync(Buffer.from(JSON.stringify({ text: 'x'.repeat(jsonBudgets.config.maxTextBytes) })))],
      ['tokens', () => deflateSync(Buffer.from(JSON.stringify(Array.from({ length: jsonBudgets.config.maxTokens }, () => null))))],
      ['depth', () => deflateSync(Buffer.from('['.repeat(65) + '0' + ']'.repeat(65)))],
      ['duplicate property', () => deflateSync(Buffer.from('{"documents":[],"documents":[]}'))],
      ['invalid UTF-8', () => deflateSync(Buffer.from([0xff]))],
    ];
    for (const [name, transform] of faults) {
      const { requests, state, reader } = fixture(1);
      state.transform = transform;
      await assert.rejects(reader.readInventory(requests), name);
      state.transform = bytes => bytes;
      state.calls.length = 0;
      await reader.readInventory(requests);
      assert.deepEqual(state.calls, ['Get-EventMetadata.ps1'], name);
    }
  });

  it('rejects request, prefix path, sequence and complete metadata mismatches without cache authority', async () => {
    type MutableReply = { requestSha256: string; documents: { path: string; sha256: string; metadata: { sequence: number; recordSha256?: string } }[] };
    const faults: [string, (value: MutableReply) => void][] = [
      ['request hash', value => { value.requestSha256 = '0'.repeat(64); }],
      ['path', value => { value.documents[0]!.path += '.other'; }],
      ['sequence', value => { value.documents[0]!.metadata.sequence += 1; }],
      ['extra document', value => { value.documents.push(value.documents[0]!); }],
      ['metadata omission', value => { delete value.documents[0]!.metadata.recordSha256; }],
      ['raw hash', value => { value.documents[0]!.sha256 = '0'; }],
    ];
    for (const [name, mutate] of faults) {
      const { requests, state, reader } = fixture(1);
      state.transform = bytes => {
        const value = JSON.parse(inflateSync(bytes).toString('utf8')) as MutableReply;
        mutate(value);
        return deflateSync(Buffer.from(JSON.stringify(value)));
      };
      await assert.rejects(reader.readInventory(requests), name);
    }
  });
});
