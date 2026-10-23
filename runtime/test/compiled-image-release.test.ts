import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { compiledImageGeneration as releaseGeneration, manifestFile, nativeHelperSha256 as releaseImage, parseNativeHelperRelease,
  readNativeHelperRelease } from '../src/compiled-image-release.ts';
import { NativeHelperUnavailableError } from '../src/native-helper-error.ts';
import { canonicalInstallationRoot, compileHelper, helperSourcePaths, verifyHelperSources } from '../src/native-image.ts';

// The reviewed pins, repeated here so a pin change is visible in review; the pin tool rewrites both copies.
const compiledImageGeneration = '55e459c26f5198e819a6fe70909df0554eb2c38ec557b20b80fe1935f9fe1f04';
const nativeHelperSha256 = '26ed4436fc62f7579a8d44a0f1b0178848e56159f2e01e7383930fe41003850d';

const root = canonicalInstallationRoot();

test('the helper release manifest binds the reviewed pins and the checkout source set', async () => {
  // Arrange
  const bytes = await fs.readFile(path.join(root, manifestFile));

  // Act
  const parsed = parseNativeHelperRelease(bytes);

  // Assert
  assert.equal(bytes.includes(13), false);
  assert.equal(releaseGeneration, compiledImageGeneration);
  assert.equal(releaseImage, nativeHelperSha256);
  assert.equal(parsed.generation, compiledImageGeneration);
  assert.equal(parsed.helper.sha256, nativeHelperSha256);
  assert.deepEqual(readNativeHelperRelease(root), parsed);
  assert.deepEqual(parsed.helper.sources.map(source => source.path), helperSourcePaths(root));
  verifyHelperSources(root, parsed);
});

test('a changed manifest refuses with the source-digest reason', async () => {
  // Arrange
  const changed = Buffer.from(await fs.readFile(path.join(root, manifestFile)));
  changed[changed.length - 1] = 32;

  // Act
  const attempt = () => parseNativeHelperRelease(changed);

  // Assert
  assert.throws(attempt, error => error instanceof NativeHelperUnavailableError && error.reason === 'sourceMismatch');
});

test('a build into a private .tmp location reproduces the pinned image', { timeout: 900000 }, async () => {
  // Arrange
  const directory = path.join(root, '.tmp', `native-reproduce-${randomBytes(16).toString('hex')}`);
  await fs.mkdir(directory, { recursive: true });
  try {
    // Act
    const output = await compileHelper(root, directory);
    const bytes = await fs.readFile(output);

    // Assert
    assert.equal(bytes.length, parseNativeHelperRelease(await fs.readFile(path.join(root, manifestFile))).helper.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), nativeHelperSha256);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
