import path from 'node:path';

import { asInteger, hasExactKeys, isLowerHex, type JsonValue } from './json.ts';
import type { HelperOperation, NativeHelper } from './native-helper.ts';
import { SupervisorError, type CommandResult, type ProcessSupervisor } from './process.ts';
import { SerialQueue } from './serial.ts';
import type { StartupCoreReplySession } from './startup-core-reply.ts';

export class DataRootUnavailableError extends Error {
  override readonly name = 'DataRootUnavailableError';
  readonly code = 'dataRootUnavailable';
}
export interface PathAdmission {
  readonly path: string;
  readonly exists: boolean;
  readonly kind: 'file' | 'directory' | null;
  readonly links: number | null;
  readonly volume: string | null;
  readonly identity: string | null;
  readonly missing: readonly string[];
}

export const maximumPathAdmissionBatchEntries = 64;
export const maximumPathAdmissionControlBytes = 65_536;

/** @internal Shared parser for the exact native path admission envelope. */
export function parseAdmission(value: JsonValue, target: string, allowMissing: boolean): PathAdmission {
  if (!hasExactKeys(value, ['path', 'exists', 'kind', 'links', 'volume', 'identity', 'missing']) || typeof value['path'] !== 'string' || path.win32.relative(path.win32.resolve(target), path.win32.resolve(value['path'])) !== '' || typeof value['exists'] !== 'boolean' || !Array.isArray(value['missing']) || !value['missing'].every(part => typeof part === 'string' && part.length > 0 && !part.includes('/') && !part.includes(path.win32.sep))) {
    throw new DataRootUnavailableError('Path admission metadata is invalid.');
  }
  const missing = value['missing'] as string[];
  if (!value['exists']) {
    if (!allowMissing || value['kind'] !== null || value['links'] !== null || value['volume'] !== null || value['identity'] !== null || missing.length === 0) { throw new DataRootUnavailableError('Invalid absent-path admission.'); }

    return { path: value['path'], exists: false, kind: null, links: null, volume: null, identity: null, missing };
  }
  const links = asInteger(value['links']);
  if ((value['kind'] !== 'file' && value['kind'] !== 'directory') || links === undefined || links < 0 || value['kind'] === 'file' && links !== 1 || !isLowerHex(value['volume'], 16) || !isLowerHex(value['identity'], 32) || missing.length !== 0) {
    throw new DataRootUnavailableError('Invalid existing-path admission.');
  }

  return { path: value['path'], exists: true, kind: value['kind'], links, volume: value['volume'], identity: value['identity'], missing };
}

/** A native helper request that did not succeed: the service's error code, or unavailable when the request itself failed. */
export class NativeOperationError extends Error {
  override readonly name = 'NativeOperationError';
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) { super(`Native operation failed: ${code}.`, options); this.code = code; }
}

export class PathInspector {
  private readonly supervisor: ProcessSupervisor;
  private readonly helper: NativeHelper;
  // Only retained core reply validation runs here; helper requests go through the helper's own queue, never this one.
  private readonly queue = new SerialQueue();
  private coreReplySession: StartupCoreReplySession | null = null;
  private coreReplyClosing: Promise<void> | null = null;

  constructor(supervisor: ProcessSupervisor) { this.supervisor = supervisor; this.helper = supervisor.nativeHelper; }

  idle(): Promise<void> { return this.queue.idle(); }

  attachStartupCoreReplySession(session: StartupCoreReplySession): void {
    if (this.coreReplySession !== null || this.coreReplyClosing !== null) { throw new DataRootUnavailableError('Startup core reply session is already attached.'); }
    this.coreReplySession = session;
  }

  closeStartupSession(): Promise<void> {
    if (this.coreReplyClosing !== null) { return this.coreReplyClosing; }
    const session = this.coreReplySession;
    this.coreReplySession = null;
    if (session === null) { return Promise.resolve(); }
    this.coreReplyClosing = this.queue.idle().then(() => session.close());
    return this.coreReplyClosing;
  }

  /**
   * Sends one native helper request within a bounded budget and returns its result. A service error code, a local
   * deadline refusal and a failed request all reject with NativeOperationError, which each reader maps to its own failure.
   */
  async native(op: HelperOperation, fields: Record<string, unknown>, timeoutMs = 30000): Promise<JsonValue> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) { throw new NativeOperationError('invalidDeadline'); }
    let reply;
    try { reply = await this.helper.request(op, fields, timeoutMs); }
    catch (error) { throw new NativeOperationError('unavailable', { cause: error }); }
    if (reply.status !== 'ok') { throw new NativeOperationError(reply.code); }
    return reply.result;
  }

  async inspect(root: string, target: string, allowMissing = false, timeoutMs = 30000): Promise<PathAdmission> {
    const results = await this.inspectMany(root, [target], allowMissing, timeoutMs);

    return results[0]!;
  }

  /** Runs retained core reply validation: through the warm worker while it is open, otherwise one-shot under the metadata role. */
  metadata(scriptPath: string, args: readonly string[], cwd: string, timeoutMs = 30000, input?: Uint8Array): Promise<CommandResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) { return Promise.reject(new DataRootUnavailableError('Invalid metadata deadline.')); }
    const deadline = performance.now() + timeoutMs;
    const frozenArgs = [...args];
    const frozenInput = input === undefined ? undefined : Buffer.from(input);
    const coreReplySession = this.coreReplySession;
    const closing = this.coreReplyClosing;
    const run = async (): Promise<CommandResult> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { throw new DataRootUnavailableError('Metadata deadline expired.'); }
      if (coreReplySession !== null && coreReplySession.supports(scriptPath, frozenArgs, frozenInput)) {
        if (coreReplySession.canFallBack) { this.coreReplySession = null; }
        else { return coreReplySession.invoke(scriptPath, frozenArgs, cwd, remaining, frozenInput); }
      }
      return this.supervisor.run('metadata', { command: 'pwsh', args: ['-NoProfile', '-File', scriptPath, ...frozenArgs], cwd }, remaining, frozenInput);
    };
    return closing === null ? this.queue.run(run) : closing.then(() => this.queue.run(run));
  }

  async inspectMany(root: string, targets: readonly string[], allowMissing = false, timeoutMs = 30000): Promise<readonly PathAdmission[]> {
    if (targets.length < 1 || targets.length > maximumPathAdmissionBatchEntries || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { throw new DataRootUnavailableError('Invalid path admission request.'); }
    const frozenTargets = [...targets];
    if (Buffer.byteLength(JSON.stringify(frozenTargets), 'utf8') > maximumPathAdmissionControlBytes) { throw new DataRootUnavailableError('Path admission batch exceeds its control budget.'); }
    let value: JsonValue;
    try { value = await this.native('admit', { root, targets: frozenTargets, allowMissing }, Math.min(timeoutMs, 30000)); }
    catch (error) {
      // A refused path is a data-root failure; a helper that could not answer is a native transport failure.
      if (error instanceof DataRootUnavailableError) { throw error; }
      if (error instanceof NativeOperationError && error.code === 'admissionUnavailable') { throw new DataRootUnavailableError('Physical path admission failed.', { cause: error }); }
      throw new SupervisorError(error instanceof NativeOperationError && error.code === 'deadlineExceeded' ? 'deadline' : 'abnormal-exit',
        'Native path admission is unavailable.', { cause: error });
    }
    if (!hasExactKeys(value, ['paths']) || !Array.isArray(value['paths']) || value['paths'].length !== frozenTargets.length) { throw new DataRootUnavailableError('Incomplete path admission batch.'); }

    return value['paths'].map((entry, index) => parseAdmission(entry, frozenTargets[index]!, allowMissing));
  }
}
