import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError } from './admission.ts';
import { asInteger, hasExactKeys, isLowerHex, isObject, stringifyJson } from './json.ts';
import type { CommandResult, OwnedSpawnOptions, ProcessSupervisor } from './process.ts';
import type { RuntimeScope } from './scope.ts';
import { StartupWorkerTransport } from './startup-worker-transport.ts';

const workerScript = fileURLToPath(new URL('../scripts/StartupMutationWorker.ps1', import.meta.url));
const writerScript = fileURLToPath(new URL('../scripts/Write-RuntimeFile.ps1', import.meta.url));
const codecScript = fileURLToPath(new URL('../scripts/Invoke-PayloadCodec.ps1', import.meta.url));
const line = String.fromCharCode(10);

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup mutation transport is unavailable.'); }
function refused(script: 'Write-RuntimeFile' | 'Invoke-PayloadCodec' | 'Get-ResourceInventory', reason: string): CommandResult {
  return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(`${script}: ${reason}${line}`) };
}

export class StartupMutationSession {
  private readonly transport: StartupWorkerTransport;
  private readonly root: string;
  private readonly companionRoot: string;
  private readonly scopeSha256: string;

  private constructor(transport: StartupWorkerTransport, scope: RuntimeScope) {
    this.transport = transport; this.root = scope.dataRoot; this.companionRoot = scope.companionRoot; this.scopeSha256 = scope.bindingSha256;
  }

  static async open(supervisor: ProcessSupervisor, scope: RuntimeScope, sourceSha256: string): Promise<StartupMutationSession | null> {
    const transport = await StartupWorkerTransport.open(supervisor, scope, 'startupMutation', workerScript, sourceSha256);
    return transport === null ? null : new StartupMutationSession(transport, scope);
  }

  handles(options: OwnedSpawnOptions): boolean {
    return options.command === 'pwsh' && options.args[0] === '-NoProfile' && options.args[1] === '-File'
      && (options.args[2] === writerScript || options.args[2] === codecScript);
  }

  get canFallBack(): boolean { return this.transport.canFallBack; }

  async trimQuarantine(scope: RuntimeScope, protectedBytes: Uint8Array, timeoutMs: number): Promise<CommandResult> {
    if (scope.dataRoot !== this.root || scope.companionRoot !== this.companionRoot || scope.bindingSha256 !== this.scopeSha256
      || protectedBytes.byteLength < 1 || protectedBytes.byteLength > 1_048_576
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) { throw unavailable(); }
    const bytes = Buffer.from(protectedBytes);
    const reply = await this.transport.request('quarantineTrim', { scopeSha256: this.scopeSha256,
      inputBase64: bytes.toString('base64'), inputSha256: createHash('sha256').update(bytes).digest('hex') }, Math.min(timeoutMs, 30000));
    if (reply.status === 'error') {
      if (reply.code === 'quarantineUnavailable') { return refused('Get-ResourceInventory', 'resource-authority-unavailable'); }
      await this.transport.invalidate();
      throw unavailable();
    }
    const result = reply.result;
    if (!hasExactKeys(result, ['removed', 'remaining'])) { await this.transport.invalidate(); throw unavailable(); }
    const removed = asInteger(result['removed']);
    const remaining = asInteger(result['remaining']);
    if (removed === undefined || removed < 0 || remaining === undefined || remaining < 0) {
      await this.transport.invalidate();
      throw unavailable();
    }
    return { exitCode: 0, stdout: Buffer.from(stringifyJson(result), 'utf8'), stderr: Buffer.alloc(0) };
  }

  async invoke(options: OwnedSpawnOptions, timeoutMs: number): Promise<CommandResult> {
    if (!this.handles(options) || options.cwd !== this.root || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) { throw unavailable(); }
    const args = options.args;
    const isWriter = args[2] === writerScript;
    const prefix = ['-NoProfile', '-File', isWriter ? writerScript : codecScript, '-Root', this.root, '-Target'];
    if (args.length < prefix.length || prefix.some((value, index) => args[index] !== value)) { throw unavailable(); }
    const target = args[6];
    const inputFile = args[8];
    const inputSha256 = args[10];
    if (typeof target !== 'string' || typeof inputFile !== 'string' || !isLowerHex(inputSha256, 64)
      || args[7] !== '-InputFile' || args[9] !== (isWriter ? '-Sha256' : '-InputSha256')) { throw unavailable(); }
    let operation: 'publish' | 'codec';
    let fields: Record<string, unknown>;
    if (isWriter) {
      const profile = args[12];
      if (args[11] !== '-Profile' || profile !== 'config' && profile !== 'state-event'
        || args.length !== 13 && (args.length !== 14 || args[13] !== '-CreateOnly')) { throw unavailable(); }
      operation = 'publish';
      fields = { target, inputFile, inputSha256, profile, createOnly: args.length === 14 };
    } else {
      const tail = args.slice(15);
      if (args[11] !== '-ControlFile' || args[13] !== '-ControlSha256' || typeof args[12] !== 'string'
        || !isLowerHex(args[14], 64) || tail.length > 2 || tail.some(flag => flag !== '-Preview' && flag !== '-VerifyOnly')
        || new Set(tail).size !== tail.length) { throw unavailable(); }
      operation = 'codec';
      fields = { target, inputFile, inputSha256, controlFile: args[12], controlSha256: args[14],
        verifyOnly: tail.includes('-VerifyOnly'), preview: tail.includes('-Preview') };
    }
    const reply = await this.transport.request(operation, fields, Math.min(timeoutMs, 30000));
    if (reply.status === 'error') {
      if (isWriter && reply.code === 'publicationFailed') { return refused('Write-RuntimeFile', 'publication-failed'); }
      if (!isWriter && reply.code === 'documentInvalid') { return refused('Invoke-PayloadCodec', 'document-invalid'); }
      if (!isWriter && reply.code === 'codecUnavailable') { return refused('Invoke-PayloadCodec', 'codec-unavailable'); }
      await this.transport.invalidate();
      throw unavailable();
    }
    const result = reply.result;
    const valid = isWriter
      ? hasExactKeys(result, ['published', 'sha256', 'cleanupComplete', 'retainedSiblings']) && result['published'] === true
        && isLowerHex(result['sha256'], 64) && typeof result['cleanupComplete'] === 'boolean'
        && Array.isArray(result['retainedSiblings']) && result['retainedSiblings'].every(name => typeof name === 'string')
      : hasExactKeys(result, ['codecVersion', 'sha256', 'published', 'cleanupComplete', 'metadata'])
        && asInteger(result['codecVersion']) === 1 && isLowerHex(result['sha256'], 64)
        && typeof result['published'] === 'boolean' && typeof result['cleanupComplete'] === 'boolean' && isObject(result['metadata']);
    if (!valid) { await this.transport.invalidate(); throw unavailable(); }
    try { return { exitCode: 0, stdout: Buffer.from(stringifyJson(result), 'utf8'), stderr: Buffer.alloc(0) }; }
    catch { await this.transport.invalidate(); throw unavailable(); }
  }

  close(): Promise<void> { return this.transport.close(); }
}
