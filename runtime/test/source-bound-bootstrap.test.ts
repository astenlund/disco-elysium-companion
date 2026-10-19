import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from '../src/admission.ts';
import { SupervisorError } from '../src/process.ts';
import { scopeComponents } from '../src/scope.ts';
import { helperFailureDetail, observeSourceBoundBootstrap, SourceBoundBootstrapError } from '../src/source-bound-bootstrap.ts';

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

test('selected bootstrap captures fixed source and accepts only the exact stopped absent reply', async () => {
  let transferred = false;
  const expressions: Buffer[] = [];
  const inspector = { metadataStdinExpression: async (value: Uint8Array, cwd: string, environment: NodeJS.ProcessEnv) => {
    assert.equal(transferred, true);
    assert.equal(cwd, companionRoot);
    assert.equal(environment.TEMP, imageRoot);
    expressions.push(Buffer.from(value));
    return reply({ status: 'absent' });
  } } as unknown as PathInspector;
  const result = await observeSourceBoundBootstrap(inspector, parent, companionRoot, game, imageRoot,
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
  await assert.rejects(observeSourceBoundBootstrap(inspector, parent, companionRoot, game, imageRoot,
    { TEMP: imageRoot }, () => { transferred = true; }));
  assert.equal(transferred, true);
});

test('helper faults after the transfer mark refuse without settling the pin obligation', async () => {
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
    await assert.rejects(observeSourceBoundBootstrap(inspector, parent, companionRoot, game, imageRoot, { TEMP: imageRoot },
      () => { transferred = true; }), Error, name);
    assert.equal(transferred, true, name);
  }
});

test('a failed helper reports a bounded printable reason without changing the player-facing message', async () => {
  let transferred = false;
  const stderr = Buffer.concat([Buffer.from([27, 91, 51, 49, 109]), Buffer.from('Image pin release is incomplete or invalid.'),
    Buffer.from([13, 10, 0, 200]), Buffer.from('x'.repeat(400))]);
  const inspector = { metadataStdinExpression: async () => ({ exitCode: 1, stderr, stdout: Buffer.alloc(0) }) } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(inspector, parent, companionRoot, game, imageRoot, { TEMP: imageRoot },
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
  await assert.rejects(observeSourceBoundBootstrap(inspector, { pid: 0, created: parent.created }, companionRoot,
    game, imageRoot, {}, () => { transferred = true; }));
  assert.equal(transferred, false);
});

test('selected bootstrap rejects trailing-separator scope spelling before transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(inspector, parent, `${companionRoot}${path.win32.sep}`,
    game, imageRoot, {}, () => { transferred = true; }));
  assert.equal(transferred, false);
});
