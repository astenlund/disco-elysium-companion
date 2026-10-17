import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError, type PathInspector } from '../src/admission.ts';
import { discoverScopeWithPrincipal, scopeComponents } from '../src/scope.ts';

const root = path.win32.join('C:', 'private', 'companion');
const game = 'disco_elysium';
const sid = 'S-1-5-21-1234-1002';
const candidate = path.win32.join(root, ...scopeComponents(game, sid));
const admission = (target: string) => ({ path: target, exists: true, kind: 'directory', links: 1,
  volume: 'a'.repeat(16), identity: 'b'.repeat(32), missing: [] });
const reply = (value: unknown) => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });

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
