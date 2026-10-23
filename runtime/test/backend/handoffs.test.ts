import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { handoffIdentityDigest, mergeHandoff } from '../../src/backend/handoffs.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { parseOperation } from '../../src/operation-records.ts';
import { handoffDigestOperations, loadHandoffDigestVectors } from '../support/handoff-digest-fixture.ts';
import type { RetainedHandoff } from '../../src/operation-records.ts';

const record: RetainedHandoff = { logicalOutboxId: `${'1'.repeat(32)}-1`, recordSha256: '2'.repeat(64), payloadBindingSha256: '3'.repeat(64),
  journalId: 'original-journal', eventId: 'original-event', acceptance: { journalId: 'original-journal', eventId: 'original-event', generation: '4'.repeat(32) },
  presentation: 'replayable', coreRepairOperationId: null, attemptRef: null };

describe('retained handoff evidence merging', () => {
  it('retains positive evidence and irreversible presentation retirement', () => {
    const merged = mergeHandoff({ ...record, presentation: 'rejected' }, { ...record, acceptance: null, payloadBindingSha256: null });
    assert.equal(merged.presentation, 'rejected');
    assert.deepEqual(merged.acceptance, record.acceptance);
    assert.equal(merged.payloadBindingSha256, record.payloadBindingSha256);
  });
  it('prefers proved current acceptance without deriving it from cleanup', () => {
    const merged = mergeHandoff(record, { ...record, acceptance: { ...record.acceptance!, generation: '5'.repeat(32) } }, '4'.repeat(32));
    assert.equal(merged.acceptance?.generation, '4'.repeat(32));
  });
  it('rejects conflicting exact bytes, original bindings and cross-root associations', () => {
    assert.throws(() => mergeHandoff(record, { ...record, recordSha256: '6'.repeat(64) }));
    assert.throws(() => mergeHandoff(record, { ...record, journalId: 'replacement-journal' }));
    const associated = { ...record, coreRepairOperationId: `jr-${'7'.repeat(32)}`, attemptRef: { operationId: `jr-${'7'.repeat(32)}`, attemptOrdinal: 0 } };
    assert.throws(() => mergeHandoff(associated, { ...associated, attemptRef: { ...associated.attemptRef, attemptOrdinal: 1 } }));
  });
});

describe('fixed retained identity digest vectors', () => {
  it('matches the fixed empty vector shared with the native inventory fixture', async () => {
    const vectors = await loadHandoffDigestVectors();
    assert.equal(vectors.empty.retainedHandoffs, 0);
    assert.equal(handoffIdentityDigest([]), vectors.empty.sha256);
  });

  it('matches the fixed nonempty vector for valid ordered, reversed and cross-record duplicate handoffs', async () => {
    const vectors = await loadHandoffDigestVectors();
    const scopeSha256 = '7'.repeat(64);
    const operations = await handoffDigestOperations(scopeSha256);
    assert.equal(operations.length, 2); assert.notEqual(operations[0]!.operationId, operations[1]!.operationId);
    for (const operation of operations) {
      const parsed = parseOperation(parseStrictJson(Buffer.from(stringifyJson(operation, 'state-event')), 'state-event'), scopeSha256);
      assert.equal(parsed.compacted, false); assert.equal(parsed.kind, 'repair'); assert.equal(parsed.outcome, 'completed');
    }
    const ordered = operations[0]!.plan.handoffs;
    const reversed = [...ordered].reverse();
    const duplicated = operations.flatMap(operation => operation.plan.handoffs);
    assert.equal(vectors.nonempty.retainedHandoffs, 2);
    assert.equal(ordered.length, 2); assert.equal(duplicated.length, 4);
    for (const handoffs of [ordered, reversed, duplicated]) {
      const count = new Set(handoffs.map(value => JSON.stringify([value.logicalOutboxId, value.recordSha256]))).size;
      assert.equal(count, vectors.nonempty.retainedHandoffs);
      assert.equal(handoffIdentityDigest(handoffs), vectors.nonempty.sha256);
    }
  });

  it('emits fully parsed records with the private scope hash through the native fixture builder entry point', async () => {
    const scopeSha256 = '8'.repeat(64);
    const builder = fileURLToPath(new URL('../support/handoff-digest-fixture.ts', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [builder, scopeSha256], { windowsHide: true, timeout: 10000, maxBuffer: 1048576 });
    const value = JSON.parse(result.stdout) as { operations: unknown[] };
    assert.equal(value.operations.length, 2);
    for (const operation of value.operations) {
      const record = parseOperation(parseStrictJson(Buffer.from(stringifyJson(operation, 'state-event')), 'state-event'), scopeSha256);
      assert.equal(record.scopeSha256, scopeSha256); assert.equal(record.compacted, false); assert.equal(record.kind, 'repair');
    }
  });

  it('reproduces the operations the native inventory test reads for its scope', async () => {
    // Arrange: the committed Go fixture records the scope hash its builder run used.
    const committed = await fs.readFile(new URL('../../native/helper/internal/inventory/testdata/handoff-operations.json', import.meta.url));
    const scopeSha256 = (JSON.parse(committed.toString('utf8')) as { operations: { scopeSha256: string }[] }).operations[0]!.scopeSha256;
    const builder = fileURLToPath(new URL('../support/handoff-digest-fixture.ts', import.meta.url));

    // Act
    const result = await promisify(execFile)(process.execPath, [builder, scopeSha256], { windowsHide: true, timeout: 10000, maxBuffer: 1048576, encoding: 'buffer' });

    // Assert
    assert.ok(Buffer.compare(result.stdout, committed) === 0, 'The builder no longer reproduces the native inventory fixture; regenerate it.');
  });
});
