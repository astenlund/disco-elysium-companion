import { createHash } from 'node:crypto';

import { requireControl } from '../control-values.ts';
import { stringifyJson } from '../json.ts';
import type { RetainedHandoff } from '../operation-records.ts';

export type HandoffIdentity = Pick<RetainedHandoff, 'logicalOutboxId' | 'recordSha256'>;

// These canonical identity fields cannot contain the colon separator. Keep this
// exact pair aligned with ResourceInventory.Identity's native union.
export function handoffIdentity(value: HandoffIdentity): string { return value.logicalOutboxId + ':' + value.recordSha256; }

export function handoffIdentityDigest(values: Iterable<HandoffIdentity>): string {
  const ordered = [...new Set([...values].map(handoffIdentity))].sort();
  return createHash('sha256').update(ordered.join(String.fromCharCode(10)), 'utf8').digest('hex');
}

export function additionalHandoffCount(candidates: Iterable<HandoffIdentity>, retained: Iterable<HandoffIdentity>): number {
  const existing = new Set([...retained].map(handoffIdentity));
  const additions = new Set<string>();
  for (const candidate of candidates) {
    const identity = handoffIdentity(candidate);
    if (!existing.has(identity)) { additions.add(identity); }
  }
  return additions.size;
}

export function mergeHandoff(previous: RetainedHandoff, next: RetainedHandoff, generation: string | null = null): RetainedHandoff {
  requireControl(previous.logicalOutboxId === next.logicalOutboxId && previous.recordSha256 === next.recordSha256
    && previous.journalId === next.journalId && previous.eventId === next.eventId && previous.coreRepairOperationId === next.coreRepairOperationId
    && (previous.payloadBindingSha256 === null || next.payloadBindingSha256 === null || previous.payloadBindingSha256 === next.payloadBindingSha256)
    && (previous.attemptRef === null || next.attemptRef === null || stringifyJson(previous.attemptRef) === stringifyJson(next.attemptRef)));
  const presentation = previous.presentation === 'rejected' || next.presentation === 'rejected' ? 'rejected'
    : previous.presentation === 'unverified' || next.presentation === 'unverified' ? 'unverified' : 'replayable';
  return { ...next, payloadBindingSha256: next.payloadBindingSha256 ?? previous.payloadBindingSha256, attemptRef: next.attemptRef ?? previous.attemptRef,
    acceptance: generation !== null && previous.acceptance?.generation === generation ? previous.acceptance : next.acceptance ?? previous.acceptance, presentation };
}
