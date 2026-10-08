import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControlDocumentError } from '../src/control-values.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { parseStrictJson, stringifyJson, type JsonValue } from '../src/json.ts';
import { OperationStore } from '../src/operations.ts';
import type { CompactOperation } from '../src/operation-records.ts';
import type { ScopeStorage } from '../src/storage.ts';

const scopeSha256 = 'a'.repeat(64);
const startedAt = '2026-10-08T00:00:00.0000000Z';
const record = (index: number): CompactOperation => ({ operationVersion: 1, operationId: `jr-${index.toString(16).padStart(32, '0')}`, scopeSha256, kind: 'repair', cause: 'header',
  startedAt, completedAt: startedAt, outcome: 'completed', compacted: true, sourceRecordSha256: 'b'.repeat(64) });

describe('operation batch inventory', () => {
  it('parses and sorts all terminal controls through one storage batch', async () => {
    const records = Array.from({ length: 4096 }, (_, index) => record(4096 - index));
    const names = records.map(value => `${value.operationId}.json`);
    const deadline = Deadline.after(120000);
    let batches = 0;
    const storage = {
      scope: { bindingSha256: scopeSha256 },
      list: async (relative: string, budget: Deadline) => { assert.equal(relative, 'operations'); assert.equal(budget, deadline); return names; },
      read: async () => { throw new Error('Per-operation read is not bounded at the retention limit.'); },
      readMany: async (paths: readonly string[], profile: string, parse: (value: JsonValue, index: number) => unknown, budget: Deadline) => {
        batches++;
        assert.deepEqual(paths, names.map(name => `operations/${name}`));
        assert.equal(profile, 'state-event');
        assert.equal(budget, deadline);
        return records.map((value, index) => ({ status: 'valid', sha256: index.toString(16).padStart(64, '0'), value: parse(parseStrictJson(Buffer.from(stringifyJson(value))), index) }));
      },
    } as unknown as ScopeStorage;
    const result = await new OperationStore(storage).list(deadline);
    assert.equal(batches, 1);
    assert.equal(result.records.length, 4096);
    assert.deepEqual(result.records.map(value => value.record.operationId), [...names].reverse().map(name => name.slice(0, -5)));
    assert.deepEqual(result.invalid, []);
    assert.equal(result.fullTerminalCount, 0);
    assert.equal(result.handoffCount, 0);
  });

  it('keeps absent and invalid evidence and rejects an operation under another filename', async () => {
    const names = [1, 2, 3].map(index => `${record(index).operationId}.json`);
    const storage = {
      scope: { bindingSha256: scopeSha256 },
      list: async () => names,
      readMany: async (_paths: readonly string[], _profile: string, parse: (value: JsonValue, index: number) => unknown) => {
        assert.throws(() => parse(parseStrictJson(Buffer.from(stringifyJson(record(2)))), 0), ControlDocumentError);
        return [{ status: 'valid', sha256: 'c'.repeat(64), value: parse(parseStrictJson(Buffer.from(stringifyJson(record(1)))), 0) },
          { status: 'invalid', sha256: 'd'.repeat(64) }, { status: 'absent' }];
      },
    } as unknown as ScopeStorage;
    const result = await new OperationStore(storage).list();
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.invalid, [{ name: names[1], sha256: 'd'.repeat(64) }, { name: names[2], sha256: null }]);
  });

  it('cannot return authority after its shared deadline expires', async () => {
    let now = 0;
    const deadline = Deadline.after(20, () => now);
    const storage = { scope: { bindingSha256: scopeSha256 }, list: async () => [], readMany: async () => { now = 20; return []; } } as unknown as ScopeStorage;
    await assert.rejects(new OperationStore(storage).list(deadline), DeadlineExceededError);
  });
});
