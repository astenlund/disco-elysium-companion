import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireDirectMainToken } from './direct-main-capability.ts';
import { asInteger, hasExactKeys, isLowerHex, parseStrictJson, type JsonValue } from './json.ts';
import { childEnvironment, ProcessSupervisor, type CommandResult, type OwnedSpawnOptions } from './process.ts';
import { SerialQueue } from './serial.ts';
import type { RuntimeScope } from './scope.ts';
import type { StartupMetadataSession } from './startup-metadata.ts';
import type { StartupCoreReplySession } from './startup-core-reply.ts';

/** @internal Copies one complete printable expression ending in a newline, or returns null when it is not exactly that. */
export function frozenStdinExpression(expression: Uint8Array): Buffer | null {
  if (expression.byteLength < 2 || expression.byteLength > 1_048_576 || expression[expression.byteLength - 1] !== 10) { return null; }
  const frozen = Buffer.from(expression);
  for (let index = 0; index < frozen.byteLength - 1; index++) {
    if (frozen[index]! < 32 || frozen[index]! > 126) { return null; }
  }
  return frozen;
}

/** @internal The supervised command that reads one in-memory expression from stdin, with a copied environment. */
export function stdinExpressionCommand(cwd: string, env: NodeJS.ProcessEnv): OwnedSpawnOptions {
  return { command: 'pwsh', args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], cwd, env: childEnvironment(env) };
}

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

const script = fileURLToPath(new URL('../scripts/Get-PathAdmission.ps1', import.meta.url));
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

export class PathInspector {
  private readonly supervisor: ProcessSupervisor;
  private readonly queue = new SerialQueue();
  private startupSession: StartupMetadataSession | null = null;
  private coreReplySession: StartupCoreReplySession | null = null;
  private startupClosing: Promise<void> | null = null;
  private startupSessionStopped = false;

  constructor(supervisor: ProcessSupervisor) { this.supervisor = supervisor; }

  idle(): Promise<void> { return this.queue.idle(); }

  /** Resolves null once the warm worker has verifiably stopped, so the supervisor takes a fresh one-shot observation. */
  observeStartupJobs(names: readonly string[], timeoutMs = 5000): Promise<readonly boolean[] | null> {
    if (this.startupWorkerStopped) {
      this.dropVerifiedStartupSession();
      return Promise.resolve(null);
    }
    return this.queue.run(async () => {
      // A request queued ahead of this one may have stopped the worker verifiably, or another observation already dropped it.
      if (this.startupWorkerStopped) {
        this.dropVerifiedStartupSession();
        return null;
      }
      if (this.startupClosing !== null || this.startupSession === null) {
        throw new DataRootUnavailableError('Startup job observation is unavailable.');
      }
      return this.startupSession.observeJobStates(names, timeoutMs);
    });
  }

  attachStartupSession(session: StartupMetadataSession): void {
    if (this.startupSession !== null || this.startupClosing !== null) { throw new DataRootUnavailableError('Startup metadata session is already attached.'); }
    this.startupSession = session;
    this.startupSessionStopped = false;
  }

  private get startupWorkerStopped(): boolean {
    return this.startupClosing === null && (this.startupSessionStopped || this.startupSession?.canFallBack === true);
  }

  // A verifiably stopped worker supplies no further answers; its warm job observer goes with it.
  private dropVerifiedStartupSession(): void {
    this.startupSession = null;
    this.startupSessionStopped = true;
    this.supervisor.clearStartupJobObserver();
  }

  attachStartupCoreReplySession(session: StartupCoreReplySession): void {
    if (this.coreReplySession !== null || this.startupClosing !== null) { throw new DataRootUnavailableError('Startup core reply session is already attached.'); }
    this.coreReplySession = session;
  }

  closeStartupSession(): Promise<void> {
    if (this.startupClosing !== null) { return this.startupClosing; }
    const sessions = [this.startupSession, this.coreReplySession].filter(session => session !== null);
    this.startupSession = null;
    this.coreReplySession = null;
    if (sessions.length === 0) { return Promise.resolve(); }
    this.startupClosing = this.queue.idle().then(async () => {
      const results = await Promise.allSettled(sessions.map(session => session.close()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') { throw failure.reason; }
    });
    return this.startupClosing;
  }

  async inspect(root: string, target: string, allowMissing = false, timeoutMs = 30000): Promise<PathAdmission> {
    const results = await this.inspectMany(root, [target], allowMissing, timeoutMs);

    return results[0]!;
  }

  metadata(scriptPath: string, args: readonly string[], cwd: string, timeoutMs = 30000, input?: Uint8Array): Promise<CommandResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) { return Promise.reject(new DataRootUnavailableError('Invalid metadata deadline.')); }
    const deadline = performance.now() + timeoutMs;
    const frozenArgs = [...args];
    const frozenInput = input === undefined ? undefined : Buffer.from(input);
    const startupSession = this.startupSession;
    const coreReplySession = this.coreReplySession;
    const closing = this.startupClosing;
    const run = async (): Promise<CommandResult> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { throw new DataRootUnavailableError('Metadata deadline expired.'); }
      if (startupSession !== null && startupSession.supports(scriptPath, frozenArgs, frozenInput)) {
        if (startupSession.canFallBack) { if (this.startupSession === startupSession) { this.dropVerifiedStartupSession(); } }
        else { return startupSession.invoke(scriptPath, frozenArgs, cwd, remaining, frozenInput); }
      }
      if (coreReplySession !== null && coreReplySession.supports(scriptPath, frozenArgs, frozenInput)) {
        if (coreReplySession.canFallBack) { this.coreReplySession = null; }
        else { return coreReplySession.invoke(scriptPath, frozenArgs, cwd, remaining, frozenInput); }
      }
      return this.supervisor.run('metadata', { command: 'pwsh', args: ['-NoProfile', '-File', scriptPath, ...frozenArgs], cwd }, remaining, frozenInput);
    };
    return closing === null ? this.queue.run(run) : closing.then(() => this.queue.run(run));
  }

  /**
   * @internal The caller constructs one fixed expression from captured, verified source bytes. That expression can transfer
   * image pins into this process, so only a direct main entry may send it.
   */
  metadataStdinExpression(token: unknown, expression: Uint8Array, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 30000): Promise<CommandResult> {
    try { requireDirectMainToken(token); }
    catch (error) { return Promise.reject(error); }
    const frozen = frozenStdinExpression(expression);
    if (frozen === null || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000
      || this.startupSession !== null || this.coreReplySession !== null || this.startupClosing !== null) {
      return Promise.reject(new DataRootUnavailableError('Invalid in-memory metadata request.'));
    }
    const command = stdinExpressionCommand(cwd, env);
    const deadline = performance.now() + timeoutMs;
    const run = (): Promise<CommandResult> => {
      if (this.startupSession !== null || this.coreReplySession !== null || this.startupClosing !== null) {
        throw new DataRootUnavailableError('In-memory metadata is unavailable after startup worker opening.');
      }
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { throw new DataRootUnavailableError('Metadata deadline expired.'); }
      return this.supervisor.run('metadata', command, remaining, frozen);
    };
    return this.queue.run(run);
  }

  inspectMany(root: string, targets: readonly string[], allowMissing = false, timeoutMs = 30000): Promise<readonly PathAdmission[]> {
    if (targets.length < 1 || targets.length > maximumPathAdmissionBatchEntries || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { return Promise.reject(new DataRootUnavailableError('Invalid path admission request.')); }
    const frozenTargets = [...targets];
    const targetText = JSON.stringify(frozenTargets);
    if (Buffer.byteLength(targetText, 'utf8') > maximumPathAdmissionControlBytes) { return Promise.reject(new DataRootUnavailableError('Path admission batch exceeds its control budget.')); }
    const args = ['-Root', root, '-TargetsJson', targetText, ...(allowMissing ? ['-AllowMissing'] : [])];
    return this.metadata(script, args, root, timeoutMs).then(result => {
      if (result.exitCode !== 0) { throw new DataRootUnavailableError('Physical path admission failed.'); }
      const value = parseStrictJson(result.stdout);
      if (!hasExactKeys(value, ['paths']) || !Array.isArray(value['paths']) || value['paths'].length !== frozenTargets.length) { throw new DataRootUnavailableError('Incomplete path admission batch.'); }

      return value['paths'].map((entry, index) => parseAdmission(entry, frozenTargets[index]!, allowMissing));
    });
  }
}
