import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recoveryFingerprint, WindowRecovery, WindowRecoveryError, type DeliveryShape, type WindowAttempt, type WindowCandidate } from '../src/window-recovery.ts';

const ordinary = recoveryFingerprint('provider', 'ordinary', 'medium');
const override = recoveryFingerprint('provider', 'override', 'high');
const state = recoveryFingerprint('admitted game state');
const provider = 'provider-instance';
function candidates(content = 'content'): WindowCandidate[] {
  return ([1, 2, 3, 4] as const).map(shape => ({ shape, fingerprint: recoveryFingerprint(content, String(shape)), bytes: 500 - shape * 100, stateIncluded: shape !== 4 }));
}
function create(overrideKey = override): WindowRecovery {
  const recovery = new WindowRecovery('logical-session', ordinary, overrideKey);
  recovery.bind('logical-session', provider);
  recovery.select('ordinary', 'Question');

  return recovery;
}
function prepare(recovery: WindowRecovery, expected: DeliveryShape, available = candidates(), relevance = state): WindowAttempt {
  const ticket = recovery.prepare(available, relevance);
  assert.notEqual(ticket, null);
  assert.equal(ticket?.candidate.shape, expected);

  return ticket as WindowAttempt;
}
function finish(recovery: WindowRecovery, ticket: WindowAttempt, outcome: 'contextExhausted' | 'success' | 'otherFailure' = 'contextExhausted', instance = provider): void {
  recovery.sent(ticket, instance);
  assert.equal(recovery.finished(ticket, instance, outcome), true);
}

describe('request-scoped window recovery', () => {
  it('sends a disclosure after a window failure without advancing or replenishing the ordinary ladder', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    const disclosure = { shape: 1 as const, fingerprint: recoveryFingerprint('pending disclosure'), bytes: 70, stateIncluded: false };
    const ticket = recovery.prepare([disclosure], recoveryFingerprint('unsettled input'), true);
    assert.ok(ticket?.disclosureOnly);
    assert.equal(ticket.revalidation, false);
    finish(recovery, ticket, 'success');
    assert.equal(recovery.summary()?.descendingFailures, 1);
    assert.equal(recovery.summary()?.revalidationAvailable, true);
    assert.equal(recovery.halfPrefixBytes, 200);
    assert.equal(prepare(recovery, 2).revalidation, false);
  });

  it('counts disclosure failures within the shared ceiling and refuses repeats without poisoning the ordinary ladder', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    const disclosure = { shape: 1 as const, fingerprint: recoveryFingerprint('pending disclosure'), bytes: 70, stateIncluded: false };
    const first = recovery.prepare([disclosure], recoveryFingerprint('unsettled input'), true);
    assert.ok(first);
    finish(recovery, first);
    assert.equal(recovery.summary()?.descendingFailures, 2);
    assert.equal(recovery.halfPrefixBytes, 200);
    assert.equal(recovery.prepare([disclosure], state, true), null);
    assert.equal(recovery.summary()?.state, 'ready');
    const ordinary = prepare(recovery, 2);
    assert.equal(ordinary.revalidation, false);
    finish(recovery, ordinary);
    const changed = { ...disclosure, fingerprint: recoveryFingerprint('another pending disclosure'), bytes: 512 };
    const fourth = recovery.prepare([changed], state, true);
    assert.ok(fourth?.disclosureOnly);
    finish(recovery, fourth);
    assert.equal(recovery.summary()?.descendingFailures, 4);
    assert.equal(recovery.summary()?.state, 'exhausted');
    assert.equal(recovery.halfPrefixBytes, 150);
    assert.equal(recovery.prepare([{ ...changed, fingerprint: recoveryFingerprint('third disclosure') }], state, true), null);
    recovery.compacted(provider);
    const revalidation = prepare(recovery, 1);
    assert.equal(revalidation.revalidation, true);
    finish(recovery, revalidation);
    assert.equal(recovery.summary()?.descendingFailures, 4);
    assert.equal(recovery.summary()?.revalidationAvailable, false);
    assert.equal(recovery.prepare([changed], state, true), null);
  });

  it('rejects a state-bearing candidate labelled as disclosure', () => {
    assert.throws(() => create().prepare([candidates()[0]!], state, true), WindowRecoveryError);
  });

  it('bounds unchanged requests to four descending failures and one revalidation', () => {
    const recovery = create();
    for (const shape of [1, 2, 3, 4] as const) { finish(recovery, prepare(recovery, shape)); }
    assert.equal(recovery.prepare(candidates(), state), null);
    assert.deepEqual(recovery.summary(), { variant: 'ordinary', state: 'exhausted', descendingFailures: 4, revalidationAvailable: true });
    recovery.compacted(provider);
    const retry = prepare(recovery, 1);
    assert.equal(retry.revalidation, true);
    finish(recovery, retry);
    recovery.compacted(provider);
    assert.equal(recovery.prepare(candidates('new state'), recoveryFingerprint('new state')), null);
    assert.equal(recovery.summary()?.descendingFailures, 4);
    assert.equal(recovery.summary()?.revalidationAvailable, false);
  });

  it('restores a full state candidate for changed text without a new game event', () => {
    const recovery = create();
    for (const shape of [1, 2, 3, 4] as const) { finish(recovery, prepare(recovery, shape)); }
    recovery.select('ordinary', 'Help.');
    const next = prepare(recovery, 1);
    assert.equal(next.candidate.stateIncluded, true);
    assert.equal(next.revalidation, false);
    assert.equal(recovery.summary()?.descendingFailures, 0);
  });

  it('does not refund failures for successful delivery, acknowledgement effects or other failures', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    finish(recovery, prepare(recovery, 2), 'success');
    finish(recovery, prepare(recovery, 2), 'otherFailure');
    assert.equal(recovery.summary()?.descendingFailures, 1);
    finish(recovery, prepare(recovery, 2));
    assert.equal(recovery.summary()?.descendingFailures, 2);
    assert.equal(recovery.halfPrefixBytes, 150);
  });

  it('skips equivalent or non-reducing candidates and never resends a failed header', () => {
    const recovery = create();
    const original = candidates();
    original[1] = { ...original[1]!, fingerprint: original[0]!.fingerprint, bytes: 400 };
    original[2] = { ...original[2]!, bytes: 450 };
    finish(recovery, prepare(recovery, 1, original));
    finish(recovery, prepare(recovery, 4, original));
    assert.equal(recovery.prepare(original, state), null);
    assert.equal(recovery.summary()?.descendingFailures, 2);
  });

  it('retains ordinary progress across override selection and shares equal configurations', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    recovery.select('override', 'Question');
    finish(recovery, prepare(recovery, 1));
    recovery.select('ordinary', 'Question');
    const next = prepare(recovery, 2);
    recovery.cancelBeforeSend(next);
    recovery.select('override', 'Question');
    assert.equal(prepare(recovery, 2).candidate.shape, 2);

    const shared = create(ordinary);
    finish(shared, prepare(shared, 1));
    shared.select('override', 'Question');
    assert.equal(prepare(shared, 2).candidate.shape, 2);
  });

  it('preserves recovery through reconnect while ignoring ended-instance and duplicate results', () => {
    const recovery = create();
    const first = prepare(recovery, 1);
    finish(recovery, first);
    assert.equal(recovery.finished(first, provider, 'contextExhausted'), false);
    const second = prepare(recovery, 2);
    recovery.sent(second, provider);
    recovery.bind('logical-session', 'replacement-process');
    assert.equal(recovery.finished(second, provider, 'contextExhausted'), false);
    recovery.compacted(provider);
    const current = prepare(recovery, 2);
    assert.equal(current.revalidation, false);
    finish(recovery, current, 'contextExhausted', 'replacement-process');
    assert.equal(recovery.summary()?.descendingFailures, 2);
  });

  it('consumes revalidation only at send and returns to the prior disposition on success', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    const changed = recoveryFingerprint('materially changed state');
    const unsent = prepare(recovery, 1, candidates('changed'), changed);
    assert.equal(unsent.revalidation, true);
    recovery.cancelBeforeSend(unsent);
    assert.equal(recovery.summary()?.revalidationAvailable, true);
    finish(recovery, prepare(recovery, 1, candidates('changed'), changed), 'success');
    assert.equal(recovery.summary()?.revalidationAvailable, false);
    assert.equal(prepare(recovery, 2, candidates('changed'), changed).revalidation, false);
  });

  it('does not consume revalidation when no state-bearing byte-cap candidate exists', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    recovery.compacted(provider);
    const floor = [candidates()[3]!];
    const next = prepare(recovery, 4, floor);
    assert.equal(next.revalidation, false);
    finish(recovery, next, 'success');
    assert.equal(recovery.summary()?.revalidationAvailable, true);
  });

  it('does not repeat a failed revalidation as an equivalent descending candidate', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    const changed = recoveryFingerprint('changed');
    const reduced = candidates('changed');
    reduced[0] = { ...reduced[0]!, fingerprint: reduced[1]!.fingerprint, bytes: reduced[1]!.bytes };
    finish(recovery, prepare(recovery, 1, reduced, changed));
    assert.equal(recovery.summary()?.revalidationAvailable, false);
    assert.equal(prepare(recovery, 3, reduced, changed).candidate.shape, 3);
  });

  it('starts new progress for changed configuration and preserves an unchanged override', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    recovery.select('override', 'Question');
    finish(recovery, prepare(recovery, 1));
    recovery.configure(recoveryFingerprint('another model'), override);
    recovery.select('ordinary', 'Question');
    const first = prepare(recovery, 1);
    recovery.cancelBeforeSend(first);
    recovery.select('override', 'Question');
    assert.equal(prepare(recovery, 2).candidate.shape, 2);
  });

  it('observes compaction during a send without inferring fit or refunding repeated allowances', () => {
    const recovery = create();
    const first = prepare(recovery, 1);
    recovery.sent(first, provider);
    recovery.compacted(provider);
    recovery.finished(first, provider, 'contextExhausted');
    const retry = prepare(recovery, 1);
    assert.equal(retry.revalidation, true);
    finish(recovery, retry);
    recovery.compacted(provider);
    assert.equal(prepare(recovery, 2).revalidation, false);
  });

  it('resets advisory state on a different session or process restart without persisting text', () => {
    const recovery = create();
    finish(recovery, prepare(recovery, 1));
    const pending = prepare(recovery, 2);
    recovery.bind('another-session', provider);
    assert.equal(recovery.finished(pending, provider, 'contextExhausted'), false);
    assert.equal(recovery.summary(), null);
    recovery.select('ordinary', 'Question');
    assert.equal(prepare(recovery, 1).revalidation, false);
    assert.equal(prepare(create(), 1).revalidation, false);
  });

  it('fails visibly on inconsistent metadata until replacement rather than replenishing it', () => {
    const recovery = create();
    assert.throws(() => recovery.prepare([], state), WindowRecoveryError);
    assert.equal(recovery.summary()?.state, 'unavailable');
    assert.throws(() => recovery.select('ordinary', 'different'), WindowRecoveryError);
    recovery.bind('logical-session', 'reconnected');
    assert.throws(() => recovery.select('ordinary', 'different'), WindowRecoveryError);
    recovery.bind('replacement', provider);
    recovery.select('ordinary', 'Question');
    assert.equal(prepare(recovery, 1).candidate.shape, 1);
  });

  it('frames fingerprints so field boundaries cannot alias', () => {
    assert.notEqual(recoveryFingerprint('ab', 'c'), recoveryFingerprint('a', 'bc'));
    assert.notEqual(recoveryFingerprint('Question'), recoveryFingerprint('question'));
  });
});
