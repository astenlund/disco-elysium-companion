import { requireControl } from '../control-values.ts';
import { stringifyJson } from '../json.ts';
import type { RetainedHandoff } from '../operation-records.ts';

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
