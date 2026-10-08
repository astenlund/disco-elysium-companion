import { parseEventDescription, type EventDescription } from '../../src/journal-records.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';

export function journalEvent(sequence: number, overrides: Record<string, unknown> = {}): EventDescription {
  const timestamp = '2026-10-08T01:00:00.0000000Z';
  return parseEventDescription(parseStrictJson(Buffer.from(stringifyJson({
    eventVersion: 1, journalId: 'journal', sequence, eventId: sequence.toString(16).padStart(32, '0'), type: 'state.consumed', occurredAt: timestamp,
    runtimeInstanceId: 'b'.repeat(32), adapter: 'game', adapterBindingEpoch: 'c'.repeat(32), principal: 'principal',
    logicalOutboxId: `${'d'.repeat(32)}-${sequence}`, recordSha256: 'e'.repeat(64), coreRepairOperationId: null, attemptRef: null,
    schemaVersion: 2, adapterVersion: 1, settlement: 'accepted', acceptance: { journalId: 'original-journal', eventId: `original-event-${sequence}`, generation: 'a'.repeat(32) },
    acknowledgedAt: null, compacted: false, payloadBindingSha256: 'f'.repeat(64), targetIdentitySha256: '1'.repeat(64), stateGeneratedAt: timestamp,
    ...overrides,
  }), 'utf8')));
}
