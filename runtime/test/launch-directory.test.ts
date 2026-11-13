import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { ConfigurationError, loadRuntimeConfig } from '../src/config.ts';
import { admitLaunchRoot, launchDirectoryRefusal, maxLaunchDirectoryLength, maxLaunchExecutableLength } from '../src/launch-directory.ts';
import type { HelperImage } from '../src/native-image.ts';
import { pathOfLength } from './support/launch-length.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = path.join(repository, '.tmp');
const configFile = path.join(repository, 'runtime', 'companion.config.json');

interface Opened { readonly code: unknown; readonly message: string; readonly launches: number; readonly entries: readonly string[] }

/**
 * Opens the backend on a root of `rootLength` characters holding the checked-in configuration, with a helper image path
 * of `imageLength` characters that does not exist, inside a folder of this run's own. An admitted root gets past the
 * configuration and fails at helper start, which refuses the absent image before its launcher runs.
 */
async function openWith(rootLength: number, imageLength = 120): Promise<Opened> {
  const scratch = await fs.mkdtemp(path.join(tmp, 'launch-admission-'));
  try {
    const root = pathOfLength(scratch, 'launch-root-', rootLength);
    await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
    await fs.copyFile(configFile, path.join(root, 'runtime', 'companion.config.json'));
    const image: HelperImage = { path: pathOfLength(scratch, 'image-', imageLength - 4) + '.exe', sha256: '0'.repeat(64), volume: '0', fileId: '0' };
    let launches = 0;
    try {
      await openBackend({ companionRoot: root, nativeImage: image, nativeLauncher: () => { launches++; throw new Error('The helper service must not start.'); } });
      throw new Error('The backend opened unexpectedly.');
    }
    catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;

      return { code, message: error instanceof Error ? error.message : String(error), launches, entries: await fs.readdir(root) };
    }
  }
  finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

describe('companion root launch admission', () => {
  it('admits a root at the launch limit and refuses one character more with the root length and the remedy', () => {
    // Arrange
    const longest = pathOfLength(tmp, 'launch-root-', maxLaunchDirectoryLength);
    const tooLong = pathOfLength(tmp, 'launch-root-', maxLaunchDirectoryLength + 1);

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
    const longest = pathOfLength(tmp, 'launch-root-', maxLaunchDirectoryLength - depth);
    const tooLong = pathOfLength(tmp, 'launch-root-', maxLaunchDirectoryLength - depth + 1);

    // Act
    const admitted = launchDirectoryRefusal(longest, relative);
    const refused = launchDirectoryRefusal(tooLong, relative);

    // Assert
    assert.equal(admitted, null);
    assert.match(refused ?? '', new RegExp(`has ${maxLaunchDirectoryLength - depth + 1} characters, but this launch needs one of at most ${maxLaunchDirectoryLength - depth}`));
  });

  it('raises the refusal as an invalid configuration', () => {
    // Arrange
    const tooLong = pathOfLength(tmp, 'launch-root-', maxLaunchDirectoryLength + 1);

    // Act and assert
    assert.throws(() => admitLaunchRoot(tooLong), error => error instanceof ConfigurationError && error.code === 'configurationInvalid');
    assert.doesNotThrow(() => admitLaunchRoot(pathOfLength(tmp, 'launch-root-', maxLaunchDirectoryLength)));
  });

  it('refuses a root too long for the adapter launch directory before starting the helper service, and admits one character less', { timeout: 60000 }, async () => {
    // Arrange: the core starts the adapter's commands in adapters/<adapter>, the deepest launch directory below the root.
    const adapter = (await loadRuntimeConfig(configFile)).adapter;
    const allowed = maxLaunchDirectoryLength - path.join('adapters', adapter).length - 1;

    // Act
    const refused = await openWith(allowed + 1);
    const admitted = await openWith(allowed);

    // Assert
    assert.equal(refused.code, 'configurationInvalid', refused.message);
    assert.match(refused.message, new RegExp(`has ${allowed + 1} characters, but this launch needs one of at most ${allowed}`));
    assert.equal(refused.launches, 0);
    assert.deepEqual(refused.entries, ['runtime']);
    assert.equal(admitted.code, 'nativeHelperUnavailable', admitted.message);
  });

  it('refuses a helper image path too long to start before starting the helper service, and admits one character less', { timeout: 60000 }, async () => {
    // Act
    const refused = await openWith(120, maxLaunchExecutableLength + 1);
    const admitted = await openWith(120, maxLaunchExecutableLength);

    // Assert
    assert.equal(refused.code, 'configurationInvalid', refused.message);
    assert.match(refused.message, new RegExp(`has ${maxLaunchExecutableLength + 1} characters, but Windows cannot start an executable whose path is longer than ${maxLaunchExecutableLength}`));
    assert.equal(refused.launches, 0);
    assert.equal(admitted.code, 'nativeHelperUnavailable', admitted.message);
  });
});
