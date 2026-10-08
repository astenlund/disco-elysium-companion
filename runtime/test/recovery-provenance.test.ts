import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type EventMetadata, type JournalCursor } from '../src/journal-records.ts';
import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { inferMissingAcknowledgement, parseSkippedRange, rangeResolutionTime } from '../src/recovery-provenance.ts';
import { SafetyUnavailableError } from '../src/safety-records.ts';

const time = '2026-10-08T03:00:00.0000000Z';
const later = '2026-10-08T04:00:00.0000000Z';
const range = { journalId: 'journal', firstSequence: 1, lastSequence: 4, reason: 'cursorRecovery', discharge: null };
const parse = (value: unknown) => parseSkippedRange(parseStrictJson(Buffer.from(stringifyJson(value), 'utf8')));
const cursor: JournalCursor = { cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: 4, lastSentSequence: 4, lastAcceptedRevision: null, updatedAt: time };
const event: EventMetadata = {
  eventVersion: 1, journalId: 'journal', sequence: 2, eventId: '1'.repeat(32), type: 'state.consumed', occurredAt: time,
  runtimeInstanceId: '2'.repeat(32), adapter: 'game', adapterBindingEpoch: '3'.repeat(32), principal: 'principal', logicalOutboxId: `${'4'.repeat(32)}-2`,
  recordSha256: '5'.repeat(64), coreRepairOperationId: null, attemptRef: null, schemaVersion: 2, adapterVersion: 1,
  settlement: 'accepted', acceptance: { journalId: 'journal', eventId: '1'.repeat(32), generation: '6'.repeat(32) }, acknowledgedAt: null, compacted: false,
};

describe('synthetic cursor provenance', () => {
  it('requires exact ranges and discriminated discharge references', () => {
    assert.equal(parse(range).discharge, null);
    for (const invalid of [{ ...range, firstSequence: 0 }, { ...range, lastSequence: 0 }, { ...range, lastSequence: 1.5 }, { ...range, discharge: undefined }]) {
      assert.throws(() => parse(invalid), SafetyUnavailableError);
    }
    assert.throws(() => parse({ ...range, discharge: { kind: 'abandonRelease', operationId: `rl-${'a'.repeat(32)}`, episodeOrdinal: 0, at: time } }), SafetyUnavailableError);
    assert.throws(() => parse({ ...range, discharge: { kind: 'recoveryAcknowledged', operationId: `jr-${'a'.repeat(32)}`, episodeOrdinal: null, at: time } }), SafetyUnavailableError);
  });

  it('never manufactures acknowledgement from a recovered cursor or its eventual discharge', () => {
    assert.equal(inferMissingAcknowledgement(event, cursor, { status: 'verified', ranges: [parse(range)] }), null);
    const discharged = parse({ ...range, discharge: { kind: 'recoveryAcknowledged', operationId: `jr-${'a'.repeat(32)}`, episodeOrdinal: 0, at: later } });
    assert.equal(inferMissingAcknowledgement(event, cursor, { status: 'verified', ranges: [discharged] }), null);
    assert.equal(rangeResolutionTime(event, { status: 'verified', ranges: [discharged] }), later);
    assert.equal(rangeResolutionTime(event, { status: 'verified', ranges: [discharged, parse(range)] }), null);
    assert.equal(inferMissingAcknowledgement({ ...event, acknowledgedAt: time }, cursor, { status: 'verified', ranges: [discharged] }), time);
  });

  it('requires complete provenance before filling a missing stamp from an actual cursor advance', () => {
    assert.throws(() => inferMissingAcknowledgement(event, cursor, { status: 'unavailable' }), SafetyUnavailableError);
    assert.equal(inferMissingAcknowledgement(event, cursor, { status: 'verified', ranges: [] }), time);
    assert.equal(inferMissingAcknowledgement({ ...event, sequence: 5 }, cursor, { status: 'verified', ranges: [] }), null);
    assert.equal(inferMissingAcknowledgement({ ...event, journalId: 'other' }, cursor, { status: 'verified', ranges: [] }), null);
  });
});
