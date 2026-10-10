import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CapacityObservation } from '../../src/capacity.ts';
import { emptyRepairPlan, initialRecovery, type ReleaseOperation, type RepairOperation } from '../../src/operation-records.ts';
import { reconcileRetention, refreshCapacityOwed, selectOperationRetention, type MaintenanceDependencies, type RetentionInputs } from '../../src/resource-lifecycle/retention.ts';
import { journalEvent } from '../support/journal-event.ts';

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
  return { safety: { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null }, operations: [],
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
        journal: { read: async () => ({ fault: null, damaged: [], events: new Map(), header: { status: 'valid', value: { historyVerified: true } }, cursor: { status: 'valid', value: { lastAckedSequence: 0 } } }) },
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
