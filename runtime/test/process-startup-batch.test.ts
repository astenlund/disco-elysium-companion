import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PathInspector } from '../src/admission.ts';
import { asInteger, hasExactKeys, parseStrictJson } from '../src/json.ts';
import { parseStartupJobStates, ProcessSupervisor, processRoles, SupervisorError } from '../src/process.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const childScript = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));
const batchScript = fileURLToPath(new URL('../scripts/Get-OwnedJobStates.ps1', import.meta.url));
const identityScript = fileURLToPath(new URL('../scripts/Get-ProcessIdentity.ps1', import.meta.url));
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

test('batches writer absence and refuses owned or foreign live jobs', { timeout: 60000 }, async () => {
  const scope = path.join(root, '.tmp', `writer-job-batch-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const competitor = await ProcessSupervisor.create(scope);
  await supervisor.verifyQuiescentMany(['publication', 'startupMutation']);
  await assert.rejects(supervisor.verifyQuiescentMany(['publication', 'publication']),
    error => error instanceof SupervisorError && error.reason === 'result-invalid');
  const options = { command: process.execPath, args: [childScript, 'wait'], cwd: root };
  const owned = supervisor.spawn('startupMutation', options);
  owned.stdout.resume(); owned.stderr.resume(); owned.stdin.end();
  try {
    await owned.ready;
    await assert.rejects(supervisor.verifyQuiescentMany(['publication', 'startupMutation']), SupervisorError);
  } finally { await supervisor.stop('startupMutation'); }
  const foreign = competitor.spawn('publication', options);
  foreign.stdout.resume(); foreign.stderr.resume(); foreign.stdin.end();
  try {
    await foreign.ready;
    await assert.rejects(supervisor.verifyQuiescentMany(['publication', 'startupMutation']), SupervisorError);
  } finally { await competitor.stop('publication'); }
  await supervisor.verifyQuiescentMany(['publication', 'startupMutation']);
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

test('warm unowned job observations fail closed without changing the all-role admission path', { timeout: 30000 }, async () => {
  const scope = path.join(root, '.tmp', `warm-job-observer-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  let observations = 0;
  supervisor.attachStartupJobObserver(async () => { observations += 1; throw new Error('worker unavailable'); });
  await assert.rejects(supervisor.verifyQuiescent('publication'),
    error => error instanceof SupervisorError && error.reason === 'termination-unverified');
  assert.equal(observations, 1);
  await supervisor.admitStartup();
  assert.equal(observations, 1);
  await supervisor.verifyQuiescent('startupMetadata');
  assert.equal(observations, 1);
  supervisor.clearStartupJobObserver();
  await supervisor.verifyQuiescent('publication');
});

test('one-shot metadata stop does not reenter its own warm observation queue', { timeout: 30000 }, async () => {
  const scope = path.join(root, '.tmp', `metadata-job-observer-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const inspector = new PathInspector(supervisor);
  let warmQueries = 0;
  supervisor.attachStartupJobObserver(async () => { warmQueries += 1; throw new Error('Unexpected worker reentry.'); });
  try {
    const result = await inspector.metadata(identityScript, ['-ProcessId', String(process.pid)], root);
    assert.equal(result.exitCode, 0);
    assert.equal(warmQueries, 0);
    const value = parseStrictJson(result.stdout);
    assert.ok(hasExactKeys(value, ['exists', 'pid', 'created']));
    assert.equal(asInteger(value['pid']), process.pid);
  } finally { supervisor.clearStartupJobObserver(); }
});

test('a startup core-reply stop inside the inspector queue is proved without the warm observer', { timeout: 30000 }, async () => {
  const scope = path.join(root, '.tmp', `core-reply-observer-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const inspector = new PathInspector(supervisor);
  let warmQueries = 0;
  supervisor.attachStartupJobObserver(async () => { warmQueries += 1; throw new Error('Unexpected worker reentry.'); });
  const child = supervisor.spawn('startupCoreReply', { command: process.execPath, args: [childScript, 'wait'], cwd: root });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  let stopped = false;
  try {
    await child.ready;
    inspector.attachStartupCoreReplySession({ supports: () => true, canFallBack: false, close: async () => {},
      invoke: async () => {
        await supervisor.stop('startupCoreReply');
        stopped = true;
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      } } as never);
    const started = performance.now();
    await inspector.metadata(identityScript, [], root, 30000, Buffer.from('{}'));
    assert.equal(stopped, true);
    assert.equal(warmQueries, 0);
    assert.ok(performance.now() - started < 10000);
  } finally {
    supervisor.clearStartupJobObserver();
    await supervisor.stop('startupCoreReply');
  }
});

test('a verifiably stopped warm worker hands later termination proofs to one-shot observation', { timeout: 60000 }, async () => {
  for (const dropBy of ['metadata', 'observation'] as const) {
    const scope = path.join(root, '.tmp', `stopped-worker-observer-${randomUUID()}`);
    const supervisor = await ProcessSupervisor.create(scope);
    const inspector = new PathInspector(supervisor);
    let warmQueries = 0;
    inspector.attachStartupSession({ canFallBack: true, supports: () => true, close: async () => {},
      observeJobStates: async (names: readonly string[]) => { warmQueries += 1; return names.map(() => true); } } as never);
    supervisor.attachStartupJobObserver((names, timeoutMs) => inspector.observeStartupJobs(names, timeoutMs));
    if (dropBy === 'metadata') {
      const identity = await inspector.metadata(identityScript, ['-ProcessId', String(process.pid)], root);
      assert.equal(identity.exitCode, 0, dropBy);
    }
    const first = await supervisor.run('core', { command: process.execPath, args: [childScript, 'arguments'], cwd: root }, 30000);
    const second = await supervisor.run('core', { command: process.execPath, args: [childScript, 'arguments'], cwd: root }, 30000);
    assert.equal(first.exitCode, 0, dropBy);
    assert.equal(second.exitCode, 0, dropBy);
    assert.equal(warmQueries, 0, dropBy);
  }
});

test('a warm observation queued behind a request that stops the worker falls back to one-shot', async () => {
  let cleared = 0;
  const supervisor = { clearStartupJobObserver: () => { cleared += 1; } } as unknown as ProcessSupervisor;
  const inspector = new PathInspector(supervisor);
  const worker = { canFallBack: false, close: async () => {}, supports: () => true,
    invoke: async () => { worker.canFallBack = true; return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    observeJobStates: async () => { throw new Error('The worker session is closed.'); } };
  inspector.attachStartupSession(worker as never);
  const request = inspector.metadata(identityScript, [], root);
  const observation = inspector.observeStartupJobs(['fixture-job']);
  await request;
  assert.equal(await observation, null);
  assert.equal(cleared, 1);
});

test('admits only the exact live owned startup metadata job', { timeout: 60000 }, async t => {
  const scope = path.join(root, '.tmp', `startup-job-batch-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const competitor = await ProcessSupervisor.create(scope);
  const child = supervisor.spawn('startupMetadata', { command: process.execPath, args: [childScript, 'wait'], cwd: root });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  try {
    const identity = await child.ready;
    const names = processRoles.map(role => supervisor.jobName(role));
    const broker = child.ownedBrokerIdentity;
    assert.ok(broker !== null);
    assert.equal(broker.pid, child.brokerPid);
    const observe = async (created: string, brokerCreated: string) => {
      const result = await execute('pwsh', ['-NoProfile', '-File', batchScript, '-JobNamesJson', JSON.stringify(names),
        '-OwnedJobName', supervisor.jobName('startupMetadata'), '-OwnedProcessId', String(identity.pid),
        '-OwnedBrokerProcessId', String(broker.pid), '-OwnedProcessCreated', created, '-OwnedBrokerCreated', brokerCreated],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      const value = parseStrictJson(Buffer.from(result.stdout));
      assert.ok(hasExactKeys(value, ['jobs', 'owned']));
      const jobs = value['jobs'];
      assert.ok(Array.isArray(jobs));
      const metadata = jobs[processRoles.indexOf('startupMetadata')];
      assert.ok(metadata !== null && typeof metadata === 'object');
      const count = asInteger((metadata as Record<string, unknown>)['processes']);
      assert.ok(count === 2 || count === 3);
      return { owned: value['owned'], count };
    };
    const admitted = await observe(identity.created, broker.created);
    assert.equal(admitted.owned, true);
    t.diagnostic(`owned startup metadata job has ${admitted.count} members`);
    assert.equal((await observe('1', broker.created)).owned, false);
    assert.equal((await observe(identity.created, String(BigInt(broker.created) + 1n))).owned, false);
    await supervisor.admitStartup(true);
    await assert.rejects(supervisor.admitStartup(), SupervisorError);
    await assert.rejects(competitor.admitStartup(), SupervisorError);
    await assert.rejects(competitor.admitStartup(true), SupervisorError);
  } finally { await supervisor.stop('startupMetadata'); }
  await supervisor.admitStartup();
});

test('refuses owned metadata admission once its stop has started', { timeout: 60000 }, async () => {
  const scope = path.join(root, '.tmp', `startup-job-batch-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const child = supervisor.spawn('startupMetadata', { command: process.execPath, args: [childScript, 'wait'], cwd: root });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  await child.ready;
  const stopping = supervisor.stop('startupMetadata', 2000);
  await assert.rejects(supervisor.admitStartup(true), error => error instanceof SupervisorError && error.reason === 'termination-unverified');
  await stopping;
  await supervisor.verifyQuiescent('startupMetadata');
});

test('refuses owned metadata admission when its job has a descendant', { timeout: 60000 }, async () => {
  const scope = path.join(root, '.tmp', `startup-job-tree-${randomUUID()}`);
  const supervisor = await ProcessSupervisor.create(scope);
  const child = supervisor.spawn('startupMetadata', { command: process.execPath, args: [childScript, 'wait-tree'], cwd: root });
  const treeReady = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  try {
    await child.ready;
    await treeReady;
    await assert.rejects(supervisor.admitStartup(true), error => error instanceof SupervisorError && error.reason === 'termination-unverified');
  } finally { await supervisor.stop('startupMetadata'); }
  await supervisor.admitStartup();
});

for (const activeRole of ['watcher', 'startupCoreReply', 'startupMutation'] as const) {
  test('refuses startup admission while an owned ' + activeRole + ' child is running', { timeout: 60000 }, async () => {
    const scope = path.join(root, '.tmp', `startup-job-batch-${randomUUID()}`);
    const supervisor = await ProcessSupervisor.create(scope);
    const child = supervisor.spawn(activeRole, { command: process.execPath, args: [childScript, 'wait'], cwd: root });
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    try {
      await child.ready;
      const names = processRoles.map(role => supervisor.jobName(role));
      const observed = await execute('pwsh', ['-NoProfile', '-File', batchScript, '-JobNamesJson', JSON.stringify(names)],
        { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      assert.deepEqual(parseStartupJobStates(parseStrictJson(Buffer.from(observed.stdout)), names), processRoles.map(role => role !== activeRole));
      await assert.rejects(execute('pwsh', ['-NoProfile', '-File', batchScript, '-JobNamesJson', JSON.stringify([names[0], names[0]])],
        { windowsHide: true, timeout: 10000, maxBuffer: 65536 }));
      await assert.rejects(supervisor.admitStartup(), error => error instanceof SupervisorError && error.reason === 'termination-unverified');
    } finally {
      await supervisor.stop(activeRole);
    }
    await supervisor.admitStartup();
  });
}
