import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControlDocumentError } from '../src/control-values.ts';
import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { coreAttemptToken, effectivelyUnfinished, emptyRepairPlan, initialRecovery, parseHandoff, parseOperation, pendingOperationSafety } from '../src/operation-records.ts';
import { parsePrerequisite, recognizeAction, type ManifestObservation } from '../src/recovery-manifest.ts';

const scope = 'a'.repeat(64);
const rootId = `jr-${'b'.repeat(32)}`;
const time = '2026-10-08T06:00:00.0000000Z';
const later = '2026-10-08T07:00:00.0000000Z';
const json = (value: unknown) => parseStrictJson(Buffer.from(stringifyJson(value, 'state-event'), 'utf8'), 'state-event');
function repair() {
  return { operationVersion: 1, operationId: rootId, scopeSha256: scope, kind: 'repair', cause: 'lostJournal', startedAt: time, completedAt: null, outcome: null, compacted: false, plan: emptyRepairPlan(), recovery: initialRecovery(time, 'c'.repeat(32)) };
}

describe('durable recovery records', () => {
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
  it('recognizes completed quarantine by both paths without replaying from diagnostic bytes', () => {
    const source = 'journal/events/0000000000000001.json';
    const target = `quarantine/0000000000000001.json.${'6'.repeat(32)}.quarantined`;
    const hash = '7'.repeat(64);
    const plan = parsePrerequisite(json({ kind: 'gap', actions: [{ kind: 'quarantine', source: { path: source, before: hash, after: null }, target: { path: target, before: null, after: hash } }], nextAction: 0, carry: null, skippedRanges: [] }));
    const observation = (sourceHash: string | null, targetHash: string | null) => new Map<string, ManifestObservation>([[source, { status: 'readable', sha256: sourceHash }], [target, { status: 'readable', sha256: targetHash }]]);
    assert.equal(recognizeAction(plan.actions[0]!, observation(hash, null)), 'before');
    assert.equal(recognizeAction(plan.actions[0]!, observation(null, hash)), 'after');
    assert.equal(recognizeAction(plan.actions[0]!, observation(null, '8'.repeat(64))), 'damage');
    const unavailable = observation(hash, null);
    unavailable.set(target, { status: 'unavailable' });
    assert.equal(recognizeAction(plan.actions[0]!, unavailable), 'unavailable');
  });

  it('rejects incoherent path chains, unbound carry and out-of-scope mutation paths', () => {
    const base = { kind: 'cursor', actions: [], nextAction: 0, carry: null, skippedRanges: [] };
    assert.equal(parsePrerequisite(json(base)).nextAction, 0);
    assert.throws(() => parsePrerequisite(json({ ...base, nextAction: 1 })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...base, actions: [{ kind: 'removeCarry', target: { path: '../state/current.json', before: 'a'.repeat(64), after: null } }] })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...base, actions: [{ kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: 'a'.repeat(64), after: null } }] })), ControlDocumentError);
    assert.throws(() => parsePrerequisite(json({ ...base, carry: { path: 'journal/recovery-event.json', sha256: 'a'.repeat(64) }, actions: [{ kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: 'a'.repeat(64), after: null } }, { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: 'a'.repeat(64), after: null } }] })), ControlDocumentError);
  });
});
