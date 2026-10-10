import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { coreAttemptToken, type RepairOperation } from '../../src/operation-records.ts';
import { abandonRecovery, bindRecoveryEvent, checkpointRecovery, replacementCandidate, selectRecoveryRecord, transferEpisode } from '../../src/recovery-progress.ts';
import { carryReleaseResolved, type RecoveryAction } from '../../src/recovery-manifest.ts';
import { validateOperationTransition } from '../../src/operations.ts';
import type { StateSafety } from '../../src/safety-records.ts';
import { bytesHash } from '../../src/storage.ts';
import { stringifyJson } from '../../src/json.ts';
import type { OutboxRead } from '../../src/outbox.ts';
import { journalEvent } from '../support/journal-event.ts';
import { at, authorityModel, deferredRepair, generation, journal, owner, release, repair, stubJournalTransaction, witness } from './authority-fixtures.ts';

function originalOutbox(record: RepairOperation, name: string, sha256 = record.plan.handoffs[0]!.recordSha256): Extract<OutboxRead, { status: 'valid' }> {
  const original = record.plan.handoffs[0]!;
  const preservation = record.recovery.episodes[0]!.prerequisite!.actions[0]!;
  assert.ok(preservation.kind === 'preserveRecovery');
  return { status: 'valid', name, sha256, bytes: Buffer.from('modeled original outbox bytes'), receipt: { sourceInspection: true },
    metadata: { stateEventVersion: 1, logicalOutboxId: original.logicalOutboxId, incarnationId: 'd'.repeat(32), sequence: 1, kind: 'resync', createdAt: at,
      principal: preservation.metadata.principal, repairOperationId: preservation.metadata.coreRepairOperationId, adapterVersion: preservation.metadata.adapterVersion,
      game: preservation.metadata.adapter, schemaVersion: preservation.metadata.schemaVersion, targetIdentitySha256: '1'.repeat(64), stateGeneratedAt: at } };
}

function deferredModel(state: 'waitingReplacement' | 'pendingCleanup' = 'pendingCleanup') {
  const source = deferredRepair(state);
  const record = repair({ ...source, plan: { ...source.plan, publishedVersions: { schemaVersion: 2, adapterVersion: 1 } } });
  let slot: string | null = '7'.repeat(64);
  let currentGeneration = generation;
  let sourceAvailable = false;
  let losePreservationSource = false;
  const event = journalEvent(2, { type: 'state.resync', coreRepairOperationId: coreAttemptToken(record.operationId, 1), attemptRef: { operationId: record.operationId, attemptOrdinal: 1 },
    acceptance: { journalId: 'journal', eventId: '2'.padStart(32, '0'), generation } });
  const snapshot = { ...journal(2, 1), events: new Map([[2, { metadata: event, sha256: '9'.repeat(64) }]]) };
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: witness }, snapshot);
  model.memory.seed(`operations/${record.operationId}.json`, record);
  model.kernel.carryHash = async () => slot;
  model.kernel.outbox.read = async name => ({ status: 'absent', name });
  model.kernel.codec.previewEvent = async () => ({ sha256: '7'.repeat(64), metadata: {}, cleanupComplete: true });
  const readJournal = model.kernel.journal.read.bind(model.kernel.journal);
  model.kernel.journal.read = async () => {
    const value = await readJournal();
    const fault = value.header.status !== 'valid' ? 'header' : value.cursor.status !== 'valid' || value.cursor.value.journalId !== value.header.value.journalId
      || value.cursor.value.lastAckedSequence > value.header.value.highWaterSequence || value.cursor.value.lastSentSequence > value.header.value.highWaterSequence ? 'cursor' : null;
    return { ...value, fault };
  };
  const safety = model.kernel.safety.bind(model.kernel);
  model.kernel.safety = async () => ({ ...await safety(), generation: currentGeneration });
  const executed: RecoveryAction[] = [];
  let failProgress = false;
  const write = model.memory.write.bind(model.memory);
  model.memory.write = async (...args) => {
    if (failProgress && args[0] === `operations/${record.operationId}.json`) { failProgress = false; throw new Error('Lost progress publication.'); }
    return write(...args);
  };
  const coordinator = () => {
    const value = new RecoveryCoordinator(model.kernel);
    Object.assign(value, { executor: () => ({ execute: async (action: RecoveryAction) => {
      // Native deletion and its second admission gate have a separate private-root
      // executor fixture. This model cuts coordinator progress after deletion.
      executed.push(action);
      if (action.kind === 'removeCarry') { const absent = slot === null; slot = null; return absent ? 'alreadyApplied' : 'applied'; }
      if (action.kind === 'preserveRecovery') {
        if (losePreservationSource) { losePreservationSource = false; sourceAvailable = false; throw new Error('Source disappeared after preservation plan.'); }
        slot = action.target.after;
        return 'applied';
      }
      if (action.kind === 'publishCursor' || action.kind === 'publishHeader' || action.kind === 'raiseHighWater') {
        model.memory.seed(action.target.path, action.value);
        return 'applied';
      }
      if (action.kind === 'quarantine') {
        if (action.source.path.startsWith('journal/events/')) { snapshot.events.delete(Number(action.source.path.slice('journal/events/'.length, -5))); }
        model.memory.files.delete(action.source.path);
        return 'applied';
      }
      if (action.kind === 'appendRecovery') {
        snapshot.events.set(action.metadata.sequence, { metadata: { ...event, ...action.metadata, payloadBindingSha256: action.source.payloadBindingSha256 }, sha256: action.target.after! });
        return 'applied';
      }
      throw new Error('Unexpected structural action in deferred fixture.');
    } }), fileHash: async (relative: string) => relative === 'journal/recovery-event.json' ? slot : relative === 'journal/events/0000000000000002.json' ? '9'.repeat(64)
      : sourceAvailable && relative === 'journal/events/0000000000000001.json' ? '8'.repeat(64)
      : model.memory.files.has(relative) ? bytesHash(model.memory.files.get(relative)!) : null,
      readRecoveryJournalSources: async () => {
        const values = [...snapshot.events.values()];
        if (sourceAvailable && !snapshot.events.has(1)) {
          const preservation = record.recovery.episodes[0]!.prerequisite!.actions[0]!;
          assert.ok(preservation.kind === 'preserveRecovery');
          values.push({ metadata: { ...event, ...preservation.metadata, payloadBindingSha256: preservation.source.payloadBindingSha256 }, sha256: '8'.repeat(64) });
        }
        return values;
      },
      readRecoverySource: async () => Buffer.from('modeled verified source') });
    return value as unknown as { runPrerequisite(id: string): Promise<void>; finalize(id: string): Promise<void>; reconcileSafety(): Promise<void>; resume(id: string): Promise<void>;
      retireAndRewind: (stored: { record: RepairOperation; sha256: string }, recoveryEvent: typeof event, presentation: 'rejected', journalSnapshot: typeof snapshot) => Promise<unknown> };
  };
  return { ...model, record, event, snapshot, executed, coordinator, setGeneration: (value: string) => {
    currentGeneration = value;
    model.memory.seed('state-safety.json', { ...model.memory.value<StateSafety>('state-safety.json'), generation: value });
  },
    setSlot: (value: string | null) => { slot = value; }, setSourceAvailable: (value: boolean) => { sourceAvailable = value; },
    losePreservationSource: () => { losePreservationSource = true; }, loseProgress: () => { failProgress = true; } };
}

describe('deferred carry execution', () => {
  for (const preservationOrigin of ['journal', 'outbox'] as const) {
    for (const journalPresent of [false, true]) {
      for (const outboxState of ['valid', 'absent', 'invalid', 'changed', 'unreadable'] as const) {
        it(`checks original outbox ${outboxState} for ${preservationOrigin} preservation with journal present ${journalPresent}`, async () => {
          const model = deferredModel('waitingReplacement');
          model.setSlot(null);
          model.setSourceAvailable(journalPresent);
          const original = model.record.plan.handoffs[0]!;
          const plan = model.record.recovery.episodes[0]!.prerequisite!;
          const preservation = plan.actions[0]!;
          assert.ok(preservation.kind === 'preserveRecovery');
          const name = 'event-0000000000000001.json';
          const candidate = preservationOrigin === 'journal' ? model.record : repair({ ...model.record, recovery: { ...model.record.recovery,
            episodes: [{ ...model.record.recovery.episodes[0]!, prerequisite: { ...plan, actions: [{ ...preservation,
              source: { root: 'companion', path: 'state/outbox/' + name, sha256: original.recordSha256, payloadBindingSha256: original.payloadBindingSha256! } }] } }] } });
          model.memory.seed(`operations/${owner.operationId}.json`, candidate);
          if (journalPresent) {
            model.snapshot.events.set(1, { metadata: { ...model.event, ...preservation.metadata, payloadBindingSha256: original.payloadBindingSha256! }, sha256: '8'.repeat(64) });
          }
          const reads: string[] = [];
          model.kernel.outbox.read = async requested => {
            reads.push(requested);
            assert.equal(requested, name);
            if (outboxState === 'unreadable') { throw new Error('Original outbox source is unreadable.'); }
            if (outboxState === 'absent') { return { status: 'absent', name }; }
            if (outboxState === 'invalid') { return { status: 'invalid', name, sha256: original.recordSha256 }; }
            return originalOutbox(candidate, name, outboxState === 'changed' ? '6'.repeat(64) : original.recordSha256);
          };
          model.coordinator();
          if (outboxState === 'unreadable') { await assert.rejects(model.kernel.authorizeDeferredCore!(candidate), /Original outbox source is unreadable/); }
          else { assert.equal(await model.kernel.authorizeDeferredCore!(candidate), !journalPresent && outboxState !== 'valid'); }
          assert.deepEqual(reads, [name], 'The original outbox is inspected once even when another exact source exists.');
          assert.equal(model.memory.writes.length, 0);
        });
      }
    }
  }

  it('preserves a surviving original outbox before allowing core continuation after journal-source loss', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    const handoff = model.record.plan.handoffs[0]!;
    model.kernel.outbox.read = async name => originalOutbox(model.record, name);
    const coordinator = model.coordinator();
    assert.equal(await model.kernel.authorizeDeferredCore!(model.record), false);
    await coordinator.runPrerequisite(owner.operationId);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.attempts.length, 2);
    assert.equal(current.recovery.episodes.length, 2);
    const restored = current.recovery.episodes[1]!.prerequisite!.actions[0]!;
    assert.ok(restored.kind === 'preserveRecovery');
    assert.deepEqual(restored.source, { root: 'companion', path: 'state/outbox/event-0000000000000001.json', sha256: handoff.recordSha256, payloadBindingSha256: handoff.payloadBindingSha256 });
    assert.equal(await model.kernel.carryHash(), '7'.repeat(64));
    assert.equal(await model.kernel.authorizeDeferredCore!(current), true);
  });

  it('does not reinterpret unreadable journal-source inspection as absence', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    const coordinator = model.coordinator();
    Object.assign(coordinator, { readRecoveryJournalSources: async () => { throw new Error('Journal source is unreadable.'); } });
    await assert.rejects(model.kernel.authorizeDeferredCore!(model.record), /Journal source is unreadable/);
    assert.equal(model.memory.writes.length, 0);
  });

  it('permits missing-payload continuation only after both source families are readable and unusable', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    const relative = 'journal/events/0000000000000001.json';
    const bytes = Buffer.from('invalid journal source content');
    model.memory.files.set(relative, bytes);
    model.snapshot.damaged = [{ path: model.memory.scope.dataRoot + '/' + relative, status: 'invalid', sha256: bytesHash(bytes) }];
    let calls = 0;
    model.kernel.outbox.read = async name => { calls++; return { status: 'invalid', name, sha256: '6'.repeat(64) }; };
    model.coordinator();
    assert.equal(await model.kernel.authorizeDeferredCore!(model.record), true);
    assert.equal(calls, 1);
    assert.equal(model.memory.writes.length, 0);
  });

  it('rejects a readable journal copy that contradicts the retained payload binding', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    const preservation = model.record.recovery.episodes[0]!.prerequisite!.actions[0]!;
    assert.ok(preservation.kind === 'preserveRecovery');
    model.snapshot.events.set(1, { metadata: { ...model.event, ...preservation.metadata, payloadBindingSha256: '5'.repeat(64) }, sha256: '8'.repeat(64) });
    model.coordinator();
    await assert.rejects(model.kernel.authorizeDeferredCore!(model.record));
    assert.equal(model.memory.writes.length, 0);
  });

  it('uses independent event inspection at core admission and propagates its failure without reentering the journal queue', async () => {
    const record = deferredRepair();
    const model = authorityModel();
    model.memory.seed(`operations/${record.operationId}.json`, record);
    model.kernel.carryHash = async () => null;
    model.kernel.journal.read = async () => { throw new Error('Journal queue reentry.'); };
    let inspections = 0;
    model.kernel.inspector.metadata = async script => {
      assert.ok(script.endsWith('Get-EventMetadata.ps1'));
      inspections++;
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Source inspection unavailable.') };
    };
    new RecoveryCoordinator(model.kernel);
    await assert.rejects(model.kernel.authorizeDeferredCore!(record), /Event inspection is unavailable/);
    assert.equal(inspections, 1);
    assert.equal(model.memory.writes.length, 0);
  });

  for (const state of ['pendingCleanup', 'waitingReplacement'] as const) {
    for (const fault of ['cursorBeyondHeader', 'absentCursor', 'absentHeader'] as const) {
      for (const carryPresent of [true, false]) {
        it(`repairs ${fault} during ${state} with carry present ${carryPresent} before bound continuation`, async () => {
          const model = deferredModel(state);
          if (!carryPresent) { model.setSlot(null); }
          if (fault === 'cursorBeyondHeader') {
            const cursor = model.snapshot.cursor;
            assert.ok(cursor.status === 'valid');
            model.memory.seed('journal/cursor-agent-session.json', { ...cursor.value, lastAckedSequence: 3 });
          } else { model.memory.files.delete(fault === 'absentHeader' ? 'journal/journal.json' : 'journal/cursor-agent-session.json'); }
          const initial = await model.kernel.journal.read();
          assert.equal(initial.fault, fault === 'absentHeader' ? 'header' : 'cursor');
          const drain = model.kernel.drain.bind(model.kernel);
          model.kernel.drain = async (...args) => {
            const snapshot = await model.kernel.journal.read();
            assert.equal(snapshot.fault, null, 'Structural repair must precede the real drain.');
            stubJournalTransaction(model.kernel, snapshot);
            return drain(...args);
          };
          const tokens: string[] = [];
          const restoresAcceptedReplacement = state === 'pendingCleanup' && !carryPresent && fault === 'absentHeader';
          const stopped = new Error('Stop before designated core publication.');
          model.kernel.publish = async (_force, record) => {
            assert.ok(record !== null);
            const snapshot = await model.kernel.journal.read();
            assert.equal(snapshot.fault, null);
            assert.ok(snapshot.header.status === 'valid' && snapshot.cursor.status === 'valid');
            assert.equal(snapshot.cursor.value.lastAckedSequence, fault === 'absentHeader' ? 0 : 2);
            if (fault === 'absentHeader') { assert.notEqual(snapshot.header.value.journalId, 'journal'); }
            tokens.push(coreAttemptToken(record.operationId, record.recovery.attempts.length - 1));
            throw stopped;
          };
          for (let restart = 0; restart < 2; restart++) {
            if (restoresAcceptedReplacement) {
              if (restart === 0) { await model.coordinator().resume(owner.operationId); }
              else { await model.coordinator().reconcileSafety(); }
            } else { await assert.rejects(model.coordinator().resume(owner.operationId), error => error === stopped); }
            const current = (await model.records())[0] as RepairOperation;
            assert.equal(current.recovery.episodes.length, 2, 'Repeated starts must reuse the policy-correct successor.');
            assert.equal(current.recovery.activeEpisode, restoresAcceptedReplacement ? null : 1);
            assert.equal(current.recovery.episodes[0]!.phase, 'transferred');
            const plan = current.recovery.episodes[1]!.prerequisite!;
            if (carryPresent || state === 'waitingReplacement') {
              assert.deepEqual(plan.carryRelease, { attemptRef: { operationId: owner.operationId, attemptOrdinal: current.recovery.attempts.length - 1 } });
              assert.equal(carryReleaseResolved(plan), false);
            } else { assert.equal(carryReleaseResolved(current.recovery.episodes[0]!.prerequisite!), true); }
            assert.equal(await model.kernel.carryHash(), carryPresent ? '7'.repeat(64) : null);
            assert.deepEqual(current.plan.handoffs[0], model.record.plan.handoffs[0]);
          }
          assert.equal(tokens[0], tokens[1]);
          assert.equal(tokens.length, restoresAcceptedReplacement ? 0 : 2);
          assert.equal(model.executed.filter(action => action.kind === 'publishCursor').length, 1);
        });
      }
    }

    for (const obstruction of ['unreadableCursor', 'contradictoryCarry'] as const) {
      it(`keeps ${state} fail closed with ${obstruction}`, async () => {
        const model = deferredModel(state);
        const cursor = model.snapshot.cursor;
        assert.ok(cursor.status === 'valid');
        model.memory.seed('journal/cursor-agent-session.json', { ...cursor.value, lastAckedSequence: 3 });
        if (obstruction === 'unreadableCursor') { model.memory.unreadable.add('journal/cursor-agent-session.json'); }
        else { model.setSlot('6'.repeat(64)); }
        const before = await model.records();
        await assert.rejects(model.coordinator().resume(owner.operationId));
        assert.deepEqual(await model.records(), before);
        assert.equal(model.executed.length, 0);
      });
    }
  }

  it('resumes an exact planned high-water partial state without manufacturing a synthetic acknowledgement', async () => {
    const model = deferredModel('waitingReplacement');
    const header = model.snapshot.header;
    const cursor = model.snapshot.cursor;
    assert.ok(header.status === 'valid' && cursor.status === 'valid');
    const oldCursor = { ...cursor.value, lastAckedSequence: 0, lastSentSequence: 2 };
    model.memory.seed('journal/cursor-agent-session.json', oldCursor);
    const cursorBefore = bytesHash(model.memory.files.get('journal/cursor-agent-session.json')!);
    const headerBefore = bytesHash(model.memory.files.get('journal/journal.json')!);
    const lowered = { ...header.value, highWaterSequence: 1 };
    model.memory.seed('journal/journal.json', lowered);
    const headerAfter = bytesHash(model.memory.files.get('journal/journal.json')!);
    const restoredCursor = { ...oldCursor, lastSentSequence: 1 };
    const plan = model.record.recovery.episodes[0]!.prerequisite!;
    const record = repair({ ...model.record, recovery: { ...model.record.recovery, episodes: [{ ...model.record.recovery.episodes[0]!, prerequisite: { ...plan, nextAction: 2,
      actions: [...plan.actions, { kind: 'raiseHighWater', target: { path: 'journal/journal.json', before: headerBefore, after: headerAfter }, value: lowered },
        { kind: 'publishCursor', target: { path: 'journal/cursor-agent-session.json', before: cursorBefore, after: bytesHash(Buffer.from(stringifyJson(restoredCursor))) }, value: restoredCursor }] } }] } });
    model.memory.seed(`operations/${owner.operationId}.json`, record);
    const intended = { ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) };
    await model.kernel.safetyStore.prepareTransfer(intended);
    await model.coordinator().reconcileSafety();
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.episodes.length, 2);
    const pending = current.recovery.episodes[1]!.prerequisite!;
    assert.equal(pending.kind, 'rewind');
    assert.deepEqual(pending.skippedRanges, []);
    const action = pending.actions[pending.nextAction]!;
    assert.ok(action.kind === 'publishCursor');
    assert.equal(action.value.lastAckedSequence, 0);
    assert.equal(action.value.lastSentSequence, 1);
    assert.equal(action.target.before, cursorBefore);
    assert.equal(current.recovery.episodes[1]!.activationId, intended.activationId);
  });

  it('combines missing-carry preservation and cursor repair in one successor', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    model.setSourceAvailable(true);
    const cursor = model.snapshot.cursor;
    assert.ok(cursor.status === 'valid');
    model.memory.seed('journal/cursor-agent-session.json', { ...cursor.value, lastAckedSequence: 3 });
    const stopped = new Error('Stop at designated publication.');
    model.kernel.publish = async () => { assert.equal((await model.kernel.journal.read()).fault, null); throw stopped; };
    await assert.rejects(model.coordinator().resume(owner.operationId), error => error === stopped);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.episodes.length, 2);
    assert.equal(current.recovery.attempts.length, 2);
    assert.deepEqual(model.executed.map(action => action.kind), ['preserveRecovery', 'publishCursor']);
    assert.equal(await model.kernel.carryHash(), '7'.repeat(64));
    assert.deepEqual(current.recovery.episodes[1]!.prerequisite!.carryRelease, model.record.recovery.episodes[0]!.prerequisite!.carryRelease);
  });

  for (const slot of ['absent', 'present', 'unreadable'] as const) {
    it(`retains operation-loss priority only with admitted carry absence: ${slot}`, async () => {
      const model = authorityModel();
      model.memory.files.set(`operations/jr-${'f'.repeat(32)}.json`, Buffer.from('invalid authority'));
      model.kernel.carryHash = async () => { if (slot === 'unreadable') { throw new Error('Unreadable carry'); } return slot === 'present' ? '7'.repeat(64) : null; };
      const coordinator = new RecoveryCoordinator(model.kernel);
      coordinator.reconcileSafety = async () => {};
      const causes: string[] = [];
      coordinator.plan = async request => { causes.push(request.cause); return { record: repair(), sha256: '8'.repeat(64) }; };
      coordinator.resume = async () => {};
      if (slot === 'absent') { await coordinator.startup(); assert.deepEqual(causes, ['operationLost']); }
      else { await assert.rejects(coordinator.startup()); assert.deepEqual(causes, []); }
      assert.equal(model.memory.writes.length, 0);
    });
  }

  it('publishes checkpoint and one removal atomically and refreshes without duplicating cleanup', async () => {
    const model = deferredModel('waitingReplacement');
    let current = (await model.kernel.operations.list()).records[0]!;
    current = await model.kernel.operations.update(current, value => bindRecoveryEvent(selectRecoveryRecord(value as RepairOperation,
      { logicalOutboxId: model.event.logicalOutboxId, recordSha256: model.event.recordSha256 }, 'observed', null), model.event));
    model.loseProgress();
    await assert.rejects(model.kernel.operations.update(current, value => checkpointRecovery(value as RepairOperation, model.event, generation, 2, at)));
    const unchanged = (await model.records())[0] as RepairOperation;
    assert.equal(unchanged.recovery.episodes[0]!.acceptedRecovery, null);
    assert.equal(unchanged.recovery.episodes[0]!.prerequisite!.actions.length, 1);
    current = await model.kernel.operations.update(current, value => checkpointRecovery(value as RepairOperation, model.event, generation, 2, at));
    current = await model.kernel.operations.update(current, value => checkpointRecovery(value as RepairOperation, model.event, generation, 2, at));
    const checkpoint = current.record as RepairOperation;
    assert.equal(checkpoint.recovery.episodes[0]!.phase, 'verifyingHistory');
    assert.equal(checkpoint.recovery.episodes[0]!.prerequisite!.actions.filter(action => action.kind === 'removeCarry').length, 1);
    await model.coordinator().runPrerequisite(owner.operationId);
    const finished = (await model.records())[0] as RepairOperation;
    assert.equal(finished.recovery.episodes[0]!.phase, 'verifyingHistory');
    assert.equal(carryReleaseResolved(finished.recovery.episodes[0]!.prerequisite!), true);
    assert.equal(model.executed.length, 1);
  });

  for (const failure of ['generation', 'destination', 'placement'] as const) {
    it(`retains the slot and pending cleanup after stale ${failure}`, async () => {
      const model = deferredModel();
      if (failure === 'generation') { model.setGeneration('6'.repeat(32)); }
      if (failure === 'destination') { model.snapshot.events.set(2, { metadata: { ...model.event, eventId: '5'.repeat(32) }, sha256: '9'.repeat(64) }); }
      if (failure === 'placement') { model.memory.seed('journal/journal.json', { ...(model.snapshot.header.status === 'valid' ? model.snapshot.header.value : {}), highWaterSequence: 3 }); }
      await model.coordinator().runPrerequisite(owner.operationId);
      assert.equal(model.executed.length, 0);
      assert.equal(await model.kernel.carryHash(), '7'.repeat(64));
      assert.equal(((await model.records())[0] as RepairOperation).recovery.episodes[0]!.prerequisite!.nextAction, 1);
      await assert.rejects(model.coordinator().finalize(owner.operationId));
    });
  }

  it('recognizes lost removal progress without re-deleting and preserves finalization fences', async () => {
    const model = deferredModel();
    model.loseProgress();
    await assert.rejects(model.coordinator().runPrerequisite(owner.operationId), /Lost progress/);
    assert.equal(await model.kernel.carryHash(), null);
    assert.equal(((await model.records())[0] as RepairOperation).recovery.episodes[0]!.prerequisite!.nextAction, 1);
    model.setGeneration('6'.repeat(32));
    await model.coordinator().runPrerequisite(owner.operationId);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.episodes[0]!.prerequisite!.nextAction, 2);
    assert.equal(current.recovery.episodes[0]!.phase, 'verifyingHistory');
    await assert.rejects(model.coordinator().finalize(owner.operationId));
    assert.equal(current.recovery.activeEpisode, 0);
  });

  it('allows only the bound attempt to continue with absent payload and no exact source', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    model.coordinator();
    assert.equal(await model.kernel.authorizeDeferredCore!(model.record), true);
    const foreign = { ...model.record, recovery: { ...model.record.recovery, activeEpisode: null } };
    assert.equal(await model.kernel.authorizeDeferredCore!(foreign), false);
    model.setSlot('6'.repeat(64));
    await assert.rejects(model.kernel.authorizeDeferredCore!(model.record));
  });

  it('restores a surviving exact source before admitting designated core work without another attempt', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    model.setSourceAvailable(true);
    const coordinator = model.coordinator();
    assert.equal(await model.kernel.authorizeDeferredCore!(model.record), false);
    await coordinator.runPrerequisite(owner.operationId);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.attempts.length, 2);
    assert.equal(current.recovery.episodes.length, 2);
    assert.equal(current.recovery.episodes[1]!.replacementAttempt, null);
    assert.deepEqual(current.recovery.episodes[1]!.prerequisite!.carryRelease, model.record.recovery.episodes[0]!.prerequisite!.carryRelease);
    assert.equal(await model.kernel.carryHash(), '7'.repeat(64));
    assert.equal(await model.kernel.authorizeDeferredCore!(current), true);
  });

  it('resumes the exact reserved preservation episode after its root publication is lost', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    model.setSourceAvailable(true);
    model.loseProgress();
    await assert.rejects(model.coordinator().runPrerequisite(owner.operationId), /Lost progress/);
    const intended = (await model.kernel.safety()).recoveryWitness!.successor!;
    const resumed = model.coordinator();
    await resumed.reconcileSafety();
    await resumed.runPrerequisite(owner.operationId);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.episodes.length, 2);
    assert.equal(current.recovery.episodes[1]!.activationId, intended.activationId);
    assert.equal(current.recovery.attempts.length, 2);
    assert.equal(await model.kernel.carryHash(), '7'.repeat(64));
  });

  it('carries the binding into missing-payload recovery when a planned exact source disappears', async () => {
    const model = deferredModel('waitingReplacement');
    model.setSlot(null);
    model.setSourceAvailable(true);
    model.losePreservationSource();
    await assert.rejects(model.coordinator().runPrerequisite(owner.operationId), /Source disappeared/);
    await model.coordinator().runPrerequisite(owner.operationId);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(current.recovery.attempts.length, 2);
    assert.equal(current.recovery.episodes.length, 3);
    assert.equal(current.recovery.episodes[2]!.replacementAttempt, null);
    assert.deepEqual(current.recovery.episodes[2]!.prerequisite!.carryRelease, model.record.recovery.episodes[0]!.prerequisite!.carryRelease);
    assert.equal(await model.kernel.authorizeDeferredCore!(current), true);
    assert.equal(await model.kernel.carryHash(), null);
  });

  it('retargets an inherited obligation atomically without reusing old removal authorization', () => {
    const original = deferredRepair('pendingCleanup');
    const first = original.recovery.episodes[0]!;
    const inherited = transferEpisode(original, { activationId: '6'.repeat(32), trigger: 'gap', attemptAtStart: 1, replacementAttempt: null,
      prerequisite: first.prerequisite, acceptedRecovery: null, startedAt: at }, at);
    assert.equal(inherited.recovery.episodes[1]!.replacementAttempt, null);
    assert.deepEqual(inherited.recovery.episodes[1]!.prerequisite!.carryRelease, first.prerequisite!.carryRelease);
    const replacement = replacementCandidate(inherited, 'placementUnavailable');
    validateOperationTransition(inherited, replacement);
    const next = replacement.recovery.episodes[1]!;
    assert.equal(next.replacementAttempt, 2);
    assert.deepEqual(next.prerequisite!.carryRelease, { attemptRef: { operationId: original.operationId, attemptOrdinal: 2 } });
    assert.equal(next.prerequisite!.actions.some(action => action.kind === 'removeCarry'), false);
    assert.equal(next.acceptedRecovery, null);
    assert.deepEqual(replacement.recovery.episodes[0], inherited.recovery.episodes[0]);
    assert.throws(() => replacementCandidate(replacement, 'missingPayload'));
  });

  it('transfers deferred cleanup through a rejected replacement rewind before retiring its event', async () => {
    const model = deferredModel();
    const current = (await model.kernel.operations.list()).records[0]!;
    const coordinator = model.coordinator();
    await coordinator.retireAndRewind({ ...current, record: current.record as RepairOperation }, model.event, 'rejected', await model.kernel.journal.read() as typeof model.snapshot);
    const updated = (await model.records())[0] as RepairOperation;
    assert.equal(updated.recovery.activeEpisode, 1);
    assert.equal(updated.recovery.episodes[0]!.phase, 'transferred');
    assert.equal(updated.recovery.episodes[1]!.replacementAttempt, null);
    assert.deepEqual(updated.recovery.episodes[1]!.prerequisite!.carryRelease, model.record.recovery.episodes[0]!.prerequisite!.carryRelease);
    assert.ok(updated.recovery.episodes[1]!.prerequisite!.actions.some(action => action.kind === 'quarantine' && action.source.path === 'journal/events/0000000000000002.json'));
    assert.equal(updated.recovery.episodes[1]!.prerequisite!.actions.at(-1)!.kind, 'removeCarry');
    assert.ok(updated.plan.retiredRecords.some(record => record.logicalOutboxId === model.event.logicalOutboxId));
    assert.equal(await model.kernel.carryHash(), '7'.repeat(64));
    const latest = (await model.kernel.operations.list()).records[0]!;
    await assert.rejects(coordinator.retireAndRewind({ ...latest, record: latest.record as RepairOperation }, model.event, 'rejected', await model.kernel.journal.read() as typeof model.snapshot));
  });

  it('resumes a stale checkpoint through the bound drain and finalizes only after cleanup', async () => {
    const model = deferredModel();
    const fresh = '6'.repeat(32);
    model.setGeneration(fresh);
    let drains = 0;
    model.kernel.drain = async (_deadline, owningRepair) => {
      assert.equal(owningRepair, owner.operationId);
      drains++;
      model.snapshot.events.set(2, { metadata: { ...model.event, acceptance: { ...model.event.acceptance!, generation: fresh } }, sha256: '9'.repeat(64) });
      return model.kernel.journal.read();
    };
    model.kernel.publish = async () => { throw new Error('Accepted observed attempt must not publish another resync.'); };
    await model.coordinator().resume(owner.operationId);
    const current = (await model.records())[0] as RepairOperation;
    assert.equal(drains, 1);
    assert.equal(current.recovery.attempts.length, 2);
    assert.equal(current.recovery.activeEpisode, null);
    assert.equal(current.recovery.episodes[0]!.acceptedRecovery?.generation, fresh);
    assert.equal(carryReleaseResolved(current.recovery.episodes[0]!.prerequisite!), true);
    assert.equal(await model.kernel.carryHash(), null);
    assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
    assert.equal(model.snapshot.events.get(2)!.metadata.acknowledgedAt, null);
  });

  for (const cut of ['beforeRoot', 'beforeActivation'] as const) {
    it(`inherits abandoned carry into initial attempt zero after a ${cut} crash`, async () => {
      const source = deferredRepair();
      const released = release();
      const abandoned = abandonRecovery(source, released.operationId, at);
      const model = authorityModel();
      model.memory.seed(`operations/${source.operationId}.json`, abandoned);
      model.memory.seed(`operations/${released.operationId}.json`, released);
      model.kernel.carryHash = async () => '7'.repeat(64);
      const write = model.memory.write.bind(model.memory);
      const activate = model.kernel.safetyStore.activateWitness.bind(model.kernel.safetyStore);
      let failed = false;
      model.memory.write = async (...args) => {
        if (!failed && cut === 'beforeRoot' && args[0].startsWith('operations/') && args[0] !== `operations/${source.operationId}.json`) { failed = true; throw new Error('Crash before successor root.'); }
        return write(...args);
      };
      model.kernel.safetyStore.activateWitness = async (...args) => {
        if (!failed && cut === 'beforeActivation') { failed = true; throw new Error('Crash before successor activation.'); }
        return activate(...args);
      };
      await assert.rejects(new RecoveryCoordinator(model.kernel).plan({ cause: 'contextUncertain', journal: await model.kernel.journal.read() }), /Crash before successor/);
      const reserved = (await model.kernel.safety()).recoveryWitness!;
      const intended = reserved.phase === 'transferring' ? reserved.successor! : reserved.owner;
      await new RecoveryCoordinator(model.kernel).reconcileSafety();
      const current = (await model.records()).find(record => record.operationId === intended.operationId) as RepairOperation;
      assert.equal(current.recovery.attempts.length, 1);
      assert.equal(current.recovery.episodes[0]!.activationId, intended.activationId);
      assert.deepEqual(current.recovery.episodes[0]!.prerequisite!.carryRelease, { attemptRef: { operationId: current.operationId, attemptOrdinal: 0 } });
      assert.deepEqual(current.plan.inheritedRecovery, owner);
      assert.deepEqual((await model.kernel.safety()).recoveryWitness?.owner, intended);
      assert.deepEqual((await model.records()).find(record => record.operationId === source.operationId), abandoned);
      const beforeRestart = await model.records();
      await new RecoveryCoordinator(model.kernel).reconcileSafety();
      assert.deepEqual(await model.records(), beforeRestart);
    });
  }
});
