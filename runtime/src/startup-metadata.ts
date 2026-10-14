import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from './admission.ts';
import { asInteger, hasExactKeys, isLowerHex, parseStrictJson, stringifyJson, type JsonValue } from './json.ts';
import { SupervisorError, type CommandResult, type OwnedProcess, type ProcessSupervisor } from './process.ts';
import type { RuntimeScope } from './scope.ts';
import type { StartupWorkerEvidence } from './startup-worker-sources.ts';

const script = fileURLToPath(new URL('../scripts/StartupMetadataWorker.ps1', import.meta.url));
const sourceScript = fileURLToPath(new URL('../scripts/Get-StartupMetadataSource.ps1', import.meta.url));
const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const admissionScript = fileURLToPath(new URL('../scripts/Get-PathAdmission.ps1', import.meta.url));
const hashesScript = fileURLToPath(new URL('../scripts/Get-FileHashes.ps1', import.meta.url));
const resourceScript = fileURLToPath(new URL('../scripts/resource-lifecycle/Get-ResourceInventory.ps1', import.meta.url));
const maximumInputFrame = 2_097_152;
const maximumOutputFrame = 65_536;
const maximumHashInput = 1_048_576;
const frameBudget = { maxBytes: maximumInputFrame, maxTokens: 65_536, maxTextBytes: maximumInputFrame } as const;

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup metadata observation is unavailable.'); }

type WorkerStream = Pick<OwnedProcess, 'stdout' | 'stderr' | 'terminated' | 'kill'>;

/** @internal The framed child stream, without file or startup authority. */
export class FramedReplies {
  private readonly child: WorkerStream;
  private buffer = Buffer.alloc(0);
  private queued: Buffer | null = null;
  private pending: { resolve: (value: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private error: Error | null = null;
  private closing = false;
  private allowQueuedHandshake = true;

  constructor(child: WorkerStream) {
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stdout.on('error', () => this.fail(unavailable()));
    child.stdout.on('end', () => { if (!this.closing || this.buffer.length > 0) { this.fail(unavailable()); } });
    child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.length > 0) { this.fail(unavailable()); }
    });
    child.stderr.on('error', () => this.fail(unavailable()));
    void child.terminated.then(() => { if (!this.closing) { this.fail(unavailable()); } }, () => this.fail(unavailable()));
  }

  private receive(chunk: Buffer): void {
    if (this.error !== null) { return; }
    if (this.closing || this.buffer.length + chunk.length > maximumOutputFrame + 4) { this.fail(unavailable()); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length < 4) { return; }
    const length = this.buffer.readUInt32BE(0);
    if (length < 1 || length > maximumOutputFrame) { this.fail(unavailable()); return; }
    if (this.buffer.length < length + 4) { return; }
    const frame = this.buffer.subarray(4, length + 4);
    this.buffer = this.buffer.subarray(length + 4);
    if (this.buffer.length > 0 || this.queued !== null) { this.fail(unavailable()); return; }
    const pending = this.pending;
    if (pending === null) {
      if (!this.allowQueuedHandshake) { this.fail(unavailable()); return; }
      this.queued = frame;
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(frame);
  }

  next(timeoutMs: number): Promise<Buffer> {
    if (this.error !== null || this.closing || this.pending !== null) { return Promise.reject(this.error ?? unavailable()); }
    this.allowQueuedHandshake = false;
    if (this.queued !== null) { const frame = this.queued; this.queued = null; return Promise.resolve(frame); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(unavailable()), timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  fail(error: Error): void {
    if (this.error !== null) { return; }
    this.error = error;
    this.queued = null;
    const pending = this.pending;
    if (pending !== null) { clearTimeout(pending.timer); this.pending = null; pending.reject(error); }
    this.child.kill();
  }

  close(): void {
    this.closing = true;
    if (this.buffer.length > 0 || this.queued !== null || this.pending !== null) { this.fail(unavailable()); }
  }

  get fault(): Error | null { return this.error; }
}

async function sourceEvidence(inspector: PathInspector, scope: RuntimeScope): Promise<{ scopeSha256: string; sourceSha256: string } | null> {
  const reply = await inspector.metadata(sourceScript, ['-CompanionRoot', scope.companionRoot, '-DataRoot', scope.dataRoot,
    '-SourceRoot', installationRoot], scope.companionRoot);
  if (reply.exitCode !== 0 || reply.stderr.length !== 0) { throw unavailable(); }
  let value: JsonValue;
  try { value = parseStrictJson(reply.stdout); }
  catch { throw unavailable(); }
  if (hasExactKeys(value, ['status']) && value['status'] === 'absent') { return null; }
  if (!hasExactKeys(value, ['status', 'scopeSha256', 'sourceSha256']) || value['status'] !== 'present'
    || !isLowerHex(value['scopeSha256'], 64) || !isLowerHex(value['sourceSha256'], 64) || value['scopeSha256'] !== scope.bindingSha256) {
    throw unavailable();
  }
  return { scopeSha256: value['scopeSha256'], sourceSha256: value['sourceSha256'] };
}

/** @internal Encodes the larger base64 control frame without enlarging decoded input. */
export function encodeStartupMetadataFrame(value: unknown): Buffer {
  const body = Buffer.from(stringifyJson(value, frameBudget), 'utf8');
  if (body.length < 1 || body.length > maximumInputFrame) { throw unavailable(); }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function validateStartupHello(value: JsonValue, nonce: string, expected: { scopeSha256: string; sourceSha256: string }): void {
  if (!hasExactKeys(value, ['version', 'nonce', 'scopeSha256', 'sourceSha256']) || asInteger(value['version']) !== 1
    || value['nonce'] !== nonce || value['scopeSha256'] !== expected.scopeSha256 || value['sourceSha256'] !== expected.sourceSha256) {
    throw unavailable();
  }
}

/** @internal Complete reply validation before an observation reaches its reader. */
const inventoryFields = ['uncompactedEvents', 'retainedHandoffs', 'retainedHandoffIdentitySha256', 'potentialHandoffs',
  'fullTerminalOperations', 'unfinishedOperations', 'invalidEvents', 'invalidOperations', 'pendingOutbox', 'uncertainWorkspace', 'freeBytes'] as const;
const inventoryCounts = ['uncompactedEvents', 'retainedHandoffs', 'potentialHandoffs', 'fullTerminalOperations', 'unfinishedOperations',
  'invalidEvents', 'invalidOperations', 'pendingOutbox'] as const;

function validateInventoryResult(value: JsonValue): void {
  if (!hasExactKeys(value, inventoryFields) || inventoryCounts.some(key => {
    const count = asInteger(value[key]);
    return count === undefined || count < 0;
  }) || !isLowerHex(value['retainedHandoffIdentitySha256'], 64) || typeof value['uncertainWorkspace'] !== 'boolean'
    || typeof value['freeBytes'] !== 'string' || !/^[0-9]+$/.test(value['freeBytes'])) { throw unavailable(); }
}

export function parseStartupMetadataReply(frameBytes: Uint8Array, id: string, operation: 'admit' | 'hash' | 'inventory'): CommandResult {
  const response = parseStrictJson(frameBytes);
  if (hasExactKeys(response, ['version', 'id', 'op', 'status', 'code'])) {
    const code = operation === 'admit' ? 'admissionUnavailable' : operation === 'hash' ? 'hashUnavailable' : 'inventoryUnavailable';
    if (asInteger(response['version']) !== 1 || response['id'] !== id || response['op'] !== operation
      || response['status'] !== 'error' || response['code'] !== code) { throw unavailable(); }
    return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  if (hasExactKeys(response, ['version', 'id', 'op', 'status', 'result'])) {
    if (asInteger(response['version']) !== 1 || response['id'] !== id || response['op'] !== operation || response['status'] !== 'ok') { throw unavailable(); }
    const result = response['result'];
    if (result === undefined) { throw unavailable(); }
    if (operation === 'inventory') { validateInventoryResult(result); }
    return { exitCode: 0, stdout: Buffer.from(stringifyJson(result), 'utf8'), stderr: Buffer.alloc(0) };
  }
  throw unavailable();
}

export class StartupMetadataSession {
  private readonly supervisor: ProcessSupervisor;
  private readonly child: OwnedProcess;
  private readonly replies: FramedReplies;
  private readonly scope: Pick<RuntimeScope, 'companionRoot' | 'dataRoot' | 'bindingSha256'>;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private inFlight = false;
  private stoppedVerified = false;

  private constructor(supervisor: ProcessSupervisor, child: OwnedProcess, replies: FramedReplies, scope: RuntimeScope) {
    this.supervisor = supervisor;
    this.child = child;
    this.replies = replies;
    this.scope = { companionRoot: scope.companionRoot, dataRoot: scope.dataRoot, bindingSha256: scope.bindingSha256 };
  }

  static async open(inspector: PathInspector, supervisor: ProcessSupervisor, scope: RuntimeScope, handshakeTimeoutMs = 30000): Promise<StartupMetadataSession | null> {
    const launch = await StartupMetadataSession.prepareOpen(inspector, supervisor, scope, handshakeTimeoutMs);

    return launch === null ? null : launch();
  }

  static async prepareOpen(inspector: PathInspector, supervisor: ProcessSupervisor, scope: RuntimeScope,
    handshakeTimeoutMs = 30000): Promise<(() => Promise<StartupMetadataSession | null>) | null> {
    if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 30000) { throw unavailable(); }
    const expected = await sourceEvidence(inspector, scope);
    if (expected === null) { return null; }

    return StartupMetadataSession.preparePinnedOpen(supervisor, scope, expected, handshakeTimeoutMs);
  }

  static prepareWithEvidence(supervisor: ProcessSupervisor, scope: RuntimeScope, evidence: StartupWorkerEvidence,
    handshakeTimeoutMs = 30000): () => Promise<StartupMetadataSession | null> {
    if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 30000
      || evidence.scopeSha256 !== scope.bindingSha256 || !isLowerHex(evidence.metadataSha256, 64)) { throw unavailable(); }

    return StartupMetadataSession.preparePinnedOpen(supervisor, scope,
      { scopeSha256: evidence.scopeSha256, sourceSha256: evidence.metadataSha256 }, handshakeTimeoutMs);
  }

  private static preparePinnedOpen(supervisor: ProcessSupervisor, scope: RuntimeScope,
    expected: { scopeSha256: string; sourceSha256: string }, handshakeTimeoutMs: number): () => Promise<StartupMetadataSession | null> {
    let used = false;

    return () => {
      if (used) { throw unavailable(); }
      used = true;
      return StartupMetadataSession.openWithEvidence(supervisor, scope, expected, handshakeTimeoutMs);
    };
  }

  private static async openWithEvidence(supervisor: ProcessSupervisor, scope: RuntimeScope,
    expected: { scopeSha256: string; sourceSha256: string }, handshakeTimeoutMs: number): Promise<StartupMetadataSession | null> {
    const tempRoot = path.join(scope.companionRoot, '.tmp');
    const nonce = randomBytes(16).toString('hex');
    let child: OwnedProcess;
    try {
      child = supervisor.spawn('startupMetadata', { command: 'pwsh', args: ['-NoProfile', '-File', script, '-CompanionRoot', scope.companionRoot,
        '-DataRoot', scope.dataRoot, '-SourceRoot', installationRoot, '-Nonce', nonce], cwd: scope.companionRoot, env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } });
    } catch {
      await supervisor.verifyQuiescent('startupMetadata');
      return null;
    }
    const replies = new FramedReplies(child);
    let ownedChildReady = false;
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const failure = unavailable();
        replies.fail(failure);
        reject(failure);
      }, handshakeTimeoutMs);
    });
    try {
      await Promise.race([child.ready, expired]);
      ownedChildReady = true;
      const remaining = Math.floor(handshakeTimeoutMs - (performance.now() - startedAt));
      if (remaining < 1) { throw unavailable(); }
      const hello = parseStrictJson(await Promise.race([replies.next(remaining), expired]));
      validateStartupHello(hello, nonce, expected);
      if (child.brokerClosed || replies.fault !== null) { throw unavailable(); }
      return new StartupMetadataSession(supervisor, child, replies, scope);
    } catch (error) {
      replies.fail(unavailable());
      await supervisor.stop('startupMetadata');
      if (!ownedChildReady && error instanceof SupervisorError && error.reason === 'abnormal-exit') { return null; }
      throw error;
    } finally { clearTimeout(timer); }
  }

  supports(scriptPath: string, args: readonly string[] = [], input?: Uint8Array): boolean {
    if (scriptPath === admissionScript || scriptPath === hashesScript) { return true; }
    return scriptPath === resourceScript && input === undefined && args.length === 8 && args[0] === '-Root'
      && args[2] === '-ScopeSha256' && args[4] === '-CompanionRoot' && args[6] === '-Mode'
      && (args[7] === 'Inventory' || args[7] === 'Marker');
  }
  get canFallBack(): boolean { return this.stoppedVerified; }

  async invoke(scriptPath: string, args: readonly string[], cwd: string, timeoutMs: number, input?: Uint8Array): Promise<CommandResult> {
    if (this.closed || this.inFlight || !this.supports(scriptPath, args, input) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) { throw unavailable(); }
    let operation: 'admit' | 'hash' | 'inventory';
    let fields: Record<string, unknown>;
    if (scriptPath === admissionScript) {
      if ((args.length !== 4 && args.length !== 5) || args[0] !== '-Root' || args[2] !== '-TargetsJson'
        || args[1] !== cwd || args.length === 5 && args[4] !== '-AllowMissing' || input !== undefined) { throw unavailable(); }
      const targets = parseStrictJson(Buffer.from(args[3]!, 'utf8'));
      if (!Array.isArray(targets) || targets.length < 1 || targets.length > 64 || !targets.every(target => typeof target === 'string')) { throw unavailable(); }
      operation = 'admit';
      fields = { targets, allowMissing: args.length === 5 };
    } else if (scriptPath === hashesScript) {
      if ((args.length !== 2 && args.length !== 4) || args[0] !== '-Root' || args[1] !== cwd || args.length === 4 && args[2] !== '-ScopeSha256'
        || input === undefined || input.byteLength < 1 || input.byteLength > maximumHashInput) { throw unavailable(); }
      const bound = args.length === 4 ? args[3]! : null;
      if (bound !== null && !isLowerHex(bound, 64)) { throw unavailable(); }
      operation = 'hash';
      const bytes = Buffer.from(input);
      fields = { inputBase64: bytes.toString('base64'), inputSha256: createHash('sha256').update(bytes).digest('hex'), scopeSha256: bound };
    } else {
      if (args[1] !== cwd || cwd !== this.scope.dataRoot || args[3] !== this.scope.bindingSha256
        || args[5] !== this.scope.companionRoot) { throw unavailable(); }
      operation = 'inventory';
      fields = { mode: args[7], scopeSha256: this.scope.bindingSha256, companionRoot: this.scope.companionRoot };
    }
    const id = randomBytes(16).toString('hex');
    const request = encodeStartupMetadataFrame({ version: 1, id, op: operation, root: cwd, remainingMs: timeoutMs, ...fields });
    this.inFlight = true;
    try {
      const next = this.replies.next(timeoutMs);
      void next.catch(() => undefined);
      this.child.stdin.write(request);
      return parseStartupMetadataReply(await next, id, operation);
    } catch (error) {
      await this.abort();
      throw error instanceof DataRootUnavailableError ? error : unavailable();
    } finally { this.inFlight = false; }
  }

  private async abort(): Promise<void> {
    this.closed = true;
    this.replies.fail(unavailable());
    await this.supervisor.stop('startupMetadata');
    this.stoppedVerified = true;
  }

  close(): Promise<void> {
    if (this.stoppedVerified) { return Promise.resolve(); }
    this.closePromise ??= (async () => {
      this.closed = true;
      this.replies.close();
      this.child.stdin.end();
      await this.supervisor.stop('startupMetadata', 2000);
      const exit = await this.child.terminated;
      if (this.replies.fault !== null || exit.code !== 0 || exit.failure !== null) { throw unavailable(); }
      this.stoppedVerified = true;
    })();
    return this.closePromise;
  }
}
