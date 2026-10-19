import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend, privateSelectedImageBootstrap } from '../src/backend/index.ts';
import { withDirectMainToken } from '../src/direct-main-capability.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absent = path.join(root, '.tmp', 'selected-image-direct-main-absent');

test('a selected image bootstrap without the direct-main token fails before any startup work', async () => {
  const phases: string[] = [];
  let transferMarked = false;
  await assert.rejects(openBackend({ companionRoot: absent, onStartupPhase: phase => phases.push(phase),
    [privateSelectedImageBootstrap]: { token: Symbol('forged'), imageRoot: absent, scratch: absent, environment: {},
      markPossibleTransfer: () => { transferMarked = true; }, onVerifiedPins: () => { throw new Error('Pins must not verify.'); } } }),
  /Compiled image transfer requires direct CLI main/);
  assert.deepEqual(phases, []);
  assert.equal(transferMarked, false);
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
});

test('the direct-main token is unavailable outside the direct CLI entry', () => {
  let issued = false;
  assert.throws(() => withDirectMainToken(() => { issued = true; }), /Compiled image transfer requires direct CLI main/);
  assert.equal(issued, false);
});
