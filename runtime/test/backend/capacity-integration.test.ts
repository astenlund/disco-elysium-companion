import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstCapacityRefusal, RuntimeCapacityError, type CapacityTransition } from '../../src/capacity.ts';
import { CoordinatorBackend } from '../../src/backend/index.ts';
import { Kernel, type KernelInput } from '../../src/backend/kernel.ts';
import { RecoveryCoordinator, handoffFor } from '../../src/backend/recovery.ts';
import { ConsumerCoordinator } from '../../src/backend/consumer.ts';
import { DeliveryCoordinator } from '../../src/backend/delivery.ts';
import { ResourceAuthority, type ResourceObservation } from '../../src/resource-lifecycle/resources.ts';
import { refreshCapacityOwed, readOwedOutbox } from '../../src/resource-lifecycle/retention.ts';
import { OperationStore } from '../../src/operations.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { parseSessionBinding } from '../../src/session-records.ts';
import { parseStateSafety, type StateSafety } from '../../src/safety-records.ts';
import type { RepairOperation } from '../../src/operation-records.ts';
import { SentMarkPublicationError } from '../../src/journal.ts';
import { bytesHash, type ScopeStorage } from '../../src/storage.ts';
import type { ContextCandidate, ContextPreparer } from '../../src/prepared-context.ts';
import { PendingStateCheckError } from '../../src/backend/api.ts';
import { MemoryAuthority, journal, repair, at, scope, generation } from './authority-fixtures.ts';
import { journalEvent } from '../support/journal-event.ts';
import { eventFileName } from '../../src/journal-records.ts';

const clean: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null };
const complete: ResourceObservation = { complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 },
  freeBytes: 100000000000n, uncertainWorkspace: false, potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0 };
const refusal = (kind: CapacityTransition, state: 'unavailable' | 'exhausted' = 'unavailable') => new RuntimeCapacityError({ admitted: false, state,
  dimensions: [state === 'unavailable' ? 'workspace' : 'retainedHandoffs'] }, kind);
const binding = parseSessionBinding(parseStrictJson(Buffer.from(stringifyJson({ agentSessionVersion: 1, providerId: 'provider', providerSessionId: 'session',
  createdAt: at, turnsCompleted: 0, needsState: true, instructionsSha256: 'f'.repeat(64), stateGeneration: generation }))));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

// Admitted I/O is an in-memory model. Every persistence write still uses the real
// document parser. Any attempt to launch a native helper throws immediately.
function model() {
  const memory = new MemoryAuthority(); memory.seed('state-safety.json', clean);
  const snapshot = journal();
  if (snapshot.header.status === 'valid') { memory.seed('journal/journal.json', snapshot.header.value); }
  if (snapshot.cursor.status === 'valid') { memory.seed('journal/cursor-agent-session.json', snapshot.cursor.value); }
  const boundaries: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('Pure capacity control reached a native boundary.'); };
  const inspector = { inspect: memory.inspect.bind(memory), metadata: forbidden, idle: async () => {} };
  const resources = new ResourceAuthority(memory.scope, inspector as never, new OperationStore(memory as unknown as ScopeStorage));
  resources.inventory = async () => complete;
  const observation = resources as unknown as { observe: () => Promise<ResourceObservation>; readSafety: () => Promise<StateSafety> };
  observation.observe = async () => complete;
  observation.readSafety = async () => {
    const value = await memory.read('state-safety.json', 'config', raw => parseStateSafety(raw, scope));
    assert.equal(value.status, 'valid'); return value.status === 'valid' ? value.value : clean;
  };
  const write = memory.write.bind(memory);
  memory.write = async (...args) => { await resources.beforeWrite(args[0], args[4]); boundaries.push('write:' + resources.currentSource()?.kind + ':' + args[0]); return write(...args); };
  resources.capacity.admitted('runtimeMarker');
  const kernel = new Kernel({ scope: memory.scope, resources, storage: memory, inspector, publisher: { idle: async () => {} },
    supervisor: { run: forbidden, stop: async (role: string) => { boundaries.push('stop:' + role); }, verifyQuiescent: async (role: string) => { boundaries.push('quiet:' + role); } },
    guard: { held: true, release: async () => { boundaries.push('release'); } },
    config: { configVersion: 1, adapter: 'stub', game: 'stubgame', provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } },
    identities: { runtimeInstanceId: '5'.repeat(32), runtimeSessionId: '6'.repeat(32), adapterBindingEpoch: '7'.repeat(32) },
    options: { companionRoot: memory.scope.companionRoot } } as unknown as KernelInput);
  kernel.journal.read = async () => snapshot;
  kernel.carryHash = async () => null;
  kernel.outbox.list = async () => [];
  kernel.outbox.read = forbidden;
  kernel.journal.idle = async () => {};
  kernel.core.idle = async () => {};
  const runtime = { runtimeInstanceId: kernel.identities.runtimeInstanceId, startedAt: at, cleanShutdown: false, watcher: null };
  memory.seed('runtime.json', runtime);
  const backend = new CoordinatorBackend(kernel, { value: runtime, sha256: bytesHash(memory.files.get('runtime.json')!) });
  return { memory, resources, kernel, backend, snapshot, boundaries };
}

describe('source-bound capacity ownership', () => {
  it('keeps a queued helper on its own reservation while a marker succeeds', async () => {
    const value = model(); const gate = deferred(); const started = deferred();
    const repairSource = value.resources.createSource('repair');
    let task!: () => Promise<void>;
    await value.resources.withSource(repairSource, async () => {
      await value.resources.reserve('repair');
      task = value.resources.bind(async () => { started.resolve(); await gate.promise; await value.resources.workspace(Number.MAX_SAFE_INTEGER, 0); });
    });
    const pending = task(); const observed = pending.catch(error => error as unknown); await started.promise;
    await value.resources.withTransition('runtimeMarker', () => value.resources.reserveRuntimeMarker());
    gate.resolve(); const error = await observed;
    assert.ok(error instanceof RuntimeCapacityError); assert.equal(error.transition, 'repair');
    assert.equal(value.resources.capacity.current.runtimeMarker.state, 'admitted'); assert.equal(value.resources.capacity.current.repair.state, 'unavailable');
  });

  it('treats an invalidated queued owner as unknown instead of borrowing a new source', async () => {
    const value = model(); let task!: () => Promise<void>;
    await value.resources.withTransition('repair', async () => { await value.resources.reserve('repair'); task = value.resources.bind(() => value.resources.workspace(0, 0)); });
    value.resources.invalidate();
    await value.resources.withTransition('runtimeMarker', () => value.resources.reserveRuntimeMarker());
    await assert.rejects(task(), error => error instanceof RuntimeCapacityError && error.transition === null);
    assert.equal(value.resources.capacity.current.runtimeMarker.reason, 'otherAuthority');
  });

  it('does not clear a prior ordinary refusal when a mandatory new-session binding succeeds', async () => {
    const value = model(); value.resources.reportFailure(refusal('ordinary', 'exhausted'));
    const result = await value.kernel.sessions.bind(binding, { verify: async () => true });
    assert.equal(result.binding.providerSessionId, binding.providerSessionId);
    assert.equal(value.resources.capacity.current.ordinary.state, 'exhausted');
    assert.deepEqual(value.boundaries.filter(item => item.startsWith('write:')), ['write:ordinary:agent-session.json', 'write:ordinary:agent-session-index.json']);
    assert.equal((await value.kernel.sessions.ready({ verify: async () => true }))?.bindingSha256, result.bindingSha256);
  });

  it('keeps inherited repair session publications on repair rather than a new ordinary control owner', async () => {
    const value = model();
    await value.resources.withTransition('repair', async () => { await value.resources.reserve('repair'); await value.kernel.sessions.bind(binding, { verify: async () => true }); });
    assert.ok(value.boundaries.filter(item => item.startsWith('write:')).every(item => item.startsWith('write:repair:')));
    assert.equal(value.resources.capacity.current.ordinary.state, 'unchecked');
  });

  it('serializes watcher marker publication behind backend work without replacing its reservation', async () => {
    const value = model(); const gate = deferred(); const started = deferred();
    const internal = value.backend as unknown as { enqueue<T>(action: () => Promise<T>): Promise<T>; watcher: { options: { persistWatcher(value: null): Promise<void> } } };
    const active = internal.enqueue(async () => { started.resolve(); await gate.promise; }); await started.promise;
    const marker = internal.watcher.options.persistWatcher(null);
    await Promise.resolve(); assert.equal(value.boundaries.some(item => item.endsWith(':runtime.json')), false);
    gate.resolve(); await active; await marker;
    assert.ok(value.boundaries.includes('write:runtimeMarker:runtime.json'));
  });

  it('takes a fresh marker reservation at shutdown and verifies the resulting helpers before release', async () => {
    const value = model(); value.resources.reportFailure(refusal('ordinary'));
    await value.backend.shutdown(true);
    const write = value.boundaries.indexOf('write:runtimeMarker:runtime.json');
    assert.ok(write >= 0);
    assert.ok(value.boundaries.lastIndexOf('quiet:metadata') > write && value.boundaries.lastIndexOf('quiet:publication') > write);
    assert.equal(value.boundaries.at(-1), 'release'); assert.equal(value.resources.capacity.current.ordinary.state, 'unavailable');
  });
});

describe('capacity phase-E selection and command result', () => {
  for (const phase of ['cleanup', 'releaseReservation'] as const) {
    it('returns an incomplete available startup after ' + phase + ' refusal without entering dependent work', async () => {
      const value = model(); let dependent = 0;
      const internal = value.backend as unknown as { cleanup(): Promise<void>; initializeStorage(): Promise<void>; retention(): Promise<void>; recovery: RecoveryCoordinator; consumer: ConsumerCoordinator };
      internal.cleanup = async () => { if (phase === 'cleanup') { throw new Error('Cleanup authority is unavailable.'); } };
      internal.initializeStorage = async () => { dependent++; };
      internal.recovery.startup = async () => { dependent++; }; internal.consumer.startup = async () => { dependent++; return null; };
      internal.retention = async () => { throw refusal('maintenance'); };
      if (phase === 'releaseReservation') { value.resources.inventory = async () => { throw new Error('Release inventory is unavailable.'); }; }
      const result = await value.backend.startup({ kind: 'chat' });
      assert.equal(result.requiredWorkCompleted, false); assert.equal(result.notOwner, false); assert.equal(dependent, 0);
      assert.equal(value.backend.status.freshness.reason, 'capacityUnavailable'); assert.equal(value.backend.status.journal.fault, null);
      assert.equal(value.memory.writes.length, 0);
      await assert.rejects(value.backend.acquire({ interactionId: 'later', requestReceivedAt: at }), RuntimeCapacityError);
    });
  }
  it('does not add a phase-E capacity pass to chat startup', async () => {
    const value = model(); let retention = 0; let capacityCallbacks = 0;
    const internal = value.backend as unknown as { cleanup(): Promise<void>; initializeStorage(): Promise<void>; retention(): Promise<void>; recovery: RecoveryCoordinator; consumer: ConsumerCoordinator; delivery: DeliveryCoordinator };
    internal.cleanup = async () => {}; internal.initializeStorage = async () => {};
    internal.retention = async () => { retention++; }; internal.consumer.startup = async () => null;
    internal.recovery.startup = async (_resume, checkpoint) => { if (checkpoint !== undefined) { capacityCallbacks++; } };
    internal.delivery.acquire = async () => ({ interaction: { interactionId: 'startup', requestReceivedAt: at }, generation, disclosureOnly: true,
      freshness: value.kernel.status.freshness, relevanceFingerprint: 'a'.repeat(64) });
    value.kernel.drain = async () => value.snapshot;
    const result = await value.backend.startup({ kind: 'chat' });
    assert.equal(capacityCallbacks, 0); assert.equal(retention, 1); assert.equal(result.requiredWorkCompleted, true); assert.equal(result.capacityRewind, null);
  });
  it('runs repair retention before fresh ordinary assessment and starts no root on admission', async () => {
    const value = model(); const recovery = new RecoveryCoordinator(value.kernel); const calls: string[] = [];
    const reserve = value.resources.reserve.bind(value.resources);
    value.resources.reserve = async (...args) => { calls.push(args[0]); await reserve(...args); };
    recovery.plan = async () => assert.fail('Admitted ordinary work selected a repair.');
    await value.resources.withTransition('repair', () => recovery.capacityCheckpoint(async () => { calls.push('retention'); }));
    assert.deepEqual(calls, ['retention', 'ordinary']);
  });

  for (const failure of ['retention', 'unavailable', 'plan'] as const) {
    it('refuses before a new root when ' + failure + ' cannot be admitted', async () => {
      const value = model(); const recovery = new RecoveryCoordinator(value.kernel); let planned = 0; let resumed = 0;
      const reserve = value.resources.reserve.bind(value.resources);
      value.resources.reserve = async (...args) => { if (args[0] === 'ordinary') { throw refusal('ordinary', failure === 'unavailable' ? 'unavailable' : 'exhausted'); } await reserve(...args); };
      recovery.plan = async () => { planned++; throw refusal('repair', 'exhausted'); };
      recovery.resume = async () => { resumed++; };
      await assert.rejects(value.resources.withTransition('repair', () => recovery.capacityCheckpoint(async () => { if (failure === 'retention') { throw refusal('maintenance'); } })), RuntimeCapacityError);
      assert.equal(planned, failure === 'plan' ? 1 : 0); assert.equal(resumed, 0); assert.equal(value.memory.writes.length, 0);
    });
  }

  it('selects one capacity plan from fresh exhaustion and resumes that exact identifier', async () => {
    const value = model(); const recovery = new RecoveryCoordinator(value.kernel); const selected = repair({ cause: 'capacity' }); const calls: string[] = [];
    value.resources.reserve = async kind => { if (kind === 'ordinary') { throw refusal('ordinary', 'exhausted'); } };
    recovery.plan = async request => { calls.push(request.cause); return { record: selected, sha256: 'f'.repeat(64) }; };
    recovery.resume = async id => { calls.push(id); };
    await value.resources.withTransition('repair', () => recovery.capacityCheckpoint(async () => {}));
    assert.deepEqual(calls, ['capacity', selected.operationId]);
  });

  for (const priority of ['active', 'header', 'cursor', 'operationLost', 'gap', 'historical'] as const) {
    it('does not enter the capacity checkpoint when ' + priority + ' recovery wins', async () => {
      const value = model(); const recovery = new RecoveryCoordinator(value.kernel); const root = repair(); let checkpoint = 0;
      recovery.reconcileSafety = async () => {};
      recovery.resume = async () => {};
      recovery.plan = async () => ({ record: root, sha256: 'f'.repeat(64) });
      if (priority === 'active') { value.memory.seed('operations/' + root.operationId + '.json', root); }
      if (priority === 'header' || priority === 'cursor' || priority === 'gap') { value.kernel.journal.read = async () => ({ ...value.snapshot, fault: priority }); }
      if (priority === 'operationLost') { value.memory.files.set('operations/jr-' + 'f'.repeat(32) + '.json', Buffer.from('{')); }
      if (priority === 'historical') {
        const accepted = { journalId: 'journal', eventId: '8'.repeat(32), sequence: 1, generation, acceptedAt: at };
        const historical = repair({ completedAt: at, outcome: 'completed', plan: { ...root.plan, correctionId: null,
          rejectedRecord: { name: 'event-0000000000000001.json', sha256: 'e'.repeat(64) }, publishedVersions: { schemaVersion: 2, adapterVersion: 1 } }, recovery: {
          attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: '9'.repeat(32) + '-1', recordSha256: 'e'.repeat(64) },
            journalEvent: { journalId: 'journal', eventId: accepted.eventId, sequence: 1 } }],
          episodes: [{ ...root.recovery.episodes[0]!, phase: 'completed', acceptedRecovery: accepted, endedAt: at }], activeEpisode: null } });
        value.memory.seed('operations/' + historical.operationId + '.json', historical);
        value.kernel.outbox.list = async () => ['event-0000000000000001.json'];
      }
      await recovery.startup(undefined, async () => { checkpoint++; });
      assert.equal(checkpoint, 0);
    });
  }

  it('leaves repair incomplete after a successful rewind when required ordinary admission still refuses', async () => {
    const value = model(); const internal = value.backend as unknown as {
      cleanup(): Promise<void>; initializeStorage(): Promise<void>; retention(): Promise<void>;
      recovery: RecoveryCoordinator; consumer: ConsumerCoordinator;
    };
    internal.cleanup = async () => {}; internal.initializeStorage = async () => {};
    internal.consumer.startup = async () => null; internal.recovery.startup = async () => {};
    internal.recovery.capacityResult = async () => null; internal.retention = async () => { throw refusal('ordinary', 'exhausted'); };
    value.kernel.drain = async () => value.snapshot;
    const result = await value.backend.startup({ kind: 'repair' });
    assert.equal(result.requiredWorkCompleted, false);
  });

  it('keeps unrelated status faults separate from completed required repair work', async () => {
    const value = model(); const internal = value.backend as unknown as { cleanup(): Promise<void>; initializeStorage(): Promise<void>; retention(): Promise<void>; recovery: RecoveryCoordinator; consumer: ConsumerCoordinator };
    internal.cleanup = async () => {}; internal.initializeStorage = async () => {}; internal.retention = async () => {};
    internal.consumer.startup = async () => null; internal.recovery.startup = async () => {}; internal.recovery.capacityResult = async () => null;
    value.kernel.drain = async () => value.snapshot;
    value.kernel.emit({ journal: { state: 'fault', fault: 'foreignRecord', unacknowledgedEvents: 0 } });
    const result = await value.backend.startup({ kind: 'repair' });
    assert.equal(result.requiredWorkCompleted, true); assert.equal(value.backend.status.journal.fault, 'foreignRecord');
  });

  for (const unknown of ['extent', 'sources', 'none'] as const) {
    it('requires complete selected report evidence when unknown fields are ' + unknown, async () => {
      const value = model(); const internal = value.backend as unknown as { cleanup(): Promise<void>; initializeStorage(): Promise<void>; retention(): Promise<void>; recovery: RecoveryCoordinator; consumer: ConsumerCoordinator };
      internal.cleanup = async () => {}; internal.initializeStorage = async () => {}; internal.retention = async () => {};
      internal.consumer.startup = async () => null; internal.recovery.startup = async () => {};
      internal.recovery.capacityResult = async () => ({ affectedEvents: unknown === 'extent' ? null : 0, fromSequence: null, throughSequence: null,
        retainedHandoffs: 0, replayableHandoffs: 0, presentationRetiredHandoffs: 0, survivingCoreRecords: unknown === 'sources' ? null : 0 });
      value.kernel.drain = async () => value.snapshot;
      const result = await value.backend.startup({ kind: 'repair' });
      assert.equal(result.requiredWorkCompleted, unknown === 'none');
      assert.equal(result.capacityRewind?.affectedEvents, unknown === 'extent' ? null : 0);
    });
  }

  it('keeps an explicit successful consumer receipt authoritative beside an ordinary refusal', async () => {
    const value = model(); const consumer = new ConsumerCoordinator(value.kernel);
    consumer.pending = async () => false;
    consumer.switch = async () => ({ success: true, value: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: true, abandonedCount: 0 }, warnings: [] });
    value.resources.reportFailure(refusal('ordinary', 'exhausted'));
    const result = await consumer.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true });
    assert.equal(result?.requiredWorkCompleted, true); assert.equal(result?.consumerResult?.success, true);
    assert.equal(value.resources.capacity.current.ordinary.state, 'exhausted');
  });

  it('does not let an opaque consumer intent waive a typed safety publication capacity refusal', async () => {
    const value = model(); let calls = 0;
    value.kernel.safetyStore.armCheck = async () => { throw refusal('release'); };
    await assert.rejects(value.resources.withTransition('release', async () => {
      await value.resources.reserve('release');
      return value.kernel.checked({ kind: 'consumer', owner: 'bridge', mode: 'abandon' }, async () => { calls++; return {} as never; }, async () => {}, undefined, 'rl-' + 'f'.repeat(32));
    }), RuntimeCapacityError);
    assert.equal(calls, 0);
  });

  it('withholds ordinary settlement before arming safety when any slot still refuses', async () => {
    const value = model(); let calls = 0;
    await value.resources.withTransition('ordinary', async () => {
      await value.resources.reserve('ordinary'); value.resources.reportFailure(refusal('runtimeMarker'));
      await assert.rejects(value.kernel.checked({ kind: 'settlement', binding: { logicalOutboxId: 'd'.repeat(32) + '-1', recordSha256: 'e'.repeat(64), journalId: 'journal', eventId: 'event' } },
        async () => { calls++; return {} as never; }, async () => {}), RuntimeCapacityError);
    });
    assert.equal(calls, 0); assert.equal(value.memory.writes.includes('state-safety.json'), false);
  });
});

describe('capacity rewind result evidence', () => {
  function capacityRecord(): RepairOperation {
    const base = repair({ cause: 'capacity' });
    const events = [1, 5, 6].map(sequence => journalEvent(sequence));
    const old = journal(6, 4); assert.equal(old.header.status, 'valid'); assert.equal(old.cursor.status, 'valid');
    if (old.header.status !== 'valid' || old.cursor.status !== 'valid') { throw new Error('Invalid journal fixture.'); }
    const cursor = { ...old.cursor.value, lastSentSequence: 4 };
    const header = { ...old.header.value, highWaterSequence: 4 };
    const actions = [5, 6].map(sequence => ({ kind: 'quarantine' as const, source: { path: 'journal/events/' + eventFileName(sequence), before: String(sequence).repeat(64), after: null },
      target: { path: 'quarantine/' + eventFileName(sequence) + '.' + 'f'.repeat(32) + '.quarantined', before: null, after: String(sequence).repeat(64) } }));
    return repair({ cause: 'capacity', plan: { ...base.plan, lastGoodSequence: 4, affected: events.map(event => ({ sequence: event.sequence, eventId: event.eventId, fileSha256: String(event.sequence).repeat(64) })),
      handoffs: events.map(event => handoffFor(event, event.sequence === 6 ? 'unverified' : 'replayable')) },
      recovery: { ...base.recovery, episodes: [{ ...base.recovery.episodes[0]!, prerequisite: { kind: 'rewind', nextAction: 0, carry: null, skippedRanges: [], actions: [...actions,
        { kind: 'publishCursor', target: { path: 'journal/cursor-agent-session.json', before: old.cursor.sha256, after: bytesHash(Buffer.from(stringifyJson(cursor))) }, value: cursor },
        { kind: 'raiseHighWater', target: { path: 'journal/journal.json', before: old.header.sha256, after: bytesHash(Buffer.from(stringifyJson(header))) }, value: header }] } }] } });
  }

  it('reports affected actions separately from other retained plan handoffs', async () => {
    const value = model(); const recovery = new RecoveryCoordinator(value.kernel); const record = capacityRecord();
    value.memory.seed('operations/' + record.operationId + '.json', record);
    const state = recovery as unknown as { selectedCapacityRoot: string; capacitySource: ReturnType<ResourceAuthority['createSource']> };
    state.selectedCapacityRoot = record.operationId; state.capacitySource = value.resources.createSource('repair');
    await value.resources.withSource(state.capacitySource, () => value.resources.reserve('repair'));
    const result = await recovery.capacityResult();
    assert.deepEqual(result, { affectedEvents: 2, fromSequence: 5, throughSequence: 6, retainedHandoffs: 3, replayableHandoffs: 2, presentationRetiredHandoffs: 1, survivingCoreRecords: 0 });
  });

  for (const damage of ['absent', 'invalid', 'unreadable', 'contradictoryPreimage'] as const) {
    it('reports unknown extent when the selected durable plan is ' + damage, async () => {
      const value = model(); const recovery = new RecoveryCoordinator(value.kernel); let record = capacityRecord();
      (recovery as unknown as { selectedCapacityRoot: string }).selectedCapacityRoot = record.operationId;
      const name = 'operations/' + record.operationId + '.json';
      if (damage === 'contradictoryPreimage') { record = repair({ ...record, plan: { ...record.plan, affected: record.plan.affected.map(event => ({ ...event, fileSha256: 'c'.repeat(64) })) } }); }
      if (damage !== 'absent') { value.memory.seed(name, record); }
      if (damage === 'invalid') { value.memory.files.set(name, Buffer.from('{')); }
      if (damage === 'unreadable') { value.memory.unreadable.add(name); }
      const result = await recovery.capacityResult(); assert.ok(result !== null); assert.ok(Object.values(result).every(value => value === null));
    });
  }
});

async function preparedModel() {
  const value = model(); const coordinator = new DeliveryCoordinator(value.kernel, async () => {});
  const event = journalEvent(1, { adapter: 'stubgame', acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation } });
  const source = { metadata: event, sha256: '4'.repeat(64) };
  const snapshot = { interaction: { interactionId: 'interaction', requestReceivedAt: at }, generation, disclosureOnly: false,
    freshness: { state: 'fresh' as const, class: null, reason: null, lastGoodGeneratedAt: at, checkedAt: at }, relevanceFingerprint: 'f'.repeat(64) };
  const retained = { public: snapshot, events: [source], state: source, journalId: 'journal', cursor: 0, sent: 0,
    safetySha256: bytesHash(value.memory.files.get('state-safety.json')!), correction: null };
  const cache = coordinator as unknown as { snapshots: WeakMap<object, unknown>; currentSnapshot: unknown; preparer: ContextPreparer };
  cache.snapshots.set(snapshot, retained); cache.currentSnapshot = retained;
  value.kernel.journal.read = async () => ({ ...journal(1), events: new Map([[1, source]]) });
  value.memory.seed('agent-session.json', binding);
  value.memory.seed('agent-session-index.json', { agentSessionIndexVersion: 1, sessions: [{ ...binding, lastBoundAt: at }] });
  const text = '<companion-turn-context>opaque-fixture</companion-turn-context>';
  const redeliveryText = '<companion-turn-context>opaque-redelivery-fixture</companion-turn-context>';
  const candidate: ContextCandidate = { shape: 1, bytes: Buffer.byteLength(text), sha256: bytesHash(Buffer.from(text)), fingerprint: 'e'.repeat(64), eventCount: 1, stateIncluded: true, degraded: null };
  const redeliveryCandidate = { ...candidate, bytes: Buffer.byteLength(redeliveryText), sha256: bytesHash(Buffer.from(redeliveryText)) };
  cache.preparer.preview = async () => ({ candidates: [candidate] });
  cache.preparer.prepare = async () => ({ candidate, cleanupComplete: true });
  cache.preparer.copyVariantsForSend = async () => ({ text, redeliveryText, redeliveryCandidate });
  cache.preparer.copyForSend = async () => text;
  cache.preparer.discard = async () => {};
  const preview = await coordinator.preview(snapshot, binding, null);
  const handle = await coordinator.prepare(snapshot, preview, candidate);
  return { ...value, coordinator, handle, redeliveryText, provider: { providerId: binding.providerId, providerSessionId: binding.providerSessionId, isCurrent: () => true } };
}

describe('optional sent-mark and mandatory send boundaries', () => {
  for (const state of ['unavailable', 'exhausted'] as const) {
    it('records ' + state + ' optional refusal, permits one exact fallback, then blocks new work', async () => {
      const value = await preparedModel();
      value.kernel.journal.markSent = async () => { throw new SentMarkPublicationError(refusal('ordinary', state)); };
      assert.equal(await value.coordinator.markSent(value.handle), false);
      assert.equal(value.resources.capacity.current.ordinary.state, state); assert.equal(value.kernel.sentMark, 1);
      const sent = await value.coordinator.copyForSend(value.handle, binding, value.provider);
      assert.equal(sent.text, value.redeliveryText); assert.equal(sent.redelivery, true);
      await assert.rejects(value.coordinator.copyForSend(value.handle, binding, value.provider));
      await assert.rejects(value.coordinator.acquire({ interactionId: 'later', requestReceivedAt: at }), RuntimeCapacityError);
      value.kernel.journal.acknowledge = async () => { throw refusal('ordinary'); };
      await assert.rejects(value.coordinator.acknowledge(value.handle, binding, value.provider, { compactionCapability: true, compactedDuringTurn: false }), RuntimeCapacityError);
      const current = await value.kernel.sessions.readBinding(); assert.equal(current.status === 'valid' ? current.value.turnsCompleted : null, 0);
    });
  }

  it('keeps ordinary I/O sent-mark failure outside the capacity refusal set', async () => {
    const value = await preparedModel(); value.kernel.journal.markSent = async () => { throw new SentMarkPublicationError(new Error('Sharing violation.')); };
    assert.equal(await value.coordinator.markSent(value.handle), false);
    assert.equal(firstCapacityRefusal(value.resources.capacity.current), null);
    assert.equal((await value.coordinator.copyForSend(value.handle, binding, value.provider)).text, value.redeliveryText);
  });

  for (const loss of ['guard', 'generation', 'provider', 'binding', 'independentCapacity'] as const) {
    it('forbids the optional fallback after ' + loss + ' authority changes', async () => {
      const value = await preparedModel(); value.kernel.journal.markSent = async () => { throw new SentMarkPublicationError(refusal('ordinary')); };
      await value.coordinator.markSent(value.handle);
      if (loss === 'guard') { (value.kernel.guard as unknown as { held: boolean }).held = false; }
      if (loss === 'generation') { value.memory.seed('state-safety.json', { ...clean, generation: 'f'.repeat(32) }); }
      if (loss === 'provider') { value.provider.isCurrent = () => false; }
      if (loss === 'binding') { value.memory.seed('agent-session.json', { ...binding, needsState: false }); }
      if (loss === 'independentCapacity') { value.resources.reportFailure(refusal('runtimeMarker')); }
      await assert.rejects(value.coordinator.copyForSend(value.handle, binding, value.provider));
    });
  }

  it('does not turn mandatory sent-prefix admission failure into the optional exception', async () => {
    const value = await preparedModel(); value.kernel.journal.markSent = async () => { throw refusal('ordinary'); };
    await assert.rejects(value.coordinator.markSent(value.handle), RuntimeCapacityError);
  });

  it('keeps a validated pending check stronger after a public capacity refusal', async () => {
    const value = model();
    value.memory.seed('state-safety.json', { ...clean, pendingCheck: 'f'.repeat(32) });
    value.resources.reportFailure(refusal('ordinary'));
    await assert.rejects(value.backend.acquire({ interactionId: 'blocked', requestReceivedAt: at }), PendingStateCheckError);
    assert.equal(value.backend.status.stateSafety.state, 'recovering'); assert.equal(value.backend.status.stateSafety.correction, null);
    assert.equal(value.backend.status.capacity.ordinary.state, 'unavailable');
  });
});

describe('owed observation authority', () => {
  it('does not substitute a zero addition forecast for a present exact outbox record', async () => {
    const value = model();
    await value.resources.withTransition('repair', () => value.resources.reserve('repair'));
    assert.equal(value.resources.capacity.current.owed.pendingOutboxRecords, null);
    const source = { status: 'valid', sha256: 'e'.repeat(64), metadata: { logicalOutboxId: 'd'.repeat(32) + '-1' } } as const;
    value.kernel.outbox.list = async () => ['event-0000000000000001.json'];
    value.kernel.outbox.read = async () => source as never;
    const evidence = await readOwedOutbox(value.kernel.outbox);
    assert.equal(evidence.names.length, 1); assert.equal(complete.pendingOutbox, 0);
    await refreshCapacityOwed(value.kernel);
    assert.equal(value.resources.capacity.current.owed.pendingOutboxRecords, 1);
  });

  it('keeps independently read counts while a failed outbox component becomes unknown', async () => {
    const value = model(); value.resources.capacity.observeOwed({ pendingOutboxRecords: 8 });
    value.kernel.outbox.list = async () => { throw new Error('Unreadable outbox.'); };
    await refreshCapacityOwed(value.kernel);
    assert.equal(value.resources.capacity.current.owed.pendingOutboxRecords, null);
    assert.equal(value.resources.capacity.current.owed.unfinishedOperations, 0);
    assert.equal(value.resources.capacity.current.owed.unacknowledgedEvents, 0);
    assert.equal(value.resources.capacity.current.owed.protectedHandoffs, null);
  });

  it('rejects a changed listing and invalid sources instead of manufacturing zero', async () => {
    const value = model(); let reads = 0;
    value.kernel.outbox.list = async () => ++reads === 1 ? [] : ['event-0000000000000001.json'];
    await assert.rejects(readOwedOutbox(value.kernel.outbox));
    value.kernel.outbox.list = async () => ['event-0000000000000001.json'];
    value.kernel.outbox.read = async () => ({ status: 'invalid' }) as never;
    await assert.rejects(readOwedOutbox(value.kernel.outbox));
  });

  it('invalidates only corresponding components before a mandatory metadata write', async () => {
    const value = model(); value.resources.capacity.observeOwed({ unacknowledgedEvents: 2, pendingOutboxRecords: 3, unfinishedOperations: 1, protectedHandoffs: 4, safetyObligation: true, historyDisclosure: true });
    value.resources.invalidatePublication('agent-session.json');
    assert.deepEqual(value.resources.capacity.current.owed, { unacknowledgedEvents: 2, pendingOutboxRecords: 3, unfinishedOperations: 1, protectedHandoffs: null, safetyObligation: null, historyDisclosure: null });
    value.resources.invalidatePublication('runtime.json');
    assert.equal(value.resources.capacity.current.owed.pendingOutboxRecords, 3);
    value.resources.invalidate(); assert.equal(value.resources.capacity.current.owed.unacknowledgedEvents, null);
  });
});
