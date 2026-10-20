import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, stdinExpressionCommand, type PathInspector } from '../src/admission.ts';
import type { ImagePinRequest } from '../src/bootstrap-image-receipt.ts';
import { readProcessIdentity, SupervisorError } from '../src/process.ts';
import { scopeComponents } from '../src/scope.ts';
import { helperFailureDetail, observeSourceBoundBootstrap, SourceBoundBootstrapError } from '../src/source-bound-bootstrap.ts';
import { capturedBootstrapSources, readyImagePinReceipt } from './support/bootstrap-fixtures.ts';
import { containedEnvironment } from './support/contained-environment.ts';

const companionRoot = path.win32.join('C:', 'private', 'companion');
const imageRoot = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const game = 'disco_elysium';
const sid = 'S-1-5-21-1234-1002';
const candidate = path.win32.join(companionRoot, ...scopeComponents(game, sid));
const admitted = (location: string) => ({ path: location, exists: true, kind: 'directory', links: 1,
  volume: 'a'.repeat(16), identity: 'b'.repeat(32), missing: [] });
const reply = (imagePins: unknown) => ({ exitCode: 0, stderr: Buffer.alloc(0),
  stdout: Buffer.from(JSON.stringify({ sid, paths: [admitted(companionRoot), admitted(candidate)], imagePins })) });
const parent = { pid: 1234, created: '1234567890123456789' };
const childFixture = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));
const token = Symbol('selected');

// A damaged image root must sit inside the installation, so copies go to its own scratch.
async function imageRootCopy(): Promise<string> {
  const copy = await fs.mkdtemp(path.win32.join(imageRoot, '.tmp', 'source-bound-bootstrap-'));
  await fs.mkdir(path.win32.join(copy, 'runtime/scripts'), { recursive: true });
  for (const relative of capturedBootstrapSources) { await fs.copyFile(path.win32.join(imageRoot, relative), path.win32.join(copy, relative)); }

  return copy;
}

async function removeImageRootCopy(copy: string): Promise<void> {
  assert.equal(path.win32.dirname(copy), path.win32.join(imageRoot, '.tmp'));
  await fs.rm(copy, { recursive: true, force: true });
}

// The request is the fourth base64 argument after the decoded package script.
function requestArgument(expression: Uint8Array): string {
  const argument = Buffer.from(expression).toString('ascii').trim().split(' ').slice(2)[3];
  assert.ok(argument !== undefined);

  return argument.slice(1, -1);
}

test('selected bootstrap captures fixed source and accepts the exact absent reply', async () => {
  let transferred = false;
  const expressions: Buffer[] = [];
  const inspector = { metadataStdinExpression: async (received: unknown, value: Uint8Array, cwd: string, environment: NodeJS.ProcessEnv) => {
    assert.equal(received, token);
    assert.equal(transferred, true);
    assert.equal(cwd, companionRoot);
    assert.equal(environment.TEMP, imageRoot);
    expressions.push(Buffer.from(value));
    return reply({ status: 'absent' });
  } } as unknown as PathInspector;
  const result = await observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, imageRoot,
    { TEMP: imageRoot }, () => { transferred = true; });
  assert.equal(result.candidate.dataRoot, candidate);
  assert.deepEqual(result.imagePins, { status: 'absent' });
  assert.equal(result.request.targetProcessId, parent.pid);
  assert.equal(result.request.targetCreated, parent.created);
  assert.equal(result.request.brokerPath, path.win32.join(imageRoot, 'runtime/native/go-broker.exe'));
  const expression = expressions[0];
  assert.ok(expression !== undefined && expression.byteLength < 1_048_576);
  assert.match(expression.toString('ascii'), /^& \(\[ScriptBlock\]::Create\(.+\)\) '[A-Za-z0-9+/=]+' /);
  assert.equal(expression[expression.length - 1], 10);
  assert.ok(expression.subarray(0, -1).every(byte => byte >= 32 && byte <= 126));
});

test('selected bootstrap rejects a malformed reply after marking possible remote transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => reply({ status: 'ready' }) } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, imageRoot,
    { TEMP: imageRoot }, () => { transferred = true; }), (error: unknown) => {
    assert.ok(error instanceof SourceBoundBootstrapError);
    assert.equal(error.reason, 'replyInvalid');
    assert.equal(error.code, 'dataRootUnavailable');
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(transferred, true);
});

test('helper faults are refused after the possible transfer was marked', async () => {
  const empty = Buffer.alloc(0);
  const faults: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['late reply', async () => { throw new DataRootUnavailableError('Metadata deadline expired.'); }],
    ['job-stop uncertainty', async () => { throw new SupervisorError('termination-unverified', 'Process-tree termination is unverified.'); }],
    ['no receipt', async () => ({ exitCode: 0, stderr: empty, stdout: empty })],
    ['truncated receipt', async () => ({ exitCode: 0, stderr: empty, stdout: Buffer.from('{"sid":"') })],
  ];
  for (const [name, fault] of faults) {
    let transferred = false;
    const inspector = { metadataStdinExpression: fault } as unknown as PathInspector;
    await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, imageRoot, { TEMP: imageRoot },
      () => { transferred = true; }), Error, name);
    assert.equal(transferred, true, name);
  }
});

test('a failed helper reports a bounded printable reason without changing the player-facing message', async () => {
  let transferred = false;
  const stderr = Buffer.concat([Buffer.from([27, 91, 51, 49, 109]), Buffer.from('Image pin release is incomplete or invalid.'),
    Buffer.from([13, 10, 0, 200]), Buffer.from('x'.repeat(400))]);
  const inspector = { metadataStdinExpression: async () => ({ exitCode: 1, stderr, stdout: Buffer.alloc(0) }) } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, imageRoot, { TEMP: imageRoot },
    () => { transferred = true; }), (error: unknown) => {
    assert.ok(error instanceof SourceBoundBootstrapError);
    assert.equal(error.message, 'Source-bound bootstrap is unavailable.');
    assert.equal(error.reason, 'helperFailed');
    assert.ok(error.detail !== null && error.detail.startsWith('exit=1; '));
    assert.ok(error.detail.length <= 'exit=1; '.length + 240);
    assert.ok([...error.detail].every(character => character >= ' ' && character <= '~'));
    return true;
  });
  assert.equal(transferred, true);
  assert.equal(helperFailureDetail(null, Buffer.alloc(0)), 'exit=none');
  assert.match(helperFailureDetail(1, Buffer.from('Image pin release generation changed.')), /^exit=1; Image pin release generation changed\.$/);
});

test('selected bootstrap refuses invalid parent identity before possible transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(token, inspector, { pid: 0, created: parent.created }, companionRoot,
    game, imageRoot, {}, () => { transferred = true; }));
  assert.equal(transferred, false);
});

test('selected bootstrap refuses an image root outside the installation before transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, path.win32.join('C:', 'private', 'foreign'),
    {}, () => { transferred = true; }), (error: unknown) => error instanceof SourceBoundBootstrapError && error.reason === 'invalidInputs');
  assert.equal(transferred, false);
});

test('a changed or missing captured source is refused before transfer', async () => {
  const copy = await imageRootCopy();
  try {
    let transferred = false;
    const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
    const refusal = (relative: string) => (error: unknown) => error instanceof SourceBoundBootstrapError && error.reason === 'sourceChanged'
      && error.detail === relative;
    await fs.appendFile(path.win32.join(copy, capturedBootstrapSources[0]), '# changed');
    await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, copy, {}, () => { transferred = true; }),
      refusal(capturedBootstrapSources[0]));
    await fs.copyFile(path.win32.join(imageRoot, capturedBootstrapSources[0]), path.win32.join(copy, capturedBootstrapSources[0]));
    await fs.rm(path.win32.join(copy, capturedBootstrapSources[1]));
    await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, copy, {}, () => { transferred = true; }),
      refusal(capturedBootstrapSources[1]));
    assert.equal(transferred, false);
  } finally { await removeImageRootCopy(copy); }
});

test('an oversized bootstrap expression is refused before transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, companionRoot, 'x'.repeat(800_000), imageRoot, {},
    () => { transferred = true; }), (error: unknown) => error instanceof SourceBoundBootstrapError && error.reason === 'expressionTooLarge');
  assert.equal(transferred, false);
});

test('a ready receipt is refused when the packaged release is missing or does not match the pinned images', async () => {
  const copy = await imageRootCopy();
  try {
    const inspector = { metadataStdinExpression: async (_token: unknown, expression: Uint8Array) => {
      const request = JSON.parse(Buffer.from(requestArgument(expression), 'base64').toString('utf8')) as ImagePinRequest;
      return reply(readyImagePinReceipt(request, candidate));
    } } as unknown as PathInspector;
    const observe = () => observeSourceBoundBootstrap(token, inspector, parent, companionRoot, game, copy, {}, () => {});
    const refusal = (error: unknown) => error instanceof SourceBoundBootstrapError && error.reason === 'releaseMismatch' && error.detail !== null;
    await assert.rejects(observe(), refusal);
    const release = JSON.parse(await fs.readFile(path.win32.join(imageRoot, 'runtime/native/compiled-images.json'), 'utf8'));
    release.broker.sha256 = 'f'.repeat(64);
    await fs.mkdir(path.win32.join(copy, 'runtime/native'));
    await fs.writeFile(path.win32.join(copy, 'runtime/native/compiled-images.json'), JSON.stringify(release, null, 2) + String.fromCharCode(10));
    await assert.rejects(observe(), refusal);
  } finally { await removeImageRootCopy(copy); }
});

// Runs the expression the bootstrap built exactly as the in-memory metadata transport launches it, without the supervisor.
async function runExpression(expression: Uint8Array, cwd: string, environment: NodeJS.ProcessEnv) {
  const command = stdinExpressionCommand(cwd, environment);
  const child = spawn(command.command, [...command.args], { cwd: command.cwd, env: command.env, windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
  child.stdin.end(Buffer.from(expression));
  const exitCode = await new Promise<number | null>(resolve => child.once('close', resolve));

  return { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

test('the real pin helper returns a ready receipt the parser accepts and pins both images in its target', { timeout: 120000 }, async () => {
  const copy = await imageRootCopy();
  const companion = await fs.mkdtemp(path.win32.join(imageRoot, '.tmp', 'source-bound-companion-'));
  const { environment, remove } = await containedEnvironment(imageRoot, 'source-bound-pins-');
  const target = spawn(process.execPath, [childFixture, 'wait'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise<void>(resolve => target.once('exit', () => resolve()));
  try {
    await fs.mkdir(path.win32.join(copy, 'runtime/native'));
    for (const name of ['go-broker.exe', 'job-observer.exe', 'compiled-images.json']) {
      await fs.copyFile(path.win32.join(imageRoot, 'runtime/native', name), path.win32.join(copy, 'runtime/native', name));
    }
    const identity = await readProcessIdentity(target.pid!, environment);
    assert.ok(identity !== null);
    const inspector = { metadataStdinExpression: async (_received: unknown, expression: Uint8Array, cwd: string, received: NodeJS.ProcessEnv) =>
      runExpression(expression, cwd, received) } as unknown as PathInspector;
    const result = await observeSourceBoundBootstrap(token, inspector, identity, companion, game, copy, environment, () => {});
    assert.equal(result.imagePins.status, 'ready');
    if (result.imagePins.status === 'ready') {
      assert.deepEqual(result.imagePins.handles.slice(-2).map(entry => entry.path),
        ['go-broker.exe', 'job-observer.exe'].map(name => path.win32.join(copy, 'runtime', 'native', name)));
    }
    for (const name of ['go-broker.exe', 'job-observer.exe']) {
      await assert.rejects(fs.open(path.win32.join(copy, 'runtime', 'native', name), 'r+'), { code: 'EBUSY' }, name);
    }
  } finally {
    target.kill();
    await exited;
    await removeImageRootCopy(copy);
    assert.equal(path.win32.dirname(companion), path.win32.join(imageRoot, '.tmp'));
    await fs.rm(companion, { recursive: true, force: true });
    await remove();
  }
});

test('selected bootstrap rejects trailing-separator scope spelling before transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(token, inspector, parent, `${companionRoot}${path.win32.sep}`,
    game, imageRoot, {}, () => { transferred = true; }));
  assert.equal(transferred, false);
});
