import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { openBackend, privateScopeSourceBatch, privateStartupMetadataPlacement } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { companionFixture } from '../support/companion.ts';

test('private combined bootstrap falls back for a new scope and refuses a changed binding', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true, [privateStartupMetadataPlacement]: 'postGuard', [privateScopeSourceBatch]: true });
    assert.equal(backend.scope.createdHere, true);
    const dataRoot = backend.scope.dataRoot;
    await backend.closeStartupWorkers();
    await backend.shutdown(true);
    backend = null;
    const marker = path.join(dataRoot, 'runtime.json');
    const before = await fs.readFile(marker);
    await fs.writeFile(path.join(dataRoot, 'scope.json'), '{}');
    await assert.rejects(openBackend({ companionRoot: fixture.root, startupMetadata: true, [privateStartupMetadataPlacement]: 'postGuard', [privateScopeSourceBatch]: true }),
      DataRootUnavailableError);
    assert.deepEqual(await fs.readFile(marker), before);
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
