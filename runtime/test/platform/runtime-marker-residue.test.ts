import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError, type PathAdmission } from '../../src/admission.ts';
import { Deadline } from '../../src/deadline.ts';
import { jsonBudgets } from '../../src/json.ts';
import { cleanupRuntimeMarkerResidue, isPublicationResidue, type MarkerResidueIO } from '../../src/platform/publication-residue.ts';
import { SupervisorError } from '../../src/process.ts';
import { scopeComponents, type RuntimeScope } from '../../src/scope.ts';
import { bytesHash } from '../../src/storage.ts';

const tmp = 'runtime.json.' + '1'.repeat(32) + '.tmp';
const bak = 'runtime.json.' + '2'.repeat(32) + '.bak';

function fixture(names: readonly string[] = [tmp], withTarget = false) {
  const companionRoot = path.resolve('C:/private-marker-unit');
  const game = 'stubgame'; const principal = 'fixture-principal';
  const dataRoot = path.join(companionRoot, ...scopeComponents(game, principal));
  const binding = Buffer.from(JSON.stringify({ runtimeScopeVersion: 1, game, principal }));
  const scope: RuntimeScope = { companionRoot, dataRoot, game, principal, bindingSha256: bytesHash(binding), createdHere: false };
  const bytes = new Map<string, Buffer>();
  const admissions = new Map<string, PathAdmission>();
  const calls: string[] = []; const removed: string[] = []; const listed = ['scope.json', ...names, ...(withTarget ? ['runtime.json'] : [])];
  let serial = 0; let inspection = 0; let quiescence = 0;
  const guard = { held: true };
  const resolve = (name: string) => path.join(dataRoot, name);
  const put = (name: string, content: string | Buffer, kind: 'file' | 'directory' = 'file') => {
    const file = resolve(name);
    bytes.set(file, Buffer.from(content));
    admissions.set(file, { path: file, exists: true, kind, links: kind === 'file' ? 1 : 0, volume: 'a'.repeat(16), identity: (++serial).toString(16).padStart(32, '0'), missing: [] });
  };
  put('', '', 'directory'); put('scope.json', binding);
  for (const name of names) { put(name, 'partial publication bytes'); }
  if (withTarget) { put('runtime.json', 'complete target bytes'); }
  const control = { hook: (_event: string): void => {}, failScan: false, extraEntries: 0, failUnlink: false };
  const inspector = {
    async inspectMany(root: string, targets: readonly string[], allowMissing: boolean, timeout: number) {
      assert.equal(root, dataRoot); assert.equal(allowMissing, true); assert.ok(timeout > 0 && timeout <= 30000);
      control.hook('inspect:' + ++inspection);
      return targets.map(file => ({ ...(admissions.get(file) ?? { path: file, exists: false, kind: null, links: null, volume: null, identity: null, missing: [path.basename(file)] }) }));
    },
  };
  const supervisor = { async verifyQuiescentMany(roles: readonly string[]) {
    assert.deepEqual(roles, ['publication', 'startupMutation']);
    calls.push('batch');
    for (const role of roles) { calls.push(role); control.hook('quiescent:' + ++quiescence); }
  } };
  const io: MarkerResidueIO = {
    async *entries(directory) {
      assert.equal(directory, dataRoot); calls.push('scan');
      for (const name of listed) { control.hook('entry:' + name); yield name; }
      for (let i = 0; i < control.extraEntries; i++) { yield 'other-' + i; }
      if (control.failScan) { throw new Error('Directory enumeration failed.'); }
      calls.push('scan-complete');
    },
    async read(file, maxBytes) {
      assert.equal(maxBytes, jsonBudgets.config.maxBytes); control.hook('read:' + path.basename(file));
      const content = bytes.get(file); if (content === undefined) { throw Object.assign(new Error('Read failed.'), { code: 'EACCES' }); }
      return content;
    },
    async unlink(file) {
      assert.ok(calls.includes('scan-complete')); control.hook('unlink:' + path.basename(file));
      if (control.failUnlink) { throw Object.assign(new Error('Sharing refusal.'), { code: 'EPERM' }); }
      assert.equal(path.dirname(file), dataRoot); removed.push(path.basename(file)); admissions.delete(file); bytes.delete(file);
    },
  };
  const run = (deadline?: Deadline) => cleanupRuntimeMarkerResidue(scope, guard, inspector, supervisor, deadline, io);
  return { scope, guard, admissions, bytes, calls, removed, listed, control, resolve, put, run };
}

for (const [name, withTarget] of [[tmp, false], [bak, true], [tmp, true], [bak, false]] as const) {
  test('marker cleanup admits ' + path.extname(name) + ' with target ' + (withTarget ? 'present' : 'absent'), async () => {
    const f = fixture([name], withTarget); const prior = f.bytes.get(f.resolve('runtime.json'));
    assert.deepEqual(await f.run(), { removed: [name] });
    assert.equal(f.bytes.get(f.resolve('runtime.json')), prior);
    assert.equal(f.calls.filter(call => call === 'publication').length, 2);
    assert.equal(f.calls.filter(call => call === 'startupMutation').length, 2);
    assert.equal(f.calls.filter(call => call === 'batch').length, 2);
  });
}

test('marker cleanup verifies both writers before each selected deletion', async () => {
  const f = fixture([tmp, bak], true);
  assert.deepEqual(await f.run(), { removed: [tmp, bak] });
  assert.deepEqual(f.calls.filter(call => call === 'publication' || call === 'startupMutation'),
    ['publication', 'startupMutation', 'publication', 'startupMutation', 'publication', 'startupMutation']);
  assert.equal(f.calls.filter(call => call === 'batch').length, 3);
});

test('empty selection preserves near matches and other phase-D residue families', async () => {
  const names = ['Runtime.json.' + '1'.repeat(32) + '.tmp', 'runtime.json.' + 'A'.repeat(32) + '.bak', 'runtime.json.' + '1'.repeat(31) + '.tmp', tmp + '.other', 'runtime.json.foreign.tmp', 'state-safety.json.' + '1'.repeat(32) + '.tmp'];
  const f = fixture(names);
  assert.deepEqual(await f.run(), { removed: [] });
  for (const name of names) { assert.ok(f.bytes.has(f.resolve(name))); }
  assert.equal(isPublicationResidue(names.at(-1)!), true);
});

for (const defect of ['incomplete scan', 'discovery overflow', 'unbound scope', 'wrong scope hash', 'guard absent', 'target directory', 'selected directory', 'selected hardlink', 'physical admission refused', 'unreadable sibling', 'oversize sibling', 'unlink failed', 'deadline expired'] as const) {
  test('marker cleanup refuses ' + defect + ' without deleting selected files', async () => {
    const f = fixture([tmp, bak], true);
    if (defect === 'incomplete scan') { f.control.failScan = true; }
    if (defect === 'discovery overflow') { f.control.extraEntries = 65536; }
    if (defect === 'unbound scope') { f.admissions.delete(f.resolve('scope.json')); }
    if (defect === 'wrong scope hash') { f.bytes.set(f.resolve('scope.json'), Buffer.from('foreign scope')); }
    if (defect === 'guard absent') { f.guard.held = false; }
    if (defect === 'target directory') { f.put('runtime.json', '', 'directory'); }
    if (defect === 'selected directory') { f.put(bak, '', 'directory'); }
    if (defect === 'selected hardlink') { const file = f.resolve(bak); f.admissions.set(file, { ...f.admissions.get(file)!, links: 2 }); }
    if (defect === 'physical admission refused') { f.control.hook = event => { if (event === 'inspect:2') { throw new DataRootUnavailableError('Native foreign object refusal.'); } }; }
    if (defect === 'unreadable sibling') { f.bytes.delete(f.resolve(bak)); }
    if (defect === 'oversize sibling') { f.bytes.set(f.resolve(bak), Buffer.alloc(jsonBudgets.config.maxBytes + 1)); }
    if (defect === 'unlink failed') { f.control.failUnlink = true; }
    await assert.rejects(f.run(defect === 'deadline expired' ? Deadline.fromStart(0, 1, () => 1) : undefined), DataRootUnavailableError);
    assert.deepEqual(f.removed, []);
    assert.ok(f.admissions.has(f.resolve(tmp))); assert.ok(f.admissions.has(f.resolve(bak)));
  });
}

for (const defect of ['sibling lost', 'sibling identity', 'sibling bytes', 'target lost', 'target identity', 'target bytes', 'target appears', 'scope bytes', 'scope identity', 'root identity', 'guard lost'] as const) {
  test('marker cleanup refuses post-scan ' + defect, async () => {
    const f = fixture([tmp], defect !== 'target appears');
    f.control.hook = event => {
      if (event !== 'quiescent:4') { return; }
      if (defect === 'sibling lost') { f.admissions.delete(f.resolve(tmp)); }
      if (defect === 'sibling identity') { f.put(tmp, f.bytes.get(f.resolve(tmp))!); }
      if (defect === 'sibling bytes') { f.bytes.set(f.resolve(tmp), Buffer.from('changed')); }
      if (defect === 'target lost') { f.admissions.delete(f.resolve('runtime.json')); }
      if (defect === 'target identity' || defect === 'target appears') { f.put('runtime.json', 'complete target bytes'); }
      if (defect === 'target bytes') { f.bytes.set(f.resolve('runtime.json'), Buffer.from('changed')); }
      if (defect === 'scope bytes') { f.bytes.set(f.resolve('scope.json'), Buffer.from('changed')); }
      if (defect === 'scope identity') { f.put('scope.json', f.bytes.get(f.resolve('scope.json'))!); }
      if (defect === 'root identity') { f.put('', '', 'directory'); }
      if (defect === 'guard lost') { f.guard.held = false; }
    };
    await assert.rejects(f.run(), DataRootUnavailableError); assert.deepEqual(f.removed, []);
  });
}

for (const [stage, role] of [[1, 'publication'], [2, 'startupMutation'], [3, 'publication'], [4, 'startupMutation']] as const) {
  test(role + ' termination uncertainty remains typed at quiescence check ' + stage, async () => {
    const f = fixture(); const failure = new SupervisorError('termination-unverified', 'Fixture uncertainty.');
    f.control.hook = event => { if (event === 'quiescent:' + stage) { throw failure; } };
    await assert.rejects(f.run(), error => error === failure);
    assert.deepEqual(f.removed, []); assert.equal(f.guard.held, true);
  });
}

test('later deletion failure leaves remaining residue and complete target for the next fresh scan', async () => {
  const f = fixture([tmp, bak], true); const target = f.bytes.get(f.resolve('runtime.json'));
  f.control.hook = event => { if (event === 'unlink:' + bak) { throw new Error('Second unlink refused.'); } };
  await assert.rejects(f.run(), DataRootUnavailableError);
  assert.deepEqual(f.removed, [tmp]); assert.ok(f.bytes.has(f.resolve(bak))); assert.equal(f.bytes.get(f.resolve('runtime.json')), target);
  f.listed.splice(f.listed.indexOf(tmp), 1); f.control.hook = () => {};
  assert.deepEqual(await f.run(), { removed: [bak] });
});

test('same-byte replacement during final sibling read fails its physical identity fence', async () => {
  const f = fixture(); let reads = 0;
  f.control.hook = event => {
    if (event === 'read:' + tmp && ++reads === 2) { f.put(tmp, f.bytes.get(f.resolve(tmp))!); }
  };
  await assert.rejects(f.run(), DataRootUnavailableError); assert.deepEqual(f.removed, []);
});
