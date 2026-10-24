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
const compiledImageGeneration = 'd58b03d182a8932575c7e26c99fa649185465ce40ca1d30a887041bee4abc499';
const nativeHelperSha256 = '0cdf981bd145e68cf4d3bff21eef23ee822bbb494dc162da4563314c9e058f34';

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
