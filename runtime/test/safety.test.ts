import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SafetyStore } from '../src/safety.ts';
import { SafetyUnavailableError, type StateSafety } from '../src/safety-records.ts';
import type { ScopeStorage } from '../src/storage.ts';

const scopeHash = 'a'.repeat(64);
const owner = { operationId: `jr-${'b'.repeat(32)}`, episodeOrdinal: 0, activationId: 'c'.repeat(32) };
function fixture() {
  const state: { value: StateSafety; hash: string; writes: number; unreadable: boolean; invalid: boolean; suppressed: string[] } = {
    value: { stateSafetyVersion: 1, generation: 'd'.repeat(32), pendingCheck: null, correction: null, recoveryWitness: null },
    hash: '0'.repeat(64), writes: 0, unreadable: false, invalid: false, suppressed: [],
  };
  const storage = {
    scope: { bindingSha256: scopeHash, createdHere: false },
    read: async () => {
      if (state.unreadable) { throw new Error('storage unreadable'); }
      return state.invalid ? { status: 'invalid', sha256: state.hash } : { status: 'valid', sha256: state.hash, value: structuredClone(state.value) };
    },
    write: async (_path: string, value: StateSafety, _profile: string, expected: string) => {
      assert.equal(expected, state.hash);
      state.value = structuredClone(value);
      state.hash = String(++state.writes).padStart(64, '0');
      return state.hash;
    },
    list: async () => [],
  } as unknown as ScopeStorage;
  return { state, safety: new SafetyStore({ storage, bindingGenerations: async () => [state.value.generation], suppressProvider: reason => state.suppressed.push(reason) }) };
}
const proved = { verify: async () => true };
const unproved = { verify: async () => false };

describe('durable safety transitions', () => {
  it('keeps a check outstanding until its exact observation and consequences are proved', async () => {
    const { state, safety } = fixture();
    const armed = await safety.armCheck();
    await assert.rejects(safety.armCheck(), SafetyUnavailableError);
    assert.equal(await safety.finishCheck('f'.repeat(32), proved), false);
    assert.equal(await safety.finishCheck(armed.checkToken, unproved), false);
    const invalidated = await safety.invalidate('coreRejected');
    assert.equal(invalidated.value.pendingCheck, armed.checkToken);
    assert.equal(invalidated.value.correction?.reason, 'coreRejected');
    assert.equal(await safety.finishCheck(armed.checkToken, proved), true);
    assert.equal(state.value.pendingCheck, null);
    assert.notEqual(state.value.correction, null);
  });

  it('does not let a delayed old-turn proof clear a newly observed invalidation', async () => {
    const { state, safety } = fixture();
    const first = await safety.invalidate('contextUncertain');
    const entered: { resolve: () => void; promise: Promise<void> } = { resolve: () => {}, promise: Promise.resolve() };
    entered.promise = new Promise(resolve => { entered.resolve = resolve; });
    let finish: (value: boolean) => void = () => {};
    const decision = new Promise<boolean>(resolve => { finish = resolve; });
    const clearing = safety.dischargeCorrection(first.value.generation, first.value.correction!.correctionId, { verify: async () => { entered.resolve(); return decision; } });
    await entered.promise;
    const later = safety.invalidate('coreRejected');
    assert.equal(state.suppressed.at(-1), 'coreRejected');
    finish(true);
    assert.equal(await clearing, false);
    await later;
    assert.equal(state.value.correction?.correctionId, first.value.correction!.correctionId);
    assert.equal(state.value.correction?.reason, 'coreRejected');
    assert.notEqual(state.value.generation, first.value.generation);
  });

  it('retains both transfer owners until the successor plan is verified and requires disclosure proof to clear', async () => {
    const { state, safety } = fixture();
    await safety.prepareWitness(owner);
    await assert.rejects(safety.activateWitness(owner, unproved));
    assert.equal(state.value.recoveryWitness?.phase, 'preparing');
    await safety.activateWitness(owner, proved);
    const successor = { operationId: `jr-${'e'.repeat(32)}`, episodeOrdinal: 0, activationId: 'f'.repeat(32) };
    await safety.prepareTransfer(successor);
    assert.deepEqual(state.value.recoveryWitness?.owner, owner);
    assert.deepEqual(state.value.recoveryWitness?.successor, successor);
    await assert.rejects(safety.activateWitness(successor, unproved));
    await safety.activateWitness(successor, proved);
    assert.equal(await safety.dischargeWitness(successor, 'acknowledged', proved), false);
    await safety.awaitDisclosure(successor, { journalId: 'journal', eventId: '1'.repeat(32), sequence: 1, generation: state.value.generation }, proved);
    assert.equal(await safety.dischargeWitness(owner, 'acknowledged', proved), false);
    assert.equal(await safety.dischargeWitness(successor, 'acknowledged', unproved), false);
    assert.equal(await safety.dischargeWitness(successor, 'acknowledged', proved), true);
    assert.equal(state.value.recoveryWitness, null);
  });

  it('does not replace unreadable or invalid authority through ordinary mutation methods', async () => {
    const { state, safety } = fixture();
    state.unreadable = true;
    await assert.rejects(safety.invalidate('contextUncertain'), /storage unreadable/);
    assert.equal(state.writes, 0);
    state.unreadable = false;
    state.invalid = true;
    await assert.rejects(safety.armCheck(), SafetyUnavailableError);
    assert.equal(state.writes, 0);
    await assert.rejects(safety.initializeNew());
  });
});
