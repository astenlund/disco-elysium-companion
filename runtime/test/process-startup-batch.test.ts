import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseStrictJson } from '../src/json.ts';
import { parseStartupJobStates, ProcessSupervisor, processRoles, SupervisorError } from '../src/process.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const childScript = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));
const batchScript = fileURLToPath(new URL('../scripts/Get-OwnedJobStates.ps1', import.meta.url));
const execute = promisify(execFile);

test('requires a complete ordered startup job observation', () => {
  const names = ['first', 'second'];
  const valid = { jobs: [{ name: 'first', state: 'absent', processes: null }, { name: 'second', state: 'present', processes: 2 }] };
  const parsed = (value: unknown) => parseStrictJson(Buffer.from(JSON.stringify(value)));
  assert.deepEqual(parseStartupJobStates(parsed(valid), names), [true, false]);
  for (const invalid of [
    { jobs: valid.jobs.slice(0, 1) },
    { jobs: [...valid.jobs].reverse() },
    { jobs: [{ ...valid.jobs[0], processes: 0 }, valid.jobs[1]] },
    { jobs: [{ ...valid.jobs[0], state: 'unknown' }, valid.jobs[1]] },
    { jobs: [{ ...valid.jobs[0], extra: true }, valid.jobs[1]] },
  ]) {
    assert.throws(() => parseStartupJobStates(parsed(invalid), names), SupervisorError);
  }
});

test('batches startup admission after a prior owned metadata child', { timeout: 60000 }, async () => {
  const scope = path.join(root, '.tmp', `startup-job-batch-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const options = { command: process.execPath, args: [childScript, 'arguments', 'checked'], cwd: root };
  await supervisor.admitStartup();
  const first = await supervisor.run('metadata', options, 15000);
  assert.equal(first.exitCode, 0);
  assert.equal(first.stdout.toString('utf8'), '["checked"]');
  await supervisor.admitStartup();
  const second = await supervisor.run('metadata', options, 15000);
  assert.equal(second.exitCode, 0);
  await supervisor.verifyQuiescent('metadata');
});

test('refuses startup admission while an owned child is running', { timeout: 60000 }, async () => {
  const scope = path.join(root, '.tmp', `startup-job-batch-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const child = supervisor.spawn('watcher', { command: process.execPath, args: [childScript, 'wait'], cwd: root });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  try {
    await child.ready;
    const names = processRoles.map(role => supervisor.jobName(role));
    const observed = await execute('pwsh', ['-NoProfile', '-File', batchScript, '-JobNamesJson', JSON.stringify(names)],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    assert.deepEqual(parseStartupJobStates(parseStrictJson(Buffer.from(observed.stdout)), names), [true, true, true, false, true, true]);
    await assert.rejects(execute('pwsh', ['-NoProfile', '-File', batchScript, '-JobNamesJson', JSON.stringify([names[0], names[0]])],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 }));
    await assert.rejects(supervisor.admitStartup(), error => error instanceof SupervisorError && error.reason === 'termination-unverified');
  } finally {
    await supervisor.stop('watcher');
  }
  await supervisor.admitStartup();
});
