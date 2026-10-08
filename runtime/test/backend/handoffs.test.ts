import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeHandoff } from '../../src/backend/handoffs.ts';
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
