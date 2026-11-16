import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PathInspector } from '../../src/admission.ts';
import { assessCapacity, RuntimeCapacityError } from '../../src/capacity.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import { completeReservation } from '../../src/resource-lifecycle/resources.ts';
import { trimQuarantine } from '../../src/resource-lifecycle/retention.ts';
import type { ScopeStorage } from '../../src/storage.ts';
import { noOperations, resourceScopeFixture, type ResourceScopeFixture } from '../support/resource-scope.ts';

function trimDependencies(fixture: ResourceScopeFixture): Parameters<typeof trimQuarantine>[0] {
  return { scope: fixture.scope, inspector: new PathInspector(fixture.native.supervisor), storage: { ensureDirectory: async () => {} } as unknown as ScopeStorage };
}

/** Runs the quarantine trim inside the maintenance transition and returns its failure after maintenance's capacity capture. */
async function trimMaintenance(fixture: ResourceScopeFixture): Promise<unknown> {
  try {
    await fixture.resources.withTransition('maintenance', () => trimQuarantine(trimDependencies(fixture), new Set()));
  } catch (error) { return fixture.resources.captureFailure(error) ?? error; }
  throw new Error('The quarantine trim succeeded over a refused entry.');
}

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

  for (const [label, entry] of [['a stray file', 'notes.txt'], ['a folder', 'unexpected']] as const) {
    it(`refuses the maintenance slot over ${label} in quarantine as foreignEntryQuarantine`, { timeout: 120000 }, async () => {
      // Arrange
      const fixture = await resourceScopeFixture('inventory-categories', async dataRoot => {
        await fs.mkdir(path.join(dataRoot, 'quarantine'));
        if (entry === 'unexpected') { await fs.mkdir(path.join(dataRoot, 'quarantine', entry)); } else { await fs.writeFile(path.join(dataRoot, 'quarantine', entry), 'stray'); }
      }, noOperations, true);
      try {
        // Act: the quarantine trim inside the maintenance transition, with the capture that maintainRuntimeStorage applies.
        const refused = await trimMaintenance(fixture);

        // Assert
        assert.ok(refused instanceof RuntimeCapacityError && refused.state === 'unavailable' && refused.transition === 'maintenance', String(refused));
        assert.deepEqual(refused.dimensions, ['foreignEntryQuarantine']);
        assert.deepEqual(fixture.resources.capacity.current.maintenance, { state: 'unavailable', reason: 'foreignEntryQuarantine', dimensions: [] });
      } finally { await fixture.close(); }
    });
  }

  it('keeps a control failure for a publication temporary in quarantine', { timeout: 120000 }, async () => {
    // Arrange
    const residue = `record.${'a'.repeat(32)}.quarantined.${'b'.repeat(32)}.tmp`;
    const fixture = await resourceScopeFixture('inventory-categories', async dataRoot => {
      await fs.mkdir(path.join(dataRoot, 'quarantine'));
      await fs.writeFile(path.join(dataRoot, 'quarantine', residue), 'residue');
    }, noOperations, true);
    try {
      // Act
      const refused = await trimMaintenance(fixture);
      await fs.rm(path.join(fixture.dataRoot, 'quarantine', residue));
      const removed = await trimQuarantine(trimDependencies(fixture), new Set());

      // Assert: the same bound scope trims once the temporary is gone, so the refusal came from the temporary.
      assert.ok(refused instanceof ControlDocumentError, String(refused));
      assert.equal(fixture.resources.capacity.current.maintenance.state, 'unchecked');
      assert.equal(removed, 0);
    } finally { await fixture.close(); }
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
