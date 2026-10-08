import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acquireWithPolicy, newestState, type AcquisitionPort } from '../../src/backend/acquisition-policy.ts';
import type { CoreResult, PublishReceipt } from '../../src/core-client.ts';
import type { Deadline } from '../../src/deadline.ts';
import type { JournalEvent, JournalSnapshot } from '../../src/journal.ts';

const now = '2026-10-08T00:00:00.0000000Z';
const targetA = 'a'.repeat(64);
const targetB = 'b'.repeat(64);
function event(sequence: number, target: string, compacted = false): JournalEvent {
  return { sha256: String(sequence).repeat(64).slice(0, 64), metadata: { eventVersion: 1, journalId: 'journal', sequence, eventId: String(sequence).repeat(32).slice(0, 32),
    type: 'state.snapshot', occurredAt: now, runtimeInstanceId: 'runtime', adapter: 'stubgame', adapterBindingEpoch: 'epoch', principal: 'principal',
    logicalOutboxId: `${'1'.repeat(32)}-${sequence}`, recordSha256: 'c'.repeat(64), coreRepairOperationId: null, attemptRef: null, schemaVersion: 2, adapterVersion: 2,
    settlement: 'accepted', acceptance: { journalId: 'journal', eventId: String(sequence).repeat(32).slice(0, 32), generation: 'd'.repeat(32) }, acknowledgedAt: now,
    compacted, payloadBindingSha256: 'e'.repeat(64), targetIdentitySha256: compacted ? null : target, stateGeneratedAt: compacted ? null : now } };
}
function journal(events: readonly JournalEvent[] = []): JournalSnapshot {
  const highWater = Math.max(0, ...events.map(value => value.metadata.sequence));
  return { header: { status: 'valid', sha256: 'f'.repeat(64), value: { journalVersion: 1, journalId: 'journal', createdAt: now, highWaterSequence: highWater, historyVerified: true } },
    cursor: { status: 'valid', sha256: 'f'.repeat(64), value: { cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: highWater, lastSentSequence: highWater, lastAcceptedRevision: null, updatedAt: now } },
    events: new Map(events.map(value => [value.metadata.sequence, value])), damaged: [], historicalGaps: [], fault: null, firstBadSequence: null, unrecordedEvent: null };
}
function success(target: string, outcome: 'unchanged' | 'committed' = 'unchanged', game = 'stubgame'): CoreResult<PublishReceipt> {
  return { success: true, value: { outcome, kind: outcome === 'unchanged' ? null : 'snapshot', logicalOutboxId: outcome === 'unchanged' ? null : `${'1'.repeat(32)}-1`,
    sequence: outcome === 'unchanged' ? null : 1, schemaVersion: 2, adapterVersion: 2, game, targetIdentitySha256: target, targetGeneratedAt: now,
    baselineApplied: null, cacheDegraded: false, warnings: [] } };
}
function port(snapshots: readonly JournalSnapshot[], receipts: readonly CoreResult<PublishReceipt>[]) {
  const flags: boolean[] = [];
  const completionBudgets: Deadline[] = [];
  const gates: Deadline[] = [];
  let reads = 0;
  let fault: string | null = null;
  const value: AcquisitionPort = { game: 'stubgame', fault: () => fault, readJournal: async () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
    publish: async (required, acquisition, afterChild) => {
      const result = receipts[flags.length]!;
      flags.push(required);
      const completion = afterChild(result, performance.now());
      completionBudgets.push(completion);
      assert.ok(completion === acquisition || completion.remaining(120000) <= 120000);
      return result;
    }, onGate: gate => { gates.push(gate); } };
  return { value, flags, completionBudgets, gates, setFault: (next: string) => { fault = next; }, reads: () => reads };
}

describe('bounded acquisition policy', () => {
  it('requires the first record when only compact evidence remains', async () => {
    const fixture = port([journal([event(1, targetA, true)])], [success(targetB, 'committed')]);
    const result = await acquireWithPolicy(fixture.value);
    assert.deepEqual(fixture.flags, [true]);
    assert.equal(result.gate, fixture.completionBudgets[0]);
    assert.equal(fixture.gates.length, 1);
  });

  it('chooses the actual newest full state regardless of inventory insertion order', async () => {
    const snapshot = journal([event(3, targetB), event(4, targetA, true), event(1, targetA)]);
    assert.equal(newestState(snapshot)?.metadata.sequence, 3);
    const fixture = port([snapshot], [success(targetB)]);
    const result = await acquireWithPolicy(fixture.value);
    assert.deepEqual(fixture.flags, [false]);
    assert.equal(result.gate, fixture.completionBudgets[0]);
  });

  it('runs exactly one required snapshot for an unchanged mismatched target and keeps the final gate', async () => {
    const receipt = success(targetB, 'committed');
    const fixture = port([journal([event(1, targetA)])], [success(targetB), receipt]);
    const result = await acquireWithPolicy(fixture.value);
    assert.deepEqual(fixture.flags, [false, true]);
    assert.equal(result.receipt, receipt);
    assert.equal(result.gate, fixture.completionBudgets[1]);
    assert.notEqual(result.gate, fixture.completionBudgets[0]);
    assert.deepEqual(fixture.gates, [result.gate]);
    assert.equal(fixture.reads(), 2);
  });

  it('rechecks the retained state before the extra transaction and skips a now matching target', async () => {
    const fixture = port([journal([event(1, targetA)]), journal([event(1, targetA), event(2, targetB)])], [success(targetB)]);
    const result = await acquireWithPolicy(fixture.value);
    assert.deepEqual(fixture.flags, [false]);
    assert.deepEqual(fixture.gates, [result.gate]);
  });

  it('does not consume after persistent faults, failed receipts, or adapter mismatch', async () => {
    const blocked = port([], []);
    blocked.setFault('outboxConflict');
    const skipped = await acquireWithPolicy(blocked.value);
    assert.equal(skipped.skippedFault, 'outboxConflict');
    assert.equal(skipped.receipt, null);
    assert.deepEqual(blocked.flags, []);
    assert.equal(blocked.reads(), 0);
    for (const receipt of [success(targetB, 'unchanged', 'othergame'),
      { success: false, class: 'config', reason: 'consumer-not-owner', consumptionState: 'notConsumed', generationTimestamp: null, warnings: [] } satisfies CoreResult<PublishReceipt>]) {
      const fixture = port([journal([event(1, targetA)])], [receipt]);
      const result = await acquireWithPolicy(fixture.value);
      assert.deepEqual(fixture.flags, [false]);
      assert.equal(result.receipt, receipt);
      assert.equal(result.gate, fixture.completionBudgets[0]);
    }
  });

  it('retains the established gate when dependent completion fails', async () => {
    const fixture = port([journal([event(1, targetA)])], [success(targetA)]);
    const failure = new Error('dependent write refused');
    const original = fixture.value.publish;
    await assert.rejects(acquireWithPolicy({ ...fixture.value, publish: async (...args) => { await original(...args); throw failure; } }), error => error === failure);
    assert.equal(fixture.gates.length, 1);
    assert.equal(fixture.gates[0], fixture.completionBudgets[0]);
  });

  it('anchors settlement before delayed receipt validation and does not renew it at selection', async () => {
    const fixture = port([journal([event(1, targetA)])], [success(targetA)]);
    const result = await acquireWithPolicy({ ...fixture.value, publish: async (_, acquisition, afterChild) => {
      const receipt = success(targetA);
      const gate = afterChild(receipt, performance.now() - 50000);
      assert.notEqual(gate, acquisition);
      assert.ok(gate.remaining(120000) <= 70000);
      return receipt;
    } });
    assert.ok(result.gate.remaining(120000) <= 70000);
    assert.deepEqual(fixture.gates, [result.gate]);
  });

  it('does not make the extra call after a newly observed fault and does not hide damaged inventory', async () => {
    const fixture = port([journal([event(1, targetA)])], [success(targetB)]);
    const original = fixture.value.publish;
    const result = await acquireWithPolicy({ ...fixture.value, publish: async (...args) => { const receipt = await original(...args); fixture.setFault('outboxConflict'); return receipt; } });
    assert.deepEqual(fixture.flags, [false]);
    assert.deepEqual(fixture.gates, [result.gate]);
    const damaged = port([{ ...journal(), fault: 'gap' }], []);
    await assert.rejects(acquireWithPolicy(damaged.value), /Journal damage/);
    assert.deepEqual(damaged.flags, []);
  });
});
