import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { admitNamedSession, indexCurrentBinding, parseSessionBinding, parseSessionIndex, type AgentSessionBinding } from '../src/session-records.ts';

const read = (value: unknown) => parseStrictJson(Buffer.from(stringifyJson(value)));
const binding: AgentSessionBinding = { agentSessionVersion: 1, providerId: 'provider', providerSessionId: 'session', createdAt: '2026-10-08T06:00:00.0000000Z',
  turnsCompleted: 1, needsState: true, instructionsSha256: 'a'.repeat(64), stateGeneration: 'b'.repeat(32) };

describe('generation-bound session records', () => {
  it('rejects absent generations, duplicate identities, unknown fields and excessive histories', () => {
    assert.deepEqual(parseSessionBinding(read(binding)), binding);
    const { stateGeneration: _, ...old } = binding;
    assert.throws(() => parseSessionBinding(read(old)));
    assert.throws(() => parseSessionBinding(read({ ...binding, extra: true })));
    const index = indexCurrentBinding(null, binding, binding.createdAt);
    assert.throws(() => parseSessionIndex(read({ ...index, sessions: [...index.sessions, ...index.sessions] })));
    assert.throws(() => parseSessionIndex(read({ ...index, sessions: Array.from({ length: 33 }, (_, index) => ({ ...binding, providerSessionId: String(index), lastBoundAt: binding.createdAt })) })));
  });

  it('keeps obsolete generations ineligible even when another rejection also applies', () => {
    const index = parseSessionIndex(read(indexCurrentBinding(null, binding, binding.createdAt)));
    assert.deepEqual(admitNamedSession(index, 'provider', 'session', 'c'.repeat(32), 'd'.repeat(64)), { result: 'stateInvalidated' });
    assert.deepEqual(admitNamedSession(index, 'provider', 'session', binding.stateGeneration, 'd'.repeat(64)), { result: 'instructionsChanged' });
    assert.deepEqual(admitNamedSession(null, 'provider', 'session', binding.stateGeneration, binding.instructionsSha256), { result: 'unknownSession' });
    assert.deepEqual(admitNamedSession(index, 'provider', 'Session', binding.stateGeneration, binding.instructionsSha256), { result: 'unknownSession' });
    assert.deepEqual(admitNamedSession(index, 'provider', 'session', binding.stateGeneration, binding.instructionsSha256), { result: 'admitted', binding });
  });

  it('bounds the index and preserves the current entry through a backward clock change', () => {
    let index = indexCurrentBinding(null, binding, binding.createdAt);
    for (let value = 0; value < 32; value++) { index = indexCurrentBinding(index, { ...binding, providerSessionId: String(value) }, `2026-10-08T06:00:${String(value).padStart(2, '0')}.0000000Z`); }
    const current = { ...binding, providerSessionId: 'current' };
    index = indexCurrentBinding(index, current, '2026-10-08T05:00:00.0000000Z');
    assert.equal(index.sessions.length, 32);
    assert.equal(index.sessions.some(entry => entry.providerSessionId === '0'), false);
    assert.deepEqual(admitNamedSession(index, 'provider', 'current', binding.stateGeneration, binding.instructionsSha256), { result: 'admitted', binding: current });
    assert.equal(parseSessionIndex(read(index)).sessions.length, 32);
  });
});
