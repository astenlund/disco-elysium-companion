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
import { containedEnvironment } from './support/contained-environment.ts';

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
  const { environment, remove } = await containedEnvironment(repository, 'release-go-broker-test-');
  let parent: Awaited<ReturnType<typeof readProcessIdentity>>;
  try { parent = await readProcessIdentity(process.pid, environment); } finally { await remove(); }
  assert.ok(parent);
  const broker = path.join(repository, 'runtime/native/go-broker.exe');
  const child = path.join(repository, 'runtime/test/fixtures/process-child.ts');
  // The last case leaves 1 MiB of input unread, which breaks the input pipe while the child exits.
  for (const [expected, unreadBytes] of [[0, 0], [1, 0], [7, 0], [1, 1_048_576]] as const) {
    const jobName = ['Global', `game-companion-process-${randomBytes(16).toString('hex')}-core`].join(path.win32.sep);
    const frame = JSON.stringify({ command: process.execPath, args: [child, 'exit', String(expected)], cwd: repository, jobName,
      parentPid: parent.pid, parentCreated: parent.created, brokerProtocolVersion: 2, childEnvironment: childEnvironment(process.env) });
    const spawned = spawn(broker, [], { cwd: repository, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    spawned.stdout.resume();
    spawned.stderr.resume();
    spawned.stdin.on('error', () => { /* The broker may exit before it takes all of the unread input. */ });
    spawned.stdin.end(Buffer.concat([Buffer.from(frame + String.fromCharCode(10)), Buffer.alloc(unreadBytes, 65)]));
    assert.equal(await new Promise<number | null>(resolve => spawned.once('close', resolve)), expected, `exit ${expected}, unread ${unreadBytes}`);
  }
});

test('observer source matches the same fixed release', async () => {
  const release = readCompiledImageRelease();
  assert.equal(release.observer.sources.length, 1);
  const source = release.observer.sources[0]!;
  const bytes = await fs.readFile(path.join(repository, source.path));
  assert.equal(normalizedGoSourceHash(bytes), source.sha256);
});
