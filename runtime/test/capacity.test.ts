import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessCapacity, capacityReasons, capacitySlot, inventoryFailureReason, inventoryFailureReasons, RuntimeCapacityError, type CapacityInventory, type ResourceCounts, type TransitionReservation } from '../src/capacity.ts';

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
    for (const observation of [{ ...inventory, complete: false }, { ...inventory, freeBytes: null }, { ...inventory, complete: false, uncertainWorkspace: true }]) {
      const result = assessCapacity(observation, transition);
      assert.deepEqual(result, { admitted: false, state: 'unavailable', dimensions: ['inventory'] });
    }
  });

  it('names residue left in a complete inventory as its own unavailable dependency', () => {
    assert.deepEqual(assessCapacity({ ...inventory, uncertainWorkspace: true }, transition), { admitted: false, state: 'unavailable', dimensions: ['workspaceResidue'] });
  });
});

describe('native inventory failure categories', () => {
  it('maps each category code of the helper to its own capacity reason', () => {
    for (const code of ['foreignEntryScopeRoot', 'foreignEntryJournal', 'foreignEntryJournalEvents', 'foreignEntryOperations', 'foreignEntryQuarantine', 'inventoryUnreadable'] as const) {
      assert.equal(inventoryFailureReason(code), code);
    }
  });

  it('names a helper that could not answer, and keeps the generic reason for every other code', () => {
    assert.equal(inventoryFailureReason('unavailable'), 'helperUnavailable');
    for (const code of ['inventoryUnavailable', 'deadlineExceeded', 'requestTooLarge', 'workspaceResidue', 'helperUnavailable', 'foreignEntryElsewhere', 'scopeUnbound']) {
      assert.equal(inventoryFailureReason(code), 'inventory', code);
    }
  });

  it('keeps every category in the bounded public reason set, so the status slot never falls back to otherAuthority', () => {
    for (const reason of inventoryFailureReasons) {
      const error = new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: [reason] }, 'ordinary');
      assert.ok(capacityReasons.includes(reason));
      assert.deepEqual(capacitySlot(error), { state: 'unavailable', reason, dimensions: [] });
    }
  });
});
