import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControlDocumentError } from '../src/control-values.ts';
import type { EventDescription } from '../src/journal-records.ts';
import { coreAttemptToken, emptyRepairPlan, initialRecovery, type RepairOperation } from '../src/operation-records.ts';
import { validateOperationTransition } from '../src/operations.ts';
import { abandonRecovery, bindRecoveryEvent, checkpointRecovery, completeRecovery, currentAttemptOrdinal, replacementCandidate, replayCandidate, selectRecoveryRecord } from '../src/recovery-progress.ts';

const time = '2026-10-08T07:00:00.0000000Z';
const root = `jr-${'a'.repeat(32)}`;
const generation = 'b'.repeat(32);
function initial(): RepairOperation { return { operationVersion: 1, operationId: root, scopeSha256: 'c'.repeat(64), kind: 'repair', cause: 'lostJournal', startedAt: time, completedAt: null, outcome: null, compacted: false, plan: emptyRepairPlan(), recovery: initialRecovery(time, 'd'.repeat(32)) }; }
function event(ordinal = 0): EventDescription {
  return { eventVersion: 1, journalId: 'journal', sequence: 5, eventId: 'e'.repeat(32), type: 'state.resync', occurredAt: time, runtimeInstanceId: 'f'.repeat(32), adapter: 'game', adapterBindingEpoch: '0'.repeat(32), principal: 'principal', logicalOutboxId: `${'1'.repeat(32)}-9`, recordSha256: '2'.repeat(64), coreRepairOperationId: coreAttemptToken(root, ordinal), attemptRef: { operationId: root, attemptOrdinal: ordinal }, schemaVersion: 2, adapterVersion: 2, settlement: 'accepted', acceptance: { journalId: 'original', eventId: 'original-event', generation }, acknowledgedAt: null, compacted: false, payloadBindingSha256: '3'.repeat(64), targetIdentitySha256: '4'.repeat(64), stateGeneratedAt: time };
}

describe('bounded recovery progress', () => {
  it('uses one replacement per episode and preserves the old attempt across replay', () => {
    const first = initial();
    assert.throws(() => replacementCandidate(first, 'missingPayload'), ControlDocumentError);
    const selected = selectRecoveryRecord(first, { logicalOutboxId: event().logicalOutboxId, recordSha256: null }, 'observed', null);
    const replaced = replacementCandidate(selected, 'missingPayload');
    assert.equal(currentAttemptOrdinal(replaced), 1);
    assert.deepEqual(replaced.recovery.attempts[0], selected.recovery.attempts[0]);
    assert.throws(() => replacementCandidate(replaced, 'missingPayload'), ControlDocumentError);
    const replay = replayCandidate(replaced, '5'.repeat(32), time);
    assert.equal(replay.recovery.episodes.length, 1);
    assert.equal(replay.recovery.episodes[0]!.replacementAttempt, 1);
    assert.equal(coreAttemptToken(root, currentAttemptOrdinal(replay)), `${root}-r1`);
    validateOperationTransition(selected, replaced);
  });

  it('requires its own exact resync in the required position and current generation before finalization', () => {
    const recoveryEvent = event();
    const selected = selectRecoveryRecord(initial(), { logicalOutboxId: recoveryEvent.logicalOutboxId, recordSha256: recoveryEvent.recordSha256 }, 'observed', null);
    const bound = bindRecoveryEvent(selected, recoveryEvent);
    assert.throws(() => checkpointRecovery(bound, { ...recoveryEvent, attemptRef: { operationId: `jr-${'9'.repeat(32)}`, attemptOrdinal: 0 } }, generation, 1, time), ControlDocumentError);
    assert.throws(() => checkpointRecovery(bound, recoveryEvent, '9'.repeat(32), 1, time), ControlDocumentError);
    assert.throws(() => checkpointRecovery(bound, recoveryEvent, generation, 6, time), ControlDocumentError);
    const checkpoint = checkpointRecovery(bound, recoveryEvent, generation, 5, time);
    assert.equal(checkpoint.recovery.episodes[0]!.phase, 'verifyingHistory');
    assert.throws(() => completeRecovery(checkpoint, 'wrong-journal', generation, time), ControlDocumentError);
    const completed = completeRecovery(checkpoint, 'journal', generation, time);
    assert.equal(completed.recovery.activeEpisode, null);
    assert.equal(completed.outcome, 'completed');
    const replay = replayCandidate(completed, '6'.repeat(32), time);
    assert.equal(replay.completedAt, completed.completedAt);
    const abandoned = abandonRecovery(replay, `rl-${'7'.repeat(32)}`, time);
    assert.equal(abandoned.outcome, 'completed');
    assert.equal(abandoned.recovery.episodes[1]!.phase, 'abandonedByRelease');
    validateOperationTransition(completed, replay);
    validateOperationTransition(replay, abandoned);
  });

  it('does not discard a selected identity or overwrite historical completion', () => {
    const recoveryEvent = event();
    const selected = selectRecoveryRecord(initial(), { logicalOutboxId: recoveryEvent.logicalOutboxId, recordSha256: recoveryEvent.recordSha256 }, 'observed', null);
    assert.throws(() => selectRecoveryRecord(selected, { logicalOutboxId: `${'1'.repeat(32)}-10`, recordSha256: '8'.repeat(64) }, 'observed', null), ControlDocumentError);
    const completed = completeRecovery(checkpointRecovery(bindRecoveryEvent(selected, recoveryEvent), recoveryEvent, generation, 1, time), 'journal', generation, time);
    assert.throws(() => validateOperationTransition(completed, { ...completed, completedAt: null, outcome: null }), ControlDocumentError);
    assert.throws(() => validateOperationTransition(selected, { ...selected, recovery: { ...selected.recovery, attempts: [] } }), ControlDocumentError);
  });
});
