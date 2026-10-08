import { requireControl } from './control-values.ts';
import type { CoreResult, SettlementBinding } from './core-client.ts';
import { eventRewriteMetadata, type EventDescription, type EventMetadata } from './journal-records.ts';
import { isLowerHex } from './json.ts';

export type SettlementResult = CoreResult<'settled' | 'already-settled'>;
export type SettlementDecision =
  | { readonly kind: 'accept'; readonly metadata: EventMetadata }
  | { readonly kind: 'unknown'; readonly metadata: EventMetadata; readonly currentEvidence: boolean }
  | { readonly kind: 'quarantined' | 'outboxInvalid' | 'conflict' | 'retry' | 'cleanupComplete' };

export function eventSettlementBinding(event: EventDescription): SettlementBinding {
  return Object.freeze({ logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256,
    journalId: event.acceptance?.journalId ?? event.journalId, eventId: event.acceptance?.eventId ?? event.eventId });
}

// The caller publishes each proposed metadata update before using it as authority.
// A retained handoff may supply an older request binding even without acceptance.
export function decideSettlement(event: EventDescription | null, binding: SettlementBinding, result: SettlementResult, generation: string, presentation: 'replayable' | 'unverified' | 'rejected' = 'replayable'): SettlementDecision {
  requireControl(isLowerHex(generation, 32) && (event === null || binding.logicalOutboxId === event.logicalOutboxId && binding.recordSha256 === event.recordSha256));
  if (event !== null && event.acceptance !== null) { requireControl(event.acceptance.journalId === binding.journalId && event.acceptance.eventId === binding.eventId); }
  if (result.success) {
    if (event === null || presentation !== 'replayable') { return { kind: 'cleanupComplete' }; }
    return { kind: 'accept', metadata: { ...eventRewriteMetadata(event), settlement: 'accepted', acceptance: { journalId: binding.journalId, eventId: binding.eventId, generation } } };
  }
  if (result.class === 'settlement' && result.reason === 'settlement-quarantined') { return { kind: 'quarantined' }; }
  if (result.class === 'outbox' && result.reason === 'outbox-record-invalid') { return { kind: 'outboxInvalid' }; }
  if (result.class === 'settlement' && result.reason === 'settlement-hash-mismatch') { return { kind: 'conflict' }; }
  if (result.class === 'settlement' && (result.reason === 'settlement-unknown' || result.reason === 'settlement-conflict')) {
    if (event === null || presentation !== 'replayable') { return { kind: 'cleanupComplete' }; }
    return { kind: 'unknown', metadata: { ...eventRewriteMetadata(event), settlement: 'unknown' }, currentEvidence: event.acceptance?.generation === generation };
  }
  return { kind: 'retry' };
}
