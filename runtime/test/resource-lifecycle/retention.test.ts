import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CapacityObservation } from '../../src/capacity.ts';
import { deferredCarryAuthority, hasProviderAuthority } from '../../src/backend/provider-authority.ts';
import { emptyRepairPlan, initialRecovery, type ReleaseOperation, type RepairOperation } from '../../src/operation-records.ts';
import { OperationStore } from '../../src/operations.ts';
import { replayCandidate } from '../../src/recovery-progress.ts';
import type { ScopeStorage } from '../../src/storage.ts';
import { reconcileRetention, refreshCapacityOwed, selectOperationRetention, type MaintenanceDependencies, type RetentionInputs } from '../../src/resource-lifecycle/retention.ts';
import { journalEvent } from '../support/journal-event.ts';
import { carryTransfer, deferredRepair, MemoryAuthority, repair as parseRepair, release as fixtureRelease } from '../backend/authority-fixtures.ts';

const origin = '2026-01-01T00:00:00.0000000Z';
const rootId = `jr-${'b'.repeat(32)}`;
const releaseId = `rl-${'c'.repeat(32)}`;
const scopeHash = 'd'.repeat(64);
const hash = 'e'.repeat(64);
const generation = 'a'.repeat(32);
function repair(): RepairOperation {
  const initial = initialRecovery(origin, 'f'.repeat(32));
  return { operationVersion: 1, operationId: rootId, scopeSha256: scopeHash, kind: 'repair', cause: 'cursor', startedAt: origin, completedAt: origin, outcome: 'completed', compacted: false,
    plan: emptyRepairPlan(), recovery: { ...initial, activeEpisode: null, episodes: [{ ...initial.episodes[0]!, phase: 'completed', endedAt: origin,
      acceptedRecovery: { journalId: 'journal', eventId: '2'.padStart(32, '0'), sequence: 2, generation, acceptedAt: origin } }] } };
}
function base(): RetentionInputs {
  return { activeJournalId: 'journal', safety: { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null }, operations: [],
    events: [journalEvent(1, { occurredAt: origin, acknowledgedAt: origin }), journalEvent(2, { occurredAt: origin, acknowledgedAt: origin })],
    outbox: new Set(), outboxNames: new Set(), sessionGenerations: new Set(), carryPresent: false };
}
function release(): ReleaseOperation {
  return { operationVersion: 1, operationId: releaseId, scopeSha256: scopeHash, kind: 'release', cause: 'release', startedAt: origin, completedAt: origin, outcome: 'completed', compacted: false,
    safety: { obligationId: '3'.repeat(32), phase: 'discharged', correctionId: null }, plan: { mode: 'abandon', abandonedSequences: [], journalId: 'journal', skippedRanges: [], unfinishedRepairs: [],
      witness: null, witnessUnavailable: false, result: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: true, abandonedCount: 0 },
      completedPhases: ['coreSwitched', 'cursorAdvanced', 'repairsAbandoned', 'dischargesPublished', 'complete'] } };
}

describe('runtime retention authority', () => {
  it('keeps the complete resolved transfer proof through real compaction of unrelated terminal records', async () => {
    const transfer = carryTransfer();
    const unrelated = fixtureRelease({ operationId: 'rl-' + '9'.repeat(32), safety: { obligationId: '8'.repeat(32), phase: 'discharged', correctionId: null } });
    const memory = new MemoryAuthority();
    for (const record of [transfer.predecessor, transfer.successor, transfer.releaseRecord, unrelated]) { memory.seed('operations/' + record.operationId + '.json', record); }
    const store = new OperationStore(memory as unknown as ScopeStorage);
    const before = await store.list();
    const safety = base().safety;
    const graph = reconcileRetention({ ...base(), events: [], operations: before.records });
    const selected = selectOperationRetention(before.records, graph.protectedOperations, '2028-01-01T00:00:00.0000000Z');
    assert.equal(deferredCarryAuthority(before).state, 'resolved');
    assert.equal(hasProviderAuthority(safety, before), true);
    assert.deepEqual(selected.map(entry => entry.record.operationId), [unrelated.operationId]);
    for (const entry of selected) { await store.compact(entry, async record => !graph.protectedOperations.has(record.operationId)); }
    const after = await store.list();
    assert.equal(after.records.find(entry => entry.record.operationId === unrelated.operationId)!.record.compacted, true);
    assert.equal(deferredCarryAuthority(after).state, 'resolved');
    assert.equal(hasProviderAuthority(safety, after), true);
    for (const id of [transfer.successor.operationId, transfer.releaseRecord.operationId]) {
      const entry = after.records.find(item => item.record.operationId === id)!;
      await store.compact(entry, async () => true);
      const damaged = await store.list();
      assert.notEqual(deferredCarryAuthority(damaged).state, 'resolved');
      assert.equal(hasProviderAuthority(safety, damaged), false);
      memory.seed('operations/' + id + '.json', entry.record);
    }
  });

  it('retains an abandoned deferred carry and its original handoff without live journal or session references', () => {
    const original = deferredRepair();
    const abandoned = parseRepair({ ...original, completedAt: original.startedAt, outcome: 'abandonedByRelease', recovery: { ...original.recovery, activeEpisode: null,
      episodes: [{ ...original.recovery.episodes[0]!, phase: 'abandonedByRelease', releaseOperationId: fixtureRelease().operationId, endedAt: original.startedAt }] } });
    const operations = [{ record: abandoned, sha256: hash }];
    const authority = reconcileRetention({ ...base(), events: [], operations, carryPresent: true });
    assert.equal(authority.protectedOperations.has(abandoned.operationId), true);
    assert.equal(authority.protectedHandoffs.size, 1);
    assert.equal(selectOperationRetention(operations, new Set(), '2028-01-01T00:00:00.0000000Z').length, 0);
  });

  it('counts only current-generation binding and indexed session protection in owed status', async () => {
    const obsolete = '9'.repeat(32);
    for (const scenario of [
      { binding: obsolete, indexed: obsolete, handoff: obsolete, expected: 0 },
      { binding: generation, indexed: obsolete, handoff: generation, expected: 1 },
      { binding: obsolete, indexed: generation, handoff: generation, expected: 1 },
      { binding: null, indexed: null, handoff: obsolete, expected: 0 },
    ]) {
      const input = base();
      const event = input.events[0]!;
      const record = repair();
      const handoff = { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256, payloadBindingSha256: event.payloadBindingSha256,
        journalId: event.acceptance!.journalId, eventId: event.acceptance!.eventId, acceptance: { ...event.acceptance!, generation: scenario.handoff },
        presentation: 'replayable' as const, coreRepairOperationId: null, attemptRef: null };
      const capacity = new CapacityObservation();
      const deps = {
        scope: { dataRoot: 'unused' }, resources: { capacity },
        safetyStore: { read: async () => ({ status: 'valid', value: input.safety }) },
        operations: { list: async () => ({ invalid: [], records: [{ record: { ...record, plan: { ...record.plan, handoffs: [handoff] } }, sha256: hash }] }) },
        journal: { read: async () => ({ fault: null, damaged: [], events: new Map(), header: { status: 'valid', value: { journalId: 'journal', historyVerified: true } }, cursor: { status: 'valid', value: { lastAckedSequence: 0 } } }) },
        outbox: { list: async () => [] }, inspector: { inspect: async () => ({ exists: false }) },
        storage: { read: async (name: string) => name === 'agent-session.json'
          ? scenario.binding === null ? { status: 'absent' } : { status: 'valid', value: { stateGeneration: scenario.binding } }
          : scenario.indexed === null ? { status: 'absent' } : { status: 'valid', value: { sessions: [{ stateGeneration: scenario.indexed }] } } },
      } as unknown as MaintenanceDependencies;
      await refreshCapacityOwed(deps);
      assert.equal(capacity.current.owed.protectedHandoffs, scenario.expected, JSON.stringify(scenario));
      assert.equal(capacity.current.ordinary.state, 'unchecked');
      for (const status of ['absent', 'invalid']) {
        const unavailable = { ...deps, safetyStore: { read: async () => ({ status }) } } as unknown as MaintenanceDependencies;
        await refreshCapacityOwed(unavailable);
        assert.equal(capacity.current.owed.protectedHandoffs, null);
      }
    }
  });

  it('keeps the newest selectable state while retiring acknowledged earlier payloads', () => {
    const input = base();
    const authority = reconcileRetention(input);
    assert.equal(authority.evidence(input.events[0]!).path, 'acknowledged');
    assert.equal(authority.evidence(input.events[1]!).state, 'protected');
  });

  it('requires the exact acknowledged recovery event for synthetic skips', () => {
    const input = base();
    const record = repair();
    const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'cursorRecovery' as const,
      discharge: { kind: 'recoveryAcknowledged' as const, operationId: rootId, episodeOrdinal: 0, at: origin } };
    const skipped = { ...input.events[0]!, acknowledgedAt: null };
    const operations = [{ record: { ...record, plan: { ...record.plan, skippedRanges: [range] } }, sha256: hash }];
    const authority = reconcileRetention({ ...input, events: [skipped, input.events[1]!], operations });
    assert.equal(authority.evidence(skipped).path, 'skipDischarged');
    assert.equal(skipped.acknowledgedAt, null);
    assert.equal(authority.protectedOperations.has(rootId), true);
    const renewed = { ...input.events[1]!, acceptance: { ...input.events[1]!.acceptance!, generation: '9'.repeat(32) } };
    assert.equal(reconcileRetention({ ...input, safety: { ...input.safety, generation: '9'.repeat(32) }, events: [skipped, renewed], operations }).evidence(skipped).path, 'skipDischarged');
    assert.throws(() => reconcileRetention({ ...input, events: [skipped, { ...input.events[1]!, acknowledgedAt: null }], operations }));
    assert.throws(() => reconcileRetention({ ...input, operations, events: [skipped, { ...input.events[1]!, eventId: '9'.repeat(32) }] }));
  });

  it('keeps a completed old-journal discharge after an admitted header replacement', () => {
    const input = base();
    const record = repair();
    const proof = { kind: 'recoveryAcknowledged' as const, operationId: rootId, episodeOrdinal: 0, at: origin };
    const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'cursorRecovery' as const, discharge: proof };
    const owner = { record: { ...record, plan: { ...record.plan, skippedRanges: [range] } }, sha256: hash };
    const historical: RetentionInputs = { ...input, activeJournalId: 'new-journal', events: [], operations: [owner],
      safety: { ...input.safety, generation: '9'.repeat(32) } };
    const authority = reconcileRetention(historical);
    assert.equal(authority.provenance.status, 'verified');
    if (authority.provenance.status !== 'verified') { throw new Error('Expected verified historical provenance.'); }
    assert.deepEqual(authority.provenance.ranges[0]?.discharge, proof);
    assert.equal(authority.protectedOperations.has(rootId), false);
    assert.deepEqual(selectOperationRetention(historical.operations, authority.protectedOperations, '2028-01-01T00:00:00.0000000Z').map(entry => entry.record.operationId), [rootId]);
    const replayed = replayCandidate(owner.record, '7'.repeat(32), origin);
    assert.equal(reconcileRetention({ ...historical, operations: [{ ...owner, record: replayed }] }).provenance.status, 'verified');
    assert.throws(() => reconcileRetention({ ...historical, activeJournalId: 'journal' }));
    assert.throws(() => reconcileRetention({ ...historical, activeJournalId: '' }));
    assert.throws(() => reconcileRetention({ ...historical, sessionGenerations: new Set([generation]) }));
    assert.throws(() => reconcileRetention({ ...historical, events: [input.events[0]!] }));
    const carrier = { record: { ...owner.record, operationId: `jr-${'c'.repeat(32)}` }, sha256: hash };
    const missingSelfProof = { ...owner, record: { ...owner.record, plan: { ...owner.record.plan, skippedRanges: [] } } };
    assert.throws(() => reconcileRetention({ ...historical, operations: [missingSelfProof, carrier] }));
    const retained = reconcileRetention({ ...historical, operations: [owner, carrier] });
    assert.equal(retained.protectedOperations.has(rootId), true);
    assert.deepEqual(selectOperationRetention([owner, carrier], retained.protectedOperations, '2028-01-01T00:00:00.0000000Z').map(entry => entry.record.operationId), [carrier.record.operationId]);
  });

  it('requires a completed exact abandon proof and preserves its supporting root', () => {
    const input = base();
    const record = release();
    const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'abandonRelease' as const,
      discharge: { kind: 'abandonRelease' as const, operationId: releaseId, episodeOrdinal: null, at: origin } };
    const skipped = { ...input.events[0]!, acknowledgedAt: null };
    const operations = [{ record: { ...record, plan: { ...record.plan, skippedRanges: [range] } }, sha256: hash }];
    const authority = reconcileRetention({ ...input, events: [skipped, input.events[1]!], operations });
    assert.equal(authority.evidence(skipped).path, 'skipDischarged');
    assert.equal(authority.protectedOperations.has(releaseId), true);
    assert.throws(() => reconcileRetention({ ...input, operations: [{ record: { ...operations[0]!.record, plan: { ...operations[0]!.record.plan, mode: 'confirmed' } }, sha256: hash }] }));
  });

  it('retains unknown settlements, unresolved skips and active recovery even beside historical completion', () => {
    const input = base();
    const unknown = { ...input.events[0]!, settlement: 'unknown' as const, acceptance: null };
    assert.equal(reconcileRetention({ ...input, events: [unknown, input.events[1]!] }).evidence(unknown).state, 'protected');
    const record = repair();
    const pending = { ...record, plan: { ...record.plan, affected: [{ sequence: 1, eventId: input.events[0]!.eventId, fileSha256: hash }] }, recovery: initialRecovery(origin, '5'.repeat(32)) };
    const authority = reconcileRetention({ ...input, operations: [{ record: pending, sha256: hash }] });
    assert.equal(authority.protectedOperations.has(rootId), true);
    assert.equal(authority.evidence(input.events[0]!).state, 'protected');
    const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'cursorRecovery' as const, discharge: null };
    assert.equal(reconcileRetention({ ...input, operations: [{ record: { ...record, plan: { ...record.plan, skippedRanges: [range] } }, sha256: hash }] }).evidence(input.events[0]!).state, 'protected');
  });

  it('protects compact-event attempt owners and handoffs referenced by surviving outbox or admitted sessions', () => {
    const input = base();
    const record = repair();
    const event = input.events[0]!;
    const handoff = { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256, payloadBindingSha256: event.payloadBindingSha256,
      journalId: event.acceptance!.journalId, eventId: event.acceptance!.eventId, acceptance: event.acceptance, presentation: 'replayable' as const, coreRepairOperationId: null, attemptRef: null };
    const operations = [{ record: { ...record, plan: { ...record.plan, handoffs: [handoff] } }, sha256: hash }];
    assert.equal(reconcileRetention({ ...input, events: [], operations, outbox: new Set([`${event.logicalOutboxId}:${event.recordSha256}`]) }).protectedOperations.has(rootId), true);
    assert.equal(reconcileRetention({ ...input, events: [], operations, sessionGenerations: new Set([generation]) }).protectedOperations.has(rootId), true);
    assert.equal(reconcileRetention({ ...input, operations: [], events: [{ ...event, compacted: true, attemptRef: { operationId: rootId, attemptOrdinal: 0 } }] }).protectedOperations.has(rootId), true);
  });

  it('uses the terminal-operation 365-day policy and stable oldest-first overflow selection', () => {
    const record = release();
    const entry = { record, sha256: hash };
    assert.equal(selectOperationRetention([entry], new Set(), '2026-12-31T23:59:59.9999999Z').length, 0);
    assert.equal(selectOperationRetention([entry], new Set(), '2027-01-01T00:00:00.0000000Z').length, 1);
    assert.equal(selectOperationRetention([entry], new Set([releaseId]), '2027-01-01T00:00:00.0000000Z').length, 0);
    const many = Array.from({ length: 4097 }, (_, index) => ({ record: { ...record, operationId: `rl-${index.toString(16).padStart(32, '0')}` }, sha256: hash }));
    const selected = selectOperationRetention(many.reverse(), new Set(), '2026-01-02T00:00:00.0000000Z');
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.record.operationId, `rl-${'0'.repeat(32)}`);
  });
});
