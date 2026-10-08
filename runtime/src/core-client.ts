import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Deadline } from './deadline.ts';
import { PathInspector } from './admission.ts';
import { isOpaqueToken } from './identity.ts';
import { logicalOutboxSequence } from './journal-records.ts';
import { asInt64, asInteger, hasExactKeys, isCanonicalUtc, isLowerHex, isObject, parseStrictJson, stringifyJson, type ControlInt64, type JsonValue } from './json.ts';
import { ProcessSupervisor, SupervisorError, type CommandResult } from './process.ts';
import { SerialQueue } from './serial.ts';

export interface CoreWarning { readonly code: string; readonly detail: string | null }
export interface CoreFailure {
  readonly success: false;
  readonly class: string;
  readonly reason: string;
  readonly consumptionState: 'none' | 'notConsumed' | 'consumed' | 'unknown';
  readonly generationTimestamp: string | null;
  readonly warnings: readonly CoreWarning[];
}
export interface PublishReceipt {
  readonly outcome: 'committed' | 'unchanged' | 'replayed';
  readonly kind: 'consumed' | 'snapshot' | 'resync' | null;
  readonly logicalOutboxId: string | null;
  readonly sequence: number | null;
  readonly schemaVersion: ControlInt64;
  readonly adapterVersion: ControlInt64;
  readonly game: string;
  readonly targetIdentitySha256: string | null;
  readonly targetGeneratedAt: string | null;
  readonly baselineApplied: boolean | null;
  readonly cacheDegraded: boolean;
  readonly warnings: readonly CoreWarning[];
}
export interface SettlementBinding { readonly logicalOutboxId: string; readonly recordSha256: string; readonly journalId: string; readonly eventId: string }
export interface ConsumerReceipt { readonly owner: 'runtime' | 'bridge'; readonly previousOwner: 'absent' | 'runtime' | 'bridge' | 'invalid'; readonly changed: boolean; readonly baselineRemoved: boolean; readonly abandonedCount: number }
export type CoreResult<T> = { readonly success: true; readonly value: T } | CoreFailure;
export type CoreRequest =
  | { readonly kind: 'publish'; readonly principal: string; readonly requireRecord: boolean; readonly repairOperationId: string | null }
  | { readonly kind: 'settlement'; readonly binding: SettlementBinding }
  | { readonly kind: 'consumer'; readonly owner: 'runtime' }
  | { readonly kind: 'consumer'; readonly owner: 'bridge'; readonly mode: 'confirmed' | 'abandon' };

interface ValidatedReply { readonly success: boolean; readonly class: string | null; readonly reason: string | null; readonly targetIdentitySha256: string | null; readonly data: { [key: string]: JsonValue } }
export interface CoreClientOptions {
  readonly companionRoot: string;
  readonly adapter: string;
  readonly supervisor: ProcessSupervisor;
  readonly inspector: PathInspector;
  // This callback must establish/verify the durable matching safety intent and
  // complete-transition reservation. The client never clears that intent itself.
  readonly admit: (request: CoreRequest, deadline: number | Deadline) => Promise<void>;
}

const replyScript = fileURLToPath(new URL('../scripts/Read-CoreReply.ps1', import.meta.url));
const principalScript = fileURLToPath(new URL('../scripts/Get-Principal.ps1', import.meta.url));
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const invalid = (): never => { throw new SupervisorError('result-invalid', 'Core result could not be admitted.'); };

function warnings(value: JsonValue | undefined): readonly CoreWarning[] {
  if (!Array.isArray(value)) { return invalid(); }
  return Object.freeze(value.map(item => {
    if (!hasExactKeys(item, ['code', 'detail']) || typeof item['code'] !== 'string' || item['detail'] !== null && typeof item['detail'] !== 'string') { return invalid(); }
    return Object.freeze({ code: item['code'], detail: item['detail'] });
  }));
}

function parseFailure(reply: ValidatedReply): CoreFailure {
  const data = reply.data;
  const consumption = data['consumptionState'];
  const generated = data['generationTimestamp'];
  if (reply.class === null || reply.reason === null || data['outcomeClass'] !== reply.class || !['none', 'notConsumed', 'consumed', 'unknown'].includes(consumption as string)
    || generated !== null && !isCanonicalUtc(generated)) { return invalid(); }
  return { success: false, class: reply.class, reason: reply.reason, consumptionState: consumption as CoreFailure['consumptionState'], generationTimestamp: generated, warnings: warnings(data['warnings']) };
}

export async function resolvePrincipal(inspector: PathInspector, companionRoot: string): Promise<string> {
  const reply = await inspector.metadata(principalScript, [], companionRoot);
  if (reply.exitCode !== 0) { throw new Error('identityUnavailable'); }
  const value = parseStrictJson(reply.stdout);
  if (!hasExactKeys(value, ['sid']) || !isOpaqueToken(value['sid'])) { throw new Error('identityUnavailable'); }
  return value['sid'];
}

export class CoreClient {
  private readonly options: CoreClientOptions;
  private readonly queue = new SerialQueue();

  constructor(options: CoreClientOptions) { this.options = options; }
  idle(): Promise<void> { return this.queue.idle(); }

  private remaining(deadline: number | Deadline, cap: number): number {
    const remaining = deadline instanceof Deadline ? deadline.remaining(cap) : Math.min(cap, Math.floor(deadline - performance.now()));
    if (Number.isNaN(remaining) || remaining <= 0) { throw new SupervisorError('deadline', 'Core command budget expired before the next operation.'); }
    return remaining;
  }

  private async validate(operation: 'Publish' | 'Settlement' | 'Consumer', result: CommandResult, deadline: number | Deadline): Promise<ValidatedReply> {
    let stdout: string;
    let stderr: string;
    try { stdout = decoder.decode(result.stdout); stderr = decoder.decode(result.stderr); }
    catch { return invalid(); }
    const input = Buffer.from(stringifyJson({ exitCode: result.exitCode, stdout, stderr }), 'utf8');
    const response = await this.options.inspector.metadata(replyScript, ['-CompanionRoot', this.options.companionRoot, '-Operation', operation], this.options.companionRoot, this.remaining(deadline, 30000), input);
    if (response.exitCode !== 0) { return invalid(); }
    const value = parseStrictJson(response.stdout);
    if (!hasExactKeys(value, ['coreReplyVersion', 'success', 'class', 'reason', 'targetIdentitySha256', 'data']) || asInteger(value['coreReplyVersion']) !== 1
      || typeof value['success'] !== 'boolean' || !isObject(value['data']) || value['targetIdentitySha256'] !== null && !isLowerHex(value['targetIdentitySha256'], 64)
      || value['success'] !== (result.exitCode === 0)) { return invalid(); }
    if (value['success'] ? value['class'] !== null || value['reason'] !== null : typeof value['class'] !== 'string' || typeof value['reason'] !== 'string' || value['targetIdentitySha256'] !== null) { return invalid(); }
    this.remaining(deadline, 30000);
    return { success: value['success'], class: value['class'] as string | null, reason: value['reason'] as string | null, targetIdentitySha256: value['targetIdentitySha256'], data: value['data'] };
  }

  private invoke(request: CoreRequest, script: string, operation: 'Publish' | 'Settlement' | 'Consumer', args: readonly string[], deadline: number | Deadline, cap: number, onTerminated?: (terminatedAt: number) => void): Promise<ValidatedReply> {
    return this.queue.run(async () => {
      this.remaining(deadline, cap);
      await this.options.admit(request, deadline);
      const timeout = this.remaining(deadline, cap);
      let result: CommandResult;
      try {
        result = await this.options.supervisor.run('core', { command: 'pwsh', args: ['-NoProfile', '-File', path.join(this.options.companionRoot, 'core', script), '-CompanionRoot', this.options.companionRoot, ...args], cwd: this.options.companionRoot }, timeout);
      } catch (error) {
        if (onTerminated !== undefined) {
          const observedAt = performance.now();
          await this.options.supervisor.verifyQuiescent('core');
          onTerminated(observedAt);
        }
        throw error;
      }
      // The validated receipt can require another helper. Charge that validation
      // to the settlement interval instead of starting a fresh interval after it.
      onTerminated?.(performance.now());
      return this.validate(operation, result, deadline);
    });
  }

  async publish(principal: string, requireRecord = false, repairOperationId: string | null = null, deadline: number | Deadline = Infinity, onTerminated?: (terminatedAt: number) => void): Promise<CoreResult<PublishReceipt>> {
    if (!isOpaqueToken(principal) || repairOperationId !== null && !isOpaqueToken(repairOperationId) || requireRecord && repairOperationId !== null) { return invalid(); }
    const request: CoreRequest = Object.freeze({ kind: 'publish', principal, requireRecord, repairOperationId });
    const args = ['-Adapter', this.options.adapter, '-Principal', principal, ...(requireRecord ? ['-RequireRecord'] : []), ...(repairOperationId === null ? [] : ['-Resync', '-RepairOperationId', repairOperationId])];
    const reply = await this.invoke(request, 'Publish-StateEvent.ps1', 'Publish', args, deadline, 3600000, onTerminated);
    if (!reply.success) { return parseFailure(reply); }
    const data = reply.data;
    const outcome = data['outcome'];
    const kind = data['kind'];
    const logical = data['logicalOutboxId'];
    const sequence = data['sequence'] === null ? null : asInteger(data['sequence']);
    const schema = asInt64(data['schemaVersion']);
    const adapter = asInt64(data['adapterVersion']);
    const target = data['target'];
    if (!['committed', 'unchanged', 'replayed'].includes(outcome as string) || kind !== null && !['consumed', 'snapshot', 'resync'].includes(kind as string)
      || logical !== null && (typeof logical !== 'string' || logicalOutboxSequence(logical) !== sequence) || sequence === undefined || schema === undefined || adapter === undefined
      || typeof data['game'] !== 'string' || typeof data['cacheDegraded'] !== 'boolean' || data['baselineApplied'] !== null && typeof data['baselineApplied'] !== 'boolean'
      || target !== null && (!isObject(target) || !isCanonicalUtc(target['generatedAt'])) || (target === null) !== (reply.targetIdentitySha256 === null)) { return invalid(); }
    if (repairOperationId !== null ? kind !== 'resync' || outcome === 'unchanged' : kind === 'resync' || outcome === 'replayed' || requireRecord && outcome === 'unchanged' || !requireRecord && kind === 'snapshot') { return invalid(); }
    return { success: true, value: Object.freeze({ outcome: outcome as PublishReceipt['outcome'], kind: kind as PublishReceipt['kind'], logicalOutboxId: logical as string | null, sequence, schemaVersion: schema,
      adapterVersion: adapter, game: data['game'], targetIdentitySha256: reply.targetIdentitySha256, targetGeneratedAt: target === null ? null : (target as { generatedAt: string }).generatedAt,
      baselineApplied: data['baselineApplied'], cacheDegraded: data['cacheDegraded'], warnings: warnings(data['warnings']) }) };
  }

  async settle(binding: SettlementBinding, deadline: number | Deadline = Infinity): Promise<CoreResult<'settled' | 'already-settled'>> {
    if (logicalOutboxSequence(binding.logicalOutboxId) === null || !isLowerHex(binding.recordSha256, 64) || !isOpaqueToken(binding.journalId) || !isOpaqueToken(binding.eventId)) { return invalid(); }
    const frozen = Object.freeze({ ...binding });
    const reply = await this.invoke(Object.freeze({ kind: 'settlement', binding: frozen }), 'Set-StateEventSettlement.ps1', 'Settlement', ['-LogicalOutboxId', frozen.logicalOutboxId, '-RecordSha256', frozen.recordSha256, '-JournalId', frozen.journalId, '-EventId', frozen.eventId], deadline, 120000);
    if (!reply.success) { return parseFailure(reply); }
    if (reply.data['logicalOutboxId'] !== frozen.logicalOutboxId || reply.data['outcome'] !== 'settled' && reply.data['outcome'] !== 'already-settled') { return invalid(); }
    return { success: true, value: reply.data['outcome'] };
  }

  async consumer(request: Extract<CoreRequest, { kind: 'consumer' }>, deadline: number | Deadline = Infinity): Promise<CoreResult<ConsumerReceipt>> {
    const frozen = Object.freeze({ ...request });
    if (frozen.owner !== 'runtime' && (frozen.owner !== 'bridge' || frozen.mode !== 'confirmed' && frozen.mode !== 'abandon')) { return invalid(); }
    const args = ['-Owner', frozen.owner, ...(frozen.owner === 'runtime' ? [] : [frozen.mode === 'confirmed' ? '-DeliveryConfirmed' : '-AbandonUndelivered'])];
    const reply = await this.invoke(frozen, 'Set-CompanionConsumer.ps1', 'Consumer', args, deadline, 120000);
    if (!reply.success) { return parseFailure(reply); }
    const data = reply.data;
    const count = asInteger(data['abandonedCount']);
    if (data['owner'] !== frozen.owner || !['absent', 'bridge', 'runtime', 'invalid'].includes(data['previousOwner'] as string) || typeof data['changed'] !== 'boolean'
      || typeof data['baselineRemoved'] !== 'boolean' || count === undefined || count < 0) { return invalid(); }
    return { success: true, value: { owner: frozen.owner, previousOwner: data['previousOwner'] as ConsumerReceipt['previousOwner'], changed: data['changed'], baselineRemoved: data['baselineRemoved'], abandonedCount: count } };
  }
}
