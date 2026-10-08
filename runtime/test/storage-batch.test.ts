import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import { ControlDocumentError } from '../src/control-values.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { readFileHashes } from '../src/file-hashes.ts';
import type { FilePublisher } from '../src/files.ts';
import { asInteger, jsonBudgets, parseStrictJson, stringifyJson } from '../src/json.ts';
import { ProcessSupervisor } from '../src/process.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { bytesHash, ScopeStorage, StorageConflictError } from '../src/storage.ts';
import { companionFixture } from './support/companion.ts';

describe('bounded file-hash protocol', () => {
  it('splits long paths by decoded-text budget and rejects uncorrelated or oversized replies', async () => {
    const root = path.resolve('hash-protocol-fixture');
    const paths = Array.from({ length: 512 }, (_, index) => path.join(root, 'p'.repeat(2048), String(index)));
    const inspector = new PathInspector({} as ProcessSupervisor);
    const batches: number[] = [];
    let fault = '';
    inspector.metadata = async (_script, args, _cwd, _timeout, input) => {
      assert.deepEqual(args, ['-Root', root]);
      assert.ok(input);
      assert.ok(input.byteLength <= jsonBudgets.config.maxBytes);
      const targets = parseStrictJson(input);
      assert.ok(Array.isArray(targets));
      batches.push(targets.length);
      const value = { requestSha256: fault === 'correlation' ? '0'.repeat(64) : bytesHash(input), sha256: targets.map(() => '1'.repeat(64)) };
      const stdout = fault === 'overflow' ? Buffer.alloc(65537, 32) : Buffer.from(stringifyJson(value));
      return { exitCode: 0, stdout, stderr: Buffer.alloc(0) };
    };
    assert.equal((await readFileHashes(inspector, root, paths, Deadline.after(30000))).length, 512);
    assert.ok(batches.length > 1);
    assert.equal(batches.reduce((sum, size) => sum + size, 0), 512);
    for (const failure of ['correlation', 'overflow']) {
      fault = failure;
      await assert.rejects(readFileHashes(inspector, root, paths, Deadline.after(30000)), DataRootUnavailableError);
    }
  });

  it('keeps queue delay and all batches inside the original deadline', async () => {
    const inspector = new PathInspector({} as ProcessSupervisor);
    let now = 0;
    let calls = 0;
    inspector.metadata = async (_script, _args, _cwd, timeout, input) => {
      assert.equal(timeout, calls === 0 ? 100 : 40);
      calls++;
      now += 60;
      assert.ok(input);
      const targets = parseStrictJson(input);
      assert.ok(Array.isArray(targets));
      return { exitCode: 0, stdout: Buffer.from(stringifyJson({ requestSha256: bytesHash(input), sha256: targets.map(() => null) })), stderr: Buffer.alloc(0) };
    };
    await assert.rejects(readFileHashes(inspector, path.resolve('fixture'), Array.from({ length: 1025 }, (_, index) => String(index)), Deadline.after(100, () => now)), DeadlineExceededError);
    assert.equal(calls, 2);
  });
});

describe('native storage batch admission', () => {
  it('reads many controls without writes and preserves exact invalid evidence', { timeout: 180000 }, async context => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    const metadata = inspector.metadata.bind(inspector);
    const calls: string[] = [];
    inspector.metadata = (script, ...args) => { calls.push(path.basename(script)); return metadata(script, ...args); };
    try {
      const binding = Buffer.from(stringifyJson({ runtimeScopeVersion: 1, game: 'game', principal: 'principal' }));
      await fs.writeFile(path.join(fixture.root, 'scope.json'), binding);
      const scope: RuntimeScope = { companionRoot: fixture.root, dataRoot: fixture.root, game: 'game', principal: 'principal', bindingSha256: bytesHash(binding), createdHere: false };
      const storage = new ScopeStorage({ scope, inspector, guard: { held: false }, publisher: {} as FilePublisher });
      const names = Array.from({ length: 1025 }, (_, index) => `${index}.json`);
      for (const [index, name] of names.entries()) { await fs.writeFile(path.join(fixture.root, name), stringifyJson({ index })); }
      const started = performance.now();
      const results = await storage.readMany(names, 'config', value => value, Deadline.after(120000));
      context.diagnostic(`native1025Ms=${Math.round(performance.now() - started)} metadataCalls=${calls.length}`);
      assert.equal(results.length, 1025);
      assert.ok(results.every((result, index) => result.status === 'valid' && asInteger((result.value as { index: unknown }).index) === index));
      assert.deepEqual(calls, ['Get-FileHashes.ps1', 'Get-FileHashes.ps1', 'Get-FileHashes.ps1']);
      assert.deepEqual(await readFileHashes(inspector, fixture.root, [names[0]!], Deadline.after(30000)), [bytesHash(Buffer.from(stringifyJson({ index: 0 })))]);
      const directoryBefore = await fs.readdir(fixture.root);
      const invalid = Buffer.from('{"duplicate":1,"duplicate":2}');
      const oversized = Buffer.alloc(jsonBudgets.config.maxBytes + 1, 32);
      await fs.writeFile(path.join(fixture.root, names[0]!), invalid);
      await fs.writeFile(path.join(fixture.root, names[1]!), oversized);
      const diagnostic = await storage.readMany([names[0]!, names[1]!, 'absent.json', names[2]!], 'config', (_value, index) => {
        if (index === 3) { throw new ControlDocumentError('fixture schema mismatch'); }
        return null;
      });
      assert.deepEqual(diagnostic, [{ status: 'invalid', sha256: bytesHash(invalid) }, { status: 'invalid', sha256: bytesHash(oversized) }, { status: 'absent' },
        { status: 'invalid', sha256: bytesHash(Buffer.from(stringifyJson({ index: 2 }))) }]);
      assert.deepEqual(await fs.readdir(fixture.root), directoryBefore);
      assert.deepEqual(await fs.readFile(path.join(fixture.root, 'scope.json')), binding);
      await fs.writeFile(path.join(fixture.root, 'scope.json'), '{}');
      await assert.rejects(storage.readMany([names[2]!], 'config', value => value), DataRootUnavailableError);
      await fs.writeFile(path.join(fixture.root, 'scope.json'), binding);
      await fs.link(path.join(fixture.root, names[2]!), path.join(fixture.root, 'alias.json'));
      await assert.rejects(storage.readMany([names[2]!], 'config', value => value), DataRootUnavailableError);
      await fs.unlink(path.join(fixture.root, 'alias.json'));
      await assert.rejects(storage.readMany(['.'], 'config', value => value), DataRootUnavailableError);
      await assert.rejects(storage.readMany(['../outside.json'], 'config', value => value), DataRootUnavailableError);
    } finally { await inspector.idle(); await fixture.close(); }
  });

  it('refuses changed bytes, lost reads and expired proof before returning authority', { timeout: 90000 }, async () => {
    const fixture = await companionFixture();
    try {
      const binding = Buffer.from('{}');
      const target = path.join(fixture.root, 'control.json');
      await fs.writeFile(path.join(fixture.root, 'scope.json'), binding);
      const original = Buffer.from('{"value":1}');
      await fs.writeFile(target, original);
      const inspector = new PathInspector({} as ProcessSupervisor);
      let mutation = async () => {};
      let now = 0;
      inspector.metadata = async (_script, args, _cwd, _timeout, input) => {
        assert.equal(args[3], bytesHash(binding));
        assert.ok(input);
        await mutation();
        return { exitCode: 0, stdout: Buffer.from(stringifyJson({ requestSha256: bytesHash(input), sha256: [bytesHash(original)] })), stderr: Buffer.alloc(0) };
      };
      const scope: RuntimeScope = { companionRoot: fixture.root, dataRoot: fixture.root, game: 'game', principal: 'principal', bindingSha256: bytesHash(binding), createdHere: false };
      const storage = new ScopeStorage({ scope, inspector, guard: { held: false }, publisher: {} as FilePublisher });
      mutation = async () => { await fs.writeFile(target, '{"value":2}'); };
      await assert.rejects(storage.readMany(['control.json'], 'config', value => value), StorageConflictError);
      mutation = async () => { await fs.unlink(target); };
      await assert.rejects(storage.readMany(['control.json'], 'config', value => value), { code: 'ENOENT' });
      await fs.writeFile(target, original);
      mutation = async () => { await fs.writeFile(path.join(fixture.root, 'scope.json'), '{"changed":true}'); };
      await assert.rejects(storage.readMany(['control.json'], 'config', value => value), DataRootUnavailableError);
      await fs.writeFile(path.join(fixture.root, 'scope.json'), binding);
      mutation = async () => { now = 10; };
      let parsed = false;
      await assert.rejects(storage.readMany(['control.json'], 'config', value => { parsed = true; return value; }, Deadline.after(10, () => now)), DeadlineExceededError);
      assert.equal(parsed, false);
      mutation = async () => {};
      now = 0;
      await assert.rejects(storage.readMany(['control.json'], 'config', value => { now = 10; return value; }, Deadline.after(10, () => now)), DeadlineExceededError);
      assert.equal((await storage.readMany(['control.json'], 'config', value => value))[0]?.status, 'valid');
      now = 0;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const paused = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      mutation = async () => { calls++; started(); await paused; };
      const first = storage.readMany(['control.json'], 'config', value => value);
      await entered;
      const queued = assert.rejects(storage.readMany(['control.json'], 'config', value => value, Deadline.after(10, () => now)), DeadlineExceededError);
      now = 10;
      release();
      await first;
      await queued;
      assert.equal(calls, 1);
    } finally { await fixture.close(); }
  });
});
