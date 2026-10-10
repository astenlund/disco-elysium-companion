import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deferredCarryAuthority, hasProviderAuthority } from '../../src/backend/provider-authority.ts';
import { handoffFor } from '../../src/backend/recovery.ts';
import { coreAttemptToken, parseOperation, type OperationRecord, type RepairOperation } from '../../src/operation-records.ts';
import type { OperationInventory } from '../../src/operations.ts';
import { validateOperationTransition } from '../../src/operations.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { bindRecoveryEvent, replacementCandidate, replayCandidate, selectRecoveryRecord, transferEpisode } from '../../src/recovery-progress.ts';
import { journalEvent } from '../support/journal-event.ts';
import { at, carryTransfer, deferredRepair, generation, repair } from './authority-fixtures.ts';

const inventory = (...records: OperationRecord[]): OperationInventory => ({ records: records.map(record => ({ record, sha256: 'a'.repeat(64) })), invalid: [], handoffCount: 0, fullTerminalCount: 0 });
const clean = { stateSafetyVersion: 1 as const, generation, pendingCheck: null, correction: null, recoveryWitness: null };
function compact(record: OperationRecord): OperationRecord {
  const { operationVersion, operationId, scopeSha256, kind, cause, startedAt, completedAt, outcome } = record;
  return parseOperation(parseStrictJson(Buffer.from(stringifyJson({ operationVersion, operationId, scopeSha256, kind, cause, startedAt, completedAt, outcome,
    compacted: true, sourceRecordSha256: 'a'.repeat(64) }))), scopeSha256);
}
function transfer(record: RepairOperation): RepairOperation {
  const current = record.recovery.episodes[record.recovery.activeEpisode!]!;
  const moved = repair(transferEpisode(record, { activationId: '9'.repeat(32), trigger: 'rewind', attemptAtStart: 1, replacementAttempt: null,
    prerequisite: current.prerequisite, acceptedRecovery: null, startedAt: at }, at));
  validateOperationTransition(record, moved);
  return moved;
}

describe('immutable designated carry replacement', () => {
  it('refuses the original carried attempt in waiting, pending and resolved records', () => {
    for (const state of ['waitingReplacement', 'pendingCleanup', 'resolved'] as const) {
      const source = deferredRepair(state);
      const changed = repair({ ...source, recovery: { ...source.recovery, episodes: source.recovery.episodes.map(episode => ({ ...episode,
        prerequisite: { ...episode.prerequisite!, carryRelease: { attemptRef: { operationId: source.operationId, attemptOrdinal: 0 } } } })) } });
      assert.equal(deferredCarryAuthority(inventory(source)).state, state);
      assert.equal(deferredCarryAuthority(inventory(changed)).state, 'unavailable');
      assert.equal(hasProviderAuthority(clean, inventory(changed)), false);
    }
  });

  it('preserves allocation and historical checkpoint proof through same-root transfers and atomic retargeting', () => {
    for (const state of ['waitingReplacement', 'pendingCleanup'] as const) {
      const moved = transfer(deferredRepair(state));
      assert.equal(moved.recovery.episodes[1]!.replacementAttempt, null);
      assert.equal(deferredCarryAuthority(inventory(moved)).state, state);
    }
    const moved = transfer(deferredRepair('pendingCleanup'));
    const retargeted = repair(replacementCandidate(moved, 'placementUnavailable'));
    validateOperationTransition(moved, retargeted);
    assert.equal(retargeted.recovery.episodes[1]!.replacementAttempt, 2);
    assert.equal(deferredCarryAuthority(inventory(retargeted)).state, 'waitingReplacement');
    const wrong = repair({ ...retargeted, recovery: { ...retargeted.recovery, episodes: retargeted.recovery.episodes.map((episode, ordinal) => ordinal !== 1 ? episode
      : { ...episode, prerequisite: { ...episode.prerequisite!, carryRelease: { attemptRef: { operationId: retargeted.operationId, attemptOrdinal: 1 } } } }) } });
    assert.equal(deferredCarryAuthority(inventory(wrong)).state, 'unavailable');
  });

  it('requires a historical accepting episode for recorded cleanup and preserves missing-proof refusal', () => {
    const source = deferredRepair('pendingCleanup');
    const noCheckpoint = repair({ ...source, recovery: { ...source.recovery, episodes: source.recovery.episodes.map(episode => ({ ...episode, phase: 'draining', acceptedRecovery: null })) } });
    assert.equal(deferredCarryAuthority(inventory(noCheckpoint)).state, 'unavailable');
    const noSelection = repair({ ...source, recovery: { ...source.recovery, attempts: source.recovery.attempts.map((attempt, ordinal) => ordinal !== 1 ? attempt
      : { publication: 'due', selectedRecord: null, journalEvent: null }) } });
    assert.equal(deferredCarryAuthority(inventory(noSelection)).state, 'unavailable');
    const originalSelected = repair({ ...source, recovery: { ...source.recovery, attempts: source.recovery.attempts.map((attempt, ordinal) => ordinal !== 1 ? attempt : source.recovery.attempts[0]!) } });
    assert.equal(deferredCarryAuthority(inventory(originalSelected)).state, 'unavailable');
  });

  it('admits cross-root initial attempt zero only with the complete exact transfer proof', () => {
    for (const state of ['waitingReplacement', 'resolved'] as const) {
      const chain = carryTransfer(state);
      const source = chain.successor;
      const successor = repair({ ...source, recovery: { ...source.recovery, attempts: [source.recovery.attempts[1]!], episodes: source.recovery.episodes.map(episode => ({ ...episode,
        replacementAttempt: null, prerequisite: { ...episode.prerequisite!, carryRelease: { attemptRef: { operationId: source.operationId, attemptOrdinal: 0 } } } })) } });
      assert.equal(deferredCarryAuthority(inventory(chain.predecessor, successor, chain.releaseRecord)).state, state);
      assert.equal(deferredCarryAuthority(inventory(successor, chain.releaseRecord)).state, 'unavailable');
      assert.equal(deferredCarryAuthority(inventory(compact(chain.predecessor), successor, chain.releaseRecord)).state, 'unavailable');
      assert.equal(deferredCarryAuthority(inventory(chain.predecessor, successor, compact(chain.releaseRecord))).state, 'unavailable');
      assert.equal(deferredCarryAuthority(inventory(chain.predecessor, successor, successor, chain.releaseRecord)).state, 'unavailable');
      const invalid = { ...inventory(chain.predecessor, successor, chain.releaseRecord), invalid: [{ name: 'unreadable-owner.json', sha256: null }] };
      assert.equal(deferredCarryAuthority(invalid).state, 'unavailable');
    }
  });

  it('does not reinterpret confirmed removal when replay changes selected identity, destination or generation', () => {
    const source = deferredRepair('resolved');
    const replay = repair(replayCandidate(source, '9'.repeat(32), at));
    validateOperationTransition(source, replay);
    const old = journalEvent(2, { type: 'state.resync', coreRepairOperationId: coreAttemptToken(source.operationId, 1), attemptRef: { operationId: source.operationId, attemptOrdinal: 1 },
      acceptance: { journalId: 'settlement-journal', eventId: 'settlement-event', generation } });
    const selected = repair(selectRecoveryRecord(replay, { logicalOutboxId: 'd'.repeat(32) + '-3', recordSha256: '5'.repeat(64) }, 'observed', handoffFor(old)));
    validateOperationTransition(replay, selected);
    const event = journalEvent(1, { journalId: 'replayed-journal', eventId: '8'.repeat(32), logicalOutboxId: 'd'.repeat(32) + '-3', recordSha256: '5'.repeat(64),
      type: 'state.resync', coreRepairOperationId: coreAttemptToken(source.operationId, 1), attemptRef: { operationId: source.operationId, attemptOrdinal: 1 } });
    const rebound = repair(bindRecoveryEvent(selected, event));
    validateOperationTransition(selected, rebound);
    assert.notDeepEqual(rebound.recovery.attempts[1]!.selectedRecord, source.recovery.attempts[1]!.selectedRecord);
    assert.notDeepEqual(rebound.recovery.attempts[1]!.journalEvent, source.recovery.attempts[1]!.journalEvent);
    assert.deepEqual(rebound.recovery.episodes[0]!.acceptedRecovery, source.recovery.episodes[0]!.acceptedRecovery);
    assert.equal(deferredCarryAuthority(inventory(rebound)).state, 'resolved');
    const laterReplacement = repair(replacementCandidate(rebound, 'missingPayload'));
    validateOperationTransition(rebound, laterReplacement);
    assert.equal(deferredCarryAuthority(inventory(laterReplacement)).state, 'resolved');
    assert.equal(hasProviderAuthority({ ...clean, generation: 'f'.repeat(32) }, inventory(source)), true);
  });
});
