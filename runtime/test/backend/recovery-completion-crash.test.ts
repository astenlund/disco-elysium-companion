import assert from 'node:assert/strict';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { hasProviderAuthority } from '../../src/backend/provider-authority.ts';
import type { JournalSnapshot } from '../../src/journal.ts';
import { coreAttemptToken } from '../../src/operation-records.ts';
import { bindRecoveryEvent, checkpointRecovery, selectRecoveryRecord } from '../../src/recovery-progress.ts';
import type { StateSafety } from '../../src/safety-records.ts';
import { at, authorityModel, correctionId, generation, journal, owner, repair, witness } from './authority-fixtures.ts';
import { journalEvent } from '../support/journal-event.ts';

const operationPath = `operations/${owner.operationId}.json`;

function prepared(withCorrection = true) {
  const event = journalEvent(1, { adapter: 'stubgame', type: 'state.resync', coreRepairOperationId: coreAttemptToken(owner.operationId, 0),
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 },
    acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation } });
  const base = repair();
  let record = repair({ cause: 'lostJournal', plan: { ...base.plan, correctionId: withCorrection ? base.plan.correctionId : null,
    publishedVersions: { schemaVersion: 2, adapterVersion: 1 } } });
  record = selectRecoveryRecord(record, { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }, 'observed', null);
  record = bindRecoveryEvent(record, event);
  record = checkpointRecovery(record, event, generation, 1, at);
  const baseSnapshot = journal(1, 0);
  assert.equal(baseSnapshot.header.status, 'valid');
  if (baseSnapshot.header.status !== 'valid') { throw new Error('Expected a valid fixture header.'); }
  const snapshot: JournalSnapshot = { ...baseSnapshot, header: { ...baseSnapshot.header, value: { ...baseSnapshot.header.value, historyVerified: false } },
    events: new Map(baseSnapshot.events).set(1, { metadata: event, sha256: 'f'.repeat(64) }) };
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: withCorrection ? { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId } : null,
    recoveryWitness: witness }, snapshot);
  model.memory.seed(operationPath, record);
  return model;
}

async function crashed(mode: 'intact' | 'missing' | 'unreadable', withCorrection = true) {
  const original = prepared(withCorrection);
  const interruption = new Error('Injected interruption before disclosure publication.');
  original.kernel.safetyStore.awaitDisclosure = async () => { throw interruption; };
  const coordinator = new RecoveryCoordinator(original.kernel) as unknown as { finalize: (operationId: string) => Promise<void> };
  await assert.rejects(coordinator.finalize(owner.operationId), error => error === interruption);
  const durable = new Map([...original.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const completedSnapshot = structuredClone(await original.kernel.journal.read());
  const snapshot: JournalSnapshot = mode === 'missing' ? { ...completedSnapshot, events: new Map(), fault: 'gap', firstBadSequence: 1 } : completedSnapshot;
  const safety = original.memory.value('state-safety.json') as StateSafety;
  const model = authorityModel(safety, snapshot);
  model.memory.files.clear();
  for (const [name, bytes] of durable) { model.memory.files.set(name, Buffer.from(bytes)); }
  if (mode === 'unreadable') { model.kernel.journal.read = async () => { throw new DataRootUnavailableError('Injected unreadable journal.'); }; }
  return model;
}

async function reboot(model: ReturnType<typeof authorityModel>) {
  const safety = model.memory.value('state-safety.json') as StateSafety;
  const snapshot = structuredClone(await model.kernel.journal.read());
  const next = authorityModel(safety, snapshot);
  next.memory.files.clear();
  for (const [name, bytes] of model.memory.files) { next.memory.files.set(name, Buffer.from(bytes)); }
  for (const name of model.memory.unreadable) { next.memory.unreadable.add(name); }
  return next;
}

test('same-identity recovery relocation refreshes the full destination reference', async () => {
  const original = journalEvent(3, { adapter: 'stubgame', type: 'state.resync', coreRepairOperationId: coreAttemptToken(owner.operationId, 0),
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 },
    acceptance: { journalId: 'journal', eventId: '3'.padStart(32, '0'), generation } });
  const restored = { ...original, sequence: 1 };
  let record = selectRecoveryRecord(repair({ cause: 'gap' }),
    { logicalOutboxId: original.logicalOutboxId, recordSha256: original.recordSha256 }, 'observed', null);
  record = bindRecoveryEvent(record, original);
  record = { ...record, recovery: { ...record.recovery, episodes: record.recovery.episodes.map(episode => ({ ...episode,
    prerequisite: { kind: 'gap', nextAction: 0, actions: [], carry: null, carryRelease: null, skippedRanges: [] } })) } };
  const initial = journal(1, 0);
  const snapshot: JournalSnapshot = { ...initial, events: new Map(initial.events).set(1, { metadata: restored, sha256: 'f'.repeat(64) }) };
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }, snapshot);
  model.memory.seed(operationPath, record);
  assert.deepEqual(await model.kernel.outbox.list(), []);
  const coordinator = new RecoveryCoordinator(model.kernel) as unknown as { runPrerequisite: (id: string) => Promise<void> };
  await coordinator.runPrerequisite(owner.operationId);
  const current = await model.kernel.operations.read(owner.operationId);
  assert.equal(current.status, 'valid');
  if (current.status !== 'valid' || current.value.compacted || current.value.kind !== 'repair') { throw new Error('Expected valid relocated recovery authority.'); }
  assert.deepEqual(current.value.recovery.attempts[0]?.journalEvent,
    { journalId: original.journalId, eventId: original.eventId, sequence: restored.sequence });
  assert.equal(checkpointRecovery(current.value, restored, generation, 1, at).recovery.episodes[0]?.acceptedRecovery?.sequence, 1);
  const writes = model.memory.writes.length;
  await coordinator.runPrerequisite(owner.operationId);
  assert.equal(model.memory.writes.length, writes);
});

test('intact completed recovery resumes exact disclosure without another episode', async () => {
  const model = await crashed('intact');
  await new RecoveryCoordinator(model.kernel).startup();
  const operation = await model.kernel.operations.read(owner.operationId);
  const safety = await model.kernel.safetyStore.read();
  assert.equal(operation.status, 'valid');
  assert.equal(safety.status, 'valid');
  if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair' || safety.status !== 'valid') { throw new Error('Expected valid recovered authority.'); }
  assert.equal(operation.value.recovery.activeEpisode, null);
  assert.equal(operation.value.recovery.episodes.length, 1);
  assert.equal(safety.value.recoveryWitness?.phase, 'awaitingDisclosure');
  assert.deepEqual(Object.keys(safety.value.recoveryWitness!.disclosure!).sort(), ['eventId', 'generation', 'journalId', 'sequence']);
  assert.equal(hasProviderAuthority(safety.value, await model.kernel.operations.list()), true);
  const before = model.memory.writes.length;
  await new RecoveryCoordinator(model.kernel).startup();
  assert.equal(model.memory.writes.length, before);
});

test('readably missing completed recovery checkpoint enters witnessed replay', async () => {
  const model = await crashed('missing');
  await new RecoveryCoordinator(model.kernel).reconcileSafety();
  const operation = await model.kernel.operations.read(owner.operationId);
  const safety = await model.kernel.safetyStore.read();
  assert.equal(operation.status, 'valid');
  assert.equal(safety.status, 'valid');
  if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair' || safety.status !== 'valid') { throw new Error('Expected valid replay authority.'); }
  assert.notEqual(operation.value.recovery.activeEpisode, null);
  assert.equal(operation.value.recovery.episodes[0]?.phase, 'completed');
  assert.equal(operation.value.recovery.episodes.at(-1)?.trigger, 'completedReplay');
  assert.equal(operation.value.recovery.episodes.at(-1)?.prerequisite?.kind, 'gap');
  assert.notEqual(safety.value.generation, generation);
  assert.equal(safety.value.correction?.reason, 'contextUncertain');
  assert.equal(safety.value.recoveryWitness?.phase, 'active');
});

test('missing checkpoint without a correction pointer replays the witnessed root', async () => {
  const model = await crashed('missing', false);
  await new RecoveryCoordinator(model.kernel).reconcileSafety();
  const inventory = await model.kernel.operations.list();
  const operation = await model.kernel.operations.read(owner.operationId);
  const safety = await model.kernel.safetyStore.read();
  assert.equal(operation.status, 'valid');
  assert.equal(safety.status, 'valid');
  if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair' || safety.status !== 'valid') { throw new Error('Expected valid replay authority.'); }
  assert.equal(inventory.records.length, 1);
  assert.notEqual(operation.value.recovery.activeEpisode, null);
  assert.equal(operation.value.recovery.episodes[0]?.phase, 'completed');
  assert.equal(operation.value.recovery.episodes.at(-1)?.trigger, 'completedReplay');
  assert.equal(operation.value.recovery.episodes.at(-1)?.prerequisite?.kind, 'gap');
  assert.equal(safety.value.correction?.recoveryOperationId, owner.operationId);
  assert.equal(operation.value.plan.correctionId, safety.value.correction?.correctionId);
});

test('finalized witnessed root loss transfers its obligation independently of the correction pointer', async () => {
  for (const phase of ['active', 'awaitingDisclosure'] as const) {
    for (const correction of ['none', 'unbound', 'bound'] as const) {
      for (const damage of ['absent', 'invalid'] as const) {
        for (const route of ['reconcile', 'startup'] as const) {
          let model = await crashed('intact', correction !== 'none');
          if (phase === 'awaitingDisclosure') { await new RecoveryCoordinator(model.kernel).reconcileSafety(); }
          if (correction === 'unbound') { await model.kernel.safetyStore.invalidate('contextUncertain'); }
          const beforeGeneration = (await model.kernel.safety()).generation;
          if (damage === 'absent') { model.memory.files.delete(operationPath); }
          else { model.memory.files.set(operationPath, Buffer.from('{')); }
          model.memory.writes.length = 0;
          let successor: string | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const coordinator = new RecoveryCoordinator(model.kernel);
            let resumes = 0;
            coordinator.resume = async () => { resumes++; };
            if (route === 'startup') { await coordinator.startup(async () => false); }
            else { await coordinator.reconcileSafety(); }
            const inventory = await model.kernel.operations.list();
            const safety = await model.kernel.safety();
            const record = inventory.records[0]?.record;
            assert.equal(inventory.records.length, 1);
            assert.ok(record !== undefined && !record.compacted && record.kind === 'repair');
            assert.equal(record.cause, 'operationLost');
            assert.deepEqual(record.plan.inheritedRecovery, owner);
            assert.equal(record.plan.handoffs.length, 1);
            assert.equal(record.plan.lostOperations.length, damage === 'invalid' ? 1 : 0);
            assert.notEqual(record.operationId, owner.operationId);
            assert.notEqual(safety.generation, beforeGeneration);
            assert.equal(safety.correction?.recoveryOperationId, record.operationId);
            assert.equal(safety.recoveryWitness?.phase, 'active');
            assert.equal(safety.recoveryWitness?.owner.operationId, record.operationId);
            assert.equal(resumes, route === 'startup' ? 1 : 0);
            if (successor === null) { successor = record.operationId; }
            else { assert.equal(record.operationId, successor); assert.equal(model.memory.writes.length, 0); }
            model = await reboot(model);
          }
        }
      }
    }
  }
});

test('lost-root successor construction resumes every durable transfer boundary', async () => {
  for (const boundary of ['invalidation', 'transfer', 'operation', 'activation', 'binding'] as const) {
    let model = await crashed('intact', false);
    model.memory.files.delete(operationPath);
    const write = model.memory.write.bind(model.memory);
    const interruption = new Error(`Injected lost-root ${boundary} crash.`);
    model.memory.write = async (relative, value, profile, expected, deadline) => {
      const result = await write(relative, value, profile, expected, deadline);
      const safety = relative === 'state-safety.json' ? value as StateSafety : null;
      const witness = safety?.recoveryWitness;
      if (boundary === 'invalidation' && safety?.correction !== null && safety?.correction !== undefined && witness?.owner.operationId === owner.operationId
        || boundary === 'transfer' && witness?.phase === 'transferring'
        || boundary === 'operation' && relative.startsWith('operations/') && relative !== operationPath
        || boundary === 'activation' && witness?.phase === 'active' && witness.owner.operationId !== owner.operationId && safety?.correction?.recoveryOperationId === null
        || boundary === 'binding' && safety?.correction?.recoveryOperationId != null && safety.correction.recoveryOperationId !== owner.operationId) { throw interruption; }
      return result;
    };
    await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), error => error === interruption, boundary);
    const partial = await model.kernel.safety();
    const reserved = partial.recoveryWitness?.phase === 'transferring' ? partial.recoveryWitness.successor!.operationId
      : partial.recoveryWitness?.owner.operationId !== owner.operationId ? partial.recoveryWitness?.owner.operationId : undefined;
    model = await reboot(model);
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    const inventory = await model.kernel.operations.list();
    const record = inventory.records[0]?.record;
    const safety = await model.kernel.safety();
    assert.equal(inventory.records.length, 1);
    assert.ok(record !== undefined && !record.compacted && record.kind === 'repair');
    assert.deepEqual(record.plan.inheritedRecovery, owner);
    assert.equal(safety.recoveryWitness?.owner.operationId, record.operationId);
    assert.equal(safety.correction?.recoveryOperationId, record.operationId);
    if (reserved !== undefined) { assert.equal(record.operationId, reserved); }
    const stable = new Map([...model.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    model = await reboot(model);
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    assert.deepEqual(model.memory.files, stable);
    assert.equal(model.memory.writes.length, 0);
  }
});

test('unreadable finalized witnessed roots stay unavailable across pointer forms and restart', async () => {
  for (const phase of ['active', 'awaitingDisclosure'] as const) {
    for (const correction of ['none', 'unbound', 'bound'] as const) {
      let model = await crashed('intact', correction !== 'none');
      if (phase === 'awaitingDisclosure') { await new RecoveryCoordinator(model.kernel).reconcileSafety(); }
      if (correction === 'unbound') { await model.kernel.safetyStore.invalidate('contextUncertain'); }
      model.memory.unreadable.add(operationPath);
      model.memory.writes.length = 0;
      const before = new Map([...model.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), DataRootUnavailableError);
        await assert.rejects(new RecoveryCoordinator(model.kernel).startup(), DataRootUnavailableError);
        assert.deepEqual(model.memory.files, before);
        assert.equal(model.memory.writes.length, 0);
        model = await reboot(model);
      }
    }
  }
});

test('an unbound correction pointer replays the same completed root', async () => {
  const model = await crashed('missing');
  const initial = model.memory.value('state-safety.json') as StateSafety;
  assert.notEqual(initial.correction, null);
  model.memory.seed('state-safety.json', { ...initial, correction: { ...initial.correction!, recoveryOperationId: null } });
  await new RecoveryCoordinator(model.kernel).reconcileSafety();
  const inventory = await model.kernel.operations.list();
  const safety = await model.kernel.safetyStore.read();
  assert.equal(inventory.records.length, 1);
  assert.equal(safety.status, 'valid');
  if (safety.status !== 'valid') { throw new Error('Expected valid correction authority.'); }
  assert.equal(safety.value.correction?.recoveryOperationId, owner.operationId);
  assert.equal(safety.value.recoveryWitness?.owner.operationId, owner.operationId);
});

test('later loss beside an awaiting disclosure replays its root with a transfer-safe trigger', async () => {
  const model = await crashed('intact', false);
  await new RecoveryCoordinator(model.kernel).reconcileSafety();
  const previous = await model.kernel.journal.read();
  const missing: JournalSnapshot = { ...previous, events: new Map(), fault: 'gap', firstBadSequence: 1 };
  await new RecoveryCoordinator(model.kernel).plan({ cause: 'gap', journal: missing });
  const inventory = await model.kernel.operations.list();
  const operation = await model.kernel.operations.read(owner.operationId);
  const safety = await model.kernel.safetyStore.read();
  assert.equal(inventory.records.length, 1);
  assert.equal(operation.status, 'valid');
  assert.equal(safety.status, 'valid');
  if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair' || safety.status !== 'valid') { throw new Error('Expected valid replay authority.'); }
  assert.equal(operation.value.recovery.episodes.at(-1)?.trigger, 'completedReplay');
  assert.equal(operation.value.recovery.episodes.at(-1)?.prerequisite?.kind, 'gap');
  assert.equal(safety.value.recoveryWitness?.phase, 'active');
  assert.equal(safety.value.correction?.recoveryOperationId, owner.operationId);
});

test('changed identity or acceptance reactivates completed recovery without a journal fault', async () => {
  for (const variant of ['identity', 'acceptance', 'journal'] as const) {
    const model = await crashed('intact');
    const read = model.kernel.journal.read.bind(model.kernel.journal);
    model.kernel.journal.read = async deadline => {
      const snapshot = structuredClone(await read(deadline));
      const event = snapshot.events.get(1)!;
      if (variant === 'journal') {
        assert.equal(snapshot.header.status, 'valid');
        assert.equal(snapshot.cursor.status, 'valid');
        if (snapshot.header.status !== 'valid' || snapshot.cursor.status !== 'valid') { throw new Error('Expected valid journal controls.'); }
        return { ...snapshot, header: { ...snapshot.header, value: { ...snapshot.header.value, journalId: 'changed-journal' } },
          cursor: { ...snapshot.cursor, value: { ...snapshot.cursor.value, journalId: 'changed-journal' } } };
      }
      const acceptance = event.metadata.acceptance;
      const metadata = variant === 'identity' ? { ...event.metadata, eventId: 'e'.repeat(32),
        acceptance: acceptance === null ? null : { ...acceptance, eventId: 'e'.repeat(32) } }
        : { ...event.metadata, acceptance: null };
      return { ...snapshot, events: new Map(snapshot.events).set(1, { ...event, metadata }) };
    };
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    const operation = await model.kernel.operations.read(owner.operationId);
    const safety = await model.kernel.safetyStore.read();
    assert.equal(operation.status, 'valid', variant);
    assert.equal(safety.status, 'valid', variant);
    if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair' || safety.status !== 'valid') { throw new Error('Expected valid replay authority.'); }
    assert.notEqual(operation.value.recovery.activeEpisode, null, variant);
    assert.equal(operation.value.recovery.episodes.at(-1)?.trigger, 'completedReplay', variant);
    assert.notEqual(safety.value.generation, generation, variant);
  }
});

test('a contradictory completed witness fails closed without changing durable bytes', async () => {
  const model = await crashed('intact');
  const initial = model.memory.value('state-safety.json') as StateSafety;
  assert.notEqual(initial.recoveryWitness, null);
  model.memory.seed('state-safety.json', { ...initial, recoveryWitness: { ...initial.recoveryWitness!,
    owner: { ...initial.recoveryWitness!.owner, activationId: 'f'.repeat(32) } } });
  const before = new Map([...model.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety());
  assert.deepEqual(model.memory.files, before);
  assert.equal(model.memory.writes.length, 0);
});

test('a completed root with a discharged correction identity cannot be silently rebound', async () => {
  const model = await crashed('missing', false);
  const record = model.memory.value(operationPath) as ReturnType<typeof repair>;
  model.memory.seed(operationPath, { ...record, plan: { ...record.plan, correctionId } });
  const before = new Map([...model.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety());
  assert.deepEqual(model.memory.files, before);
  assert.equal(model.memory.writes.length, 0);
});

test('completed replay resumes each partial witness transfer without replacing its root', async () => {
  for (const boundary of ['invalidation', 'transfer', 'operation', 'activation'] as const) {
    let model = await crashed('missing');
    const write = model.memory.write.bind(model.memory);
    let safetyWrites = 0;
    let operationWrites = 0;
    const interruption = new Error(`Injected ${boundary} crash.`);
    model.memory.write = async (relative, value, profile, expected, deadline) => {
      const result = await write(relative, value, profile, expected, deadline);
      if (relative === 'state-safety.json') { safetyWrites++; }
      if (relative === operationPath) { operationWrites++; }
      if (boundary === 'invalidation' && safetyWrites === 1 || boundary === 'transfer' && safetyWrites === 2
        || boundary === 'operation' && operationWrites === 1 || boundary === 'activation' && safetyWrites === 3) { throw interruption; }
      return result;
    };
    await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), error => error === interruption, boundary);
    model = await reboot(model);
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    const operation = await model.kernel.operations.read(owner.operationId);
    const safety = await model.kernel.safetyStore.read();
    assert.equal(operation.status, 'valid');
    assert.equal(safety.status, 'valid');
    if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair' || safety.status !== 'valid') { throw new Error('Expected valid replay authority.'); }
    assert.equal((await model.kernel.operations.list()).records.length, 1, boundary);
    assert.equal(operation.value.recovery.episodes[0]?.phase, 'completed', boundary);
    assert.equal(operation.value.recovery.episodes.at(-1)?.trigger, 'completedReplay', boundary);
    assert.equal(safety.value.recoveryWitness?.phase, 'active', boundary);
    assert.equal(safety.value.recoveryWitness.owner.operationId, owner.operationId, boundary);
    const active = safety.value.recoveryWitness.owner.activationId;
    model = await reboot(model);
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    const repeated = await model.kernel.safetyStore.read();
    assert.equal(repeated.status, 'valid');
    if (repeated.status !== 'valid') { throw new Error('Expected valid repeated authority.'); }
    assert.equal(repeated.value.recoveryWitness?.owner.activationId, active, boundary);
  }
});

test('unreadable completed recovery checkpoint preserves durable obligations', async () => {
  const model = await crashed('unreadable');
  const before = new Map([...model.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), DataRootUnavailableError);
  assert.deepEqual(model.memory.files, before);
  assert.equal(model.memory.writes.length, 0);
});

test('unreadable completed recovery operation preserves durable obligations', async () => {
  const model = await crashed('intact');
  model.memory.unreadable.add(operationPath);
  const before = new Map([...model.memory.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), DataRootUnavailableError);
  assert.deepEqual(model.memory.files, before);
  assert.equal(model.memory.writes.length, 0);
});
