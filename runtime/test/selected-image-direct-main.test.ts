import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openBackend, privateSelectedImageBootstrap } from '../src/backend/index.ts';
import { DirectImagePinObligation, withDirectMainToken } from '../src/direct-main-capability.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absent = path.join(root, '.tmp', 'selected-image-direct-main-absent');
const fixtureMain = fileURLToPath(new URL('./support/selected-chat-main.ts', import.meta.url));
const execute = promisify(execFile);

async function runFixtureMain(args: readonly string[]): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  try {
    const { stdout } = await execute(process.execPath, [fixtureMain, ...args], { windowsHide: true, timeout: 60000 });
    return { code: 0, lines: stdout.trim().split('\n').map(line => JSON.parse(line)) };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    return { code: typeof failure.code === 'number' ? failure.code : -1,
      lines: (failure.stdout ?? '').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line)) };
  }
}

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

test('the direct-main token is unavailable outside the direct main entries', () => {
  let issued = false;
  assert.throws(() => withDirectMainToken(() => { issued = true; }), /Compiled image transfer requires direct CLI main/);
  assert.equal(issued, false);
});

test('the pin obligation requires a hard exit only while remote handles may exist', () => {
  const idle = new DirectImagePinObligation();
  assert.equal(idle.requiresHardExit, false);
  assert.throws(() => idle.verified('ready'), /pin state is invalid/);
  const ready = new DirectImagePinObligation();
  ready.markPossibleTransfer();
  assert.equal(ready.status, 'unknown');
  assert.equal(ready.requiresHardExit, true);
  ready.verified('ready');
  assert.equal(ready.requiresHardExit, true);
  assert.throws(() => ready.markPossibleTransfer(), /already started/);
  assert.throws(() => ready.verified('absent'), /pin state is invalid/);
  const absentPins = new DirectImagePinObligation();
  absentPins.markPossibleTransfer();
  absentPins.verified('absent');
  assert.equal(absentPins.requiresHardExit, false);
});

test('the fixture main refuses unsafe roots before taking the token', async () => {
  const scratch = await fs.mkdtemp(path.join(root, '.tmp', 'fixture-main-refusal-'));
  try {
    const copied = path.join(scratch, 'copied');
    await fs.mkdir(path.join(copied, 'runtime'), { recursive: true });
    await fs.mkdir(path.join(copied, 'adapters', 'disco_elysium'), { recursive: true });
    await fs.writeFile(path.join(copied, 'runtime', 'companion.config.json'), JSON.stringify({ adapter: 'disco_elysium' }));
    const adapterPath = path.join(copied, 'adapters', 'disco_elysium', 'adapter.json');
    await fs.writeFile(adapterPath, JSON.stringify({ saveDirectory: 'C:/Users/fixture/SaveGames' }));
    const cases = [
      ['runtime', root, '0'],
      [root, root, '0'],
      [copied, root, '2'],
      [copied, root, '0'],
    ];
    for (const args of cases) {
      const { code, lines } = await runFixtureMain(args);
      assert.equal(code, 2, args.join(' '));
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.event, 'result');
      assert.equal(lines[0]!.status, 'refused');
      assert.equal(lines[0]!.pins, 'idle');
    }
    await assert.rejects(fs.stat(path.join(copied, 'runtime-data')), { code: 'ENOENT' });
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});
