import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasCarryAuthority, hasProviderAuthority } from '../../src/backend/provider-authority.ts';
import { Kernel, type KernelInput } from '../../src/backend/kernel.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import { Deadline } from '../../src/deadline.ts';
import { CoordinatorBackend } from '../../src/backend/index.ts';
import { DataRootUnavailableError } from '../../src/admission.ts';
import { SafetyUnavailableError } from '../../src/safety-records.ts';
import { authorityModel, journal, repair } from './authority-fixtures.ts';
import { journalEvent } from '../support/journal-event.ts';
import { eventRewriteMetadata } from '../../src/journal-records.ts';
import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { bytesHash } from '../../src/storage.ts';
import { DeliveryCoordinator } from '../../src/backend/delivery.ts';
import { ContextPreparer, type ContextCandidate } from '../../src/prepared-context.ts';
import { WindowRecovery, WindowRecoveryError, recoveryFingerprint } from '../../src/window-recovery.ts';
import { parseSessionBinding } from '../../src/session-records.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import type { HandoverOperation, RepairOperation } from '../../src/operation-records.ts';
import type { OperationInventory } from '../../src/operations.ts';
import type { StateSafety } from '../../src/safety-records.ts';

const now = '2026-10-08T00:00:00.0000000Z';
const generation = '1'.repeat(32);
const scope = 'a'.repeat(64);
const clean: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null };
const empty: OperationInventory = { records: [], invalid: [], handoffCount: 0, fullTerminalCount: 0 };
const handover: HandoverOperation = { operationVersion: 1, operationId: `ho-${'2'.repeat(32)}`, scopeSha256: scope, kind: 'handover', cause: 'handover', compacted: false,
  startedAt: now, completedAt: now, outcome: 'completed', safety: { obligationId: '3'.repeat(32), phase: 'pending', correctionId: null },
  plan: { owner: 'runtime', result: { owner: 'runtime', previousOwner: 'runtime', changed: false, baselineRemoved: false, abandonedCount: 0 }, completedPhases: ['coreSwitched', 'complete'] } };
const inventory = (record: HandoverOperation | RepairOperation): OperationInventory => ({ ...empty, records: [{ record, sha256: 'b'.repeat(64) }], fullTerminalCount: record.completedAt === null ? 0 : 1 });

describe('independent provider admission authority', () => {
  it('admits proved clean safety and refuses an unfinished checked observation', () => {
    assert.equal(hasProviderAuthority(clean, empty), true);
    assert.equal(hasProviderAuthority({ ...clean, pendingCheck: '4'.repeat(32) }, empty), false);
  });

  it('keeps a terminal consumer safety obligation effective until transfer', () => {
    assert.equal(hasProviderAuthority(clean, inventory(handover)), false);
    assert.equal(hasProviderAuthority(clean, inventory({ ...handover, safety: { ...handover.safety, phase: 'discharged' } })), true);
  });

  it('rejects damaged operations and corrections whose owning plan is missing', () => {
    assert.equal(hasProviderAuthority(clean, { ...empty, invalid: [{ name: handover.operationId + '.json', sha256: 'c'.repeat(64) }] }), false);
    assert.equal(hasProviderAuthority({ ...clean, correction: { correctionId: '5'.repeat(32), reason: 'contextUncertain', recoveryOperationId: null } }, empty), false);
    assert.equal(hasProviderAuthority({ ...clean, correction: { correctionId: '5'.repeat(32), reason: 'contextUncertain', recoveryOperationId: `jr-${'6'.repeat(32)}` } }, empty), false);
  });

  it('refuses a preparing or orphaned recovery witness even without correction', () => {
    const witness = { scopeSha256: scope, owner: { operationId: `jr-${'6'.repeat(32)}`, episodeOrdinal: 0, activationId: '7'.repeat(32) }, phase: 'preparing' as const, successor: null, disclosure: null };
    assert.equal(hasProviderAuthority({ ...clean, recoveryWitness: witness }, empty), false);
    assert.equal(hasProviderAuthority({ ...clean, recoveryWitness: { ...witness, phase: 'active' } }, empty), false);
  });

  it('requires the completed checkpoint and independent disclosure to agree before provider reuse', () => {
    const operationId = `jr-${'6'.repeat(32)}`;
    const accepted = { journalId: 'journal', eventId: '8'.repeat(32), sequence: 1, generation, acceptedAt: now };
    const repair: RepairOperation = { operationVersion: 1, operationId, scopeSha256: scope, kind: 'repair', cause: 'lostJournal', compacted: false,
      startedAt: now, completedAt: now, outcome: 'completed', plan: { lastGoodSequence: 0, affected: [], cursorTo: null, rejectedRecord: null, lostOperations: [],
        publishedVersions: { schemaVersion: 2, adapterVersion: 2 }, retiredRecords: [], handoffs: [], correctionId: null, inheritedRecovery: null, skippedRanges: [] },
      recovery: { attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: `${'9'.repeat(32)}-1`, recordSha256: 'b'.repeat(64) }, journalEvent: { journalId: accepted.journalId, eventId: accepted.eventId, sequence: 1 } }],
        episodes: [{ activationId: '7'.repeat(32), trigger: 'initial', phase: 'completed', attemptAtStart: 0, replacementAttempt: null, prerequisite: null, acceptedRecovery: accepted,
          successorEpisode: null, releaseOperationId: null, startedAt: now, endedAt: now }], activeEpisode: null } };
    const owner = { operationId, episodeOrdinal: 0, activationId: '7'.repeat(32) };
    const disclosure = { journalId: accepted.journalId, eventId: accepted.eventId, sequence: accepted.sequence, generation };
    const witness = { scopeSha256: scope, owner, phase: 'awaitingDisclosure' as const, successor: null, disclosure };
    assert.equal(hasProviderAuthority({ ...clean, recoveryWitness: witness }, inventory(repair)), true);
    assert.equal(hasProviderAuthority({ ...clean, recoveryWitness: { ...witness, phase: 'active', disclosure: null } }, inventory(repair)), false);
    assert.equal(hasProviderAuthority({ ...clean, recoveryWitness: { ...witness, disclosure: { ...disclosure, eventId: 'a'.repeat(32) } } }, inventory(repair)), false);
    assert.equal(hasProviderAuthority({ ...clean, generation: 'c'.repeat(32), recoveryWitness: witness }, inventory(repair)), false);
  });

  it('refuses publish and settlement before a native child when a consumer obligation survives', async () => {
    const pendingHandover: HandoverOperation = { ...handover, completedAt: null, outcome: null, plan: { owner: 'runtime', result: null, completedPhases: [] } };
    const cases: readonly [OperationInventory, boolean][] = [[inventory(handover), true], [inventory(pendingHandover), true],
      [inventory({ ...pendingHandover, safety: { ...handover.safety, phase: 'transferred', correctionId: '5'.repeat(32) } }), true],
      [{ ...empty, invalid: [{ name: handover.operationId + '.json', sha256: null }] }, true],
      [inventory({ ...handover, safety: { ...handover.safety, phase: 'discharged' } }), false]];
    for (const [pending, denied] of cases) {
      for (const operation of ['publish', 'settlement'] as const) {
        let calls = 0;
        let completions = 0;
        const reachedNative = new Error('Fixture reached the native execution boundary.');
        const input = {
          config: { configVersion: 1, adapter: 'stub', game: 'stubgame', provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } },
          identities: { runtimeInstanceId: '1'.repeat(32), runtimeSessionId: '2'.repeat(32), adapterBindingEpoch: '3'.repeat(32) },
          scope: { companionRoot: 'C:/Git/disco-elysium-companion/.tmp/never-created-admission', dataRoot: 'C:/Git/disco-elysium-companion/.tmp/never-created-admission/data', game: 'stubgame', principal: 'principal', bindingSha256: scope, createdHere: false },
          guard: { held: true }, inspector: {}, publisher: {}, storage: {}, resources: {}, options: { companionRoot: 'unused' },
          supervisor: { run: async () => { calls++; throw reachedNative; }, verifyQuiescent: async () => {} },
        } as unknown as KernelInput;
        const kernel = new Kernel(input);
        const safety = { ...clean, pendingCheck: '6'.repeat(32) };
        kernel.operations.list = async () => pending;
        kernel.safetyStore.armCheck = async () => ({ value: safety, sha256: 'b'.repeat(64), checkToken: safety.pendingCheck });
        kernel.safetyStore.read = async () => ({ status: 'valid', value: safety, sha256: 'b'.repeat(64) });
        kernel.safetyStore.finishCheck = async () => { completions++; return true; };
        const deadline = Deadline.after(30000);
        const binding = { logicalOutboxId: `${'7'.repeat(32)}-1`, recordSha256: 'c'.repeat(64), journalId: 'journal', eventId: 'event' };
        const action = operation === 'publish' ? kernel.publish(false, null, deadline)
          : kernel.checked({ kind: 'settlement', binding }, () => kernel.core.settle(binding, deadline), async () => {}, deadline);
        await assert.rejects(action, error => denied ? error instanceof ControlDocumentError : error === reachedNative);
        assert.equal(calls, denied ? 0 : 1, operation);
        assert.equal(completions, 0, operation);
      }
    }
  });
});

describe('deciding authority controls', () => {
  it('withholds old provider authority when an unbound recovery slot contradicts a null witness', async context => {
    const model = authorityModel(clean);
    const backend = new CoordinatorBackend(model.kernel, { value: { runtimeInstanceId: model.kernel.identities.runtimeInstanceId, startedAt: now, cleanShutdown: false, watcher: null }, sha256: 'd'.repeat(64) });
    const before = await backend.providerSafety();
    const identity = { providerId: 'model-provider', providerSessionId: 'model-session', isCurrent: () => true };
    const bound = await backend.sessions.bind({ agentSessionVersion: 1, providerId: identity.providerId, providerSessionId: identity.providerSessionId,
      createdAt: now, turnsCompleted: 0, needsState: true, instructionsSha256: 'e'.repeat(64), stateGeneration: before.generation }, backend.sessionProof(identity));
    assert.equal(await backend.sessionProof(identity).verify(bound.binding), true);
    // Opaque disk-loss evidence is not parsed or asserted to be an accepted payload.
    model.memory.files.set('journal/recovery-event.json', Buffer.from('unbound recovery evidence'));
    let admitted: Awaited<ReturnType<typeof backend.providerSafety>> | null = null;
    try { admitted = await backend.providerSafety(); }
    catch (error) { assert.ok(error instanceof SafetyUnavailableError || error instanceof DataRootUnavailableError || error instanceof ControlDocumentError); }
    const oldHistoryAllowed = await backend.sessionProof(identity).verify(bound.binding);
    context.diagnostic(JSON.stringify({ admittedGeneration: admitted?.generation ?? null, previousGeneration: before.generation,
      oldHistoryAllowed, observedSlot: model.memory.inspections.includes('journal/recovery-event.json') }));
    assert.ok(admitted === null || admitted.generation !== before.generation && admitted.correction !== null, 'Unbound recovery evidence cannot retain clean admission in the previous generation.');
    assert.equal(oldHistoryAllowed, false);
    const [planned] = await model.records();
    assert.ok(planned !== undefined && !planned.compacted && planned.kind === 'repair');
    assert.equal(planned.cause, 'operationLost');
    assert.deepEqual(planned.recovery.episodes[0]!.prerequisite?.actions[0]?.kind, 'quarantine');
    assert.equal(planned.recovery.episodes[0]!.prerequisite?.carry, null);
    assert.equal(model.memory.files.get('journal/recovery-event.json')?.toString(), 'unbound recovery evidence');
  });
});

describe('recovery slot authority', () => {
  it('requires one exact owning manifest and rejects completed removal or changed bytes', () => {
    const hash = '7'.repeat(64);
    const source = repair();
    const event = journalEvent(1);
    const metadata = eventRewriteMetadata(event);
    const prerequisite = { kind: 'rewind' as const, nextAction: 1, carry: { path: 'journal/recovery-event.json' as const, sha256: hash }, skippedRanges: [],
      actions: [{ kind: 'preserveRecovery' as const, source: { root: 'scope' as const, path: 'journal/events/0000000000000001.json', sha256: '8'.repeat(64), payloadBindingSha256: event.payloadBindingSha256 },
        target: { path: 'journal/recovery-event.json', before: null, after: hash }, metadata }] };
    const historical = repair({ ...source, completedAt: now, outcome: 'recordRejected', recovery: { ...source.recovery, activeEpisode: null,
      episodes: [{ ...source.recovery.episodes[0]!, phase: 'recordRejected', endedAt: now, prerequisite }] } });
    assert.equal(hasCarryAuthority(null, empty), true);
    assert.equal(hasCarryAuthority(hash, empty), false);
    assert.equal(hasCarryAuthority(hash, inventory(historical)), true, 'A retained historical cleanup plan still owns the exact slot.');
    assert.equal(hasCarryAuthority('9'.repeat(64), inventory(historical)), false);
    const removed = repair({ ...historical, recovery: { ...historical.recovery, episodes: [{ ...historical.recovery.episodes[0]!, prerequisite: { ...prerequisite,
      nextAction: 2, actions: [...prerequisite.actions, { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: hash, after: null } }] } }] } });
    assert.equal(hasCarryAuthority(hash, inventory(removed)), false);
    const duplicate = repair({ ...historical, operationId: `jr-${'8'.repeat(32)}` });
    assert.equal(hasCarryAuthority(hash, { ...empty, records: [...inventory(historical).records, ...inventory(duplicate).records] }), false);
  });

  it('preserves unreadable carry evidence and never reports clean authority', async () => {
    const model = authorityModel(clean);
    model.memory.files.set('journal/recovery-event.json', Buffer.from('unreadable evidence'));
    model.memory.unreadable.add('journal/recovery-event.json');
    await assert.rejects(model.kernel.providerAuthority(await model.kernel.safety()), DataRootUnavailableError);
    await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), DataRootUnavailableError);
    assert.equal(model.memory.writes.length, 0);
    assert.equal((await model.records()).length, 0);
  });

  it('resumes the same reserved quarantine without treating its opaque bytes as replay state', async () => {
    const model = authorityModel(clean);
    const bytes = Buffer.from('opaque unbound evidence');
    model.memory.files.set('journal/recovery-event.json', bytes);
    const recovery = new RecoveryCoordinator(model.kernel);
    await recovery.reconcileSafety();
    const first = await model.kernel.safety();
    await recovery.reconcileSafety();
    assert.deepEqual(await model.kernel.safety(), first);
    const records = await model.records();
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.ok(!record.compacted && record.kind === 'repair');
    const plan = record.recovery.episodes[0]!.prerequisite!;
    assert.equal(plan.carry, null);
    assert.equal(plan.actions.length, 1);
    assert.deepEqual(plan.actions[0]!.kind === 'quarantine' && plan.actions[0]!.source, { path: 'journal/recovery-event.json', before: bytesHash(bytes), after: null });
    assert.equal(record.plan.handoffs.length, 0);
    assert.equal(model.memory.writes.some(value => value.startsWith('journal/events/')), false);
  });
});

describe('codec-owned relevance lifecycle', () => {
  const nativeWarning = '05987956f9661eb6ec143e5e10559a5a9d2bca5f4bd153da971f350514df379c';
  const nativeClean = 'be3b1e92ab484c0d3a0118ebce41b215b3da50222a44004ad1c4f083cf3e0b8f';
  const floor = 'ac7b70e9c22085f6f62d46a31c9a438b851049f7f978f97ca1d1f2f82ea48dc5';
  function candidates(fingerprint: string): ContextCandidate[] {
    return [1, 3, 4].map(shape => ({ shape: shape as 1 | 3 | 4, fingerprint: shape === 4 ? floor : fingerprint, sha256: 'a'.repeat(64),
      bytes: shape === 4 ? 465 : 1075, eventCount: 0, stateIncluded: shape !== 4, degraded: shape === 4 ? 'stateTooLarge' : null }));
  }
  function deliveryFixture() {
    const event = journalEvent(1, { adapter: 'stubgame', acknowledgedAt: now, acceptance: { journalId: 'journal', eventId: '1'.repeat(32), generation } });
    const events = new Map([[1, { metadata: event, sha256: 'a'.repeat(64) }]]);
    const model = authorityModel(clean, { ...journal(1, 1), events });
    model.kernel.publish = async (_required, _repair, _deadline, _operation, afterChild) => {
      const result = { success: true as const, value: { outcome: 'unchanged' as const, kind: null, logicalOutboxId: null, sequence: null, schemaVersion: 2, adapterVersion: 1,
        game: 'stubgame', targetIdentitySha256: event.targetIdentitySha256, targetGeneratedAt: event.stateGeneratedAt, baselineApplied: null, cacheDegraded: false, warnings: [] } };
      model.kernel.operational.observe(result); afterChild?.(result, performance.now()); return result;
    };
    model.kernel.drain = async () => model.kernel.journal.read();
    const binding = parseSessionBinding(parseStrictJson(Buffer.from(stringifyJson({ agentSessionVersion: 1, providerId: 'fixture', providerSessionId: 'fixture-session',
      createdAt: now, turnsCompleted: 1, needsState: true, instructionsSha256: 'b'.repeat(64), stateGeneration: generation }))));
    return { ...model, events, binding, delivery: new DeliveryCoordinator(model.kernel, async () => { throw new Error('Unexpected retention.'); }) };
  }

  it('preserves the empty candidate boundary for initial, exhausted and disclosure selection', async () => {
    const model = deliveryFixture();
    const original = ContextPreparer.prototype.preview;
    ContextPreparer.prototype.preview = async () => ({ candidates: [] });
    const createWindow = () => {
      const value = new WindowRecovery('logical', recoveryFingerprint('provider'), null);
      value.bind('logical', 'instance'); value.select('ordinary', 'unchanged question');
      return value;
    };
    try {
      const snapshot = await model.delivery.acquire({ interactionId: 'empty-preview', requestReceivedAt: now });
      const preview = await model.delivery.preview(snapshot, model.binding, null);
      assert.deepEqual(preview.preview.candidates, []);
      assert.equal(preview.relevanceFingerprint, snapshot.relevanceFingerprint);
      const initial = createWindow();
      assert.throws(() => initial.prepare(preview.preview.candidates, preview.relevanceFingerprint), WindowRecoveryError);
      assert.equal(initial.summary()?.state, 'unavailable');
      const failed = createWindow();
      const ticket = failed.prepare(candidates(nativeClean), nativeClean)!;
      failed.sent(ticket, 'instance'); failed.finished(ticket, 'instance', 'contextExhausted');
      assert.equal(failed.prepare(preview.preview.candidates, preview.relevanceFingerprint), null);
      assert.equal(failed.summary()?.state, 'exhausted');
      assert.equal(failed.summary()?.descendingFailures, 1);
      assert.equal(failed.summary()?.revalidationAvailable, true);
      const disclosure = createWindow();
      assert.throws(() => disclosure.prepare(preview.preview.candidates, preview.relevanceFingerprint, true), WindowRecoveryError);
      assert.equal(disclosure.summary()?.state, 'unavailable');
    } finally { ContextPreparer.prototype.preview = original; }
  });

  it('uses native material content while ignoring raw source churn and half-prefix changes', async () => {
    const model = deliveryFixture();
    const original = ContextPreparer.prototype.preview;
    let available = candidates(nativeWarning);
    ContextPreparer.prototype.preview = async () => ({ candidates: available });
    try {
      const first = await model.delivery.acquire({ interactionId: 'first', requestReceivedAt: now });
      const preview = await model.delivery.preview(first, model.binding, null);
      assert.equal(preview.relevanceFingerprint, nativeWarning);
      const current = model.events.get(1)!;
      model.events.set(1, { ...current, metadata: { ...current.metadata, payloadBindingSha256: '7'.repeat(64) } });
      const churn = await model.delivery.acquire({ interactionId: 'churn', requestReceivedAt: now });
      assert.notEqual(churn.relevanceFingerprint, first.relevanceFingerprint);
      available = [available[0]!, { ...available[0]!, shape: 2, fingerprint: '8'.repeat(64), bytes: 600 }, ...available.slice(1)];
      assert.equal((await model.delivery.preview(churn, model.binding, 600)).relevanceFingerprint, nativeWarning);
      available = candidates(nativeClean);
      assert.equal((await model.delivery.preview(churn, model.binding, 600)).relevanceFingerprint, nativeClean);
    } finally { ContextPreparer.prototype.preview = original; }
  });

  it('admits exactly one material-content revalidation without resetting exhausted progress', async () => {
    const model = deliveryFixture();
    const original = ContextPreparer.prototype.preview;
    let available = candidates(nativeWarning);
    ContextPreparer.prototype.preview = async () => ({ candidates: available });
    try {
      const snapshot = await model.delivery.acquire({ interactionId: 'window', requestReceivedAt: now });
      const before = await model.delivery.preview(snapshot, model.binding, null);
      const window = new WindowRecovery('logical', recoveryFingerprint('provider'), null);
      window.bind('logical', 'instance'); window.select('ordinary', 'unchanged question');
      for (const candidate of [before.preview.candidates[0]!, before.preview.candidates.at(-1)!]) {
        const ticket = window.prepare([candidate], before.relevanceFingerprint)!;
        window.sent(ticket, 'instance'); window.finished(ticket, 'instance', 'contextExhausted');
      }
      assert.equal(window.summary()?.state, 'exhausted');
      assert.equal(window.prepare(before.preview.candidates, before.relevanceFingerprint), null);
      available = candidates(nativeClean);
      const after = await model.delivery.preview(snapshot, model.binding, window.halfPrefixBytes);
      const revalidation = window.prepare(after.preview.candidates, after.relevanceFingerprint);
      assert.ok(revalidation, 'Changed native content makes the unused allowance eligible.');
      assert.equal(revalidation.revalidation, true);
      assert.equal(revalidation.candidate.shape, 1);
      window.cancelBeforeSend(revalidation);
      assert.equal(window.summary()?.revalidationAvailable, true);
      const sent = window.prepare(after.preview.candidates, after.relevanceFingerprint)!;
      window.sent(sent, 'instance'); window.finished(sent, 'instance', 'contextExhausted');
      assert.equal(window.summary()?.descendingFailures, 2);
      assert.equal(window.summary()?.revalidationAvailable, false);
      assert.equal(window.prepare(candidates('9'.repeat(64)), '9'.repeat(64)), null);
    } finally { ContextPreparer.prototype.preview = original; }
  });

  it('reports the refreshed native relevance when binding requirements change before send', async () => {
    const model = deliveryFixture();
    const original = { preview: ContextPreparer.prototype.preview, prepare: ContextPreparer.prototype.prepare,
      variants: ContextPreparer.prototype.copyVariantsForSend, copy: ContextPreparer.prototype.copyForSend, discard: ContextPreparer.prototype.discard };
    ContextPreparer.prototype.preview = async request => ({ candidates: (request as Record<string, unknown>)['state'] === null
      ? [{ ...candidates(nativeWarning)[0]!, stateIncluded: false }] : candidates(nativeClean) });
    ContextPreparer.prototype.prepare = async (_preview, candidate) => ({ candidate, cleanupComplete: true });
    ContextPreparer.prototype.copyVariantsForSend = async prepared => ({ text: 'opaque', redeliveryText: 'opaque', redeliveryCandidate: prepared.candidate });
    ContextPreparer.prototype.copyForSend = async () => 'opaque';
    ContextPreparer.prototype.discard = async () => {};
    try {
      const identity = { providerId: model.binding.providerId, providerSessionId: model.binding.providerSessionId, isCurrent: () => true };
      const oldBinding = { ...model.binding, needsState: false };
      await model.kernel.sessions.bind(oldBinding, model.kernel.sessionProof(identity));
      const snapshot = await model.delivery.acquire({ interactionId: 'binding', requestReceivedAt: now });
      const preview = await model.delivery.preview(snapshot, oldBinding, null);
      const previousRelevance = preview.relevanceFingerprint;
      const handle = await model.delivery.prepare(snapshot, preview, preview.preview.candidates[0]!);
      await model.kernel.sessions.bind(model.binding, model.kernel.sessionProof(identity));
      const sent = await model.delivery.copyForSend(handle, model.binding, identity);
      assert.equal(sent.candidate.stateIncluded, true);
      assert.equal(sent.relevanceFingerprint, nativeClean);
      assert.equal(preview.relevanceFingerprint, previousRelevance, 'The earlier immutable preview stays historical.');
    } finally {
      ContextPreparer.prototype.preview = original.preview; ContextPreparer.prototype.prepare = original.prepare;
      ContextPreparer.prototype.copyVariantsForSend = original.variants; ContextPreparer.prototype.copyForSend = original.copy; ContextPreparer.prototype.discard = original.discard;
    }
  });

  it('preserves the disclosure-first null baseline and consumes no allowance before send', async () => {
    const model = deliveryFixture();
    const original = ContextPreparer.prototype.preview;
    ContextPreparer.prototype.preview = async () => ({ candidates: candidates(nativeClean) });
    try {
      const snapshot = await model.delivery.acquire({ interactionId: 'after-disclosure', requestReceivedAt: now });
      const preview = await model.delivery.preview(snapshot, model.binding, null);
      const window = new WindowRecovery('logical', recoveryFingerprint('provider'), null);
      window.bind('logical', 'instance'); window.select('ordinary', 'unchanged question');
      const disclosure = { shape: 1 as const, fingerprint: '3f7e12622285c58bc46318609a8d168dbd9344afedcbe9d11e6a5fd29bae854e', bytes: 482, stateIncluded: false };
      const first = window.prepare([disclosure], disclosure.fingerprint, true)!;
      window.sent(first, 'instance'); window.finished(first, 'instance', 'contextExhausted');
      const current = window.prepare(preview.preview.candidates, preview.relevanceFingerprint);
      assert.ok(current);
      assert.equal(current.revalidation, true);
      assert.equal(current.candidate.shape, 1);
      assert.equal(window.summary()?.descendingFailures, 1);
      window.cancelBeforeSend(current);
      assert.equal(window.summary()?.revalidationAvailable, true);
    } finally { ContextPreparer.prototype.preview = original; }
  });
});
