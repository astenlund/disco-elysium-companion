import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NativeHelperUnavailableError } from '../src/native-helper-error.ts';
import { NativeHelper } from '../src/native-helper.ts';
import { ProcessSupervisor, retiredJobRoles, type JobRole } from '../src/process.ts';
import { compileTestProgram, testHelperImage } from './support/native-helper.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const holderSource = fileURLToPath(new URL('./support/job-holder/', import.meta.url));
const scratch = path.join(repository, '.tmp', `native-binding-${randomUUID()}`);
let holder = '';

/** Runs a process in the named job, creating the job or joining an existing one, as another release's process would. */
async function holdJob(jobName: string): Promise<{ close(): Promise<void> }> {
  const child = spawn(holder, [jobName], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`The job holder ended with ${code}.`)));
  });
  let closed: Promise<void> | null = null;
  return { close: () => { closed ??= (async () => { child.stdin.end(); await exited; })(); return closed; } };
}

async function scope(): Promise<string> {
  const root = path.join(scratch, `scope-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function startHelper(root: string): Promise<{ readonly helper: NativeHelper; readonly supervisor: ProcessSupervisor }> {
  const helper = await NativeHelper.start(await testHelperImage());
  return { helper, supervisor: await ProcessSupervisor.create(root, helper) };
}

async function bound(root: string): Promise<{ readonly helper: NativeHelper; readonly supervisor: ProcessSupervisor }> {
  const started = await startHelper(root);
  await started.supervisor.proveBindable();
  await started.helper.bind({ token: started.supervisor.scopeToken, companionRoot: root, dataRoot: root });
  return started;
}

describe('helper predecessor proofs and scope binding', () => {
  before(async () => {
    await fs.mkdir(scratch, { recursive: true });
    holder = await compileTestProgram(holderSource, scratch, 'job-holder');
  });

  after(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  for (const role of [...retiredJobRoles, 'helper'] as readonly JobRole[]) {
    it(`blocks startup admission while a ${role} job is present`, { timeout: 60000 }, async () => {
      // Arrange
      const root = await scope();
      const { helper, supervisor } = await startHelper(root);
      const held = await holdJob(supervisor.jobName(role));
      try {
        // Act and assert
        await assert.rejects(supervisor.proveBindable(), /still present/);
        await held.close();
        await supervisor.proveBindable();
      } finally { await held.close(); await helper.close(); }
    });
  }

  for (const role of retiredJobRoles) {
    it(`blocks the pre-marker pass while a ${role} job is present beside the bound service`, { timeout: 60000 }, async () => {
      // Arrange
      const root = await scope();
      const { helper, supervisor } = await bound(root);
      const held = await holdJob(supervisor.jobName(role));
      try {
        // Act and assert
        await assert.rejects(supervisor.proveNoForeignWriters([role]), /still present/);
        await held.close();
        await supervisor.proveNoForeignWriters([role]);
      } finally { await held.close(); await helper.close(); }
    });
  }

  it('blocks both passes when the helper job holds a foreign member, and refuses binding over an existing helper job', { timeout: 60000 }, async () => {
    // Arrange: a bound service whose helper job then gains a member from another process, and a second runtime.
    const root = await scope();
    const { helper, supervisor } = await bound(root);
    const intruder = await holdJob(supervisor.jobName('helper'));
    const second = await startHelper(root);
    try {
      // Act and assert
      await assert.rejects(supervisor.proveNoForeignWriters(), /member other than/);
      await assert.rejects(second.supervisor.proveBindable(), /still present/);
      await assert.rejects(second.helper.bind({ token: second.supervisor.scopeToken, companionRoot: root, dataRoot: root }),
        error => error instanceof NativeHelperUnavailableError && error.reason === 'bindFailed');
    } finally { await intruder.close(); await second.helper.close(); await helper.close(); }
  });

  it('refuses a mutating request before binding with scopeUnbound', { timeout: 60000 }, async () => {
    // Arrange
    const root = await scope();
    const { helper } = await startHelper(root);
    try {
      // Act
      const reply = await helper.request('publish', { root, target: path.join(root, 'target.json'), inputFile: path.join(root, 'input.json'),
        inputSha256: '0'.repeat(64), profile: 'config', createOnly: true }, 10000);

      // Assert
      assert.deepEqual(reply, { status: 'error', code: 'scopeUnbound' });
      await assert.rejects(fs.stat(path.join(root, 'target.json')), { code: 'ENOENT' });
    } finally { await helper.close(); }
  });

  it('blocks both passes when the job observation is unavailable', { timeout: 60000 }, async () => {
    // Arrange: a bound helper that can no longer serve requests.
    const root = await scope();
    const { helper, supervisor } = await bound(root);
    await helper.close();

    // Act and assert
    await assert.rejects(supervisor.proveBindable());
    await assert.rejects(supervisor.proveNoForeignWriters());
  });
});
