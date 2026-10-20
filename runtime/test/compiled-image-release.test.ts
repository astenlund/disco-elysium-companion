import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CompiledImageReleaseError, compiledImageGeneration, parseCompiledImageRelease,
  readCompiledImageRelease } from '../src/compiled-image-release.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = path.join(repository, 'runtime/native/compiled-images.json');

test('packaged Go images bind one fixed manifest generation and source list', async () => {
  const bytes = await fs.readFile(manifest);
  assert.equal(bytes.includes(13), false);
  const parsed = parseCompiledImageRelease(bytes);
  assert.deepEqual(readCompiledImageRelease(), parsed);
  assert.equal(parsed.generation, compiledImageGeneration);
  assert.equal(parsed.broker.sha256, '3159986b0ed324454000b6b1c7cd21e85d761434823f3053cfe766eea3f2659d');
  assert.equal(parsed.observer.sha256, 'f2301be464bf0f41f1851144319a6058370a0e118bbf93d094173b71826db12d');
  assert.equal(parsed.broker.sources.length, 5);
  assert.equal(parsed.observer.sources.length, 1);
  for (const image of [parsed.broker, parsed.observer]) {
    const packaged = await fs.readFile(path.join(repository, 'runtime/native', image.file));
    assert.equal(packaged.length, image.bytes, image.file);
    assert.equal(createHash('sha256').update(packaged).digest('hex'), image.sha256, image.file);
  }
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] = 32;
  assert.throws(() => parseCompiledImageRelease(changed), CompiledImageReleaseError);
});
