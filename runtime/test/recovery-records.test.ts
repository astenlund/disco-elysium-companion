import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControlDocumentError } from '../src/control-values.ts';
import { eventRewriteMetadata } from '../src/journal-records.ts';
import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { coreAttemptToken, effectivelyUnfinished, emptyRepairPlan, initialRecovery, parseHandoff, parseOperation, pendingOperationSafety } from '../src/operation-records.ts';
import { carryReleaseState, parsePrerequisite, parseRecoveryAction, recognizeAction, type ManifestObservation } from '../src/recovery-manifest.ts';
import { validateOperationTransition } from '../src/operations.ts';
import { journalEvent } from './support/journal-event.ts';

const scope = 'a'.repeat(64);
const rootId = `jr-${'b'.repeat(32)}`;
const time = '2026-10-08T06:00:00.0000000Z';
const later = '2026-10-08T07:00:00.0000000Z';
const json = (value: unknown) => parseStrictJson(Buffer.from(stringifyJson(value, 'state-event'), 'utf8'), 'state-event');
function repair() {
  return { operationVersion: 1, operationId: rootId, scopeSha256: scope, kind: 'repair', cause: 'lostJournal', startedAt: time, completedAt: null, outcome: null, compacted: false, plan: emptyRepairPlan(), recovery: initialRecovery(time, 'c'.repeat(32)) };
}

function deferredCarry() {
  const metadata = eventRewriteMetadata(journalEvent(1, { type: 'state.resync', coreRepairOperationId: rootId, attemptRef: { operationId: rootId, attemptOrdinal: 0 } }));
  const hash = '7'.repeat(64);
  const prerequisite = parsePrerequisite(json({ kind: 'cursor', actions: [{ kind: 'preserveRecovery', target: { path: 'journal/recovery-event.json', before: null, after: hash },
    source: { root: 'scope', path: 'journal/events/0000000000000001.json', sha256: '8'.repeat(64), payloadBindingSha256: 'f'.repeat(64) }, metadata }],
    nextAction: 1, carry: { path: 'journal/recovery-event.json', sha256: hash }, carryRelease: { attemptRef: { operationId: rootId, attemptOrdinal: 1 } }, skippedRanges: [] }));
  const original = repair();
  const handoff = { logicalOutboxId: metadata.logicalOutboxId, recordSha256: metadata.recordSha256, payloadBindingSha256: 'f'.repeat(64),
    journalId: metadata.acceptance!.journalId, eventId: metadata.acceptance!.eventId, acceptance: metadata.acceptance, presentation: 'replayable', coreRepairOperationId: rootId, attemptRef: metadata.attemptRef };
  const operation = { ...original, plan: { ...original.plan, handoffs: [handoff] }, recovery: { ...original.recovery,
    attempts: [...original.recovery.attempts, { publication: 'due', selectedRecord: null, journalEvent: null }],
    episodes: [{ ...original.recovery.episodes[0]!, replacementAttempt: 1, prerequisite }] } };
  return { prerequisite, operation };
}

describe('durable recovery records', () => {
  it('keeps rejected episodes active while deferred cleanup remains unresolved', () => {
    const { operation, prerequisite } = deferredCarry();
    const remove = { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: prerequisite.carry!.sha256, after: null } };
    for (const pending of [prerequisite, { ...prerequisite, actions: [...prerequisite.actions, remove] }]) {
      const rejected = { ...operation.recovery.episodes[0]!, phase: 'recordRejected', prerequisite: pending };
      const active = { ...operation, completedAt: time, outcome: 'recordRejected', recovery: { ...operation.recovery, episodes: [rejected] } };
      assert.doesNotThrow(() => parseOperation(json(active), scope));
      const ended = { ...rejected, endedAt: later };
      assert.throws(() => parseOperation(json({ ...active, recovery: { ...active.recovery, activeEpisode: null, episodes: [ended] } }), scope), ControlDocumentError);
      const successor = { ...rejected, activationId: '9'.repeat(32), trigger: 'cursor', phase: 'preparing', attemptAtStart: 1,
        replacementAttempt: null, startedAt: later };
      assert.throws(() => parseOperation(json({ ...active, recovery: { ...active.recovery, activeEpisode: 1, episodes: [ended, successor] } }), scope), ControlDocumentError);
    }
  });

  it('retains resolved rejected history and unresolved transferred or abandoned history', () => {
    const { operation, prerequisite } = deferredCarry();
    const first = operation.recovery.episodes[0]!;
    const terminal = { ...operation, completedAt: later, outcome: 'recordRejected' };
    const remove = { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: prerequisite.carry!.sha256, after: null } };
    const resolved = { ...first, phase: 'recordRejected', endedAt: later,
      prerequisite: { ...prerequisite, actions: [...prerequisite.actions, remove], nextAction: 2 } };
    assert.doesNotThrow(() => parseOperation(json({ ...terminal, recovery: { ...operation.recovery, activeEpisode: null, episodes: [resolved] } }), scope));
    const abandoned = { ...first, phase: 'abandonedByRelease', endedAt: later, releaseOperationId: `rl-${'8'.repeat(32)}` };
    assert.doesNotThrow(() => parseOperation(json({ ...terminal, recovery: { ...operation.recovery, activeEpisode: null, episodes: [abandoned] } }), scope));
    const transferred = { ...first, phase: 'transferred', endedAt: later, successorEpisode: 1 };
    const successor = { ...first, activationId: '9'.repeat(32), trigger: 'cursor', attemptAtStart: 1, replacementAttempt: null, startedAt: later };
    assert.doesNotThrow(() => parseOperation(json({ ...terminal, recovery: { ...operation.recovery, activeEpisode: 1, episodes: [transferred, successor] } }), scope));
  });

  it('preserves explicit abandon filename evidence without inventing a journal identity or range', () => {
    const operation = { operationVersion: 1, operationId: `rl-${'4'.repeat(32)}`, scopeSha256: scope, kind: 'release', cause: 'release', startedAt: time,
      completedAt: null, outcome: null, compacted: false, safety: { obligationId: '5'.repeat(32), phase: 'pending', correctionId: null },
      plan: { mode: 'abandon', abandonedSequences: [1, 2], journalId: null, skippedRanges: [], unfinishedRepairs: [], witness: null, witnessUnavailable: true, result: null, completedPhases: [] } };
    for (const journalId of [null, 'journal']) {
      const plan = { ...operation.plan, journalId };
      const parsed = parseOperation(json({ ...operation, plan }), scope);
      assert.ok(!parsed.compacted && parsed.kind === 'release');
      assert.equal(parsed.plan.journalId, journalId);
      assert.deepEqual(parsed.plan.abandonedSequences, [1, 2]);
      assert.deepEqual(parsed.plan.skippedRanges, []);
      assert.throws(() => parseOperation(json({ ...operation, plan: { ...plan, mode: 'confirmed' } }), scope), ControlDocumentError);
    }
    for (const abandonedSequences of [[1, 1], [0], [9007199254740992]]) {
      assert.throws(() => parseOperation(json({ ...operation, plan: { ...operation.plan, abandonedSequences } }), scope), ControlDocumentError);
    }
  });

  it('preserves the core receipt version range inside a repair plan', () => {
    const value = repair();
    value.plan = { ...value.plan, publishedVersions: { schemaVersion: 2, adapterVersion: -9223372036854775808n } };
    const parsed = parseOperation(json(value), scope);
    assert.ok(!parsed.compacted && parsed.kind === 'repair');
    assert.equal(parsed.plan.publishedVersions?.adapterVersion, -9223372036854775808n);
  });

  it('keeps historical completion separate from an active replay episode', () => {
    const value = repair();
    assert.equal(effectivelyUnfinished(parseOperation(json(value), scope)), true);
    const first = value.recovery.episodes[0]!;
    const checkpoint = { journalId: 'journal', eventId: 'd'.repeat(32), sequence: 1, generation: 'e'.repeat(32), acceptedAt: time };
    const completed = { ...value, completedAt: time, outcome: 'completed', recovery: { ...value.recovery, activeEpisode: null, episodes: [{ ...first, phase: 'completed', endedAt: time, acceptedRecovery: checkpoint }] } };
    assert.equal(effectivelyUnfinished(parseOperation(json(completed), scope)), false);
    const replay = { ...completed, recovery: { ...completed.recovery, activeEpisode: 1, episodes: [...completed.recovery.episodes, { ...first, activationId: 'f'.repeat(32), trigger: 'completedReplay', startedAt: later }] } };
    const parsed = parseOperation(json(replay), scope);
    assert.equal(parsed.completedAt, time);
    assert.equal(parsed.outcome, 'completed');
    assert.equal(effectivelyUnfinished(parsed), true);
    assert.equal(effectivelyUnfinished(parseOperation(json(completed), scope), true), true);
  });

  it('rejects dangling ordinals, reused activations, malformed phases and false terminal authority', () => {
    const value = repair();
    for (const recovery of [
      { ...value.recovery, activeEpisode: 1 },
      { ...value.recovery, attempts: [] },
      { ...value.recovery, activeEpisode: null },
      { ...value.recovery, episodes: [{ ...value.recovery.episodes[0], attemptAtStart: 1 }] },
      { ...value.recovery, episodes: [{ ...value.recovery.episodes[0], phase: 'completed', endedAt: time }] },
      { ...value.recovery, episodes: [{ ...value.recovery.episodes[0], replacementAttempt: 0 }] },
    ]) { assert.throws(() => parseOperation(json({ ...value, recovery }), scope), ControlDocumentError); }
    assert.throws(() => parseOperation(json({ ...value, scopeSha256: 'f'.repeat(64) }), scope), ControlDocumentError);
    assert.throws(() => parseOperation(json({ ...value, outcome: 'refused', completedAt: time }), scope), ControlDocumentError);
    assert.equal(coreAttemptToken(rootId, 0), rootId);
    assert.equal(coreAttemptToken(rootId, 2), `${rootId}-r2`);
    assert.throws(() => coreAttemptToken(rootId, -1), ControlDocumentError);
  });

  it('does not turn nullable cleanup evidence or another root association into replay authority', () => {
    const handoff = { logicalOutboxId: `${'1'.repeat(32)}-1`, recordSha256: '2'.repeat(64), payloadBindingSha256: null, journalId: 'original', eventId: 'event', acceptance: null,
      presentation: 'unverified', coreRepairOperationId: coreAttemptToken(rootId, 1), attemptRef: { operationId: rootId, attemptOrdinal: 1 } };
    assert.equal(parseHandoff(json(handoff)).presentation, 'unverified');
    assert.throws(() => parseHandoff(json({ ...handoff, presentation: 'replayable' })), ControlDocumentError);
    assert.throws(() => parseHandoff(json({ ...handoff, coreRepairOperationId: rootId })), ControlDocumentError);
    assert.throws(() => parseHandoff(json({ ...handoff, acceptance: { journalId: 'other', eventId: 'event', generation: '3'.repeat(32) } })), ControlDocumentError);
  });

  it('keeps pending consumer safety visible even on a terminal handover', () => {
    const operation = { operationVersion: 1, operationId: `ho-${'4'.repeat(32)}`, scopeSha256: scope, kind: 'handover', cause: 'handover', startedAt: time, completedAt: later,
      outcome: 'completed', compacted: false, plan: { owner: 'runtime', result: { owner: 'runtime', previousOwner: 'bridge', changed: true, baselineRemoved: false, abandonedCount: 0 }, completedPhases: ['coreSwitched', 'complete'] }, safety: { obligationId: '5'.repeat(32), phase: 'pending', correctionId: null } };
    const parsed = parseOperation(json(operation), scope);
    assert.equal(effectivelyUnfinished(parsed), false);
    assert.equal(pendingOperationSafety(parsed), true);
    assert.throws(() => parseOperation(json({ ...operation, safety: { ...operation.safety, phase: 'transferred' } }), scope), ControlDocumentError);
  });
});

describe('write-ahead manifest crash recognition', () => {
  it('requires exact deferred cleanup grammar and preservation evidence', () => {
    const { prerequisite } = deferredCarry();
    const { carryRelease: omitted, ...withoutRelease } = prerequisite;
    assert.ok(omitted);
    assert.throws(() => parsePrerequisite(json(withoutRelease)));
    for (const carryRelease of [{}, { attemptRef: null }, { attemptRef: {} }, { attemptRef: { operationId: rootId, attemptOrdinal: -1 } },
      { attemptRef: { operationId: rootId, attemptOrdinal: 1.5 } }, { attemptRef: { operationId: rootId, attemptOrdinal: 9007199254740992 } },
      { attemptRef: { operationId: rootId.toUpperCase(), attemptOrdinal: 1 } }, { attemptRef: { operationId: rootId, attemptOrdinal: 1, extra: true } },
      { attemptRef: { operationId: rootId, attemptOrdinal: 1 }, extra: true }]) {
      assert.throws(() => parsePrerequisite(json({ ...prerequisite, carryRelease })));
    }
    assert.throws(() => parsePrerequisite(json({ ...prerequisite, carry: null })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...prerequisite, actions: [], nextAction: 0 })), ControlDocumentError);
    const duplicate = stringifyJson(prerequisite, 'state-event').replace('"carryRelease":', '"carryRelease":null,"carryRelease":');
    assert.throws(() => parseStrictJson(Buffer.from(duplicate), 'state-event'));
    assert.equal(parsePrerequisite(json({ ...prerequisite, carryRelease: null })).carryRelease, null);
  });

  it('distinguishes structural completion from pending and confirmed carry removal', () => {
    const { prerequisite } = deferredCarry();
    assert.equal(carryReleaseState(prerequisite), 'waitingReplacement');
    const action = { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: prerequisite.carry!.sha256, after: null } };
    const pending = parsePrerequisite(json({ ...prerequisite, actions: [...prerequisite.actions, action] }));
    assert.equal(carryReleaseState(pending), 'pendingCleanup');
    assert.equal(carryReleaseState(parsePrerequisite(json({ ...pending, nextAction: 2 }))), 'resolved');
    assert.equal(carryReleaseState(null), 'none');
  });

  it('rejects reuse of a deferred carry slot after its single cleanup action', () => {
    const { prerequisite } = deferredCarry();
    const preserve = prerequisite.actions[0]!;
    const remove = { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: prerequisite.carry!.sha256, after: null } };
    for (const actions of [[preserve, remove, preserve, remove], [preserve, remove, preserve]]) {
      assert.throws(() => parsePrerequisite(json({ ...prerequisite, actions, nextAction: 3 })), ControlDocumentError);
    }
  });

  it('rejects retained handoffs that change the preserved original settlement binding', () => {
    const { operation, prerequisite } = deferredCarry();
    const handoff = operation.plan.handoffs[0]!;
    assert.doesNotThrow(() => parseOperation(json(operation), scope));
    for (const changed of [{ journalId: 'different-journal', eventId: handoff.eventId }, { journalId: handoff.journalId, eventId: 'different-event' }]) {
      const altered = { ...handoff, ...changed, acceptance: { ...handoff.acceptance!, ...changed } };
      assert.throws(() => parseOperation(json({ ...operation, plan: { ...operation.plan, handoffs: [altered] } }), scope), ControlDocumentError);
    }
    const preserve = prerequisite.actions[0]!;
    assert.ok(preserve.kind === 'preserveRecovery');
    const withoutAcceptance = { ...operation, plan: { ...operation.plan, handoffs: [{ ...handoff, journalId: preserve.metadata.journalId,
      eventId: preserve.metadata.eventId, acceptance: null }] }, recovery: { ...operation.recovery, episodes: [{ ...operation.recovery.episodes[0]!,
      prerequisite: { ...prerequisite, actions: [{ ...preserve, metadata: { ...preserve.metadata, acceptance: null, settlement: 'pending' } }] } }] } };
    assert.doesNotThrow(() => parseOperation(json(withoutAcceptance), scope));
    assert.throws(() => parseOperation(json({ ...withoutAcceptance, plan: { ...withoutAcceptance.plan,
      handoffs: [{ ...withoutAcceptance.plan.handoffs[0]!, eventId: 'different-event' }] } }), scope), ControlDocumentError);
  });

  it('validates local replacement bounds and the original handoff without conflating their attempts', () => {
    const { operation, prerequisite } = deferredCarry();
    assert.doesNotThrow(() => parseOperation(json(operation), scope));
    for (const attemptRef of [{ operationId: rootId, attemptOrdinal: 2 }, { operationId: `jr-${'9'.repeat(32)}`, attemptOrdinal: 0 }]) {
      const episodes = [{ ...operation.recovery.episodes[0]!, prerequisite: { ...prerequisite, carryRelease: { attemptRef } } }];
      assert.throws(() => parseOperation(json({ ...operation, recovery: { ...operation.recovery, episodes } }), scope), ControlDocumentError);
    }
    assert.throws(() => parseOperation(json({ ...operation, plan: { ...operation.plan, handoffs: [] } }), scope), ControlDocumentError);
    const foreign = `jr-${'9'.repeat(32)}`;
    const inherited = { ...operation, plan: { ...operation.plan, inheritedRecovery: { operationId: foreign, episodeOrdinal: 0, activationId: '9'.repeat(32) } },
      recovery: { ...operation.recovery, episodes: [{ ...operation.recovery.episodes[0]!, prerequisite: { ...prerequisite, carryRelease: { attemptRef: { operationId: foreign, attemptOrdinal: 0 } } } }] } };
    assert.doesNotThrow(() => parseOperation(json(inherited), scope));
  });

  it('does not silently erase unresolved cleanup during operation updates', () => {
    const { operation, prerequisite } = deferredCarry();
    const before = parseOperation(json(operation), scope);
    const after = parseOperation(json({ ...operation, recovery: { ...operation.recovery,
      episodes: [{ ...operation.recovery.episodes[0]!, prerequisite: { ...prerequisite, carryRelease: null } }] } }), scope);
    assert.ok(!before.compacted && !after.compacted);
    assert.throws(() => validateOperationTransition(before, after), ControlDocumentError);
    assert.doesNotThrow(() => validateOperationTransition(before, before));
  });

  it('retains inherited cleanup across episode transfer and atomically retargets a new replacement', () => {
    const { operation, prerequisite } = deferredCarry();
    const before = parseOperation(json(operation), scope);
    const transferred = { ...operation, recovery: { ...operation.recovery, activeEpisode: 1, episodes: [
      { ...operation.recovery.episodes[0]!, phase: 'transferred', successorEpisode: 1, endedAt: later },
      { ...operation.recovery.episodes[0]!, activationId: '9'.repeat(32), trigger: 'cursor', startedAt: later, attemptAtStart: 1, replacementAttempt: null },
    ] } };
    const inherited = parseOperation(json(transferred), scope);
    assert.ok(!before.compacted && !inherited.compacted);
    assert.doesNotThrow(() => validateOperationTransition(before, inherited));
    const retargeted = { ...transferred, recovery: { ...transferred.recovery,
      attempts: [...transferred.recovery.attempts, { publication: 'due', selectedRecord: null, journalEvent: null }],
      episodes: [transferred.recovery.episodes[0], { ...transferred.recovery.episodes[1]!, replacementAttempt: 2,
        prerequisite: { ...prerequisite, carryRelease: { attemptRef: { operationId: rootId, attemptOrdinal: 2 } } } }] } };
    const updated = parseOperation(json(retargeted), scope);
    assert.ok(!updated.compacted);
    assert.doesNotThrow(() => validateOperationTransition(inherited, updated));
    const stale = parseOperation(json({ ...transferred, recovery: { ...transferred.recovery,
      episodes: [transferred.recovery.episodes[0], { ...transferred.recovery.episodes[1]!,
        prerequisite: { ...prerequisite, carryRelease: { attemptRef: { operationId: rootId, attemptOrdinal: 0 } } } }] } }), scope);
    assert.ok(!stale.compacted);
    assert.throws(() => validateOperationTransition(inherited, stale), ControlDocumentError);
  });

  it('does not turn out-of-domain sequence filenames into recovery authority', () => {
    const hash = '7'.repeat(64);
    const metadata = eventRewriteMetadata(journalEvent(1));
    for (const sequence of ['0000000000000000', '9007199254740992']) {
      const journalName = `journal/events/${sequence}.json`;
      const quarantineName = `quarantine/${sequence}.json.${'6'.repeat(32)}.quarantined`;
      assert.throws(() => parsePrerequisite(json({ kind: 'gap', actions: [{ kind: 'quarantine', source: { path: journalName, before: hash, after: null },
        target: { path: quarantineName, before: null, after: hash } }], nextAction: 0, carry: null, carryRelease: null, skippedRanges: [] })), ControlDocumentError);
      assert.throws(() => parseRecoveryAction(json({ kind: 'preserveRecovery', target: { path: 'journal/recovery-event.json', before: null, after: hash },
        source: { root: 'companion', path: `state/outbox/event-${sequence}.json`, sha256: hash, payloadBindingSha256: hash }, metadata })), ControlDocumentError);
    }
    assert.equal(parseRecoveryAction(json({ kind: 'preserveRecovery', target: { path: 'journal/recovery-event.json', before: null, after: hash },
      source: { root: 'companion', path: 'state/outbox/event-9007199254740991.json', sha256: hash, payloadBindingSha256: hash }, metadata })).kind, 'preserveRecovery');
  });

  it('recognizes completed quarantine by both paths without replaying from diagnostic bytes', () => {
    const source = 'journal/events/0000000000000001.json';
    const target = `quarantine/0000000000000001.json.${'6'.repeat(32)}.quarantined`;
    const hash = '7'.repeat(64);
    const plan = parsePrerequisite(json({ kind: 'gap', actions: [{ kind: 'quarantine', source: { path: source, before: hash, after: null }, target: { path: target, before: null, after: hash } }], nextAction: 0, carry: null, carryRelease: null, skippedRanges: [] }));
    const observation = (sourceHash: string | null, targetHash: string | null) => new Map<string, ManifestObservation>([[source, { status: 'readable', sha256: sourceHash }], [target, { status: 'readable', sha256: targetHash }]]);
    assert.equal(recognizeAction(plan.actions[0]!, observation(hash, null)), 'before');
    assert.equal(recognizeAction(plan.actions[0]!, observation(null, hash)), 'after');
    assert.equal(recognizeAction(plan.actions[0]!, observation(null, '8'.repeat(64))), 'damage');
    const unavailable = observation(hash, null);
    unavailable.set(target, { status: 'unavailable' });
    assert.equal(recognizeAction(plan.actions[0]!, unavailable), 'unavailable');
  });

  it('rejects incoherent path chains, unbound carry and out-of-scope mutation paths', () => {
    const base = { kind: 'cursor', actions: [], nextAction: 0, carry: null, carryRelease: null, skippedRanges: [] };
    assert.equal(parsePrerequisite(json(base)).nextAction, 0);
    assert.throws(() => parsePrerequisite(json({ ...base, nextAction: 1 })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...base, actions: [{ kind: 'removeCarry', target: { path: '../state/current.json', before: 'a'.repeat(64), after: null } }] })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...base, actions: [{ kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: 'a'.repeat(64), after: null } }] })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...base, carry: { path: 'journal/recovery-event.json', sha256: 'a'.repeat(64) }, actions: [{ kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: 'a'.repeat(64), after: null } }, { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: 'a'.repeat(64), after: null } }] })), ControlDocumentError);
  });
});
