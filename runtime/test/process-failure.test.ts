import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { OwnedProcess, SupervisorError } from '../src/process.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Broker extends EventEmitter {
  readonly pid = 456;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kills = 0;
  exitCode: number | null = null;
  readonly signalCode = null;
  kill(): boolean { this.killed = true; this.kills++; return true; }
  header(fields: Record<string, unknown> = {}): void {
    this.stdout.write(JSON.stringify({ ownedProcessVersion: 1, jobName: 'fixture', pid: 123, created: '123',
      brokerPid: this.pid, brokerCreated: '456', ...fields }) + '\n');
  }
  close(): void { this.exitCode = 1; this.emit('close', 1, null); }
}

function fixture() {
  const broker = new Broker();
  const proof = deferred();
  let proofs = 0;
  const child = new OwnedProcess('fixture', { pid: 1, created: '1' }, { command: 'fixture', args: [], cwd: 'C:/fixture' }, () => { proofs++; return proof.promise; }, () => broker as unknown as ChildProcessWithoutNullStreams);
  return { broker, child, proof, get proofs() { return proofs; } };
}

describe('owned transport failure supervision', () => {
  for (const fields of [{ brokerPid: 457 }, { brokerPid: 123 }, { brokerCreated: '0' }, { brokerCreated: 456 }]) {
    it('rejects an unbound broker header', async () => {
      const { broker, child, proof } = fixture();
      broker.header(fields);
      await assert.rejects(child.ready, error => error instanceof SupervisorError && error.reason === 'result-invalid');
      assert.equal(child.ownedBrokerIdentity, null);
      broker.close();
      proof.resolve();
      await child.terminated;
    });
  }

  for (const channel of ['stdout', 'stderr', 'stdin', 'process', 'exposedStdout', 'exposedStderr'] as const) {
    for (const stage of ['beforeHeader', 'duringOutput', 'duringVerification'] as const) {
      it(`supervises ${channel} failure ${stage} and waits for termination proof`, async () => {
        const { broker, child, proof } = fixture();
        const forwarded: Buffer[] = [];
        child.stdout.on('data', (bytes: Buffer) => forwarded.push(bytes));
        child.stderr.resume();
        let failures = 0;
        let settled = false;
        child.on('error', () => { failures++; });
        void child.terminated.then(() => { settled = true; });
        if (stage !== 'beforeHeader') { broker.header(); await child.ready; broker.stdout.write('partial'); }
        if (stage === 'duringVerification') { broker.close(); }
        const emitter = channel === 'process' ? broker : channel === 'exposedStdout' ? child.stdout : channel === 'exposedStderr' ? child.stderr : broker[channel];
        assert.doesNotThrow(() => emitter.emit('error', new Error('injected pipe failure')));
        assert.doesNotThrow(() => emitter.emit('error', new Error('repeated failure')));
        const count = forwarded.length;
        broker.stdout.write('must not be forwarded');
        assert.equal(forwarded.length, count);
        if (stage === 'beforeHeader') { await assert.rejects(child.ready, SupervisorError); }
        if (stage !== 'duringVerification') { broker.close(); }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(failures, 1);
        assert.equal(broker.kills, stage === 'duringVerification' ? 0 : 1);
        assert.equal(child.terminationState, 'verifying');
        assert.equal(settled, false);
        proof.resolve();
        const exit = await child.terminated;
        assert.ok(exit.failure instanceof SupervisorError);
        assert.equal(exit.failure.reason, 'result-invalid');
        assert.equal(child.terminationState, 'verified');
      });
    }
  }

  it('keeps failed termination proof unavailable after the broker closes', async () => {
    const { broker, child, proof } = fixture();
    broker.header();
    await child.ready;
    broker.stderr.emit('error', new Error('pipe failure'));
    broker.close();
    proof.reject(new Error('job still exists'));
    await assert.rejects(child.terminated, error => error instanceof SupervisorError && error.reason === 'termination-unverified');
    assert.equal(child.terminationState, 'unverified');
  });
});
