import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { asInteger, hasExactKeys, isLowerHex, parseStrictJson, type JsonValue } from './json.ts';
import { ProcessSupervisor, type CommandResult } from './process.ts';
import { SerialQueue } from './serial.ts';
import type { StartupMetadataSession } from './startup-metadata.ts';

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

function parseAdmission(value: JsonValue, target: string, allowMissing: boolean): PathAdmission {
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
  private startupClosing: Promise<void> | null = null;

  constructor(supervisor: ProcessSupervisor) { this.supervisor = supervisor; }

  idle(): Promise<void> { return this.queue.idle(); }

  attachStartupSession(session: StartupMetadataSession): void {
    if (this.startupSession !== null || this.startupClosing !== null) { throw new DataRootUnavailableError('Startup metadata session is already attached.'); }
    this.startupSession = session;
  }

  closeStartupSession(): Promise<void> {
    if (this.startupClosing !== null) { return this.startupClosing; }
    const session = this.startupSession;
    this.startupSession = null;
    if (session === null) { return Promise.resolve(); }
    this.startupClosing = this.queue.idle().then(() => session.close());
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
    const closing = this.startupClosing;
    const run = async (): Promise<CommandResult> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { throw new DataRootUnavailableError('Metadata deadline expired.'); }
      if (startupSession !== null && startupSession.supports(scriptPath, frozenArgs, frozenInput)) {
        if (startupSession.canFallBack) { this.startupSession = null; }
        else { return startupSession.invoke(scriptPath, frozenArgs, cwd, remaining, frozenInput); }
      }
      return this.supervisor.run('metadata', { command: 'pwsh', args: ['-NoProfile', '-File', scriptPath, ...frozenArgs], cwd }, remaining, frozenInput);
    };
    return closing === null ? this.queue.run(run) : closing.then(() => this.queue.run(run));
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
