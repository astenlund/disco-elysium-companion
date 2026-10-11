import { requireControl } from '../control-values.ts';
import type { Deadline } from '../deadline.ts';
import { hasCurrentAcceptance, type EventMetadata } from '../journal-records.ts';
import { coreAttemptToken, type RepairOperation } from '../operation-records.ts';
import type { RecoveryDisclosure } from '../safety-records.ts';
import { hasProviderAuthority } from './provider-authority.ts';
import type { Kernel } from './kernel.ts';

export function matchesRecoveryDisclosure(record: RepairOperation, episodeOrdinal: number, event: EventMetadata, disclosure: RecoveryDisclosure, generation: string): boolean {
  const episode = record.recovery.episodes[episodeOrdinal];
  const checkpoint = episode?.acceptedRecovery;
  if (episode?.phase !== 'completed' || checkpoint === null || checkpoint === undefined || record.recovery.activeEpisode !== null) { return false; }
  const attemptOrdinal = episode.replacementAttempt ?? episode.attemptAtStart;
  const attempt = record.recovery.attempts[attemptOrdinal];
  return checkpoint.journalId === disclosure.journalId && checkpoint.eventId === disclosure.eventId && checkpoint.sequence === disclosure.sequence
    && checkpoint.generation === disclosure.generation && disclosure.generation === generation
    && event.journalId === disclosure.journalId && event.eventId === disclosure.eventId && event.sequence === disclosure.sequence
    && event.type === 'state.resync' && !event.compacted && event.settlement !== 'pending' && hasCurrentAcceptance(event, generation)
    && event.sequence >= Math.max(1, record.plan.lastGoodSequence + 1) && attempt?.publication === 'observed'
    && attempt.selectedRecord?.logicalOutboxId === event.logicalOutboxId && attempt.selectedRecord.recordSha256 === event.recordSha256
    && attempt.journalEvent?.journalId === event.journalId && attempt.journalEvent.eventId === event.eventId && attempt.journalEvent.sequence === event.sequence
    && event.coreRepairOperationId === coreAttemptToken(record.operationId, attemptOrdinal)
    && event.attemptRef?.operationId === record.operationId && event.attemptRef.attemptOrdinal === attemptOrdinal;
}

export async function reconcileAcknowledgedRecovery(kernel: Kernel, restoreMissingStamp?: () => Promise<void>, deadline?: Deadline): Promise<boolean> {
  const safety = await kernel.safety(deadline);
  const witness = safety.recoveryWitness;
  if (witness?.phase !== 'awaitingDisclosure') { return false; }
  kernel.owned();
  const disclosure = witness.disclosure;
  requireControl(disclosure !== null);
  const inventory = await kernel.operations.list(deadline);
  requireControl(inventory.invalid.length === 0);
  if (!hasProviderAuthority(safety, inventory)) { return false; }
  const owner = inventory.records.find(entry => entry.record.operationId === witness.owner.operationId)?.record;
  requireControl(owner !== undefined && !owner.compacted && owner.kind === 'repair');
  const episode = owner.recovery.episodes[witness.owner.episodeOrdinal];
  requireControl(episode?.activationId === witness.owner.activationId && owner.scopeSha256 === witness.scopeSha256);

  let journal = await kernel.journal.read(deadline);
  if (journal.fault !== null || journal.damaged.length > 0 || journal.header.status !== 'valid' || journal.cursor.status !== 'valid'
    || journal.cursor.value.lastAckedSequence < disclosure.sequence) { return false; }
  let event = journal.events.get(disclosure.sequence)?.metadata;
  if (event === undefined || !matchesRecoveryDisclosure(owner, witness.owner.episodeOrdinal, event, disclosure, safety.generation)) { return false; }
  if (event.acknowledgedAt === null && restoreMissingStamp !== undefined) {
    await restoreMissingStamp();
    journal = await kernel.journal.read(deadline);
    requireControl(journal.fault === null && journal.damaged.length === 0 && journal.header.status === 'valid' && journal.cursor.status === 'valid'
      && journal.cursor.value.lastAckedSequence >= disclosure.sequence);
    event = journal.events.get(disclosure.sequence)?.metadata;
  }
  if (event === undefined || event.acknowledgedAt === null || !matchesRecoveryDisclosure(owner, witness.owner.episodeOrdinal, event, disclosure, safety.generation)) { return false; }
  const acknowledgedAt = event.acknowledgedAt;
  for (const entry of inventory.records) {
    if (entry.record.compacted || entry.record.kind !== 'repair' || !entry.record.plan.skippedRanges.some(range => range.discharge === null)) { continue; }
    await kernel.operations.update(entry, current => {
      requireControl(current.kind === 'repair');
      return { ...current, plan: { ...current.plan, skippedRanges: current.plan.skippedRanges.map(range => range.discharge === null
        ? { ...range, discharge: { kind: 'recoveryAcknowledged' as const, operationId: witness.owner.operationId, episodeOrdinal: witness.owner.episodeOrdinal, at: acknowledgedAt } } : range) } };
    }, deadline);
  }
  return kernel.safetyStore.dischargeWitness(witness.owner, 'acknowledged', { verify: async current => {
    if (current.generation !== disclosure.generation || current.recoveryWitness?.phase !== 'awaitingDisclosure'
      || current.recoveryWitness.disclosure?.journalId !== disclosure.journalId || current.recoveryWitness.disclosure.eventId !== disclosure.eventId
      || current.recoveryWitness.disclosure.sequence !== disclosure.sequence) { return false; }
    const checkedJournal = await kernel.journal.read(deadline);
    const checkedEvent = checkedJournal.events.get(disclosure.sequence)?.metadata;
    const checkedOperations = await kernel.operations.list(deadline);
    const checkedOwner = checkedOperations.records.find(entry => entry.record.operationId === witness.owner.operationId)?.record;
    return checkedJournal.fault === null && checkedJournal.damaged.length === 0 && checkedJournal.cursor.status === 'valid'
      && checkedJournal.cursor.value.lastAckedSequence >= disclosure.sequence && checkedEvent !== undefined
      && checkedEvent.acknowledgedAt === acknowledgedAt && checkedOwner !== undefined && !checkedOwner.compacted && checkedOwner.kind === 'repair'
      && matchesRecoveryDisclosure(checkedOwner, witness.owner.episodeOrdinal, checkedEvent, disclosure, current.generation) && checkedOperations.invalid.length === 0
      && checkedOperations.records.every(entry => entry.record.compacted || entry.record.kind !== 'repair'
        || entry.record.plan.skippedRanges.every(range => range.discharge !== null));
  } }, deadline);
}
