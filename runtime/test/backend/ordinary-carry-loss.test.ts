import assert from 'node:assert/strict';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { RecoveryCoordinator, handoffFor } from '../../src/backend/recovery.ts';
import { eventRewriteMetadata } from '../../src/journal-records.ts';
import { requireRepair } from '../../src/operations.ts';
import type { ManifestObservation, PayloadSource, RecoveryAction } from '../../src/recovery-manifest.ts';
import { bytesHash } from '../../src/storage.ts';
import { stringifyJson } from '../../src/json.ts';
import { journalEvent } from '../support/journal-event.ts';
import { authorityModel, correctionId, generation, installEventInspectionFixture, journal, owner, repair, witness } from './authority-fixtures.ts';

const operationPath = `operations/${owner.operationId}.json`;
const eventPath = 'journal/events/0000000000000001.json';
const carryPath = 'journal/recovery-event.json';
const quarantinePath = `quarantine/0000000000000001.json.${'9'.repeat(32)}.quarantined`;
const hashValue = (value: unknown): string => bytesHash(Buffer.from(stringifyJson(value)));

interface FixtureOptions { readonly outboxSource?: boolean; readonly invalidSlot?: boolean; readonly invalidOriginal?: boolean; readonly unstableSlot?: boolean;
  readonly restoredDestination?: boolean; readonly headerFault?: boolean; readonly simulateCarryQuarantine?: boolean;
  readonly stopAt?: 'preserveRecovery' | 'quarantine' | 'raiseHighWater' }

function fixture(options: FixtureOptions = {}) {
  const snapshot = journal();
  assert.equal(snapshot.header.status, 'valid');
  assert.equal(snapshot.cursor.status, 'valid');
  if (snapshot.header.status !== 'valid' || snapshot.cursor.status !== 'valid') { throw new Error('Expected valid journal controls.'); }
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }, snapshot);
  const outboxBytes = Buffer.from('modeled valid original outbox record bytes');
  const event = journalEvent(1, { adapter: 'stubgame', type: 'state.resync', coreRepairOperationId: owner.operationId,
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 }, recordSha256: bytesHash(outboxBytes) });
  const metadata = eventRewriteMetadata(event);
  const original = Buffer.from('original modeled event bytes');
  const carry = Buffer.from('protected modeled event bytes');
  const restored = Buffer.from('restored modeled event bytes');
  const raised = { ...snapshot.header.value, highWaterSequence: 1 };
  const actions = [
    { kind: 'preserveRecovery', target: { path: carryPath, before: null, after: bytesHash(carry) },
      source: { root: 'scope', path: eventPath, sha256: bytesHash(original), payloadBindingSha256: event.payloadBindingSha256 }, metadata },
    { kind: 'quarantine', source: { path: eventPath, before: bytesHash(original), after: null },
      target: { path: quarantinePath, before: null, after: bytesHash(original) } },
    { kind: 'publishCursor', target: { path: 'journal/cursor-agent-session.json', before: hashValue(snapshot.cursor.value), after: hashValue(snapshot.cursor.value) },
      value: snapshot.cursor.value },
    { kind: 'raiseHighWater', target: { path: 'journal/journal.json', before: hashValue(raised), after: hashValue(snapshot.header.value) }, value: snapshot.header.value },
    { kind: 'appendRecovery', target: { path: eventPath, before: null, after: bytesHash(restored) },
      source: { root: 'scope', path: carryPath, sha256: bytesHash(carry), payloadBindingSha256: event.payloadBindingSha256 }, metadata },
    { kind: 'raiseHighWater', target: { path: 'journal/journal.json', before: hashValue(snapshot.header.value), after: hashValue(raised) }, value: raised },
    { kind: 'removeCarry', target: { path: carryPath, before: bytesHash(carry), after: null } },
  ] as const;
  const base = repair();
  let record = repair({ ...base, plan: { ...base.plan, affected: [{ sequence: 1, eventId: event.eventId, fileSha256: bytesHash(original) }],
    handoffs: [handoffFor(event)], publishedVersions: { schemaVersion: event.schemaVersion, adapterVersion: event.adapterVersion } },
  recovery: { attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 },
    journalEvent: { journalId: event.journalId, eventId: event.eventId, sequence: 1 } }], activeEpisode: 0,
  episodes: [{ ...base.recovery.episodes[0]!, phase: 'reconstructing', prerequisite: { kind: 'gap', actions, nextAction: 4,
    carry: { path: carryPath, sha256: bytesHash(carry) }, carryRelease: null, skippedRanges: [] } }] } });
  if (options.invalidOriginal) {
    const episode = record.recovery.episodes[0]!;
    assert.ok(episode.prerequisite !== null);
    record = repair({ ...record, recovery: { ...record.recovery,
      episodes: [{ ...episode, prerequisite: { ...episode.prerequisite!, nextAction: 0 } }] } });
  }
  model.memory.seed(operationPath, record);
  if (options.invalidOriginal) {
    const damaged = Buffer.from('{');
    model.memory.files.set(eventPath, damaged);
    model.memory.seed('journal/journal.json', raised);
    const readJournal = model.kernel.journal.read.bind(model.kernel.journal);
    model.kernel.journal.read = async () => ({ ...await readJournal(), fault: 'gap', firstBadSequence: 1, events: new Map(),
      damaged: [{ path: `${model.memory.scope.dataRoot}/${eventPath}`, status: 'invalid', sha256: bytesHash(damaged) }] });
  } else { model.memory.files.set(quarantinePath, original); }
  if (options.headerFault) {
    model.memory.files.delete('journal/journal.json');
    const readJournal = model.kernel.journal.read.bind(model.kernel.journal);
    model.kernel.journal.read = async () => {
      const current = await readJournal();

      return { ...current, fault: current.header.status === 'valid' ? current.fault : 'header' };
    };
  }
  if (options.invalidSlot) { model.memory.files.set(carryPath, Buffer.from('invalid protected carry bytes')); }
  if (options.restoredDestination) { model.memory.files.set(eventPath, restored); }
  let slotReads = 0;
  installEventInspectionFixture(model.kernel, async (relative, sequence) => {
    assert.ok(!relative.startsWith('quarantine/'));
    assert.ok(relative === carryPath && sequence === 0 || relative.startsWith('journal/events/') && sequence > 0);
    if (relative === carryPath && options.unstableSlot) {
      slotReads += 1;

      return slotReads === 1 ? { status: 'absent', sha256: null, metadata: null }
        : { status: 'invalid', sha256: bytesHash(Buffer.from('changed between reads')), metadata: null };
    }
    const admission = await model.memory.inspect(model.memory.scope.dataRoot, relative, true);
    if (!admission.exists) { return { status: 'absent', sha256: null, metadata: null }; }
    const bytes = model.memory.files.get(relative);
    assert.ok(bytes !== undefined);
    if (relative === eventPath && options.restoredDestination && bytesHash(bytes) === bytesHash(restored)) {
      return { status: 'valid', sha256: bytesHash(bytes), metadata: { ...metadata, payloadBindingSha256: event.payloadBindingSha256,
        targetIdentitySha256: event.targetIdentitySha256, stateGeneratedAt: event.stateGeneratedAt } };
    }

    return { status: 'invalid', sha256: bytesHash(bytes), metadata: null };
  });
  let coreCalls = 0;
  model.kernel.core.publish = async () => { coreCalls += 1; throw new Error('FAKE_CORE_BOUNDARY'); };
  model.kernel.core.settle = async () => { coreCalls += 1; throw new Error('FAKE_CORE_BOUNDARY'); };
  model.kernel.outbox.read = async name => options.outboxSource ? { status: 'valid', name, sha256: bytesHash(outboxBytes), bytes: outboxBytes,
    receipt: { sourceInspection: true }, metadata: { stateEventVersion: 1, logicalOutboxId: event.logicalOutboxId, incarnationId: event.logicalOutboxId.slice(0, 32),
      sequence: 1, kind: 'resync', createdAt: event.occurredAt, principal: event.principal, repairOperationId: event.coreRepairOperationId,
      adapterVersion: event.adapterVersion, game: event.adapter, schemaVersion: event.schemaVersion,
      targetIdentitySha256: event.targetIdentitySha256!, stateGeneratedAt: event.stateGeneratedAt! } } : { status: 'absent', name };
  model.kernel.codec.previewEvent = async target => ({ sha256: target === carryPath ? bytesHash(carry) : bytesHash(restored), metadata: {}, cleanupComplete: true });
  model.kernel.codec.rewriteEvent = async () => {
    model.memory.files.set(eventPath, restored);

    return { sha256: bytesHash(restored), metadata: {}, bytes: restored, cleanupComplete: true };
  };
  let actionBoundary = options.stopAt;
  const coordinator = () => {
    const instance = new RecoveryCoordinator(model.kernel);
    const internals = instance as unknown as { executor: (id: string) => { observe: (action: RecoveryAction) => Promise<ReadonlyMap<string, ManifestObservation>>;
      execute: (action: RecoveryAction) => Promise<'alreadyApplied' | 'applied'> }; readRecoverySource: (source: PayloadSource) => Promise<Buffer>;
      fileHash: (relative: string) => Promise<string | null> };
    internals.fileHash = async relative => {
      const admission = await model.memory.inspect(model.memory.scope.dataRoot, relative, true);
      if (!admission.exists) { return null; }
      const bytes = model.memory.files.get(relative);
      assert.ok(bytes !== undefined);

      return bytesHash(bytes);
    };
    const readSource = internals.readRecoverySource.bind(instance);
    internals.readRecoverySource = async source => {
      if (source.root !== 'companion') { return readSource(source); }
      assert.equal(options.outboxSource, true);
      assert.equal(source.sha256, bytesHash(outboxBytes));

      return outboxBytes;
    };
    const executor = internals.executor.bind(instance);
    internals.executor = id => {
      const value = executor(id);
      const execute = value.execute.bind(value);
      value.execute = async action => {
        if (action.kind === actionBoundary) { throw new Error('FAKE_ACTION_BOUNDARY'); }
        if (options.simulateCarryQuarantine && action.kind === 'quarantine' && action.source.path === carryPath) {
          const source = model.memory.files.get(action.source.path);
          const target = model.memory.files.get(action.target.path);
          if (source !== undefined && bytesHash(source) === action.source.before && target === undefined) {
            model.memory.files.delete(action.source.path);
            model.memory.files.set(action.target.path, source);

            return 'applied';
          }
          if (source === undefined && target !== undefined && bytesHash(target) === action.target.after) { return 'alreadyApplied'; }
          throw new Error('FAKE_QUARANTINE_PREIMAGE_MISMATCH');
        }

        return execute(action);
      };
      value.observe = async action => new Map((action.kind === 'quarantine' ? [action.source, action.target] : [action.target]).map(change => {
        const bytes = model.memory.files.get(change.path);
        return [change.path, { status: 'readable' as const, sha256: bytes === undefined ? null : bytesHash(bytes) }] as const;
      }));
      return value;
    };
    return instance;
  };
  return { model, record, coordinator, setActionBoundary: (value: FixtureOptions['stopAt']) => { actionBoundary = value; },
    get coreCalls() { return coreCalls; } };
}

test('missing ordinary carry transfers to one durable missing-payload replacement', async () => {
  const current = fixture();
  const { model, record, coordinator } = current;
  await assert.rejects(coordinator().startup());
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.attempts.length, 2);
  assert.equal(stored.recovery.episodes[0]?.phase, 'transferred');
  const active = stored.recovery.episodes[stored.recovery.activeEpisode!]!;
  assert.equal(active.trigger, 'recoveryMissing');
  assert.equal(active.replacementAttempt, 1);
  assert.equal(active.prerequisite?.carry, null);
  assert.equal(active.prerequisite?.carryRelease, null);
  assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
  assert.ok(current.coreCalls > 0);
  await assert.rejects(coordinator().startup());
  const repeatedFound = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(repeatedFound);
  const repeated = requireRepair(repeatedFound);
  assert.equal(repeated.recovery.attempts.length, 2);
});

test('unreadable ordinary carry inspection preserves the original recovery authority', async () => {
  const { model, record, coordinator } = fixture();
  model.memory.unreadable.add(carryPath);
  await assert.rejects(coordinator().startup(), DataRootUnavailableError);
  assert.deepEqual((await model.records()).find(value => value.operationId === owner.operationId), record);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
});
test('changing carry observations cannot authorize missing-payload replacement', async () => {
  const { model, record, coordinator } = fixture({ unstableSlot: true });
  await assert.rejects(coordinator().startup());
  assert.deepEqual((await model.records()).find(value => value.operationId === owner.operationId), record);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
});

test('a surviving exact outbox source gets a durable new preservation plan', async () => {
  const { model, record, coordinator } = fixture({ outboxSource: true, stopAt: 'preserveRecovery' });
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.attempts.length, 1);
  const active = stored.recovery.episodes[stored.recovery.activeEpisode!]!;
  assert.equal(active.trigger, 'recoveryMissing');
  assert.equal(active.replacementAttempt, null);
  const pending = active.prerequisite?.actions[active.prerequisite.nextAction];
  assert.ok(pending?.kind === 'preserveRecovery');
  assert.equal(pending.source.root, 'companion');
  assert.equal(pending.source.sha256, record.plan.handoffs[0]?.recordSha256);
  assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
});

test('a content-invalid occupied slot is quarantined before missing-payload replacement', async () => {
  const { model, record, coordinator } = fixture({ invalidSlot: true, stopAt: 'quarantine' });
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.attempts.length, 2);
  const active = stored.recovery.episodes[stored.recovery.activeEpisode!]!;
  assert.equal(active.trigger, 'recoveryMissing');
  assert.equal(active.replacementAttempt, 1);
  assert.equal(active.prerequisite?.carry, null);
  const pending = active.prerequisite?.actions[active.prerequisite.nextAction];
  assert.ok(pending?.kind === 'quarantine');
  assert.equal(pending.source.path, carryPath);
  assert.equal(pending.source.before, bytesHash(model.memory.files.get(carryPath)!));
  assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
});

test('a durable append postimage survives lost progress even after the carry disappears', async () => {
  const { model, coordinator } = fixture({ restoredDestination: true, stopAt: 'raiseHighWater' });
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.attempts.length, 1);
  assert.equal(stored.recovery.episodes.length, 1);
  const active = stored.recovery.episodes[0]!;
  assert.equal(active.prerequisite?.nextAction, 5);
  assert.equal(active.prerequisite?.actions[5]?.kind, 'raiseHighWater');
});

test('concurrent header damage remains in the missing-payload successor plan', async () => {
  const { model, record, coordinator } = fixture({ headerFault: true, stopAt: 'quarantine' });
  await assert.rejects(coordinator().startup(), error => error instanceof Error && error.name === 'RecoveryDamageError');
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.attempts.length, 2);
  const active = stored.recovery.episodes[stored.recovery.activeEpisode!]!;
  assert.equal(active.trigger, 'recoveryMissing');
  assert.equal(active.replacementAttempt, 1);
  assert.equal(active.prerequisite?.carry, null);
  assert.equal((await model.kernel.journal.read()).fault, 'header');
  assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const repeated = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(repeated);
  assert.equal(requireRepair(repeated).recovery.attempts.length, 2);
  const resumed = requireRepair(repeated).recovery.episodes[requireRepair(repeated).recovery.activeEpisode!]!;
  assert.ok(resumed.prerequisite?.actions.slice(resumed.prerequisite.nextAction).some(action => action.kind === 'publishHeader'));
});

test('a reserved owner transfer resumes the same missing-payload attempt', async () => {
  const { model, record, coordinator } = fixture();
  const successor = { operationId: owner.operationId, episodeOrdinal: 1, activationId: '4'.repeat(32) };
  await model.kernel.safetyStore.prepareTransfer(successor);
  await coordinator().reconcileSafety();
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.attempts.length, 2);
  assert.equal(stored.recovery.episodes[1]?.trigger, 'recoveryMissing');
  assert.equal(stored.recovery.episodes[1]?.activationId, successor.activationId);
  assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
  await assert.rejects(coordinator().startup());
  const repeated = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(repeated);
  assert.equal(requireRepair(repeated).recovery.attempts.length, 2);
});

for (const outboxSource of [false, true]) {
  test(`a content-invalid original before quarantine ${outboxSource ? 'preserves exact outbox bytes' : 'selects missing-payload replacement'}`, async () => {
    const { model, record, coordinator } = fixture({ invalidOriginal: true, outboxSource, stopAt: outboxSource ? 'preserveRecovery' : 'quarantine' });
    await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
    const found = (await model.records()).find(value => value.operationId === owner.operationId);
    assert.ok(found);
    const stored = requireRepair(found);
    assert.equal(stored.recovery.attempts.length, outboxSource ? 1 : 2);
    const active = stored.recovery.episodes[stored.recovery.activeEpisode!]!;
    assert.equal(active.trigger, 'recoveryMissing');
    assert.equal(active.replacementAttempt, outboxSource ? null : 1);
    const pending = active.prerequisite?.actions.slice(active.prerequisite.nextAction) ?? [];
    assert.ok(pending.some(action => action.kind === 'quarantine' && action.source.path === eventPath && action.source.before === bytesHash(Buffer.from('{'))));
    assert.equal(pending.some(action => action.kind === 'preserveRecovery' && action.source.root === 'companion'), outboxSource);
    assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
    assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
    await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
    const repeated = (await model.records()).find(value => value.operationId === owner.operationId);
    assert.ok(repeated);
    assert.equal(requireRepair(repeated).recovery.attempts.length, outboxSource ? 1 : 2);
  });
}

for (const invalidSlot of [false, true]) {
  test(`reserved header reconstruction decodes the actual outbox source with invalid slot ${invalidSlot}`, async () => {
    const { model, record, coordinator } = fixture({ outboxSource: true, headerFault: true, invalidSlot });
    const calls: { target: string; sourceKind: string; outboxBytes: boolean }[] = [];
    const preview = model.kernel.codec.previewEvent.bind(model.kernel.codec);
    model.kernel.codec.previewEvent = async (...args) => {
      const [target, bytes, , sourceKind] = args;
      calls.push({ target, sourceKind, outboxBytes: Buffer.from(bytes).equals(Buffer.from('modeled valid original outbox record bytes')) });

      return preview(...args);
    };
    const successor = { operationId: owner.operationId, episodeOrdinal: 1, activationId: '4'.repeat(32) };
    await model.kernel.safetyStore.prepareTransfer(successor);
    await coordinator().reconcileSafety();
    const outboxCalls = calls.filter(call => call.outboxBytes);
    assert.ok(outboxCalls.length >= 2);
    assert.ok(outboxCalls.every(call => call.sourceKind === 'outbox'));
    assert.ok(outboxCalls.some(call => call.target === carryPath));
    assert.ok(outboxCalls.some(call => call.target.startsWith('journal/events/')));
    const found = (await model.records()).find(value => value.operationId === owner.operationId);
    assert.ok(found);
    const stored = requireRepair(found);
    assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
    assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
  });
}

for (const headerFault of [false, true]) {
  test(`a planned invalid-carry quarantine resumes under header fault ${headerFault}`, async () => {
    const current = fixture({ outboxSource: true, invalidSlot: true, headerFault, stopAt: 'quarantine' });
    const { model, record, coordinator } = current;
    if (headerFault) {
      await model.kernel.safetyStore.prepareTransfer({ operationId: owner.operationId, episodeOrdinal: 1, activationId: '4'.repeat(32) });
      await coordinator().reconcileSafety();
    } else { await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/); }
    for (let restart = 0; restart < 2; restart++) {
      await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
      const found = (await model.records()).find(value => value.operationId === owner.operationId);
      assert.ok(found);
      const stored = requireRepair(found);
      assert.equal(stored.recovery.episodes.length, 2);
      assert.equal(stored.recovery.attempts.length, 1);
      const active = stored.recovery.episodes[stored.recovery.activeEpisode!]!;
      const pending = active.prerequisite?.actions[active.prerequisite.nextAction];
      assert.ok(pending?.kind === 'quarantine');
      assert.equal(pending.source.path, carryPath);
      assert.equal(pending.source.before, bytesHash(model.memory.files.get(carryPath)!));
      assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
      assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
      assert.equal(current.coreCalls, 0);
    }
  });
}

test('a completed invalid-carry quarantine with lost progress resumes its preservation', async () => {
  const { model, coordinator, setActionBoundary } = fixture({ outboxSource: true, invalidSlot: true, stopAt: 'quarantine' });
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const initial = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(initial);
  const pending = requireRepair(initial).recovery.episodes[1]?.prerequisite?.actions[0];
  assert.ok(pending?.kind === 'quarantine');
  const invalid = model.memory.files.get(carryPath);
  assert.ok(invalid !== undefined);
  model.memory.files.delete(carryPath);
  model.memory.files.set(pending.target.path, invalid);
  setActionBoundary('preserveRecovery');
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const found = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(found);
  const stored = requireRepair(found);
  assert.equal(stored.recovery.episodes.length, 2);
  assert.equal(stored.recovery.attempts.length, 1);
  assert.equal(stored.recovery.episodes[1]?.prerequisite?.actions[stored.recovery.episodes[1]!.prerequisite!.nextAction]?.kind, 'preserveRecovery');
});

for (const sourceState of ['absent', 'invalid'] as const) {
  for (const quarantineMoved of [false, true]) {
    test(`source ${sourceState} after recorded carry quarantine, moved ${quarantineMoved}, enters one replacement`, async () => {
      const current = fixture({ outboxSource: true, invalidSlot: true, stopAt: 'quarantine', simulateCarryQuarantine: true });
      const { model, record, coordinator, setActionBoundary } = current;
      await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
      const planned = (await model.records()).find(value => value.operationId === owner.operationId);
      assert.ok(planned);
      const currentPlan = requireRepair(planned).recovery.episodes[1]?.prerequisite;
      const cleanup = currentPlan?.actions[currentPlan.nextAction];
      assert.ok(cleanup?.kind === 'quarantine' && cleanup.source.path === carryPath);
      if (quarantineMoved) {
        const bytes = model.memory.files.get(carryPath);
        assert.ok(bytes !== undefined);
        model.memory.files.delete(carryPath);
        model.memory.files.set(cleanup.target.path, bytes);
      }
      model.kernel.outbox.read = async name => sourceState === 'absent'
        ? { status: 'absent', name }
        : { status: 'invalid', name, sha256: bytesHash(Buffer.from('{')) };
      setActionBoundary(undefined);
      for (let restart = 0; restart < 2; restart++) {
        await assert.rejects(coordinator().startup(), /FAKE_CORE_BOUNDARY/);
        const found = (await model.records()).find(value => value.operationId === owner.operationId);
        assert.ok(found);
        const stored = requireRepair(found);
        assert.equal(stored.recovery.attempts.length, 2);
        assert.equal(stored.recovery.episodes.length, 3);
        const successor = stored.recovery.episodes[2]?.prerequisite;
        assert.ok(successor);
        const carriedCleanup = successor.actions.find(action => action.kind === 'quarantine' && action.source.path === carryPath);
        assert.ok(carriedCleanup?.kind === 'quarantine');
        assert.equal(carriedCleanup.target.path, cleanup.target.path);
        assert.equal(successor.actions.filter(action => action.kind === 'quarantine' && action.source.path === carryPath).length, 1);
        assert.deepEqual(stored.plan.handoffs, record.plan.handoffs);
        assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
        assert.equal(model.memory.files.has(carryPath), false);
        assert.equal(bytesHash(model.memory.files.get(cleanup.target.path)!), cleanup.target.after);
      }
      assert.ok(current.coreCalls > 0);
    });
  }
}

test('unreadable source after recorded carry cleanup preserves the pending plan', async () => {
  const { model, coordinator } = fixture({ outboxSource: true, invalidSlot: true, stopAt: 'quarantine' });
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const before = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(before);
  model.kernel.outbox.read = async () => { throw new DataRootUnavailableError('Modeled source admission failure.'); };
  await assert.rejects(coordinator().startup(), DataRootUnavailableError);
  assert.deepEqual((await model.records()).find(value => value.operationId === owner.operationId), before);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
});

test('conflicting recorded quarantine target cannot authorize replacement', async () => {
  const { model, coordinator } = fixture({ outboxSource: true, invalidSlot: true, stopAt: 'quarantine' });
  await assert.rejects(coordinator().startup(), /FAKE_ACTION_BOUNDARY/);
  const before = (await model.records()).find(value => value.operationId === owner.operationId);
  assert.ok(before);
  const plan = requireRepair(before).recovery.episodes[1]?.prerequisite;
  const cleanup = plan?.actions[plan.nextAction];
  assert.ok(cleanup?.kind === 'quarantine');
  model.memory.files.set(cleanup.target.path, Buffer.from('conflicting quarantine destination'));
  await assert.rejects(coordinator().startup());
  assert.deepEqual((await model.records()).find(value => value.operationId === owner.operationId), before);
  assert.equal((await model.kernel.safety()).correction?.correctionId, correctionId);
});
