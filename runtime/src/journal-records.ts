import { isOpaqueToken } from './identity.ts';
import { asInt64, asInteger, hasExactKeys, isCanonicalUtc, isLowerHex, type ControlInt64, type JsonValue } from './json.ts';

export const journalConsumerId = 'agent-session';
export type StateEventType = 'state.consumed' | 'state.snapshot' | 'state.resync';
export type SettlementState = 'pending' | 'accepted' | 'unknown';

export interface JournalHeader {
  readonly journalVersion: 1;
  readonly journalId: string;
  readonly createdAt: string;
  readonly highWaterSequence: number;
  readonly historyVerified: boolean;
}

export interface JournalCursor {
  readonly cursorVersion: 1;
  readonly journalId: string;
  readonly consumerId: typeof journalConsumerId;
  readonly lastAckedSequence: number;
  readonly lastSentSequence: number;
  readonly lastAcceptedRevision: null;
  readonly updatedAt: string;
}

export interface Acceptance {
  readonly journalId: string;
  readonly eventId: string;
  readonly generation: string;
}

export interface AttemptReference { readonly operationId: string; readonly attemptOrdinal: number }

export interface EventMetadata {
  readonly eventVersion: 1;
  readonly journalId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly type: StateEventType;
  readonly occurredAt: string;
  readonly runtimeInstanceId: string;
  readonly adapter: string;
  readonly adapterBindingEpoch: string;
  readonly principal: string;
  readonly logicalOutboxId: string;
  readonly recordSha256: string;
  readonly coreRepairOperationId: string | null;
  readonly attemptRef: AttemptReference | null;
  readonly schemaVersion: ControlInt64;
  readonly adapterVersion: ControlInt64;
  readonly settlement: SettlementState;
  readonly acceptance: Acceptance | null;
  readonly acknowledgedAt: string | null;
  readonly compacted: boolean;
}

export interface EventDescription extends EventMetadata {
  readonly payloadBindingSha256: string;
  readonly targetIdentitySha256: string | null;
  readonly stateGeneratedAt: string | null;
}

export class JournalDocumentError extends Error { override readonly name = 'JournalDocumentError'; }

function requireValue(condition: unknown): asserts condition {
  if (!condition) { throw new JournalDocumentError('Journal control metadata is invalid.'); }
}

export function logicalOutboxSequence(value: unknown): number | null {
  if (typeof value !== 'string' || value.length < 34 || value[32] !== '-' || !isLowerHex(value.slice(0, 32), 32)) { return null; }
  const suffix = value.slice(33);
  const sequence = Number(suffix);
  return Number.isSafeInteger(sequence) && sequence > 0 && String(sequence) === suffix ? sequence : null;
}

export function eventFileName(sequence: number): string {
  requireValue(Number.isSafeInteger(sequence) && sequence > 0);
  return `${String(sequence).padStart(16, '0')}.json`;
}

export function eventFileSequence(name: string): number | null {
  if (name.length !== 21 || !/^[0-9]{16}\.json$/.test(name)) { return null; }
  const sequence = Number(name.slice(0, 16));
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export function parseJournalHeader(value: JsonValue): JournalHeader {
  requireValue(hasExactKeys(value, ['journalVersion', 'journalId', 'createdAt', 'highWaterSequence', 'historyVerified']));
  const highWater = asInteger(value['highWaterSequence']);
  requireValue(asInteger(value['journalVersion']) === 1 && isOpaqueToken(value['journalId']) && isCanonicalUtc(value['createdAt'])
    && highWater !== undefined && highWater >= 0 && typeof value['historyVerified'] === 'boolean');
  return Object.freeze({ journalVersion: 1, journalId: value['journalId'], createdAt: value['createdAt'], highWaterSequence: highWater, historyVerified: value['historyVerified'] });
}

export function parseJournalCursor(value: JsonValue): JournalCursor {
  requireValue(hasExactKeys(value, ['cursorVersion', 'journalId', 'consumerId', 'lastAckedSequence', 'lastSentSequence', 'lastAcceptedRevision', 'updatedAt']));
  const acked = asInteger(value['lastAckedSequence']);
  const sent = asInteger(value['lastSentSequence']);
  requireValue(asInteger(value['cursorVersion']) === 1 && isOpaqueToken(value['journalId']) && value['consumerId'] === journalConsumerId
    && acked !== undefined && acked >= 0 && sent !== undefined && sent >= 0 && value['lastAcceptedRevision'] === null && isCanonicalUtc(value['updatedAt']));
  // A repair may lower the sent mark independently of a completed turn's cursor advance.
  return Object.freeze({ cursorVersion: 1, journalId: value['journalId'], consumerId: journalConsumerId, lastAckedSequence: acked, lastSentSequence: sent, lastAcceptedRevision: null, updatedAt: value['updatedAt'] });
}

export function parseAcceptance(value: JsonValue | undefined): Acceptance | null {
  if (value === null) { return null; }
  requireValue(hasExactKeys(value, ['journalId', 'eventId', 'generation']) && isOpaqueToken(value['journalId']) && isOpaqueToken(value['eventId']) && isLowerHex(value['generation'], 32));
  return Object.freeze({ journalId: value['journalId'], eventId: value['eventId'], generation: value['generation'] });
}

export function parseAttemptReference(value: JsonValue | undefined): AttemptReference | null {
  if (value === null) { return null; }
  requireValue(hasExactKeys(value, ['operationId', 'attemptOrdinal']));
  const ordinal = asInteger(value['attemptOrdinal']);
  requireValue(typeof value['operationId'] === 'string' && value['operationId'].startsWith('jr-') && isLowerHex(value['operationId'].slice(3), 32) && ordinal !== undefined && ordinal >= 0);
  return Object.freeze({ operationId: value['operationId'], attemptOrdinal: ordinal });
}

const eventMetadataFields = ['eventVersion', 'journalId', 'sequence', 'eventId', 'type', 'occurredAt', 'runtimeInstanceId', 'adapter', 'adapterBindingEpoch', 'principal', 'logicalOutboxId', 'recordSha256', 'coreRepairOperationId', 'attemptRef', 'schemaVersion', 'adapterVersion', 'settlement', 'acceptance', 'acknowledgedAt', 'compacted'] as const;

export function parseEventMetadata(value: JsonValue): EventMetadata {
  requireValue(hasExactKeys(value, eventMetadataFields));
  const sequence = asInteger(value['sequence']);
  const schemaVersion = asInt64(value['schemaVersion']);
  const adapterVersion = asInt64(value['adapterVersion']);
  const acceptance = parseAcceptance(value['acceptance']);
  const attemptRef = parseAttemptReference(value['attemptRef']);
  requireValue(asInteger(value['eventVersion']) === 1 && isOpaqueToken(value['journalId']) && sequence !== undefined && sequence > 0 && isLowerHex(value['eventId'], 32)
    && (value['type'] === 'state.consumed' || value['type'] === 'state.snapshot' || value['type'] === 'state.resync') && isCanonicalUtc(value['occurredAt'])
    && isLowerHex(value['runtimeInstanceId'], 32) && typeof value['adapter'] === 'string' && value['adapter'].length > 0 && isLowerHex(value['adapterBindingEpoch'], 32)
    && isOpaqueToken(value['principal']) && typeof value['logicalOutboxId'] === 'string' && logicalOutboxSequence(value['logicalOutboxId']) !== null
    && isLowerHex(value['recordSha256'], 64) && schemaVersion !== undefined && adapterVersion !== undefined
    && (value['settlement'] === 'pending' || value['settlement'] === 'accepted' || value['settlement'] === 'unknown')
    && (value['acknowledgedAt'] === null || isCanonicalUtc(value['acknowledgedAt'])) && typeof value['compacted'] === 'boolean');
  const repair = value['coreRepairOperationId'];
  requireValue(value['type'] === 'state.resync' ? isOpaqueToken(repair) : repair === null && attemptRef === null);
  requireValue(value['settlement'] !== 'accepted' || acceptance !== null);
  return Object.freeze({
    eventVersion: 1, journalId: value['journalId'], sequence, eventId: value['eventId'], type: value['type'], occurredAt: value['occurredAt'],
    runtimeInstanceId: value['runtimeInstanceId'], adapter: value['adapter'], adapterBindingEpoch: value['adapterBindingEpoch'], principal: value['principal'],
    logicalOutboxId: value['logicalOutboxId'], recordSha256: value['recordSha256'], coreRepairOperationId: repair as string | null, attemptRef,
    schemaVersion, adapterVersion, settlement: value['settlement'], acceptance, acknowledgedAt: value['acknowledgedAt'], compacted: value['compacted'],
  });
}

// This consumes the codec's bounded control projection, never an event payload.
export function parseEventDescription(value: JsonValue): EventDescription {
  requireValue(hasExactKeys(value, [...eventMetadataFields, 'payloadBindingSha256', 'targetIdentitySha256', 'stateGeneratedAt']));
  const metadata = parseEventMetadata(Object.fromEntries(eventMetadataFields.map(field => [field, value[field]!])));
  const target = value['targetIdentitySha256'];
  const generated = value['stateGeneratedAt'];
  requireValue(isLowerHex(value['payloadBindingSha256'], 64) && (metadata.compacted ? target === null && generated === null : isLowerHex(target, 64) && isCanonicalUtc(generated)));
  return Object.freeze({ ...metadata, payloadBindingSha256: value['payloadBindingSha256'], targetIdentitySha256: target as string | null, stateGeneratedAt: generated as string | null });
}

export function eventRewriteMetadata(value: EventDescription): EventMetadata {
  const { payloadBindingSha256: _binding, targetIdentitySha256: _target, stateGeneratedAt: _generated, ...metadata } = value;
  return metadata;
}

// Positive evidence is necessary, not sufficient: safety, retirement, witness,
// integrity and selected-state gates remain the coordinator's separate obligations.
export function hasCurrentAcceptance(event: EventMetadata, generation: string): boolean {
  return isLowerHex(generation, 32) && event.acceptance !== null && event.acceptance.generation === generation;
}

export function sameEventDependency(left: EventDescription, right: EventDescription): boolean {
  return left.journalId === right.journalId && left.sequence === right.sequence && left.eventId === right.eventId && left.logicalOutboxId === right.logicalOutboxId
    && left.recordSha256 === right.recordSha256 && left.payloadBindingSha256 === right.payloadBindingSha256 && left.compacted === right.compacted;
}

export function acknowledgementPrefix(cursor: JournalCursor, sent: readonly EventDescription[], current: ReadonlyMap<number, EventDescription>, generation: string): readonly EventDescription[] {
  const prefix: EventDescription[] = [];
  let previous = -1;
  for (const candidate of sent) {
    requireValue(candidate.sequence > previous);
    previous = candidate.sequence;
    if (candidate.sequence <= cursor.lastAckedSequence) { continue; }
    const observed = current.get(candidate.sequence);
    if (candidate.journalId !== cursor.journalId || candidate.sequence !== cursor.lastAckedSequence + prefix.length + 1 || observed === undefined
      || !sameEventDependency(candidate, observed) || observed.compacted || !hasCurrentAcceptance(candidate, generation) || !hasCurrentAcceptance(observed, generation)) { break; }
    prefix.push(observed);
  }
  return Object.freeze(prefix);
}
