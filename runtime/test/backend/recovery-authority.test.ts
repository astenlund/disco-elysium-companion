import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reservedWitnessMatches } from '../../src/backend/recovery-authority.ts';
import { handoffFor, RecoveryCoordinator } from '../../src/backend/recovery.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { replayCandidate, transferEpisode } from '../../src/recovery-progress.ts';
import { sameRecoveryOwner, SafetyUnavailableError, type RecoveryWitness, type StateSafety } from '../../src/safety-records.ts';
import type { SafetyProof } from '../../src/safety.ts';
import { admittedCapacityFixture, at, authorityModel, correctionId, generation, installEventInspectionFixture, journal, owner, repair, witness } from './authority-fixtures.ts';
import { DataRootUnavailableError } from '../../src/admission.ts';
import { bytesHash } from '../../src/storage.ts';
import { eventRewriteMetadata, parseEventMetadata } from '../../src/journal-records.ts';
import { journalEvent } from '../support/journal-event.ts';
import { parseStrictJson, stringifyJson, type JsonValue } from '../../src/json.ts';
import type { RecoveryAction } from '../../src/recovery-manifest.ts';

function pendingCarryModel(headerConflict: boolean) {
  const source = repair();
  const event = journalEvent(1, { type: 'state.resync', coreRepairOperationId: owner.operationId, attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 } });
  const carry = Buffer.from('protected carry bytes');
  const carryHash = bytesHash(carry);
  const snapshot = journal();
  assert.equal(snapshot.header.status, 'valid');
  if (snapshot.header.status !== 'valid') { throw new Error('Expected fixture header.'); }
  const header = snapshot.header.value;
  const hash = (value: unknown) => bytesHash(Buffer.from(stringifyJson(value)));
  const actions: RecoveryAction[] = [{ kind: 'preserveRecovery', target: { path: 'journal/recovery-event.json', before: null, after: carryHash },
    source: { root: 'scope', path: 'journal/events/0000000000000001.json', sha256: '5'.repeat(64), payloadBindingSha256: event.payloadBindingSha256! }, metadata: eventRewriteMetadata(event) }];
  if (headerConflict) { actions.push({ kind: 'publishHeader', target: { path: 'journal/journal.json', before: '8'.repeat(64), after: hash(header) }, value: header }); }
  actions.push({ kind: 'appendRecovery', target: { path: 'journal/events/0000000000000001.json', before: null, after: '6'.repeat(64) },
    source: { root: 'scope', path: 'journal/recovery-event.json', sha256: carryHash, payloadBindingSha256: event.payloadBindingSha256! }, metadata: eventRewriteMetadata(event) },
  { kind: 'raiseHighWater', target: { path: 'journal/journal.json', before: hash(header), after: hash({ ...header, highWaterSequence: 1 }) }, value: { ...header, highWaterSequence: 1 } },
  { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: carryHash, after: null } });
  const record = repair({ ...source, plan: { ...source.plan, handoffs: [handoffFor(event)] }, recovery: { ...source.recovery, episodes: [{ ...source.recovery.episodes[0]!, prerequisite: {
    kind: 'gap', nextAction: 1, carry: { path: 'journal/recovery-event.json', sha256: carryHash }, carryRelease: null, skippedRanges: [], actions } }] } });
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
    correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
  model.memory.seed(`operations/${owner.operationId}.json`, record);
  model.memory.files.set('journal/recovery-event.json', carry);
  installEventInspectionFixture(model.kernel, async (relative, sequence) => {
    const admission = await model.memory.inspect(model.memory.scope.dataRoot, relative, true);
    if (!admission.exists) { return { status: 'absent', sha256: null, metadata: null }; }
    const bytes = model.memory.files.get(relative);
    assert.ok(bytes !== undefined);
    const sha256 = bytesHash(bytes);
    const currentRecord = await model.kernel.operations.read(owner.operationId);
    assert.equal(currentRecord.status, 'valid');
    if (currentRecord.status !== 'valid') { throw new Error('Expected a valid recovery operation.'); }
    const current = currentRecord.value;
    assert.ok(!current.compacted && current.kind === 'repair');
    if (current.compacted || current.kind !== 'repair') { throw new Error('Expected a full recovery operation.'); }
    const actions = current.recovery.episodes.flatMap(episode => episode.prerequisite?.actions ?? []);
    for (const action of actions) {
      if (action.kind !== 'preserveRecovery' && action.kind !== 'appendRecovery') { continue; }
      if (action.kind === 'preserveRecovery' && relative === 'journal/recovery-event.json' && sequence === 0
        || action.kind === 'preserveRecovery' && action.source.root === 'scope' && action.source.path === relative && action.metadata.sequence === sequence
        || action.kind === 'appendRecovery' && action.target.path === relative && action.metadata.sequence === sequence) {
        return { status: 'valid', sha256, metadata: { ...action.metadata, payloadBindingSha256: action.source.payloadBindingSha256,
          targetIdentitySha256: action.metadata.compacted ? null : event.targetIdentitySha256,
          stateGeneratedAt: action.metadata.compacted ? null : event.stateGeneratedAt } };
      }
    }

    return { status: 'invalid', sha256, metadata: null };
  });
  if (headerConflict) { model.memory.seed('journal/journal.json', { ...header, historyVerified: false }); }
  const readJournal = model.kernel.journal.read.bind(model.kernel.journal);
  model.kernel.journal.read = async () => {
    const value = await readJournal();
    const bytes = model.memory.files.get('journal/events/0000000000000001.json');
    const records = await model.records();
    const current = records[0];
    if (bytes !== undefined && current !== undefined && !current.compacted && current.kind === 'repair'
      && current.recovery.episodes.some(episode => episode.prerequisite?.actions.some(action => action.kind === 'appendRecovery' && action.target.path === 'journal/events/0000000000000001.json' && action.target.after === bytesHash(bytes)))) {
      return { ...value, events: new Map([[1, { metadata: event, sha256: bytesHash(bytes) }]]) };
    }
    return value;
  };
  model.kernel.codec.previewEvent = async (target, bytes, metadata, _kind, binding) => ({ sha256: target === 'journal/recovery-event.json' ? carryHash : bytesHash(Buffer.from(stringifyJson({ source: bytesHash(bytes), metadata, binding }))),
    metadata: parseStrictJson(Buffer.from(stringifyJson({ ...event, ...parseEventMetadata(parseStrictJson(Buffer.from(stringifyJson(metadata)))), payloadBindingSha256: binding }))) as { [key: string]: JsonValue },
    cleanupComplete: true });
  const coordinator = () => {
    const value = new RecoveryCoordinator(model.kernel);
    // Replace only native byte observation; the planner and control persistence
    // remain production code and missing/unreadable fixture paths stay distinct.
    Object.assign(value, { fileHash: async (relative: string) => {
      if (model.memory.unreadable.has(relative)) { throw new DataRootUnavailableError('Fixture path unavailable.'); }
      const bytes = model.memory.files.get(relative);
      return bytes === undefined ? null : bytesHash(bytes);
    }, readRecoverySource: async (source: { path: string; sha256: string }) => {
      if (model.memory.unreadable.has(source.path)) { throw new DataRootUnavailableError('Fixture payload unavailable.'); }
      const bytes = model.memory.files.get(source.path);
      assert.ok(bytes !== undefined && bytesHash(bytes) === source.sha256);
      return bytes;
    } });
    return value;
  };
  return { ...model, record, carry, coordinator };
}

describe('reserved recovery ownership', () => {
  it('requires the exact active plan before activating a preparing witness', () => {
    const preparing = { ...witness, phase: 'preparing' as const };
    assert.equal(reservedWitnessMatches(preparing, repair()), true);
    assert.equal(reservedWitnessMatches({ ...preparing, owner: { ...owner, activationId: 'f'.repeat(32) } }, repair()), false);
    assert.equal(reservedWitnessMatches({ ...preparing, scopeSha256: '0'.repeat(64) }, repair()), false);
    assert.equal(reservedWitnessMatches(preparing, repair({ operationId: `jr-${'9'.repeat(32)}` })), false);
  });

  it('preserves exact predecessor ownership across roots and episode transfers', () => {
    const source = repair();
    const successor = { operationId: `jr-${'8'.repeat(32)}`, episodeOrdinal: 0, activationId: owner.activationId };
    const previous = { ...owner, activationId: '7'.repeat(32) };
    const transfer: RecoveryWitness = { ...witness, owner: previous, phase: 'transferring', successor };
    const candidate = repair({ operationId: successor.operationId, plan: { ...source.plan, inheritedRecovery: previous } });
    assert.equal(reservedWitnessMatches(transfer, candidate), true);
    assert.equal(reservedWitnessMatches(transfer, { ...candidate, plan: { ...candidate.plan, inheritedRecovery: null } }), false);
    const moved = transferEpisode(source, { ...source.recovery.episodes[0]!, activationId: '6'.repeat(32), trigger: 'gap' }, at);
    const withinRoot: RecoveryWitness = { ...witness, phase: 'transferring', successor: { ...owner, episodeOrdinal: 1, activationId: '6'.repeat(32) } };
    assert.equal(reservedWitnessMatches(withinRoot, moved), true);
    assert.equal(reservedWitnessMatches({ ...withinRoot, owner: { ...owner, activationId: '5'.repeat(32) } }, moved), false);
  });

  it('admits completed replay without rewriting the historical terminal episode', () => {
    const source = repair();
    const terminal = repair({ ...source, completedAt: at, outcome: 'recordRejected', recovery: { ...source.recovery, activeEpisode: null,
      episodes: [{ ...source.recovery.episodes[0]!, phase: 'recordRejected', endedAt: at }] } });
    const replayed = replayCandidate(terminal, '4'.repeat(32), at);
    assert.equal(reservedWitnessMatches({ ...witness, phase: 'transferring', successor: { ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) } }, replayed), true);
    assert.deepEqual(replayed.recovery.episodes[0], terminal.recovery.episodes[0]);
  });
});

describe('deciding authority controls', () => {
  it('recovers the direct lost-owner control with real control persistence', async () => {
    const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'coreRejected', recoveryOperationId: owner.operationId }, recoveryWitness: witness };
    const model = authorityModel(initial);
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    const safety = await model.kernel.safety();
    assert.equal(safety.recoveryWitness?.phase, 'active');
    assert.equal(safety.correction?.recoveryOperationId, safety.recoveryWitness?.owner.operationId);
    assert.equal(safety.correction?.correctionId, correctionId);
    assert.equal(safety.correction?.reason, 'coreRejected');
    assert.equal((await model.records()).length, 1);
  });

  it('preserves the older correction when an activated successor is lost before pointer transfer', async context => {
    const older = `jr-${'9'.repeat(32)}`;
    const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'coreRejected', recoveryOperationId: older }, recoveryWitness: witness };
    const model = authorityModel(initial);
    let failure: unknown;
    try { await new RecoveryCoordinator(model.kernel).reconcileSafety(); } catch (error) { failure = error; }
    const safety = await model.kernel.safety();
    const records = await model.records();
    context.diagnostic(JSON.stringify({ error: failure instanceof Error ? failure.message : null, correctionOwner: safety.correction?.recoveryOperationId,
      witnessOwner: safety.recoveryWitness?.owner.operationId, witnessPhase: safety.recoveryWitness?.phase, operations: records.length }));
    assert.equal(failure, undefined, 'A newer witnessed predecessor and an older correction pointer are separate preserved duties.');
    assert.equal(safety.correction?.recoveryOperationId, safety.recoveryWitness?.owner.operationId);
    assert.equal(safety.correction?.correctionId, correctionId);
    assert.equal(safety.correction?.reason, 'coreRejected');
    assert.equal(records.length, 1);
    assert.ok(!records[0]!.compacted && records[0]!.kind === 'repair');
    if (!records[0]!.compacted && records[0]!.kind === 'repair') { assert.deepEqual(records[0]!.plan.inheritedRecovery, witness.owner); }
  });

  it('binds exact invalid predecessor bytes independently for both lost owners', async () => {
    for (const invalid of ['correction', 'witness', 'both']) {
      const older = `jr-${'9'.repeat(32)}`;
      const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
        correction: { correctionId, reason: 'coreRejected', recoveryOperationId: older }, recoveryWitness: witness });
      const damaged = new Map<string, Buffer>();
      if (invalid !== 'witness') { damaged.set(older, Buffer.from('invalid older correction root')); }
      if (invalid !== 'correction') { damaged.set(owner.operationId, Buffer.from('invalid witnessed root')); }
      for (const [id, bytes] of damaged) { model.memory.files.set(`operations/${id}.json`, bytes); }
      await new RecoveryCoordinator(model.kernel).reconcileSafety();
      const safety = await model.kernel.safety();
      assert.equal(safety.correction?.recoveryOperationId, safety.recoveryWitness?.owner.operationId);
      const replacement = (await model.records()).find(record => record.operationId === safety.correction?.recoveryOperationId)!;
      assert.ok(!replacement.compacted && replacement.kind === 'repair');
      assert.deepEqual(replacement.plan.inheritedRecovery, owner);
      for (const [id, bytes] of damaged) { assert.ok(replacement.plan.lostOperations.some(lost => lost.name === `${id}.json` && lost.sha256 === bytesHash(bytes))); }
    }
  });

  it('keeps the correction pointer when either required predecessor is unreadable', async () => {
    for (const unreadable of [`jr-${'9'.repeat(32)}`, owner.operationId]) {
      const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
        correction: { correctionId, reason: 'coreRejected', recoveryOperationId: `jr-${'9'.repeat(32)}` }, recoveryWitness: witness };
      const model = authorityModel(initial);
      model.memory.files.set(`operations/${unreadable}.json`, Buffer.from('unreadable root'));
      model.memory.unreadable.add(`operations/${unreadable}.json`);
      await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), DataRootUnavailableError);
      assert.deepEqual((await model.kernel.safety()).correction, initial.correction);
      assert.equal(model.memory.writes.length, 0);
    }
  });
});

describe('successor plan resume ordering', () => {
  for (const branch of ['normal', 'restart'] as const) {
    for (const destinationPresent of [false, true]) {
      it(`handles unavailable cursor placement through ${branch} with old destination present ${destinationPresent}`, async () => {
        const model = pendingCarryModel(false);
        const original = model.record.recovery.episodes[0]!.prerequisite!;
        const eventBytes = Buffer.from('verified old recovery destination');
        const header = journal(2).header;
        const cursor = journal(2).cursor;
        assert.ok(header.status === 'valid' && cursor.status === 'valid');
        model.memory.seed('journal/journal.json', header.value);
        model.memory.files.delete('journal/cursor-agent-session.json');
        const pendingCursor: RecoveryAction = { kind: 'publishCursor', target: { path: 'journal/cursor-agent-session.json', before: '9'.repeat(64), after: bytesHash(Buffer.from(stringifyJson(cursor.value))) }, value: cursor.value };
        const selected = journalEvent(1);
        const record = repair({ ...model.record, recovery: { ...model.record.recovery,
          attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: selected.logicalOutboxId, recordSha256: selected.recordSha256 }, journalEvent: null }],
          episodes: [{ ...model.record.recovery.episodes[0]!, prerequisite: { ...original, actions: [original.actions[0]!, pendingCursor,
            ...original.actions.slice(1).map(action => action.kind === 'appendRecovery' ? { ...action, target: { ...action.target, after: bytesHash(eventBytes) } } : action)] } }] } });
        model.memory.seed(`operations/${owner.operationId}.json`, record);
        if (destinationPresent) { model.memory.files.set('journal/events/0000000000000001.json', eventBytes); }
        const read = model.kernel.journal.read.bind(model.kernel.journal);
        model.kernel.journal.read = async () => {
          const snapshot = await read();
          return { ...snapshot, events: new Map([...snapshot.events, [2, { metadata: journalEvent(2), sha256: '7'.repeat(64) }]]) };
        };
        const run = async () => {
          if (branch === 'restart') {
            await model.kernel.safetyStore.prepareTransfer({ ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) });
            await model.coordinator().reconcileSafety();
          } else {
            const stored = (await model.kernel.operations.list()).records[0]!;
            await (model.coordinator() as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read());
          }
        };
        await run();
        const beforeRestart = await model.records();
        await model.coordinator().reconcileSafety();
        assert.deepEqual(await model.records(), beforeRestart);
        const current = beforeRestart[0]!;
        assert.ok(!current.compacted && current.kind === 'repair');
        assert.equal(current.recovery.attempts.length, 2);
        assert.deepEqual(current.recovery.attempts[0], record.recovery.attempts[0]);
        assert.deepEqual(current.recovery.attempts[1], { publication: 'due', selectedRecord: null, journalEvent: null });
        assert.equal(current.recovery.episodes[1]!.replacementAttempt, 1);
        const plan = current.recovery.episodes[1]!.prerequisite!;
        assert.deepEqual(plan.actions.slice(0, plan.nextAction).map(action => action.kind), destinationPresent ? ['preserveRecovery', 'appendRecovery', 'raiseHighWater'] : ['preserveRecovery']);
        assert.deepEqual(plan.actions.slice(plan.nextAction).map(action => action.kind), destinationPresent ? ['publishCursor', 'removeCarry'] : ['publishCursor']);
        assert.deepEqual(plan.carryRelease, destinationPresent ? null : { attemptRef: { operationId: owner.operationId, attemptOrdinal: 1 } });
        assert.deepEqual(model.memory.files.get('journal/events/0000000000000001.json'), destinationPresent ? eventBytes : undefined);
        assert.deepEqual(model.memory.files.get('journal/recovery-event.json'), model.carry);
        assert.ok(current.plan.handoffs.some(handoff => handoff.logicalOutboxId === selected.logicalOutboxId));
      });
    }
    for (const carryPresent of [false, true]) {
      it(`reconstructs missing cursor above high water through ${branch} with carry present ${carryPresent}`, async () => {
        const model = pendingCarryModel(false);
        const original = model.record.recovery.episodes[0]!.prerequisite!;
        const eventBytes = Buffer.from('validated original event bytes');
        const header = journal(1).header;
        const cursor = journal(1).cursor;
        assert.ok(header.status === 'valid' && cursor.status === 'valid');
        model.memory.seed('journal/journal.json', header.value);
        model.memory.files.delete('journal/cursor-agent-session.json');
        const preservation = original.actions[0]!;
        assert.ok(preservation.kind === 'preserveRecovery');
        const pendingCursor: RecoveryAction = { kind: 'publishCursor', target: { path: 'journal/cursor-agent-session.json', before: '9'.repeat(64), after: bytesHash(Buffer.from(stringifyJson(cursor.value))) }, value: cursor.value };
        const record = repair({ ...model.record, recovery: { ...model.record.recovery, episodes: [{ ...model.record.recovery.episodes[0]!, prerequisite: { ...original,
          actions: [{ ...preservation, source: { ...preservation.source, sha256: bytesHash(eventBytes) } }, pendingCursor,
            ...original.actions.slice(1).map(action => action.kind === 'appendRecovery' ? { ...action, target: { ...action.target, after: bytesHash(eventBytes) } } : action)] } }] } });
        model.memory.seed(`operations/${owner.operationId}.json`, record);
        model.memory.files.set('journal/events/0000000000000001.json', eventBytes);
        if (!carryPresent) { model.memory.files.delete('journal/recovery-event.json'); }
        if (branch === 'restart') {
          await model.kernel.safetyStore.prepareTransfer({ ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) });
          await model.coordinator().reconcileSafety();
        } else {
          const stored = (await model.kernel.operations.list()).records[0]!;
          await (model.coordinator() as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read());
        }
        const current = (await model.records())[0]!;
        assert.ok(!current.compacted && current.kind === 'repair');
        const plan = current.recovery.episodes[1]!.prerequisite!;
        const pending = plan.actions.slice(plan.nextAction);
        const replacementCursor = pending.find(action => action.kind === 'publishCursor');
        const append = pending.find(action => action.kind === 'appendRecovery');
        assert.ok(replacementCursor?.kind === 'publishCursor' && append?.kind === 'appendRecovery');
        assert.equal(replacementCursor.value.lastAckedSequence, 1);
        assert.equal(append.metadata.sequence, 2);
        assert.equal(append.metadata.journalId, header.value.journalId);
        const quarantine = pending.findIndex(action => action.kind === 'quarantine' && action.source.path === 'journal/events/0000000000000001.json' && action.source.before === bytesHash(eventBytes));
        assert.ok(quarantine >= 0 && quarantine < pending.indexOf(append));
        assert.equal(pending.at(-1)!.kind, 'removeCarry');
        assert.equal(carryPresent ? plan.nextAction : pending[0]!.kind === 'preserveRecovery', carryPresent ? 1 : true);
        assert.ok(plan.skippedRanges.some(range => range.firstSequence === 1 && range.lastSequence === 1 && range.discharge === null));
      });
    }
    for (const completedHeader of [false, true]) {
      it(`keeps carry proof self-contained across repeated ${branch} transfers with completed header ${completedHeader}`, async () => {
        const model = pendingCarryModel(false);
        const original = model.record.recovery.episodes[0]!.prerequisite!;
        const eventBytes = Buffer.from('restored event bytes');
        const actions = original.actions.map(action => action.kind === 'appendRecovery' ? { ...action, target: { ...action.target, after: bytesHash(eventBytes) } } : action);
        const record = repair({ ...model.record, recovery: { ...model.record.recovery, episodes: [{ ...model.record.recovery.episodes[0]!,
          prerequisite: { ...original, actions, nextAction: 2 } }] } });
        model.memory.seed(`operations/${owner.operationId}.json`, record);
        model.memory.files.set('journal/events/0000000000000001.json', eventBytes);
        const header = actions[2]!;
        if (header.kind !== 'raiseHighWater') { throw new Error('Expected high-water action.'); }
        const activations = new Set<string>();
        for (let ordinal = 1; ordinal <= 4; ordinal++) {
          model.memory.seed('journal/journal.json', completedHeader ? header.value : { ...header.value, highWaterSequence: 0,
            createdAt: ordinal === 1 ? at : '2026-10-09T00:00:00.0000000Z', historyVerified: false });
          const reserved = { ...owner, episodeOrdinal: ordinal, activationId: String(ordinal + 4).repeat(32) };
          if (branch === 'restart') {
            await model.kernel.safetyStore.prepareTransfer(reserved);
            await model.coordinator().reconcileSafety();
          } else {
            const stored = (await model.kernel.operations.list()).records[0]!;
            await (model.coordinator() as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read());
          }
          const beforeRestart = await model.records();
          await model.coordinator().reconcileSafety();
          assert.deepEqual(await model.records(), beforeRestart);
          const current = beforeRestart[0]!;
          assert.ok(!current.compacted && current.kind === 'repair');
          assert.equal(current.recovery.episodes.length, ordinal + 1);
          assert.equal(current.recovery.activeEpisode, ordinal);
          const activation = current.recovery.episodes[ordinal]!.activationId;
          assert.equal(activations.has(activation), false);
          activations.add(activation);
          const plan = current.recovery.episodes[ordinal]!.prerequisite!;
          assert.deepEqual(plan.actions.slice(0, plan.nextAction).map(action => action.kind), completedHeader
            ? ['preserveRecovery', 'appendRecovery', 'raiseHighWater'] : ['preserveRecovery', 'appendRecovery']);
          assert.deepEqual(plan.actions.slice(plan.nextAction).map(action => action.kind), completedHeader ? ['removeCarry'] : ['raiseHighWater', 'removeCarry']);
          assert.deepEqual(plan.carry, original.carry);
          assert.deepEqual(model.memory.files.get('journal/recovery-event.json'), model.carry);
          assert.deepEqual(model.memory.files.get('journal/events/0000000000000001.json'), eventBytes);
          if (branch === 'restart') { assert.deepEqual((await model.kernel.safety()).recoveryWitness?.owner, reserved); }
        }
      });
    }
    for (const { headerState, nextAction } of (['damaged', 'postimage', 'missing'] as const).flatMap(headerState => [1, 2].map(nextAction => ({ headerState, nextAction })))) {
      it(`handles durable append with ${headerState} high water and progress ${nextAction} through ${branch}`, async () => {
        const model = pendingCarryModel(false);
        const original = model.record.recovery.episodes[0]!.prerequisite!;
        const eventBytes = Buffer.from('restored event bytes');
        const actions: RecoveryAction[] = original.actions.map(action => action.kind === 'appendRecovery' ? { ...action, target: { ...action.target, after: bytesHash(eventBytes) } } : action);
        const independentBytes = Buffer.from('independent quarantine source');
        const independentDestination = `quarantine/independent.${'8'.repeat(32)}.quarantined`;
        if (headerState === 'missing') {
          model.memory.files.set('journal/events/0000000000000002.json', independentBytes);
          actions.splice(actions.length - 1, 0, { kind: 'quarantine', source: { path: 'journal/events/0000000000000002.json', before: bytesHash(independentBytes), after: null },
            target: { path: independentDestination, before: null, after: bytesHash(independentBytes) } });
        }
        const record = repair({ ...model.record, plan: { ...model.record.plan, handoffs: headerState === 'missing' ? [handoffFor(journalEvent(2))] : [] }, recovery: { ...model.record.recovery, episodes: [{ ...model.record.recovery.episodes[0]!,
          prerequisite: { ...original, actions, nextAction } }] } });
        model.memory.seed(`operations/${owner.operationId}.json`, record);
        model.memory.files.set('journal/events/0000000000000001.json', eventBytes);
        const highWater = actions[2]!;
        if (highWater.kind !== 'raiseHighWater') { throw new Error('Expected high-water action.'); }
        if (headerState === 'postimage') { model.memory.seed('journal/journal.json', highWater.value); }
        if (headerState === 'damaged') { model.memory.seed('journal/journal.json', { ...highWater.value, highWaterSequence: 0, historyVerified: false }); }
        if (headerState === 'missing') { model.memory.files.delete('journal/journal.json'); }
        const run = async () => {
          if (branch === 'restart') {
            await model.kernel.safetyStore.prepareTransfer({ ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) });
            await model.coordinator().reconcileSafety();
          } else {
            const stored = (await model.kernel.operations.list()).records[0]!;
            await (model.coordinator() as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read());
          }
        };
        await run();
        const current = (await model.records())[0]!;
        assert.ok(!current.compacted && current.kind === 'repair');
        const plan = current.recovery.episodes[1]!.prerequisite!;
        const pending = plan.actions.slice(plan.nextAction);
        if (headerState === 'missing') {
          assert.equal(plan.kind, 'header');
          const freshHeader = pending.find(action => action.kind === 'publishHeader');
          const cursor = pending.find(action => action.kind === 'publishCursor');
          const append = pending.find(action => action.kind === 'appendRecovery');
          assert.ok(freshHeader?.kind === 'publishHeader' && cursor?.kind === 'publishCursor' && append?.kind === 'appendRecovery');
          assert.notEqual(freshHeader.value.journalId, 'journal');
          assert.equal(freshHeader.value.highWaterSequence, 0);
          assert.equal(cursor.value.lastAckedSequence, 0);
          assert.equal(cursor.value.journalId, freshHeader.value.journalId);
          assert.equal(append.metadata.journalId, freshHeader.value.journalId);
          assert.equal(append.metadata.logicalOutboxId, actions[1]!.kind === 'appendRecovery' && actions[1]!.metadata.logicalOutboxId);
          const quarantine = pending.findIndex(action => action.kind === 'quarantine' && action.source.path === 'journal/events/0000000000000001.json' && action.source.before === bytesHash(eventBytes));
          assert.ok(quarantine >= 0 && quarantine < pending.indexOf(append));
          assert.ok(pending.some(action => action.kind === 'quarantine' && action.source.before === bytesHash(independentBytes) && action.target.path === independentDestination));
          assert.ok(current.plan.handoffs.some(handoff => handoff.logicalOutboxId === journalEvent(2).logicalOutboxId));
          assert.equal(pending.at(-1)!.kind, 'removeCarry');
          const beforeRestart = await model.records();
          await model.coordinator().reconcileSafety();
          assert.deepEqual(await model.records(), beforeRestart);
        } else { assert.deepEqual(pending.map(action => action.kind), headerState === 'postimage' ? ['removeCarry'] : ['raiseHighWater', 'removeCarry']); }
        if (headerState === 'damaged') { assert.equal(pending[0]!.kind === 'raiseHighWater' && pending[0]!.target.before, bytesHash(model.memory.files.get('journal/journal.json')!)); }
        assert.deepEqual(model.memory.files.get('journal/recovery-event.json'), model.carry);
        assert.deepEqual(current.recovery.episodes[0]!.prerequisite, record.recovery.episodes[0]!.prerequisite);
      });
    }
    for (const headerConflict of [false, true]) {
      it(`keeps pending carry restoration executable through ${branch} with header conflict ${headerConflict}`, async () => {
        const model = pendingCarryModel(headerConflict);
        const next = { ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) };
        if (branch === 'restart') {
          await model.kernel.safetyStore.prepareTransfer(next);
          await model.coordinator().reconcileSafety();
        } else {
          const stored = (await model.kernel.operations.list()).records[0]!;
          const coordinator = model.coordinator();
          await (coordinator as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read());
        }
        for (let restart = 0; restart < 2; restart++) {
          await model.coordinator().reconcileSafety();
          const current = (await model.records())[0]!;
          assert.ok(!current.compacted && current.kind === 'repair');
          assert.equal(current.recovery.episodes.length, 2);
          const plan = current.recovery.episodes[1]!.prerequisite!;
          const pending = plan.actions.slice(plan.nextAction);
          assert.deepEqual(pending.map(action => action.kind), headerConflict ? ['publishHeader', 'appendRecovery', 'raiseHighWater', 'removeCarry'] : ['appendRecovery', 'raiseHighWater', 'removeCarry']);
          assert.deepEqual(plan.carry, model.record.recovery.episodes[0]!.prerequisite!.carry);
          assert.equal(plan.actions[0]!.kind, 'preserveRecovery');
          assert.deepEqual(current.recovery.episodes[0]!.prerequisite, model.record.recovery.episodes[0]!.prerequisite);
          assert.deepEqual(model.memory.files.get('journal/recovery-event.json'), model.carry);
          if (headerConflict) { assert.equal(pending[0]!.kind === 'publishHeader' && pending[0]!.target.before, bytesHash(model.memory.files.get('journal/journal.json')!)); }
          if (branch === 'restart') { assert.deepEqual((await model.kernel.safety()).recoveryWitness?.owner, next); }
        }
      });
    }
    it(`recognizes a completed header postimage before restoring carry during ${branch}`, async () => {
      const model = pendingCarryModel(true);
      const header = model.record.recovery.episodes[0]!.prerequisite!.actions[1]!;
      assert.equal(header.kind, 'publishHeader');
      if (header.kind !== 'publishHeader') { throw new Error('Expected header action.'); }
      model.memory.seed('journal/journal.json', header.value);
      if (branch === 'restart') {
        await model.kernel.safetyStore.prepareTransfer({ ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) });
        await model.coordinator().reconcileSafety();
      } else {
        const stored = (await model.kernel.operations.list()).records[0]!;
        await (model.coordinator() as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read());
      }
      const current = (await model.records())[0]!;
      assert.ok(!current.compacted && current.kind === 'repair');
      const plan = current.recovery.episodes[1]!.prerequisite!;
      assert.deepEqual(plan.actions.slice(plan.nextAction).map(action => action.kind), ['appendRecovery', 'raiseHighWater', 'removeCarry']);
    });
    it(`refuses unavailable or contradictory pending carry during ${branch} without a successor`, async () => {
      for (const failure of ['missing', 'changed', 'unreadable', 'destination', 'quarantine'] as const) {
        const model = pendingCarryModel(true);
        if (failure === 'missing') { model.memory.files.delete('journal/recovery-event.json'); }
        if (failure === 'changed') { model.memory.files.set('journal/recovery-event.json', Buffer.from('changed')); }
        if (failure === 'unreadable') { model.memory.unreadable.add('journal/journal.json'); }
        if (failure === 'destination') { model.memory.files.set('journal/events/0000000000000001.json', Buffer.from('conflicting destination')); }
        let expected = model.record;
        if (failure === 'quarantine') {
          const bytes = Buffer.from('quarantine source');
          const sourcePath = 'journal/events/0000000000000002.json';
          const targetPath = `quarantine/source.${'9'.repeat(32)}.quarantined`;
          const plan = model.record.recovery.episodes[0]!.prerequisite!;
          const action: RecoveryAction = { kind: 'quarantine', source: { path: sourcePath, before: bytesHash(bytes), after: null },
            target: { path: targetPath, before: null, after: bytesHash(bytes) } };
          expected = repair({ ...model.record, recovery: { ...model.record.recovery, episodes: [{ ...model.record.recovery.episodes[0]!,
            prerequisite: { ...plan, actions: [plan.actions[0]!, action, ...plan.actions.slice(1)] } }] } });
          model.memory.seed(`operations/${owner.operationId}.json`, expected);
          model.memory.files.set(sourcePath, bytes);
          model.memory.files.set(targetPath, Buffer.from('conflicting quarantine destination'));
        }
        if (branch === 'restart') { await model.kernel.safetyStore.prepareTransfer({ ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) }); }
        const writes = model.memory.writes.length;
        const coordinator = model.coordinator();
        if (branch === 'restart') { await assert.rejects(coordinator.reconcileSafety()); }
        else {
          const stored = (await model.kernel.operations.list()).records[0]!;
          await assert.rejects(async () => (coordinator as unknown as { transferDamage: (record: typeof stored, snapshot: Awaited<ReturnType<typeof model.kernel.journal.read>>) => Promise<void> }).transferDamage(stored, await model.kernel.journal.read()));
        }
        assert.ok(model.memory.writes.slice(writes).every(target => target === 'state-safety.json'));
        assert.deepEqual(await model.records(), [expected]);
      }
    });
  }

  for (const branch of ['damage', 'replay-transfer', 'replay-prepare'] as const) {
    it(`restores the exact reserved episode after ${branch} loses its root publication`, async () => {
      const source = repair();
      const range = { journalId: 'old-journal', firstSequence: 1, lastSequence: 3, reason: 'cursorRecovery' as const, discharge: null };
      const event = journalEvent(1);
      const carry = Buffer.from('protected carry bytes');
      const carryHash = bytesHash(carry);
      const retained = repair({ ...source, plan: { ...source.plan, skippedRanges: [range], handoffs: [handoffFor(event)] }, recovery: { ...source.recovery,
        episodes: [{ ...source.recovery.episodes[0]!, prerequisite: { kind: 'gap', nextAction: 1, carry: { path: 'journal/recovery-event.json', sha256: carryHash }, carryRelease: null, skippedRanges: [range],
          actions: [{ kind: 'preserveRecovery', target: { path: 'journal/recovery-event.json', before: null, after: carryHash },
            source: { root: 'scope', path: 'journal/events/0000000000000001.json', sha256: '5'.repeat(64), payloadBindingSha256: event.payloadBindingSha256! }, metadata: eventRewriteMetadata(event) }] } }] } });
      const record = branch === 'damage' ? retained
        : repair({ ...retained, completedAt: at, outcome: 'recordRejected', recovery: { ...retained.recovery, activeEpisode: null,
          episodes: [{ ...retained.recovery.episodes[0]!, phase: 'recordRejected', endedAt: at }] } });
      const next = { ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) };
      const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
        correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
      model.memory.seed(`operations/${owner.operationId}.json`, record);
      model.memory.files.set('journal/recovery-event.json', carry);
      if (branch === 'replay-prepare') {
        model.memory.seed('state-safety.json', { ...(await model.kernel.safety()), recoveryWitness: null });
        await model.kernel.safetyStore.prepareWitness(next);
      } else { await model.kernel.safetyStore.prepareTransfer(next); }
      const before = structuredClone(record.recovery.episodes[0]!);
      for (let restart = 0; restart < 2; restart++) {
        await new RecoveryCoordinator(model.kernel).reconcileSafety();
        const safety = await model.kernel.safety();
        assert.equal(safety.recoveryWitness?.phase, 'active');
        assert.deepEqual(safety.recoveryWitness?.owner, next);
        assert.equal(safety.correction?.correctionId, correctionId);
        const records = await model.records();
        assert.equal(records.length, 1);
        const current = records[0]!;
        assert.ok(!current.compacted && current.kind === 'repair');
        assert.equal(current.recovery.episodes.length, 2);
        assert.equal(current.recovery.activeEpisode, 1);
        assert.equal(current.recovery.episodes[1]!.activationId, next.activationId);
        assert.deepEqual(current.plan.skippedRanges, [range]);
        assert.deepEqual(current.plan.handoffs, record.plan.handoffs);
        assert.deepEqual(current.recovery.episodes[0]!.prerequisite, before.prerequisite);
        assert.deepEqual(model.memory.files.get('journal/recovery-event.json'), carry);
        if (branch !== 'damage') { assert.deepEqual(current.recovery.episodes[0], before); }
      }
    });
  }

  it('keeps contradictory existing-root reservations closed without writing a successor', async () => {
    for (const mismatch of ['ordinal', 'predecessor', 'preparing-active'] as const) {
      const next = { ...owner, episodeOrdinal: mismatch === 'ordinal' ? 2 : 1, activationId: '4'.repeat(32) };
      const reserved: RecoveryWitness = mismatch === 'preparing-active' ? { ...witness, owner: next, phase: 'preparing' }
        : { ...witness, owner: mismatch === 'predecessor' ? { ...owner, activationId: '5'.repeat(32) } : owner, phase: 'transferring', successor: next };
      const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: reserved });
      model.memory.seed(`operations/${owner.operationId}.json`, repair());
      await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety());
      assert.equal(model.memory.writes.length, 0);
      assert.deepEqual((await model.kernel.safety()).recoveryWitness, reserved);
    }
  });

  it('activates the durable reserved owner before rebinding an older lost correction pointer', async () => {
    const predecessorId = `jr-${'9'.repeat(32)}`;
    const planned = repair();
    let safety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'coreRejected', recoveryOperationId: predecessorId }, recoveryWitness: { ...witness, phase: 'preparing' } };
    const writes: string[] = [];
    const stop = new Error('Stop after durable pointer publication.');
    const inventory = { records: [{ record: planned, sha256: 'a'.repeat(64) }], invalid: [], fullTerminalCount: 0, handoffCount: 0 };
    const kernel = { resources: admittedCapacityFixture(), guard: { held: true }, scope: { bindingSha256: witness.scopeSha256 }, safety: async () => safety, carryHash: async () => null,
      operations: { list: async () => inventory, read: async (id: string) => id === planned.operationId ? { status: 'valid', value: planned, sha256: 'a'.repeat(64) } : { status: 'absent' } },
      journal: { read: async () => journal() }, safetyStore: {
        read: async () => ({ status: 'valid', value: safety, sha256: 'b'.repeat(64) }),
        activateWitness: async (candidate: typeof owner, proof: SafetyProof) => {
          assert.equal(sameRecoveryOwner(candidate, owner), true);
          assert.equal(await proof.verify(safety), true);
          writes.push('active'); safety = { ...safety, recoveryWitness: { ...witness, phase: 'active' } };
        },
        invalidate: async () => { writes.push('generation'); safety = { ...safety, generation: 'd'.repeat(32) }; return { value: safety, sha256: 'b'.repeat(64) }; },
        transferCorrection: async (id: string, prior: string, successor: string, proof: SafetyProof) => {
          assert.equal(safety.recoveryWitness?.phase, 'active');
          assert.equal(id, correctionId); assert.equal(prior, predecessorId); assert.equal(successor, owner.operationId);
          assert.equal(await proof.verify(safety), true);
          writes.push('pointer'); safety = { ...safety, correction: { ...safety.correction!, recoveryOperationId: successor } }; throw stop;
        },
      } } as unknown as Kernel;
    await assert.rejects(new RecoveryCoordinator(kernel).reconcileSafety(), error => error === stop);
    assert.deepEqual(writes, ['active', 'generation', 'pointer']);
    assert.equal(safety.correction?.reason, 'coreRejected');
    assert.equal(safety.correction?.correctionId, correctionId);
    assert.equal(safety.correction?.recoveryOperationId, owner.operationId);
  });

  it('does not allocate a replacement for a content-invalid reserved plan', async () => {
    let writes = 0;
    const safety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: { ...witness, phase: 'preparing' } };
    const kernel = { resources: admittedCapacityFixture(), carryHash: async () => null, safetyStore: { read: async () => ({ status: 'valid', value: safety, sha256: 'b'.repeat(64) }), invalidate: async () => { writes++; } },
      operations: { list: async () => ({ records: [], invalid: [{ name: `${owner.operationId}.json`, sha256: 'c'.repeat(64) }], fullTerminalCount: 0, handoffCount: 0 }),
        read: async () => ({ status: 'invalid', sha256: 'c'.repeat(64) }) } } as unknown as Kernel;
    await assert.rejects(new RecoveryCoordinator(kernel).reconcileSafety(), SafetyUnavailableError);
    assert.equal(writes, 0);
  });
});
