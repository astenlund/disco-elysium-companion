import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError } from './admission.ts';
import { asInteger, hasExactKeys, isLowerHex, isObject, parseStrictJson, stringifyJson } from './json.ts';
import type { CommandResult, ProcessSupervisor } from './process.ts';
import type { RuntimeScope } from './scope.ts';
import { StartupWorkerTransport } from './startup-worker-transport.ts';

const workerScript = fileURLToPath(new URL('../scripts/StartupCoreReplyWorker.ps1', import.meta.url));
const readerScript = fileURLToPath(new URL('../scripts/Read-CoreReply.ps1', import.meta.url));
const errorLine = Buffer.from('Read-CoreReply: core-reply-invalid' + String.fromCharCode(10));

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup core reply validation is unavailable.'); }

export class StartupCoreReplySession {
  private readonly transport: StartupWorkerTransport;
  private readonly companionRoot: string;

  private constructor(transport: StartupWorkerTransport, companionRoot: string) {
    this.transport = transport; this.companionRoot = companionRoot;
  }

  static async open(supervisor: ProcessSupervisor, scope: RuntimeScope, sourceSha256: string): Promise<StartupCoreReplySession | null> {
    const transport = await StartupWorkerTransport.open(supervisor, scope, 'startupCoreReply', workerScript, sourceSha256);
    return transport === null ? null : new StartupCoreReplySession(transport, scope.companionRoot);
  }

  supports(scriptPath: string, args: readonly string[], input?: Uint8Array): boolean {
    return scriptPath === readerScript && input !== undefined && args.length === 4 && args[0] === '-CompanionRoot'
      && args[1] === this.companionRoot && args[2] === '-Operation' && ['Publish', 'Settlement', 'Consumer'].includes(args[3]!);
  }

  get canFallBack(): boolean { return this.transport.canFallBack; }

  async invoke(scriptPath: string, args: readonly string[], cwd: string, timeoutMs: number, input?: Uint8Array): Promise<CommandResult> {
    if (!this.supports(scriptPath, args, input) || cwd !== this.companionRoot || input === undefined || input.byteLength < 1 || input.byteLength > 1_048_576) {
      throw unavailable();
    }
    let control;
    try { control = parseStrictJson(input); }
    catch { throw unavailable(); }
    if (!hasExactKeys(control, ['exitCode', 'stdout', 'stderr']) || ![0, 1].includes(asInteger(control['exitCode']) ?? -1)
      || typeof control['stdout'] !== 'string' || typeof control['stderr'] !== 'string'
      || Buffer.byteLength(control['stdout'], 'utf8') > 65_536 || Buffer.byteLength(control['stderr'], 'utf8') > 65_536) { throw unavailable(); }
    const reply = await this.transport.request('validateCore', { operation: args[3], exitCode: asInteger(control['exitCode']),
      stdout: control['stdout'], stderr: control['stderr'] }, timeoutMs);
    if (reply.status === 'error') {
      if (reply.code !== 'coreReplyInvalid') { await this.transport.invalidate(); throw unavailable(); }
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: errorLine };
    }
    const result = reply.result;
    if (!hasExactKeys(result, ['coreReplyVersion', 'success', 'class', 'reason', 'targetIdentitySha256', 'data'])
      || asInteger(result['coreReplyVersion']) !== 1 || typeof result['success'] !== 'boolean'
      || result['success'] !== (asInteger(control['exitCode']) === 0) || !isObject(result['data'])
      || result['targetIdentitySha256'] !== null && !isLowerHex(result['targetIdentitySha256'], 64)
      || (result['success'] ? result['class'] !== null || result['reason'] !== null
        : typeof result['class'] !== 'string' || typeof result['reason'] !== 'string' || result['targetIdentitySha256'] !== null)) {
      await this.transport.invalidate();
      throw unavailable();
    }
    try { return { exitCode: 0, stdout: Buffer.from(stringifyJson(result), 'utf8'), stderr: Buffer.alloc(0) }; }
    catch { await this.transport.invalidate(); throw unavailable(); }
  }

  close(): Promise<void> { return this.transport.close(); }
}
