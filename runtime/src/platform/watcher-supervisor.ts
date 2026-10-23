import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { asInteger, hasExactKeys } from '../json.ts';
import { SupervisorError, type OwnedExit, type OwnedSpawnOptions, type ProcessIdentity, type ProcessSupervisor } from '../process.ts';
import type { RuntimeRecord } from '../runtime-records.ts';
import { SerialQueue } from '../serial.ts';

export type WatcherState = 'disabled' | 'running' | 'restarting' | 'stopped';
export interface WatcherChild {
  readonly ready: Promise<ProcessIdentity>;
  readonly terminated: Promise<OwnedExit>;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  kill(): boolean;
}
export interface WatcherClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(timer: unknown): void;
}
export interface WatcherOptions {
  readonly companionRoot: string;
  readonly adapter: string;
  readonly enabled: boolean;
  readonly supervisor: { spawn(role: 'watcher', options: OwnedSpawnOptions): WatcherChild; verifyQuiescent(role: 'watcher'): Promise<void> };
  readonly persistWatcher: (identity: ProcessIdentity | null) => Promise<void>;
  readonly onState: (state: WatcherState) => void;
  readonly onFailure?: (error: Error) => void;
  readonly clock?: WatcherClock;
}

const systemClock: WatcherClock = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: timer => clearTimeout(timer as NodeJS.Timeout),
};
const delays = [1000, 5000, 30000, 60000] as const;

// The recorded process token alone does not authorize a different PID incarnation
// or another scope's job. The native helper verifies both before terminating a tree.
export async function reconcileWatcherOrphan(previous: RuntimeRecord | null, supervisor: ProcessSupervisor): Promise<void> {
  if (previous?.watcher !== null && previous?.watcher !== undefined && !await supervisor.observeJobAbsent('watcher')) {
    const identity = previous.watcher;
    let reply;
    try { reply = await supervisor.nativeHelper.request('stopOrphanWatcher', { pid: identity.pid, created: identity.created, jobName: supervisor.jobName('watcher') }, 30000); }
    catch (error) { throw new SupervisorError('termination-unverified', 'Previous watcher could not be reconciled.', { cause: error }); }
    if (reply.status !== 'ok') { throw new SupervisorError('termination-unverified', 'Previous watcher could not be reconciled.'); }
    const value = reply.result;
    if (!hasExactKeys(value, ['state', 'pid', 'created']) || asInteger(value['pid']) !== identity.pid || value['created'] !== identity.created
      || typeof value['state'] !== 'string' || !['absent', 'reused', 'terminated'].includes(value['state'])) {
      throw new SupervisorError('result-invalid', 'Previous watcher reconciliation returned invalid evidence.');
    }
  }
  await supervisor.verifyQuiescent('watcher');
}

interface Attempt { readonly child: WatcherChild; readonly startedAt: number }

export class WatcherSupervisor {
  private readonly options: WatcherOptions;
  private readonly clock: WatcherClock;
  private readonly queue = new SerialQueue();
  private active: Attempt | null = null;
  private restartTimer: unknown = null;
  private nextDelay = 0;
  private wanted = false;
  private stopping = false;
  private failure: Error | null = null;
  private current: WatcherState;

  constructor(options: WatcherOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.current = options.enabled ? 'stopped' : 'disabled';
  }

  get state(): WatcherState { return this.current; }

  start(): Promise<void> {
    return this.queue.run(async () => {
      if (!this.options.enabled || this.wanted || this.stopping) { return; }
      if (this.failure !== null) { throw this.failure; }
      this.wanted = true;
      await this.launch();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wanted = false;
    if (this.restartTimer !== null) { this.clock.cancel(this.restartTimer); this.restartTimer = null; }
    // Interrupt a launch even if it is waiting for the broker's identity frame.
    this.active?.child.kill();
    await this.queue.run(async () => {
      if (this.active !== null) {
        const attempt = this.active;
        attempt.child.kill();
        await attempt.child.terminated;
        await this.options.supervisor.verifyQuiescent('watcher');
        this.active = null;
        await this.options.persistWatcher(null);
      } else { await this.options.supervisor.verifyQuiescent('watcher'); }
      if (this.failure !== null) { throw this.failure; }
      this.setState(this.options.enabled ? 'stopped' : 'disabled');
    });
  }

  private setState(state: WatcherState): void {
    if (state !== this.current) {
      this.current = state;
      try { this.options.onState(state); }
      catch { /* A presentation callback cannot interrupt process ownership. */ }
    }
  }

  private report(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error('Watcher supervision failed.');
    try { this.options.onFailure?.(failure); }
    catch { /* Diagnostics cannot bypass the required process termination. */ }
    return failure;
  }

  private block(error: unknown): void {
    this.failure = this.report(error);
    this.wanted = false;
    this.setState('stopped');
  }

  private schedule(startedAt: number | null): void {
    if (!this.wanted) { this.setState('stopped'); return; }
    if (startedAt !== null && this.clock.now() - startedAt >= 600000) { this.nextDelay = 0; }
    const delay = delays[Math.min(this.nextDelay, delays.length - 1)]!;
    this.nextDelay = Math.min(this.nextDelay + 1, delays.length - 1);
    this.setState('restarting');
    this.restartTimer = this.clock.schedule(() => {
      this.restartTimer = null;
      void this.queue.run(async () => { if (this.wanted) { await this.launch(); } }).catch(error => this.block(error));
    }, delay);
  }

  private async launch(): Promise<void> {
    if (!this.wanted) { return; }
    let attempt: Attempt | null = null;
    let readyTimer: unknown = null;
    try {
      await this.options.supervisor.verifyQuiescent('watcher');
      if (!this.wanted) { return; }
      const child = this.options.supervisor.spawn('watcher', { command: 'pwsh', args: ['-NoProfile', '-File',
        path.join(this.options.companionRoot, 'core', 'Watch-Saves.ps1'), '-Adapter', this.options.adapter, '-CompanionRoot', this.options.companionRoot], cwd: this.options.companionRoot });
      attempt = { child, startedAt: this.clock.now() };
      this.active = attempt;
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end();
      let exited = false;
      const ownedAttempt = attempt;
      void child.terminated.then(() => { exited = true; return this.queue.run(() => this.exited(ownedAttempt)); }, error => {
        exited = true;
        return this.queue.run(async () => { if (this.active === ownedAttempt) { this.block(error); } });
      }).catch(error => this.block(error));
      const launchExpired = new Promise<never>((_, reject) => {
        readyTimer = this.clock.schedule(() => { child.kill(); reject(new SupervisorError('deadline', 'Watcher launch did not produce a process identity.')); }, 30000);
      });
      const identity = await Promise.race([child.ready, launchExpired]);
      this.clock.cancel(readyTimer); readyTimer = null;
      if (!this.wanted || exited) { child.kill(); await child.terminated; return; }
      await this.options.persistWatcher(identity);
      if (this.wanted && !exited) { this.setState('running'); }
    } catch (error) {
      this.report(error);
      if (attempt !== null) {
        attempt.child.kill();
        try { await attempt.child.terminated; await this.options.supervisor.verifyQuiescent('watcher'); }
        catch (terminationError) { this.block(terminationError); throw terminationError; }
        if (this.active === attempt) { this.active = null; }
      } else if (error instanceof SupervisorError && error.reason === 'termination-unverified') {
        this.block(error); throw error;
      }
      this.schedule(null);
    } finally { if (readyTimer !== null) { this.clock.cancel(readyTimer); } }
  }

  private async exited(attempt: Attempt): Promise<void> {
    if (this.active !== attempt) { return; }
    await this.options.supervisor.verifyQuiescent('watcher');
    this.active = null;
    try { await this.options.persistWatcher(null); }
    catch (error) { this.report(error); }
    this.schedule(attempt.startedAt);
  }
}
