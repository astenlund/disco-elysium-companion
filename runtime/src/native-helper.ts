import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { asInteger, hasExactKeys, parseStrictJson, stringifyJson, type JsonBudget, type JsonValue } from './json.ts';
import { NativeHelperUnavailableError } from './native-helper-error.ts';
import { observeImageFile, type HelperImage } from './native-image.ts';

/** Requests a caller may send; bindScope belongs to this module. */
export type HelperOperation = 'admit' | 'hash' | 'inventory' | 'eventMetadata' | 'eventBatch' | 'publish' | 'codec' | 'contextPreparation'
  | 'fileAction' | 'principal' | 'processIdentity' | 'jobStates' | 'ownedProcessLive' | 'stopOrphanWatcher' | 'coreReplySource';
export type HelperReply = { readonly status: 'ok'; readonly result: JsonValue } | { readonly status: 'error'; readonly code: string };
export interface HelperIdentity { readonly pid: number; readonly created: string }
export interface HelperBinding { readonly token: string; readonly companionRoot: string; readonly dataRoot: string }
export interface HelperOwner { readonly name: string; readonly pid: number; readonly created: string }

/** A request that failed because its service failed or its reply never came; the caller maps it to its own failure. */
export class HelperRequestFailedError extends Error {
  override readonly name = 'HelperRequestFailedError';
  readonly kind: 'fault' | 'missed';
  /** For a failed mutating request: whether the service's exit was observed before this error was reported. */
  exitObserved: boolean | null = null;
  constructor(kind: 'fault' | 'missed', message: string) { super(message); this.kind = kind; }
}

const maximumFrame = 2_097_152;
const frameBudget: JsonBudget = { maxBytes: maximumFrame, maxTokens: 262_144, maxTextBytes: maximumFrame };
export const maximumInFlight = 16;
const ordinarySlots = 12;
/** A request with less budget than this is refused locally, leaving the service untouched. */
export const sendFloorMs = 250;
/** Only a reply missing past its deadline plus this grace counts as a missed deadline. */
export const replyGraceMs = 5_000;
const handshakeTimeoutMs = 30_000;
const exitWaitMs = 10_000;
const helperJobPollMs = 5_000;
const creationToken = /^[1-9][0-9]{0,18}$/;
const proofOperations: ReadonlySet<string> = new Set(['jobStates', 'processIdentity', 'ownedProcessLive']);
const mutatingOperations: ReadonlySet<string> = new Set(['publish', 'codec', 'contextPreparation', 'fileAction', 'stopOrphanWatcher']);

const deadlineExceeded: HelperReply = Object.freeze({ status: 'error', code: 'deadlineExceeded' });

/** The owner field value that asks the helper to name the bound service serving an owned jobStates observation. */
export const boundServiceOwner = 'boundService';

/** Private helper processes omit HOME; a child receives its own environment through the broker's control frame. */
export function withoutHome(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name.toUpperCase() !== 'HOME'));
}

/** @internal Starts one service process from the image; tests substitute a scripted service. */
export type ServiceSpawn = (image: HelperImage, nonce: string) => ChildProcessWithoutNullStreams;

const spawnService: ServiceSpawn = (image, nonce) =>
  spawn(image.path, ['service', nonce], { env: withoutHome(process.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

function isMutating(op: string, fields: Record<string, unknown>): boolean {
  return mutatingOperations.has(op) || op === 'inventory' && fields['mode'] === 'Quarantine';
}

interface PendingReply {
  readonly op: string;
  readonly resolve: (reply: HelperReply) => void;
  readonly reject: (error: Error) => void;
}

/** One running service process: its framed reply stream, in-flight requests and missed requests awaiting late replies. */
class ServiceProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  readonly pending = new Map<number, PendingReply>();
  /** Missed requests still running inside the service: each holds one of its slots until its late reply or the exit. */
  readonly missed = new Set<number>();
  /** Whether any request of this service missed its deadline, which makes its retirement a failure, not a renewal. */
  hadMiss = false;
  identity: HelperIdentity | null = null;
  fault: Error | null = null;
  draining = false;
  nextSeq = 1;
  proofsInFlight = 0;
  ordinaryInFlight = 0;
  private stopped: Promise<boolean> | null = null;
  private resolveRetired!: (observed: boolean) => void;
  /** Settles once this service has been stopped, with whether its exit was observed. */
  readonly retired = new Promise<boolean>(resolve => { this.resolveRetired = resolve; });
  private hasExited = false;
  private buffer = Buffer.alloc(0);
  private hello: { resolve: (frame: Buffer) => void; reject: (error: Error) => void } | null = null;
  private readonly onChange: () => void;

  constructor(child: ChildProcessWithoutNullStreams, onChange: () => void) {
    this.onChange = onChange;
    this.child = child;
    this.exited = new Promise(resolve => { this.child.once('exit', () => { this.hasExited = true; resolve(); }); });
    this.child.once('error', () => this.failChannel('The native helper service could not start.'));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', () => this.failChannel('The native helper service wrote to stderr.'));
    this.child.stdin.on('error', () => this.failChannel('The native helper service input failed.'));
    void this.exited.then(() => this.failChannel('The native helper service exited.'));
    // The service alone never keeps the runtime process alive; a request in flight does, through its own timer.
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) { (stream as { unref?: () => void }).unref?.(); }
  }

  get alive(): boolean { return !this.hasExited && this.fault === null; }
  get inFlight(): number { return this.proofsInFlight + this.ordinaryInFlight; }

  awaitHello(timeoutMs: number): Promise<Buffer> {
    if (this.fault !== null) { return Promise.reject(this.fault); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failChannel('The native helper handshake timed out.'), timeoutMs);
      this.hello = { resolve: frame => { clearTimeout(timer); resolve(frame); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  }

  private receive(chunk: Buffer): void {
    if (this.fault !== null) { return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.fault === null && this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > maximumFrame) { this.failChannel('A native helper frame is out of bounds.'); return; }
      if (this.buffer.length < length + 4) { return; }
      const frame = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      this.dispatch(frame);
    }
  }

  private dispatch(frame: Buffer): void {
    const hello = this.hello;
    if (hello !== null) { this.hello = null; hello.resolve(frame); return; }
    if (this.identity === null) { this.failChannel('The native helper replied before its handshake.'); return; }
    let parsed: JsonValue;
    try { parsed = parseStrictJson(frame, frameBudget); }
    catch { this.failChannel('A native helper reply is not strict JSON.'); return; }
    const reply = hasExactKeys(parsed, ['version', 'seq', 'op', 'status', 'result']) || hasExactKeys(parsed, ['version', 'seq', 'op', 'status', 'code'])
      ? parsed : null;
    const seq = reply === null ? undefined : asInteger(reply['seq']);
    if (reply === null || seq === undefined || asInteger(reply['version']) !== 1) { this.failChannel('A native helper reply is malformed.'); return; }
    const pending = this.pending.get(seq);
    if (pending === undefined) {
      // The late reply of a request already failed for its deadline is a valid frame and is discarded.
      if (this.missed.delete(seq)) { this.onChange(); return; }
      this.failChannel('A native helper reply names no request in flight.');
      return;
    }
    if (reply['op'] !== pending.op) { this.failChannel('A native helper reply names another operation.'); return; }
    // The entry stays pending until its reply validates, so a channel fault raised for an invalid reply rejects it too.
    if (reply['status'] === 'ok' && 'result' in reply) {
      this.pending.delete(seq);
      pending.resolve({ status: 'ok', result: reply['result']! });
    } else if (reply['status'] === 'error' && typeof reply['code'] === 'string' && /^[a-zA-Z]{1,64}$/.test(reply['code'])) {
      this.pending.delete(seq);
      pending.resolve({ status: 'error', code: reply['code'] });
    } else { this.failChannel('A native helper reply status is invalid.'); }
  }

  /** A fault of the whole process: every request in flight fails and the process is stopped. */
  failChannel(message: string): void {
    if (this.fault !== null) { return; }
    const error = new HelperRequestFailedError('fault', message);
    this.fault = error;
    this.hello?.reject(error);
    this.hello = null;
    for (const pending of this.pending.values()) { pending.reject(error); }
    this.pending.clear();
    if (!this.hasExited) { this.child.kill(); }
    this.onChange();
  }

  /** One request alone missed its deadline plus grace: it fails, and its late reply will be discarded. */
  miss(seq: number): void {
    const pending = this.pending.get(seq);
    if (pending === undefined) { return; }
    this.pending.delete(seq);
    this.missed.add(seq);
    this.hadMiss = true;
    pending.reject(new HelperRequestFailedError('missed', 'The native helper reply missed its deadline.'));
    this.onChange();
  }

  write(value: unknown): void {
    const body = Buffer.from(stringifyJson(value, frameBudget), 'utf8');
    if (body.length < 1 || body.length > maximumFrame) { throw new HelperRequestFailedError('fault', 'A native helper request exceeds its bound.'); }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  /** Closes the input and observes the exit, stopping the process when it lingers; false when no exit was observed. */
  stop(): Promise<boolean> {
    this.stopped ??= (async () => {
      if (this.hasExited) { return true; }
      // A stopping service keeps the runtime process alive until its exit is observed, so shutdown cannot end before it.
      this.child.ref();
      this.child.stdin.end();
      const exited = (milliseconds: number): Promise<boolean> => Promise.race([this.exited.then(() => true),
        new Promise<boolean>(resolve => { setTimeout(() => resolve(false), milliseconds).unref(); })]);
      if (await exited(exitWaitMs)) { return true; }
      this.child.kill();
      return exited(exitWaitMs);
    })();
    void this.stopped.then(observed => this.resolveRetired(observed));
    return this.stopped;
  }
}

type Phase = 'ready' | 'replacing' | 'exhausted' | 'closed';

/**
 * The runtime's long-lived native helper service. Up to sixteen requests run concurrently, four slots reserved for proofs;
 * a single missed deadline fails that request alone and drains the service, while an exit or invalid frame fails every
 * request in flight. A failure restarts the service at most once; renewal at the sequence bound is not a failure.
 */
export class NativeHelper {
  private readonly image: HelperImage;
  private readonly sequenceLimit: number;
  private readonly spawnService: ServiceSpawn;
  private current: ServiceProcess | null = null;
  private phase: Phase = 'ready';
  private restartsLeft = 1;
  private binding: HelperBinding | null = null;
  private exclusive = false;
  private retiring: Promise<void> | null = null;
  private waiters: (() => void)[] = [];

  private constructor(image: HelperImage, sequenceLimit: number, launcher: ServiceSpawn) { this.image = image; this.sequenceLimit = sequenceLimit; this.spawnService = launcher; }

  /**
   * Starts and verifies the service from an image whose pin the caller has already checked. The sequence limit and the
   * launcher exist for tests: a low limit drives renewal, and a launcher substitutes a scripted service.
   */
  static async start(image: HelperImage, sequenceLimit = Number.MAX_SAFE_INTEGER, launcher: ServiceSpawn = spawnService): Promise<NativeHelper> {
    const helper = new NativeHelper(image, sequenceLimit, launcher);
    helper.current = await helper.launch();
    return helper;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) { wake(); }
  }

  private change(): void {
    const current = this.current;
    if (current !== null && this.phase === 'ready') {
      if (current.fault !== null) { void this.retire(current, 'failure'); }
      else if (current.missed.size > 0 && !current.draining) { this.drain(current); }
      else if (current.draining && current.inFlight === 0) { void this.retire(current, 'failure'); }
    }
    this.notify();
  }

  /** Waits for a change of state; false when the deadline passed first. */
  private waitChange(deadline: number): Promise<boolean> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) { return Promise.resolve(false); }
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(waiter => waiter !== wake); resolve(false); }, remaining);
      const wake = (): void => { clearTimeout(timer); resolve(true); };
      this.waiters.push(wake);
    });
  }

  private async launch(): Promise<ServiceProcess> {
    // The prelaunch observation: hash and identity through one descriptor, compared to the pin and later to the handshake.
    const observed = observeImageFile(this.image.path);
    if (observed === null) { throw new NativeHelperUnavailableError('imageAbsent'); }
    if (observed.sha256 !== this.image.sha256) { throw new NativeHelperUnavailableError('imagePinMismatch'); }
    const nonce = randomBytes(16).toString('hex');
    const service = new ServiceProcess(this.spawnService(this.image, nonce), () => this.change());
    try {
      const hello = parseStrictJson(await service.awaitHello(handshakeTimeoutMs), frameBudget);
      if (!hasExactKeys(hello, ['version', 'nonce', 'pid', 'created', 'imageSha256', 'imageVolume', 'imageFileId'])
        || asInteger(hello['version']) !== 1 || hello['nonce'] !== nonce || asInteger(hello['pid']) !== service.child.pid
        || typeof hello['created'] !== 'string' || !creationToken.test(hello['created'])) {
        throw new NativeHelperUnavailableError('serviceStart');
      }
      if (hello['imageSha256'] !== this.image.sha256 || hello['imageVolume'] !== observed.volume || hello['imageFileId'] !== observed.fileId) {
        throw new NativeHelperUnavailableError('imageIdentityMismatch');
      }
      service.identity = { pid: service.child.pid!, created: hello['created'] };
      return service;
    } catch (error) {
      service.failChannel('The native helper handshake failed.');
      await service.stop();
      throw error instanceof NativeHelperUnavailableError ? error : new NativeHelperUnavailableError('serviceStart');
    }
  }

  /** Stops sending ordinary requests to a service with a missed request; it retires once the others have settled. */
  private drain(service: ServiceProcess): void {
    service.draining = true;
    if (service.inFlight === 0) { void this.retire(service, 'failure'); }
  }

  /**
   * Stops a service, observes its exit and, unless the helper is closing, starts and binds a replacement. A failure uses
   * the single restart; a renewal does not. When an exit cannot be observed or no restart is left, the helper is exhausted.
   */
  private retire(service: ServiceProcess, cause: 'failure' | 'renewal'): Promise<void> {
    if (this.current !== service || this.phase !== 'ready') { return Promise.resolve(); }
    this.phase = 'replacing';
    this.notify();
    const replacing = this.replace(service, cause);
    this.retiring = replacing;
    return replacing;
  }

  /** The replacement loop of retire; close waits for it, so no service it starts outlives close. */
  private async replace(service: ServiceProcess, cause: 'failure' | 'renewal'): Promise<void> {
    let stopping = service;
    let renewal = cause === 'renewal';
    for (;;) {
      const observed = await stopping.stop();
      if (this.phase !== 'replacing') { return; }
      if (!observed || !renewal && this.restartsLeft < 1) { this.phase = 'exhausted'; this.notify(); return; }
      if (!renewal) { this.restartsLeft -= 1; }
      let replacement: ServiceProcess | null = null;
      try {
        replacement = await this.launch();
        this.current = replacement;
        if (this.binding !== null) { await this.rebind(replacement, this.binding); }
        if (this.phase === 'replacing') { this.phase = 'ready'; }
        this.notify();
        return;
      } catch {
        // A replacement that failed to start, verify or bind is a service failure: it takes the single restart, once
        // its own exit has been observed.
        if (replacement === null) {
          if (this.phase === 'replacing' && (renewal ? this.restartsLeft < 1 : true)) { this.phase = 'exhausted'; this.notify(); return; }
          renewal = false;
          continue;
        }
        stopping = replacement;
        renewal = false;
      }
    }
  }

  private helperJobName(token: string): string { return `Global\\game-companion-process-${token}-helper`; }

  /** Binds a replacement once a fresh observation, polled briefly, proves the old service's helper job absent. */
  private async rebind(service: ServiceProcess, binding: HelperBinding): Promise<void> {
    const name = this.helperJobName(binding.token);
    const until = performance.now() + helperJobPollMs;
    for (;;) {
      const reply = await this.exchange(service, 'jobStates', { names: [name], owner: null }, until + 30_000);
      const jobs = reply.status === 'ok' && hasExactKeys(reply.result, ['jobs']) ? reply.result['jobs'] : null;
      const entry = Array.isArray(jobs) && jobs.length === 1 ? jobs[0] : null;
      if (!hasExactKeys(entry, ['name', 'state', 'processes'])) { throw new NativeHelperUnavailableError('bindFailed'); }
      if (entry['state'] === 'absent') { break; }
      if (performance.now() >= until) { throw new NativeHelperUnavailableError('bindFailed'); }
      await new Promise(resolve => { setTimeout(resolve, 50); });
    }
    const bound = await this.exchange(service, 'bindScope', { token: binding.token, companionRoot: binding.companionRoot, dataRoot: binding.dataRoot },
      performance.now() + 30_000);
    if (bound.status !== 'ok' || !hasExactKeys(bound.result, ['bound']) || bound.result['bound'] !== true) {
      throw new NativeHelperUnavailableError('bindFailed');
    }
  }

  /** Takes a slot on a usable service, waiting through a drain or replacement within the deadline; null when it passed. */
  private async acquire(proof: boolean, deadline: number): Promise<ServiceProcess | null> {
    for (;;) {
      if (this.phase === 'exhausted' || this.phase === 'closed') { throw new NativeHelperUnavailableError('unavailable'); }
      const service = this.current;
      const usable = service !== null && service.alive && service.identity !== null && !this.exclusive && this.phase === 'ready';
      // A missed request still running inside the service keeps its slot there, so it counts against both limits.
      const occupied = service === null ? maximumInFlight : service.inFlight + service.missed.size;
      if (usable && service.nextSeq > this.sequenceLimit && !service.draining) {
        service.draining = true;
        if (service.inFlight === 0) { void this.retire(service, 'renewal'); }
      } else if (usable && (!service.draining || proof) && occupied < maximumInFlight && (proof || service.ordinaryInFlight + service.missed.size < ordinarySlots)) {
        if (proof) { service.proofsInFlight += 1; } else { service.ordinaryInFlight += 1; }
        return service;
      }
      if (!await this.waitChange(deadline)) { return null; }
    }
  }

  private release(service: ServiceProcess, proof: boolean): void {
    if (proof) { service.proofsInFlight -= 1; } else { service.ordinaryInFlight -= 1; }
    if (service.draining && service.inFlight === 0 && this.current === service) {
      void this.retire(service, service.nextSeq > this.sequenceLimit && service.fault === null && !service.hadMiss ? 'renewal' : 'failure');
    }
    this.notify();
  }

  /** Sends one request on a service whose slot the caller already holds, or one this module owns outright. */
  private exchange(service: ServiceProcess, op: string, fields: Record<string, unknown>, deadline: number): Promise<HelperReply> {
    const deadlineMs = Math.floor(deadline - performance.now());
    if (deadlineMs < sendFloorMs) { return Promise.resolve(deadlineExceeded); }
    const seq = service.nextSeq;
    service.nextSeq += 1;
    return new Promise<HelperReply>((resolve, reject) => {
      const timer = setTimeout(() => service.miss(seq), deadlineMs + replyGraceMs);
      service.pending.set(seq, { op, resolve: reply => { clearTimeout(timer); resolve(reply); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { service.write({ version: 1, seq, op, deadlineMs, ...fields }); }
      catch { service.failChannel('The native helper request could not be written.'); }
    });
  }

  /**
   * Sends one request within the caller's budget. A request below the send floor is refused locally with deadlineExceeded.
   * A proof failed only because its service failed is sent once more to the replacement; a failed mutating request
   * rejects only after the service's exit has been observed, so no caller inspects a target the service may still change.
   */
  async request(op: HelperOperation, fields: Record<string, unknown>, budgetMs: number): Promise<HelperReply> {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_600_000) { throw new NativeHelperUnavailableError('unavailable'); }
    const deadline = performance.now() + budgetMs;
    const proof = proofOperations.has(op);
    let retried = false;
    for (;;) {
      if (deadline - performance.now() < sendFloorMs) { return deadlineExceeded; }
      const service = await this.acquire(proof, deadline);
      if (service === null) { return deadlineExceeded; }
      let released = false;
      try {
        // An owned observation names the bound service that serves it, so a retry on the replacement names the replacement.
        const sent = fields['owner'] === boundServiceOwner ? { ...fields, owner: this.ownerOf(service) } : fields;
        return await this.exchange(service, op, sent, deadline);
      } catch (error) {
        if (error instanceof NativeHelperUnavailableError) { throw error; }
        const failure = error instanceof HelperRequestFailedError ? error : new HelperRequestFailedError('fault', 'The native helper request failed.');
        // A failed mutation reports only after the service has been retired and its exit observed. It gives up its active
        // slot first, since the drain that retires the service waits for every active slot.
        if (isMutating(op, fields)) {
          this.release(service, proof);
          released = true;
          failure.exitObserved = await service.retired;
        }
        if (proof && !retried && failure.kind === 'fault') { retried = true; continue; }
        throw failure;
      } finally { if (!released) { this.release(service, proof); } }
    }
  }

  /** Binds the service to one scope, while no other request is in flight, after the caller has proven the helper job absent. */
  async bind(binding: HelperBinding, budgetMs = 30_000): Promise<void> {
    if (this.binding !== null) { throw new NativeHelperUnavailableError('bindFailed'); }
    const deadline = performance.now() + budgetMs;
    for (;;) {
      if (this.phase !== 'ready') { throw new NativeHelperUnavailableError(this.phase === 'replacing' ? 'bindFailed' : 'unavailable'); }
      const service = this.current;
      if (service !== null && service.alive && !this.exclusive && service.inFlight === 0) {
        this.exclusive = true;
        try {
          const reply = await this.exchange(service, 'bindScope', { token: binding.token, companionRoot: binding.companionRoot, dataRoot: binding.dataRoot }, deadline);
          if (reply.status !== 'ok' || !hasExactKeys(reply.result, ['bound']) || reply.result['bound'] !== true) { throw new NativeHelperUnavailableError('bindFailed'); }
          this.binding = binding;
          return;
        } catch (error) {
          throw error instanceof NativeHelperUnavailableError ? error : new NativeHelperUnavailableError('bindFailed');
        } finally { this.exclusive = false; this.notify(); }
      }
      if (!await this.waitChange(deadline)) { throw new NativeHelperUnavailableError('bindFailed'); }
    }
  }

  /** The bound service as the owner of its scope's helper job, for owned job observations. */
  owner(): HelperOwner {
    if (this.current === null || this.phase !== 'ready') { throw new NativeHelperUnavailableError('unavailable'); }

    return this.ownerOf(this.current);
  }

  private ownerOf(service: ServiceProcess): HelperOwner {
    const identity = service.identity;
    if (identity === null || this.binding === null) { throw new NativeHelperUnavailableError('unavailable'); }

    return { name: this.helperJobName(this.binding.token), pid: identity.pid, created: identity.created };
  }

  get bound(): boolean { return this.binding !== null; }

  /**
   * The image a broker launch may use. While a verified service holds it, the held image; during the restart window, the
   * image after a fresh hash and identity check against the prelaunch observation; after a second failure, nothing.
   */
  brokerImage(): string {
    const service = this.current;
    if (this.phase === 'ready' && service !== null && service.alive && service.identity !== null) { return this.image.path; }
    if (this.phase === 'replacing') {
      const observed = observeImageFile(this.image.path);
      if (observed !== null && observed.sha256 === this.image.sha256 && observed.volume === this.image.volume && observed.fileId === this.image.fileId) {
        return this.image.path;
      }
    }
    throw new NativeHelperUnavailableError('unavailable');
  }

  /** Checks that the current service is the process its handshake named, through its own processIdentity request. */
  async verifyLive(budgetMs = 5_000): Promise<void> {
    const identity = this.current?.identity;
    if (identity === null || identity === undefined) { throw new NativeHelperUnavailableError('unavailable'); }
    const reply = await this.request('processIdentity', { pid: identity.pid }, budgetMs);
    if (reply.status !== 'ok' || !hasExactKeys(reply.result, ['exists', 'pid', 'created']) || reply.result['exists'] !== true
      || reply.result['created'] !== identity.created || this.current?.identity !== identity) {
      throw new NativeHelperUnavailableError('unavailable');
    }
  }

  /**
   * Stops the service and observes its exit; the caller releases its guard only after this resolves. A replacement in
   * progress finishes first, so the service stopped here is the last one this helper started.
   */
  async close(): Promise<void> {
    this.phase = 'closed';
    this.notify();
    await this.retiring;
    const service = this.current;
    if (service !== null && !await service.stop()) { throw new NativeHelperUnavailableError('unavailable'); }
  }
}

/** Requires an ok reply and returns its result, mapping every failure to the caller's own error. */
export function helperResult(reply: HelperReply, failure: () => Error): JsonValue {
  if (reply.status !== 'ok') { throw failure(); }
  return reply.result;
}
