import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import { withoutHome } from '../src/native-helper.ts';
import { ProcessSupervisor, SupervisorError } from '../src/process.ts';
import { createTestNative } from './support/native-helper.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));
const create = async (): Promise<ProcessSupervisor> => (await createTestNative(path.join(root, '.tmp', `process-${randomUUID()}`))).supervisor;
const options = (mode: string, ...args: string[]) => ({ command: process.execPath, args: [fixture, mode, ...args], cwd: root });

describe('owned process transport', () => {
  it('gives every child its own supplied environment through the control frame', { timeout: 30000 }, async () => {
    // Arrange
    const scratch = await fs.mkdtemp(path.join(root, '.tmp', 'child-environment-'));
    const profile = path.join(scratch, 'profile');
    await fs.mkdir(profile);
    const supervisor = (await createTestNative(path.join(scratch, 'scope'))).supervisor;
    const supplied = { ...withoutHome(process.env), TEMP: profile, TMP: profile, TMPDIR: profile,
      APPDATA: profile, LOCALAPPDATA: profile, USERPROFILE: profile, HOME: profile };
    try {
      // Act
      const metadata = await supervisor.run('metadata', { ...options('environment'), env: supplied }, 15000);
      const provider = await supervisor.run('provider', { ...options('environment'), env: supplied }, 15000);

      // Assert
      for (const result of [metadata, provider]) {
        assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), { TEMP: profile, APPDATA: profile, HOME: profile });
      }
      await supervisor.verifyQuiescentMany(['metadata', 'provider']);
    } finally {
      assert.equal(path.relative(root, scratch).startsWith('..'), false);
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('proves exact live provider PID and creation in its scoped job', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const otherScope = await create();
    const child = supervisor.spawn('provider', options('wait'));
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    try {
      const identity = await child.ready;
      await supervisor.verifyOwnedLive('provider', child, identity);
      const observe = async (jobName: string, created: string): Promise<unknown> => {
        const reply = await supervisor.nativeHelper.request('ownedProcessLive', { jobName, pid: identity.pid, created }, 5000);
        assert.equal(reply.status, 'ok');
        return reply.status === 'ok' ? JSON.parse(JSON.stringify(reply.result)) : null;
      };
      assert.deepEqual(await observe(otherScope.jobName('provider'), identity.created), { live: false });
      assert.deepEqual(await observe(supervisor.jobName('provider'), String(BigInt(identity.created) + 1n)), { live: false });
      await assert.rejects(supervisor.verifyOwnedLive('provider', child, { ...identity, pid: identity.pid + 1 }), SupervisorError);
      await assert.rejects(supervisor.verifyOwnedLive('provider', child, { ...identity, created: String(BigInt(identity.created) + 1n) }), SupervisorError);
      await assert.rejects(otherScope.verifyOwnedLive('provider', child, identity), SupervisorError);
      assert.equal(child.brokerClosed, false);
    } finally {
      await supervisor.stop('provider');
      await assert.rejects(supervisor.verifyOwnedLive('provider', child, await child.ready), SupervisorError);
    }
  });

  it('survives native broker spawn failure and verifies ownership before reuse', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const missingCwd = path.join(root, '.tmp', `missing-broker-${randomUUID()}`);
    await assert.rejects(supervisor.run('core', { ...options('arguments'), cwd: missingCwd }, 15000), SupervisorError);
    await supervisor.verifyQuiescent('core');
    const next = await supervisor.run('core', options('arguments', 'recovered'), 15000);
    assert.equal(next.stdout.toString('utf8'), '["recovered"]');
  });

  it('preserves argument vectors and separates metadata from bounded child streams', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const argumentsList = ['space value', 'quote"value', 'slash' + String.fromCharCode(92), '$literal', ''];
    const result = await supervisor.run('core', options('arguments', ...argumentsList), 15000);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), argumentsList);
    assert.equal(result.stderr.toString('utf8'), 'diagnostic');
    await supervisor.verifyQuiescent('core');
  });

  it('preserves streamed input and blocks reuse even before native job creation', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const child = supervisor.spawn('provider', options('echo'));
    const sdkProcess: SpawnedProcess = child;
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk as Buffer));
    child.stderr.resume();
    try {
      await assert.rejects(supervisor.verifyQuiescent('provider'), SupervisorError);
      assert.throws(() => supervisor.spawn('provider', options('echo')), SupervisorError);
      const identity = await child.ready;
      assert.ok(identity.pid > 0);
      const input = Buffer.from('first\r\n{"ownedProcessVersion":1}\n' + String.fromCodePoint(0x1f600));
      sdkProcess.stdin.end(input);
      const result = await child.terminated;
      assert.equal(result.code, 0);
      assert.equal(result.failure, null);
      assert.deepEqual(Buffer.concat(chunks), input);
    } finally {
      if (!child.brokerClosed) { child.kill(); }
      await child.terminated;
    }
  });

  it('forwards bounded finite control input after the private broker frame', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const input = Buffer.from('{"control":"first"}\n{"ownedProcessVersion":1}\n');
    const result = await supervisor.run('metadata', options('echo'), 15000, input);
    assert.deepEqual(result.stdout, input);
    await assert.rejects(supervisor.run('metadata', options('echo'), 15000, Buffer.alloc(1048577)), SupervisorError);
    await supervisor.verifyQuiescent('metadata');
  });

  it('terminates on capture overflow and admits the next command only after quiescence', { timeout: 40000 }, async () => {
    const supervisor = await create();
    await assert.rejects(supervisor.run('core', options('overflow'), 15000), error => error instanceof SupervisorError && error.reason === 'capture-overflow');
    const next = await supervisor.run('core', options('arguments', 'after-overflow'), 15000);
    assert.equal(next.stdout.toString('utf8'), '["after-overflow"]');
  });

  it('treats an exhausted deadline as failure and verifies the entire job ended', { timeout: 30000 }, async () => {
    const supervisor = await create();
    await assert.rejects(supervisor.run('core', options('wait'), 3000), error => error instanceof SupervisorError && error.reason === 'deadline');
    await supervisor.verifyQuiescent('core');
  });

  it('stops a running child after its grace period and keeps admission closed until verified', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const child = supervisor.spawn('core', options('wait'));
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    try {
      await child.ready;
      const stopping = supervisor.stop('core', 25);
      assert.equal(supervisor.stop('core', 0), stopping);
      assert.throws(() => supervisor.spawn('core', options('arguments')), SupervisorError);
      await stopping;
      assert.equal(child.terminationState, 'verified');
      const next = await supervisor.run('core', options('arguments', 'after-stop'), 15000);
      assert.equal(next.stdout.toString(), '["after-stop"]');
      await supervisor.stop('core');
    } finally { if (!child.brokerClosed) { child.kill(); } await child.terminated; }
  });

  it('kills the whole child tree through its kill-on-close job when the broker dies', { timeout: 30000 }, async () => {
    // Arrange: a child that starts a descendant of its own.
    const supervisor = await create();
    const child = supervisor.spawn('provider', options('wait-tree'));
    child.stderr.resume();
    child.stdin.end();
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    await child.ready;
    const deadline = performance.now() + 15000;
    while (!/^[0-9]+$/.test(output) && performance.now() < deadline) { await new Promise(resolve => { setTimeout(resolve, 20); }); }
    const descendant = Number(output);
    assert.ok(descendant > 0);

    // Act: terminate the broker process alone.
    assert.equal(child.kill(), true);
    await child.terminated;

    // Assert: the job took the child and its descendant with it, and the role is launchable again.
    assert.throws(() => process.kill(descendant, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    await supervisor.verifyQuiescent('provider');
    const next = await supervisor.run('provider', options('arguments', 'after-broker-death'), 15000);
    assert.equal(next.stdout.toString(), '["after-broker-death"]');
  });

  it('can stop before readiness without releasing an unverifiable owner', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const child = supervisor.spawn('core', options('wait'));
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    await supervisor.stop('core');
    assert.equal(child.terminationState, 'verified');
    await supervisor.verifyQuiescent('core');
    await assert.rejects(supervisor.stop('core', -1), SupervisorError);
  });

  it('rejects oversized control metadata before allocating a broker', { timeout: 30000 }, async () => {
    const supervisor = await create();
    assert.throws(() => supervisor.spawn('core', options('arguments', 'x'.repeat(1_048_576))));
    const result = await supervisor.run('core', options('arguments', 'still-available'), 15000);
    assert.equal(result.stdout.toString('utf8'), '["still-available"]');
  });

  it('shares an ongoing termination proof instead of racing to clear queue ownership', { timeout: 30000 }, async () => {
    const supervisor = await create();
    const child = supervisor.spawn('core', options('arguments', 'complete'));
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end();
    await child.ready;
    const deadline = performance.now() + 10000;
    while (!child.brokerClosed && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(child.brokerClosed, true);
    const [result] = await Promise.all([child.terminated, supervisor.verifyQuiescent('core')]);
    assert.equal(result.code, 0);
    assert.equal(child.terminationState, 'verified');
  });

  it('terminates a long-lived child when its runtime parent exits', { timeout: 30000 }, async () => {
    const candidate = path.join(root, '.tmp', `parent-exit-${randomUUID()}`);
    const ownerScript = fileURLToPath(new URL('./fixtures/supervisor-owner.ts', import.meta.url));
    const owner = spawn(process.execPath, [ownerScript, candidate], { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    owner.stderr.resume();
    const closed = new Promise<void>((resolve, reject) => { owner.once('close', () => resolve()); owner.once('error', reject); });
    const lines = createInterface({ input: owner.stdout });
    try {
      const first = await lines[Symbol.asyncIterator]().next();
      assert.equal(first.done, false);
      const report = JSON.parse(first.value as string) as { job: string; identity: { pid: number } };
      assert.ok(report.identity.pid > 0);
      owner.stdin.end();
      await closed;
      const replacement = (await createTestNative(candidate)).supervisor;
      assert.equal(replacement.jobName('watcher'), report.job);
      await replacement.verifyQuiescent('watcher');
      const result = await replacement.run('watcher', options('arguments', 'replacement'), 15000);
      assert.equal(result.stdout.toString('utf8'), '["replacement"]');
    } finally {
      lines.close();
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); }
      await closed;
    }
  });
});
