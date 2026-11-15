import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeCapacityError } from '../../src/capacity.ts';
import { resourceScopeFixture } from '../support/resource-scope.ts';

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
