import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend, readBackendStatus } from '../src/backend/index.ts';
import { runCli } from '../src/cli.ts';
import { helperImageFile, helperModule } from '../src/compiled-image-release.ts';
import { ConfigurationError, loadRuntimeConfig } from '../src/config.ts';
import { admitLaunchRoot, installationRootBound, launchDirectoryRefusal, maxLaunchDirectoryLength, maxLaunchExecutableLength } from '../src/launch-directory.ts';
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

/** The installation bound, derived here from the measured limits and the launch paths installationRootBound covers. */
async function expectedInstallationBound(): Promise<number> {
  const adapter = (await loadRuntimeConfig(configFile)).adapter;
  const depth = (relative: string): number => path.join('', relative).length + 1;

  return Math.min(maxLaunchDirectoryLength, maxLaunchDirectoryLength - depth(path.join('adapters', adapter)), maxLaunchDirectoryLength - depth(helperModule),
    maxLaunchExecutableLength - depth(helperImageFile));
}

/** Runs one CLI command on a root of `rootLength` characters holding the checked-in configuration, in a folder of this run's own. */
async function cliWith(args: readonly string[], rootLength: number): Promise<{ readonly failure: unknown; readonly progress: readonly unknown[]; readonly written: readonly string[] }> {
  const scratch = await fs.mkdtemp(path.join(tmp, 'launch-cli-'));
  try {
    const root = pathOfLength(scratch, 'launch-root-', rootLength);
    await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
    await fs.copyFile(configFile, path.join(root, 'runtime', 'companion.config.json'));
    const progress: unknown[] = [];
    const written: string[] = [];
    let failure: unknown = null;
    try { await runCli(args, root, text => { written.push(text); }, event => { progress.push(event); }, () => undefined); }
    catch (error) { failure = error; }

    return { failure, progress, written };
  }
  finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

describe('installation launch admission at the command line', () => {
  for (const command of ['status', 'chat']) {
    it(`refuses ${command} for a root one character over the installation bound, before any build, helper or progress`, { timeout: 60000 }, async () => {
      // Arrange
      const bound = await expectedInstallationBound();

      // Act
      const { failure, progress, written } = await cliWith([command], bound + 1);

      // Assert
      assert.ok(failure instanceof ConfigurationError, `expected ConfigurationError, got ${String(failure)}`);
      assert.match(failure.message, new RegExp(`has ${bound + 1} characters, but this installation needs one of at most ${bound}`));
      assert.deepEqual(progress, []);
      assert.deepEqual(written, []);
    });
  }

  it('refuses chat for a root over the bound even when its configuration cannot be read, before any build or progress', { timeout: 60000 }, async () => {
    // Arrange: a configuration that does not parse, so only the adapter-free part of the bound can be checked.
    const bound = await expectedInstallationBound();
    const scratch = await fs.mkdtemp(path.join(tmp, 'launch-cli-'));
    try {
      const root = pathOfLength(scratch, 'launch-root-', bound + 1);
      await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
      await fs.writeFile(path.join(root, 'runtime', 'companion.config.json'), 'not json');
      const progress: unknown[] = [];
      let failure: unknown = null;

      // Act
      try { await runCli(['chat'], root, () => undefined, event => { progress.push(event); }, () => undefined); }
      catch (error) { failure = error; }

      // Assert
      assert.ok(failure instanceof ConfigurationError, `expected ConfigurationError, got ${String(failure)}`);
      assert.match(failure.message, new RegExp(`has ${bound + 1} characters, but this installation needs one of at most ${bound}`));
      assert.deepEqual(progress, []);
    }
    finally { await fs.rm(scratch, { recursive: true, force: true }); }
  });

  it('refuses standalone status for a helper image path too long to start, before its launcher runs', { timeout: 60000 }, async () => {
    // Arrange
    const scratch = await fs.mkdtemp(path.join(tmp, 'launch-status-'));
    try {
      const root = pathOfLength(scratch, 'launch-root-', 120);
      await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
      await fs.copyFile(configFile, path.join(root, 'runtime', 'companion.config.json'));
      const image: HelperImage = { path: pathOfLength(scratch, 'image-', maxLaunchExecutableLength + 1 - 4) + '.exe', sha256: '0'.repeat(64), volume: '0', fileId: '0' };
      let launches = 0;

      // Act
      const reading = readBackendStatus(root, { nativeImage: image, nativeLauncher: () => { launches++; throw new Error('The helper service must not start.'); } });

      // Assert
      await assert.rejects(reading, error => error instanceof ConfigurationError && error.message.includes(`has ${maxLaunchExecutableLength + 1} characters`));
      assert.equal(launches, 0);
    }
    finally { await fs.rm(scratch, { recursive: true, force: true }); }
  });
});

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

  it('refuses a root over the installation bound before starting the helper service, and admits the bound itself', { timeout: 60000 }, async () => {
    // Arrange
    const bound = await expectedInstallationBound();

    // Act
    const refused = await openWith(bound + 1);
    const admitted = await openWith(bound);

    // Assert
    assert.equal(installationRootBound((await loadRuntimeConfig(configFile)).adapter), bound);
    assert.equal(refused.code, 'configurationInvalid', refused.message);
    assert.match(refused.message, new RegExp(`has ${bound + 1} characters, but this installation needs one of at most ${bound}`));
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
    assert.match(refused.message, new RegExp(`helper image path has ${maxLaunchExecutableLength + 1} characters, but the runtime cannot start the helper image from a path longer than ${maxLaunchExecutableLength}`));
    assert.equal(refused.launches, 0);
    assert.equal(admitted.code, 'nativeHelperUnavailable', admitted.message);
  });
});
