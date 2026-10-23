import { createHash } from 'node:crypto';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import { Deadline } from './deadline.ts';
import { readFileHashes } from './file-hashes.ts';
import { parseEventDescription, type EventDescription } from './journal-records.ts';
import { hasExactKeys, isLowerHex, jsonBudgets, stringifyJson, type JsonValue } from './json.ts';

export interface EventReadRequest { readonly path: string; readonly sequence: number }
export type EventRead =
  | { readonly path: string; readonly status: 'absent'; readonly sha256: null }
  | { readonly path: string; readonly status: 'invalid'; readonly sha256: string | null }
  | { readonly path: string; readonly status: 'valid'; readonly sha256: string; readonly metadata: EventDescription };

type ValidEvent = Extract<EventRead, { status: 'valid' }>;
const maximumCacheEntries = 16_384;
const maximumCacheBytes = 64 * 1024 * 1024;
const maximumBatchRecords = 512;

function parseDocuments(documents: readonly JsonValue[], requests: readonly EventReadRequest[]): EventRead[] {
  return documents.map((document, index): EventRead => {
    if (!hasExactKeys(document, ['path', 'status', 'sha256', 'metadata']) || document['path'] !== requests[index]!.path) { throw new DataRootUnavailableError('Event inspection response is uncorrelated.'); }
    const target = document['path'];
    if (document['status'] === 'absent' && document['sha256'] === null && document['metadata'] === null) { return { path: target, status: 'absent', sha256: null }; }
    if (document['status'] === 'invalid' && (document['sha256'] === null || isLowerHex(document['sha256'], 64)) && document['metadata'] === null) {
      return { path: target, status: 'invalid', sha256: document['sha256'] };
    }
    if (document['status'] === 'valid' && isLowerHex(document['sha256'], 64) && document['metadata'] !== undefined) {
      const metadata = parseEventDescription(document['metadata']);
      if (requests[index]!.sequence !== 0 && metadata.sequence !== requests[index]!.sequence) { throw new DataRootUnavailableError('Event inspection position is uncorrelated.'); }
      return { path: target, status: 'valid', sha256: document['sha256'], metadata };
    }
    throw new DataRootUnavailableError('Event inspection response is invalid.');
  });
}

// Inspection performs no staging, repair or cleanup and needs no writer guard.
export class EventReader {
  private readonly root: string;
  private readonly inspector: PathInspector;
  private readonly cache = new Map<string, { value: ValidEvent; bytes: number }>();
  private cacheBytes = 0;
  private epoch = 0;

  constructor(root: string, inspector: PathInspector) { this.root = root; this.inspector = inspector; }

  invalidate(): void { this.cache.clear(); this.cacheBytes = 0; this.epoch++; }

  private remember(value: EventRead): void {
    const previous = this.cache.get(value.path);
    if (previous !== undefined) { this.cache.delete(value.path); this.cacheBytes -= previous.bytes; }
    if (value.status !== 'valid') { return; }
    const bytes = Buffer.byteLength(stringifyJson(value), 'utf8');
    if (bytes > maximumCacheBytes) { return; }
    while (this.cache.size >= maximumCacheEntries || this.cacheBytes + bytes > maximumCacheBytes) {
      const oldest = this.cache.entries().next().value;
      if (oldest === undefined) { break; }
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].bytes;
    }
    this.cache.set(value.path, { value: structuredClone(value), bytes });
    this.cacheBytes += bytes;
  }

  // Every hit requires fresh native path admission and the complete current hash.
  // Cached metadata is parsing work only; headers, cursors and bindings stay fresh.
  async readInventory(requests: readonly EventReadRequest[], deadline = Deadline.after(30000)): Promise<readonly EventRead[]> {
    const epoch = this.epoch;
    const frozen = requests.map(request => ({ path: path.resolve(this.root, request.path), sequence: request.sequence }));
    const results = new Map<string, EventRead>();
    const pending: EventReadRequest[] = [];
    try {
      if (frozen.some(request => !Number.isSafeInteger(request.sequence) || request.sequence <= 0) || new Set(frozen.map(request => request.path)).size !== frozen.length) {
        throw new DataRootUnavailableError('Invalid journal event inventory.');
      }
      const cached = frozen.filter(request => this.cache.has(request.path));
      const hashes = await readFileHashes(this.inspector, this.root, cached.map(request => request.path), deadline);
      for (const [index, request] of cached.entries()) {
        const value = this.cache.get(request.path)?.value;
        if (value !== undefined && value.sha256 === hashes[index] && value.metadata.sequence === request.sequence) {
          results.set(request.path, structuredClone(value));
        }
      }
      for (const request of frozen) { if (!results.has(request.path)) { pending.push(request); } }
      for (let offset = 0; offset < pending.length;) {
        const values = await this.readBatch(pending.slice(offset, offset + maximumBatchRecords), deadline);
        deadline.check();
        for (const value of values) { results.set(value.path, value); }
        offset += values.length;
      }
      deadline.check();
      if (epoch !== this.epoch) { throw new DataRootUnavailableError('Event inventory was invalidated while being read.'); }
      const ordered = frozen.map(request => results.get(request.path)!);
      for (const value of ordered) { this.remember(value); }
      deadline.check();
      return ordered;
    } catch (error) { this.invalidate(); throw error; }
  }

  private async readBatch(requests: readonly EventReadRequest[], deadline: Deadline): Promise<readonly EventRead[]> {
    deadline.check();
    const batch: EventReadRequest[] = [];
    let bytes = 2;
    let textBytes = 0;
    for (const request of requests) {
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(request), 'utf8') + (batch.length === 0 ? 0 : 1);
      const nextTextBytes = textBytes + Buffer.byteLength(request.path, 'utf8') + 12;
      if (nextBytes > jsonBudgets.config.maxBytes || nextTextBytes > jsonBudgets.config.maxTextBytes) { break; }
      batch.push(request);
      bytes = nextBytes;
      textBytes = nextTextBytes;
    }
    if (batch.length === 0) { throw new DataRootUnavailableError('Event inspection request exceeds its control budget.'); }
    const input = Buffer.from(stringifyJson(batch), 'utf8');
    const requestSha256 = createHash('sha256').update(input).digest('hex');
    let result: JsonValue;
    try { result = await this.inspector.native('eventBatch', { root: this.root, inputBase64: input.toString('base64') }, deadline.remaining()); }
    catch (error) { throw new DataRootUnavailableError('Event inspection is unavailable.', { cause: error }); }
    deadline.check();
    if (!hasExactKeys(result, ['requestSha256', 'documents']) || result['requestSha256'] !== requestSha256 || !Array.isArray(result['documents']) || result['documents'].length < 1 || result['documents'].length > batch.length) {
      throw new DataRootUnavailableError('Event inspection response is incomplete or uncorrelated.');
    }
    const values = parseDocuments(result['documents'], batch);
    deadline.check();
    return values;
  }

  async read(requests: readonly EventReadRequest[], timeoutMs = 30000): Promise<readonly EventRead[]> {
    if (requests.length === 0 || requests.length > 8 || requests.some(request => !Number.isSafeInteger(request.sequence) || request.sequence < 0)) {
      throw new DataRootUnavailableError('Invalid event inspection batch.');
    }
    const frozen = requests.map(request => ({ path: path.resolve(this.root, request.path), sequence: request.sequence }));
    const encoded = JSON.stringify(frozen);
    if (Buffer.byteLength(encoded, 'utf8') > 65536) { throw new DataRootUnavailableError('Event inspection control exceeds its budget.'); }
    let result: JsonValue;
    try { result = await this.inspector.native('eventMetadata', { root: this.root, requestsJson: encoded, source: false }, timeoutMs); }
    catch (error) { throw new DataRootUnavailableError('Event inspection is unavailable.', { cause: error }); }
    if (!hasExactKeys(result, ['documents']) || !Array.isArray(result['documents']) || result['documents'].length !== frozen.length) {
      throw new DataRootUnavailableError('Event inspection response is incomplete.');
    }
    return parseDocuments(result['documents'], frozen);
  }
}
