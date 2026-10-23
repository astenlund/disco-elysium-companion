import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { EventReader, type EventReadRequest } from '../src/event-reader.ts';
import { eventFileName } from '../src/journal-records.ts';
import { parseStrictJson, stringifyJson, type JsonValue } from '../src/json.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import { journalEvent } from './support/journal-event.ts';

function fixture(count: number) {
  const root = path.resolve('event-reader-fixture');
  const requests: EventReadRequest[] = Array.from({ length: count }, (_, index) => ({ path: eventFileName(index + 1), sequence: index + 1 }));
  const state = { fail: false, malformed: false, wrongRequest: false, prefix: 512, onHash: () => {}, onMetadata: () => {}, transform: (value: unknown): unknown => value,
    calls: [] as string[], timeouts: [] as number[], batches: [] as EventReadRequest[][], hashes: new Map(requests.map(request => [path.join(root, request.path), '1'.repeat(64)])) };
  const inspector = new PathInspector({} as ProcessSupervisor);
  inspector.native = async (op, fields, timeout) => {
    state.calls.push(op);
    state.timeouts.push(timeout!);
    if (state.fail) { throw new Error('fixture metadata unavailable'); }
    let value: unknown;
    if (op === 'hash') {
      state.onHash();
      const input = Buffer.from(fields['inputBase64'] as string, 'base64');
      const targets: string[] = JSON.parse(input.toString('utf8'));
      value = { requestSha256: state.wrongRequest ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex'), sha256: targets.map(target => state.hashes.get(target) ?? null) };
    } else {
      state.onMetadata();
      const input = op === 'eventBatch' ? Buffer.from(fields['inputBase64'] as string, 'base64') : null;
      const targets: EventReadRequest[] = JSON.parse(input === null ? fields['requestsJson'] as string : input.toString('utf8'));
      state.batches.push(targets);
      const documents = targets.slice(0, state.prefix).map(target => ({ path: target.path, status: state.hashes.has(target.path) ? 'valid' : 'absent', sha256: state.hashes.get(target.path) ?? null, metadata: state.hashes.has(target.path) ? journalEvent(target.sequence) : null }));
      value = input === null ? { documents } : { requestSha256: state.wrongRequest ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex'), documents };
    }
    const reply = parseStrictJson(Buffer.from(stringifyJson(state.malformed ? {} : value)));
    return (op === 'eventBatch' ? state.transform(reply) : reply) as JsonValue;
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
    assert.deepEqual(state.calls, ['hash']);
    state.calls.length = 0;
    state.hashes.set(path.join(root, requests[0]!.path), '2'.repeat(64));
    state.hashes.delete(path.join(root, requests[1]!.path));
    const changed = await reader.readInventory(requests);
    assert.equal(changed[0]!.sha256, '2'.repeat(64));
    assert.equal(changed[1]!.status, 'absent');
    assert.deepEqual(state.calls, ['hash', 'eventBatch']);
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
      assert.deepEqual(state.calls, ['eventBatch']);
    }
    reader.invalidate();
    state.calls.length = 0;
    await reader.readInventory(requests);
    assert.deepEqual(state.calls, ['eventBatch']);
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
    assert.deepEqual(state.calls, Array.from({ length: 16 }, () => 'hash'));
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
    assert.deepEqual(state.calls, Array.from({ length: 3 }, () => 'eventBatch'));
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
      state.transform = reply => {
        const value = JSON.parse(stringifyJson(reply)) as MutableReply;
        mutate(value);
        return parseStrictJson(Buffer.from(JSON.stringify(value)));
      };
      await assert.rejects(reader.readInventory(requests), name);
    }
  });
});
