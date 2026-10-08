import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acknowledgementPrefix, eventFileName, eventFileSequence, eventRewriteMetadata, hasCurrentAcceptance, JournalDocumentError, logicalOutboxSequence, parseJournalCursor, parseJournalHeader, sameEventDependency } from '../src/journal-records.ts';
import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { decideSettlement, eventSettlementBinding } from '../src/settlement.ts';
import { journalEvent as event } from './support/journal-event.ts';

const timestamp = '2026-10-08T01:00:00.0000000Z';
const generation = 'a'.repeat(32);
const header = { journalVersion: 1, journalId: 'journal', createdAt: timestamp, highWaterSequence: 3, historyVerified: false };
const cursor = { cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: 0, lastSentSequence: 3, lastAcceptedRevision: null, updatedAt: timestamp };
const parse = (value: unknown) => parseStrictJson(Buffer.from(stringifyJson(value), 'utf8'));

describe('journal control and acknowledgement boundaries', () => {
  it('separates positive acceptance, unknown evidence, exact rejection and cleanup-only results', () => {
    const value = event(1);
    const binding = eventSettlementBinding(value);
    assert.equal(binding.journalId, 'original-journal');
    const failure = (reason: string) => ({ success: false as const, class: 'settlement', reason, consumptionState: 'none' as const, generationTimestamp: null, warnings: [] });
    const accepted = decideSettlement(value, binding, { success: true, value: 'already-settled' }, 'b'.repeat(32));
    assert.equal(accepted.kind, 'accept');
    if (accepted.kind !== 'accept') { throw new Error('Expected positive acceptance proposal'); }
    assert.equal(accepted.metadata.acceptance?.generation, 'b'.repeat(32));
    assert.equal(accepted.metadata.acceptance?.eventId, binding.eventId);
    const unknown = decideSettlement(value, binding, failure('settlement-unknown'), generation);
    assert.equal(unknown.kind, 'unknown');
    if (unknown.kind !== 'unknown') { throw new Error('Expected unknown evidence proposal'); }
    assert.equal(unknown.currentEvidence, true);
    assert.deepEqual(unknown.metadata.acceptance, value.acceptance);
    const expired = decideSettlement(value, binding, failure('settlement-conflict'), 'b'.repeat(32));
    assert.ok(expired.kind === 'unknown' && !expired.currentEvidence);
    assert.equal(decideSettlement(value, binding, failure('settlement-quarantined'), generation).kind, 'quarantined');
    assert.equal(decideSettlement(value, binding, failure('settlement-hash-mismatch'), generation).kind, 'conflict');
    assert.equal(decideSettlement(value, binding, failure('settlement-out-of-order'), generation).kind, 'retry');
    for (const presentation of ['unverified', 'rejected'] as const) {
      assert.equal(decideSettlement(value, binding, { success: true, value: 'settled' }, generation, presentation).kind, 'cleanupComplete');
      assert.equal(decideSettlement(value, binding, failure('settlement-unknown'), generation, presentation).kind, 'cleanupComplete');
    }
    assert.equal(decideSettlement(null, binding, { success: true, value: 'already-settled' }, generation, 'rejected').kind, 'cleanupComplete');
    assert.equal(decideSettlement(null, binding, failure('settlement-unknown'), generation, 'rejected').kind, 'cleanupComplete');
    assert.equal(decideSettlement(null, binding, failure('settlement-hash-mismatch'), generation, 'rejected').kind, 'conflict');
    assert.equal(decideSettlement(null, binding, { ...failure('outbox-record-invalid'), class: 'outbox' }, generation, 'rejected').kind, 'outboxInvalid');
  });

  it('retains large signed versions through event metadata rewrites', () => {
    const value = event(1, { adapterVersion: -9223372036854775808n, schemaVersion: 9223372036854775807n });
    assert.equal(value.adapterVersion, -9223372036854775808n);
    assert.equal(value.schemaVersion, 9223372036854775807n);
    const text = stringifyJson(eventRewriteMetadata(value));
    assert.ok(text.includes('"adapterVersion":-9223372036854775808'));
    assert.ok(text.includes('"schemaVersion":9223372036854775807'));
    assert.throws(() => event(1, { adapterVersion: 9223372036854775808n }), JournalDocumentError);
  });

  it('keeps safe positive sequence and exact filename grammars closed', () => {
    for (const sequence of [1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(eventFileSequence(eventFileName(sequence)), sequence);
      assert.equal(logicalOutboxSequence(`${'a'.repeat(32)}-${sequence}`), sequence);
    }
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) { assert.throws(() => eventFileName(sequence), JournalDocumentError); }
    for (const name of ['0000000000000000.json', '9007199254740992.json', '0000000000000001.json\n', '0000000000000001.JSON', '1.json']) { assert.equal(eventFileSequence(name), null); }
    for (const suffix of ['0', '01', '1.0', '+1', '1\n', '9007199254740992']) { assert.equal(logicalOutboxSequence(`${'a'.repeat(32)}-${suffix}`), null); }
  });

  it('does not infer history verification and allows a repair-lowered sent mark', () => {
    assert.equal(parseJournalHeader(parse(header)).historyVerified, false);
    assert.throws(() => parseJournalHeader(parse({ ...header, historyVerified: undefined })), JournalDocumentError);
    assert.throws(() => parseJournalHeader(parse({ ...header, highWaterSequence: -1 })), JournalDocumentError);
    assert.throws(() => parseJournalHeader(parse({ ...header, unknown: true })), JournalDocumentError);
    assert.equal(parseJournalCursor(parse({ ...cursor, lastAckedSequence: 2, lastSentSequence: 1 })).lastSentSequence, 1);
    assert.throws(() => parseJournalCursor(parse({ ...cursor, lastAcceptedRevision: 1 })), JournalDocumentError);
  });

  it('retains original acceptance and unacknowledged compact evidence separately from destination metadata', () => {
    const full = event(1);
    assert.equal(full.acceptance!.journalId, 'original-journal');
    assert.equal(hasCurrentAcceptance(full, generation), true);
    assert.equal(hasCurrentAcceptance(full, 'b'.repeat(32)), false);
    assert.equal(hasCurrentAcceptance(event(1, { settlement: 'unknown', acceptance: null }), generation), false);
    const compact = event(1, { compacted: true, targetIdentitySha256: null, stateGeneratedAt: null });
    assert.equal(compact.acknowledgedAt, null);
    assert.equal(compact.payloadBindingSha256, full.payloadBindingSha256);
    assert.equal('payloadBindingSha256' in eventRewriteMetadata(compact), false);
    assert.equal('payload' in eventRewriteMetadata(compact), false);
    assert.throws(() => event(1, { compacted: true }), JournalDocumentError);
    assert.throws(() => event(1, { acceptance: null }), JournalDocumentError);
    assert.throws(() => event(1, { attemptRef: { operationId: `jr-${'a'.repeat(32)}`, attemptOrdinal: 0 } }), JournalDocumentError);
    const resync = event(1, { type: 'state.resync', coreRepairOperationId: 'core-repair', attemptRef: { operationId: `jr-${'a'.repeat(32)}`, attemptOrdinal: 0 } });
    assert.equal(resync.attemptRef!.attemptOrdinal, 0);
    assert.throws(() => event(1, { type: 'state.resync', coreRepairOperationId: null }), JournalDocumentError);
  });

  it('acknowledges only a contiguous matching prefix in the current generation', () => {
    const sent = [event(1), event(2), event(3)];
    const current = new Map(sent.map(item => [item.sequence, item]));
    const position = parseJournalCursor(parse(cursor));
    assert.deepEqual(acknowledgementPrefix(position, sent, current, generation), sent);
    current.set(2, event(2, { eventId: '9'.repeat(32) }));
    assert.deepEqual(acknowledgementPrefix(position, sent, current, generation), [sent[0]]);
    current.set(1, event(1, { acceptance: { ...sent[0]!.acceptance, generation: 'b'.repeat(32) } }));
    assert.deepEqual(acknowledgementPrefix(position, sent, current, generation), []);
    current.set(1, event(1, { payloadBindingSha256: '0'.repeat(64) }));
    assert.equal(sameEventDependency(sent[0]!, current.get(1)!), false);
    assert.deepEqual(acknowledgementPrefix(position, sent, current, generation), []);
  });

  it('cannot bridge missing events or turn a synthetic cursor into an acknowledgement', () => {
    const sent = [event(1), event(2), event(3)];
    const current = new Map(sent.map(item => [item.sequence, item]));
    assert.deepEqual(acknowledgementPrefix(parseJournalCursor(parse(cursor)), [sent[1]!], current, generation), []);
    current.delete(2);
    assert.deepEqual(acknowledgementPrefix(parseJournalCursor(parse(cursor)), sent, current, generation), [sent[0]]);
    const skipped = parseJournalCursor(parse({ ...cursor, lastAckedSequence: 3 }));
    assert.deepEqual(acknowledgementPrefix(skipped, sent, current, generation), []);
    assert.deepEqual(acknowledgementPrefix(parseJournalCursor(parse(cursor)), sent, current, 'invalid'), []);
  });
});
