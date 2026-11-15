import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assessCapacity, RuntimeCapacityError } from '../../src/capacity.ts';
import { completeReservation } from '../../src/resource-lifecycle/resources.ts';
import { noOperations, resourceScopeFixture } from '../support/resource-scope.ts';

describe('inventory failure categories through the native helper', () => {
  it('refuses an ordinary transition over a foreign folder in journal as foreignEntryJournal', { timeout: 120000 }, async () => {
    // Arrange
    const fixture = await resourceScopeFixture('inventory-categories', dataRoot => fs.mkdir(path.join(dataRoot, 'journal', 'unexpected')));
    try {
      // Act
      const refused = fixture.resources.withTransition('ordinary', () => fixture.resources.reserve('ordinary'));

      // Assert
      await assert.rejects(refused, error => error instanceof RuntimeCapacityError && error.state === 'unavailable' && error.dimensions.join() === 'foreignEntryJournal');
      assert.deepEqual(fixture.resources.capacity.current.ordinary, { state: 'unavailable', reason: 'foreignEntryJournal', dimensions: [] });
    } finally { await fixture.close(); }
  });

  it('refuses an ordinary transition over a stray file in journal/events as foreignEntryJournalEvents', { timeout: 120000 }, async () => {
    // Arrange
    const fixture = await resourceScopeFixture('inventory-categories', dataRoot => fs.writeFile(path.join(dataRoot, 'journal', 'events', 'notes.txt'), 'stray'), noOperations);
    try {
      // Act: the ordinary assessment that reserve performs, without the safety record this scope does not hold.
      const observation = await fixture.resources.inventory(undefined, false);
      const decision = assessCapacity(observation, completeReservation('ordinary', observation));

      // Assert
      assert.equal(observation.invalidEvents, 1);
      assert.deepEqual(decision, { admitted: false, state: 'unavailable', dimensions: ['foreignEntryJournalEvents'] });
    } finally { await fixture.close(); }
  });

  it('keeps the generic reason for a damaged event under a valid event name, and for a recovering assessment', { timeout: 120000 }, async () => {
    // Arrange
    const damaged = await resourceScopeFixture('inventory-categories', dataRoot => fs.writeFile(path.join(dataRoot, 'journal', 'events', '0000000000000001.json'), 'damaged'), noOperations);
    const stray = await resourceScopeFixture('inventory-categories', dataRoot => fs.writeFile(path.join(dataRoot, 'journal', 'events', 'notes.txt'), 'stray'), noOperations);
    try {
      // Act
      const observation = await damaged.resources.inventory(undefined, false);
      const recovering = await stray.resources.inventory(undefined, true);

      // Assert
      assert.equal(observation.invalidEvents, 1);
      assert.deepEqual(assessCapacity(observation, completeReservation('ordinary', observation)), { admitted: false, state: 'unavailable', dimensions: ['inventory'] });
      assert.equal(recovering.complete, true);
      assert.equal(recovering.incompleteReason, undefined);
    } finally { await damaged.close(); await stray.close(); }
  });

  it('refuses the runtime marker over a runtime.json publication sibling as workspaceResidue', { timeout: 120000 }, async () => {
    // Arrange
    const fixture = await resourceScopeFixture('inventory-categories', dataRoot => fs.writeFile(path.join(dataRoot, `runtime.json.${'a'.repeat(32)}.tmp`), 'residue'));
    try {
      // Act
      const refused = fixture.resources.withTransition('runtimeMarker', () => fixture.resources.reserveRuntimeMarker());

      // Assert
      await assert.rejects(refused, error => error instanceof RuntimeCapacityError && error.dimensions.join() === 'workspaceResidue');
      assert.deepEqual(fixture.resources.capacity.current.runtimeMarker, { state: 'unavailable', reason: 'workspaceResidue', dimensions: [] });
    } finally { await fixture.close(); }
  });
});
