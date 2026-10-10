import assert from 'node:assert/strict';
import test from 'node:test';

import { RecoveryCoordinator, handoffFor } from '../../src/backend/recovery.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import type { CoreResult, PublishReceipt } from '../../src/core-client.ts';
import { eventRewriteMetadata, parseJournalCursor, parseJournalHeader } from '../../src/journal-records.ts';
import type { JournalSnapshot } from '../../src/journal.ts';
import { stringifyJson } from '../../src/json.ts';
import { coreAttemptToken, type RepairOperation } from '../../src/operation-records.ts';
import type { OutboxRead } from '../../src/outbox.ts';
import type { RecoveryOwner, StateSafety } from '../../src/safety-records.ts';
import { activeRecoveryOwner, bindRecoveryEvent, checkpointRecovery, completeRecovery, replayCandidate, selectRecoveryRecord } from '../../src/recovery-progress.ts';
import type { RecoveryAction } from '../../src/recovery-manifest.ts';
import { bytesHash } from '../../src/storage.ts';
import { journalEvent } from '../support/journal-event.ts';
import { at, authorityModel, correctionId, generation, journal, owner, repair, witness } from './authority-fixtures.ts';

function memoryFileHash(model: ReturnType<typeof authorityModel>) {
  return async (relative: string) => {
    const bytes = model.memory.files.get(relative);
    return bytes === undefined ? null : bytesHash(bytes);
  };
}

function completedAtFloor(floor = 3) {
  const oldEvent = journalEvent(4, { adapter: 'stubgame', type: 'state.resync', coreRepairOperationId: coreAttemptToken(owner.operationId, 0),
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 }, acceptance: { journalId: 'journal', eventId: '4'.padStart(32, '0'), generation } });
  const base = repair();
  let record = repair({ plan: { ...base.plan, lastGoodSequence: floor, publishedVersions: { schemaVersion: 2, adapterVersion: 1 } } });
  record = selectRecoveryRecord(record, { logicalOutboxId: oldEvent.logicalOutboxId, recordSha256: oldEvent.recordSha256 }, 'observed', null);
  record = bindRecoveryEvent(record, oldEvent);
  record = completeRecovery(checkpointRecovery(record, oldEvent, generation, floor + 1, at), 'journal', generation, at);
  return { oldEvent, record };
}

function completedReplayModel(retainOldHandoff = false, floor = 3) {
  const { oldEvent, record } = completedAtFloor(floor);
  const baseline = journal();
  assert.ok(baseline.header.status === 'valid' && baseline.cursor.status === 'valid');
  if (baseline.header.status !== 'valid' || baseline.cursor.status !== 'valid') { throw new Error('Expected valid fixture controls.'); }
  const journalId = '9'.repeat(32);
  const snapshot = { ...baseline,
    header: { ...baseline.header, value: { ...baseline.header.value, journalId } },
    cursor: { ...baseline.cursor, value: { ...baseline.cursor.value, journalId } },
    events: new Map<number, { metadata: typeof oldEvent; sha256: string }>() };
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }, snapshot);
  const retained = retainOldHandoff ? repair({ ...record, plan: { ...record.plan, handoffs: [handoffFor(oldEvent)] } }) : record;
  model.memory.seed(`operations/${owner.operationId}.json`, retained);
  return { model, oldEvent, snapshot, journalId };
}

function completedOrdinaryCarryModel() {
  const { oldEvent, record } = completedAtFloor(0);
  const oldVersion = journalEvent(4, { ...oldEvent, schemaVersion: 1 });
  const restored = journalEvent(1, { ...oldVersion, sequence: 1 });
  const snapshot = { ...journal(1, 0), events: new Map([[1, { metadata: restored, sha256: 'f'.repeat(64) }]]) };
  assert.equal(snapshot.header.status, 'valid');
  if (snapshot.header.status !== 'valid') { throw new Error('Expected a completed restoration header.'); }
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId },
    recoveryWitness: { ...witness, owner: { operationId: owner.operationId, episodeOrdinal: 1, activationId: '3'.repeat(32) } } }, snapshot);
  model.memory.seed('journal/events/0000000000000001.json', restored);
  const eventHash = bytesHash(model.memory.files.get('journal/events/0000000000000001.json')!);
  snapshot.events.set(1, { metadata: restored, sha256: eventHash });
  const active = replayCandidate(record, '3'.repeat(32), at);
  const carryHash = '7'.repeat(64);
  const prerequisite = { kind: 'rewind' as const, nextAction: 4, carry: { path: 'journal/recovery-event.json' as const, sha256: carryHash }, carryRelease: null,
    skippedRanges: [], actions: [
      { kind: 'preserveRecovery' as const, source: { root: 'scope' as const, path: 'journal/events/0000000000000004.json',
        sha256: '8'.repeat(64), payloadBindingSha256: oldVersion.payloadBindingSha256 },
        target: { path: 'journal/recovery-event.json', before: null, after: carryHash }, metadata: eventRewriteMetadata(oldVersion) },
      { kind: 'appendRecovery' as const, source: { root: 'scope' as const, path: 'journal/recovery-event.json', sha256: carryHash,
        payloadBindingSha256: oldVersion.payloadBindingSha256 },
        target: { path: 'journal/events/0000000000000001.json', before: null, after: eventHash }, metadata: eventRewriteMetadata(restored) },
      { kind: 'raiseHighWater' as const, target: { path: 'journal/journal.json', before: 'd'.repeat(64),
        after: bytesHash(model.memory.files.get('journal/journal.json')!) }, value: snapshot.header.value },
      { kind: 'removeCarry' as const, target: { path: 'journal/recovery-event.json', before: carryHash, after: null } },
    ] };
  model.memory.seed(`operations/${owner.operationId}.json`, { ...active, plan: { ...active.plan, handoffs: [handoffFor(oldVersion)] }, recovery: { ...active.recovery,
    episodes: active.recovery.episodes.map((episode, index) => index === active.recovery.activeEpisode ? { ...episode, prerequisite } : episode) } });
  model.kernel.outbox.read = async name => ({ status: 'absent', name });
  model.kernel.carryHash = async () => null;
  return { model, oldVersion, restored, prerequisite };
}

function nonTailVersionReplayModel() {
  const { oldEvent, record } = completedAtFloor();
  const oldVersion = journalEvent(4, { ...oldEvent, schemaVersion: 1 });
  const later = journalEvent(5, { adapter: 'stubgame', logicalOutboxId: `${'b'.repeat(32)}-5`, recordSha256: 'c'.repeat(64),
    acceptance: { journalId: 'journal', eventId: '5'.padStart(32, '0'), generation } });
  const events = new Map([[4, { metadata: oldVersion, sha256: 'f'.repeat(64) }], [5, { metadata: later, sha256: 'e'.repeat(64) }]]);
  const snapshot = { ...journal(5, 3), events };
  const active = replayCandidate(record, '3'.repeat(32), at);
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId },
    recoveryWitness: { ...witness, owner: { operationId: owner.operationId, episodeOrdinal: 1, activationId: '3'.repeat(32) } } }, snapshot);
  model.memory.seed(`operations/${owner.operationId}.json`, active);
  for (const [sequence, event] of events) {
    const name = `journal/events/${String(sequence).padStart(16, '0')}.json`;
    model.memory.seed(name, event.metadata);
    events.set(sequence, { metadata: event.metadata, sha256: bytesHash(model.memory.files.get(name)!) });
  }
  model.kernel.carryHash = async () => null;
  return { model, oldEvent, later, events };
}

function memoryRewindExecutor(model: ReturnType<typeof authorityModel>, coordinator: RecoveryCoordinator,
  events: Map<number, { metadata: ReturnType<typeof journalEvent>; sha256: string }>): void {
  Object.assign(coordinator, { fileHash: memoryFileHash(model), executor: () => ({ execute: async (action: RecoveryAction) => {
    if (action.kind === 'quarantine') {
      const bytes = model.memory.files.get(action.source.path);
      assert.ok(bytes !== undefined);
      model.memory.files.delete(action.source.path);
      model.memory.files.set(action.target.path, bytes);
      for (const sequence of events.keys()) {
        if (action.source.path === `journal/events/${String(sequence).padStart(16, '0')}.json`) { events.delete(sequence); }
      }
    }
    if (action.kind === 'publishCursor' || action.kind === 'raiseHighWater') { model.memory.seed(action.target.path, action.value); }
    return 'applied';
  } }) });
}

function publishReceipt(logicalOutboxId: string, sequence: number, outcome: PublishReceipt['outcome']): CoreResult<PublishReceipt> {
  return { success: true, value: { outcome, kind: 'resync', logicalOutboxId, sequence, schemaVersion: 2, adapterVersion: 1, game: 'stubgame',
    targetIdentitySha256: null, targetGeneratedAt: null, baselineApplied: null, cacheDegraded: false, warnings: [] } };
}

function replayOutbox(logicalOutboxId: string, sequence: number, attemptOrdinal: number, sha256: string): Extract<OutboxRead, { status: 'valid' }> {
  const name = `event-${String(sequence).padStart(16, '0')}.json`;
  return { status: 'valid', name, sha256, bytes: Buffer.from('modeled core source'), receipt: { sourceInspection: true },
    metadata: { stateEventVersion: 1, logicalOutboxId, incarnationId: logicalOutboxId.slice(0, 32), sequence, kind: 'resync', createdAt: at,
      principal: 'principal', repairOperationId: coreAttemptToken(owner.operationId, attemptOrdinal), adapterVersion: 1, game: 'stubgame',
      schemaVersion: 2, targetIdentitySha256: '1'.repeat(64), stateGeneratedAt: at } };
}

function receiptCaptureModel() {
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  model.memory.seed(`operations/${owner.operationId}.json`, repair());
  const oldId = `${'a'.repeat(32)}-4`;
  const oldSource = replayOutbox(oldId, 4, 0, '6'.repeat(64));
  const oldVersion = { ...oldSource, metadata: { ...oldSource.metadata, kind: 'consumed' as const, repairOperationId: null, schemaVersion: 1 } };
  const newId = `${'8'.repeat(32)}-5`;
  const newSource = replayOutbox(newId, 5, 0, '7'.repeat(64));
  const sources = new Map<string, OutboxRead>([[oldVersion.name, oldVersion], [newSource.name, newSource]]);
  model.kernel.outbox.list = async () => [...sources.keys()];
  model.kernel.outbox.read = async name => sources.get(name) ?? { status: 'absent', name };
  const published: number[] = [];
  model.kernel.publish = async (_force, record, _deadline, accept) => {
    assert.ok(record !== null);
    published.push(record.recovery.attempts.length - 1);
    const result = publishReceipt(newId, 5, published.length === 1 ? 'committed' : 'replayed');
    await accept?.(result);
    return result;
  };
  return { model, oldVersion, newSource, sources, published };
}

function deferredUpgradeModel() {
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  const oldId = `${'8'.repeat(32)}-4`;
  const newId = `${'9'.repeat(32)}-5`;
  const oldSource = replayOutbox(oldId, 4, 0, '6'.repeat(64));
  const oldVersion = { ...oldSource, metadata: { ...oldSource.metadata, schemaVersion: 1 } };
  const newSource = replayOutbox(newId, 5, 0, '7'.repeat(64));
  const selected = selectRecoveryRecord(repair(), { logicalOutboxId: oldId, recordSha256: oldSource.sha256 }, 'deferred', null);
  model.memory.seed(`operations/${owner.operationId}.json`, selected);
  let fenced = false;
  model.kernel.outbox.list = async () => fenced ? [newSource.name] : [oldVersion.name];
  model.kernel.outbox.read = async name => name === newSource.name && fenced ? newSource : name === oldVersion.name && !fenced ? oldVersion : { status: 'absent', name };
  return { model, oldId, newId, oldVersion, newSource, fence: () => { fenced = true; } };
}

function seedExternalHandoff(model: ReturnType<typeof authorityModel>, handoff: ReturnType<typeof handoffFor>, digit = '9'): void {
  const base = repair();
  const operationId = `jr-${digit.repeat(32)}`;
  const record = repair({ ...base, operationId, completedAt: at, outcome: 'completed', plan: { ...base.plan, correctionId: null, handoffs: [handoff] },
    recovery: { ...base.recovery, activeEpisode: null, episodes: [{ ...base.recovery.episodes[0]!, phase: 'completed', endedAt: at,
      acceptedRecovery: { journalId: 'journal', eventId: '1'.repeat(32), sequence: 1, generation, acceptedAt: at } }] } });
  model.memory.seed(`operations/${operationId}.json`, record);
}

function damageBeforeReplayPublication(model: ReturnType<typeof authorityModel>, coordinator: RecoveryCoordinator): void {
  const read = model.kernel.journal.read.bind(model.kernel.journal);
  let damaged = true;
  model.kernel.journal.read = async () => ({ ...await read(), fault: damaged ? 'gap' : null, firstBadSequence: damaged ? 1 : null });
  Object.assign(coordinator, { fileHash: memoryFileHash(model), executor: () => ({ execute: async (action: RecoveryAction) => {
    assert.ok(action.kind === 'publishCursor' || action.kind === 'raiseHighWater');
    model.memory.seed(action.target.path, action.value);
    if (action.kind === 'raiseHighWater') { damaged = false; }
    return 'applied';
  } }) });
}

function installReplacementCompletion(model: ReturnType<typeof authorityModel>, snapshot: ReturnType<typeof completedReplayModel>['snapshot'], journalId: string): number[] {
  const logicalId = `${'8'.repeat(32)}-5`;
  const recordHash = '7'.repeat(64);
  const source = replayOutbox(logicalId, 5, 1, recordHash);
  model.kernel.outbox.read = async name => name === source.name ? source : { status: 'absent', name };
  model.kernel.outbox.list = async () => [source.name];
  const published: number[] = [];
  model.kernel.publish = async (_force, record, _deadline, accept) => {
    assert.ok(record !== null);
    published.push(record.recovery.attempts.length - 1);
    assert.equal(record.recovery.episodes.at(-1)?.replacementAttempt, 1);
    const result = publishReceipt(logicalId, 5, 'committed');
    await accept?.(result);
    return result;
  };
  model.kernel.drain = async (_deadline, owningRepair) => {
    assert.equal(owningRepair, owner.operationId);
    const current = await model.kernel.journal.read();
    assert.ok(current.header.status === 'valid');
    if (current.header.status !== 'valid') { throw new Error('Expected a valid replacement journal header.'); }
    const event = journalEvent(1, { adapter: 'stubgame', journalId, type: 'state.resync', logicalOutboxId: logicalId, recordSha256: recordHash,
      coreRepairOperationId: coreAttemptToken(owner.operationId, 1), attemptRef: { operationId: owner.operationId, attemptOrdinal: 1 },
      acceptance: { journalId, eventId: '1'.padStart(32, '0'), generation: (await model.kernel.safety()).generation } });
    model.memory.seed('journal/journal.json', { ...current.header.value, highWaterSequence: 1 });
    snapshot.events.set(1, { metadata: event, sha256: 'f'.repeat(64) });
    const stored = (await model.kernel.operations.list()).records.find(entry => entry.record.operationId === owner.operationId);
    assert.ok(stored !== undefined);
    await model.kernel.operations.update(stored, value => bindRecoveryEvent(value as RepairOperation, event));
    return model.kernel.journal.read();
  };
  return published;
}

async function crashAfterReplayReservation(model: ReturnType<typeof authorityModel>): Promise<string> {
  const write = model.memory.write.bind(model.memory);
  const interrupted = new Error('Stop after the replay witness reservation.');
  model.memory.write = async (...args) => {
    const result = await write(...args);
    if (args[0] === 'state-safety.json' && (args[1] as StateSafety).recoveryWitness?.phase === 'transferring') { throw interrupted; }
    return result;
  };
  try { await assert.rejects(new RecoveryCoordinator(model.kernel).plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() }), error => error === interrupted); }
  finally { model.memory.write = write; }
  const safety = model.memory.value<StateSafety>('state-safety.json');
  assert.equal(safety.recoveryWitness?.phase, 'transferring');
  return safety.recoveryWitness.successor!.activationId;
}

function interruptAfterObservedWrite(model: ReturnType<typeof authorityModel>) {
  const write = model.memory.write.bind(model.memory);
  const interrupted = new Error('Stop after observed selection is durable.');
  let cut = false;
  model.memory.write = async (...args) => {
    const result = await write(...args);
    if (!cut && args[0].startsWith('operations/')) {
      const record = args[1] as RepairOperation;
      if (record.kind === 'repair' && record.recovery.activeEpisode !== null && record.plan.publishedVersions !== null
        && record.recovery.attempts.at(-1)?.publication === 'observed') { cut = true; throw interrupted; }
    }
    return result;
  };
  return { interrupted, restore: () => { model.memory.write = write; } };
}

async function persistDamageTransfer(record: RepairOperation, baseline: JournalSnapshot,
  makeSnapshot: (model: ReturnType<typeof authorityModel>) => JournalSnapshot): Promise<{ record: RepairOperation; model: ReturnType<typeof authorityModel> }> {
  const currentOwner = activeRecoveryOwner(record);
  assert.ok(currentOwner !== null);
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: null,
    recoveryWitness: { ...witness, owner: currentOwner } }, baseline);
  model.memory.seed(`operations/${record.operationId}.json`, record);
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, { fileHash: memoryFileHash(model) });
  const entry = (await model.kernel.operations.list()).records.find(item => item.record.operationId === record.operationId);
  assert.ok(entry !== undefined && !entry.record.compacted && entry.record.kind === 'repair');
  assert.ok(record.recovery.episodes.length <= 2);
  const successor: RecoveryOwner = { operationId: record.operationId, episodeOrdinal: record.recovery.episodes.length,
    activationId: String(record.recovery.episodes.length + 3).repeat(32) };
  await (coordinator as unknown as { publishDamageEpisode: (stored: { record: RepairOperation; sha256: string }, snapshot: JournalSnapshot,
    owner: RecoveryOwner) => Promise<void> }).publishDamageEpisode({ record: entry.record as RepairOperation, sha256: entry.sha256 }, makeSnapshot(model), successor);
  const result = await model.kernel.operations.read(record.operationId);
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid' || result.value.compacted || result.value.kind !== 'repair') { throw new Error('Expected a persisted damage successor.'); }
  return { record: result.value, model };
}

test('initial cursor repair completes when the acknowledged position exceeds high water', async () => {
  const baseline = journal();
  const snapshot = { ...baseline, events: new Map(baseline.events) };
  const model = authorityModel(undefined, snapshot);
  assert.equal(snapshot.cursor.status, 'valid');
  if (snapshot.cursor.status !== 'valid') { throw new Error('Expected a valid fixture cursor.'); }
  model.memory.seed('journal/cursor-agent-session.json', { ...snapshot.cursor.value, lastAckedSequence: 10, lastSentSequence: 10 });
  model.kernel.journal.read = async () => {
    const header = await model.memory.read('journal/journal.json', 'config', parseJournalHeader);
    const cursor = await model.memory.read('journal/cursor-agent-session.json', 'config', parseJournalCursor);
    const fault = header.status !== 'valid' ? 'header' : cursor.status !== 'valid' || cursor.value.lastAckedSequence > header.value.highWaterSequence
      || cursor.value.lastSentSequence > header.value.highWaterSequence ? 'cursor' : null;
    return { ...snapshot, header, cursor, fault };
  };
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, {
    fileHash: memoryFileHash(model),
    executor: () => ({ execute: async (action: RecoveryAction) => {
      assert.equal(action.kind, 'publishCursor');
      model.memory.seed(action.target.path, action.value);
      return 'applied';
    } }),
  });
  const initial = await model.kernel.journal.read();
  assert.equal(initial.fault, 'cursor');
  const planned = await coordinator.plan({ cause: 'cursor', journal: initial });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.plan.lastGoodSequence, 0);
  assert.equal(planned.record.plan.cursorTo, 0);
  const operationId = planned.record.operationId;
  await (coordinator as unknown as { runPrerequisite: (id: string) => Promise<void> }).runPrerequisite(operationId);
  const repaired = await model.kernel.journal.read();
  assert.equal(repaired.fault, null);
  assert.ok(repaired.cursor.status === 'valid');
  if (repaired.cursor.status !== 'valid') { throw new Error('Expected a valid repaired cursor.'); }
  assert.equal(repaired.cursor.value.lastAckedSequence, 0);

  const safety = await model.kernel.safety();
  const event = journalEvent(1, { adapter: 'stubgame', type: 'state.resync', coreRepairOperationId: coreAttemptToken(operationId, 0),
    attemptRef: { operationId, attemptOrdinal: 0 }, acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation: safety.generation } });
  assert.ok(repaired.header.status === 'valid');
  if (repaired.header.status !== 'valid') { throw new Error('Expected a valid repaired header.'); }
  model.memory.seed('journal/journal.json', { ...repaired.header.value, highWaterSequence: 1 });
  snapshot.events.set(1, { metadata: event, sha256: 'f'.repeat(64) });
  const stored = (await model.kernel.operations.list()).records.find(entry => entry.record.operationId === operationId);
  assert.ok(stored !== undefined);
  await model.kernel.operations.update(stored, value => {
    const repair = value as RepairOperation;
    const selected = selectRecoveryRecord(repair, { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }, 'observed', null);
    return checkpointRecovery(bindRecoveryEvent(selected, event), event, safety.generation, repair.plan.lastGoodSequence + 1, event.occurredAt);
  });
  await (coordinator as unknown as { finalize: (id: string) => Promise<void> }).finalize(operationId);
  const completed = await model.kernel.operations.read(operationId);
  assert.equal(completed.status, 'valid');
  if (completed.status !== 'valid' || completed.value.compacted || completed.value.kind !== 'repair') { throw new Error('Expected a completed repair operation.'); }
  assert.equal(completed.value.outcome, 'completed');
  assert.equal(completed.value.recovery.activeEpisode, null);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
});

test('a valid acknowledged position above sent remains the initial recovery floor', async () => {
  const snapshot = { ...journal(1, 1), events: new Map([[1, { metadata: journalEvent(1, { adapter: 'stubgame' }), sha256: 'f'.repeat(64) }]]) };
  assert.equal(snapshot.cursor.status, 'valid');
  if (snapshot.cursor.status !== 'valid') { throw new Error('Expected a valid fixture cursor.'); }
  const model = authorityModel(undefined, snapshot);
  model.memory.seed('journal/cursor-agent-session.json', { ...snapshot.cursor.value, lastSentSequence: 0 });
  const current = await model.kernel.journal.read();
  const planned = await new RecoveryCoordinator(model.kernel).plan({ cause: 'contextUncertain', journal: current });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.plan.lastGoodSequence, 1);
  assert.equal(planned.record.recovery.episodes[0]?.prerequisite, null);
});

test('a sent-only cursor position above high water uses the repaired high water', async () => {
  const snapshot = { ...journal(1, 0), events: new Map([[1, { metadata: journalEvent(1, { adapter: 'stubgame' }), sha256: 'f'.repeat(64) }]]) };
  const model = authorityModel(undefined, snapshot);
  assert.equal(snapshot.cursor.status, 'valid');
  if (snapshot.cursor.status !== 'valid') { throw new Error('Expected a valid fixture cursor.'); }
  model.memory.seed('journal/cursor-agent-session.json', { ...snapshot.cursor.value, lastSentSequence: 10 });
  const observed = await model.kernel.journal.read();
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, { fileHash: memoryFileHash(model) });
  const planned = await coordinator.plan({ cause: 'cursor', journal: { ...observed, fault: 'cursor' } });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.plan.lastGoodSequence, 1);
  assert.equal(planned.record.plan.cursorTo, 1);
});

test('lost journal planning rebuilds an absent header from sequence zero', async () => {
  const model = authorityModel();
  model.memory.files.delete('journal/journal.json');
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, { fileHash: memoryFileHash(model) });
  const missing = { ...await model.kernel.journal.read(), header: { status: 'absent' as const }, fault: 'header' as const };
  const planned = await coordinator.plan({ cause: 'lostJournal', journal: missing });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.recovery.episodes[0]?.prerequisite?.kind, 'header');
  assert.equal(planned.record.plan.lastGoodSequence, 0);
  assert.equal(planned.record.plan.cursorTo, null);
});

test('completed repair replays through a rebuilt header at a lower sequence', async () => {
  const { oldEvent, record } = completedAtFloor();
  const baseline = journal(4, 3);
  const events = new Map<number, { metadata: typeof oldEvent; sha256: string }>();
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }, baseline);
  model.memory.seed(`operations/${owner.operationId}.json`, record);
  model.memory.files.delete('journal/journal.json');
  model.kernel.journal.read = async () => {
    const header = await model.memory.read('journal/journal.json', 'config', parseJournalHeader);
    const cursor = await model.memory.read('journal/cursor-agent-session.json', 'config', parseJournalCursor);
    const fault = header.status !== 'valid' ? 'header' : cursor.status !== 'valid' || cursor.value.journalId !== header.value.journalId ? 'cursor' : null;
    return { ...baseline, header, cursor, events, fault };
  };
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, {
    fileHash: memoryFileHash(model),
    executor: () => ({ execute: async (action: RecoveryAction) => {
      if (action.kind === 'quarantine') {
        const source = model.memory.files.get(action.source.path);
        assert.ok(source !== undefined);
        model.memory.files.delete(action.source.path);
        model.memory.files.set(action.target.path, source);
      } else if (action.kind === 'publishHeader' || action.kind === 'publishCursor') { model.memory.seed(action.target.path, action.value); }
      else { throw new Error(`Unexpected replay prerequisite: ${action.kind}`); }
      return 'applied';
    } }),
  });
  const planned = await coordinator.plan({ cause: 'header', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.operationId, owner.operationId);
  assert.equal(planned.record.plan.lastGoodSequence, 0);
  assert.equal(planned.record.plan.cursorTo, null);
  assert.equal(planned.record.recovery.episodes.at(-1)?.trigger, 'completedReplay');
  const selected = planned.record.recovery.attempts.at(-1)!.selectedRecord;
  assert.ok(selected !== null);
  await model.kernel.operations.update(planned, value => selectRecoveryRecord(value as RepairOperation, selected, 'observed', null));
  model.kernel.drain = async (_deadline, owningRepair) => {
    assert.equal(owningRepair, owner.operationId);
    const current = await model.kernel.journal.read();
    assert.ok(current.header.status === 'valid' && current.cursor.status === 'valid');
    if (current.header.status !== 'valid' || current.cursor.status !== 'valid') { throw new Error('Expected rebuilt journal controls.'); }
    assert.notEqual(current.header.value.journalId, 'journal');
    assert.equal(current.cursor.value.lastAckedSequence, 0);
    const event = journalEvent(1, { adapter: 'stubgame', journalId: current.header.value.journalId, type: 'state.resync',
      logicalOutboxId: oldEvent.logicalOutboxId, coreRepairOperationId: coreAttemptToken(owner.operationId, 0),
      attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 },
      acceptance: { journalId: current.header.value.journalId, eventId: '1'.padStart(32, '0'), generation: (await model.kernel.safety()).generation } });
    model.memory.seed('journal/journal.json', { ...current.header.value, highWaterSequence: 1 });
    events.set(1, { metadata: event, sha256: 'f'.repeat(64) });
    const stored = (await model.kernel.operations.list()).records.find(entry => entry.record.operationId === owner.operationId);
    assert.ok(stored !== undefined);
    await model.kernel.operations.update(stored, value => bindRecoveryEvent(value as RepairOperation, event));
    return model.kernel.journal.read();
  };
  await coordinator.resume(owner.operationId);
  const result = await model.kernel.operations.read(owner.operationId);
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid' || result.value.compacted || result.value.kind !== 'repair') { throw new Error('Expected completed replay authority.'); }
  assert.equal(result.value.plan.lastGoodSequence, 0);
  assert.equal(result.value.recovery.attempts.length, 1);
  assert.equal(result.value.recovery.activeEpisode, null);
  assert.equal(result.value.recovery.episodes.at(-1)?.acceptedRecovery?.sequence, 1);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
});

test('completed replay uses the current journal position with or without cursor reconstruction', async () => {
  const { record } = completedAtFloor();
  const original = journal(1, 0);
  assert.ok(original.header.status === 'valid' && original.cursor.status === 'valid');
  if (original.header.status !== 'valid' || original.cursor.status !== 'valid') { throw new Error('Expected valid fixture controls.'); }
  const journalId = '9'.repeat(32);
  for (const missingCursor of [false, true]) {
    const snapshot = { ...original,
      header: { ...original.header, value: { ...original.header.value, journalId } },
      cursor: { ...original.cursor, value: { ...original.cursor.value, journalId } },
      events: new Map([[1, { metadata: journalEvent(1, { adapter: 'stubgame', journalId }), sha256: 'f'.repeat(64) }]]),
      fault: missingCursor ? 'cursor' as const : null };
    const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }, snapshot);
    model.memory.seed(`operations/${owner.operationId}.json`, record);
    if (missingCursor) { model.memory.files.delete('journal/cursor-agent-session.json'); }
    const coordinator = new RecoveryCoordinator(model.kernel);
    Object.assign(coordinator, { fileHash: memoryFileHash(model) });
    const observed = await model.kernel.journal.read();
    const planned = await coordinator.plan({ cause: missingCursor ? 'cursor' : 'contextUncertain', journal: observed });
    assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
    assert.equal(planned.record.operationId, owner.operationId);
    assert.equal(planned.record.plan.lastGoodSequence, 1);
    assert.equal(planned.record.plan.cursorTo, missingCursor ? 1 : null);
    assert.equal(planned.record.recovery.episodes.at(-1)?.prerequisite?.kind ?? null, missingCursor ? 'cursor' : null);
  }
});

test('completed replay follows a gap prerequisite that lowers high water', async () => {
  const { record } = completedAtFloor();
  const baseline = journal(4, 0);
  const snapshot = { ...baseline, events: new Map([[1, { metadata: journalEvent(1, { adapter: 'stubgame' }), sha256: 'f'.repeat(64) }]]),
    fault: 'gap' as const, firstBadSequence: 2 };
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }, snapshot);
  model.memory.seed(`operations/${owner.operationId}.json`, record);
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, { fileHash: memoryFileHash(model) });
  const planned = await coordinator.plan({ cause: 'gap', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.plan.lastGoodSequence, 1);
  assert.equal(planned.record.plan.cursorTo, null);
  assert.equal(planned.record.recovery.episodes.at(-1)?.prerequisite?.kind, 'gap');
});

test('missing completed resync allocates one replacement before publishing under the old token', async () => {
  const { model, snapshot, journalId } = completedReplayModel();
  const coordinator = new RecoveryCoordinator(model.kernel);
  const planned = await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.plan.lastGoodSequence, 0);
  const published = installReplacementCompletion(model, snapshot, journalId);
  await coordinator.resume(owner.operationId);
  const result = await model.kernel.operations.read(owner.operationId);
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid' || result.value.compacted || result.value.kind !== 'repair') { throw new Error('Expected completed replacement authority.'); }
  assert.deepEqual(published, [1]);
  assert.equal(result.value.recovery.attempts.length, 2);
  assert.equal(result.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
  assert.equal(result.value.recovery.episodes.at(-1)?.acceptedRecovery?.sequence, 1);
  assert.equal(result.value.recovery.activeEpisode, null);
});

test('a replayed tombstone losing its exact source reaches one durable replacement', async () => {
  const { model, oldEvent } = completedReplayModel(true);
  const coordinator = new RecoveryCoordinator(model.kernel);
  const planned = await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  const oldSource = replayOutbox(oldEvent.logicalOutboxId, 4, 0, oldEvent.recordSha256);
  let sourcePresent = true;
  model.kernel.outbox.read = async name => sourcePresent && name === oldSource.name ? oldSource : { status: 'absent', name };
  model.kernel.outbox.list = async () => sourcePresent ? [oldSource.name] : [];
  const interrupted = new Error('Stop after the replacement attempt is durable.');
  const published: number[] = [];
  model.kernel.publish = async (_force, record, _deadline, accept) => {
    assert.ok(record !== null);
    const ordinal = record.recovery.attempts.length - 1;
    published.push(ordinal);
    if (ordinal === 1) { throw interrupted; }
    assert.equal(ordinal, 0);
    sourcePresent = false;
    const result = publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
    await accept?.(result);
    return result;
  };
  model.kernel.drain = async () => model.kernel.journal.read();
  await assert.rejects(coordinator.resume(owner.operationId), error => error === interrupted);
  let current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected durable replacement authority.'); }
  assert.deepEqual(published, [0, 1]);
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.recordSha256, oldEvent.recordSha256);
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
  assert.equal(current.value.recovery.attempts.length, 2);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === interrupted);
  current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected resumed replacement authority.'); }
  assert.deepEqual(published, [0, 1, 1]);
  assert.equal(current.value.recovery.attempts.length, 2);
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
});

test('damage transfer retains the selected attempt and allocates one replacement before publish', async () => {
  const { model } = completedReplayModel();
  const coordinator = new RecoveryCoordinator(model.kernel);
  await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  damageBeforeReplayPublication(model, coordinator);
  model.kernel.outbox.read = async name => ({ status: 'absent', name });
  const interrupted = new Error('Stop at replacement publication.');
  const published: number[] = [];
  model.kernel.publish = async (_force, record) => { published.push(record!.recovery.attempts.length - 1); throw interrupted; };
  await assert.rejects(coordinator.resume(owner.operationId), error => error === interrupted);
  let stored = await model.kernel.operations.read(owner.operationId);
  assert.equal(stored.status, 'valid');
  if (stored.status !== 'valid' || stored.value.compacted || stored.value.kind !== 'repair') { throw new Error('Expected transferred replay authority.'); }
  assert.equal(stored.value.recovery.episodes.at(-1)?.trigger, 'gap');
  assert.equal(stored.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
  assert.equal(stored.value.recovery.attempts.length, 2);
  assert.deepEqual(published, [1]);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === interrupted);
  stored = await model.kernel.operations.read(owner.operationId);
  assert.equal(stored.status, 'valid');
  if (stored.status !== 'valid' || stored.value.compacted || stored.value.kind !== 'repair') { throw new Error('Expected resumed transfer authority.'); }
  assert.equal(stored.value.recovery.attempts.length, 2);
  assert.deepEqual(published, [1, 1]);
});

test('damage-transferred replayed tombstone uses its recorded hash after source loss', async () => {
  const { model, oldEvent } = completedReplayModel(true);
  const coordinator = new RecoveryCoordinator(model.kernel);
  await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  damageBeforeReplayPublication(model, coordinator);
  const oldSource = replayOutbox(oldEvent.logicalOutboxId, 4, 0, oldEvent.recordSha256);
  let present = true;
  model.kernel.outbox.read = async name => present && name === oldSource.name ? oldSource : { status: 'absent', name };
  model.kernel.outbox.list = async () => present ? [oldSource.name] : [];
  const interrupted = new Error('Stop after transferred replacement.');
  model.kernel.publish = async (_force, record, _deadline, accept) => {
    assert.ok(record !== null);
    if (record.recovery.attempts.length === 2) { throw interrupted; }
    present = false;
    const result = publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
    await accept?.(result);
    return result;
  };
  model.kernel.drain = async () => model.kernel.journal.read();
  await assert.rejects(coordinator.resume(owner.operationId), error => error === interrupted);
  const stored = await model.kernel.operations.read(owner.operationId);
  assert.equal(stored.status, 'valid');
  if (stored.status !== 'valid' || stored.value.compacted || stored.value.kind !== 'repair') { throw new Error('Expected retained transferred replay.'); }
  assert.equal(stored.value.recovery.episodes.at(-1)?.trigger, 'gap');
  assert.equal(stored.value.recovery.attempts[0]?.selectedRecord?.recordSha256, oldEvent.recordSha256);
  assert.equal(stored.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
});

test('a newly deferred selection without a journal reference keeps its original attempt', async () => {
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  const logicalId = `${'8'.repeat(32)}-5`;
  const source = replayOutbox(logicalId, 5, 0, '7'.repeat(64));
  const selected = selectRecoveryRecord(repair(), { logicalOutboxId: logicalId, recordSha256: source.sha256 }, 'deferred', null);
  assert.equal(selected.recovery.attempts[0]?.journalEvent, null);
  model.memory.seed(`operations/${owner.operationId}.json`, selected);
  let sourceReads = 0;
  model.kernel.outbox.read = async () => { sourceReads++; return source; };
  const interrupted = new Error('Stop at the original core token.');
  model.kernel.publish = async (_force, record) => { assert.equal(record?.recovery.attempts.length, 1); throw interrupted; };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === interrupted);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retained deferred selection.'); }
  assert.equal(sourceReads, 0);
  assert.equal(current.value.recovery.attempts.length, 1);
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, null);
});

test('old-version replay preserves a later accepted suffix event before replacement', async () => {
  const { model, oldEvent, later, events } = nonTailVersionReplayModel();
  seedExternalHandoff(model, handoffFor(later));
  const newId = `${'9'.repeat(32)}-4`;
  const newSource = replayOutbox(newId, 4, 1, '7'.repeat(64));
  const retiredId = `${'a'.repeat(32)}-2`;
  const retiredBase = replayOutbox(retiredId, 2, 0, '6'.repeat(64));
  const retiredSource = { ...retiredBase, metadata: { ...retiredBase.metadata, kind: 'consumed' as const, repairOperationId: null, schemaVersion: 1 } };
  let replacementPublished = false;
  model.kernel.outbox.read = async name => name === retiredSource.name ? retiredSource
    : replacementPublished && name === newSource.name ? newSource : { status: 'absent', name };
  model.kernel.outbox.list = async () => replacementPublished ? [retiredSource.name, newSource.name] : [retiredSource.name];
  const coordinator = new RecoveryCoordinator(model.kernel);
  const published: number[] = [];
  let oldCheckToken: string | null = null;
  model.kernel.core.publish = async (_principal, _force, token) => {
    const ordinal = token === coreAttemptToken(owner.operationId, 1) ? 1 : 0;
    published.push(ordinal);
    if (ordinal === 1) {
      assert.notEqual((await model.kernel.safety()).pendingCheck, oldCheckToken);
      assert.equal(events.has(4), false);
      assert.equal(events.has(5), false);
      const snapshotAtReplacement = await model.kernel.journal.read();
      assert.equal(snapshotAtReplacement.header.status, 'valid');
      if (snapshotAtReplacement.header.status !== 'valid') { throw new Error('Expected a rewound header.'); }
      assert.equal(snapshotAtReplacement.header.value.highWaterSequence, 3);
      replacementPublished = true;
      return publishReceipt(newId, 4, 'committed');
    }
    oldCheckToken = (await model.kernel.safety()).pendingCheck;
    assert.ok(oldCheckToken !== null);
    return publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
  };
  memoryRewindExecutor(model, coordinator, events);
  model.kernel.drain = async (_deadline, owningRepair) => {
    assert.equal(owningRepair, owner.operationId);
    const current = await model.kernel.journal.read();
    assert.equal(current.header.status, 'valid');
    if (current.header.status !== 'valid') { throw new Error('Expected replacement journal authority.'); }
    const event = journalEvent(4, { adapter: 'stubgame', eventId: 'a'.repeat(32), type: 'state.resync', logicalOutboxId: newId,
      recordSha256: newSource.sha256, coreRepairOperationId: coreAttemptToken(owner.operationId, 1),
      attemptRef: { operationId: owner.operationId, attemptOrdinal: 1 },
      acceptance: { journalId: current.header.value.journalId, eventId: 'a'.repeat(32), generation: (await model.kernel.safety()).generation } });
    model.memory.seed('journal/journal.json', { ...current.header.value, highWaterSequence: 4 });
    events.set(4, { metadata: event, sha256: 'e'.repeat(64) });
    const stored = (await model.kernel.operations.list()).records.find(entry => entry.record.operationId === owner.operationId);
    assert.ok(stored !== undefined);
    await model.kernel.operations.update(stored, value => bindRecoveryEvent(value as RepairOperation, event));
    return model.kernel.journal.read();
  };
  await coordinator.resume(owner.operationId);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected durable incompatible replay authority.'); }
  assert.deepEqual(published, [0, 1]);
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
  assert.equal(current.value.recovery.attempts[0]?.publication, 'observed');
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === oldEvent.logicalOutboxId)?.presentation, 'rejected');
  const laterHandoff = current.value.plan.handoffs.find(item => item.logicalOutboxId === later.logicalOutboxId);
  assert.equal(laterHandoff?.presentation, 'replayable');
  assert.equal(laterHandoff?.recordSha256, later.recordSha256);
  assert.equal(laterHandoff?.journalId, later.acceptance?.journalId);
  assert.equal(laterHandoff?.eventId, later.acceptance?.eventId);
  assert.deepEqual(laterHandoff?.acceptance, later.acceptance);
  assert.equal(current.value.plan.retiredRecords.find(item => item.logicalOutboxId === retiredId)?.recordSha256, retiredSource.sha256);
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === retiredId)?.presentation, 'unverified');
  assert.equal(current.value.recovery.episodes.at(-1)?.prerequisite?.nextAction, current.value.recovery.episodes.at(-1)?.prerequisite?.actions.length);
  assert.equal(current.value.recovery.activeEpisode, null);
  assert.equal((await model.kernel.safety()).pendingCheck, null);
  assert.deepEqual([...events.values()].map(item => item.metadata.logicalOutboxId), [newId]);
});

test('non-tail replay resumes its exact suffix plan across replacement write cuts', async () => {
  for (const cutSide of ['before', 'after'] as const) {
    const { model, oldEvent, later, events } = nonTailVersionReplayModel();
    model.kernel.outbox.read = async name => ({ status: 'absent', name });
    const makeCoordinator = () => {
      const coordinator = new RecoveryCoordinator(model.kernel);
      memoryRewindExecutor(model, coordinator, events);
      return coordinator;
    };
    const stopped = new Error('Stop at new core token.');
    const cut = new Error('Stop at exact suffix publication.');
    const published: number[] = [];
    model.kernel.publish = async (_force, current, _deadline, accept) => {
      assert.ok(current !== null);
      const ordinal = current.recovery.attempts.length - 1;
      published.push(ordinal);
      if (ordinal === 1) {
        assert.equal(events.size, 0, cutSide);
        const snapshot = await model.kernel.journal.read();
        assert.equal(snapshot.header.status, 'valid');
        if (snapshot.header.status !== 'valid') { throw new Error('Expected a rewound suffix header.'); }
        assert.equal(snapshot.header.value.highWaterSequence, 3, cutSide);
        throw stopped;
      }
      const result = publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
      await accept?.(result);
      return result;
    };
    const write = model.memory.write.bind(model.memory);
    let interrupted = false;
    model.memory.write = async (...args) => {
      const candidate = args[0] === `operations/${owner.operationId}.json` && (args[1] as RepairOperation).recovery.attempts.length === 2;
      if (candidate && !interrupted && cutSide === 'before') { interrupted = true; throw cut; }
      const result = await write(...args);
      if (candidate && !interrupted && cutSide === 'after') { interrupted = true; throw cut; }
      return result;
    };
    await assert.rejects(makeCoordinator().resume(owner.operationId), error => error === cut, cutSide);
    let current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', cutSide);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retained suffix authority.'); }
    assert.equal(current.value.recovery.attempts.length, cutSide === 'before' ? 1 : 2, cutSide);
    assert.equal(events.size, 2, cutSide);
    model.memory.write = write;
    await assert.rejects(makeCoordinator().resume(owner.operationId), error => error === stopped, cutSide);
    current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', cutSide);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected resumed exact suffix authority.'); }
    assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1, cutSide);
    assert.deepEqual(current.value.plan.handoffs.find(item => item.logicalOutboxId === later.logicalOutboxId)?.acceptance, later.acceptance, cutSide);
    assert.deepEqual(published, cutSide === 'before' ? [0, 0, 1] : [0, 1], cutSide);
  }
});

test('non-tail replay refuses conflicting suffix binding or handoff capacity', async () => {
  for (const refusal of ['binding', 'capacity'] as const) {
    const { model, oldEvent, later, events } = nonTailVersionReplayModel();
    model.kernel.outbox.read = async name => ({ status: 'absent', name });
    if (refusal === 'binding') {
      const incompatible = { ...handoffFor(later), eventId: 'a'.repeat(32), acceptance: { ...later.acceptance!, eventId: 'a'.repeat(32) } };
      seedExternalHandoff(model, incompatible);
    } else {
      const reserve = model.kernel.resources.reserve.bind(model.kernel.resources);
      model.kernel.resources.reserve = async (...args) => {
        if (args[1]?.uncompactedEvents === 1 && (args[1]?.retainedHandoffs ?? 0) > 0) {
          throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['retainedHandoffs'] }, 'repair');
        }
        return reserve(...args);
      };
    }
    let drains = 0;
    model.kernel.drain = async () => { drains++; throw new Error('Refused suffix reached drain.'); };
    model.kernel.publish = async (_force, _record, _deadline, accept) => {
      const result = publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
      await accept?.(result);
      return result;
    };
    const coordinator = new RecoveryCoordinator(model.kernel);
    memoryRewindExecutor(model, coordinator, events);
    await assert.rejects(coordinator.resume(owner.operationId));
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', refusal);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retained suffix obligation.'); }
    assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, null, refusal);
    assert.equal(events.size, 2, refusal);
    assert.equal(drains, 0, refusal);
  }
});

test('old-version replay resumes the correct token across replacement write cuts', async () => {
  for (const cutSide of ['before', 'after'] as const) {
    const { model, oldEvent } = completedReplayModel(true);
    await new RecoveryCoordinator(model.kernel).plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
    const base = replayOutbox(oldEvent.logicalOutboxId, 4, 0, oldEvent.recordSha256);
    const oldSource = { ...base, metadata: { ...base.metadata, schemaVersion: 1 } };
    model.kernel.outbox.read = async name => name === oldSource.name ? oldSource : { status: 'absent', name };
    model.kernel.outbox.list = async () => [oldSource.name];
    model.kernel.carryHash = async () => null;
    const stopped = new Error('Stop at replacement token.');
    const cut = new Error('Stop at replacement write.');
    const published: number[] = [];
    model.kernel.publish = async (_force, current, _deadline, accept) => {
      assert.ok(current !== null);
      const ordinal = current.recovery.attempts.length - 1;
      published.push(ordinal);
      if (ordinal === 1) { throw stopped; }
      const result = publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
      await accept?.(result);
      return result;
    };
    const write = model.memory.write.bind(model.memory);
    let interrupted = false;
    model.memory.write = async (...args) => {
      const replacement = args[0] === `operations/${owner.operationId}.json` && (args[1] as RepairOperation).recovery.attempts.length === 2;
      if (replacement && !interrupted && cutSide === 'before') { interrupted = true; throw cut; }
      const result = await write(...args);
      if (replacement && !interrupted && cutSide === 'after') { interrupted = true; throw cut; }
      return result;
    };
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut, cutSide);
    let current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', cutSide);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected replay authority after cut.'); }
    assert.equal(current.value.recovery.attempts.length, cutSide === 'before' ? 1 : 2, cutSide);
    model.memory.write = write;
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === stopped, cutSide);
    current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', cutSide);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected durable replacement authority.'); }
    assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1, cutSide);
    assert.equal(current.value.recovery.attempts.length, 2, cutSide);
    assert.deepEqual(published, cutSide === 'before' ? [0, 0, 1] : [0, 1], cutSide);
  }
});

test('a fresh resync displaces a deferred old source with one cleanup binding', async () => {
  const { model, oldId, newId, oldVersion, fence } = deferredUpgradeModel();
  const stopped = new Error('Stop after the new selection.');
  const cut = new Error('Stop before the new selection is durable.');
  const write = model.memory.write.bind(model.memory);
  let interrupt = true;
  model.memory.write = async (...args) => {
    if (interrupt && args[0] === `operations/${owner.operationId}.json`
      && (args[1] as RepairOperation).recovery.attempts[0]?.selectedRecord?.logicalOutboxId === newId) { throw cut; }
    return write(...args);
  };
  let calls = 0;
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    fence();
    const result = publishReceipt(newId, 5, calls++ === 0 ? 'committed' : 'replayed');
    await accept?.(result);
    return result;
  };
  model.kernel.drain = async () => { throw stopped; };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut);
  let current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected deferred predecessor after the lost callback.'); }
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, oldId);
  interrupt = false;
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === stopped);
  current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected durable displaced selection.'); }
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, newId);
  assert.equal(current.value.recovery.attempts.length, 1);
  assert.equal(current.value.recovery.episodes[0]?.replacementAttempt, null);
  const old = current.value.plan.handoffs.find(item => item.logicalOutboxId === oldId);
  assert.equal(old?.recordSha256, oldVersion.sha256);
  assert.equal(old?.payloadBindingSha256, null);
  assert.equal(old?.presentation, 'unverified');
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === stopped);
  assert.equal(calls, 2);
  const originalRead = model.kernel.journal.read.bind(model.kernel.journal);
  const events = new Map<number, { metadata: ReturnType<typeof journalEvent>; sha256: string }>();
  model.kernel.journal.read = async () => ({ ...await originalRead(), events });
  model.kernel.drain = async () => {
    const snapshot = await model.kernel.journal.read();
    assert.equal(snapshot.header.status, 'valid');
    if (snapshot.header.status !== 'valid') { throw new Error('Expected a healthy destination journal.'); }
    const event = journalEvent(1, { adapter: 'stubgame', type: 'state.resync', logicalOutboxId: newId, recordSha256: '7'.repeat(64),
      coreRepairOperationId: coreAttemptToken(owner.operationId, 0), attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 },
      acceptance: { journalId: snapshot.header.value.journalId, eventId: '1'.padStart(32, '0'), generation: (await model.kernel.safety()).generation } });
    model.memory.seed('journal/journal.json', { ...snapshot.header.value, highWaterSequence: 1 });
    events.set(1, { metadata: event, sha256: 'f'.repeat(64) });
    const stored = (await model.kernel.operations.list()).records.find(entry => entry.record.operationId === owner.operationId);
    assert.ok(stored !== undefined);
    await model.kernel.operations.update(stored, value => bindRecoveryEvent(value as RepairOperation, event));
    return model.kernel.journal.read();
  };
  await new RecoveryCoordinator(model.kernel).resume(owner.operationId);
  const completed = await model.kernel.operations.read(owner.operationId);
  assert.equal(completed.status, 'valid');
  if (completed.status !== 'valid' || completed.value.compacted || completed.value.kind !== 'repair') { throw new Error('Expected accepted same-token recovery.'); }
  assert.equal(completed.value.recovery.activeEpisode, null);
  assert.equal(completed.value.recovery.episodes[0]?.acceptedRecovery?.sequence, 1);
  assert.equal(calls, 2);
});

test('deferred fencing warning retains the old selected source until a clean new-ID replay', async () => {
  const { model, oldId, newId, fence } = deferredUpgradeModel();
  let calls = 0;
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    fence();
    const receipt = publishReceipt(newId, 5, calls++ === 0 ? 'committed' : 'replayed');
    assert.ok(receipt.success);
    if (!receipt.success) { throw new Error('Expected modeled core receipt.'); }
    const result = calls === 1 ? { ...receipt, value: { ...receipt.value, warnings: [{ code: 'outbox-quarantine-deferred', detail: null }] } } : receipt;
    await accept?.(result);
    return result;
  };
  let drains = 0;
  model.kernel.drain = async () => { drains++; throw new Error('Stop after clean selection.'); };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /Core quarantine remains deferred/);
  let current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected deferred selected predecessor.'); }
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, oldId);
  assert.equal(current.value.recovery.attempts[0]?.publication, 'deferred');
  assert.equal(current.value.plan.handoffs.length, 0);
  assert.equal(drains, 0);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /Stop after clean selection/);
  current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected clean new selection.'); }
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, newId);
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === oldId)?.presentation, 'unverified');
  assert.equal(current.value.recovery.episodes[0]?.replacementAttempt, null);
  assert.equal(calls, 2);
});

test('surviving deferred old bytes are retired when a fresh resync displaces them', async () => {
  const { model, oldId, newId, oldVersion, newSource } = deferredUpgradeModel();
  model.kernel.outbox.list = async () => [oldVersion.name, newSource.name];
  model.kernel.outbox.read = async name => name === oldVersion.name ? oldVersion : name === newSource.name ? newSource : { status: 'absent', name };
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    const result = publishReceipt(newId, 5, 'committed');
    await accept?.(result);
    return result;
  };
  model.kernel.drain = async () => { throw new Error('Stop after receipt capture.'); };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /Stop after receipt capture/);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retired old source.'); }
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, newId);
  assert.equal(current.value.plan.retiredRecords.find(item => item.logicalOutboxId === oldId)?.recordSha256, oldVersion.sha256);
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === oldId)?.presentation, 'unverified');
});

test('deferred displacement refuses contradictory or unavailable historical bindings', async () => {
  for (const evidence of ['conflict', 'invalid'] as const) {
    const { model, oldId, newId, oldVersion, fence } = deferredUpgradeModel();
    if (evidence === 'conflict') {
      const alien = journalEvent(4, { adapter: 'stubgame', type: 'state.resync', logicalOutboxId: oldId, recordSha256: oldVersion.sha256,
        coreRepairOperationId: coreAttemptToken(owner.operationId, 1), attemptRef: { operationId: owner.operationId, attemptOrdinal: 1 } });
      seedExternalHandoff(model, handoffFor(alien));
    } else {
      model.memory.files.set(`operations/jr-${'a'.repeat(32)}.json`, Buffer.from('{}'));
    }
    model.kernel.publish = async (_force, _record, _deadline, accept) => {
      fence();
      const result = publishReceipt(newId, 5, 'committed');
      await accept?.(result);
      return result;
    };
    let drains = 0;
    model.kernel.drain = async () => { drains++; throw new Error('Disputed binding reached drain.'); };
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId));
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', evidence);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected unchanged selection.'); }
    assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, oldId, evidence);
    assert.equal(drains, 0, evidence);
  }
});

test('readable prior resync is retained with its original binding before core publication', async () => {
  const { model, oldEvent, snapshot, journalId } = completedReplayModel(false, 0);
  const originalHeader = await model.kernel.journal.read();
  assert.ok(originalHeader.header.status === 'valid');
  if (originalHeader.header.status !== 'valid') { throw new Error('Expected a valid journal header.'); }
  const priorEvent = journalEvent(1, { adapter: 'stubgame', journalId, type: 'state.resync', logicalOutboxId: oldEvent.logicalOutboxId,
    recordSha256: oldEvent.recordSha256, coreRepairOperationId: coreAttemptToken(owner.operationId, 0),
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 }, acceptance: oldEvent.acceptance });
  model.memory.seed('journal/journal.json', { ...originalHeader.header.value, highWaterSequence: 1 });
  snapshot.events.set(1, { metadata: priorEvent, sha256: 'f'.repeat(64) });
  const coordinator = new RecoveryCoordinator(model.kernel);
  const planned = await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  assert.equal(planned.record.plan.lastGoodSequence, 0);
  const newLogicalId = `${'8'.repeat(32)}-5`;
  const newSource = replayOutbox(newLogicalId, 5, 0, '7'.repeat(64));
  model.kernel.outbox.read = async name => name === newSource.name ? newSource : { status: 'absent', name };
  model.kernel.outbox.list = async () => [newSource.name];
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    const result = publishReceipt(newLogicalId, 5, 'committed');
    await accept?.(result);
    return result;
  };
  const interrupted = new Error('Stop after selection.');
  model.kernel.drain = async () => { throw interrupted; };
  await assert.rejects(coordinator.resume(owner.operationId), error => error === interrupted);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retained replay authority.'); }
  const handoff = current.value.plan.handoffs.find(item => item.logicalOutboxId === oldEvent.logicalOutboxId);
  assert.ok(handoff !== undefined);
  assert.equal(handoff.recordSha256, oldEvent.recordSha256);
  assert.equal(handoff.payloadBindingSha256, priorEvent.payloadBindingSha256);
  assert.deepEqual(handoff.acceptance, oldEvent.acceptance);
  assert.equal(current.value.recovery.attempts[0]?.selectedRecord?.logicalOutboxId, newLogicalId);
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, null);
  assert.equal(current.value.recovery.attempts.length, 1);
});

test('a plan-bound carry keeps the original completed-replay attempt', async () => {
  const { model, oldEvent } = completedReplayModel();
  const coordinator = new RecoveryCoordinator(model.kernel);
  const planned = await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  const record = planned.record as RepairOperation;
  model.memory.seed('journal/recovery-event.json', { carry: 'bound' });
  const carryHash = bytesHash(model.memory.files.get('journal/recovery-event.json')!);
  const prerequisite = { kind: 'rewind' as const, nextAction: 1, carry: { path: 'journal/recovery-event.json' as const, sha256: carryHash },
    carryRelease: { attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 } }, skippedRanges: [], actions: [
      { kind: 'preserveRecovery' as const, source: { root: 'scope' as const, path: 'journal/events/0000000000000004.json',
        sha256: '8'.repeat(64), payloadBindingSha256: oldEvent.payloadBindingSha256 },
        target: { path: 'journal/recovery-event.json', before: null, after: carryHash }, metadata: eventRewriteMetadata(oldEvent) },
      { kind: 'removeCarry' as const, target: { path: 'journal/recovery-event.json', before: carryHash, after: null } },
    ] };
  model.memory.seed(`operations/${owner.operationId}.json`, { ...record, plan: { ...record.plan, handoffs: [handoffFor(oldEvent)] }, recovery: { ...record.recovery,
    episodes: record.recovery.episodes.map((episode, index) => index === record.recovery.activeEpisode ? { ...episode, prerequisite } : episode) } });
  model.kernel.outbox.read = async name => ({ status: 'absent', name });
  const interrupted = new Error('Stop at bound core publication.');
  model.kernel.publish = async (_force, record) => { assert.equal(record?.recovery.attempts.length, 1); throw interrupted; };
  await assert.rejects(coordinator.resume(owner.operationId), error => error === interrupted);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected bound carry authority.'); }
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, null);
  assert.equal(current.value.recovery.attempts.length, 1);
  assert.equal(await model.kernel.carryHash(), carryHash);
});

test('a completed ordinary carry removal replays from the exact restored event', async () => {
  const { model, oldVersion, prerequisite } = completedOrdinaryCarryModel();
  const coordinator = new RecoveryCoordinator(model.kernel);
  Object.assign(coordinator, { fileHash: memoryFileHash(model) });
  const cut = new Error('Stop after completed-carry replay replacement is durable.');
  const write = model.memory.write.bind(model.memory);
  model.memory.write = async (...args) => {
    const result = await write(...args);
    if (args[0] === `operations/${owner.operationId}.json` && (args[1] as RepairOperation).recovery.attempts.length === 2) { throw cut; }
    return result;
  };
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    const result = publishReceipt(oldVersion.logicalOutboxId, 4, 'replayed');
    await accept?.(result);
    return result;
  };
  await assert.rejects(coordinator.resume(owner.operationId), error => error === cut);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected replacement after restored old-version replay.'); }
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === oldVersion.logicalOutboxId)?.presentation, 'rejected');
  assert.equal(prerequisite.nextAction, prerequisite.actions.length);
  assert.equal(await model.kernel.carryHash(), null);
});

test('completed carry removal refuses present slot or contradictory restoration', async () => {
  for (const contradiction of ['slot', 'event'] as const) {
    const { model, oldVersion, prerequisite } = completedOrdinaryCarryModel();
    if (contradiction === 'slot') { model.kernel.carryHash = async () => prerequisite.carry.sha256; }
    else {
      const current = model.memory.value<RepairOperation>(`operations/${owner.operationId}.json`);
      const actions = prerequisite.actions.map(action => action.kind === 'appendRecovery' ? { ...action, metadata: { ...action.metadata, eventId: 'b'.repeat(32) } } : action);
      model.memory.seed(`operations/${owner.operationId}.json`, { ...current, recovery: { ...current.recovery,
        episodes: current.recovery.episodes.map((episode, index) => index === current.recovery.activeEpisode
          ? { ...episode, prerequisite: { ...prerequisite, actions } } : episode) } });
    }
    let publications = 0;
    model.kernel.publish = async (_force, _record, _deadline, accept) => {
      publications++;
      const result = publishReceipt(oldVersion.logicalOutboxId, 4, 'replayed');
      await accept?.(result);
      return result;
    };
    let drains = 0;
    model.kernel.drain = async () => { drains++; throw new Error('Contradictory carry reached drain.'); };
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId));
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid', contradiction);
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retained carry authority.'); }
    assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, null, contradiction);
    assert.equal(drains, 0, contradiction);
    assert.equal(publications, 1, contradiction);
  }
});

test('an old-version protected carry retargets its release to one replacement', async () => {
  const { model, oldEvent } = completedReplayModel();
  const planned = await new RecoveryCoordinator(model.kernel).plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  assert.ok(!planned.record.compacted && planned.record.kind === 'repair');
  const record = planned.record as RepairOperation;
  model.memory.seed('journal/recovery-event.json', { carry: 'bound' });
  const carryHash = bytesHash(model.memory.files.get('journal/recovery-event.json')!);
  const oldVersion = journalEvent(4, { ...oldEvent, schemaVersion: 1 });
  const metadata = eventRewriteMetadata(oldVersion);
  const prerequisite = { kind: 'rewind' as const, nextAction: 1, carry: { path: 'journal/recovery-event.json' as const, sha256: carryHash },
    carryRelease: { attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 } }, skippedRanges: [], actions: [
      { kind: 'preserveRecovery' as const, source: { root: 'scope' as const, path: 'journal/events/0000000000000004.json',
        sha256: '8'.repeat(64), payloadBindingSha256: oldEvent.payloadBindingSha256 },
        target: { path: 'journal/recovery-event.json', before: null, after: carryHash }, metadata },
      { kind: 'removeCarry' as const, target: { path: 'journal/recovery-event.json', before: carryHash, after: null } },
    ] };
  model.memory.seed(`operations/${owner.operationId}.json`, { ...record, plan: { ...record.plan, handoffs: [handoffFor(oldVersion)] }, recovery: { ...record.recovery,
    episodes: record.recovery.episodes.map((episode, index) => index === record.recovery.activeEpisode ? { ...episode, prerequisite } : episode) } });
  model.kernel.outbox.read = async name => ({ status: 'absent', name });
  const stopped = new Error('Stop at protected replacement publication.');
  model.kernel.publish = async (_force, current, _deadline, accept) => {
    assert.ok(current !== null);
    if (current.recovery.attempts.length === 2) { throw stopped; }
    const result = publishReceipt(oldEvent.logicalOutboxId, 4, 'replayed');
    await accept?.(result);
    return result;
  };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === stopped);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected protected replacement authority.'); }
  assert.equal(current.value.recovery.episodes.at(-1)?.replacementAttempt, 1);
  assert.equal(current.value.recovery.episodes.at(-1)?.prerequisite?.carryRelease?.attemptRef.attemptOrdinal, 1);
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === oldEvent.logicalOutboxId)?.presentation, 'rejected');
  assert.equal(await model.kernel.carryHash(), carryHash);
});

test('a same-ID journal event owned by another repair cannot supply replay authority', async () => {
  const { model, oldEvent, snapshot, journalId } = completedReplayModel(false, 0);
  const current = await model.kernel.journal.read();
  assert.ok(current.header.status === 'valid');
  if (current.header.status !== 'valid') { throw new Error('Expected a valid journal header.'); }
  const foreignOperationId = `jr-${'5'.repeat(32)}`;
  const foreign = journalEvent(1, { adapter: 'stubgame', journalId, type: 'state.resync', logicalOutboxId: oldEvent.logicalOutboxId,
    recordSha256: oldEvent.recordSha256, coreRepairOperationId: coreAttemptToken(foreignOperationId, 0),
    attemptRef: { operationId: foreignOperationId, attemptOrdinal: 0 }, acceptance: oldEvent.acceptance });
  model.memory.seed('journal/journal.json', { ...current.header.value, highWaterSequence: 1 });
  snapshot.events.set(1, { metadata: foreign, sha256: 'f'.repeat(64) });
  const coordinator = new RecoveryCoordinator(model.kernel);
  await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
  model.kernel.outbox.read = async name => ({ status: 'absent', name });
  let publications = 0;
  model.kernel.publish = async () => { publications++; throw new Error('Foreign event reached core publication.'); };
  await assert.rejects(coordinator.resume(owner.operationId), ControlDocumentError);
  assert.equal(publications, 0);
  const stored = await model.kernel.operations.read(owner.operationId);
  assert.equal(stored.status, 'valid');
  if (stored.status !== 'valid' || stored.value.compacted || stored.value.kind !== 'repair') { throw new Error('Expected retained repair authority.'); }
  assert.equal(stored.value.recovery.attempts.length, 1);
});

test('both startup replay entries rebase a completed floor to the current journal', async () => {
  for (const trigger of ['staleGeneration', 'retainedOutbox'] as const) {
    const { model, oldEvent } = completedReplayModel();
    if (trigger === 'staleGeneration') {
      const safety = model.memory.value('state-safety.json') as { generation: string };
      model.memory.seed('state-safety.json', { ...safety, generation: 'a'.repeat(32) });
    } else {
      const current = model.memory.value<RepairOperation>(`operations/${owner.operationId}.json`);
      const name = 'event-0000000000000004.json';
      model.memory.seed(`operations/${owner.operationId}.json`, { ...current, plan: { ...current.plan,
        retiredRecords: [{ name, logicalOutboxId: oldEvent.logicalOutboxId, recordSha256: oldEvent.recordSha256 }] } });
      model.kernel.outbox.list = async () => [name];
    }
    const coordinator = new RecoveryCoordinator(model.kernel);
    coordinator.reconcileSafety = async () => {};
    const resumed: string[] = [];
    coordinator.resume = async operationId => { resumed.push(operationId); };
    await coordinator.startup();
    const result = await model.kernel.operations.read(owner.operationId);
    assert.equal(result.status, 'valid');
    if (result.status !== 'valid' || result.value.compacted || result.value.kind !== 'repair') { throw new Error('Expected durable startup replay.'); }
    assert.deepEqual(resumed, [owner.operationId]);
    assert.equal(result.value.plan.lastGoodSequence, 0, trigger);
    assert.equal(result.value.plan.cursorTo, null, trigger);
    assert.equal(result.value.recovery.episodes.at(-1)?.trigger, 'completedReplay', trigger);
  }
});

test('reservation-only replay restore keeps its activation and completes at the new floor', async () => {
  const { model, snapshot, journalId } = completedReplayModel();
  const activationId = await crashAfterReplayReservation(model);
  const before = await model.kernel.operations.read(owner.operationId);
  assert.equal(before.status, 'valid');
  if (before.status !== 'valid' || before.value.compacted || before.value.kind !== 'repair') { throw new Error('Expected completed predecessor authority.'); }
  assert.equal(before.value.plan.lastGoodSequence, 3);
  assert.equal(before.value.recovery.activeEpisode, null);
  const unreadable = new Error('Current journal is unreadable.');
  const read = model.kernel.journal.read.bind(model.kernel.journal);
  model.kernel.journal.read = async () => { throw unreadable; };
  await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), error => error === unreadable);
  model.kernel.journal.read = read;
  const stillReserved = await model.kernel.operations.read(owner.operationId);
  assert.equal(stillReserved.status, 'valid');
  if (stillReserved.status !== 'valid' || stillReserved.value.compacted || stillReserved.value.kind !== 'repair') { throw new Error('Expected unchanged reserved predecessor.'); }
  assert.equal(stillReserved.value.plan.lastGoodSequence, 3);
  const coordinator = new RecoveryCoordinator(model.kernel);
  await coordinator.reconcileSafety();
  const restored = await model.kernel.operations.read(owner.operationId);
  assert.equal(restored.status, 'valid');
  if (restored.status !== 'valid' || restored.value.compacted || restored.value.kind !== 'repair') { throw new Error('Expected restored replay authority.'); }
  assert.equal(restored.value.plan.lastGoodSequence, 0);
  assert.equal(restored.value.plan.cursorTo, null);
  assert.equal(restored.value.recovery.episodes.at(-1)?.activationId, activationId);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'active');
  const published = installReplacementCompletion(model, snapshot, journalId);
  await coordinator.resume(owner.operationId);
  const completed = await model.kernel.operations.read(owner.operationId);
  assert.equal(completed.status, 'valid');
  if (completed.status !== 'valid' || completed.value.compacted || completed.value.kind !== 'repair') { throw new Error('Expected completed reserved replay.'); }
  assert.deepEqual(published, [1]);
  assert.equal(completed.value.recovery.episodes.at(-1)?.acceptedRecovery?.sequence, 1);
  assert.equal(completed.value.recovery.activeEpisode, null);
});

test('reservation-only replay restore defers header loss to a damage episode', async () => {
  const { model } = completedReplayModel();
  const activationId = await crashAfterReplayReservation(model);
  model.memory.files.delete('journal/journal.json');
  const read = model.kernel.journal.read.bind(model.kernel.journal);
  model.kernel.journal.read = async () => {
    const snapshot = await read();
    return { ...snapshot, fault: snapshot.header.status === 'valid' ? null : 'header' };
  };
  const coordinator = new RecoveryCoordinator(model.kernel);
  await coordinator.reconcileSafety();
  const restored = await model.kernel.operations.read(owner.operationId);
  assert.equal(restored.status, 'valid');
  if (restored.status !== 'valid' || restored.value.compacted || restored.value.kind !== 'repair') { throw new Error('Expected reserved replay with pending header fault.'); }
  assert.equal(restored.value.plan.lastGoodSequence, 3);
  assert.equal(restored.value.recovery.episodes.at(-1)?.activationId, activationId);
  const interrupted = new Error('Stop after durable header transfer.');
  Object.assign(coordinator, { fileHash: memoryFileHash(model), executor: () => ({ execute: async () => { throw interrupted; } }) });
  await assert.rejects((coordinator as unknown as { runPrerequisite: (id: string) => Promise<void> }).runPrerequisite(owner.operationId), error => error === interrupted);
  const transferred = await model.kernel.operations.read(owner.operationId);
  assert.equal(transferred.status, 'valid');
  if (transferred.status !== 'valid' || transferred.value.compacted || transferred.value.kind !== 'repair') { throw new Error('Expected durable header transfer.'); }
  assert.equal(transferred.value.recovery.episodes.at(-1)?.trigger, 'header');
  assert.equal(transferred.value.plan.lastGoodSequence, 0);
});

test('readable invalid payload takes replacement while uncertain and unbound sources stop', async () => {
  for (const state of ['invalid', 'unreadable', 'unboundValid'] as const) {
    const { model, oldEvent } = completedReplayModel();
    const coordinator = new RecoveryCoordinator(model.kernel);
    await coordinator.plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() });
    const oldSource = replayOutbox(oldEvent.logicalOutboxId, 4, 0, oldEvent.recordSha256);
    model.kernel.outbox.read = async name => {
      if (state === 'unreadable') { throw new Error('Source inspection unavailable.'); }
      return state === 'invalid' ? { status: 'invalid', name, sha256: oldEvent.recordSha256 } : oldSource;
    };
    const stopped = new Error('Stop at core publication.');
    const published: number[] = [];
    model.kernel.publish = async (_force, record) => { published.push(record!.recovery.attempts.length - 1); throw stopped; };
    await assert.rejects(coordinator.resume(owner.operationId), error => state === 'invalid' ? error === stopped
      : error instanceof Error && (state === 'unreadable' ? /Source inspection unavailable/.test(error.message) : /without a proven original settlement binding/.test(error.message)));
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid');
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected durable replay authority.'); }
    assert.deepEqual(published, state === 'invalid' ? [1] : []);
    assert.equal(current.value.recovery.attempts.length, state === 'invalid' ? 2 : 1);
  }
});

test('observed-write crash keeps the receipt-time retired set fixed across later records', async () => {
  const { model, oldVersion, sources, published } = receiptCaptureModel();
  const cut = interruptAfterObservedWrite(model);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
  cut.restore();
  const observed = await model.kernel.operations.read(owner.operationId);
  assert.equal(observed.status, 'valid');
  if (observed.status !== 'valid' || observed.value.compacted || observed.value.kind !== 'repair') { throw new Error('Expected observed publication.'); }
  assert.equal(observed.value.recovery.attempts.at(-1)?.publication, 'observed');
  assert.deepEqual(observed.value.plan.retiredRecords, [{ name: oldVersion.name, logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }]);
  const oldHandoff = observed.value.plan.handoffs.find(item => item.logicalOutboxId === oldVersion.metadata.logicalOutboxId);
  assert.equal(oldHandoff?.presentation, 'unverified');
  assert.equal(oldHandoff.payloadBindingSha256, null);
  const capturedRetired = observed.value.plan.retiredRecords;
  const laterId = `${'b'.repeat(32)}-6`;
  const later = replayOutbox(laterId, 6, 0, '5'.repeat(64));
  sources.set(later.name, { ...later, metadata: { ...later.metadata, kind: 'consumed', repairOperationId: null, schemaVersion: 3 } });
  const stopped = new Error('Stop after checking durable retirement.');
  let drains = 0;
  model.kernel.drain = async () => {
    drains++;
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid');
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected retired repair authority.'); }
    assert.deepEqual(current.value.plan.retiredRecords, capturedRetired);
    assert.ok(!current.value.plan.handoffs.some(item => item.logicalOutboxId === laterId));
    throw stopped;
  };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === stopped);
  const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === stopped);
  assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable);
  assert.equal(drains, 2);
  assert.deepEqual(published, [0]);
});

test('a crash before the atomic observation retries the same core attempt', async () => {
  const { model, oldVersion, published } = receiptCaptureModel();
  const preflight = model.kernel.resources.preflight.bind(model.kernel.resources);
  const beforeUpdate = new Error('Stop before observed root publication.');
  Object.assign(model.kernel.resources, { preflight: async () => { throw beforeUpdate; } });
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === beforeUpdate);
  Object.assign(model.kernel.resources, { preflight });
  const before = await model.kernel.operations.read(owner.operationId);
  assert.equal(before.status, 'valid');
  if (before.status !== 'valid' || before.value.compacted || before.value.kind !== 'repair') { throw new Error('Expected the original due attempt.'); }
  assert.equal(before.value.recovery.attempts[0]?.publication, 'due');
  assert.equal(before.value.plan.retiredRecords.length, 0);
  const afterUpdate = interruptAfterObservedWrite(model);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === afterUpdate.interrupted);
  afterUpdate.restore();
  const observed = await model.kernel.operations.read(owner.operationId);
  assert.equal(observed.status, 'valid');
  if (observed.status !== 'valid' || observed.value.compacted || observed.value.kind !== 'repair') { throw new Error('Expected captured observed authority.'); }
  assert.deepEqual(published, [0, 0]);
  assert.equal(observed.value.recovery.attempts[0]?.publication, 'observed');
  assert.deepEqual(observed.value.plan.retiredRecords, [{ name: oldVersion.name, logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }]);
});

test('receipt capture reserves handoff growth before marking selection observed', async () => {
  const { model } = receiptCaptureModel();
  const reserve = model.kernel.resources.reserve.bind(model.kernel.resources);
  Object.assign(model.kernel.resources, { reserve: async (...args: Parameters<typeof model.kernel.resources.reserve>) => {
    if (args[1]?.retainedHandoffs === 1) { throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['retainedHandoffs'] }, 'repair'); }
    return reserve(...args);
  } });
  const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error instanceof RuntimeCapacityError && error.dimensions.includes('retainedHandoffs'));
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected due authority after capacity refusal.'); }
  assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable);
  assert.equal(current.value.recovery.attempts[0]?.publication, 'due');
});

test('observed-write crash records a surviving rejected source before drain', async () => {
  const rejectedName = 'event-0000000000000004.json';
  const rejectedHash = '6'.repeat(64);
  const initial = repair();
  const record = repair({ ...initial, cause: 'coreRejected', plan: { ...initial.plan, rejectedRecord: { name: rejectedName, sha256: rejectedHash } } });
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'coreRejected', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  model.memory.seed(`operations/${owner.operationId}.json`, record);
  const newId = `${'8'.repeat(32)}-5`;
  const newSource = replayOutbox(newId, 5, 0, '7'.repeat(64));
  model.kernel.outbox.read = async name => name === rejectedName ? { status: 'invalid', name, sha256: rejectedHash }
    : name === newSource.name ? newSource : { status: 'absent', name };
  model.kernel.outbox.list = async () => [newSource.name, rejectedName];
  let publications = 0;
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    publications++;
    const result = publishReceipt(newId, 5, 'committed');
    await accept?.(result);
    return result;
  };
  const cut = interruptAfterObservedWrite(model);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
  cut.restore();
  let drains = 0;
  model.kernel.drain = async () => { drains++; throw new Error('Rejected source reached drain.'); };
  await new RecoveryCoordinator(model.kernel).resume(owner.operationId);
  const terminal = await model.kernel.operations.read(owner.operationId);
  assert.equal(terminal.status, 'valid');
  if (terminal.status !== 'valid' || terminal.value.compacted || terminal.value.kind !== 'repair') { throw new Error('Expected rejected terminal authority.'); }
  assert.equal(terminal.value.outcome, 'recordRejected');
  assert.equal(terminal.value.recovery.episodes.at(-1)?.phase, 'recordRejected');
  assert.equal(drains, 0);
  assert.equal(publications, 1);
});

test('an observed selection without durable versions stops before drain', async () => {
  const selected = selectRecoveryRecord(repair(), { logicalOutboxId: `${'8'.repeat(32)}-5`, recordSha256: '7'.repeat(64) }, 'observed', null);
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  model.memory.seed(`operations/${owner.operationId}.json`, selected);
  let drains = 0;
  model.kernel.drain = async () => { drains++; throw new Error('Unknown versions reached drain.'); };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), ControlDocumentError);
  assert.equal(drains, 0);
});

test('changed bytes cannot reuse a retired identity or retained handoff', async () => {
  for (const prior of ['retiredRecord', 'handoff'] as const) {
    const { model, oldVersion } = receiptCaptureModel();
    const base = model.memory.value<RepairOperation>(`operations/${owner.operationId}.json`);
    const priorHash = '5'.repeat(64);
    const handoff = handoffFor(journalEvent(4, { adapter: 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: priorHash }));
    model.memory.seed(`operations/${owner.operationId}.json`, { ...base, plan: { ...base.plan,
      retiredRecords: prior === 'retiredRecord' ? [{ name: oldVersion.name, logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: priorHash }] : [],
      handoffs: prior === 'handoff' ? [handoff] : [] } });
    const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
    let drains = 0;
    model.kernel.drain = async () => { drains++; throw new Error('Conflicting bytes reached drain.'); };
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), ControlDocumentError, prior);
    assert.equal(drains, 0, prior);
    assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable, prior);
  }
});

test('deferred core quarantine never enters observed post-publication reconciliation', async () => {
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  model.memory.seed(`operations/${owner.operationId}.json`, repair());
  const logicalId = `${'8'.repeat(32)}-5`;
  const source = replayOutbox(logicalId, 5, 0, '7'.repeat(64));
  model.kernel.outbox.read = async name => name === source.name ? source : { status: 'absent', name };
  model.kernel.outbox.list = async () => [source.name];
  let publications = 0;
  model.kernel.publish = async (_force, _record, _deadline, accept) => {
    publications++;
    const receipt = publishReceipt(logicalId, 5, 'committed');
    if (!receipt.success) { throw new Error('Expected a successful modeled receipt.'); }
    const result = { ...receipt, value: { ...receipt.value, warnings: [{ code: 'outbox-quarantine-deferred', detail: null }] } };
    await accept?.(result);
    return result;
  };
  let drains = 0;
  model.kernel.drain = async () => { drains++; throw new Error('Deferred publication reached drain.'); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /Core quarantine remains deferred/);
  }
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected deferred repair authority.'); }
  assert.equal(current.value.recovery.attempts[0]?.publication, 'deferred');
  assert.equal(current.value.plan.retiredRecords.length, 0);
  assert.equal(publications, 2);
  assert.equal(drains, 0);
});

test('version retirement preserves an exact handoff binding while forbidding presentation', async () => {
  const { model, oldVersion } = receiptCaptureModel();
  const original = handoffFor(journalEvent(4, { adapter: 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }));
  const base = model.memory.value<RepairOperation>(`operations/${owner.operationId}.json`);
  model.memory.seed(`operations/${owner.operationId}.json`, { ...base, plan: { ...base.plan, handoffs: [original] } });
  const cut = interruptAfterObservedWrite(model);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
  cut.restore();
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected version retirement authority.'); }
  const retired = current.value.plan.handoffs.find(item => item.logicalOutboxId === oldVersion.metadata.logicalOutboxId);
  assert.deepEqual(retired, { ...original, presentation: 'rejected' });
});

test('receipt capture reuses an exact binding from another admitted repair', async () => {
  const { model, oldVersion } = receiptCaptureModel();
  const original = handoffFor(journalEvent(4, { adapter: 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }));
  seedExternalHandoff(model, original);
  const otherPath = `operations/jr-${'9'.repeat(32)}.json`;
  const other = model.memory.value<RepairOperation>(otherPath);
  model.memory.seed(otherPath, { ...other, plan: { ...other.plan,
    retiredRecords: [{ name: oldVersion.name, logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }] } });
  const cut = interruptAfterObservedWrite(model);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
  cut.restore();
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected captured cross-root binding.'); }
  assert.deepEqual(current.value.plan.handoffs.find(item => item.logicalOutboxId === original.logicalOutboxId), { ...original, presentation: 'rejected' });
});

test('a historical retired identity without its binding stops new receipt capture', async () => {
  const { model, oldVersion } = receiptCaptureModel();
  const original = handoffFor(journalEvent(4, { adapter: 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }));
  seedExternalHandoff(model, original);
  const otherPath = `operations/jr-${'9'.repeat(32)}.json`;
  const other = model.memory.value<RepairOperation>(otherPath);
  model.memory.seed(otherPath, { ...other, plan: { ...other.plan, handoffs: [],
    retiredRecords: [{ name: oldVersion.name, logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }] } });
  const admitted = await model.kernel.operations.read(other.operationId);
  assert.equal(admitted.status, 'valid');
  const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
  let drains = 0;
  model.kernel.drain = async () => { drains++; throw new Error('Unbound historical retirement reached drain.'); };
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /Historically retired source has no proven original settlement binding/);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected due root after missing historical binding.'); }
  assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable);
  assert.equal(current.value.recovery.attempts[0]?.publication, 'due');
  assert.equal(drains, 0);
});

test('receipt capture uses an exact current journal binding and refuses foreign journal evidence', async () => {
  for (const foreign of [false, true]) {
    const { model, oldVersion } = receiptCaptureModel();
    assert.notEqual(model.kernel.config.adapter, model.kernel.scope.game);
    const initial = await model.kernel.journal.read();
    assert.ok(initial.header.status === 'valid');
    if (initial.header.status !== 'valid') { throw new Error('Expected a valid journal header.'); }
    model.memory.seed('journal/journal.json', { ...initial.header.value, highWaterSequence: 4 });
    const event = journalEvent(4, { adapter: foreign ? 'foreign-game' : 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId,
      recordSha256: oldVersion.sha256, principal: 'principal' });
    const read = model.kernel.journal.read.bind(model.kernel.journal);
    model.kernel.journal.read = async () => ({ ...await read(), events: new Map([[4, { metadata: event, sha256: 'f'.repeat(64) }]]) });
    const cut = interruptAfterObservedWrite(model);
    if (foreign) {
      await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), ControlDocumentError);
      const current = await model.kernel.operations.read(owner.operationId);
      assert.equal(current.status, 'valid');
      if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected due authority after foreign evidence.'); }
      assert.equal(current.value.recovery.attempts[0]?.publication, 'due');
    } else {
      await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
      const current = await model.kernel.operations.read(owner.operationId);
      assert.equal(current.status, 'valid');
      if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected captured journal binding.'); }
      assert.deepEqual(current.value.plan.handoffs.find(item => item.logicalOutboxId === event.logicalOutboxId), { ...handoffFor(event), presentation: 'rejected' });
    }
    cut.restore();
  }
});

test('receipt capture refuses disappearing and unreadable candidate evidence', async () => {
  for (const state of ['disappeared', 'unreadable', 'operationInvalid'] as const) {
    const { model, oldVersion } = receiptCaptureModel();
    if (state === 'operationInvalid') { model.memory.files.set(`operations/jr-${'f'.repeat(32)}.json`, Buffer.from('{')); }
    else {
      const read = model.kernel.outbox.read.bind(model.kernel.outbox);
      model.kernel.outbox.read = async name => {
        if (name !== oldVersion.name) { return read(name); }
        if (state === 'unreadable') { throw new Error('Candidate source read failed.'); }
        return { status: 'absent', name };
      };
    }
    const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
    let drains = 0;
    model.kernel.drain = async () => { drains++; throw new Error('Unadmitted candidate reached drain.'); };
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error instanceof Error
      && (state === 'unreadable' ? /Candidate source read failed/.test(error.message) : state === 'operationInvalid'
        ? /unavailable operation authority/.test(error.message) : /Listed retired candidate disappeared before inspection/.test(error.message)), state);
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid');
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected original due authority.'); }
    assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable, state);
    assert.equal(current.value.recovery.attempts[0]?.publication, 'due', state);
    assert.equal(drains, 0, state);
  }
});

test('invalid and foreign sources never gain receipt-time retirement authority', async () => {
  for (const state of ['invalid', 'foreignGame', 'foreignPrincipal'] as const) {
    const { model, oldVersion } = receiptCaptureModel();
    const read = model.kernel.outbox.read.bind(model.kernel.outbox);
    model.kernel.outbox.read = async name => {
      if (name !== oldVersion.name) { return read(name); }
      if (state === 'invalid') { return { status: 'invalid', name, sha256: oldVersion.sha256 }; }
      return { ...oldVersion, metadata: { ...oldVersion.metadata,
        game: state === 'foreignGame' ? 'foreign-game' : oldVersion.metadata.game,
        principal: state === 'foreignPrincipal' ? 'foreign-principal' : oldVersion.metadata.principal } };
    };
    const cut = interruptAfterObservedWrite(model);
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
    cut.restore();
    const current = await model.kernel.operations.read(owner.operationId);
    assert.equal(current.status, 'valid');
    if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected scoped observed authority.'); }
    assert.equal(current.value.plan.retiredRecords.length, 0, state);
    assert.ok(!current.value.plan.handoffs.some(item => item.logicalOutboxId === oldVersion.metadata.logicalOutboxId), state);
  }
});

test('receipt capture refuses conflicting original bindings across repairs', async () => {
  const { model, oldVersion } = receiptCaptureModel();
  const currentBinding = handoffFor(journalEvent(4, { adapter: 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256 }));
  const base = model.memory.value<RepairOperation>(`operations/${owner.operationId}.json`);
  model.memory.seed(`operations/${owner.operationId}.json`, { ...base, plan: { ...base.plan, handoffs: [currentBinding] } });
  seedExternalHandoff(model, { ...currentBinding, journalId: 'different-journal', eventId: 'different-event', acceptance: null });
  const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), ControlDocumentError);
  assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable);
});

test('a selected source that contradicts receipt versions cannot authorize retirement', async () => {
  const { model, newSource } = receiptCaptureModel();
  const read = model.kernel.outbox.read.bind(model.kernel.outbox);
  model.kernel.outbox.read = async name => name === newSource.name ? { ...newSource, metadata: { ...newSource.metadata, schemaVersion: 3 } } : read(name);
  const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), ControlDocumentError);
  assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable);
});

test('a journaled historical selection cannot be replaced with a null binding', async () => {
  const { model, oldVersion } = receiptCaptureModel();
  const otherId = `jr-${'9'.repeat(32)}`;
  const event = journalEvent(4, { adapter: 'stubgame', logicalOutboxId: oldVersion.metadata.logicalOutboxId, recordSha256: oldVersion.sha256,
    type: 'state.resync', coreRepairOperationId: coreAttemptToken(otherId, 0), attemptRef: { operationId: otherId, attemptOrdinal: 0 },
    acceptance: { journalId: 'journal', eventId: '4'.padStart(32, '0'), generation } });
  const base = repair();
  let historical = repair({ ...base, operationId: otherId, plan: { ...base.plan, correctionId: null } });
  historical = selectRecoveryRecord(historical, { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }, 'observed', null);
  historical = bindRecoveryEvent(historical, event);
  historical = completeRecovery(checkpointRecovery(historical, event, generation, 1, at), 'journal', generation, at);
  model.memory.seed(`operations/${otherId}.json`, historical);
  const durable = Buffer.from(model.memory.files.get(`operations/${owner.operationId}.json`)!);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /Journaled retired source has no proven original settlement binding/);
  assert.deepEqual(model.memory.files.get(`operations/${owner.operationId}.json`), durable);
});

test('unverified fallback reserves all admitted event IDs before minting', async () => {
  const { model, oldVersion } = receiptCaptureModel();
  const unrelated = handoffFor(journalEvent(2, { adapter: 'stubgame' }));
  seedExternalHandoff(model, unrelated);
  let reserved = false;
  model.kernel.eventIdentity = async (_snapshot, _deadline, identities) => {
    reserved = identities?.includes(unrelated.eventId) === true;
    return 'c'.repeat(32);
  };
  const cut = interruptAfterObservedWrite(model);
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === cut.interrupted);
  cut.restore();
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected admitted fallback authority.'); }
  assert.equal(reserved, true);
  assert.equal(current.value.plan.handoffs.find(item => item.logicalOutboxId === oldVersion.metadata.logicalOutboxId)?.eventId, 'c'.repeat(32));
});

test('a second damage transfer caps an old floor at the acknowledged high water', async () => {
  const base = repair();
  const retained = handoffFor(journalEvent(2, { adapter: 'stubgame' }));
  const baseline = journal(5, 2);
  const first = await persistDamageTransfer(repair({ ...base, plan: { ...base.plan, lastGoodSequence: 2, handoffs: [retained] } }), baseline,
    () => ({ ...baseline, fault: 'gap', firstBadSequence: 5 }));
  assert.equal(first.record.plan.lastGoodSequence, 4);
  assert.equal(first.record.recovery.episodes.length, 2);
  const afterFirstActions = repair({ ...first.record, recovery: { ...first.record.recovery,
    episodes: first.record.recovery.episodes.map((episode, index) => index === first.record.recovery.activeEpisode
      ? { ...episode, phase: 'reconstructing', prerequisite: { ...episode.prerequisite!, nextAction: episode.prerequisite!.actions.length } } : episode) } });
  const nextJournal = journal(4, 2);
  const { record, model } = await persistDamageTransfer(afterFirstActions, nextJournal, model => ({ ...nextJournal, fault: null, firstBadSequence: null,
    damaged: [{ path: `${model.memory.scope.dataRoot}/journal/events/0000000000000001.json`, status: 'invalid', sha256: '8'.repeat(64) }] }));
  assert.equal(record.recovery.episodes.length, 3);
  assert.equal(record.recovery.episodes[1]?.phase, 'transferred');
  assert.equal(record.recovery.episodes[2]?.trigger, 'gap');
  assert.deepEqual(record.plan.handoffs, [retained]);
  assert.equal(record.recovery.attempts.length, 1);
  assert.equal(record.recovery.episodes[2]?.replacementAttempt, null);
  assert.equal(record.plan.lastGoodSequence, 2);
  const headerAction = record.recovery.episodes[2]?.prerequisite?.actions.find(action => action.kind === 'raiseHighWater');
  assert.ok(headerAction?.kind === 'raiseHighWater');
  assert.equal(headerAction.value.highWaterSequence, 2);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'transferring');
  await new RecoveryCoordinator(model.kernel).reconcileSafety();
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'active');
  const resumed = await model.kernel.operations.read(owner.operationId);
  assert.equal(resumed.status, 'valid');
  if (resumed.status !== 'valid' || resumed.value.compacted || resumed.value.kind !== 'repair') { throw new Error('Expected resumed damage authority.'); }
  assert.equal(resumed.value.plan.lastGoodSequence, 2);
});

test('a known first bad sequence retains the verified good prefix', async () => {
  const base = repair();
  const baseline = journal(6, 2);
  const { record } = await persistDamageTransfer(repair({ ...base, plan: { ...base.plan, lastGoodSequence: 2 } }), baseline,
    () => ({ ...baseline, fault: 'gap', firstBadSequence: 5 }));
  assert.equal(record.plan.lastGoodSequence, 4);
  const headerAction = record.recovery.episodes.at(-1)?.prerequisite?.actions.find(action => action.kind === 'raiseHighWater');
  assert.ok(headerAction?.kind === 'raiseHighWater');
  assert.equal(headerAction.value.highWaterSequence, 4);
});

test('a pending manifest cannot carry its old floor past the planned high water', async () => {
  const base = repair();
  const baseline = journal(5, 2);
  assert.ok(baseline.header.status === 'valid');
  if (baseline.header.status !== 'valid') { throw new Error('Expected a valid fixture header.'); }
  const lowered = { ...baseline.header.value, highWaterSequence: 2 };
  const prerequisite = { kind: 'gap' as const, actions: [{ kind: 'raiseHighWater' as const,
    target: { path: 'journal/journal.json', before: bytesHash(Buffer.from(stringifyJson(baseline.header.value))), after: bytesHash(Buffer.from(stringifyJson(lowered))) },
    value: lowered }], nextAction: 0, carry: null, carryRelease: null, skippedRanges: [] };
  const pending = repair({ ...base, plan: { ...base.plan, lastGoodSequence: 4 }, recovery: { ...base.recovery,
    episodes: [{ ...base.recovery.episodes[0]!, prerequisite }] } });
  const { record } = await persistDamageTransfer(pending, baseline, () => baseline);
  assert.equal(record.plan.lastGoodSequence, 2);
  assert.equal(record.recovery.episodes.at(-1)?.prerequisite?.kind, 'gap');
});
