import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PathInspector } from '../../src/admission.ts';
import { additionalHandoffCount, handoffIdentity, handoffIdentityDigest } from '../../src/backend/handoffs.ts';
import { DeliveryCoordinator } from '../../src/backend/delivery.ts';
import { Kernel, type KernelInput } from '../../src/backend/kernel.ts';
import { RecoveryCoordinator, handoffFor } from '../../src/backend/recovery.ts';
import { assessCapacity, RuntimeCapacityError } from '../../src/capacity.ts';
import { Deadline } from '../../src/deadline.ts';
import type { EventDescription } from '../../src/journal-records.ts';
import type { JournalSnapshot } from '../../src/journal.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { effectivelyUnfinished, type RepairOperation, type RetainedHandoff } from '../../src/operation-records.ts';
import { OperationStore } from '../../src/operations.ts';
import { completeReservation, ResourceAuthority, type ResourceObservation } from '../../src/resource-lifecycle/resources.ts';
import { parseStateSafety, type StateSafety } from '../../src/safety-records.ts';
import { bytesHash, type ScopeStorage } from '../../src/storage.ts';
import { MemoryAuthority, at, generation, journal, repair, scope } from './authority-fixtures.ts';
import { journalEvent } from '../support/journal-event.ts';

const empty: ResourceObservation = { complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 },
  freeBytes: 100000000000n, uncertainWorkspace: false, potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0 };
function history(compact: number, live = 2): readonly EventDescription[] {
  return Array.from({ length: compact + live }, (_, offset) => journalEvent(offset + 1, { adapter: 'stubgame', principal: 'principal',
    recordSha256: bytesHash(Buffer.from('core-source-' + (offset + 1))), compacted: offset < compact, acknowledgedAt: offset < compact ? at : null,
    acceptance: { journalId: 'journal', eventId: (offset + 1).toString(16).padStart(32, '0'), generation },
    ...(offset < compact ? { targetIdentitySha256: null, stateGeneratedAt: null } : {}) }));
}

function completedRoot(handoffs: readonly RetainedHandoff[]): RepairOperation {
  const initial = repair();
  const accepted = { journalId: 'journal', eventId: 'f'.repeat(32), sequence: 1, generation, acceptedAt: at };
  return repair({ completedAt: at, outcome: 'completed', plan: { ...initial.plan, handoffs, correctionId: null, publishedVersions: { schemaVersion: 2, adapterVersion: 1 } },
    recovery: { attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: 'c'.repeat(32) + '-1', recordSha256: 'd'.repeat(64) }, journalEvent: { journalId: 'journal', eventId: accepted.eventId, sequence: 1 } }],
      episodes: [{ ...initial.recovery.episodes[0]!, phase: 'completed', acceptedRecovery: accepted, endedAt: at }], activeEpisode: null } });
}

// Native aggregate observations are modeled from scope-consistent parsed control
// metadata. No event payload, physical path or native helper is claimed verified.
// Test-ResourceInventory.ps1 independently exercises the actual native union.
function fixture(events: readonly EventDescription[], retained: readonly RetainedHandoff[] = []) {
  const memory = new MemoryAuthority();
  const safety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null };
  memory.seed('state-safety.json', safety);
  if (retained.length > 0) { const record = completedRoot(retained); memory.seed('operations/' + record.operationId + '.json', record); }
  const operations = new OperationStore(memory as unknown as ScopeStorage);
  let coreCalls = 0;
  let metadataCalls = 0;
  let replyChange: ((value: Record<string, unknown>) => Record<string, unknown>) | null = null;
  let afterObserve: (() => void) | null = null;
  const metadata = async () => {
    metadataCalls++;
    const inventory = await operations.list();
    const known = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair' ? entry.record.plan.handoffs : []);
    const pair = (value: { logicalOutboxId: string; recordSha256: string }) => JSON.stringify([value.logicalOutboxId, value.recordSha256]);
    const native = { uncompactedEvents: events.filter(event => !event.compacted).length, retainedHandoffs: new Set(known.map(pair)).size,
      retainedHandoffIdentitySha256: handoffIdentityDigest(known),
      potentialHandoffs: new Set([...events.map(pair), ...known.map(pair)]).size, fullTerminalOperations: inventory.fullTerminalCount,
      unfinishedOperations: inventory.records.filter(entry => effectivelyUnfinished(entry.record)).length, invalidEvents: 0, invalidOperations: inventory.invalid.length,
      pendingOutbox: 0, uncertainWorkspace: false, freeBytes: '100000000000' };
    const observed = replyChange?.(native) ?? native;
    afterObserve?.();
    return { exitCode: 0, stdout: Buffer.from(stringifyJson(observed)), stderr: Buffer.alloc(0) };
  };
  const inspector = { metadata, inspect: memory.inspect.bind(memory) } as unknown as PathInspector;
  const resources = new ResourceAuthority(memory.scope, inspector, operations);
  (resources as unknown as { readSafety: () => Promise<StateSafety> }).readSafety = async () => parseStateSafety(parseStrictJson(memory.files.get('state-safety.json')!), scope);
  const snapshot: JournalSnapshot = { ...journal(events.length, events.filter(event => event.compacted).length),
    events: new Map(events.map(event => [event.sequence, { metadata: event, sha256: bytesHash(Buffer.from(stringifyJson(event))) }])) };
  if (snapshot.header.status === 'valid') { memory.seed('journal/journal.json', snapshot.header.value); }
  if (snapshot.cursor.status === 'valid') { memory.seed('journal/cursor-agent-session.json', snapshot.cursor.value); }
  const kernel = new Kernel({ scope: memory.scope, resources, storage: memory, inspector, publisher: {}, guard: { held: true },
    supervisor: { run: async () => { throw new Error('Native helpers are forbidden in this pure fixture.'); }, verifyQuiescent: async () => {} },
    config: { configVersion: 1, adapter: 'stub', game: 'stubgame', provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } },
    identities: { runtimeInstanceId: '1'.repeat(32), runtimeSessionId: '2'.repeat(32), adapterBindingEpoch: '3'.repeat(32) },
    options: { companionRoot: memory.scope.companionRoot } } as unknown as KernelInput);
  kernel.journal.read = async () => snapshot;
  kernel.carryHash = async () => null;
  kernel.core.publish = async () => { coreCalls++; throw new Error('Unexpected core call.'); };
  return { memory, resources, kernel, snapshot, get coreCalls() { return coreCalls; }, get metadataCalls() { return metadataCalls; },
    changeReply(value: typeof replyChange) { replyChange = value; }, afterObservation(value: typeof afterObserve) { afterObserve = value; } };
}

describe('compact history preventive capacity', () => {
  it('refuses ordinary consumption with 8193 compact identities and two live events before arming or publication', async () => {
    const events = history(8193); const value = fixture(events);
    assert.ok(events.every(event => event.adapter === value.kernel.scope.game && event.principal === value.kernel.scope.principal));
    const inventory = await value.resources.inventory();
    assert.equal(inventory.counts.uncompactedEvents, 2); assert.equal(inventory.potentialHandoffs, 8195);
    const reservation = completeReservation('ordinary', inventory);
    assert.equal(reservation.additions.retainedHandoffs + reservation.remainingControlReserve.retainedHandoffs, 8198);
    const decision = assessCapacity(inventory, reservation);
    assert.deepEqual(decision, { admitted: false, state: 'exhausted', dimensions: ['retainedHandoffs'] });
    let retention = 0;
    const delivery = new DeliveryCoordinator(value.kernel, async () => { retention++; });
    await assert.rejects(value.resources.withTransition('ordinary', () => delivery.acquire({ interactionId: 'capacity', requestReceivedAt: at })),
      error => error instanceof RuntimeCapacityError && error.state === 'exhausted' && error.transition === 'ordinary' && error.dimensions.includes('retainedHandoffs'));
    assert.equal(retention, 1); assert.equal(value.coreCalls, 0); assert.equal(value.memory.writes.length, 0);
    assert.equal((await value.kernel.safety()).pendingCheck, null); assert.equal((await value.kernel.safety()).recoveryWitness, null);
  });

  it('preserves safe header-plan refusal before every modeled write with the actual compact/live inventory', async () => {
    const value = fixture(history(8193));
    const missingHeader: JournalSnapshot = { ...value.snapshot, header: { status: 'absent' }, fault: 'header' };
    value.memory.files.delete('journal/journal.json'); value.kernel.journal.read = async () => missingHeader;
    const recovery = new RecoveryCoordinator(value.kernel);
    await assert.rejects(recovery.plan({ cause: 'header', journal: missingHeader }), error => error instanceof RuntimeCapacityError && error.state === 'exhausted' && error.dimensions.includes('retainedHandoffs'));
    assert.equal(value.memory.writes.length, 0); assert.equal(value.coreCalls, 0);
    assert.equal((await value.kernel.safety()).recoveryWitness, null);
    assert.equal((await value.kernel.operations.list()).records.length, 0);
  });

  it('deduplicates identities retained by older roots when calculating the new plan growth', async () => {
    const events = history(4096); const existing = events.slice(0, 4096).map(event => handoffFor(event)); const value = fixture(events, existing);
    const inventory = await value.resources.inventory();
    assert.equal(inventory.counts.retainedHandoffs, 4096); assert.equal(inventory.potentialHandoffs, 4098);
    const baseline = assessCapacity(inventory, completeReservation('repair', inventory));
    assert.ok(baseline.admitted); assert.equal(baseline.peakCounts.retainedHandoffs, 4100);
    const stop = new Error('Stop after exact reservation; no plan writes are modeled.');
    const reserve = value.resources.reserve.bind(value.resources); const growth: number[] = [];
    value.resources.reserve = async (kind, additions, deadline) => {
      await reserve(kind, additions, deadline);
      if (additions?.retainedHandoffs !== undefined) { growth.push(additions.retainedHandoffs); throw stop; }
    };
    const missingHeader: JournalSnapshot = { ...value.snapshot, header: { status: 'absent' }, fault: 'header' };
    await assert.rejects(new RecoveryCoordinator(value.kernel).plan({ cause: 'header', journal: missingHeader }), error => error === stop);
    assert.deepEqual(growth, [2]); assert.equal(value.memory.writes.length, 0);
  });

  it('counts duplicate retained and candidate pairs once but keeps different source hashes distinct', () => {
    const [event] = history(1, 0); assert.ok(event !== undefined);
    const retained = handoffFor(event);
    assert.equal(additionalHandoffCount([event, event], [retained, retained]), 0);
    const altered = { ...event, recordSha256: '0'.repeat(64) };
    assert.equal(additionalHandoffCount([event, altered, altered], [retained]), 1);
    assert.equal(handoffIdentity(event), event.logicalOutboxId + ':' + event.recordSha256);
    assert.equal(additionalHandoffCount([], [retained]), 0);
  });

  it('retains incoming and recovery headroom at the handoff ceiling', () => {
    const observation = { ...empty, counts: { ...empty.counts, retainedHandoffs: 8188 }, potentialHandoffs: 8189 };
    const admitted = assessCapacity(observation, completeReservation('ordinary', observation));
    assert.ok(admitted.admitted); assert.equal(admitted.peakCounts.retainedHandoffs, 8192);
    const incoming = { ...observation, pendingOutbox: 1 };
    assert.deepEqual(assessCapacity(incoming, completeReservation('ordinary', incoming)), { admitted: false, state: 'exhausted', dimensions: ['retainedHandoffs'] });
  });

  it('keeps release and existing repair finalization separate from ordinary preventive admission', async () => {
    const inventory = { ...empty, counts: { ...empty.counts, uncompactedEvents: 2 }, potentialHandoffs: 8195, activeRepair: true, recoveryEvents: 0 };
    assert.equal(assessCapacity(inventory, completeReservation('ordinary', inventory)).admitted, false);
    assert.equal(assessCapacity(inventory, completeReservation('repair', inventory)).admitted, true);
    assert.equal(completeReservation('repair', inventory).additions.retainedHandoffs, 0);
    assert.equal(completeReservation('release', inventory).additions.retainedHandoffs, 0);
    assert.equal(assessCapacity(inventory, completeReservation('release', inventory)).admitted, true);
    const value = fixture(history(8193));
    const original = value.resources.inventory.bind(value.resources);
    value.resources.inventory = async (...args) => ({ ...await original(...args), activeRepair: true, recoveryEvents: 0 });
    const delivery = new DeliveryCoordinator(value.kernel, async () => {});
    await assert.rejects(value.resources.withTransition('ordinary', () => delivery.acquire({ interactionId: 'finalizing', requestReceivedAt: at })), RuntimeCapacityError);
    assert.equal(value.coreCalls, 0); assert.equal(value.memory.writes.length, 0);
    await value.resources.withTransition('release', () => value.resources.reserve('release'));
    assert.equal(value.resources.capacity.current.release.state, 'admitted'); assert.equal(value.resources.capacity.current.ordinary.state, 'exhausted');
  });

  it('rejects invalid or partial count evidence without classifying it as a measured limit', async () => {
    for (const change of [
      (value: Record<string, unknown>) => ({ ...value, potentialHandoffs: 0.5 }),
      (value: Record<string, unknown>) => ({ ...value, invalidEvents: 1 }),
      (value: Record<string, unknown>) => ({ ...value, retainedHandoffs: 1, potentialHandoffs: 2 }),
      (value: Record<string, unknown>) => ({ ...value, retainedHandoffIdentitySha256: 'not-a-hash' }),
      (value: Record<string, unknown>) => ({ ...value, retainedHandoffIdentitySha256: '0'.repeat(64) }),
      (value: Record<string, unknown>) => ({ ...value, retainedHandoffIdentitySha256: null }),
      (value: Record<string, unknown>) => ({ ...value, retainedHandoffIdentitySha256: '' }),
      (value: Record<string, unknown>) => { const { retainedHandoffIdentitySha256: _, ...missing } = value; return missing; },
      (value: Record<string, unknown>) => { const { potentialHandoffs: _, ...missing } = value; return missing; },
    ]) {
      const value = fixture(history(1)); value.changeReply(change);
      await assert.rejects(value.resources.withTransition('ordinary', () => value.resources.reserve('ordinary')),
        error => error instanceof RuntimeCapacityError && error.state === 'unavailable');
      assert.equal(value.coreCalls, 0); assert.equal(value.memory.writes.length, 0);
    }
    assert.throws(() => completeReservation('ordinary', { ...empty, counts: { ...empty.counts, retainedHandoffs: 2 }, potentialHandoffs: 1 }), RuntimeCapacityError);
  });

  it('revokes stale or expired observations instead of admitting their earlier count', async () => {
    const value = fixture(history(1)); value.afterObservation(() => value.resources.invalidate());
    await assert.rejects(value.resources.withTransition('ordinary', () => value.resources.reserve('ordinary')),
      error => error instanceof RuntimeCapacityError && error.state === 'unavailable');
    value.afterObservation(null);
    const expired = Deadline.fromStart(0, 1, () => 2);
    await assert.rejects(value.resources.withTransition('ordinary', () => value.resources.reserve('ordinary', {}, expired)), RuntimeCapacityError);
    assert.equal(value.memory.writes.length, 0); assert.equal(value.coreCalls, 0);
  });

  it('binds the receipt to its operation and event observation epoch', async () => {
    for (const target of ['operations/jr-' + 'a'.repeat(32) + '.json', 'journal/events/0000000000000001.json']) {
      const value = fixture(history(1)); value.afterObservation(() => value.resources.invalidatePublication(target));
      await assert.rejects(value.resources.withTransition('ordinary', () => value.resources.reserve('ordinary')),
        error => error instanceof RuntimeCapacityError && error.state === 'unavailable' && error.transition === 'ordinary');
      assert.equal(value.resources.capacity.current.ordinary.reason, 'inventory');
      assert.equal(value.coreCalls, 0); assert.equal(value.memory.writes.length, 0);
    }
  });

  it('uses the empty-set hash and ordinal unique identity ordering without persistent authority', () => {
    assert.equal(handoffIdentityDigest([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const values = history(2).map(event => handoffFor(event));
    assert.equal(handoffIdentityDigest(values), handoffIdentityDigest([...values].reverse().concat(values)));
    const expected = bytesHash(Buffer.from(values.map(handoffIdentity).sort().join(String.fromCharCode(10))));
    assert.equal(handoffIdentityDigest(values), expected);
  });

  it('keeps planned multi-write work on its reserved lease and freshly compares the next ordinary assessment', async () => {
    const events = history(1); const value = fixture(events, [handoffFor(events[0]!)]);
    await value.resources.withTransition('ordinary', async () => {
      await value.resources.reserve('ordinary'); const observations = value.metadataCalls;
      const cursorPath = 'journal/cursor-agent-session.json';
      const cursorBytes = value.memory.files.get(cursorPath)!;
      await value.resources.beforeWrite(cursorPath);
      await value.memory.write(cursorPath, parseStrictJson(cursorBytes), 'config', bytesHash(cursorBytes));
      const operation = (await value.kernel.operations.list()).records[0]!;
      const operationPath = 'operations/' + operation.record.operationId + '.json';
      await value.resources.beforeWrite(operationPath);
      await value.memory.write(operationPath, operation.record, 'state-event', operation.sha256);
      assert.equal(value.resources.assertReservation(), 'ordinary');
      await value.resources.workspace(1, 1);
      assert.equal(value.metadataCalls, observations, 'Planned continuation must not reenter inventory from a publication queue.');
      assert.equal(value.resources.capacity.current.ordinary.state, 'admitted');
      value.changeReply(reply => ({ ...reply, retainedHandoffIdentitySha256: '0'.repeat(64) }));
      await assert.rejects(value.resources.reserve('ordinary'), error => error instanceof RuntimeCapacityError && error.state === 'unavailable');
      assert.equal(value.metadataCalls, observations + 1);
      assert.throws(() => value.resources.assertReservation(), RuntimeCapacityError);
    });
    assert.equal(value.memory.writes.length, 2); assert.equal(value.coreCalls, 0);
  });

  it('does not add an ordinary digest comparison to repair, release or maintenance', async () => {
    for (const kind of ['repair', 'release', 'maintenance'] as const) {
      const value = fixture(history(1)); value.changeReply(reply => ({ ...reply, retainedHandoffIdentitySha256: '0'.repeat(64) }));
      await value.resources.withTransition(kind, () => kind === 'maintenance' ? value.resources.reserveMaintenance() : value.resources.reserve(kind));
      assert.equal(value.resources.capacity.current[kind].state, 'admitted');
      value.changeReply(reply => ({ ...reply, retainedHandoffIdentitySha256: null }));
      await assert.rejects(value.resources.withTransition(kind, () => kind === 'maintenance' ? value.resources.reserveMaintenance() : value.resources.reserve(kind)),
        error => error instanceof RuntimeCapacityError && error.state === 'unavailable');
    }
  });

  it('refuses a count-equal retained identity swap across the native and parsed inventories', async () => {
    const events = history(8187); const retained = events.map(event => handoffFor(event)); const value = fixture(events, retained);
    const prior = retained[0]!;
    const replacement: RetainedHandoff = { ...prior, logicalOutboxId: 'f'.repeat(32) + '-99999', recordSha256: '0'.repeat(64), eventId: 'f'.repeat(32),
      acceptance: prior.acceptance === null ? null : { ...prior.acceptance, eventId: 'f'.repeat(32) } };
    value.afterObservation(() => {
      const changed = completedRoot([replacement, ...retained.slice(1)]);
      value.memory.seed('operations/' + changed.operationId + '.json', changed);
    });
    // The observed union is 8189, which would reserve exactly 8192. The later
    // identity set instead needs 8190 plus the same three prospective handoffs.
    assert.equal(additionalHandoffCount(events, [replacement, ...retained.slice(1)]), 1);
    await assert.rejects(value.resources.withTransition('ordinary', () => value.resources.reserve('ordinary')),
      error => error instanceof RuntimeCapacityError && error.state === 'unavailable');
    assert.equal(value.coreCalls, 0); assert.equal(value.memory.writes.length, 0);
  });
});
