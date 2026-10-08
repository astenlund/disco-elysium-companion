import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { SupervisorError, type OwnedExit, type ProcessIdentity, type ProcessSupervisor } from '../../src/process.ts';
import { reconcileWatcherOrphan, WatcherSupervisor, type WatcherChild, type WatcherClock, type WatcherState } from '../../src/platform/watcher-supervisor.ts';
import type { RuntimeRecord } from '../../src/runtime-records.ts';

class Clock implements WatcherClock {
  time = 0;
  readonly scheduled = new Map<object, { callback: () => void; milliseconds: number }>();
  now(): number { return this.time; }
  schedule(callback: () => void, milliseconds: number): unknown { const id = {}; this.scheduled.set(id, { callback, milliseconds }); return id; }
  cancel(timer: unknown): void { this.scheduled.delete(timer as object); }
  advance(): number {
    assert.equal(this.scheduled.size, 1);
    const [id, next] = [...this.scheduled][0]!;
    this.scheduled.delete(id); this.time += next.milliseconds; next.callback();
    return next.milliseconds;
  }
}

class Child implements WatcherChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly ready: Promise<ProcessIdentity>;
  readonly terminated: Promise<OwnedExit>;
  kills = 0;
  private resolve!: (exit: OwnedExit) => void;
  private reject!: (error: Error) => void;
  constructor(pid: number) {
    this.ready = Promise.resolve({ pid, created: String(pid) });
    this.terminated = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
  exit(): void { this.resolve({ code: 1, signal: null, failure: null }); }
  uncertain(): void { this.reject(new SupervisorError('termination-unverified', 'Fixture tree remains unverified.')); }
  kill(): boolean { this.kills++; this.exit(); return true; }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function harness(persistWatcher?: (identity: ProcessIdentity | null) => Promise<void>, enabled = true) {
  const clock = new Clock();
  const children: Child[] = [];
  const identities: (ProcessIdentity | null)[] = [];
  const states: WatcherState[] = [];
  const errors: Error[] = [];
  const watcher = new WatcherSupervisor({ companionRoot: 'fixture', adapter: 'fixture', enabled, clock,
    supervisor: { spawn: () => { const child = new Child(children.length + 1); children.push(child); return child; }, verifyQuiescent: async () => {} },
    persistWatcher: async identity => { identities.push(identity); await persistWatcher?.(identity); }, onState: state => states.push(state), onFailure: error => errors.push(error) });
  return { watcher, clock, children, identities, states, errors };
}

describe('watcher supervision', () => {
  it('uses proven job absence before inspecting a stale watcher PID', async () => {
    const previous: RuntimeRecord = { runtimeInstanceId: 'a'.repeat(32), startedAt: '2026-10-08T01:00:00.0000000Z', cleanShutdown: false,
      watcher: { pid: 4, created: '1' } };
    for (const absent of [true, false]) {
      let runs = 0;
      let verifications = 0;
      const supervisor = { observeJobAbsent: async () => absent, jobName: () => `Global${String.fromCharCode(92)}fixture-watcher`,
        run: async () => { runs++; return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ state: 'reused', pid: 4, created: '1' })) }; },
        verifyQuiescent: async () => { verifications++; } } as unknown as ProcessSupervisor;
      await reconcileWatcherOrphan(previous, supervisor, 'C:/Git/disco-elysium-companion/.tmp/fixture');
      assert.equal(runs, absent ? 0 : 1);
      assert.equal(verifications, 1);
    }
    const unavailable = new SupervisorError('termination-unverified', 'Fixture job observation is unavailable.');
    const uncertain = { observeJobAbsent: async () => { throw unavailable; },
      run: async () => { assert.fail('An uncertain job must not inspect or terminate a PID.'); },
      verifyQuiescent: async () => { assert.fail('An uncertain job must not be reported quiescent.'); } } as unknown as ProcessSupervisor;
    await assert.rejects(reconcileWatcherOrphan(previous, uncertain, 'C:/Git/disco-elysium-companion/.tmp/fixture'), error => error === unavailable);
  });

  it('uses the complete restart ladder and resets after a ten-minute run', async () => {
    const fixture = harness();
    await fixture.watcher.start();
    assert.equal(fixture.watcher.state, 'running');
    for (const expected of [1000, 5000, 30000, 60000, 60000]) {
      fixture.children.at(-1)!.exit();
      await flush();
      assert.equal(fixture.watcher.state, 'restarting');
      assert.equal(fixture.clock.advance(), expected);
      await flush();
      assert.equal(fixture.watcher.state, 'running');
    }
    fixture.clock.time += 600000;
    fixture.children.at(-1)!.exit();
    await flush();
    assert.equal(fixture.clock.advance(), 1000);
    await flush();
    await fixture.watcher.stop();
    assert.equal(fixture.clock.scheduled.size, 0);
    assert.equal(fixture.watcher.state, 'stopped');
    assert.equal(fixture.identities.at(-1), null);
  });

  it('kills a just-spawned tree when its durable identity write fails and counts the failed start', async () => {
    let failures = 2;
    const fixture = harness(async identity => { if (identity !== null && failures-- > 0) { throw new Error('Fixture publication failed.'); } });
    await fixture.watcher.start();
    assert.equal(fixture.children[0]!.kills, 1);
    assert.equal(fixture.watcher.state, 'restarting');
    assert.equal(fixture.clock.advance(), 1000);
    await flush();
    assert.equal(fixture.children[1]!.kills, 1);
    assert.equal(fixture.clock.advance(), 5000);
    await flush();
    assert.equal(fixture.watcher.state, 'running');
    assert.equal(fixture.errors.length, 2);
    await fixture.watcher.stop();
  });

  it('does not restart after shutdown during a pending restart', async () => {
    const fixture = harness();
    await fixture.watcher.start();
    fixture.children[0]!.exit(); await flush();
    await fixture.watcher.stop();
    assert.equal(fixture.clock.scheduled.size, 0);
    assert.equal(fixture.children.length, 1);
    assert.equal(fixture.watcher.state, 'stopped');
  });

  it('honors shutdown before an enqueued start has created a child', async () => {
    const fixture = harness();
    await Promise.all([fixture.watcher.start(), fixture.watcher.stop()]);
    await fixture.watcher.start();
    assert.equal(fixture.children.length, 0);
    assert.equal(fixture.watcher.state, 'stopped');
  });

  it('keeps shutdown unclean when process-tree termination cannot be verified', async () => {
    const fixture = harness();
    await fixture.watcher.start();
    fixture.children[0]!.uncertain(); await flush();
    assert.equal(fixture.watcher.state, 'stopped');
    assert.equal(fixture.clock.scheduled.size, 0);
    await assert.rejects(fixture.watcher.stop(), error => error instanceof SupervisorError && error.reason === 'termination-unverified');
    assert.equal(fixture.identities.filter(identity => identity === null).length, 0);
  });

  it('leaves a disabled watcher unspawned', async () => {
    const fixture = harness(undefined, false);
    await fixture.watcher.start(); await fixture.watcher.stop();
    assert.equal(fixture.watcher.state, 'disabled');
    assert.equal(fixture.children.length, 0);
    assert.equal(fixture.identities.length, 0);
  });
});
