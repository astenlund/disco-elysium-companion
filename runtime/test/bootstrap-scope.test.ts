import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import { parseStrictJson } from '../src/json.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import { discoverScopeWithPrincipal, parseCombinedScopeReply, scopeComponents } from '../src/scope.ts';

const root = path.win32.join('C:', 'private', 'companion');
const game = 'disco_elysium';
const sid = 'S-1-5-21-1234-1002';
const candidate = path.win32.join(root, ...scopeComponents(game, sid));
const admission = (target: string) => ({ path: target, exists: true, kind: 'directory', links: 1,
  volume: 'a'.repeat(16), identity: 'b'.repeat(32), missing: [] });
const reply = (value: unknown) => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });
const installation = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const execute = promisify(execFile);

test('a refused bootstrap names the innermost cause in one bounded line', async () => {
  const script = path.win32.join(installation, 'runtime', 'scripts', 'Get-BootstrapScope.ps1');
  await assert.rejects(execute('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-Root', 'relative', '-Game', game],
    { windowsHide: true, timeout: 120000 }), (error: { code?: unknown; stdout?: string; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr?.trim(), 'Get-BootstrapScope: bootstrap-unavailable: IOException: A local drive-qualified path is required.');
    return true;
  });
});


test('combined bootstrap binds the current principal to exact root and scope admissions', async () => {
  const calls: unknown[][] = [];
  const inspector = { metadata: async (...args: unknown[]) => {
    calls.push(args);
    return reply({ sid, paths: [admission(root), admission(candidate)] });
  } } as unknown as PathInspector;
  assert.deepEqual(await discoverScopeWithPrincipal(inspector, root, game),
    { companionRoot: root, dataRoot: candidate, game, principal: sid });
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0]![0] as string), 'Get-BootstrapScope.ps1');
  assert.deepEqual(calls[0]!.slice(1), [['-Root', root, '-Game', game], root]);
});

test('combined bootstrap refuses partial, foreign, and unsuccessful observations without fallback', async () => {
  const valid = { sid, paths: [admission(root), admission(candidate)] };
  for (const result of [
    reply({ ...valid, extra: true }),
    reply({ ...valid, sid: '' }),
    reply({ ...valid, paths: [admission(root)] }),
    reply({ ...valid, paths: [admission(root), admission(path.win32.join(root, 'foreign'))] }),
    reply({ ...valid, paths: [{ ...admission(root), kind: 'file' }, admission(candidate)] }),
    { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
  ]) {
    let calls = 0;
    const inspector = { metadata: async () => { calls += 1; return result; } } as unknown as PathInspector;
    await assert.rejects(discoverScopeWithPrincipal(inspector, root, game), DataRootUnavailableError);
    assert.equal(calls, 1);
  }
});

test('selected bootstrap adds one pin receipt without changing scope admission', () => {
  const pins = { status: 'absent' };
  const value = { sid, paths: [admission(root), admission(candidate)], imagePins: pins };
  const selected = parseStrictJson(Buffer.from(JSON.stringify(value)));
  const result = parseCombinedScopeReply(selected, root, game, true);
  assert.deepEqual(result.candidate, { companionRoot: root, dataRoot: candidate, game, principal: sid });
  assert.equal((result.imagePins as { status: string }).status, 'absent');
  assert.throws(() => parseCombinedScopeReply(selected, root, game, false), DataRootUnavailableError);
  assert.throws(() => parseCombinedScopeReply(parseStrictJson(Buffer.from(JSON.stringify({ ...value, imagePins: undefined }))),
    root, game, true), DataRootUnavailableError);
});

test('in-memory bootstrap transport sends one bounded expression through the supervised metadata role', async () => {
  const calls: unknown[][] = [];
  const supervisor = { run: async (...args: unknown[]) => {
    calls.push(args);
    return reply({ sid, paths: [admission(root), admission(candidate)] });
  } } as unknown as ProcessSupervisor;
  const inspector = new PathInspector(supervisor);
  const expression = Buffer.from([38, 32, 49, 10]);
  const environment = { TEMP: 'C:/private/temp' };
  const pending = inspector.metadataStdinExpression(expression, root, environment);
  expression[0] = 65;
  environment.TEMP = 'C:/private/changed';
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'metadata');
  const options = calls[0]![1] as { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
  assert.equal(options.command, 'pwsh');
  assert.deepEqual(options.args, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-']);
  assert.equal(options.cwd, root);
  assert.equal(options.env.TEMP, 'C:/private/temp');
  assert.ok(typeof calls[0]![2] === 'number' && (calls[0]![2] as number) > 0 && (calls[0]![2] as number) <= 30000);
  assert.deepEqual(calls[0]![3], Buffer.from([38, 32, 49, 10]));
  for (const invalid of [Buffer.alloc(0), Buffer.from([38, 32, 49]), Buffer.from([38, 10, 49, 10]),
    Buffer.from([38, 0, 10]), Buffer.alloc(1_048_577, 65)]) {
    await assert.rejects(inspector.metadataStdinExpression(invalid, root, environment), DataRootUnavailableError);
  }
  assert.equal(calls.length, 1);
});
