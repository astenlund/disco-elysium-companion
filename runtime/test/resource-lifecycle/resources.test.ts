import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessCapacity } from '../../src/capacity.ts';
import { emptyRepairPlan, initialRecovery, type RepairOperation } from '../../src/operation-records.ts';
import { completeReservation, remainingRecoveryPublications, ResourceAuthority, validateOperationExpansion, type ResourceObservation } from '../../src/resource-lifecycle/resources.ts';
import type { PathInspector } from '../../src/admission.ts';
import type { OperationStore } from '../../src/operations.ts';
import type { RuntimeScope } from '../../src/scope.ts';

const empty: ResourceObservation = { complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 }, freeBytes: 4_000_000_000n,
  uncertainWorkspace: false, potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0 };
const timestamp = '2026-10-08T00:00:00.0000000Z';
function operation(): RepairOperation {
  return { operationVersion: 1, operationId: `jr-${'a'.repeat(32)}`, scopeSha256: 'b'.repeat(64), kind: 'repair', cause: 'lostJournal', startedAt: timestamp,
    completedAt: null, outcome: null, compacted: false, plan: emptyRepairPlan(), recovery: initialRecovery(timestamp, 'c'.repeat(32)) };
}

describe('complete runtime transition capacity', () => {
  it('reserves all sixteen pending records, an acquisition and two recovery publications', () => {
    const transition = completeReservation('ordinary', { ...empty, pendingOutbox: 16 });
    assert.equal(transition.additions.uncompactedEvents, 17);
    assert.equal(transition.remainingControlReserve.uncompactedEvents, 2);
    assert.equal(transition.documents.filter(document => document.name.startsWith('incoming-')).length, 19);
    assert.equal(transition.additions.fullTerminalOperations + transition.remainingControlReserve.fullTerminalOperations, 2);
    assert.equal(assessCapacity(empty, transition).admitted, true);
  });

  it('uses unique existing recovery candidates and accounts for unfinished terminalization', () => {
    const inventory = { ...empty, counts: { ...empty.counts, retainedHandoffs: 10 }, potentialHandoffs: 13, unfinishedOperations: 3, pendingOutbox: 16 };
    const transition = completeReservation('repair', inventory);
    assert.equal(transition.additions.retainedHandoffs, 21);
    assert.equal(transition.additions.fullTerminalOperations, 4);
    assert.equal(transition.remainingControlReserve.fullTerminalOperations, 1);
  });

  it('reserves the observed empty outbox without charging sixteen nonexistent records', () => {
    const transition = completeReservation('ordinary', empty);
    assert.equal(transition.additions.uncompactedEvents, 1);
    assert.equal(transition.remainingControlReserve.uncompactedEvents, 2);
    assert.equal(transition.documents.filter(document => document.name.startsWith('incoming-')).length, 3);
    assert.throws(() => completeReservation('ordinary', empty, { retainedHandoffs: -1 }));
  });

  it('refuses the next ordinary transition before it spends required control space', () => {
    const inventory = { ...empty, counts: { ...empty.counts, uncompactedEvents: 8190 } };
    const result = assessCapacity(inventory, completeReservation('ordinary', inventory));
    assert.equal(result.admitted, false);
    if (!result.admitted) { assert.ok(result.dimensions.includes('uncompactedEvents')); }
  });

  it('permits a bounded release beside an over-limit event history while preserving the count', () => {
    const inventory = { ...empty, counts: { ...empty.counts, uncompactedEvents: 8193 }, potentialHandoffs: 8193 };
    const release = assessCapacity(inventory, completeReservation('release', inventory));
    assert.equal(release.admitted, true);
    if (release.admitted) { assert.equal(release.controlOnly, true); assert.equal(release.peakCounts.uncompactedEvents, 8193); }
    assert.equal(assessCapacity(inventory, completeReservation('repair', inventory)).admitted, false);
  });

  it('reserves only the remaining replacement and permits finalization at the event ceiling', () => {
    const replacement = { ...empty, counts: { ...empty.counts, uncompactedEvents: 8191 }, activeRepair: true, recoveryEvents: 1 };
    assert.equal(assessCapacity(replacement, completeReservation('repair', replacement)).admitted, true);
    const finalization = { ...replacement, counts: { ...replacement.counts, uncompactedEvents: 8192 }, recoveryEvents: 0, potentialHandoffs: 8192 };
    const transition = completeReservation('repair', finalization);
    assert.equal(transition.additions.uncompactedEvents, 0);
    assert.equal(transition.additions.retainedHandoffs, 0);
    assert.equal(assessCapacity(finalization, transition).admitted, true);
    const release = { ...empty, counts: { ...empty.counts, fullTerminalOperations: 4095 }, unfinishedOperations: 1, pendingConsumer: true };
    assert.equal(assessCapacity(release, completeReservation('release', release)).admitted, true);
  });

  it('derives remaining publication slots from the durable attempt and episode phase', () => {
    const record = operation();
    assert.equal(remainingRecoveryPublications(record), 2);
    const observed: RepairOperation = { ...record, recovery: { ...record.recovery, attempts: [{ ...record.recovery.attempts[0]!, publication: 'observed',
      selectedRecord: { logicalOutboxId: `${'d'.repeat(32)}-1`, recordSha256: 'e'.repeat(64) } }] } };
    assert.equal(remainingRecoveryPublications(observed), 1);
    const episode = record.recovery.episodes[0]!;
    assert.equal(remainingRecoveryPublications({ ...observed, recovery: { ...observed.recovery, episodes: [{ ...episode, phase: 'recordRejected' }] } }), 2);
    assert.equal(remainingRecoveryPublications({ ...observed, recovery: { ...observed.recovery, episodes: [{ ...episode, phase: 'verifyingHistory',
      acceptedRecovery: { journalId: 'journal', eventId: 'a'.repeat(32), sequence: 1, generation: 'b'.repeat(32), acceptedAt: timestamp } }] } }), 0);
    assert.equal(remainingRecoveryPublications({ ...record, recovery: { ...record.recovery, attempts: [...observed.recovery.attempts, record.recovery.attempts[0]!],
      episodes: [{ ...episode, replacementAttempt: 1 }] } }), 1);
  });

  it('refuses incomplete inventory, residue and insufficient complete workspace', () => {
    for (const inventory of [{ ...empty, complete: false }, { ...empty, uncertainWorkspace: true }, { ...empty, freeBytes: 64_000_000n }]) {
      assert.equal(assessCapacity(inventory, completeReservation('ordinary', inventory)).admitted, false);
    }
  });

  it('validates prospective replacement and finalization without mutating the current root', () => {
    const record = operation();
    const previous = structuredClone(record);
    validateOperationExpansion(record);
    assert.deepEqual(record, previous);
    const huge = { ...record, plan: { ...record.plan, handoffs: Array.from({ length: 8192 }, (_, sequence) => ({ logicalOutboxId: `${'d'.repeat(32)}-${sequence + 1}`,
      recordSha256: 'e'.repeat(64), payloadBindingSha256: 'f'.repeat(64), journalId: 'x'.repeat(2048), eventId: 'y'.repeat(2048), acceptance: null,
      presentation: 'unverified' as const, coreRepairOperationId: null, attemptRef: null })) } };
    assert.throws(() => validateOperationExpansion(huge));
  });

  it('revokes a previous reservation when the next inventory cannot be established', async () => {
    let unavailable = false;
    const inspector = { metadata: async () => ({ exitCode: unavailable ? 1 : 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({
      uncompactedEvents: 0, retainedHandoffs: 0, retainedHandoffIdentitySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', potentialHandoffs: 0, fullTerminalOperations: 0, unfinishedOperations: 0, invalidEvents: 0, invalidOperations: 0,
      uncertainWorkspace: false, pendingOutbox: 0, freeBytes: '4000000000',
    })) }) } as unknown as PathInspector;
    const operations = { list: async () => ({ records: [], invalid: [], handoffCount: 0, fullTerminalCount: 0 }) } as unknown as OperationStore;
    const scope = { dataRoot: 'C:/fixture', bindingSha256: 'a'.repeat(64) } as RuntimeScope;
    const authority = new ResourceAuthority(scope, inspector, operations);
    await authority.withTransition('release', async () => {
      await authority.reserve('release');
      await authority.workspace(1, 1);
      unavailable = true;
      await assert.rejects(() => authority.reserve('release'));
      await assert.rejects(() => authority.workspace(1, 1));
    });
  });
});
