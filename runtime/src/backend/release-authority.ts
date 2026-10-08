import { requireControl } from '../control-values.ts';
import type { JournalSnapshot } from '../journal.ts';
import { eventFileSequence, type JournalCursor, type JournalHeader } from '../journal-records.ts';
import type { ReleaseOperation } from '../operation-records.ts';
import { sameRecoveryOwner, type RecoveryOwner, type RecoveryWitness } from '../safety-records.ts';

export function releaseJournalEvidence(snapshot: Pick<JournalSnapshot, 'header' | 'cursor'> | null, fileNames: readonly string[]): {
  readonly header: JournalHeader | null; readonly cursor: JournalCursor | null; readonly abandonedSequences: number[];
} {
  const header = snapshot?.header.status === 'valid' ? snapshot.header.value : null;
  const candidate = snapshot?.cursor.status === 'valid' ? snapshot.cursor.value : null;
  const cursor = header !== null && candidate !== null && candidate.journalId === header.journalId
    && candidate.lastAckedSequence <= header.highWaterSequence && candidate.lastSentSequence <= header.highWaterSequence ? candidate : null;
  const abandonedSequences = fileNames.flatMap(name => {
    const sequence = eventFileSequence(name);
    requireControl(sequence !== null);
    return cursor === null || sequence > cursor.lastAckedSequence ? [sequence] : [];
  });
  return { header, cursor, abandonedSequences: [...new Set(abandonedSequences)].sort((left, right) => left - right) };
}

export function releaseNamesOwner(release: ReleaseOperation, owner: RecoveryOwner): boolean {
  return release.plan.unfinishedRepairs.some(item => item.operationId === owner.operationId && item.episodeOrdinal === owner.episodeOrdinal && item.activationId === owner.activationId);
}

export function releaseNamesWitness(release: ReleaseOperation, witness: RecoveryWitness): boolean {
  if (release.scopeSha256 !== witness.scopeSha256 || release.completedAt === null || release.outcome !== 'completed' || release.plan.mode !== 'abandon'
    || release.plan.result?.owner !== 'bridge' || !(['coreSwitched', 'cursorAdvanced', 'repairsAbandoned', 'dischargesPublished', 'complete'] as const).every(phase => release.plan.completedPhases.includes(phase))
    || release.plan.skippedRanges.some(range => range.discharge?.kind !== 'abandonRelease' || range.discharge.operationId !== release.operationId || range.discharge.episodeOrdinal !== null)) { return false; }
  const recorded = release.plan.witness;
  if (recorded === null) {
    return release.plan.witnessUnavailable && releaseNamesOwner(release, witness.owner) && (witness.successor === null || releaseNamesOwner(release, witness.successor));
  }
  return recorded.scopeSha256 === witness.scopeSha256 && recorded.phase === witness.phase && sameRecoveryOwner(recorded.owner, witness.owner)
    && (recorded.successor === null ? witness.successor === null : witness.successor !== null && sameRecoveryOwner(recorded.successor, witness.successor))
    && (recorded.disclosure === null ? witness.disclosure === null : witness.disclosure !== null
      && recorded.disclosure.journalId === witness.disclosure.journalId && recorded.disclosure.eventId === witness.disclosure.eventId
      && recorded.disclosure.sequence === witness.disclosure.sequence && recorded.disclosure.generation === witness.disclosure.generation);
}
