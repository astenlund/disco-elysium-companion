import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openBackend, privateStartupMetadataPlacement } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { takeInstanceGuard } from '../../src/guard.ts';
import { ProcessSupervisor } from '../../src/process.ts';
import { StartupMetadataSession } from '../../src/startup-metadata.ts';
import { companionFixture } from '../support/companion.ts';

test('failed post-admission worker proof preserves marker and verifies worker stop', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  const originalMatches = StartupMetadataSession.prototype.matchesStartupEvidence;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root });
    const dataRoot = backend.scope.dataRoot;
    await backend.shutdown(true);
    backend = null;
    const marker = path.join(dataRoot, 'runtime.json');
    const before = await fs.readFile(marker);
    let proofs = 0;
    StartupMetadataSession.prototype.matchesStartupEvidence = function () { proofs++; return false; };
    try { await assert.rejects(openBackend({ companionRoot: fixture.root, startupMetadata: true, [privateStartupMetadataPlacement]: 'postGuard' })); }
    finally { StartupMetadataSession.prototype.matchesStartupEvidence = originalMatches; }
    assert.ok(proofs > 0);
    assert.deepEqual(await fs.readFile(marker), before);
    const supervisor = await ProcessSupervisor.create(dataRoot);
    await supervisor.verifyQuiescent('startupMetadata');
    const guard = await takeInstanceGuard(dataRoot, () => { throw new Error('Private guard was lost.'); });
    assert.equal(guard.held, true);
    await guard.release();
  } finally {
    StartupMetadataSession.prototype.matchesStartupEvidence = originalMatches;
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
