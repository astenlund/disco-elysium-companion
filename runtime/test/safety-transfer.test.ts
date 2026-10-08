import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SafetyStore } from '../src/safety.ts';
import type { StateSafety } from '../src/safety-records.ts';
import type { ScopeStorage } from '../src/storage.ts';

const previous = `jr-${'a'.repeat(32)}`;
const successor = `jr-${'b'.repeat(32)}`;
const correctionId = 'c'.repeat(32);
const scopeHash = 'd'.repeat(64);
const owner = { operationId: previous, episodeOrdinal: 2, activationId: 'e'.repeat(32) };
const nextOwner = { operationId: successor, episodeOrdinal: 0, activationId: 'f'.repeat(32) };

function fixture(phase: 'transferring' | 'active') {
  const state: { value: StateSafety; writes: number } = { writes: 0, value: { stateSafetyVersion: 1, generation: '1'.repeat(32), pendingCheck: '2'.repeat(32),
    correction: { correctionId, reason: 'coreRejected', recoveryOperationId: previous },
    recoveryWitness: { scopeSha256: scopeHash, phase, owner: phase === 'active' ? nextOwner : owner, successor: phase === 'active' ? null : nextOwner, disclosure: null } } };
  // This fixture isolates the transition guard; ScopeStorage has separate native checks.
  const storage = { scope: { bindingSha256: scopeHash },
    read: async () => ({ status: 'valid', value: structuredClone(state.value), sha256: scopeHash }),
    write: async (_: string, value: StateSafety, profile: string, expected: string) => {
      assert.equal(profile, 'config'); assert.equal(expected, scopeHash);
      state.value = structuredClone(value); state.writes++;
      return scopeHash;
    } } as unknown as ScopeStorage;
  const store = new SafetyStore({ storage, bindingGenerations: async () => [], suppressProvider: () => {} });
  return { state, store };
}

describe('correction ownership transfer', () => {
  it('preserves identity, reason, generation and pending duties through both witness crash states', async () => {
    for (const phase of ['transferring', 'active'] as const) {
      const { state, store } = fixture(phase);
      const before = structuredClone(state.value);
      const result = await store.transferCorrection(correctionId, previous, successor, { verify: async value => {
        assert.deepEqual(value, before);
        return true;
      } });
      assert.deepEqual(result.value, { ...before, correction: { ...before.correction!, recoveryOperationId: successor } });
      assert.equal(state.writes, 1);
    }
  });

  it('refuses absent witnesses, foreign predecessors and unproven successor inheritance without writes', async () => {
    const { state, store } = fixture('transferring');
    await assert.rejects(store.transferCorrection(correctionId, previous, successor, { verify: async () => false }));
    await assert.rejects(store.transferCorrection(correctionId, `jr-${'3'.repeat(32)}`, successor, { verify: async () => true }));
    state.value = { ...state.value, recoveryWitness: null };
    await assert.rejects(store.transferCorrection(correctionId, previous, successor, { verify: async () => true }));
    assert.equal(state.writes, 0);
  });
});
