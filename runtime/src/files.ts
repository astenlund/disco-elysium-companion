import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector, type PathAdmission } from './admission.ts';
import type { Deadline } from './deadline.ts';
import type { InstanceGuard } from './guard.ts';
import { hasExactKeys, jsonBudgets, readBoundedFile, ProspectiveJsonBudgetError, stringifyProspectiveJson, type JsonProfile, type JsonValue, type ProspectiveJsonFailure } from './json.ts';
import { HelperRequestFailedError, type HelperOperation } from './native-helper.ts';
import { SupervisorError, type ProcessSupervisor } from './process.ts';
import { SerialQueue } from './serial.ts';

export class PublicationError extends Error {
  override readonly name = 'PublicationError';
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export interface PublicationResult { readonly sha256: string; readonly cleanupComplete: boolean }
export type AdmitPublicationScope = (scopePath: string) => Promise<readonly PathAdmission[]>;
export class PublicationPathAdmissionError extends Error {
  override readonly name = 'PublicationPathAdmissionError';
  constructor(cause: unknown) { super('Initial publication path admission failed.', { cause }); }
}

// The callback may add its scope path, but only this invocation can acquire the batch.
export async function admitStagingPaths(inspector: PathInspector, root: string, targets: readonly string[], action: (admit: AdmitPublicationScope) => Promise<void>, remaining: () => number, validate: (observed: readonly PathAdmission[]) => void = () => {}): Promise<readonly PathAdmission[]> {
  const frozen = [...targets];
  let active = true;
  let issued = false;
  let violated = false;
  let pending: Promise<readonly PathAdmission[]> | undefined;
  let observed: readonly PathAdmission[] | undefined;
  let complete = false;
  const validatePaths = (paths: readonly string[], results: readonly PathAdmission[]): void => {
    if (results.length !== paths.length || results.some((entry, index) => path.win32.relative(path.win32.resolve(paths[index]!), path.win32.resolve(entry.path)) !== '')) {
      throw new DataRootUnavailableError('Publication admission is incomplete or uncorrelated.');
    }
  };
  const validateTargets = (results: readonly PathAdmission[]): void => {
    for (const [index, entry] of results.entries()) {
      if (entry.kind === 'directory' || entry.missing.length > 1 || index > 0 && entry.exists) { throw new DataRootUnavailableError('Publication staging path is inadmissible.'); }
    }
    validate(results);
  };
  try {
    await action(scopePath => {
      if (!active || issued) { violated = true; return Promise.reject(new DataRootUnavailableError('Publication admission is no longer available.')); }
      issued = true;
      const paths = [scopePath, ...frozen];
      pending = Promise.resolve().then(async () => {
        let results: readonly PathAdmission[];
        const timeout = remaining();
        const expires = performance.now() + timeout;
        try { results = await inspector.inspectMany(root, paths, true, timeout); validatePaths(paths, results); }
        catch (cause) {
          if (cause instanceof SupervisorError) { throw cause; }
          // A failed combined batch cannot identify the offending path. Only a
          // completed failing target probe may bypass the scope refusal channel.
          const probeTime = Math.min(remaining(), Math.floor(expires - performance.now()));
          if (probeTime <= 0) { throw cause; }
          try {
            const targetsNow = await inspector.inspectMany(root, frozen, true, probeTime);
            validatePaths(frozen, targetsNow);
            validateTargets(targetsNow);
          } catch (probeError) {
            remaining();
            if (probeError instanceof SupervisorError) { throw probeError; }
            if (performance.now() >= expires) { throw cause; }
            if (probeError instanceof DataRootUnavailableError || probeError instanceof PublicationError) { throw new PublicationPathAdmissionError(cause); }
          }
          throw cause;
        }
        try {
          observed = structuredClone(results.slice(1));
          validateTargets(observed);
        } catch (cause) {
          throw new PublicationPathAdmissionError(cause);
        }
        complete = true;
        return results;
      });
      return pending;
    });
    if (violated || !complete || observed === undefined) { throw new DataRootUnavailableError('Publication admission was not completed.'); }
    remaining();
    return observed;
  } catch (error) {
    if (error instanceof PublicationPathAdmissionError) { throw error.cause; }
    throw error;
  } finally {
    active = false;
    await pending?.catch(() => {});
  }
}

export interface PublicationOptions {
  readonly root: string;
  readonly guard: Pick<InstanceGuard, 'held'>;
  readonly inspector: PathInspector;
  readonly supervisor: ProcessSupervisor;
  readonly preflight: (target: string, bytes: Readonly<Uint8Array>, profile: JsonProfile, deadline?: Deadline) => Promise<void>;
  readonly preflightWithAdmission?: (target: string, bytes: Readonly<Uint8Array>, profile: JsonProfile, admit: AdmitPublicationScope, deadline?: Deadline) => Promise<void>;
  readonly invalidate: (target: string) => void;
  readonly prospectiveFailure?: ProspectiveJsonFailure;
  readonly bind?: <T>(action: () => Promise<T>) => () => Promise<T>;
  readonly beforeWrite?: (relative: string, deadline?: Deadline) => Promise<void>;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// Callers reserve their complete transition; this queue checks its exact publication before staging.
export class FilePublisher {
  private readonly options: PublicationOptions;
  private readonly queue = new SerialQueue();
  private unavailable = false;

  constructor(options: PublicationOptions) { this.options = options; }

  get blocked(): boolean { return this.unavailable; }
  /** True while any publication, codec or context preparation is queued or in flight. */
  get busy(): boolean { return this.queue.busy; }
  idle(): Promise<void> { return this.queue.idle(); }

  /**
   * Waits, within the deadline, until no publication, codec or context preparation is queued or in flight, so a caller
   * that must not run beside a writer waits for an in-flight publish instead of refusing. False when the deadline passed
   * first. The caller must not hold this publisher's queue, which would wait on itself.
   */
  async quiesce(deadline: Deadline): Promise<boolean> {
    while (this.queue.busy) {
      let remaining: number;
      try { remaining = deadline.remaining(); }
      catch { return false; }
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); });
      try { await Promise.race([this.queue.idle(), expired]); }
      finally { clearTimeout(timer); }
    }

    return true;
  }

  /**
   * Runs one mutating helper request. A reply, ok or error, proves the request's handles closed; a failed request is
   * reported only after the service's exit was observed, and ended is false when that exit could not be observed.
   */
  async runNativeMutation(op: HelperOperation, fields: Record<string, unknown>, timeoutMs: number): Promise<{ readonly result: JsonValue | null; readonly ended: boolean; readonly failure: unknown }> {
    try { return { result: await this.options.inspector.native(op, fields, Math.min(timeoutMs, 30000)), ended: true, failure: null }; }
    catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      return { result: null, ended: !(cause instanceof HelperRequestFailedError && cause.exitObserved === false), failure: error };
    }
  }

  // Codec and ordinary publication share this owner and queue, including cleanup failure.
  exclusive<T>(operation: (options: PublicationOptions) => Promise<T>, deadline?: Deadline): Promise<T> {
    const captured = this.options.bind?.(() => operation(this.options)) ?? (() => operation(this.options));
    return this.queue.run(async () => {
      deadline?.check(); this.requireOwnership();
      return captured();
    });
  }

  block(): void { this.unavailable = true; this.options.invalidate(this.options.root); }
  assertAvailable(): void { this.requireOwnership(); }

  private requireOwnership(): void {
    if (!this.options.guard.held || this.unavailable) { throw new PublicationError('Publication ownership or workspace is unavailable.', true); }
  }

  async publishJson(relative: string, value: unknown, createOnly = false, deadline?: Deadline): Promise<PublicationResult> {
    await this.options.beforeWrite?.(relative, deadline);
    return this.publish(relative, Buffer.from(stringifyProspectiveJson(value, 'config', relative, this.options.prospectiveFailure), 'utf8'), 'config', createOnly, deadline);
  }

  async publish(relative: string, data: Uint8Array, profile: JsonProfile, createOnly = false, deadline?: Deadline,
    preimage?: (scope: PathAdmission | null, target: PathAdmission) => Promise<void>): Promise<PublicationResult> {
    await this.options.beforeWrite?.(relative, deadline);
    if (data.byteLength > jsonBudgets[profile].maxBytes) {
      const error = new ProspectiveJsonBudgetError([{ dimension: 'bytes', actual: data.byteLength, limit: jsonBudgets[profile].maxBytes }], relative);
      return Promise.reject(this.options.prospectiveFailure?.(error) ?? error);
    }
    const bytes = Buffer.from(data);

    return this.exclusive(async () => {
      this.requireOwnership();
      const target = path.resolve(this.options.root, relative);
      const input = `${target}.${randomBytes(16).toString('hex')}.tmp`;
      const preflightWithAdmission = this.options.preflightWithAdmission;
      let scopeAdmission: PathAdmission | null = null;
      let targetAdmission: PathAdmission;
      let preflightComplete = false;
      try {
        if (preflightWithAdmission === undefined) {
          targetAdmission = (await this.options.inspector.inspectMany(this.options.root, [target, input], true, deadline?.remaining()))[0]!;
          await this.options.preflight(target, bytes, profile, deadline);
          preflightComplete = true;
        } else {
          const admitted = await admitStagingPaths(this.options.inspector, this.options.root, [target, input], async admit => {
            await preflightWithAdmission(target, bytes, profile, async scopePath => {
              const observed = await admit(scopePath);
              scopeAdmission = structuredClone(observed[0]!);
              return observed;
            }, deadline);
            preflightComplete = true;
          }, () => {
            this.requireOwnership();
            return deadline?.remaining() ?? 30000;
          });
          targetAdmission = admitted[0]!;
          if (scopeAdmission === null) { throw new DataRootUnavailableError('Publication scope admission was not returned.'); }
        }
        await preimage?.(scopeAdmission, targetAdmission);
        this.requireOwnership();
        deadline?.check();
      } catch (error) {
        if (preflightComplete) { this.options.invalidate(target); }
        throw error;
      }
      const hash = digest(bytes);
      let inputCreated = false;
      let helperEnded = true;
      let completed = false;
      let cleanupComplete = false;
      let failure: unknown = null;
      let inputAdmission: PathAdmission | undefined;
      try {
        this.requireOwnership();
        deadline?.check();
        const handle = await fs.open(input, 'wx');
        inputCreated = true;
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        let reply: JsonValue | null = null;
        try {
          this.requireOwnership();
          const outcome = await this.runNativeMutation('publish', { root: this.options.root, target, inputFile: input, inputSha256: hash, profile, createOnly },
            deadline?.remaining() ?? 30000);
          // Exact target bytes decide an error reply or a lost one.
          reply = outcome.result;
          failure = outcome.failure;
          helperEnded = outcome.ended;
        } catch (error) { failure = error; }
        if (!helperEnded || !this.options.guard.held) {
          this.block();
          throw new PublicationError('Publication cannot be reconciled while ownership is uncertain.', true);
        }
        try {
          // Exact-target reconciliation and cleanup remain mandatory after expiry.
          // Their result never grants a fresh settlement allowance to this caller.
          const observations = await this.options.inspector.inspectMany(this.options.root, [target, input], true);
          const observed = observations[0]!;
          inputAdmission = observations[1]!;
          if (observed.exists && observed.kind === 'file') {
            const actual = await readBoundedFile(observed.path, jsonBudgets[profile].maxBytes);
            completed = actual.length === bytes.length && digest(actual) === hash;
          }
        } catch {
          this.block();
          throw new PublicationError('Published target cannot be read back.', true);
        }
        if (!completed) { throw new PublicationError(`Target does not contain the staged publication${failure instanceof Error ? ': ' + failure.message : '.'}`); }
        cleanupComplete = hasExactKeys(reply, ['published', 'sha256', 'cleanupComplete', 'retainedSiblings']) && reply['published'] === true && reply['sha256'] === hash && reply['cleanupComplete'] === true && Array.isArray(reply['retainedSiblings']) && reply['retainedSiblings'].length === 0;
        if (!cleanupComplete) { this.block(); }
      } catch (error) {
        this.options.invalidate(target);
        throw error;
      } finally {
        if (inputCreated && helperEnded && this.options.guard.held) {
          try {
            const observed = inputAdmission ?? await this.options.inspector.inspect(this.options.root, input, true);
            if (observed.exists) {
              if (observed.kind !== 'file' || digest(await readBoundedFile(input, jsonBudgets[profile].maxBytes)) !== hash) { throw new DataRootUnavailableError('Owned publication input changed.'); }
              await fs.unlink(input);
            }
          } catch {
            this.block();
            cleanupComplete = false;
          }
        } else if (inputCreated) {
          this.block();
          cleanupComplete = false;
        }
      }

      try { deadline?.check(); }
      catch (error) { this.options.invalidate(target); throw error; }
      return { sha256: hash, cleanupComplete };
    }, deadline);
  }
}
