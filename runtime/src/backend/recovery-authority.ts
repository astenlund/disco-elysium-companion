import type { RepairOperation } from '../operation-records.ts';
import { activeRecoveryOwner } from '../recovery-progress.ts';
import { sameRecoveryOwner, type RecoveryWitness } from '../safety-records.ts';

export function reservedWitnessMatches(witness: RecoveryWitness, record: RepairOperation): boolean {
  if (witness.phase !== 'preparing' && witness.phase !== 'transferring' || witness.scopeSha256 !== record.scopeSha256) { return false; }
  const reserved = witness.phase === 'transferring' ? witness.successor : witness.owner;
  const active = activeRecoveryOwner(record);
  if (reserved === null || active === null || !sameRecoveryOwner(reserved, active)) { return false; }
  if (witness.phase === 'preparing') { return true; }
  if (witness.owner.operationId !== reserved.operationId) {
    return record.plan.inheritedRecovery !== null && sameRecoveryOwner(record.plan.inheritedRecovery, witness.owner);
  }
  const previous = record.recovery.episodes[witness.owner.episodeOrdinal];
  if (previous?.activationId !== witness.owner.activationId || reserved.episodeOrdinal <= witness.owner.episodeOrdinal) { return false; }
  if (previous.phase === 'transferred') { return previous.successorEpisode === reserved.episodeOrdinal; }
  return (previous.phase === 'completed' || previous.phase === 'recordRejected') && record.recovery.episodes[reserved.episodeOrdinal]!.trigger === 'completedReplay';
}
