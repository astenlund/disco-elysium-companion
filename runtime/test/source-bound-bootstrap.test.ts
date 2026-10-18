import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PathInspector } from '../src/admission.ts';
import { scopeComponents } from '../src/scope.ts';
import { observeSourceBoundBootstrap } from '../src/source-bound-bootstrap.ts';

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

test('selected bootstrap refuses invalid parent identity before possible transfer', async () => {
  let transferred = false;
  const inspector = { metadataStdinExpression: async () => { throw new Error('Helper must not launch.'); } } as unknown as PathInspector;
  await assert.rejects(observeSourceBoundBootstrap(inspector, { pid: 0, created: parent.created }, companionRoot,
    game, imageRoot, {}, () => { transferred = true; }));
  assert.equal(transferred, false);
});
