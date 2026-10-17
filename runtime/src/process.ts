import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { guardScopeToken } from './guard.ts';
import { asInteger, hasExactKeys, parseStrictJson, stringifyJson, type JsonValue } from './json.ts';

export const processRoles = ['core', 'publication', 'provider', 'watcher', 'metadata', 'startupMetadata', 'startupCoreReply', 'startupMutation'] as const;
export type ProcessRole = typeof processRoles[number];
export type SupervisorReason = 'deadline' | 'capture-overflow' | 'abnormal-exit' | 'result-invalid' | 'termination-unverified';
export class SupervisorError extends Error {
  override readonly name = 'SupervisorError';
  readonly reason: SupervisorReason;
  constructor(reason: SupervisorReason, message: string) { super(message); this.reason = reason; }
}
export interface ProcessIdentity { readonly pid: number; readonly created: string }
export interface OwnedSpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}
export interface OwnedExit { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly failure: Error | null }
export interface CommandResult { readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }
export type BrokerSpawn = (options: OwnedSpawnOptions) => ChildProcessWithoutNullStreams;

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const creationToken = /^[1-9][0-9]{0,18}$/;
const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
const spawnBroker: BrokerSpawn = options => spawn('pwsh', ['-NoProfile', '-File', path.join(scripts, 'Invoke-OwnedProcess.ps1')], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

// These bootstrap scripts inspect metadata only and never start another process or write a file.
function inspectNative(script: 'Get-ProcessIdentity.ps1' | 'Get-OwnedJobState.ps1' | 'Get-OwnedJobStates.ps1', args: readonly string[], timeoutMs = 5000): Promise<ReturnType<typeof parseStrictJson>> {
  return new Promise((resolve, reject) => {
    execFile('pwsh', ['-NoProfile', '-File', path.join(scripts, script), ...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 65_536, encoding: 'buffer' }, (error, stdout) => {
      if (error !== null) { reject(new SupervisorError('termination-unverified', 'Native process metadata is unavailable.')); return; }
      try { resolve(parseStrictJson(stdout)); }
      catch { reject(new SupervisorError('result-invalid', 'Native process metadata is invalid.')); }
    });
  });
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) { throw new SupervisorError('result-invalid', 'Invalid process identifier.'); }
  const value = await inspectNative('Get-ProcessIdentity.ps1', ['-ProcessId', String(pid)]);
  if (!hasExactKeys(value, ['exists', 'pid', 'created']) || asInteger(value['pid']) !== pid || typeof value['exists'] !== 'boolean') {
    throw new SupervisorError('result-invalid', 'Invalid process identity response.');
  }
  if (!value['exists'] && value['created'] === null) { return null; }
  if (value['exists'] && typeof value['created'] === 'string' && creationToken.test(value['created'])) { return { pid, created: value['created'] }; }
  throw new SupervisorError('result-invalid', 'Invalid process creation identity.');
}

async function jobAbsent(name: string, timeoutMs: number): Promise<boolean> {
  const value = await inspectNative('Get-OwnedJobState.ps1', ['-JobName', name], timeoutMs);
  if (!hasExactKeys(value, ['state', 'processes'])) { throw new SupervisorError('termination-unverified', 'Invalid job observation.'); }
  if (value['state'] === 'absent' && value['processes'] === null) { return true; }
  const count = asInteger(value['processes']);
  if (value['state'] === 'present' && count !== undefined && count >= 0) { return false; }
  throw new SupervisorError('termination-unverified', 'Job state is unavailable.');
}

/** @internal A partial or reordered batch cannot establish startup quiescence. */
export function parseStartupJobStates(value: JsonValue, names: readonly string[]): readonly boolean[] {
  if (!hasExactKeys(value, ['jobs']) || !Array.isArray(value['jobs']) || value['jobs'].length !== names.length) {
    throw new SupervisorError('termination-unverified', 'Startup job observations are incomplete.');
  }
  return value['jobs'].map((entry, index) => {
    if (!hasExactKeys(entry, ['name', 'state', 'processes']) || entry['name'] !== names[index]) {
      throw new SupervisorError('termination-unverified', 'Startup job observation identity is invalid.');
    }
    if (entry['state'] === 'absent' && entry['processes'] === null) { return true; }
    const count = asInteger(entry['processes']);
    if (entry['state'] === 'present' && count !== undefined && count >= 0) { return false; }
    throw new SupervisorError('termination-unverified', 'Startup job state is unavailable.');
  });
}

async function jobsAbsent(names: readonly string[], owned?: { name: string; identity: ProcessIdentity; brokerPid: number }, timeoutMs = 30000): Promise<readonly boolean[]> {
  const args = ['-JobNamesJson', JSON.stringify(names)];
  if (owned !== undefined) { args.push('-OwnedJobName', owned.name, '-OwnedProcessId', String(owned.identity.pid), '-OwnedBrokerProcessId', String(owned.brokerPid), '-OwnedProcessCreated', owned.identity.created); }
  const value = await inspectNative('Get-OwnedJobStates.ps1', args, timeoutMs);
  if (owned === undefined) { return parseStartupJobStates(value, names); }
  if (!hasExactKeys(value, ['jobs', 'owned']) || value['owned'] !== true) {
    throw new SupervisorError('termination-unverified', 'Owned startup metadata job membership is unverified.');
  }
  const observedJobs = value['jobs'];
  if (observedJobs === undefined) { throw new SupervisorError('termination-unverified', 'Startup job observations are incomplete.'); }
  return parseStartupJobStates({ jobs: observedJobs }, names);
}

export class OwnedProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly ready: Promise<ProcessIdentity>;
  readonly terminated: Promise<OwnedExit>;
  private readonly broker: ChildProcessWithoutNullStreams;
  private failure: Error | null = null;
  private header: Buffer = Buffer.alloc(0);
  private identity: ProcessIdentity | null = null;
  private closed = false;
  private verification: 'running' | 'verifying' | 'verified' | 'unverified' = 'running';
  private resolveReady!: (identity: ProcessIdentity) => void;
  private rejectReady!: (error: Error) => void;
  private resolveTermination!: (exit: OwnedExit) => void;
  private rejectTermination!: (error: Error) => void;

  constructor(jobName: string, parent: ProcessIdentity, options: OwnedSpawnOptions, verifyTermination: () => Promise<void>, createBroker: BrokerSpawn = spawnBroker) {
    super();
    options.signal?.throwIfAborted();
    const frame = stringifyJson({ command: options.command, args: options.args, cwd: options.cwd, jobName, parentPid: parent.pid, parentCreated: parent.created });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.terminated = new Promise((resolve, reject) => { this.resolveTermination = resolve; this.rejectTermination = reject; });
    // SDK consumers use events; runtime consumers additionally await these original promises.
    void this.ready.catch(() => undefined);
    void this.terminated.catch(() => undefined);
    this.on('error', error => { this.failure ??= error as Error; });
    this.broker = createBroker(options);
    this.stdin = this.broker.stdin;
    let failing = false;
    const fail = (error: Error): void => {
      if (failing) { return; }
      failing = true;
      const failure = error instanceof SupervisorError ? error : new SupervisorError('result-invalid', 'Owned-process transport failed.');
      this.failure ??= failure;
      this.rejectReady(failure);
      // Continue draining the broker, but never forward partial protocol output.
      this.broker.stdout.resume();
      this.broker.stderr.resume();
      this.stdout.destroy(failure);
      this.stderr.destroy(failure);
      if (!this.closed) { this.broker.kill(); }
      this.emit('error', failure);
    };
    this.broker.on('error', fail);
    this.broker.stdin.on('error', fail);
    this.broker.stdout.on('error', fail);
    this.broker.stderr.on('error', fail);
    this.stdout.on('error', fail);
    this.stderr.on('error', fail);
    this.broker.stdout.on('data', (chunk: Buffer) => {
      if (failing) { return; }
      try {
        if (this.identity === null) {
          this.header = Buffer.concat([this.header, chunk]);
          const newline = this.header.indexOf(10);
          if (newline < 0) {
            if (this.header.length > 65_536) { throw new SupervisorError('result-invalid', 'Owned-process header exceeds its bound.'); }
            return;
          }
          if (newline > 65_536) { throw new SupervisorError('result-invalid', 'Owned-process header exceeds its bound.'); }
          const value = parseStrictJson(this.header.subarray(0, newline));
          if (!hasExactKeys(value, ['ownedProcessVersion', 'jobName', 'pid', 'created']) || asInteger(value['ownedProcessVersion']) !== 1 || value['jobName'] !== jobName || typeof value['created'] !== 'string' || !creationToken.test(value['created'])) {
            throw new SupervisorError('result-invalid', 'Invalid owned-process header.');
          }
          const pid = asInteger(value['pid']);
          if (pid === undefined || pid < 1 || pid > 2147483647) { throw new SupervisorError('result-invalid', 'Invalid owned child identity.'); }
          this.identity = { pid, created: value['created'] };
          this.resolveReady(this.identity);
          chunk = this.header.subarray(newline + 1);
          this.header = Buffer.alloc(0);
        }
        if (chunk.length > 0 && !this.stdout.write(chunk)) {
          this.broker.stdout.pause();
          this.stdout.once('drain', () => this.broker.stdout.resume());
        }
      } catch (error) { fail(error as Error); }
    });
    this.broker.stderr.on('data', (chunk: Buffer) => {
      if (failing) { return; }
      if (!this.stderr.write(chunk)) {
        this.broker.stderr.pause();
        this.stderr.once('drain', () => this.broker.stderr.resume());
      }
    });
    this.broker.stdout.once('end', () => this.stdout.end());
    this.broker.stderr.once('end', () => this.stderr.end());
    const abort = (): void => { this.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.broker.once('close', (code, signal) => {
      this.closed = true;
      this.verification = 'verifying';
      options.signal?.removeEventListener('abort', abort);
      if (this.identity === null) {
        this.failure ??= new SupervisorError('abnormal-exit', 'Helper exited before child identity was received.');
        this.rejectReady(this.failure);
      }
      void verifyTermination().then(() => {
        this.verification = 'verified';
        this.resolveTermination({ code, signal, failure: this.failure });
        this.emit('exit', code, signal);
      }, error => {
        this.verification = 'unverified';
        const failure = new SupervisorError('termination-unverified', `Process-tree termination is unverified: ${(error as Error).message}`);
        this.rejectTermination(failure);
        this.emit('error', failure);
      });
    });
    try { this.broker.stdin.write(frame + '\n'); }
    catch (error) { fail(error as Error); }
  }

  get killed(): boolean { return this.broker.killed; }
  get brokerPid(): number | undefined { return this.broker.pid; }
  get brokerClosed(): boolean { return this.closed; }
  get terminationState(): 'running' | 'verifying' | 'verified' | 'unverified' { return this.verification; }
  get exitCode(): number | null { return this.broker.exitCode; }
  get signalCode(): NodeJS.Signals | null { return this.broker.signalCode; }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { return this.broker.kill(signal); }
}

export class ProcessSupervisor {
  private readonly parent: ProcessIdentity;
  private readonly scope: string;
  private readonly active = new Map<ProcessRole, OwnedProcess | null>();
  private readonly stopping = new Map<ProcessRole, Promise<void>>();
  private startupJobObserver: ((names: readonly string[], timeoutMs: number) => Promise<readonly boolean[]>) | null = null;

  private constructor(parent: ProcessIdentity, canonicalScope: string) { this.parent = parent; this.scope = guardScopeToken(canonicalScope); }

  static async create(canonicalScope: string): Promise<ProcessSupervisor> {
    const parent = await readProcessIdentity(process.pid);
    if (parent === null) { throw new SupervisorError('termination-unverified', 'Runtime process identity is unavailable.'); }

    return new ProcessSupervisor(parent, canonicalScope);
  }

  forScope(canonicalScope: string): ProcessSupervisor {
    return new ProcessSupervisor(this.parent, canonicalScope);
  }

  jobName(role: ProcessRole): string { return ['Global', `game-companion-process-${this.scope}-${role}`].join(path.win32.sep); }

  attachStartupJobObserver(observer: (names: readonly string[], timeoutMs: number) => Promise<readonly boolean[]>): void {
    if (this.startupJobObserver !== null) { throw new SupervisorError('result-invalid', 'Startup job observer is already attached.'); }
    this.startupJobObserver = observer;
  }

  clearStartupJobObserver(): void { this.startupJobObserver = null; }

  private async observeUnownedJobs(names: readonly string[], timeoutMs: number): Promise<readonly boolean[]> {
    const observer = this.startupJobObserver;
    if (observer === null || names.includes(this.jobName('startupMetadata')) || names.includes(this.jobName('metadata'))) {
      return names.length === 1 ? [await jobAbsent(names[0]!, timeoutMs)] : jobsAbsent(names, undefined, timeoutMs);
    }
    let result: readonly boolean[];
    try { result = await observer([...names], timeoutMs); }
    catch { throw new SupervisorError('termination-unverified', 'Startup job observation is unavailable.'); }
    if (result.length !== names.length || result.some(value => typeof value !== 'boolean')) {
      throw new SupervisorError('termination-unverified', 'Startup job observation is invalid.');
    }
    return result;
  }

  async observeJobAbsent(role: ProcessRole): Promise<boolean> {
    const owner = this.active.get(role);
    if (owner !== undefined) { throw new SupervisorError('termination-unverified', 'An in-process owner is still starting or running.'); }
    const absent = (await this.observeUnownedJobs([this.jobName(role)], 5000))[0]!;
    if (this.active.get(role) !== owner) { throw new SupervisorError('termination-unverified', 'Process ownership changed during verification.'); }
    return absent;
  }

  async verifyQuiescent(role: ProcessRole): Promise<void> {
    const owner = this.active.get(role);
    if (owner?.terminationState === 'verifying') { await owner.terminated; return; }
    await this.verifyOwner(role, owner);
  }

  async verifyQuiescentMany(roles: readonly ProcessRole[]): Promise<void> {
    if (roles.length < 1 || roles.length > processRoles.length || new Set(roles).size !== roles.length
      || roles.some(role => !(processRoles as readonly string[]).includes(role))) {
      throw new SupervisorError('result-invalid', 'Invalid process-role batch.');
    }
    const owners = new Map<ProcessRole, OwnedProcess | null | undefined>();
    for (const role of roles) {
      const owner = this.active.get(role);
      if (owner?.terminationState === 'verifying') { await owner.terminated; }
      const current = this.active.get(role);
      if (current === null || current !== undefined && !current.brokerClosed) {
        throw new SupervisorError('termination-unverified', 'An in-process owner is still starting or running.');
      }
      owners.set(role, current);
    }
    const names = roles.map(role => this.jobName(role));
    let absent = await this.observeUnownedJobs(names, 5000);
    if (absent.some(value => !value)) {
      for (const [index, role] of roles.entries()) {
        if (absent[index]) { continue; }
        const owner = owners.get(role);
        await this.verifyOwner(role, owner);
        owners.set(role, undefined);
      }
      absent = await this.observeUnownedJobs(names, 5000);
    }
    for (const [index, role] of roles.entries()) {
      const owner = owners.get(role);
      if (this.active.get(role) !== owner) { throw new SupervisorError('termination-unverified', 'Process ownership changed during verification.'); }
      if (!absent[index]) { throw new SupervisorError('termination-unverified', 'A predecessor process job is still present.'); }
      this.active.delete(role);
    }
  }

  private async verifyOwner(role: ProcessRole, owner: OwnedProcess | null | undefined): Promise<void> {
    if (this.active.get(role) !== owner) { throw new SupervisorError('termination-unverified', 'Process ownership changed before verification.'); }
    if (owner === null || owner !== undefined && !owner.brokerClosed) { throw new SupervisorError('termination-unverified', 'An in-process owner is still starting or running.'); }
    const deadline = performance.now() + 5000;
    do {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { break; }
      if ((await this.observeUnownedJobs([this.jobName(role)], remaining))[0]) {
        if (this.active.get(role) !== owner) { throw new SupervisorError('termination-unverified', 'Process ownership changed during verification.'); }
        this.active.delete(role);
        return;
      }
      await wait(25);
    } while (performance.now() < deadline);
    throw new SupervisorError('termination-unverified', 'A predecessor process job is still present.');
  }

  async admitStartup(allowOwnedStartupMetadata = false): Promise<void> {
    const owners = new Map<ProcessRole, OwnedProcess | null | undefined>();
    let metadataIdentity: ProcessIdentity | undefined;
    for (const role of processRoles) {
      const owner = this.active.get(role);
      if (owner?.terminationState === 'verifying') { await owner.terminated; }
      const current = this.active.get(role);
      if (role === 'startupMetadata' && allowOwnedStartupMetadata
        && current !== undefined && current !== null && !current.brokerClosed
        && !this.stopping.has(role) && current.terminationState === 'running') {
        const identity = await current.ready;
        if (current.brokerClosed || this.active.get(role) !== current || this.stopping.has(role)) {
          throw new SupervisorError('termination-unverified', 'Owned startup process changed during admission.');
        }
        metadataIdentity = identity;
        owners.set(role, current);
        continue;
      }
      if (current === null || current !== undefined && !current.brokerClosed) {
        throw new SupervisorError('termination-unverified', 'An in-process owner is still starting or running.');
      }
      owners.set(role, current);
    }
    if (allowOwnedStartupMetadata && metadataIdentity === undefined) {
      throw new SupervisorError('termination-unverified', 'Owned startup metadata process is unavailable.');
    }
    const metadataOwner = owners.get('startupMetadata');
    const brokerPid = metadataOwner?.brokerPid;
    if (metadataIdentity !== undefined && (brokerPid === undefined || !Number.isSafeInteger(brokerPid) || brokerPid < 1)) {
      throw new SupervisorError('termination-unverified', 'Owned startup metadata broker identity is unavailable.');
    }
    const absent = await jobsAbsent(processRoles.map(role => this.jobName(role)), metadataIdentity === undefined ? undefined
      : { name: this.jobName('startupMetadata'), identity: metadataIdentity, brokerPid: brokerPid! });
    for (const [index, role] of processRoles.entries()) {
      if (this.active.get(role) !== owners.get(role)) { throw new SupervisorError('termination-unverified', 'Process ownership changed during startup admission.'); }
      if (role === 'startupMetadata' && metadataIdentity !== undefined) {
        const owner = owners.get(role);
        if (absent[index] || owner === undefined || owner === null || owner.brokerClosed || owner.terminationState !== 'running' || this.stopping.has(role)) {
          throw new SupervisorError('termination-unverified', 'Owned startup metadata job changed during admission.');
        }
        continue;
      }
      if (absent[index]) { this.active.delete(role); }
      else { await this.verifyQuiescent(role); }
    }
  }

  stop(role: ProcessRole, graceMs = 0): Promise<void> {
    if (!(processRoles as readonly string[]).includes(role) || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30000) {
      return Promise.reject(new SupervisorError('result-invalid', 'Invalid process stop request.'));
    }
    const existing = this.stopping.get(role);
    if (existing !== undefined) { return existing; }
    // Deferring one microtask registers the stop before any admission can race it.
    const pending = Promise.resolve().then(async () => {
      const owner = this.active.get(role);
      if (owner === null) { throw new SupervisorError('termination-unverified', 'A process owner is still starting.'); }
      if (owner === undefined || owner.terminationState === 'unverified') { await this.verifyQuiescent(role); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (graceMs > 0 && !owner.brokerClosed) {
          await Promise.race([owner.terminated, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
          clearTimeout(timer);
        }
        if (!owner.brokerClosed && !owner.kill()) { throw new SupervisorError('termination-unverified', 'Owned process termination could not be requested.'); }
        await Promise.race([owner.terminated, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SupervisorError('termination-unverified', 'Owned process termination did not become verifiable.')), 10000);
        })]);
        await this.verifyQuiescent(role);
      } finally { clearTimeout(timer); }
    });
    this.stopping.set(role, pending);
    void pending.then(() => this.stopping.delete(role), () => this.stopping.delete(role));
    return pending;
  }

  spawn(role: ProcessRole, options: OwnedSpawnOptions): OwnedProcess {
    if (!(processRoles as readonly string[]).includes(role)) { throw new SupervisorError('result-invalid', 'Unknown process role.'); }
    if (this.active.has(role) || this.stopping.has(role)) { throw new SupervisorError('termination-unverified', 'The previous process still owns this queue.'); }
    this.active.set(role, null);
    try {
      let child: OwnedProcess;
      child = new OwnedProcess(this.jobName(role), this.parent, options, () => this.verifyOwner(role, child));
      this.active.set(role, child);
      return child;
    }
    catch (error) { this.active.delete(role); throw error; }
  }

  async run(role: ProcessRole, options: OwnedSpawnOptions, timeoutMs: number, input?: Uint8Array): Promise<CommandResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) { throw new SupervisorError('result-invalid', 'Invalid child deadline.'); }
    if (input !== undefined && input.byteLength > 1_048_576) { throw new SupervisorError('result-invalid', 'Finite child control input exceeds its budget.'); }
    const frozenInput = input === undefined ? undefined : Buffer.from(input);
    const child = this.spawn(role, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: SupervisorReason | null = null;
    const timer = setTimeout(() => { failure ??= 'deadline'; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 65_536) { failure ??= 'capture-overflow'; stdout.length = 0; child.kill(); }
      else if (failure === null) { stdout.push(chunk); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 65_536) { failure ??= 'capture-overflow'; stderr.length = 0; child.kill(); }
      else if (failure === null) { stderr.push(chunk); }
    });
    child.stdin.end(frozenInput);
    try {
      const exit = await child.terminated;
      if (failure !== null) { throw new SupervisorError(failure, `Owned child failed: ${failure}.`); }
      if (exit.failure !== null) { throw exit.failure instanceof SupervisorError ? exit.failure : new SupervisorError('result-invalid', exit.failure.message); }
      if (exit.code === null || exit.code < 0 || exit.code > 1) { throw new SupervisorError('abnormal-exit', 'Owned child ended abnormally.'); }

      return { exitCode: exit.code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    } finally { clearTimeout(timer); }
  }
}
