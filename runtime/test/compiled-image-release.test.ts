import assert from 'node:assert/strict';
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
  assert.equal(parsed.broker.sha256, 'aa52d71f8a2243bdcb83bc394a12fe8193e413eb70b3543130f69df5a99c5d13');
  assert.equal(parsed.observer.sha256, 'bb3818599c2b5c5c4da98af42daea4300bfdb3103c0d420009021bd8af313fec');
  assert.equal(parsed.broker.sources.length, 5);
  assert.equal(parsed.observer.sources.length, 1);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] = 32;
  assert.throws(() => parseCompiledImageRelease(changed), CompiledImageReleaseError);
});
