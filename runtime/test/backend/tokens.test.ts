import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allocateUniqueToken } from '../../src/backend/tokens.ts';

describe('bounded recovery token allocation', () => {
  it('rejects retained collisions before returning an unused token', () => {
    const retained = new Set(['1'.repeat(32), '2'.repeat(32)]);
    const sequence = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
    assert.equal(allocateUniqueToken(retained, () => sequence.shift()!), '3'.repeat(32));
  });
  it('fails after exactly four collisions without granting a token', () => {
    let calls = 0;
    assert.throws(() => allocateUniqueToken(new Set(['1'.repeat(32)]), () => { calls++; return '1'.repeat(32); }));
    assert.equal(calls, 4);
  });
});
