import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PathAdmission } from './admission.ts';
import { Deadline } from './deadline.ts';
import { admitStagingPaths, FilePublisher, PublicationError, type AdmitPublicationScope } from './files.ts';
import { asInteger, hasExactKeys, isLowerHex, isObject, jsonBudgets, parseStrictJson, readBoundedFile, stringifyJson, type JsonValue } from './json.ts';
import { SupervisorError } from './process.ts';

export class CodecDocumentError extends Error { override readonly name = 'CodecDocumentError'; }
type JsonObject = { [key: string]: JsonValue };

export interface CodecReservation {
  readonly target: string;
  readonly inputBytes: number;
  readonly controlBytes: number;
  readonly maximumOutputBytes: number;
  readonly publication: boolean;
}

export interface CodecResult {
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly bytes: Buffer;
  readonly cleanupComplete: boolean;
}
export type CodecPreview = Omit<CodecResult, 'bytes'>;

export interface SourceInspectionReceipt { readonly sourceInspection: true }
interface SourceInspection { readonly sha256: string; readonly metadata: string; readonly expectedSequence: number }

interface CodecRequest {
  readonly mode: 'source' | 'event' | 'create' | 'rewrite' | 'reconstruct';
  readonly metadata: unknown;
  readonly compact: boolean;
  readonly expectedSequence: number;
  readonly createOnly: boolean;
  readonly binding: string | null;
}

interface CodecReply { readonly sha256: string; readonly published: boolean; readonly cleanupComplete: boolean; readonly metadata: JsonObject }
const script = fileURLToPath(new URL('../scripts/Invoke-PayloadCodec.ps1', import.meta.url));
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function parseReply(bytes: Buffer): CodecReply {
  const value = parseStrictJson(bytes);
  if (!hasExactKeys(value, ['codecVersion', 'sha256', 'published', 'cleanupComplete', 'metadata']) || asInteger(value['codecVersion']) !== 1 || !isLowerHex(value['sha256'], 64)
    || typeof value['published'] !== 'boolean' || typeof value['cleanupComplete'] !== 'boolean' || !isObject(value['metadata'])) {
    throw new SupervisorError('result-invalid', 'Codec returned malformed control metadata.');
  }

  return { sha256: value['sha256'], published: value['published'], cleanupComplete: value['cleanupComplete'], metadata: value['metadata'] };
}

// All payload bytes are opaque here. The native codec validates and projects only
// control metadata, while the publisher owns serialization, staging and shutdown.
export class PayloadCodec {
  private readonly publisher: FilePublisher;
  private readonly sourceInspections = new WeakMap<SourceInspectionReceipt, SourceInspection>();
  private readonly reserve: (reservation: CodecReservation, deadline?: Deadline) => Promise<void>;
  private readonly reserveWithAdmission?: (reservation: CodecReservation, admit: AdmitPublicationScope, deadline?: Deadline) => Promise<void>;

  constructor(publisher: FilePublisher, reserve: (reservation: CodecReservation, deadline?: Deadline) => Promise<void>, reserveWithAdmission?: (reservation: CodecReservation, admit: AdmitPublicationScope, deadline?: Deadline) => Promise<void>) {
    this.publisher = publisher;
    this.reserve = reserve;
    this.reserveWithAdmission = reserveWithAdmission;
  }

  inspectSource(source: Uint8Array, expectedSequence: number, deadline: number | Deadline = Infinity): Promise<CodecResult> {
    return this.execute('codec.json', source, { mode: 'source', metadata: null, compact: false, expectedSequence, createOnly: false, binding: null }, deadline);
  }

  async inspectSourceWithReceipt(source: Uint8Array, expectedSequence: number, deadline: number | Deadline = Infinity): Promise<CodecResult & { readonly receipt: SourceInspectionReceipt }> {
    const inspected = await this.inspectSource(source, expectedSequence, deadline);
    if (!inspected.cleanupComplete) {
      this.publisher.block();
      throw new PublicationError('Source inspection cleanup is incomplete.', true);
    }
    this.publisher.assertAvailable();
    const receipt: SourceInspectionReceipt = Object.freeze({ sourceInspection: true });
    this.sourceInspections.set(receipt, { sha256: inspected.sha256, metadata: stringifyJson(inspected.metadata), expectedSequence });
    return { ...inspected, receipt };
  }

  // This single-use receipt proves validation of bytes, never current disk or safety authority.
  consumeSourceInspection(receipt: SourceInspectionReceipt, frozen: Uint8Array, expectedSequence: number, deadline?: Deadline): Pick<CodecResult, 'sha256' | 'metadata'> {
    const inspected = this.sourceInspections.get(receipt);
    this.sourceInspections.delete(receipt);
    this.publisher.assertAvailable();
    deadline?.check();
    if (inspected === undefined || inspected.expectedSequence !== expectedSequence || inspected.sha256 !== hash(frozen)) {
      throw new CodecDocumentError('Source inspection receipt does not match this codec and frozen source.');
    }
    return { sha256: inspected.sha256, metadata: parseStrictJson(Buffer.from(inspected.metadata, 'utf8')) as JsonObject };
  }

  inspectEvent(source: Uint8Array, deadline: number | Deadline = Infinity): Promise<CodecResult> {
    return this.execute('codec.json', source, { mode: 'event', metadata: null, compact: false, expectedSequence: 0, createOnly: false, binding: null }, deadline);
  }

  createEvent(target: string, source: Uint8Array, metadata: unknown, expectedSequence: number, deadline: number | Deadline = Infinity): Promise<CodecResult> {
    return this.execute(target, source, { mode: 'create', metadata, compact: false, expectedSequence, createOnly: true, binding: null }, deadline);
  }

  rewriteEvent(target: string, source: Uint8Array, metadata: unknown, compact: boolean, createOnly = false, deadline: number | Deadline = Infinity): Promise<CodecResult> {
    return this.execute(target, source, { mode: 'rewrite', metadata, compact, expectedSequence: 0, createOnly, binding: null }, deadline);
  }

  reconstructEvent(target: string, source: Uint8Array, metadata: unknown, expectedSequence: number, binding: string, createOnly = true, deadline: number | Deadline = Infinity): Promise<CodecResult> {
    return this.execute(target, source, { mode: 'reconstruct', metadata, compact: false, expectedSequence, createOnly, binding }, deadline);
  }

  async previewEvent(target: string, source: Uint8Array, metadata: unknown, sourceKind: 'outbox' | 'event', binding: string, expectedSequence = 0, deadline: number | Deadline = Infinity): Promise<CodecPreview> {
    const result = await this.execute(target, source, { mode: sourceKind === 'outbox' ? 'reconstruct' : 'rewrite', metadata, compact: false, expectedSequence, createOnly: true, binding: sourceKind === 'outbox' ? binding : null }, deadline, true);
    if (result.metadata['payloadBindingSha256'] !== binding) { throw new CodecDocumentError('Preview does not preserve the retained payload binding.'); }
    return { sha256: result.sha256, metadata: result.metadata, cleanupComplete: result.cleanupComplete };
  }

  private execute(relative: string, source: Uint8Array, request: CodecRequest, deadline: number | Deadline, preview = false): Promise<CodecResult> {
    if (source.byteLength > jsonBudgets['state-event'].maxBytes) { return Promise.reject(new CodecDocumentError('Codec input exceeds its byte budget.')); }
    if (!Number.isSafeInteger(request.expectedSequence) || request.expectedSequence < 0 || Number.isNaN(deadline)) { return Promise.reject(new CodecDocumentError('Codec request is invalid.')); }
    const frozen = Buffer.from(source);
    const control = Buffer.from(stringifyJson(request, 'config'), 'utf8');
    const sourceHash = hash(frozen);
    const controlHash = hash(control);
    const mutation = !preview && (request.mode === 'create' || request.mode === 'rewrite' || request.mode === 'reconstruct');

    return this.publisher.exclusive(async options => {
      const remaining = (requireWorkspace = true): number => {
        if (requireWorkspace) { this.publisher.assertAvailable(); }
        const time = deadline instanceof Deadline ? deadline.remaining() : Math.min(30000, Math.floor(deadline - performance.now()));
        if (time <= 0) { throw new SupervisorError('deadline', 'Codec request exhausted its interaction budget.'); }
        return time;
      };
      remaining();
      const target = path.resolve(options.root, relative);
      const input = `${target}.${randomBytes(16).toString('hex')}.tmp`;
      const controlFile = `${target}.${randomBytes(16).toString('hex')}.tmp`;
      const staged = [{ path: input, bytes: frozen, sha256: sourceHash, created: false }, { path: controlFile, bytes: control, sha256: controlHash, created: false }];
      const reservation = { target, inputBytes: frozen.length, controlBytes: control.length, maximumOutputBytes: mutation ? jsonBudgets['state-event'].maxBytes : 0, publication: mutation };
      const bounded = deadline instanceof Deadline ? deadline : undefined;
      const validateDestination = (initial: readonly PathAdmission[]): void => {
        if (initial[0]!.kind === 'directory' || initial[0]!.missing.length > 1 || mutation && request.createOnly && initial[0]!.exists) {
          throw new PublicationError('Codec destination is inadmissible or already exists.');
        }
      };
      let accounted = false;
      try {
        const initial = this.reserveWithAdmission === undefined
          ? await options.inspector.inspectMany(options.root, [target, input, controlFile], true, remaining())
          : await admitStagingPaths(options.inspector, options.root, [target, input, controlFile], async admit => {
            await this.reserveWithAdmission!(reservation, admit, bounded);
            accounted = true;
          }, remaining, validateDestination);
        validateDestination(initial);
        if (this.reserveWithAdmission === undefined) { await this.reserve(reservation, bounded); accounted = true; }
        remaining();
      } catch (error) {
        if (mutation && accounted) { options.invalidate(target); }
        throw error;
      }
      let helperEnded = true;
      let cleanupComplete = true;
      let publicationAttempted = false;
      let publicationReconciled = false;
      let reply: CodecReply | null = null;
      let actual: Buffer = frozen;
      try {
        for (const item of staged) {
          remaining();
          const handle = await fs.open(item.path, 'wx');
          item.created = true;
          try { await handle.writeFile(item.bytes); await handle.sync(); }
          finally { await handle.close(); }
        }
        const args = ['-NoProfile', '-File', script, '-Root', options.root, '-Target', target, '-InputFile', input, '-InputSha256', sourceHash, '-ControlFile', controlFile, '-ControlSha256', controlHash, ...(preview ? ['-Preview'] : [])];
        const invoke = async (verifyOnly: boolean): Promise<CodecReply> => {
          const timeout = remaining();
          if (mutation && !verifyOnly) { publicationAttempted = true; }
          try {
            const result = await options.supervisor.run('publication', { command: 'pwsh', args: [...args, ...(verifyOnly ? ['-VerifyOnly'] : [])], cwd: options.root }, timeout);
            if (result.exitCode !== 0) {
              if (result.stderr.toString('utf8').trim() === 'Invoke-PayloadCodec: document-invalid') { throw new CodecDocumentError('Codec rejected an invalid document.'); }
              throw new SupervisorError('result-invalid', 'Codec helper could not complete.');
            }
            return parseReply(result.stdout);
          } catch (error) {
            if (error instanceof SupervisorError && error.reason === 'termination-unverified') { helperEnded = false; this.publisher.block(); }
            throw error;
          }
        };
        try { reply = await invoke(false); }
        catch (error) {
          if (!mutation || !helperEnded || error instanceof CodecDocumentError) { throw error; }
          // Recompute from the still-frozen source/control without another publication.
          // This establishes exact target bytes, but cannot prove the lost helper's cleanup.
          cleanupComplete = false;
          reply = await invoke(true);
        }
        if (mutation) {
          if (!reply.published) { publicationReconciled = true; throw new PublicationError('Codec target does not contain its expected complete publication.'); }
          await options.inspector.inspect(options.root, target, false, remaining());
          actual = await readBoundedFile(target, jsonBudgets['state-event'].maxBytes);
          if (hash(actual) !== reply.sha256) { throw new PublicationError('Codec publication changed before readback.', true); }
          publicationReconciled = true;
        } else if ((!preview && reply.sha256 !== sourceHash) || reply.published) {
          throw new SupervisorError('result-invalid', 'Codec inspection does not match the frozen input.');
        }
        cleanupComplete &&= reply.cleanupComplete;
      } catch (error) {
        if (mutation && accounted) { options.invalidate(target); }
        if (!helperEnded || error instanceof PublicationError && error.uncertain || publicationAttempted && !publicationReconciled && !(error instanceof CodecDocumentError)) { this.publisher.block(); }
        throw error;
      } finally {
        const owned = staged.filter(item => item.created);
        if (owned.length > 0 && helperEnded && options.guard.held) {
          try {
            const admissions = await options.inspector.inspectMany(options.root, owned.map(item => item.path), true);
            for (const [index, item] of owned.entries()) {
              const admission = admissions[index]!;
              if (admission.exists) {
                if (admission.kind !== 'file' || hash(await readBoundedFile(item.path, item.bytes.length)) !== item.sha256) { throw new PublicationError('Owned codec staging changed.', true); }
                await fs.unlink(item.path);
              }
            }
          } catch { cleanupComplete = false; }
        } else if (owned.length > 0) { cleanupComplete = false; }
        if (!cleanupComplete) { this.publisher.block(); }
      }
      if (reply === null) { throw new SupervisorError('result-invalid', 'Codec did not return a verified result.'); }
      try { remaining(false); }
      catch (error) { if (mutation) { options.invalidate(target); } throw error; }

      return { sha256: reply.sha256, metadata: reply.metadata, bytes: preview ? Buffer.alloc(0) : Buffer.from(actual), cleanupComplete };
    });
  }
}
