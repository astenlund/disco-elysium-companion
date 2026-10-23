import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { openBackend } from '../../src/backend/index.ts';
import { ReleaseRefusedError } from '../../src/backend/consumer.ts';
import { companionFixture } from '../support/companion.ts';
import { testHelperImage } from '../support/native-helper.ts';

describe('production coordinator command authority', () => {
  it('initializes exact scoped safety and refuses an unverified confirmed release before the core switch', { timeout: 600000 }, async () => {
    const fixture = await companionFixture('runtime');
    let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
    try {
      backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
      await assert.rejects(backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: false }), ReleaseRefusedError);
      const safety = await backend.safety();
      assert.equal(safety.pendingCheck, null);
      assert.equal(safety.recoveryWitness, null);
      assert.equal(safety.correction, null);
      assert.match(safety.generation, /^[a-f0-9]{32}$/);
      assert.deepEqual(await fs.readdir(path.join(backend.scope.dataRoot, 'operations')), []);
      await assert.rejects(fs.access(path.join(fixture.root, 'state', 'consumer.json')));
      await backend.shutdown(true);
      backend = null;
    } finally {
      if (backend !== null) { await backend.shutdown(true); }
      await fixture.close();
    }
  });

  it('durably switches ownership using the protected handover intent', { timeout: 600000 }, async () => {
    const fixture = await companionFixture('runtime');
    let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
    try {
      backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
      const startup = await backend.startup({ kind: 'consumer', owner: 'runtime', abandonUndelivered: false });
      assert.equal(startup.consumerResult?.success, true);
      const records = await fs.readdir(path.join(backend.scope.dataRoot, 'operations'));
      assert.equal(records.length, 1);
      const operation = JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'operations', records[0]!), 'utf8'));
      assert.equal(operation.kind, 'handover');
      assert.equal(operation.outcome, 'completed');
      assert.equal(operation.safety.phase, 'discharged');
      assert.equal(operation.plan.result.owner, 'runtime');
      assert.equal((await backend.safety()).pendingCheck, null);
      await backend.shutdown(true);
      backend = null;
    } finally {
      if (backend !== null) { await backend.shutdown(true); }
      await fixture.close();
    }
  });
});
