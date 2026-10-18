import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readCompiledImageRelease } from '../src/compiled-image-release.ts';
import { normalizedGoSourceHash } from '../src/go-source.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('broker sources match the fixed release after uniform checkout line-ending normalization', async () => {
  const release = readCompiledImageRelease();
  for (const source of release.broker.sources) {
    const bytes = await fs.readFile(path.join(repository, source.path));
    assert.equal(normalizedGoSourceHash(bytes), source.sha256, source.path);
  }
  assert.equal(normalizedGoSourceHash(Buffer.from([97, 10])), normalizedGoSourceHash(Buffer.from([97, 13, 10])));
  assert.throws(() => normalizedGoSourceHash(Buffer.from([97, 13, 10, 98, 10])));
  assert.throws(() => normalizedGoSourceHash(Buffer.from([97, 13, 98])));
  assert.throws(() => normalizedGoSourceHash(Buffer.from([97])));
});
