import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { ConfigurationError } from '../src/config.ts';
import { admitLaunchRoot, launchDirectoryRefusal, maxLaunchDirectoryLength } from '../src/launch-directory.ts';
import type { HelperImage } from '../src/native-image.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A root path of exactly `length` characters inside `parent` (by default the repository's .tmp); this builds the path only. */
function rootOfLength(length: number, parent = path.join(repository, '.tmp')): string {
  const base = path.join(parent, 'launch-root-');
  assert.ok(base.length < length, `the parent path is too long to build a ${length}-character root`);

  return base + 'r'.repeat(length - base.length);
}

describe('companion root launch admission', () => {
  it('admits a root at the launch limit and refuses one character more with the root length and the remedy', () => {
    // Arrange
    const longest = rootOfLength(maxLaunchDirectoryLength);
    const tooLong = rootOfLength(maxLaunchDirectoryLength + 1);

    // Act
    const admitted = launchDirectoryRefusal(longest);
    const refused = launchDirectoryRefusal(tooLong);

    // Assert
    assert.equal(admitted, null);
    assert.ok(refused !== null);
    assert.match(refused, new RegExp(`has ${maxLaunchDirectoryLength + 1} characters, but this launch needs one of at most ${maxLaunchDirectoryLength}`));
    assert.match(refused, /Move the companion root to a shorter path\.$/);
    assert.equal(refused.includes(tooLong), false);
  });

  it('lowers the allowed root length by the depth a launch adds beneath the root', () => {
    // Arrange
    const relative = path.join('runtime', 'native', 'helper');
    const depth = relative.length + 1;
    const longest = rootOfLength(maxLaunchDirectoryLength - depth);
    const tooLong = rootOfLength(maxLaunchDirectoryLength - depth + 1);

    // Act
    const admitted = launchDirectoryRefusal(longest, relative);
    const refused = launchDirectoryRefusal(tooLong, relative);

    // Assert
    assert.equal(admitted, null);
    assert.match(refused ?? '', new RegExp(`has ${maxLaunchDirectoryLength - depth + 1} characters, but this launch needs one of at most ${maxLaunchDirectoryLength - depth}`));
  });

  it('raises the refusal as an invalid configuration', () => {
    // Arrange
    const tooLong = rootOfLength(maxLaunchDirectoryLength + 1);

    // Act and assert
    assert.throws(() => admitLaunchRoot(tooLong), error => error instanceof ConfigurationError && error.code === 'configurationInvalid');
    assert.doesNotThrow(() => admitLaunchRoot(rootOfLength(maxLaunchDirectoryLength)));
  });

  it('refuses a too-long root when opening the backend before reading its configuration or starting the helper service', async () => {
    // Arrange: a valid configuration under the root, so neither a missing file nor the absent image can refuse it first.
    // The root lives in a folder of this run's own, which alone is removed afterwards.
    const scratch = await fs.mkdtemp(path.join(repository, '.tmp', 'launch-admission-'));
    const tooLong = rootOfLength(maxLaunchDirectoryLength + 1, scratch);
    await fs.mkdir(path.join(tooLong, 'runtime'), { recursive: true });
    await fs.copyFile(path.join(repository, 'runtime', 'companion.config.json'), path.join(tooLong, 'runtime', 'companion.config.json'));
    let launches = 0;
    const image: HelperImage = { path: path.join(scratch, 'never-started.exe'), sha256: '0'.repeat(64), volume: '0', fileId: '0' };
    try {
      // Act
      const opening = openBackend({ companionRoot: tooLong, nativeImage: image, nativeLauncher: () => { launches++; throw new Error('The helper service must not start.'); } });

      // Assert
      await assert.rejects(opening, error => error instanceof ConfigurationError && error.code === 'configurationInvalid'
        && error.message.includes(`has ${maxLaunchDirectoryLength + 1} characters`));
      assert.equal(launches, 0);
      assert.deepEqual(await fs.readdir(tooLong), ['runtime']);
    }
    finally { await fs.rm(scratch, { recursive: true, force: true }); }
  });
});
