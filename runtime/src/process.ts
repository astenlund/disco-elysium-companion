import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, type Writable } from 'node:stream';

import { guardScopeToken } from './guard.ts';
import { asInteger, hasExactKeys, parseStrictJson, stringifyJson, type JsonValue } from './json.ts';
import { boundServiceOwner, withoutHome, type NativeHelper } from './native-helper.ts';

/** Roles the supervisor launches through a broker. */
export const processRoles = ['core', 'provider', 'watcher', 'metadata', 'startupCoreReply'] as const;
export type ProcessRole = typeof processRoles[number];
/** Job names that no longer launch but still take part in predecessor proof. */
export const retiredJobRoles = ['publication', 'startupMetadata', 'startupMutation'] as const;
export type RetiredJobRole = typeof retiredJobRoles[number];
export type JobRole = ProcessRole | RetiredJobRole | 'helper';
export type SupervisorReason = 'deadline' | 'capture-overflow' | 'abnormal-exit' | 'result-invalid' | 'termination-unverified';
export class SupervisorError extends Error {
  override readonly name = 'SupervisorError';
  readonly reason: SupervisorReason;
  constructor(reason: SupervisorReason, message: string, options?: ErrorOptions) { super(message, options); this.reason = reason; }
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

const creationToken = /^[1-9][0-9]{0,18}$/;
/** A present retired name, or a helper job before binding, may still be ending: it gets this bounded absence poll. */
const predecessorPollMs = 5000;
const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

/** @internal Freeze the child environment that the broker's control frame carries. */
export function childEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = Object.create(null) as Record<string, string>;
  const folded = new Set<string>();
  for (const name of Object.keys(source).sort()) {
    const value = source[name];
    if (value === undefined) { continue; }
    if (name.length === 0 || name.includes('=') || name.includes(String.fromCharCode(0))
      || typeof value !== 'string' || value.includes(String.fromCharCode(0))) {
      throw new SupervisorError('result-invalid', 'Owned child environment is not representable.');
    }
    const key = name.toUpperCase();
    if (!folded.has(key)) { folded.add(key); selected[name] = value; }
  }
  return selected;
}

/**
 * Launches the Go broker from the helper image, with the child's environment minus HOME; the child itself receives its
 * environment through the control frame. A launch the helper cannot attest is refused before any process is created.
 */
export function helperBrokerSpawn(helper: Pick<NativeHelper, 'brokerImage'>): BrokerSpawn {
  return options => {
    let image: string;
    try { image = helper.brokerImage(); }
    catch (error) { throw new SupervisorError('termination-unverified', 'No verified native helper attests the broker image.', { cause: error }); }
    return spawn(image, ['broker'], { cwd: options.cwd, env: withoutHome(options.env ?? process.env), shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
  };
}

async function helperResult(helper: Pick<NativeHelper, 'request'>, op: 'processIdentity' | 'jobStates' | 'ownedProcessLive',
  fields: Record<string, unknown>, timeoutMs: number): Promise<JsonValue> {
  let reply;
  try { reply = await helper.request(op, fields, timeoutMs); }
  catch (error) { throw new SupervisorError('termination-unverified', 'Native process metadata is unavailable.', { cause: error }); }
  if (reply.status !== 'ok') { throw new SupervisorError('termination-unverified', 'Native process metadata is unavailable.'); }
  return reply.result;
}

export async function readProcessIdentity(helper: Pick<NativeHelper, 'request'>, pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) { throw new SupervisorError('result-invalid', 'Invalid process identifier.'); }
  const value = await helperResult(helper, 'processIdentity', { pid }, 5000);
  if (!hasExactKeys(value, ['exists', 'pid', 'created']) || asInteger(value['pid']) !== pid || typeof value['exists'] !== 'boolean') {
    throw new SupervisorError('result-invalid', 'Invalid process identity response.');
  }
  if (!value['exists'] && value['created'] === null) { return null; }
  if (value['exists'] && typeof value['created'] === 'string' && creationToken.test(value['created'])) { return { pid, created: value['created'] }; }
  throw new SupervisorError('result-invalid', 'Invalid process creation identity.');
}

/** @internal A partial or reordered batch cannot establish quiescence. */
export function parseJobStates(value: JsonValue, names: readonly string[]): readonly boolean[] {
  if (!hasExactKeys(value, ['jobs']) && !hasExactKeys(value, ['jobs', 'owned'])) {
    throw new SupervisorError('termination-unverified', 'Job observations are incomplete.');
  }
  const jobs = value['jobs'];
  if (!Array.isArray(jobs) || jobs.length !== names.length) { throw new SupervisorError('termination-unverified', 'Job observations are incomplete.'); }
  return jobs.map((entry, index) => {
    if (!hasExactKeys(entry, ['name', 'state', 'processes']) || entry['name'] !== names[index]) {
      throw new SupervisorError('termination-unverified', 'Job observation identity is invalid.');
    }
    if (entry['state'] === 'absent' && entry['processes'] === null) { return true; }
    const count = asInteger(entry['processes']);
    if (entry['state'] === 'present' && count !== undefined && count >= 0) { return false; }
    throw new SupervisorError('termination-unverified', 'Job state is unavailable.');
  });
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
  private brokerIdentity: ProcessIdentity | null = null;
  private closed = false;
  private verification: 'running' | 'verifying' | 'verified' | 'unverified' = 'running';
  private resolveReady!: (identity: ProcessIdentity) => void;
  private rejectReady!: (error: Error) => void;
  private resolveTermination!: (exit: OwnedExit) => void;
  private rejectTermination!: (error: Error) => void;

  constructor(jobName: string, parent: ProcessIdentity, options: OwnedSpawnOptions, verifyTermination: () => Promise<void>, createBroker: BrokerSpawn) {
    super();
    options.signal?.throwIfAborted();
    const frame = stringifyJson({ command: options.command, args: options.args, cwd: options.cwd, jobName, parentPid: parent.pid, parentCreated: parent.created,
      brokerProtocolVersion: 2, childEnvironment: childEnvironment(options.env ?? process.env) });
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
          if (!hasExactKeys(value, ['ownedProcessVersion', 'jobName', 'pid', 'created', 'brokerPid', 'brokerCreated'])
            || asInteger(value['ownedProcessVersion']) !== 1 || value['jobName'] !== jobName
            || typeof value['created'] !== 'string' || !creationToken.test(value['created'])
            || typeof value['brokerCreated'] !== 'string' || !creationToken.test(value['brokerCreated'])) {
            throw new SupervisorError('result-invalid', 'Invalid owned-process header.');
          }
          const pid = asInteger(value['pid']);
          const brokerPid = asInteger(value['brokerPid']);
          if (pid === undefined || pid < 1 || pid > 2147483647 || brokerPid === undefined || brokerPid < 1
            || brokerPid > 2147483647 || brokerPid === pid || brokerPid !== this.broker.pid) {
            throw new SupervisorError('result-invalid', 'Invalid owned process identities.');
          }
          this.identity = { pid, created: value['created'] };
          this.brokerIdentity = { pid: brokerPid, created: value['brokerCreated'] };
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
  get ownedBrokerIdentity(): ProcessIdentity | null { return this.brokerIdentity; }
  get brokerClosed(): boolean { return this.closed; }
  get terminationState(): 'running' | 'verifying' | 'verified' | 'unverified' { return this.verification; }
  get exitCode(): number | null { return this.broker.exitCode; }
  get signalCode(): NodeJS.Signals | null { return this.broker.signalCode; }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { return this.broker.kill(signal); }
}

export class ProcessSupervisor {
  private readonly parent: ProcessIdentity;
  private readonly scope: string;
  private readonly helper: NativeHelper;
  private readonly createBroker: BrokerSpawn;
  private readonly active = new Map<ProcessRole, OwnedProcess | null>();
  private readonly stopping = new Map<ProcessRole, Promise<void>>();

  private constructor(parent: ProcessIdentity, canonicalScope: string, helper: NativeHelper, createBroker: BrokerSpawn) {
    this.parent = parent; this.scope = guardScopeToken(canonicalScope); this.helper = helper; this.createBroker = createBroker;
  }

  static async create(canonicalScope: string, helper: NativeHelper, createBroker: BrokerSpawn = helperBrokerSpawn(helper)): Promise<ProcessSupervisor> {
    // The runtime's own identity comes from the helper; children name it as the parent their job must outlive.
    const parent = await readProcessIdentity(helper, process.pid);
    if (parent === null) { throw new SupervisorError('termination-unverified', 'Runtime process identity is unavailable.'); }

    return new ProcessSupervisor(parent, canonicalScope, helper, createBroker);
  }

  forScope(canonicalScope: string): ProcessSupervisor {
    return new ProcessSupervisor(this.parent, canonicalScope, this.helper, this.createBroker);
  }

  parentIdentity(): ProcessIdentity { return Object.freeze({ ...this.parent }); }

  get scopeToken(): string { return this.scope; }

  get nativeHelper(): NativeHelper { return this.helper; }

  jobName(role: JobRole): string { return ['Global', `game-companion-process-${this.scope}-${role}`].join(path.win32.sep); }

  private async observeJobs(names: readonly string[], timeoutMs: number,
    owner: typeof boundServiceOwner | null = null): Promise<{ absent: readonly boolean[]; owned: boolean | null }> {
    const value = await helperResult(this.helper, 'jobStates', { names, owner }, timeoutMs);
    const absent = parseJobStates(value, names);
    if (owner === null) {
      if (hasExactKeys(value, ['jobs', 'owned'])) { throw new SupervisorError('termination-unverified', 'Unexpected owned observation.'); }
      return { absent, owned: null };
    }
    if (!hasExactKeys(value, ['jobs', 'owned']) || typeof value['owned'] !== 'boolean') {
      throw new SupervisorError('termination-unverified', 'Owned helper job membership is unverified.');
    }
    return { absent, owned: value['owned'] };
  }

  /**
   * Before binding, right after the instance guard: the helper job and every retired name must be positively absent. A
   * present one is polled briefly, since a predecessor that is still ending must not fail a quick restart.
   */
  async proveBindable(): Promise<void> {
    const names = [this.jobName('helper'), ...retiredJobRoles.map(role => this.jobName(role))];
    const until = performance.now() + predecessorPollMs;
    for (;;) {
      const { absent } = await this.observeJobs(names, 30000);
      if (absent.every(value => value)) { return; }
      if (performance.now() >= until) { throw new SupervisorError('termination-unverified', 'A predecessor helper or retired job is still present.'); }
      await wait(50);
    }
  }

  /**
   * After binding: the helper job must hold exactly this runtime's bound service and each named retired job must be
   * positively absent, a present one polled briefly. Startup admission names every retired role; the pre-marker residue
   * pass names only the publication writers.
   */
  async proveNoForeignWriters(retired: readonly RetiredJobRole[] = retiredJobRoles): Promise<void> {
    const names = [this.jobName('helper'), ...retired.map(role => this.jobName(role))];
    const until = performance.now() + predecessorPollMs;
    for (;;) {
      const { absent, owned } = await this.observeJobs(names, 30000, boundServiceOwner);
      if (absent[0] || owned !== true) { throw new SupervisorError('termination-unverified', 'The helper job holds a member other than this runtime\'s service.'); }
      if (absent.slice(1).every(value => value)) { return; }
      if (performance.now() >= until) { throw new SupervisorError('termination-unverified', 'A retired predecessor job is still present.'); }
      await wait(50);
    }
  }

  async observeJobAbsent(role: ProcessRole): Promise<boolean> {
    const owner = this.active.get(role);
    if (owner !== undefined) { throw new SupervisorError('termination-unverified', 'An in-process owner is still starting or running.'); }
    const absent = (await this.observeJobs([this.jobName(role)], 5000)).absent[0]!;
    if (this.active.get(role) !== owner) { throw new SupervisorError('termination-unverified', 'Process ownership changed during verification.'); }
    return absent;
  }

  async verifyQuiescent(role: ProcessRole): Promise<void> {
    const owner = this.active.get(role);
    if (owner?.terminationState === 'verifying') { await owner.terminated; return; }
    await this.verifyOwner(role, owner);
  }

  async verifyOwnedLive(role: 'provider', child: OwnedProcess, identity: ProcessIdentity): Promise<void> {
    if (role !== 'provider' || this.active.get(role) !== child || child.brokerClosed || child.terminationState !== 'running' || this.stopping.has(role)
      || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || identity.pid > 2147483647 || !creationToken.test(identity.created)) {
      throw new SupervisorError('termination-unverified', 'Owned provider process identity is unavailable.');
    }
    const ready = await child.ready;
    if (ready.pid !== identity.pid || ready.created !== identity.created || this.active.get(role) !== child || child.brokerClosed) {
      throw new SupervisorError('termination-unverified', 'Owned provider process changed before verification.');
    }
    const result = await helperResult(this.helper, 'ownedProcessLive', { jobName: this.jobName(role), pid: identity.pid, created: identity.created }, 5000);
    if (!hasExactKeys(result, ['live']) || result['live'] !== true || this.active.get(role) !== child || child.brokerClosed || child.terminationState !== 'running' || this.stopping.has(role)) {
      throw new SupervisorError('termination-unverified', 'Owned provider process liveness is unverified.');
    }
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
    let absent = (await this.observeJobs(names, 5000)).absent;
    if (absent.some(value => !value)) {
      for (const [index, role] of roles.entries()) {
        if (absent[index]) { continue; }
        await this.verifyOwner(role, owners.get(role));
        owners.set(role, undefined);
      }
      absent = (await this.observeJobs(names, 5000)).absent;
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
      if ((await this.observeJobs([this.jobName(role)], remaining)).absent[0]) {
        if (this.active.get(role) !== owner) { throw new SupervisorError('termination-unverified', 'Process ownership changed during verification.'); }
        this.active.delete(role);
        return;
      }
      await wait(25);
    } while (performance.now() < deadline);
    throw new SupervisorError('termination-unverified', 'A predecessor process job is still present.');
  }

  /**
   * Startup predecessor admission under the held guard: every launch role, the bound helper job as an owned observation and
   * every retired name. A present launch role takes the quiescence path; a foreign helper or a present retired name fails closed.
   */
  async admitStartup(): Promise<void> {
    const owners = new Map<ProcessRole, OwnedProcess | null | undefined>();
    for (const role of processRoles) {
      const owner = this.active.get(role);
      if (owner?.terminationState === 'verifying') { await owner.terminated; }
      const current = this.active.get(role);
      if (current === null || current !== undefined && !current.brokerClosed) {
        throw new SupervisorError('termination-unverified', 'An in-process owner is still starting or running.');
      }
      owners.set(role, current);
    }
    await this.proveNoForeignWriters();
    const names = processRoles.map(role => this.jobName(role));
    const { absent } = await this.observeJobs(names, 30000);
    for (const [index, role] of processRoles.entries()) {
      if (this.active.get(role) !== owners.get(role)) { throw new SupervisorError('termination-unverified', 'Process ownership changed during startup admission.'); }
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
      child = new OwnedProcess(this.jobName(role), this.parent, options, () => this.verifyOwner(role, child), this.createBroker);
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
