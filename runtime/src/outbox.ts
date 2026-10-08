import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import { CodecDocumentError, PayloadCodec } from './codec.ts';
import { controlChoice, controlFields, controlHash, controlInt64, controlInteger, controlNullable, controlToken, controlUtc, requireControl } from './control-values.ts';
import type { Deadline } from './deadline.ts';
import { observeFile } from './file-observation.ts';
import { jsonBudgets, readBoundedFile, StrictJsonError, type ControlInt64, type JsonValue } from './json.ts';

export interface SourceDescription {
  readonly stateEventVersion: 1;
  readonly logicalOutboxId: string;
  readonly incarnationId: string;
  readonly sequence: number;
  readonly kind: 'consumed' | 'snapshot' | 'resync';
  readonly createdAt: string;
  readonly principal: string;
  readonly repairOperationId: string | null;
  readonly adapterVersion: ControlInt64;
  readonly game: string;
  readonly schemaVersion: ControlInt64;
  readonly targetIdentitySha256: string;
  readonly stateGeneratedAt: string;
}
export type OutboxRead = { readonly status: 'valid'; readonly name: string; readonly sha256: string; readonly bytes: Buffer; readonly metadata: SourceDescription }
  | { readonly status: 'absent'; readonly name: string }
  | { readonly status: 'invalid'; readonly name: string; readonly sha256: string };

const recordName = /^event-([0-9]{16})\.json$/;
const directory = path.join('state', 'outbox');

export function parseSourceDescription(value: JsonValue): SourceDescription {
  const item = controlFields(value, ['stateEventVersion', 'logicalOutboxId', 'incarnationId', 'sequence', 'kind', 'createdAt', 'principal', 'repairOperationId', 'adapterVersion', 'game', 'schemaVersion', 'targetIdentitySha256', 'stateGeneratedAt']);
  requireControl(controlInteger(item['stateEventVersion']) === 1);
  const incarnationId = controlHash(item['incarnationId'], 32);
  const sequence = controlInteger(item['sequence'], 1);
  const logicalOutboxId = controlToken(item['logicalOutboxId']);
  const kind = controlChoice(item['kind'], ['consumed', 'snapshot', 'resync']);
  const repairOperationId = controlNullable(item['repairOperationId'], controlToken);
  requireControl(logicalOutboxId === `${incarnationId}-${sequence}` && (kind === 'resync' ? repairOperationId !== null : repairOperationId === null) && typeof item['game'] === 'string' && item['game'].length > 0);
  return Object.freeze({ stateEventVersion: 1, incarnationId, sequence, logicalOutboxId, kind, repairOperationId, createdAt: controlUtc(item['createdAt']),
    principal: controlToken(item['principal']), game: item['game'], adapterVersion: controlInt64(item['adapterVersion']), schemaVersion: controlInt64(item['schemaVersion']),
    targetIdentitySha256: controlHash(item['targetIdentitySha256']), stateGeneratedAt: controlUtc(item['stateGeneratedAt']) });
}

// The only direct core-state read surface is the outbox's record files. Payload
// bytes stay opaque and frozen; codec metadata alone crosses into TypeScript.
export class OutboxReader {
  private readonly root: string;
  private readonly inspector: PathInspector;
  private readonly codec: PayloadCodec;

  constructor(root: string, inspector: PathInspector, codec: PayloadCodec) { this.root = root; this.inspector = inspector; this.codec = codec; }

  async list(deadline?: Deadline): Promise<readonly string[]> {
    const target = await this.inspector.inspect(this.root, path.join(this.root, directory), true, deadline?.remaining());
    if (!target.exists) { return []; }
    if (target.kind !== 'directory') { throw new DataRootUnavailableError('The core outbox is not an ordinary directory.'); }
    const names: string[] = [];
    for await (const entry of await fs.opendir(target.path)) {
      deadline?.check();
      if (recordName.test(entry.name)) { names.push(entry.name); }
    }
    return Object.freeze(names.sort());
  }

  async read(name: string, deadline?: Deadline): Promise<OutboxRead> {
    const match = recordName.exec(name);
    if (match === null) { throw new DataRootUnavailableError('Only an exact outbox record filename may be read.'); }
    const target = await this.inspector.inspect(this.root, path.join(this.root, directory, name), true, deadline?.remaining());
    if (!target.exists) { return { status: 'absent', name }; }
    if (target.kind !== 'file') { throw new DataRootUnavailableError('The outbox record is not an ordinary file.'); }
    let bytes: Buffer;
    try { bytes = await readBoundedFile(target.path, jsonBudgets['state-event'].maxBytes); }
    catch (error) {
      if (!(error instanceof StrictJsonError)) { throw error; }
      return { status: 'invalid', name, sha256: (await observeFile(target.path, deadline)).sha256 };
    }
    deadline?.check();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) { return { status: 'invalid', name, sha256 }; }
    try {
      const inspected = await this.codec.inspectSource(bytes, sequence, deadline);
      requireControl(inspected.sha256 === sha256);
      const metadata = parseSourceDescription(inspected.metadata);
      requireControl(metadata.sequence === sequence);
      deadline?.check();
      return { status: 'valid', name, sha256, bytes, metadata };
    } catch (error) {
      if (error instanceof CodecDocumentError) { return { status: 'invalid', name, sha256 }; }
      throw error;
    }
  }
}
