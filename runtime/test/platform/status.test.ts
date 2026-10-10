import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EventRead } from '../../src/event-reader.ts';
import type { JournalCursor, JournalHeader } from '../../src/journal-records.ts';
import { isPublicationResidue } from '../../src/platform/publication-residue.ts';
import { summarizeCarryStatus, summarizeJournal, type OperationStatus, type StatusDocument } from '../../src/platform/status.ts';
import { journalEvent } from '../support/journal-event.ts';
import { authorityModel, correctionId, deferredRepair, generation, owner, release, repair, scope } from '../backend/authority-fixtures.ts';
import type { OperationInventory } from '../../src/operations.ts';
import type { RepairOperation } from '../../src/operation-records.ts';
import type { StateSafety } from '../../src/safety-records.ts';

const now = '2026-10-08T01:00:00.0000000Z';
const header = (highWaterSequence: number): StatusDocument<JournalHeader> => ({ status: 'valid', value: { journalVersion: 1, journalId: 'journal', createdAt: now, highWaterSequence, historyVerified: true } });
const cursor = (lastAckedSequence: number): StatusDocument<JournalCursor> => ({ status: 'valid', value: { cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence, lastSentSequence: lastAckedSequence, lastAcceptedRevision: null, updatedAt: now } });
const event = (sequence: number, overrides: Record<string, unknown> = {}): EventRead => ({ status: 'valid', path: `${sequence}.json`, sha256: 'a'.repeat(64), metadata: journalEvent(sequence, overrides) });
const summary = (events: EventRead[], highWater = 3, acked = 1, operations: OperationStatus[] = []) => summarizeJournal(header(highWater), cursor(acked), events, 'game', 'principal', operations, []);

describe('standalone status interpretation', () => {
  it('shares exact correction owner evidence without denying unbound or pending corrections', async () => {
    const source = deferredRepair('resolved');
    const matching = repair({ ...source, plan: { ...source.plan, correctionId } });
    const duplicate = repair({ ...matching, operationId: 'jr-' + '9'.repeat(32), plan: { ...matching.plan, handoffs: [] },
      recovery: { ...matching.recovery, episodes: matching.recovery.episodes.map(episode => ({ ...episode, prerequisite: null })) } });
    const abandoned = repair({ ...matching, recovery: { ...matching.recovery, episodes: matching.recovery.episodes.map(episode => ({ ...episode, phase: 'abandonedByRelease', releaseOperationId: release().operationId })) } });
    const cases: { label: string; records: readonly RepairOperation[]; carry: 'none' | 'resolved' | 'unavailable'; provider: boolean; unbound?: boolean; pending?: boolean }[] = [
      { label: 'matching', records: [matching], carry: 'resolved', provider: true },
      { label: 'missing plan binding', records: [source], carry: 'unavailable', provider: false },
      { label: 'different plan binding', records: [repair({ ...source, plan: { ...source.plan, correctionId: 'd'.repeat(32) } })], carry: 'unavailable', provider: false },
      { label: 'competing owners', records: [matching, duplicate], carry: 'unavailable', provider: false },
      { label: 'absent owner', records: [], carry: 'unavailable', provider: false },
      { label: 'abandoned owner', records: [abandoned], carry: 'unavailable', provider: false },
      { label: 'unbound correction', records: [], carry: 'none', provider: false, unbound: true },
      { label: 'plan before correction binding', records: [matching], carry: 'resolved', provider: false, unbound: true },
      { label: 'pending check', records: [matching], carry: 'resolved', provider: false, pending: true },
    ];
    for (const item of cases) {
      const state: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: item.pending ? '5'.repeat(32) : null, recoveryWitness: null,
        correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: item.unbound ? null : matching.operationId } };
      const model = authorityModel(state);
      for (const record of item.records) { model.memory.seed('operations/' + record.operationId + '.json', record); }
      const inventory = await model.kernel.operations.list();
      const observed = await model.kernel.observeSafety();
      assert.equal(summarizeCarryStatus({ status: 'valid', value: state }, inventory, null), item.carry, item.label);
      assert.equal(observed.stateSafety.carryRelease, item.carry, item.label);
      assert.equal(observed.stateSafety.state, item.carry === 'unavailable' ? 'unavailable' : 'recovering', item.label);
      assert.equal(observed.providerAllowed, item.provider, item.label);
    }
    for (const unreadable of [false, true]) {
      const state: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, recoveryWitness: null,
        correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: matching.operationId } };
      const model = authorityModel(state);
      const name = 'operations/' + matching.operationId + '.json';
      model.memory.seed(name, matching);
      if (unreadable) { model.memory.unreadable.add(name); } else { model.memory.files.set(name, Buffer.from('{')); }
      const observed = await model.kernel.observeSafety();
      assert.equal(observed.stateSafety.state, 'unavailable');
      assert.equal(observed.providerAllowed, false);
      const inventory: OperationInventory = { records: [], invalid: [{ name, sha256: null }], handoffCount: 0, fullTerminalCount: 0 };
      assert.equal(summarizeCarryStatus({ status: 'valid', value: state }, inventory, null), 'unavailable');
    }
  });

  it('reports the deferred cleanup state only from complete admitted authority', () => {
    const safety = { status: 'valid' as const, value: { stateSafetyVersion: 1 as const, generation, pendingCheck: null, correction: null, recoveryWitness: null } };
    const empty = { records: [], invalid: [], handoffCount: 0, fullTerminalCount: 0 };
    assert.equal(summarizeCarryStatus(safety, empty, null), 'none');
    for (const state of ['waitingReplacement', 'pendingCleanup', 'resolved'] as const) {
      const inventory = { ...empty, records: [{ record: deferredRepair(state), sha256: 'a'.repeat(64) }] };
      const admitted = state === 'resolved' ? safety : { ...safety, value: { ...safety.value,
        recoveryWitness: { scopeSha256: scope, owner, phase: 'active' as const, successor: null, disclosure: null } } };
      assert.equal(summarizeCarryStatus(admitted, inventory, null), state);
      assert.equal(summarizeCarryStatus(safety, inventory, undefined), 'unavailable');
      assert.equal(summarizeCarryStatus(safety, inventory, '8'.repeat(64)), 'unavailable');
      assert.equal(summarizeCarryStatus({ status: 'absent' }, inventory, null), 'unavailable');
      assert.equal(summarizeCarryStatus({ status: 'unreadable' }, inventory, null), 'unavailable');
      assert.equal(summarizeCarryStatus(safety, { ...inventory, invalid: [{ name: 'lost.json', sha256: null }] }, null), 'unavailable');
    }
  });

  it('shares live witness and root authority across missing, contradictory and expected partial states', async () => {
    const clean: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null };
    const active = deferredRepair();
    const completed = deferredRepair('resolved');
    const checkpoint = completed.recovery.episodes[0]!.acceptedRecovery!;
    const witness = { scopeSha256: scope, owner, phase: 'active' as const, successor: null, disclosure: null };
    const awaiting = { ...witness, phase: 'awaitingDisclosure' as const, disclosure: { journalId: checkpoint.journalId, eventId: checkpoint.eventId, sequence: checkpoint.sequence, generation: checkpoint.generation } };
    const inventory = (records: OperationInventory['records']): OperationInventory => ({ records, invalid: [], handoffCount: 0, fullTerminalCount: 0 });
    const records = inventory([{ record: active, sha256: 'a'.repeat(64) }]);
    const finished = inventory([{ record: completed, sha256: 'a'.repeat(64) }]);
    const nextOwner = { operationId: 'jr-' + '9'.repeat(32), episodeOrdinal: 0, activationId: '8'.repeat(32) };
    const next = repair({ operationId: nextOwner.operationId, plan: { ...active.plan, handoffs: [], inheritedRecovery: owner },
      recovery: { ...repair().recovery, episodes: [{ ...repair().recovery.episodes[0]!, activationId: nextOwner.activationId }] } });
    const successor = inventory([{ record: next, sha256: 'b'.repeat(64) }]);
    const cases: { state: StateSafety; inventory: OperationInventory; unavailable: boolean }[] = [
      { state: clean, inventory: records, unavailable: true },
      { state: { ...clean, recoveryWitness: witness }, inventory: records, unavailable: false },
      { state: { ...clean, recoveryWitness: witness }, inventory: inventory([]), unavailable: true },
      { state: { ...clean, recoveryWitness: { ...witness, owner: { ...owner, activationId: '9'.repeat(32) } } }, inventory: records, unavailable: true },
      { state: { ...clean, recoveryWitness: { ...witness, owner: { ...owner, episodeOrdinal: 1 } } }, inventory: records, unavailable: true },
      { state: { ...clean, recoveryWitness: { ...witness, scopeSha256: '9'.repeat(64) } }, inventory: records, unavailable: true },
      { state: { ...clean, recoveryWitness: awaiting }, inventory: finished, unavailable: false },
      { state: { ...clean, recoveryWitness: awaiting }, inventory: inventory([]), unavailable: true },
      { state: { ...clean, recoveryWitness: { ...awaiting, owner: { ...owner, activationId: '9'.repeat(32) } } }, inventory: finished, unavailable: true },
      { state: { ...clean, recoveryWitness: { ...awaiting, disclosure: { ...awaiting.disclosure, eventId: '9'.repeat(32) } } }, inventory: finished, unavailable: true },
      { state: { ...clean, recoveryWitness: { ...witness, phase: 'preparing' } }, inventory: inventory([]), unavailable: false },
      { state: { ...clean, recoveryWitness: { ...witness, phase: 'preparing', owner: { ...owner, activationId: '9'.repeat(32) } } }, inventory: records, unavailable: true },
      { state: { ...clean, recoveryWitness: { ...witness, phase: 'transferring', successor: nextOwner } }, inventory: records, unavailable: false },
      { state: { ...clean, recoveryWitness: { ...witness, phase: 'transferring', successor: nextOwner } }, inventory: successor, unavailable: false },
      { state: { ...clean, recoveryWitness: { ...witness, phase: 'transferring', successor: nextOwner } },
        inventory: inventory([{ record: { ...next, plan: { ...next.plan, inheritedRecovery: null } }, sha256: 'b'.repeat(64) }]), unavailable: true },
      { state: { ...clean, recoveryWitness: witness }, inventory: inventory([...records.records, ...successor.records]), unavailable: true },
      { state: { ...clean, recoveryWitness: witness }, inventory: { ...records, records: [...records.records, ...records.records] }, unavailable: true },
    ];
    for (const item of cases) {
      const model = authorityModel();
      model.kernel.safetyStore.read = async () => ({ status: 'valid', value: item.state, sha256: 'a'.repeat(64) });
      model.kernel.operations.list = async () => item.inventory;
      const observed = await model.kernel.observeSafety();
      const standalone = summarizeCarryStatus({ status: 'valid', value: item.state }, item.inventory, null);
      assert.equal(standalone === 'unavailable', item.unavailable);
      assert.equal(observed.stateSafety.state === 'unavailable', item.unavailable);
      assert.equal(observed.stateSafety.carryRelease, standalone);
      if (item.unavailable) { assert.equal(observed.providerAllowed, false); }
    }
    const pending = release({ safety: { obligationId: '9'.repeat(32), phase: 'pending', correctionId: null } });
    const model = authorityModel(clean);
    model.memory.seed('operations/' + pending.operationId + '.json', pending);
    const observed = await model.kernel.observeSafety();
    assert.equal(observed.stateSafety.state, 'recovering');
    assert.equal(summarizeCarryStatus({ status: 'valid', value: clean }, await model.kernel.operations.list(), null), 'none');
  });

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
    const refused: OperationStatus = { operationId: 'rl-' + '1'.repeat(32), kind: 'release', cause: 'release', outcome: 'refused', effectivelyUnfinished: false, pendingSafety: true, carryRelease: 'none' };
    assert.equal(summary([], 0, 0, [refused]).fault, null);
    const repair: OperationStatus = { operationId: 'jr-' + '2'.repeat(32), kind: 'repair', cause: 'header', outcome: 'completed', effectivelyUnfinished: true, pendingSafety: false, carryRelease: 'none' };
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
