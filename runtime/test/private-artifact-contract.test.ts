import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { admitPrivateDirectory, brokerEnvironment, pinPrivateFile, verifyPinnedPrivateFile } from '../src/compiled-broker.ts';
import { childEnvironment, nativeObserverEnvironment, SupervisorError } from '../src/process.ts';
import { chatBackendOptions } from '../src/runtime.ts';
import { privateCompiledProcessBroker, privateNativeStartupJobs } from '../src/backend/index.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('private artifact admission requires a repo-bound ordinary file and directory', async () => {
  const scratch = path.join(repository, '.tmp', `artifact-contract-${randomUUID()}`);
  assert.ok(path.relative(repository, scratch).startsWith('.tmp' + path.sep));
  await fs.mkdir(scratch, { recursive: true });
  const ordinary = path.join(scratch, 'ordinary.txt');
  const alias = path.join(scratch, 'alias.txt');
  const junction = path.join(scratch, 'junction');
  await fs.writeFile(ordinary, 'private contract\r\n', { flag: 'wx' });
  const hash = createHash('sha256').update(await fs.readFile(ordinary)).digest('hex');
  try {
    admitPrivateDirectory(scratch);
    const pinned = pinPrivateFile(ordinary, hash);
    try { verifyPinnedPrivateFile(pinned); }
    finally { closeSync(pinned.descriptor); }
    assert.throws(() => pinPrivateFile(path.resolve(repository, '..', 'outside.txt'), hash));
    assert.throws(() => admitPrivateDirectory(path.resolve(repository, '..')));
    await fs.link(ordinary, alias);
    assert.throws(() => pinPrivateFile(ordinary, hash));
    await fs.unlink(alias);
    await fs.symlink(scratch, junction, 'junction');
    assert.throws(() => admitPrivateDirectory(junction));
    assert.throws(() => pinPrivateFile(path.join(junction, 'ordinary.txt'), hash));
  } finally {
    assert.ok(path.relative(repository, scratch).startsWith('.tmp' + path.sep));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('v2 child environment preserves empty values and refuses hidden drive keys', () => {
  const environment: NodeJS.ProcessEnv = { TEMP: 'private', EMPTY: '', Path: 'kept', PATH: 'shadow' };
  const frozen = childEnvironment(environment);
  assert.equal(frozen.EMPTY, '');
  assert.equal(Object.keys(frozen).filter(name => name.toUpperCase() === 'PATH').length, 1);
  assert.equal(frozen.PATH, 'shadow');
  assert.throws(() => childEnvironment({ '=C:': 'external' }),
    error => error instanceof SupervisorError && error.reason === 'result-invalid');
  assert.throws(() => childEnvironment({ 'BAD=KEY': 'value' }), SupervisorError);
  assert.throws(() => childEnvironment({ BAD: 'value' + String.fromCharCode(0) }), SupervisorError);
});

test('private helper environments omit HOME while the child snapshot preserves it', () => {
  const scratch = path.join(repository, '.tmp', 'broker-environment-fixture');
  const options = { command: 'fixture', args: [], cwd: repository, env: { EMPTY: '', HOME: 'inherited-home' } };
  const child = childEnvironment(options.env);
  const broker = brokerEnvironment(options, scratch);
  assert.equal(child.HOME, 'inherited-home');
  assert.equal(child.EMPTY, '');
  assert.equal(Object.hasOwn(broker, 'HOME'), false);
  assert.equal(Object.hasOwn(nativeObserverEnvironment(scratch, options.env), 'HOME'), false);
  assert.equal(broker.USERPROFILE, scratch);
  assert.equal(broker.APPDATA, scratch);
  const absent = brokerEnvironment({ ...options, env: { EMPTY: '' } }, scratch);
  assert.equal(Object.hasOwn(absent, 'HOME'), false);
  assert.equal(Object.hasOwn(childEnvironment({ EMPTY: '' }), 'HOME'), false);
  assert.equal(Object.hasOwn(nativeObserverEnvironment(scratch, { EMPTY: '' }), 'HOME'), false);
  const differentlyCased = { home: 'lower-home', HoMe: 'mixed-home' };
  assert.deepEqual(Object.keys(brokerEnvironment({ ...options, env: differentlyCased }, scratch)).filter(name => name.toUpperCase() === 'HOME'), []);
  assert.deepEqual(Object.keys(nativeObserverEnvironment(scratch, differentlyCased)).filter(name => name.toUpperCase() === 'HOME'), []);
  assert.equal(childEnvironment({ home: 'lower-home' }).home, 'lower-home');
});

test('private selectors stay off the default and pre-guard chat options', () => {
  const native = { binary: 'private', source: 'private', manifest: 'private', scratch: 'private',
    binarySha256: '0'.repeat(64), sourceSha256: '0'.repeat(64), manifestSha256: '0'.repeat(64) };
  const broker = { directory: 'private', scratch: 'private', hashes: {}, sources: {} } as never;
  const ordinary = chatBackendOptions(repository, () => {}, () => {}, undefined, false, broker, native);
  assert.equal(ordinary[privateCompiledProcessBroker], undefined);
  assert.equal(ordinary[privateNativeStartupJobs], undefined);
  const selected = chatBackendOptions(repository, () => {}, () => {}, undefined, true, broker, native);
  assert.equal(selected[privateCompiledProcessBroker], broker);
  assert.equal(selected[privateNativeStartupJobs], native);
});
