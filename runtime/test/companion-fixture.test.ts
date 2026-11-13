import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRootRemoved, companionFixture, FixtureResidueError } from './support/companion.ts';
import { holdExclusively } from './support/exclusive-hold.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('companion fixture cleanup contract', () => {
  it('resolves close only after the fixture root is physically removed', { timeout: 120000 }, async () => {
    // Arrange
    const fixture = await companionFixture();
    await fs.writeFile(path.join(fixture.root, 'plain.txt'), 'x');

    // Act
    await fixture.close();

    // Assert
    assert.equal(existsSync(fixture.root), false);
  });

  it('rejects with the host-reported, path-free residue when a held handle keeps the root alive', { timeout: 120000 }, async () => {
    // Arrange
    const fixture = await companionFixture();
    try {
      const held = path.join(fixture.root, 'held.txt');
      await fs.writeFile(held, 'x');
      const hold = await holdExclusively(held);
      let failure: unknown = null;

      // Act
      try { await fixture.close(); }
      catch (error) { failure = error; }
      finally { await hold.release(); }

      // Assert
      assert.ok(failure instanceof FixtureResidueError, `expected FixtureResidueError, got ${String(failure)}`);
      assert.deepEqual(failure.residue, { kind: 'directory', remaining: 1, sample: ['held.txt'] });
      assert.equal(failure.message.includes(fixture.root), false);
      assert.equal(existsSync(fixture.root), true);
    }
    finally {
      await fixture.close().catch(() => undefined);
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects with path-free residue when an entry that is not a directory stands at the root path', { timeout: 120000 }, async () => {
    // Arrange: the root directory is replaced by a held file, which no removal can take and which is not the root directory.
    const fixture = await companionFixture();
    try {
      await fs.rm(fixture.root, { recursive: true });
      await fs.writeFile(fixture.root, 'x');
      const hold = await holdExclusively(fixture.root);
      let failure: unknown = null;

      // Act
      try { await fixture.close(); }
      catch (error) { failure = error; }
      finally { await hold.release(); }

      // Assert
      assert.ok(failure instanceof FixtureResidueError, `expected FixtureResidueError, got ${String(failure)}`);
      assert.equal(failure.residue.kind, 'not-a-directory');
      assert.equal(failure.message.includes(fixture.root), false);
    }
    finally {
      await fixture.close().catch(() => undefined);
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports a directory still standing at the root with its entry count and a bounded root-relative sample', async () => {
    // Arrange
    const root = await fs.mkdtemp(path.join(repository, '.tmp', 'fixture-residue-'));
    try {
      await fs.mkdir(path.join(root, 'nested'));
      for (let index = 0; index < 20; index++) { await fs.writeFile(path.join(root, 'nested', `f${String(index).padStart(2, '0')}.txt`), 'x'); }
      let failure: unknown = null;

      // Act
      try { await assertRootRemoved(root); }
      catch (error) { failure = error; }

      // Assert
      assert.ok(failure instanceof FixtureResidueError, `expected FixtureResidueError, got ${String(failure)}`);
      assert.equal(failure.residue.kind, 'directory');
      assert.equal(failure.residue.remaining, 21);
      assert.equal(failure.residue.sample.length, 16);
      assert.equal(failure.residue.sample[0], 'nested');
      assert.equal(failure.residue.sample[1], 'nested/f00.txt');
      await assert.doesNotReject(assertRootRemoved(path.join(root, 'absent')));
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
