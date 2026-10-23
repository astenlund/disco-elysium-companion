import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NativeOperationError } from './admission.ts';
import type { Deadline } from './deadline.ts';
import { FilePublisher, PublicationError, type PublicationOptions } from './files.ts';
import { asInteger, hasExactKeys, isLowerHex, isObject, jsonBudgets, parseStrictJson, readBoundedFile, stringifyJson, type JsonValue } from './json.ts';
import { SupervisorError } from './process.ts';
import type { RuntimeScope } from './scope.ts';

export interface ContextCandidate {
  readonly shape: 1 | 2 | 3 | 4;
  readonly sha256: string;
  readonly fingerprint: string;
  readonly bytes: number;
  readonly eventCount: number;
  readonly stateIncluded: boolean;
  readonly degraded: 'eventTooLarge' | 'stateTooLarge' | null;
}
export interface ContextPreview { readonly candidates: readonly ContextCandidate[] }
export interface PreparedContext { readonly candidate: ContextCandidate; readonly cleanupComplete: boolean }
export interface ContextCopies { readonly text: string; readonly redeliveryText: string; readonly redeliveryCandidate: ContextCandidate }
export interface ContextReservation { readonly inputBytes: number; readonly maximumOutputBytes: number }
export interface ContextPreparerOptions {
  readonly scope: RuntimeScope;
  readonly publisher: FilePublisher;
  // Reads already-reconciled safety, operation and session authority; never publishes.
  readonly admit: (request: JsonValue, deadline?: Deadline) => Promise<boolean>;
  readonly reserve: (reservation: ContextReservation, deadline?: Deadline) => Promise<void>;
}

interface RedeliveryPlan { readonly candidate: ContextCandidate; readonly offsets: readonly number[] }
interface ContextReply { readonly candidates: readonly ContextCandidate[]; readonly redeliveries: ReadonlyMap<ContextCandidate, RedeliveryPlan>; readonly published: boolean; readonly cleanupComplete: boolean }
const maximumBytes = 4194304;
const targetName = 'prepared-context.txt';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function reply(value: JsonValue, requestSha256: string): ContextReply {
  if (Buffer.byteLength(stringifyJson(value), 'utf8') > 65536 || !hasExactKeys(value, ['contextResultVersion', 'requestSha256', 'published', 'cleanupComplete', 'candidates', 'redeliveryOffsets']) || asInteger(value['contextResultVersion']) !== 1
    || value['requestSha256'] !== requestSha256 || typeof value['published'] !== 'boolean' || typeof value['cleanupComplete'] !== 'boolean' || !Array.isArray(value['candidates']) || value['candidates'].length > 4
    || typeof value['redeliveryOffsets'] !== 'string' || value['redeliveryOffsets'].length > 43692) {
    throw new PublicationError('Context helper response is uncorrelated.');
  }
  const packed = Buffer.from(value['redeliveryOffsets'], 'base64');
  if (packed.length > 32768 || packed.length % 4 !== 0 || packed.toString('base64') !== value['redeliveryOffsets']) { throw new PublicationError('Context redelivery offsets are invalid.'); }
  const baseOffsets = Array.from({ length: packed.length / 4 }, (_, index) => packed.readUInt32LE(index * 4));
  if (baseOffsets.some((offset, index) => offset < 1 || offset + 5 > maximumBytes || index > 0 && offset < baseOffsets[index - 1]! + 5)) { throw new PublicationError('Context redelivery offsets overlap or escape their block.'); }
  const shapes = new Set<number>();
  const redeliveries = new Map<ContextCandidate, RedeliveryPlan>();
  let longestPlan = 0;
  const candidates = value['candidates'].map(item => {
    if (!hasExactKeys(item, ['shape', 'sha256', 'fingerprint', 'bytes', 'eventCount', 'stateIncluded', 'degraded', 'redeliverySha256', 'redeliveryBytes', 'redeliveryChanges', 'redeliveryOffsetDelta'])) { throw new PublicationError('Context candidate metadata is invalid.'); }
    const shape = asInteger(item['shape']);
    const size = asInteger(item['bytes']);
    const count = asInteger(item['eventCount']);
    const changes = asInteger(item['redeliveryChanges']);
    const redeliverySize = asInteger(item['redeliveryBytes']);
    const delta = asInteger(item['redeliveryOffsetDelta']);
    if (shape === undefined || shape < 1 || shape > 4 || shapes.has(shape) || !isLowerHex(item['sha256'], 64) || !isLowerHex(item['fingerprint'], 64)
      || size === undefined || size < 1 || size > maximumBytes || count === undefined || count < 0 || count > 8192 || typeof item['stateIncluded'] !== 'boolean'
      || item['degraded'] !== null && item['degraded'] !== 'eventTooLarge' && item['degraded'] !== 'stateTooLarge') { throw new PublicationError('Context candidate metadata is invalid.'); }
    shapes.add(shape);
    if (!isLowerHex(item['redeliverySha256'], 64) || changes === undefined || changes < 0 || changes > count || changes > baseOffsets.length
      || delta === undefined || Math.abs(delta) > maximumBytes || changes === 0 && delta !== 0 || redeliverySize !== size - changes || redeliverySize < 1) {
      throw new PublicationError('Context redelivery metadata is invalid.');
    }
    const offsets = baseOffsets.slice(0, changes).map(offset => offset + delta);
    if (offsets.some(offset => offset < 1 || offset + 5 > size)) { throw new PublicationError('Context redelivery plan escapes its candidate.'); }
    longestPlan = Math.max(longestPlan, changes);
    const candidate = Object.freeze({ shape: shape as ContextCandidate['shape'], sha256: item['sha256'], fingerprint: item['fingerprint'], bytes: size, eventCount: count, stateIncluded: item['stateIncluded'], degraded: item['degraded'] });
    redeliveries.set(candidate, Object.freeze({ candidate: Object.freeze({ ...candidate, sha256: item['redeliverySha256'], bytes: redeliverySize }), offsets: Object.freeze(offsets) }));
    return candidate;
  });
  if (longestPlan !== baseOffsets.length) { throw new PublicationError('Context redelivery vector has unbound positions.'); }
  return { candidates: Object.freeze(candidates), redeliveries, published: value['published'], cleanupComplete: value['cleanupComplete'] };
}

// Only native-identified control tokens change. Opaque payload bytes are copied
// verbatim, and the native exact result hash decides whether the transformation is valid.
function redeliveryBytes(primary: Buffer, plan: RedeliveryPlan): Buffer {
  const result = Buffer.alloc(plan.candidate.bytes);
  let source = 0;
  let destination = 0;
  for (const offset of plan.offsets) {
    if (offset < source || primary.subarray(offset, offset + 5).toString('ascii') !== 'false') { throw new PublicationError('Context redelivery token does not match its native plan.', true); }
    destination += primary.copy(result, destination, source, offset);
    result.write('true', destination, 'ascii'); destination += 4; source = offset + 5;
  }
  destination += primary.copy(result, destination, source);
  if (destination !== result.length || hash(result) !== plan.candidate.sha256) { throw new PublicationError('Context redelivery bytes do not match their native hash.', true); }
  return result;
}

// Preview tickets are local, one-use and bound to exact request bytes. The prepared
// file is never loaded as history and survives failure only for guarded cleanup.
export class ContextPreparer {
  private readonly options: ContextPreparerOptions;
  private latest: { readonly preview: ContextPreview; readonly bytes: Buffer; readonly redeliveries: ReadonlyMap<ContextCandidate, RedeliveryPlan>; consumed: boolean } | null = null;
  private active: { readonly handle: PreparedContext; readonly copies: ContextCopies; readonly request: Buffer; readonly ownership: PublicationOptions } | null = null;

  constructor(options: ContextPreparerOptions) { this.options = options; }

  get current(): PreparedContext | null { return this.active?.handle ?? null; }

  async preview(request: unknown, deadline?: Deadline): Promise<ContextPreview> {
    const bytes = Buffer.from(stringifyJson(request, 'state-event'));
    await this.requireAdmission(bytes, deadline);
    const preview = await this.options.publisher.exclusive(async options => {
      this.requireEmpty();
      this.latest = null;
      const result = await this.execute(options, bytes, 'Preview', null, deadline);
      if (result.response === null || result.response.published || !result.response.cleanupComplete) { throw new PublicationError('Context preview is unavailable.', true); }
      const preview = Object.freeze({ candidates: result.response.candidates });
      this.latest = { preview, bytes, redeliveries: result.response.redeliveries, consumed: false };
      return preview;
    }, deadline);
    try {
      await this.requireAdmission(bytes, deadline);
      if (this.latest?.preview !== preview) { throw new PublicationError('Context preview was superseded during admission.'); }
      return preview;
    } catch (error) {
      if (this.latest?.preview === preview) { this.latest = null; }
      throw error;
    }
  }

  async prepare(preview: ContextPreview, candidate: ContextCandidate, deadline?: Deadline): Promise<PreparedContext> {
    const ticket = this.latest;
    if (ticket === null || ticket.preview !== preview || ticket.consumed || !preview.candidates.includes(candidate)) { throw new PublicationError('Context preview ticket is stale or unknown.'); }
    const request = parseStrictJson(ticket.bytes, 'state-event');
    if (!isObject(request)) { throw new PublicationError('Context request is invalid.'); }
    request['shape'] = JSON.rawJSON(String(candidate.shape));
    const bytes = Buffer.from(stringifyJson(request, 'state-event'));
    let owned: PreparedContext | null = null;
    try {
      await this.requireAdmission(bytes, deadline);
      const prepared = await this.options.publisher.exclusive(async options => {
        this.requireEmpty();
        if (this.latest !== ticket || ticket.consumed) { throw new PublicationError('Context preview ticket changed before publication.'); }
        ticket.consumed = true;
        try {
          const plan = ticket.redeliveries.get(candidate);
          if (plan === undefined) { throw new PublicationError('Context candidate has no native redelivery plan.'); }
          const result = await this.execute(options, bytes, 'Publish', candidate, deadline, plan);
          if (result.text === null) { throw new PublicationError('Context publication is unavailable.', true); }
          if (this.active === null) { throw new PublicationError('Prepared context ownership was lost.', true); }
          return this.active.handle;
        } finally { owned = this.active?.handle ?? null; }
      }, deadline);
      await this.requireAdmission(bytes, deadline);
      if (this.active?.handle !== prepared) { throw new PublicationError('Prepared context was retired during admission.'); }
      return prepared;
    } catch (error) {
      if (owned !== null && this.active?.handle === owned) {
        try { await this.discard(owned); }
        catch { this.options.publisher.block(); }
      }
      throw error;
    }
  }

  discard(prepared: PreparedContext): Promise<void> {
    return this.options.publisher.exclusive(async options => {
      if (this.active?.handle !== prepared) { throw new PublicationError('Prepared context ownership is unavailable.'); }
      await this.verifyScope(options);
      const target = path.join(this.options.scope.dataRoot, targetName);
      try {
        const admitted = await options.inspector.inspect(options.root, target, true);
        if (admitted.exists) {
          if (admitted.kind !== 'file' || hash(await readBoundedFile(target, maximumBytes)) !== prepared.candidate.sha256) { throw new PublicationError('Prepared context changed before cleanup.', true); }
          await fs.unlink(target);
        }
        this.active = null;
      } catch (error) { this.options.publisher.block(); throw error; }
    });
  }

  async copyForSend(prepared: PreparedContext, deadline?: Deadline): Promise<string> {
    return (await this.copyVariantsForSend(prepared, deadline)).text;
  }

  async copyVariantsForSend(prepared: PreparedContext, deadline?: Deadline): Promise<ContextCopies> {
    const active = this.active;
    if (active === null || active.handle !== prepared || !active.ownership.guard.held) { throw new PublicationError('Prepared context has no current send authority.'); }
    await this.verifyScope(active.ownership, deadline);
    await this.requireAdmission(active.request, deadline);
    deadline?.check();
    if (this.active !== active || !active.ownership.guard.held) { throw new PublicationError('Prepared context ownership changed during its send check.'); }
    return active.copies;
  }

  private requireEmpty(): void {
    if (this.active !== null) { throw new PublicationError('The preceding prepared context still owns its artifact.'); }
  }

  // Admission may read ScopeStorage. Keep it outside publication ownership:
  // binding writes take the storage queue before the publication queue.
  private async requireAdmission(bytes: Buffer, deadline?: Deadline): Promise<void> {
    deadline?.check();
    const request = parseStrictJson(bytes, 'state-event');
    const scope = this.options.scope;
    if (!isObject(request) || request['scopeSha256'] !== scope.bindingSha256 || request['game'] !== scope.game || request['principal'] !== scope.principal
      || !await this.options.admit(request, deadline)) { throw new PublicationError('Context snapshot has no current authority.'); }
    deadline?.check();
  }

  private async verifyScope(options: PublicationOptions, deadline?: Deadline): Promise<void> {
    if (!options.guard.held || path.win32.relative(options.root, this.options.scope.dataRoot) !== '') { throw new PublicationError('Context writer ownership is unavailable.', true); }
    const binding = path.join(options.root, 'scope.json');
    const observed = await options.inspector.inspect(options.root, binding, false, deadline?.remaining());
    if (observed.kind !== 'file' || hash(await readBoundedFile(binding, jsonBudgets.config.maxBytes)) !== this.options.scope.bindingSha256) { throw new PublicationError('Immutable context scope changed.', true); }
    deadline?.check();
  }

  private async execute(options: PublicationOptions, bytes: Buffer, mode: 'Preview' | 'Publish', expected: ContextCandidate | null, deadline?: Deadline, redelivery?: RedeliveryPlan): Promise<{ response: ContextReply | null; text: string | null }> {
    const request = parseStrictJson(bytes, 'state-event');
    const scope = this.options.scope;
    if (path.win32.relative(options.root, scope.dataRoot) !== '' || !isObject(request) || request['scopeSha256'] !== scope.bindingSha256 || request['game'] !== scope.game || request['principal'] !== scope.principal) {
      throw new PublicationError('Context snapshot has no current authority.');
    }
    const publisher = this.options.publisher;
    const target = path.join(scope.dataRoot, targetName);
    const input = `${target}.${randomBytes(16).toString('hex')}.tmp`;
    const inputHash = hash(bytes);
    let created = false;
    let ended = true;
    let attempted = false;
    let reconciled = false;
    let response: ContextReply | null = null;
    let text: string | null = null;
    // The caller already holds publication ownership. This internal call must not
    // enqueue on that same queue again.
    const admitted = await options.inspector.inspectMany(scope.dataRoot, [target, input], true, deadline?.remaining());
    if (admitted[0]!.exists || admitted[1]!.exists) { throw new PublicationError('Prepared-context workspace is occupied.'); }
    await this.options.reserve({ inputBytes: bytes.length, maximumOutputBytes: mode === 'Publish' ? maximumBytes : 0 }, deadline);
    deadline?.check();
    try {
      await this.verifyScope(options, deadline);
      const handle = await fs.open(input, 'wx');
      created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      publisher.assertAvailable();
      const timeout = deadline?.remaining() ?? 30000;
      attempted = mode === 'Publish';
      const outcome = await publisher.runNativeMutation('contextPreparation', { root: scope.dataRoot, inputFile: input, inputSha256: inputHash, mode }, timeout);
      if (!outcome.ended) {
        ended = false;
        publisher.block();
        throw new SupervisorError('termination-unverified', 'Context helper termination is unverified.', { cause: outcome.failure });
      }
      if (outcome.result !== null) { response = reply(outcome.result, inputHash); }
      else if (!(outcome.failure instanceof NativeOperationError && outcome.failure.code !== 'unavailable') && (mode === 'Preview' || !attempted)) {
        // A request that failed outright leaves a preview nothing to reconcile; an error reply leaves the response empty.
        throw outcome.failure;
      }
      if (mode === 'Publish' && expected !== null) {
        const actualPath = await options.inspector.inspect(scope.dataRoot, target, true);
        if (!actualPath.exists) { reconciled = true; throw new PublicationError('Prepared target was not published.'); }
        if (actualPath.kind !== 'file') { throw new PublicationError('Prepared target changed object kind.', true); }
        const actual = await readBoundedFile(target, maximumBytes);
        if (actual.length !== expected.bytes || hash(actual) !== expected.sha256) { throw new PublicationError('Prepared target differs from its preview.', true); }
        if (redelivery === undefined) { throw new PublicationError('Prepared target has no native redelivery plan.', true); }
        const alternate = redeliveryBytes(actual, redelivery);
        text = decoder.decode(actual);
        reconciled = true;
        const cleanupComplete = response !== null && response.published && response.cleanupComplete;
        const copies = Object.freeze({ text, redeliveryText: decoder.decode(alternate), redeliveryCandidate: redelivery.candidate });
        this.active = { handle: Object.freeze({ candidate: expected, cleanupComplete }), copies, request: Buffer.from(bytes), ownership: options };
        if (!cleanupComplete) { publisher.block(); }
      } else if (response === null || response.published || !response.cleanupComplete) { throw new PublicationError('Context preview did not complete.'); }
      deadline?.check();
    } catch (error) {
      if (attempted) { options.invalidate(target); }
      if (!ended || attempted && !reconciled || error instanceof PublicationError && error.uncertain) { publisher.block(); }
      throw error;
    } finally {
      if (created && ended && options.guard.held) {
        try {
          await this.verifyScope(options);
          const owned = await options.inspector.inspect(scope.dataRoot, input, true);
          if (owned.exists) {
            if (owned.kind !== 'file' || hash(await readBoundedFile(input, jsonBudgets['state-event'].maxBytes)) !== inputHash) { throw new PublicationError('Context staging changed.', true); }
            await fs.unlink(input);
          }
        } catch { publisher.block(); }
      } else if (created) { publisher.block(); }
    }
    if (mode === 'Preview') { publisher.assertAvailable(); }
    if (this.active !== null && publisher.blocked && this.active.handle.cleanupComplete) {
      this.active = { ...this.active, handle: Object.freeze({ ...this.active.handle, cleanupComplete: false }) };
    }
    deadline?.check();
    return { response, text };
  }

}
