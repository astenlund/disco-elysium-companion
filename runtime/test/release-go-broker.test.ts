import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readCompiledImageRelease } from '../src/compiled-image-release.ts';
import { normalizedGoSourceHash } from '../src/go-source.ts';
import { childEnvironment, readProcessIdentity } from '../src/process.ts';

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

test('the packaged broker exits with its child exit code', { timeout: 60000 }, async () => {
  const parent = await readProcessIdentity(process.pid);
  assert.ok(parent);
  const broker = path.join(repository, 'runtime/native/go-broker.exe');
  const child = path.join(repository, 'runtime/test/fixtures/process-child.ts');
  for (const expected of [0, 1, 7]) {
    const jobName = ['Global', `game-companion-process-${randomBytes(16).toString('hex')}-core`].join(path.win32.sep);
    const frame = JSON.stringify({ command: process.execPath, args: [child, 'exit', String(expected)], cwd: repository, jobName,
      parentPid: parent.pid, parentCreated: parent.created, brokerProtocolVersion: 2, childEnvironment: childEnvironment(process.env) });
    const spawned = spawn(broker, [], { cwd: repository, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    spawned.stdout.resume();
    spawned.stderr.resume();
    spawned.stdin.end(frame + String.fromCharCode(10));
    assert.equal(await new Promise<number | null>(resolve => spawned.once('close', resolve)), expected);
  }
});

test('observer source matches the same fixed release', async () => {
  const release = readCompiledImageRelease();
  assert.equal(release.observer.sources.length, 1);
  const source = release.observer.sources[0]!;
  const bytes = await fs.readFile(path.join(repository, source.path));
  assert.equal(normalizedGoSourceHash(bytes), source.sha256);
});
