import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { DataRootUnavailableError } from './admission.ts';
import { asInteger, hasExactKeys, isLowerHex, parseStrictJson, type JsonValue } from './json.ts';
import { SupervisorError, type OwnedProcess, type ProcessRole, type ProcessSupervisor } from './process.ts';
import type { RuntimeScope } from './scope.ts';
import { encodeStartupMetadataFrame, FramedReplies, maximumNormalOutput, validateStartupHello } from './startup-metadata.ts';
import { startupWorkerInstallationRoot } from './startup-worker-sources.ts';

type StartupTransportRole = Extract<ProcessRole, 'startupCoreReply' | 'startupMutation'>;
export type StartupWorkerReply = { readonly status: 'ok'; readonly result: JsonValue } | { readonly status: 'error'; readonly code: string };

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup worker transport is unavailable.'); }

export class StartupWorkerTransport {
  readonly role: StartupTransportRole;
  private readonly supervisor: ProcessSupervisor;
  private readonly child: OwnedProcess;
  private readonly replies: FramedReplies;
  private readonly root: string;
  private inFlight = false;
  private closed = false;
  private stoppedVerified = false;
  private closePromise: Promise<void> | null = null;

  private constructor(supervisor: ProcessSupervisor, role: StartupTransportRole, child: OwnedProcess,
    replies: FramedReplies, root: string) {
    this.supervisor = supervisor; this.role = role; this.child = child; this.replies = replies; this.root = root;
  }

  static async open(supervisor: ProcessSupervisor, scope: RuntimeScope, role: StartupTransportRole, script: string,
    sourceSha256: string, handshakeTimeoutMs = 30000): Promise<StartupWorkerTransport | null> {
    if (!isLowerHex(sourceSha256, 64) || !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 30000) {
      throw unavailable();
    }
    const nonce = randomBytes(16).toString('hex');
    const tempRoot = path.join(scope.companionRoot, '.tmp');
    let child: OwnedProcess;
    try {
      child = supervisor.spawn(role, { command: 'pwsh', args: ['-NoProfile', '-File', script,
        '-CompanionRoot', scope.companionRoot, '-DataRoot', scope.dataRoot,
        '-SourceRoot', startupWorkerInstallationRoot, '-Nonce', nonce], cwd: scope.companionRoot,
      env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } });
    } catch {
      await supervisor.verifyQuiescent(role);
      return null;
    }
    const replies = new FramedReplies(child, maximumNormalOutput);
    let ownedChildReady = false;
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const failure = unavailable(); replies.fail(failure); reject(failure); }, handshakeTimeoutMs);
    });
    try {
      await Promise.race([child.ready, expired]);
      ownedChildReady = true;
      const remaining = Math.floor(handshakeTimeoutMs - (performance.now() - startedAt));
      if (remaining < 1) { throw unavailable(); }
      validateStartupHello(parseStrictJson(await Promise.race([replies.next(remaining), expired])), nonce,
        { scopeSha256: scope.bindingSha256, sourceSha256 });
      if (child.brokerClosed || replies.fault !== null) { throw unavailable(); }
      return new StartupWorkerTransport(supervisor, role, child, replies,
        role === 'startupCoreReply' ? scope.companionRoot : scope.dataRoot);
    } catch (error) {
      replies.fail(unavailable());
      await supervisor.stop(role);
      if (!ownedChildReady && error instanceof SupervisorError && error.reason === 'abnormal-exit') { return null; }
      throw error;
    } finally { clearTimeout(timer); }
  }

  get canFallBack(): boolean { return this.stoppedVerified; }

  async request(operation: string, fields: Record<string, unknown>, timeoutMs: number): Promise<StartupWorkerReply> {
    if (this.closed || this.inFlight || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) { throw unavailable(); }
    const id = randomBytes(16).toString('hex');
    const frame = encodeStartupMetadataFrame({ ...fields, version: 1, id, op: operation, root: this.root, remainingMs: timeoutMs });
    this.inFlight = true;
    const startedAt = performance.now();
    try {
      const pending = this.replies.next(timeoutMs);
      void pending.catch(() => undefined);
      this.child.stdin.write(frame);
      const response = parseStrictJson(await pending);
      if (performance.now() - startedAt >= timeoutMs || this.child.brokerClosed || this.replies.fault !== null) { throw unavailable(); }
      if (hasExactKeys(response, ['version', 'id', 'op', 'status', 'result']) && response['status'] === 'ok'
        && response['version'] !== undefined && response['result'] !== undefined) {
        this.validateCorrelation(response, id, operation);
        return { status: 'ok', result: response['result'] };
      }
      if (hasExactKeys(response, ['version', 'id', 'op', 'status', 'code']) && response['status'] === 'error'
        && typeof response['code'] === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(response['code'])) {
        this.validateCorrelation(response, id, operation);
        return { status: 'error', code: response['code'] };
      }
      throw unavailable();
    } catch (error) {
      await this.abort();
      throw error instanceof DataRootUnavailableError ? error : unavailable();
    } finally { this.inFlight = false; }
  }

  private validateCorrelation(response: Record<string, JsonValue>, id: string, operation: string): void {
    if (asInteger(response['version']) !== 1 || response['id'] !== id || response['op'] !== operation) { throw unavailable(); }
  }

  private async abort(): Promise<void> {
    if (this.stoppedVerified) { return; }
    this.closed = true;
    this.replies.fail(unavailable());
    await this.supervisor.stop(this.role);
    this.stoppedVerified = true;
  }

  invalidate(): Promise<void> { return this.abort(); }

  close(): Promise<void> {
    if (this.stoppedVerified) { return Promise.resolve(); }
    this.closePromise ??= (async () => {
      this.closed = true;
      this.replies.close();
      this.child.stdin.end();
      await this.supervisor.stop(this.role, 2000);
      const exit = await this.child.terminated;
      if (this.replies.fault !== null || exit.code !== 0 || exit.failure !== null) { throw unavailable(); }
      this.stoppedVerified = true;
    })();
    return this.closePromise;
  }
}
