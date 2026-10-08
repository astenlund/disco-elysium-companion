import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { describe, it } from 'node:test';

import { DataRootUnavailableError } from '../src/admission.ts';
import { createReadOnlyInspection } from '../src/read-only-inspection.ts';
import { companionFixture } from './support/companion.ts';

describe('independent read-only metadata ownership', () => {
  it('allows concurrent readers without creating state or reusing a closed helper owner', { timeout: 30000 }, async () => {
    const fixture = await companionFixture();
    const first = await createReadOnlyInspection(fixture.root);
    const second = await createReadOnlyInspection(fixture.root);
    try {
      const [left, right] = await Promise.all([first.inspector.inspect(fixture.root, fixture.root), second.inspector.inspect(fixture.root, fixture.root)]);
      assert.equal(left.kind, 'directory');
      assert.equal(left.identity, right.identity);
      assert.deepEqual(await fs.readdir(fixture.root), []);
      await first.close();
      await assert.rejects(first.inspector.inspect(fixture.root, fixture.root), DataRootUnavailableError);
      assert.equal((await second.inspector.inspect(fixture.root, fixture.root)).kind, 'directory');
    } finally { await first.close(); await second.close(); await fixture.close(); }
  });
});
