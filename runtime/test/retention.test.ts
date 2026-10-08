import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EventDescription } from '../src/journal-records.ts';
import { selectJournalRetention, utcTicks, type RetainedEvent } from '../src/retention.ts';

const origin = '2026-01-01T00:00:00.0000001Z';
function entry(index: number, overrides: Partial<EventDescription> = {}): RetainedEvent {
  const event: EventDescription = { eventVersion: 1, journalId: 'journal', sequence: index, eventId: index.toString(16).padStart(32, '0'), type: 'state.consumed', occurredAt: origin,
    runtimeInstanceId: 'a'.repeat(32), adapter: 'game', adapterBindingEpoch: 'b'.repeat(32), principal: 'principal', logicalOutboxId: `${'c'.repeat(32)}-${index}`,
    recordSha256: 'd'.repeat(64), coreRepairOperationId: null, attemptRef: null, schemaVersion: 2, adapterVersion: 1, settlement: 'accepted',
    acceptance: { journalId: 'journal', eventId: index.toString(16).padStart(32, '0'), generation: 'e'.repeat(32) }, acknowledgedAt: origin, compacted: false,
    payloadBindingSha256: 'f'.repeat(64), targetIdentitySha256: '0'.repeat(64), stateGeneratedAt: origin, ...overrides };
  return { event, sha256: '1'.repeat(64), evidence: { state: 'resolved', path: 'acknowledged', resolvedAt: origin } };
}

describe('journal retention eligibility', () => {
  it('uses exact seven-digit timestamp boundaries and the later resolution time', () => {
    assert.equal(utcTicks('2026-01-01T00:00:00.0000001Z') - utcTicks('2026-01-01T00:00:00.0000000Z'), 1n);
    const record = entry(1);
    assert.equal(selectJournalRetention([record], '2026-06-30T00:00:00.0000000Z', true).compact.length, 0);
    assert.equal(selectJournalRetention([record], '2026-06-30T00:00:00.0000001Z', true).compact.length, 1);
    const later = { ...record, evidence: { ...record.evidence, resolvedAt: '2026-02-01T00:00:00.0000000Z' } };
    assert.equal(selectJournalRetention([later], '2026-06-30T00:00:00.0000001Z', true).compact.length, 0);
  });

  it('compacts a discharged skip without manufacturing an acknowledgement', () => {
    const record = entry(1, { acknowledgedAt: null });
    const discharged = { ...record, evidence: { state: 'resolved' as const, path: 'skipDischarged' as const, resolvedAt: origin } };
    const result = selectJournalRetention([discharged], '2027-01-01T00:00:00.0000000Z', true);
    assert.equal(result.compact.length, 1);
    assert.equal(result.compact[0]!.event.acknowledgedAt, null);
    assert.equal(selectJournalRetention([{ ...discharged, event: { ...record.event, settlement: 'unknown', acceptance: null } }], '2027-01-01T00:00:00.0000000Z', true).compact.length, 0);
  });

  it('retains protected over-capacity history and compacts only enough eligible records in stable order', () => {
    const entries = Array.from({ length: 8193 }, (_, index) => entry(index + 1));
    const now = '2026-01-02T00:00:00.0000000Z';
    const selected = selectJournalRetention(entries, now, true);
    assert.equal(selected.compact.length, 1);
    assert.equal(selected.compact[0]!.event.sequence, 1);
    assert.equal(selected.remainingFull, 8192);
    const protectedEntries = entries.map(value => ({ ...value, evidence: { state: 'protected' as const, path: null, resolvedAt: null } }));
    const protectedResult = selectJournalRetention(protectedEntries, now, true);
    assert.equal(protectedResult.compact.length, 0);
    assert.equal(protectedResult.overCapacity, true);
    assert.throws(() => selectJournalRetention(entries, now, false));
  });
});
