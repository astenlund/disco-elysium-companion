import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { companionFixture, FixtureResidueError } from './support/companion.ts';

const exclusiveScript = fileURLToPath(new URL('./backend/fixtures/Exclusive-FileHandle.ps1', import.meta.url));

/** Holds the file open without delete sharing in another process until released, so no removal can take it. */
async function holdExclusively(file: string): Promise<{ release(): Promise<void> }> {
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-hold-'));
  const stop = path.join(control, 'stop');
  const holder = spawn('pwsh', ['-NoProfile', '-File', exclusiveScript, '-Path', file, '-Hold', '-StopPath', stop], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve, reject) => { holder.once('close', resolve); holder.once('error', reject); });
  const first = await createInterface({ input: holder.stdout })[Symbol.asyncIterator]().next();
  assert.equal(first.value, 'ready');

  return {
    async release(): Promise<void> {
      await fs.writeFile(stop, 'stop');
      assert.equal(await exited, 0);
      await fs.rm(control, { recursive: true, force: true });
    },
  };
}

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

  it('rejects with a path-free residue error when a held handle keeps the root alive', { timeout: 120000 }, async () => {
    // Arrange
    const fixture = await companionFixture();
    const held = path.join(fixture.root, 'held.txt');
    await fs.writeFile(held, 'x');
    const hold = await holdExclusively(held);
    let failure: unknown = null;

    // Act
    try {
      try { await fixture.close(); }
      catch (error) { failure = error; }
    }
    finally { await hold.release(); }

    // Assert
    try {
      assert.ok(failure instanceof FixtureResidueError, `expected FixtureResidueError, got ${String(failure)}`);
      assert.deepEqual(failure.residue, { remaining: 1, sample: ['held.txt'] });
      assert.equal(failure.message.includes(fixture.root), false);
      assert.equal(existsSync(fixture.root), true);
    }
    finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
  });
});
