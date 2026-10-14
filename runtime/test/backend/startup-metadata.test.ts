import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { DataRootUnavailableError } from '../../src/admission.ts';
import { Deadline } from '../../src/deadline.ts';
import { readFileHashes } from '../../src/file-hashes.ts';
import { SupervisorError, type CommandResult } from '../../src/process.ts';
import type { StartupMetadataSession } from '../../src/startup-metadata.ts';
import { companionFixture } from '../support/companion.ts';

const exclusiveScript = fileURLToPath(new URL('./fixtures/Exclusive-FileHandle.ps1', import.meta.url));
const resourceScript = fileURLToPath(new URL('../../scripts/resource-lifecycle/Get-ResourceInventory.ps1', import.meta.url));

function resourceObservation(backend: RuntimeBackend, mode: 'Inventory' | 'Marker'): Promise<CommandResult> {
  return backend.inspector.metadata(resourceScript, ['-Root', backend.scope.dataRoot, '-ScopeSha256', backend.scope.bindingSha256,
    '-CompanionRoot', backend.scope.companionRoot, '-Mode', mode], backend.scope.dataRoot);
}

test('startup worker freshly admits and hashes private files, then restores one-shot inspection', { timeout: 600000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  let stage = 'open';
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true });
    stage = 'active worker';
    await assert.rejects(backend.supervisor.verifyQuiescent('startupMetadata'), SupervisorError);
    stage = 'fresh inventory';
    const inventory = async (mode: 'Inventory' | 'Marker'): Promise<boolean> => {
      const reply = await resourceObservation(backend!, mode);
      assert.equal(reply.exitCode, 0);
      assert.equal(reply.stderr.length, 0);
      return (JSON.parse(reply.stdout.toString('utf8')) as { uncertainWorkspace: boolean }).uncertainWorkspace;
    };
    assert.equal(await inventory('Inventory'), false);
    assert.equal(await inventory('Marker'), false);
    await backend.supervisor.verifyQuiescent('metadata');
    const scopeBinding = path.join(backend.scope.dataRoot, 'scope.json');
    const exclusiveScope = await backend.supervisor.run('metadata', { command: 'pwsh',
      args: ['-NoProfile', '-File', exclusiveScript, '-Path', scopeBinding], cwd: fixture.root }, 30000);
    assert.equal(exclusiveScope.exitCode, 0);
    const linkedScope = path.join(fixture.root, '.tmp', 'scope-link.json');
    await fs.link(scopeBinding, linkedScope);
    try {
      const refused = await resourceObservation(backend, 'Inventory');
      assert.equal(refused.exitCode, 1);
    } finally { await fs.unlink(linkedScope); }
    assert.equal(await inventory('Inventory'), false);
    await assert.rejects(backend.inspector.metadata(resourceScript, ['-Root', backend.scope.dataRoot, '-ScopeSha256', '0'.repeat(64),
      '-CompanionRoot', backend.scope.companionRoot, '-Mode', 'Inventory'], backend.scope.dataRoot), DataRootUnavailableError);
    await assert.rejects(backend.supervisor.verifyQuiescent('startupMetadata'), SupervisorError);
    assert.equal(await inventory('Inventory'), false);
    const residue = path.join(backend.scope.dataRoot, 'codec.json');
    const aliasTarget = path.join(fixture.root, '.tmp', 'inventory-alias-target.json');
    await fs.writeFile(aliasTarget, '{}', { flag: 'wx' });
    await fs.symlink(aliasTarget, residue, 'file');
    try {
      const refused = await resourceObservation(backend, 'Inventory');
      assert.equal(refused.exitCode, 1);
    } finally { await fs.unlink(residue); await fs.unlink(aliasTarget); }
    assert.equal(await inventory('Inventory'), false);
    await fs.writeFile(residue, '{}', { flag: 'wx' });
    try {
      assert.equal(await inventory('Inventory'), true);
      assert.equal(await inventory('Marker'), false);
    } finally { await fs.unlink(residue); }
    assert.equal(await inventory('Inventory'), false);
    const sample = path.join(fixture.root, '.tmp', 'sample.json');
    stage = 'fresh admission';
    assert.equal((await backend.inspector.inspect(fixture.root, sample, true)).exists, false);
    await fs.writeFile(sample, '{"version":1}');
    const admitted = await backend.inspector.inspect(fixture.root, sample);
    assert.equal(admitted.kind, 'file');
    const [before] = await readFileHashes(backend.inspector, fixture.root, [sample], Deadline.after(30000));
    assert.match(before!, /^[a-f0-9]{64}$/);
    await fs.writeFile(sample, '{"version":2}');
    const [after] = await readFileHashes(backend.inspector, fixture.root, [sample], Deadline.after(30000));
    assert.match(after!, /^[a-f0-9]{64}$/);
    assert.notEqual(after, before);
    const linked = path.join(fixture.root, '.tmp', 'sample-link.json');
    await fs.link(sample, linked);
    await assert.rejects(backend.inspector.inspect(fixture.root, sample), DataRootUnavailableError);
    await fs.unlink(linked);
    assert.equal((await backend.inspector.inspect(fixture.root, sample)).kind, 'file');
    const reparse = path.join(fixture.root, '.tmp', 'sample-alias.json');
    await fs.symlink(sample, reparse, 'file');
    await assert.rejects(backend.inspector.inspect(fixture.root, reparse), DataRootUnavailableError);
    await fs.unlink(reparse);
    await fs.unlink(sample);
    assert.equal((await backend.inspector.inspect(fixture.root, sample, true)).exists, false);
    await backend.closeStartupMetadata();
    stage = 'one-shot after close';
    await backend.supervisor.verifyQuiescent('startupMetadata');
    assert.equal((await backend.inspector.inspect(fixture.root, path.join(fixture.root, 'runtime', 'companion.config.json'))).kind, 'file');
    await backend.shutdown(true);
    backend = null;
  } catch (error) {
    process.stdout.write(`# startup metadata fixture failed during ${stage}: ${(error as Error).message}\n`);
    throw error;
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});

test('an exited worker fails the next observation and permits one-shot work after verified stop', { timeout: 600000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  try {
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true });
    const target = path.join(fixture.root, 'runtime', 'companion.config.json');
    assert.equal((await backend.inspector.inspect(fixture.root, target)).kind, 'file');
    assert.equal((await resourceObservation(backend, 'Inventory')).exitCode, 0);
    await backend.supervisor.stop('startupMetadata');
    await assert.rejects(resourceObservation(backend, 'Inventory'), DataRootUnavailableError);
    assert.equal((await resourceObservation(backend, 'Inventory')).exitCode, 0);
    assert.equal((await backend.inspector.inspect(fixture.root, target)).kind, 'file');
    await backend.closeStartupMetadata();
    await backend.shutdown(true);
    backend = null;
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});

test('private non-owner startup stops its worker before clean shutdown', { timeout: 600000 }, async () => {
  const fixture = await companionFixture('runtime');
  let backend: RuntimeBackend | null = null;
  try {
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true });
    const startup = await backend.startup({ kind: 'chat' });
    assert.equal(startup.notOwner, true);
    await backend.closeStartupMetadata();
    await backend.supervisor.verifyQuiescent('startupMetadata');
    await backend.shutdown(true);
    backend = null;
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});

test('worker closes file handles and rechecks an in-flight target replacement', { timeout: 600000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  try {
    backend = await openBackend({ companionRoot: fixture.root, startupMetadata: true });
    const sample = path.join(fixture.root, '.tmp', 'moving.bin');
    const displaced = path.join(fixture.root, '.tmp', 'displaced.bin');
    const stopPath = path.join(fixture.root, '.tmp', 'release-exclusive-hold');
    await fs.writeFile(sample, 'original');
    assert.equal((await backend.inspector.inspect(fixture.root, sample)).kind, 'file');

    const holder = backend.supervisor.spawn('metadata', { command: 'pwsh', args: ['-NoProfile', '-File', exclusiveScript, '-Path', sample, '-Hold', '-StopPath', stopPath], cwd: fixture.root });
    try {
      await holder.ready;
      const lines = createInterface({ input: holder.stdout });
      let timer: NodeJS.Timeout | undefined;
      try {
        const ready = await Promise.race([lines[Symbol.asyncIterator]().next(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Exclusive holder did not start.')), 10000);
        })]);
        assert.equal(ready.value, 'ready');
      } finally { clearTimeout(timer); lines.close(); }
      await assert.rejects(readFileHashes(backend.inspector, fixture.root, [sample], Deadline.after(30000)), DataRootUnavailableError);
    } finally {
      await fs.writeFile(stopPath, 'stop');
      holder.stdin.end();
      await backend.supervisor.stop('metadata', 5000);
      await fs.unlink(stopPath);
    }
    assert.equal((await backend.inspector.inspect(fixture.root, sample)).kind, 'file');

    await fs.truncate(sample, 128 * 1024 * 1024);
    const [before] = await readFileHashes(backend.inspector, fixture.root, [sample], Deadline.after(30000));
    assert.match(before!, /^[a-f0-9]{64}$/);
    const exclusive = async (target: string): Promise<void> => {
      const result = await backend!.supervisor.run('metadata', { command: 'pwsh', args: ['-NoProfile', '-File', exclusiveScript, '-Path', target], cwd: fixture.root }, 30000);
      assert.equal(result.exitCode, 0);
    };
    await exclusive(sample);

    const session = (backend.inspector as unknown as { startupSession: StartupMetadataSession | null }).startupSession;
    assert.ok(session);
    const originalInvoke = session.invoke;
    let requestSent!: () => void;
    const sent = new Promise<void>(resolve => { requestSent = resolve; });
    session.invoke = (...args: Parameters<StartupMetadataSession['invoke']>) => {
      const pending = originalInvoke.call(session, ...args);
      requestSent();
      return pending;
    };
    let settled = false;
    const raced = readFileHashes(backend.inspector, fixture.root, [sample], Deadline.after(30000)).finally(() => { settled = true; });
    void raced.catch(() => undefined);
    try {
      await sent;
      assert.equal(settled, false);
      await fs.rename(sample, displaced);
      assert.equal(settled, false, 'The target was replaced while the worker request was pending.');
      await fs.writeFile(sample, 'replacement');
      let observed: string | null | undefined;
      try { [observed] = await raced; }
      catch (error) { assert.ok(error instanceof DataRootUnavailableError); }
      const [current] = await readFileHashes(backend.inspector, fixture.root, [sample], Deadline.after(30000));
      assert.match(current!, /^[a-f0-9]{64}$/);
      assert.notEqual(current, before);
      if (observed !== undefined) { assert.ok(observed === before || observed === current || observed === null); }
      await exclusive(sample);
      await exclusive(displaced);
    } finally { session.invoke = originalInvoke; }
    await backend.closeStartupMetadata();
    await backend.shutdown(true);
    backend = null;
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
