import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PathInspector } from '../../src/admission.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import { ResourceAuthority } from '../../src/resource-lifecycle/resources.ts';
import type { RuntimeScope } from '../../src/scope.ts';
import { createTestNative } from '../support/native-helper.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binding = '{"runtimeScopeVersion":1,"game":"stubgame","principal":"principal"}';

/** A scratch runtime-data scope inspected by the real helper; `prepare` adds the entries a case needs. */
async function inspectScope(prepare: (dataRoot: string) => Promise<void>, act: (resources: ResourceAuthority) => Promise<void>): Promise<ResourceAuthority> {
  const scratch = await fs.mkdtemp(path.join(repository, '.tmp', 'inventory-categories-'));
  const dataRoot = path.join(scratch, 'data');
  await fs.mkdir(path.join(dataRoot, 'journal', 'events'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'scope.json'), binding);
  await prepare(dataRoot);
  const native = await createTestNative(dataRoot);
  try {
    const scope: RuntimeScope = { companionRoot: scratch, dataRoot, game: 'stubgame', principal: 'principal', bindingSha256: createHash('sha256').update(binding).digest('hex'), createdHere: false };
    const resources = new ResourceAuthority(scope, new PathInspector(native.supervisor), {} as never);
    await act(resources);

    return resources;
  } finally {
    await native.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

describe('inventory failure categories through the native helper', () => {
  it('refuses an ordinary transition over a foreign folder in journal as foreignEntryJournal', { timeout: 120000 }, async () => {
    // Arrange, Act
    const resources = await inspectScope(dataRoot => fs.mkdir(path.join(dataRoot, 'journal', 'unexpected')),
      resources => assert.rejects(resources.withTransition('ordinary', () => resources.reserve('ordinary')),
        error => error instanceof RuntimeCapacityError && error.state === 'unavailable' && error.dimensions.join() === 'foreignEntryJournal'));

    // Assert
    assert.deepEqual(resources.capacity.current.ordinary, { state: 'unavailable', reason: 'foreignEntryJournal', dimensions: [] });
  });

  it('refuses the runtime marker over a runtime.json publication sibling as workspaceResidue', { timeout: 120000 }, async () => {
    // Arrange, Act
    const resources = await inspectScope(dataRoot => fs.writeFile(path.join(dataRoot, `runtime.json.${'a'.repeat(32)}.tmp`), 'residue'),
      resources => assert.rejects(resources.withTransition('runtimeMarker', () => resources.reserveRuntimeMarker()),
        error => error instanceof RuntimeCapacityError && error.dimensions.join() === 'workspaceResidue'));

    // Assert
    assert.deepEqual(resources.capacity.current.runtimeMarker, { state: 'unavailable', reason: 'workspaceResidue', dimensions: [] });
  });
});
