import { controlHash, controlInteger, controlUtc, requireControl } from './control-values.ts';
import { hasCurrentAcceptance, type EventDescription } from './journal-records.ts';
import { coreAttemptToken, type AcceptedRecovery, type RecoveryEpisode, type RecoveryProgress, type RepairOperation, type RetainedHandoff, type SelectedRecord } from './operation-records.ts';
import { type RecoveryOwner } from './safety-records.ts';

export function activeRecoveryOwner(record: RepairOperation): RecoveryOwner | null {
  const index = record.recovery.activeEpisode;
  if (index === null) { return null; }
  const episode = record.recovery.episodes[index]!;
  return { operationId: record.operationId, episodeOrdinal: index, activationId: episode.activationId };
}

export function currentAttemptOrdinal(record: RepairOperation): number { return record.recovery.attempts.length - 1; }

function updateEpisode(record: RepairOperation, update: (episode: RecoveryEpisode) => RecoveryEpisode): RepairOperation {
  const index = record.recovery.activeEpisode;
  requireControl(index !== null);
  const episodes = record.recovery.episodes.map((episode, ordinal) => ordinal === index ? Object.freeze(update(episode)) : episode);
  return { ...record, recovery: { ...record.recovery, episodes: Object.freeze(episodes) } };
}

// The caller arms the returned owner's witness before publishing this candidate.
export function replayCandidate(record: RepairOperation, activationId: string, startedAt: string): RepairOperation {
  controlHash(activationId, 32); controlUtc(startedAt);
  if (record.recovery.activeEpisode !== null) {
    const attempts = record.recovery.attempts.map((attempt, index) => index === currentAttemptOrdinal(record) ? { ...attempt, publication: 'due' as const } : attempt);
    return { ...record, recovery: { ...record.recovery, attempts } };
  }
  requireControl(!record.recovery.episodes.some(episode => episode.activationId === activationId));
  const episode: RecoveryEpisode = { activationId, trigger: 'completedReplay', phase: 'preparing', attemptAtStart: currentAttemptOrdinal(record), replacementAttempt: null,
    prerequisite: null, acceptedRecovery: null, successorEpisode: null, releaseOperationId: null, startedAt, endedAt: null };
  return { ...record, recovery: { attempts: record.recovery.attempts.map((attempt, index) => index === currentAttemptOrdinal(record) ? { ...attempt, publication: 'due' } : attempt),
    episodes: [...record.recovery.episodes, episode], activeEpisode: record.recovery.episodes.length } };
}

export function replacementCandidate(record: RepairOperation, reason: 'missingPayload' | 'placementUnavailable' | 'acceptanceUnavailable'): RepairOperation {
  requireControl(['missingPayload', 'placementUnavailable', 'acceptanceUnavailable'].includes(reason));
  const index = record.recovery.activeEpisode;
  requireControl(index !== null);
  const episode = record.recovery.episodes[index]!;
  requireControl(episode.replacementAttempt === null && currentAttemptOrdinal(record) === episode.attemptAtStart && record.recovery.attempts[episode.attemptAtStart]!.selectedRecord !== null);
  const replacement = record.recovery.attempts.length;
  const candidate = updateEpisode(record, episode => ({ ...episode, phase: 'publishing', replacementAttempt: replacement, acceptedRecovery: null }));
  return { ...candidate, recovery: { ...candidate.recovery, attempts: [...candidate.recovery.attempts, { publication: 'due', selectedRecord: null, journalEvent: null }] } };
}

export function selectRecoveryRecord(record: RepairOperation, selected: SelectedRecord, publication: 'deferred' | 'observed', displaced: RetainedHandoff | null): RepairOperation {
  const ordinal = currentAttemptOrdinal(record);
  const previous = record.recovery.attempts[ordinal]!.selectedRecord;
  let handoffs = record.plan.handoffs;
  if (previous !== null && previous.logicalOutboxId !== selected.logicalOutboxId) {
    requireControl(previous.recordSha256 !== null && displaced !== null && displaced.logicalOutboxId === previous.logicalOutboxId && displaced.recordSha256 === previous.recordSha256);
    if (!handoffs.some(value => value.logicalOutboxId === displaced.logicalOutboxId && value.recordSha256 === displaced.recordSha256)) { handoffs = [...handoffs, displaced]; }
  }
  if (previous?.logicalOutboxId === selected.logicalOutboxId && previous.recordSha256 !== null) { requireControl(previous.recordSha256 === selected.recordSha256); }
  const attempts = record.recovery.attempts.map((attempt, index) => index === ordinal ? { publication, selectedRecord: selected, journalEvent: previous?.logicalOutboxId === selected.logicalOutboxId ? attempt.journalEvent : null } : attempt);
  return { ...record, plan: { ...record.plan, handoffs }, recovery: { ...record.recovery, attempts } };
}

export function bindRecoveryEvent(record: RepairOperation, event: EventDescription): RepairOperation {
  const ordinal = currentAttemptOrdinal(record);
  const selected = record.recovery.attempts[ordinal]!.selectedRecord;
  requireControl(selected !== null && selected.recordSha256 !== null && selected.logicalOutboxId === event.logicalOutboxId && selected.recordSha256 === event.recordSha256
    && event.type === 'state.resync' && event.coreRepairOperationId === coreAttemptToken(record.operationId, ordinal)
    && event.attemptRef?.operationId === record.operationId && event.attemptRef.attemptOrdinal === ordinal);
  const attempts = record.recovery.attempts.map((attempt, index) => index === ordinal ? { ...attempt, journalEvent: { journalId: event.journalId, eventId: event.eventId, sequence: event.sequence } } : attempt);
  return { ...record, recovery: { ...record.recovery, attempts } };
}

export function checkpointRecovery(record: RepairOperation, event: EventDescription, generation: string, minimumSequence: number, acceptedAt: string): RepairOperation {
  controlHash(generation, 32); controlInteger(minimumSequence, 1); controlUtc(acceptedAt);
  const ordinal = currentAttemptOrdinal(record);
  const attempt = record.recovery.attempts[ordinal]!;
  const index = record.recovery.activeEpisode;
  requireControl(index !== null && attempt.publication === 'observed' && attempt.selectedRecord?.logicalOutboxId === event.logicalOutboxId && attempt.selectedRecord.recordSha256 === event.recordSha256
    && attempt.journalEvent?.journalId === event.journalId && attempt.journalEvent.eventId === event.eventId && attempt.journalEvent.sequence === event.sequence
    && event.type === 'state.resync' && !event.compacted && event.sequence >= minimumSequence && hasCurrentAcceptance(event, generation)
    && event.coreRepairOperationId === coreAttemptToken(record.operationId, ordinal) && event.attemptRef?.operationId === record.operationId && event.attemptRef.attemptOrdinal === ordinal);
  const prerequisite = record.recovery.episodes[index]!.prerequisite;
  requireControl(prerequisite === null || prerequisite.nextAction === prerequisite.actions.length);
  const acceptedRecovery: AcceptedRecovery = { journalId: event.journalId, eventId: event.eventId, sequence: event.sequence, generation, acceptedAt };
  return updateEpisode(record, episode => ({ ...episode, phase: 'verifyingHistory', acceptedRecovery }));
}

export function completeRecovery(record: RepairOperation, verifiedJournalId: string, generation: string, endedAt: string): RepairOperation {
  controlUtc(endedAt);
  const index = record.recovery.activeEpisode;
  requireControl(index !== null);
  const episode = record.recovery.episodes[index]!;
  requireControl(episode.phase === 'verifyingHistory' && episode.acceptedRecovery?.journalId === verifiedJournalId && episode.acceptedRecovery.generation === generation);
  const updated = updateEpisode(record, value => ({ ...value, phase: 'completed', endedAt }));
  return { ...updated, completedAt: record.completedAt ?? endedAt, outcome: record.outcome ?? 'completed', recovery: { ...updated.recovery, activeEpisode: null } };
}

export function abandonRecovery(record: RepairOperation, releaseOperationId: string, endedAt: string): RepairOperation {
  requireControl(releaseOperationId.startsWith('rl-')); controlHash(releaseOperationId.slice(3), 32); controlUtc(endedAt);
  const updated = record.recovery.activeEpisode === null ? record : updateEpisode(record, episode => ({ ...episode, phase: 'abandonedByRelease', releaseOperationId, endedAt }));
  return { ...updated, completedAt: record.completedAt ?? endedAt, outcome: record.outcome ?? 'abandonedByRelease', recovery: { ...updated.recovery, activeEpisode: null } };
}

export function transferEpisode(record: RepairOperation, next: Omit<RecoveryEpisode, 'phase' | 'endedAt' | 'successorEpisode' | 'releaseOperationId'>, at: string): RepairOperation {
  controlUtc(at);
  const current = record.recovery.activeEpisode;
  requireControl(current !== null && !record.recovery.episodes.some(episode => episode.activationId === next.activationId));
  const successor = record.recovery.episodes.length;
  const episodes = record.recovery.episodes.map((episode, index) => index === current ? { ...episode, phase: 'transferred' as const, successorEpisode: successor, endedAt: at } : episode);
  const progress: RecoveryProgress = { ...record.recovery, episodes: [...episodes, { ...next, phase: 'preparing', endedAt: null, successorEpisode: null, releaseOperationId: null }], activeEpisode: successor };
  return { ...record, recovery: progress };
}
