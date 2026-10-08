import { isOpaqueToken } from './identity.ts';
import { type EventMetadata, type JournalCursor } from './journal-records.ts';
import { asInteger, hasExactKeys, isCanonicalUtc, isLowerHex, type JsonValue } from './json.ts';
import { isRepairOperationId, SafetyUnavailableError } from './safety-records.ts';

export interface SkipDischarge {
  readonly kind: 'recoveryAcknowledged' | 'abandonRelease';
  readonly operationId: string;
  readonly episodeOrdinal: number | null;
  readonly at: string;
}

export interface SkippedRange {
  readonly journalId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly reason: 'cursorRecovery' | 'abandonRelease';
  readonly discharge: SkipDischarge | null;
}

export type ProvenanceInventory = { readonly status: 'unavailable' } | { readonly status: 'verified'; readonly ranges: readonly SkippedRange[] };

export function parseSkippedRange(value: JsonValue): SkippedRange {
  if (!hasExactKeys(value, ['journalId', 'firstSequence', 'lastSequence', 'reason', 'discharge'])) { throw new SafetyUnavailableError('Skipped-range fields are invalid.'); }
  const first = asInteger(value['firstSequence']);
  const last = asInteger(value['lastSequence']);
  if (!isOpaqueToken(value['journalId']) || first === undefined || first < 1 || last === undefined || last < first || value['reason'] !== 'cursorRecovery' && value['reason'] !== 'abandonRelease') {
    throw new SafetyUnavailableError('Skipped-range identity is invalid.');
  }
  let discharge: SkipDischarge | null = null;
  const raw = value['discharge'];
  if (raw !== null) {
    if (!hasExactKeys(raw, ['kind', 'operationId', 'episodeOrdinal', 'at']) || !isCanonicalUtc(raw['at'])) { throw new SafetyUnavailableError('Skipped-range discharge is invalid.'); }
    const episode = raw['episodeOrdinal'] === null ? null : asInteger(raw['episodeOrdinal']);
    const operation = raw['operationId'];
    if (raw['kind'] === 'recoveryAcknowledged') {
      if (!isRepairOperationId(operation) || episode === null || episode === undefined || episode < 0) { throw new SafetyUnavailableError('Recovery discharge reference is invalid.'); }
    } else if (raw['kind'] === 'abandonRelease') {
      if (typeof operation !== 'string' || !operation.startsWith('rl-') || !isLowerHex(operation.slice(3), 32) || episode !== null) { throw new SafetyUnavailableError('Release discharge reference is invalid.'); }
    } else { throw new SafetyUnavailableError('Discharge kind is unsupported.'); }
    discharge = Object.freeze({ kind: raw['kind'], operationId: operation, episodeOrdinal: episode, at: raw['at'] });
  }
  return Object.freeze({ journalId: value['journalId'], firstSequence: first, lastSequence: last, reason: value['reason'], discharge });
}

export function skippedRangesFor(event: Pick<EventMetadata, 'journalId' | 'sequence'>, inventory: ProvenanceInventory): readonly SkippedRange[] {
  if (inventory.status !== 'verified') { throw new SafetyUnavailableError('Cursor provenance inventory is unavailable.'); }
  return inventory.ranges.filter(range => range.journalId === event.journalId && event.sequence >= range.firstSequence && event.sequence <= range.lastSequence);
}

// Proof resolution happens before the inventory is marked verified. A synthetic
// position never stamps an acknowledgement, even after its missing-history duty ends.
export function inferMissingAcknowledgement(event: EventMetadata, cursor: JournalCursor, inventory: ProvenanceInventory): string | null {
  if (event.acknowledgedAt !== null) { return event.acknowledgedAt; }
  if (event.journalId !== cursor.journalId || event.sequence > cursor.lastAckedSequence) { return null; }
  return skippedRangesFor(event, inventory).length === 0 ? cursor.updatedAt : null;
}

export function rangeResolutionTime(event: Pick<EventMetadata, 'journalId' | 'sequence'>, inventory: ProvenanceInventory): string | null {
  const ranges = skippedRangesFor(event, inventory);
  if (ranges.length === 0 || ranges.some(range => range.discharge === null)) { return null; }
  return ranges.reduce((latest, range) => range.discharge!.at > latest ? range.discharge!.at : latest, ranges[0]!.discharge!.at);
}
