import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { hasExactKeys, parseStrictJson } from '../src/json.ts';
import { ProcessSupervisor, processRoles, type OwnedProcess } from '../src/process.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(repository, 'runtime', 'prototypes', 'job-observer.go');
const childScript = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));
const execute = promisify(execFile);

test('native owned startup proof binds broker and child creation identities', { timeout: 120000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(repository, '.tmp', 'native-owned-identity-'));
  const binary = path.join(scratch, 'job-observer.exe');
  const manifest = path.join(scratch, 'job-observer.json');
  const privateEnvironment = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch, HOME: scratch,
    USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, GOCACHE: path.join(scratch, 'go-cache'),
    GOPATH: path.join(scratch, 'go-path'), GOMODCACHE: path.join(scratch, 'go-modules'), GOTELEMETRY: 'off' };
  let supervisor: ProcessSupervisor | undefined;
  let child: OwnedProcess | undefined;
  try {
    await execute('go', ['build', '-o', binary, source], { cwd: scratch, env: privateEnvironment, windowsHide: true, timeout: 90000 });
    const digest = async (location: string) => createHash('sha256').update(await fs.readFile(location)).digest('hex');
    const sourceSha256 = await digest(source);
    const binarySha256 = await digest(binary);
    await fs.writeFile(manifest, JSON.stringify({ sourceSha256, binarySha256, toolchain: 'go-test', output: binary, provenance: {} }), { flag: 'wx' });
    supervisor = await ProcessSupervisor.create(path.join(scratch, 'scope'), undefined,
      { binary, source, manifest, scratch, binarySha256, sourceSha256, manifestSha256: await digest(manifest) });
    child = supervisor.spawn('startupMetadata', { command: process.execPath, args: [childScript, 'wait'], cwd: repository, env: privateEnvironment });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end();
    const identity = await child.ready;
    const broker = child.ownedBrokerIdentity;
    assert.ok(broker !== null);
    assert.equal(broker.pid, child.brokerPid);
    const names = processRoles.map(role => supervisor!.jobName(role));
    const owned = { name: supervisor.jobName('startupMetadata'), processId: identity.pid, brokerId: broker.pid,
      created: identity.created, brokerCreated: broker.created };
    const observe = async (request: string) => {
      const result = await execute(binary, [request], { cwd: scratch, env: privateEnvironment, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      assert.ok(Buffer.byteLength(result.stdout) <= 65536);
      const value = parseStrictJson(Buffer.from(result.stdout));
      assert.ok(hasExactKeys(value, ['jobs', 'owned']));
      return value;
    };
    const request = JSON.stringify({ names, owned });
    const valid = await observe(request);
    assert.equal(valid['owned'], true);
    assert.ok(Array.isArray(valid['jobs']));
    assert.deepEqual(valid['jobs'].map(job => {
      assert.ok(hasExactKeys(job, ['name', 'state', 'processes']));
      return job['name'];
    }), names);
    await supervisor.admitStartup(true);
    assert.equal((await observe(JSON.stringify({ names, owned: { ...owned, brokerCreated: String(BigInt(broker.created) + 1n) } })))['owned'], false);
    assert.equal((await observe(JSON.stringify({ names, owned: { ...owned, created: String(BigInt(identity.created) + 1n) } })))['owned'], false);
    assert.equal((await observe(JSON.stringify({ names, owned: { ...owned, brokerId: process.pid } })))['owned'], false);
    for (const invalid of [
      JSON.stringify({ names, owned: { ...owned, brokerId: identity.pid } }),
      JSON.stringify({ names, owned: { ...owned, brokerCreated: undefined } }),
      request.replace('"brokerCreated":', '"brokerCreated":"1","brokerCreated":'),
    ]) {
      await assert.rejects(observe(invalid));
    }
  } finally {
    if (supervisor !== undefined && child !== undefined) { await supervisor.stop('startupMetadata'); }
    assert.equal(path.dirname(scratch), path.join(repository, '.tmp'));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
