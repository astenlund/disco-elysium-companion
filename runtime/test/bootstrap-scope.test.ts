import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DataRootUnavailableError, frozenStdinExpression, PathInspector, stdinExpressionCommand } from '../src/admission.ts';
import { parseStrictJson } from '../src/json.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import { discoverScopeWithPrincipal, parseCombinedScopeReply, scopeComponents } from '../src/scope.ts';
import { containedEnvironment } from './support/contained-environment.ts';

const root = path.win32.join('C:', 'private', 'companion');
const game = 'disco_elysium';
const sid = 'S-1-5-21-1234-1002';
const candidate = path.win32.join(root, ...scopeComponents(game, sid));
const admission = (target: string) => ({ path: target, exists: true, kind: 'directory', links: 1,
  volume: 'a'.repeat(16), identity: 'b'.repeat(32), missing: [] });
const reply = (value: unknown) => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });
const installation = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const execute = promisify(execFile);
const capturedSources = ['runtime/scripts/Get-BootstrapScope.ps1', 'runtime/scripts/NativeFiles.cs', 'runtime/scripts/NativeImagePins.cs',
  'runtime/scripts/BootstrapImagePins.ps1', 'runtime/scripts/BootstrapImagePackage.ps1'];

test('a refused bootstrap names the innermost cause in one bounded line', async () => {
  const script = path.win32.join(installation, 'runtime', 'scripts', 'Get-BootstrapScope.ps1');
  const { environment, remove } = await containedEnvironment(installation, 'bootstrap-scope-test-');
  try {
    await assert.rejects(execute('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-Root', 'relative', '-Game', game],
      { env: environment, windowsHide: true, timeout: 120000 }), (error: { code?: unknown; stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr?.trim(), 'Get-BootstrapScope: bootstrap-unavailable: IOException: A local drive-qualified path is required.');
      return true;
    });
  } finally {
    await remove();
  }
});

test('captured bootstrap sources check out with pinned CRLF endings so their fixed hashes hold on any clone', async () => {
  const { stdout } = await execute('git', ['-C', installation, 'check-attr', 'eol', '--', ...capturedSources], { windowsHide: true });
  assert.deepEqual(stdout.trim().split(String.fromCharCode(10)).map(line => line.trim()), capturedSources.map(name => `${name}: eol: crlf`));
  for (const name of capturedSources) {
    const bytes = await fs.readFile(path.win32.join(installation, name));
    assert.ok(bytes.includes(10), `${name} has no line endings.`);
    assert.equal(bytes.findIndex((byte, index) => byte === 10 && bytes[index - 1] !== 13), -1, `${name} has a line feed without a carriage return.`);
  }
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

test('the in-memory transport refuses a forged token before any helper starts', async () => {
  let runs = 0;
  const supervisor = { run: async () => { runs += 1; return reply({ sid, paths: [admission(root), admission(candidate)] }); } } as unknown as ProcessSupervisor;
  const inspector = new PathInspector(supervisor);
  await assert.rejects(inspector.metadataStdinExpression(Symbol('forged'), Buffer.from([38, 32, 49, 10]), root, {}),
    /Compiled image transfer requires direct CLI main/);
  await assert.rejects(inspector.metadataStdinExpression(undefined, Buffer.from([38, 32, 49, 10]), root, {}),
    /Compiled image transfer requires direct CLI main/);
  assert.equal(runs, 0);
});

test('the in-memory expression and its command are copied and bounded before any send', () => {
  const expression = Buffer.from([38, 32, 49, 10]);
  const frozen = frozenStdinExpression(expression);
  expression[0] = 65;
  assert.deepEqual(frozen, Buffer.from([38, 32, 49, 10]));
  for (const invalid of [Buffer.alloc(0), Buffer.from([38, 32, 49]), Buffer.from([38, 10, 49, 10]),
    Buffer.from([38, 0, 10]), Buffer.alloc(1_048_577, 65)]) {
    assert.equal(frozenStdinExpression(invalid), null);
  }
  const environment = { TEMP: 'C:/private/temp' };
  const command = stdinExpressionCommand(root, environment);
  environment.TEMP = 'C:/private/changed';
  assert.equal(command.command, 'pwsh');
  assert.deepEqual(command.args, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-']);
  assert.equal(command.cwd, root);
  assert.equal(command.env?.TEMP, 'C:/private/temp');
});
