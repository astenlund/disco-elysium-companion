// Developer workflow: rebuilds the native helper with the closed build environment, then rewrites the release manifest
// and the two reviewed pins (the manifest digest and the image digest) in compiled-image-release.ts and its test.
// A reviewer verifies a pin by running this tool on the same commit and comparing the result.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { compiledImageGeneration, goToolchain, helperImageFile, manifestFile, nativeHelperSha256 } from '../src/compiled-image-release.ts';
import { canonicalInstallationRoot, compileHelper, helperSourceDigest, helperSourcePaths } from '../src/native-image.ts';

const root = canonicalInstallationRoot();
const directory = path.join(root, '.tmp', `native-pin-${randomBytes(16).toString('hex')}`);
mkdirSync(directory, { recursive: true });
try {
  const output = await compileHelper(root, directory);
  const image = readFileSync(output);
  const imageSha256 = createHash('sha256').update(image).digest('hex');
  const sources = helperSourcePaths(root).map(source => ({ path: source, sha256: helperSourceDigest(root, source) }));
  const manifest = { compiledImagesVersion: 2, toolchain: { name: goToolchain.name, version: goToolchain.version, target: goToolchain.target,
    flags: [...goToolchain.flags] }, helper: { file: path.posix.basename(helperImageFile), bytes: statSync(output).size, sha256: imageSha256, sources } };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(root, manifestFile), manifestBytes);
  const generation = createHash('sha256').update(manifestBytes).digest('hex');
  // The pins are rewritten by name, never by value: two pins can hold the same placeholder.
  for (const relative of ['runtime/src/compiled-image-release.ts', 'runtime/test/compiled-image-release.test.ts']) {
    const location = path.join(root, relative);
    let text: string;
    try { text = readFileSync(location, 'utf8'); }
    catch { continue; }
    writeFileSync(location, text.replace(/(compiledImageGeneration = ')[0-9a-f]{64}(')/g, `$1${generation}$2`)
      .replace(/(nativeHelperSha256 = ')[0-9a-f]{64}(')/g, `$1${imageSha256}$2`));
  }
  process.stdout.write(`previous manifest ${compiledImageGeneration}, image ${nativeHelperSha256}\n`);
  process.stdout.write(`manifest ${generation}\nimage ${imageSha256} (${image.length} bytes, ${sources.length} sources)\n`);
} finally { rmSync(directory, { recursive: true, force: true }); }
