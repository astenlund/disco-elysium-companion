import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { FileObservationError, observeFile } from '../src/file-observation.ts';
import { jsonBudgets, readBoundedFile, StrictJsonError } from '../src/json.ts';
import { companionFixture } from './support/companion.ts';

describe('diagnostic byte observation', () => {
  it('hashes complete over-budget bytes without admitting them as JSON', async () => {
    const fixture = await companionFixture();
    try {
      const target = path.join(fixture.root, 'damaged.json');
      for (const size of [2, jsonBudgets.config.maxBytes, jsonBudgets.config.maxBytes + 1, jsonBudgets['state-event'].maxBytes + 1]) {
        const bytes = Buffer.alloc(size, 32);
        bytes[0] = 123; bytes[1] = 125;
        await fs.writeFile(target, bytes);
        assert.deepEqual(await observeFile(target), { bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') });
        if (size > jsonBudgets.config.maxBytes) { await assert.rejects(readBoundedFile(target, jsonBudgets.config.maxBytes), StrictJsonError); }
      }
      await assert.rejects(observeFile(path.join(fixture.root, 'absent')), { code: 'ENOENT' });
      await assert.rejects(observeFile(fixture.root), error => error instanceof FileObservationError || (error as NodeJS.ErrnoException).code === 'EISDIR');
    } finally { await fixture.close(); }
  });

  it('fails incomplete observation without returning a partial hash', async () => {
    const fixture = await companionFixture();
    try {
      const target = path.join(fixture.root, 'large.json');
      await fs.writeFile(target, Buffer.alloc(131072));
      let tick = 0;
      const budget = Deadline.after(5, () => tick++);
      await assert.rejects(observeFile(target, budget), DeadlineExceededError);
    } finally { await fixture.close(); }
  });
});

describe('shared monotonic deadline', () => {
  it('keeps queue time and repeated child allowances within one original budget', () => {
    let now = 10;
    const deadline = Deadline.after(120000, () => now);
    assert.equal(deadline.remaining(), 30000);
    now += 100000;
    assert.equal(deadline.remaining(), 20000);
    now += 19999;
    assert.equal(deadline.remaining(), 1);
    now++;
    assert.throws(() => deadline.remaining(), DeadlineExceededError);
  });
});
