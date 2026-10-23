import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import { discoverScope, readScope } from '../src/scope.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

test('discovers and reads a scope with one fresh path batch per operation', { timeout: 120000 }, async () => {
  const fixture = await companionFixture();
  const supervisor = (await createTestNative(fixture.root)).supervisor;
  const inspector = new PathInspector(supervisor);
  const original = inspector.inspectMany.bind(inspector);
  const batches: { root: string; targets: readonly string[]; allowMissing: boolean }[] = [];
  inspector.inspectMany = (root, targets, allowMissing = false, timeoutMs = 30000) => {
    batches.push({ root, targets: [...targets], allowMissing });
    return original(root, targets, allowMissing, timeoutMs);
  };
  try {
    const candidate = await discoverScope(inspector, fixture.root, 'stub', 'batch-principal');
    assert.deepEqual(batches, [{ root: fixture.root, targets: [fixture.root, candidate.dataRoot], allowMissing: true }]);
    batches.length = 0;
    assert.equal(await readScope(inspector, candidate), null);
    assert.deepEqual(batches, [{ root: candidate.companionRoot,
      targets: [candidate.dataRoot, path.join(candidate.dataRoot, 'scope.json')], allowMissing: true }]);

    await fs.mkdir(candidate.dataRoot, { recursive: true });
    batches.length = 0;
    assert.equal(await readScope(inspector, candidate), null);
    assert.equal(batches.length, 1);

    const binding = path.join(candidate.dataRoot, 'scope.json');
    await fs.writeFile(binding, JSON.stringify({ runtimeScopeVersion: 1, game: 'stub', principal: 'batch-principal' }));
    batches.length = 0;
    const admitted = await readScope(inspector, candidate);
    assert.equal(admitted?.createdHere, false);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]?.targets, [candidate.dataRoot, binding]);

    await fs.writeFile(binding, JSON.stringify({ runtimeScopeVersion: 1, game: 'stub', principal: 'other-principal' }));
    await assert.rejects(readScope(inspector, candidate), DataRootUnavailableError);
  } finally {
    await inspector.idle();
    await supervisor.verifyQuiescent('metadata');
    await fixture.close();
  }
});
