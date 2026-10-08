import { pendingOperationSafety } from '../operation-records.ts';
import type { OperationInventory } from '../operations.ts';
import type { StateSafety } from '../safety-records.ts';

export function hasCarryAuthority(sha256: string | null, inventory: OperationInventory): boolean {
  if (sha256 === null) { return true; }
  const owners = inventory.records.filter(({ record }) => !record.compacted && record.kind === 'repair' && record.recovery.episodes.some((episode, ordinal) => {
    const plan = episode.prerequisite;
    return plan !== null && (plan.carry?.sha256 === sha256 && plan.actions.some(action => action.kind === 'preserveRecovery' && action.target.after === sha256)
      && !plan.actions.some((action, index) => action.kind === 'removeCarry' && index < plan.nextAction)
      || record.recovery.activeEpisode === ordinal && plan.actions.some((action, index) => index >= plan.nextAction && action.kind === 'quarantine'
        && action.source.path === 'journal/recovery-event.json' && action.source.before === sha256));
  }));
  return owners.length === 1;
}

// Provider admission is independent of a successful core result or a readable
// fixed safety file alone. Every protected operation still participates.
export function hasProviderAuthority(state: StateSafety, inventory: OperationInventory): boolean {
  if (inventory.invalid.length > 0 || inventory.records.some(item => pendingOperationSafety(item.record)) || state.pendingCheck !== null) { return false; }
  const correction = state.correction;
  if (correction !== null) {
    if (correction.recoveryOperationId === null) { return false; }
    const record = inventory.records.find(item => item.record.operationId === correction.recoveryOperationId)?.record;
    if (record === undefined || record.compacted || record.kind !== 'repair' || record.plan.correctionId !== correction.correctionId
      || record.recovery.episodes.at(-1)?.phase === 'abandonedByRelease') { return false; }
    const owners = inventory.records.filter(item => !item.record.compacted && item.record.kind === 'repair' && item.record.plan.correctionId === correction.correctionId
      && item.record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease');
    if (owners.length !== 1) { return false; }
  }
  const witness = state.recoveryWitness;
  if (witness !== null) {
    const record = inventory.records.find(item => item.record.operationId === witness.owner.operationId)?.record;
    if (record === undefined || record.compacted || record.kind !== 'repair' || record.scopeSha256 !== witness.scopeSha256) { return false; }
    const episode = record.recovery.episodes[witness.owner.episodeOrdinal];
    if (episode?.activationId !== witness.owner.activationId || witness.phase === 'preparing' || witness.phase === 'transferring') { return false; }
    if (witness.phase === 'active' && record.recovery.activeEpisode !== witness.owner.episodeOrdinal) { return false; }
    if (witness.phase === 'awaitingDisclosure') {
      const checkpoint = episode.acceptedRecovery;
      const disclosure = witness.disclosure;
      if (episode.phase !== 'completed' || checkpoint === null || disclosure === null || record.recovery.activeEpisode !== null
        || checkpoint.journalId !== disclosure.journalId || checkpoint.eventId !== disclosure.eventId || checkpoint.sequence !== disclosure.sequence
        || checkpoint.generation !== disclosure.generation || checkpoint.generation !== state.generation) { return false; }
    }
  } else if (inventory.records.some(item => !item.record.compacted && item.record.kind === 'repair' && item.record.recovery.activeEpisode !== null)) { return false; }
  return true;
}
