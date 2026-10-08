import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessCapacity, type CapacityInventory, type ResourceCounts, type TransitionReservation } from '../src/capacity.ts';

const zero: ResourceCounts = { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 };
const inventory: CapacityInventory = { complete: true, counts: zero, freeBytes: 1000000000n, uncertainWorkspace: false };
const transition: TransitionReservation = { kind: 'ordinary', additions: zero, remainingControlReserve: zero, documents: [], workspaceBytes: 0n };

describe('complete-transition resource vectors', () => {
  it('admits equality only after all actual additions and control reserves are counted', () => {
    const full = { ...inventory, counts: { ...zero, uncompactedEvents: 8192 } };
    assert.equal(assessCapacity(full, transition).admitted, true);
    assert.equal(assessCapacity(full, { ...transition, additions: { ...zero, uncompactedEvents: 1 } }).admitted, false);
    assert.equal(assessCapacity({ ...inventory, counts: { ...zero, uncompactedEvents: 8189 } }, { ...transition, additions: { ...zero, uncompactedEvents: 1 }, remainingControlReserve: { ...zero, uncompactedEvents: 2 } }).admitted, true);
    assert.equal(assessCapacity({ ...inventory, counts: { ...zero, uncompactedEvents: 8190 } }, { ...transition, additions: { ...zero, uncompactedEvents: 1 }, remainingControlReserve: { ...zero, uncompactedEvents: 2 } }).admitted, false);
  });

  it('does not grant a control transition an exception for protected handoffs or operation limits', () => {
    const saturated = { ...inventory, counts: { uncompactedEvents: 8193, retainedHandoffs: 8192, fullTerminalOperations: 4096 } };
    const result = assessCapacity(saturated, { ...transition, kind: 'release', additions: { ...zero, retainedHandoffs: 1, fullTerminalOperations: 1 } });
    assert.equal(result.admitted, false);
    if (result.admitted) { throw new Error('Saturated fixture was admitted.'); }
    assert.deepEqual(result.dimensions, ['retainedHandoffs', 'fullTerminalOperations']);
    const control = assessCapacity(saturated, { ...transition, kind: 'release' });
    assert.equal(control.admitted, true);
    if (!control.admitted) { throw new Error('Non-growing control transition was refused.'); }
    assert.equal(control.controlOnly, true);
    assert.equal(assessCapacity(saturated, transition).admitted, false);
  });

  it('checks bytes, tokens, decoded text and peak free space independently', () => {
    const result = assessCapacity(inventory, { ...transition, documents: [
      { name: 'a', profile: 'config', usage: { bytes: 1048577, tokens: 1, textBytes: 1 } },
      { name: 'b', profile: 'config', usage: { bytes: 10, tokens: 65537, textBytes: 1 } },
      { name: 'c', profile: 'config', usage: { bytes: 10, tokens: 1, textBytes: 524289 } },
    ] });
    assert.equal(result.admitted, false);
    if (result.admitted) { throw new Error('Oversized fixture was admitted.'); }
    assert.deepEqual(result.dimensions, ['a:bytes', 'b:tokens', 'c:text']);
    assert.equal(assessCapacity({ ...inventory, freeBytes: 33554432n }, { ...transition, documents: [{ name: 'future', profile: 'state-event', usage: null }] }).admitted, true);
    assert.equal(assessCapacity({ ...inventory, freeBytes: 33554432n }, { ...transition, workspaceBytes: 1n, documents: [{ name: 'future', profile: 'state-event', usage: null }] }).admitted, false);
  });

  it('never turns incomplete discovery or uncertain cleanup into spare capacity', () => {
    for (const observation of [{ ...inventory, complete: false }, { ...inventory, uncertainWorkspace: true }, { ...inventory, freeBytes: null }]) {
      const result = assessCapacity(observation, transition);
      assert.deepEqual(result, { admitted: false, state: 'unavailable', dimensions: ['inventory'] });
    }
  });
});
