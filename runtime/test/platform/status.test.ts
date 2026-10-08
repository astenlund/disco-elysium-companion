import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EventRead } from '../../src/event-reader.ts';
import type { JournalCursor, JournalHeader } from '../../src/journal-records.ts';
import { isPublicationResidue } from '../../src/platform/publication-residue.ts';
import { summarizeJournal, type OperationStatus, type StatusDocument } from '../../src/platform/status.ts';
import { journalEvent } from '../support/journal-event.ts';

const now = '2026-10-08T01:00:00.0000000Z';
const header = (highWaterSequence: number): StatusDocument<JournalHeader> => ({ status: 'valid', value: { journalVersion: 1, journalId: 'journal', createdAt: now, highWaterSequence, historyVerified: true } });
const cursor = (lastAckedSequence: number): StatusDocument<JournalCursor> => ({ status: 'valid', value: { cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence, lastSentSequence: lastAckedSequence, lastAcceptedRevision: null, updatedAt: now } });
const event = (sequence: number, overrides: Record<string, unknown> = {}): EventRead => ({ status: 'valid', path: `${sequence}.json`, sha256: 'a'.repeat(64), metadata: journalEvent(sequence, overrides) });
const summary = (events: EventRead[], highWater = 3, acked = 1, operations: OperationStatus[] = []) => summarizeJournal(header(highWater), cursor(acked), events, 'game', 'principal', operations, []);

describe('standalone status interpretation', () => {
  it('counts unacknowledged events and recognizes a crash before the high-water write', () => {
    assert.equal(summary([event(1), event(2), event(3)]).unacknowledgedEvents, 2);
    const crash = summary([event(1), event(2), event(3), event(4)]);
    assert.equal(crash.unrecordedEvent, true);
    assert.equal(crash.unacknowledgedEvents, 3);
  });

  it('does not mistake pruned acknowledged history for an unacknowledged gap', () => {
    assert.equal(summary([event(3)], 3, 2).state, 'healthy');
    assert.equal(summary([event(3)], 3, 1).integrity, 'gap');
    assert.equal(summary([event(2), event(3, { compacted: true, acknowledgedAt: now, targetIdentitySha256: null, stateGeneratedAt: null })]).integrity, 'gap');
  });

  it('never reports a zero backlog from missing, foreign, duplicated or unreadable authority', () => {
    assert.equal(summary([event(2, { adapter: 'another' }), event(3)]).unacknowledgedEvents, null);
    assert.equal(summary([event(2), event(3, { eventId: journalEvent(2).eventId })]).integrity, 'gap');
    assert.equal(summarizeJournal({ status: 'unreadable' }, cursor(0), [], 'game', 'principal', [], []).state, 'unavailable');
    assert.equal(summarizeJournal({ status: 'absent' }, cursor(0), [], 'game', 'principal', [], []).integrity, 'header');
  });

  it('reports active repair roots but gives a refused release no stream fault', () => {
    const refused: OperationStatus = { operationId: 'rl-' + '1'.repeat(32), kind: 'release', cause: 'release', outcome: 'refused', effectivelyUnfinished: false, pendingSafety: true };
    assert.equal(summary([], 0, 0, [refused]).fault, null);
    const repair: OperationStatus = { operationId: 'jr-' + '2'.repeat(32), kind: 'repair', cause: 'header', outcome: 'completed', effectivelyUnfinished: true, pendingSafety: false };
    assert.equal(summary([], 0, 0, [repair]).state, 'repairing');
    assert.equal(summary([], 0, 0, [repair]).fault, 'repairFailed');
  });
});

describe('owned publication names', () => {
  it('recognizes runtime siblings and preserves unknown, aliased and out-of-range names', () => {
    const suffix = '.' + 'a'.repeat(32) + '.tmp';
    for (const name of ['runtime.json', 'scope.json', 'codec.json', 'prepared-context.txt', 'journal/recovery-event.json', 'journal/events/0000000000000001.json', 'operations/jr-' + 'b'.repeat(32) + '.json']) {
      assert.equal(isPublicationResidue(name + suffix), true, name);
    }
    for (const name of ['unknown.json', '../runtime.json', 'runtime.json ', 'RUNTIME.JSON', 'journal/events/0000000000000000.json', 'journal/events/9999999999999999.json', 'operations/no.json']) {
      assert.equal(isPublicationResidue(name + suffix), false, name);
    }
    assert.equal(isPublicationResidue('runtime.json.' + 'A'.repeat(32) + '.tmp'), false);
    assert.equal(isPublicationResidue('runtime.json.' + 'a'.repeat(32) + '.tmp.extra'), false);
  });
});
