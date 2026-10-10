import { coreAttemptToken, pendingOperationSafety, type RepairOperation } from '../operation-records.ts';
import type { OperationInventory } from '../operations.ts';
import { carryReleaseRemovalIndex, carryReleaseState, type RecoveryPrerequisite } from '../recovery-manifest.ts';
import { sameRecoveryOwner, type RecoveryOwner, type StateSafety } from '../safety-records.ts';

export type CarryReleaseStatus = ReturnType<typeof carryReleaseState> | 'unavailable';
export interface DeferredCarryAuthority {
  readonly state: CarryReleaseStatus;
  readonly owner: { readonly operationId: string; readonly episodeOrdinal: number } | null;
  readonly carrySha256: string | null;
  readonly protectedOperations: ReadonlySet<string>;
}

function sameCarriedSource(left: RecoveryPrerequisite, right: RecoveryPrerequisite): boolean {
  if (left.carry === null || right.carry?.sha256 !== left.carry.sha256) { return false; }
  const first = left.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === left.carry!.sha256);
  const second = right.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === right.carry!.sha256);
  return first?.kind === 'preserveRecovery' && second?.kind === 'preserveRecovery'
    && first.metadata.logicalOutboxId === second.metadata.logicalOutboxId && first.metadata.recordSha256 === second.metadata.recordSha256
    && first.metadata.journalId === second.metadata.journalId && first.metadata.eventId === second.metadata.eventId
    && first.metadata.coreRepairOperationId === second.metadata.coreRepairOperationId && first.source.payloadBindingSha256 === second.source.payloadBindingSha256;
}

function hasDesignatedCarryBinding(record: RepairOperation, ordinal: number, plan: RecoveryPrerequisite): boolean {
  const bound = plan.carryRelease!.attemptRef;
  const preserved = plan.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === plan.carry?.sha256);
  if (bound.operationId !== record.operationId || preserved?.kind !== 'preserveRecovery'
    || preserved.metadata.coreRepairOperationId === coreAttemptToken(bound.operationId, bound.attemptOrdinal)
    || preserved.metadata.attemptRef?.operationId === bound.operationId && preserved.metadata.attemptRef.attemptOrdinal === bound.attemptOrdinal) { return false; }
  const sameBinding = (candidate: RecoveryPrerequisite | null): candidate is RecoveryPrerequisite => candidate !== null && sameCarriedSource(plan, candidate)
    && candidate.carryRelease?.attemptRef.operationId === bound.operationId && candidate.carryRelease.attemptRef.attemptOrdinal === bound.attemptOrdinal;
  const allocation = (index: number, visited = new Set<number>()): boolean => {
    if (visited.has(index)) { return false; }
    visited.add(index);
    const episode = record.recovery.episodes[index];
    if (episode === undefined || !sameBinding(episode.prerequisite)) { return false; }
    if (episode.replacementAttempt !== null) { return episode.replacementAttempt === bound.attemptOrdinal && episode.attemptAtStart < bound.attemptOrdinal; }
    if (episode.attemptAtStart !== bound.attemptOrdinal) { return false; }
    // A cross-root initial attempt gains this role only through the separately
    // verified predecessor/release transfer, never from ordinal zero alone.
    if (index === 0 && bound.attemptOrdinal === 0 && record.plan.inheritedRecovery !== null) { return true; }
    const predecessors = record.recovery.episodes.flatMap((candidate, predecessor) => predecessor < index && candidate.phase === 'transferred'
      && candidate.successorEpisode === index && sameBinding(candidate.prerequisite) ? [predecessor] : []);
    return predecessors.length === 1 && allocation(predecessors[0]!, visited);
  };
  if (!allocation(ordinal)) { return false; }
  const state = carryReleaseState(plan);
  const selected = record.recovery.attempts[bound.attemptOrdinal]!.selectedRecord;
  if (state !== 'resolved' && selected?.logicalOutboxId === preserved.metadata.logicalOutboxId && selected.recordSha256 === preserved.metadata.recordSha256) { return false; }
  if (state === 'waitingReplacement') { return record.recovery.episodes[ordinal]!.acceptedRecovery === null; }
  if (selected === null) { return false; }
  // A replay can replace the attempt's current selected record and destination.
  // Historical cleanup authority follows its immutable accepting episode, while
  // the removal executor separately revalidates current acceptance before unlink.
  return record.recovery.episodes.some((episode, index) => index <= ordinal && episode.acceptedRecovery !== null && sameBinding(episode.prerequisite)
    && carryReleaseRemovalIndex(episode.prerequisite) >= 0 && (episode.replacementAttempt ?? episode.attemptAtStart) === bound.attemptOrdinal && allocation(index));
}

export function deferredCarryAuthority(inventory: OperationInventory): DeferredCarryAuthority {
  const protectedOperations = new Set<string>();
  const unavailable = (): DeferredCarryAuthority => ({ state: 'unavailable', owner: null, carrySha256: null, protectedOperations });
  if (inventory.invalid.length > 0) { return unavailable(); }
  const byId = new Map(inventory.records.map(entry => [entry.record.operationId, entry.record]));
  if (byId.size !== inventory.records.length) { return unavailable(); }
  const entries: { record: RepairOperation; ordinal: number; plan: RecoveryPrerequisite }[] = [];
  for (const { record } of inventory.records) {
    if (record.compacted || record.kind !== 'repair') { continue; }
    for (const [ordinal, episode] of record.recovery.episodes.entries()) {
      const plan = episode.prerequisite;
      if (plan?.carryRelease == null || episode.phase === 'transferred') { continue; }
      const bound = plan.carryRelease.attemptRef;
      const target = byId.get(bound.operationId);
      if (plan.carry === null || target === undefined || target.compacted || target.kind !== 'repair' || target.scopeSha256 !== record.scopeSha256
        || target.recovery.attempts[bound.attemptOrdinal] === undefined || bound.operationId !== record.operationId && record.plan.inheritedRecovery?.operationId !== bound.operationId) { return unavailable(); }
      if (!hasDesignatedCarryBinding(record, ordinal, plan)) { return unavailable(); }
      entries.push({ record, ordinal, plan });
      if (carryReleaseState(plan) !== 'resolved') { protectedOperations.add(record.operationId); protectedOperations.add(bound.operationId); }
    }
  }
  const inherited = new Map<string, string>();
  const key = (operationId: string, ordinal: number): string => operationId + ':' + ordinal;
  for (const entry of entries) {
    const predecessor = entry.record.plan.inheritedRecovery;
    if (predecessor === null) { continue; }
    const localPreserve = entry.plan.actions.find(action => action.kind === 'preserveRecovery');
    if (localPreserve?.kind === 'preserveRecovery' && entry.record.recovery.attempts.some((attempt, ordinal) =>
      localPreserve.metadata.coreRepairOperationId === coreAttemptToken(entry.record.operationId, ordinal)
      && attempt.selectedRecord?.logicalOutboxId === localPreserve.metadata.logicalOutboxId && attempt.selectedRecord.recordSha256 === localPreserve.metadata.recordSha256
      && attempt.journalEvent?.journalId === localPreserve.metadata.journalId && attempt.journalEvent.eventId === localPreserve.metadata.eventId
      && attempt.journalEvent.sequence === localPreserve.metadata.sequence)) { continue; }
    const prior = byId.get(predecessor.operationId);
    if (prior === undefined || prior.compacted || prior.kind !== 'repair' || prior.operationId === entry.record.operationId || prior.scopeSha256 !== entry.record.scopeSha256) { return unavailable(); }
    const episode = prior.recovery.episodes[predecessor.episodeOrdinal];
    if (episode?.activationId !== predecessor.activationId || episode.prerequisite?.carry?.sha256 !== entry.plan.carry!.sha256
      || episode.phase !== 'abandonedByRelease' || episode.releaseOperationId === null) { return unavailable(); }
    if (!sameCarriedSource(episode.prerequisite, entry.plan)) { return unavailable(); }
    const release = byId.get(episode.releaseOperationId);
    if (release === undefined || release.compacted || release.kind !== 'release' || release.scopeSha256 !== prior.scopeSha256 || release.outcome !== 'completed'
      || release.completedAt === null || release.plan.mode !== 'abandon' || release.plan.result?.owner !== 'bridge'
      || !release.plan.unfinishedRepairs.some(owner => owner.operationId === prior.operationId && owner.episodeOrdinal === predecessor.episodeOrdinal && owner.activationId === predecessor.activationId)) { return unavailable(); }
    const parent = key(prior.operationId, predecessor.episodeOrdinal);
    if (inherited.has(parent) && inherited.get(parent) !== entry.record.operationId) { return unavailable(); }
    inherited.set(parent, entry.record.operationId);
    // The successor's confirmed removal is the proof that the retained
    // predecessor no longer owns the slot, even after successor completion.
    for (const id of [prior.operationId, release.operationId, entry.record.operationId, entry.plan.carryRelease!.attemptRef.operationId]) { protectedOperations.add(id); }
  }
  const live = entries.filter(entry => !inherited.has(key(entry.record.operationId, entry.ordinal)) && carryReleaseState(entry.plan) !== 'resolved');
  if (live.length > 1) { return unavailable(); }
  const owner = live[0];
  if (owner === undefined) { return { state: entries.length === 0 ? 'none' : 'resolved', owner: null, carrySha256: null, protectedOperations }; }
  return { state: carryReleaseState(owner.plan), owner: { operationId: owner.record.operationId, episodeOrdinal: owner.ordinal }, carrySha256: owner.plan.carry!.sha256, protectedOperations };
}

export function hasCarryAuthority(sha256: string | null, inventory: OperationInventory): boolean {
  const deferred = deferredCarryAuthority(inventory);
  if (deferred.state === 'unavailable') { return false; }
  if (deferred.owner !== null) {
    if (sha256 !== null && sha256 !== deferred.carrySha256) { return false; }
    const ordinaryOwner = inventory.records.some(({ record }) => !record.compacted && record.kind === 'repair' && record.recovery.episodes.some(episode => {
      const plan = episode.prerequisite;
      return episode.phase !== 'transferred' && plan !== null && plan.carryRelease === null && plan.carry !== null
        && !plan.actions.some((action, index) => action.kind === 'removeCarry' && index < plan.nextAction);
    }));
    if (ordinaryOwner) { return false; }
    // Absence is still an owed preservation/removal obligation, never admission
    // for provider input or ordinary work. Its owner reconciles it separately.
    return true;
  }
  if (sha256 === null) { return true; }
  const owners = inventory.records.filter(({ record }) => !record.compacted && record.kind === 'repair' && record.recovery.episodes.some((episode, ordinal) => {
    const plan = episode.prerequisite;
    return plan !== null && plan.carryRelease === null && (plan.carry?.sha256 === sha256 && plan.actions.some(action => action.kind === 'preserveRecovery' && action.target.after === sha256)
      && !plan.actions.some((action, index) => action.kind === 'removeCarry' && index < plan.nextAction)
      || record.recovery.activeEpisode === ordinal && plan.actions.some((action, index) => index >= plan.nextAction && action.kind === 'quarantine'
        && action.source.path === 'journal/recovery-event.json' && action.source.before === sha256));
  }));
  return owners.length === 1;
}

function correctionAuthority(state: StateSafety, inventory: OperationInventory): 'verified' | 'unbound' | 'unavailable' {
  const correction = state.correction;
  if (correction === null) { return 'verified'; }
  if (correction.recoveryOperationId === null) { return 'unbound'; }
  const owners = inventory.records.filter(({ record }) => !record.compacted && record.kind === 'repair' && record.plan.correctionId === correction.correctionId
    && record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease');
  return owners.length === 1 && owners[0]!.record.operationId === correction.recoveryOperationId ? 'verified' : 'unavailable';
}

// Readable pending authority is distinct from permission to use a provider.
// Reserved preparing/transferring plans may be absent, but an activated owner
// must be present and every competing active root must belong to that transition.
export function hasSafetyRecordAuthority(state: StateSafety, inventory: OperationInventory): boolean {
  if (inventory.invalid.length > 0) { return false; }
  const records = new Map(inventory.records.map(entry => [entry.record.operationId, entry.record]));
  if (records.size !== inventory.records.length) { return false; }
  if (correctionAuthority(state, inventory) === 'unavailable') { return false; }
  const active = inventory.records.flatMap(({ record }) => !record.compacted && record.kind === 'repair' && record.recovery.activeEpisode !== null
    ? [{ operationId: record.operationId, episodeOrdinal: record.recovery.activeEpisode, activationId: record.recovery.episodes[record.recovery.activeEpisode]!.activationId }] : []);
  const witness = state.recoveryWitness;
  if (witness === null) { return active.length === 0; }
  const matches = (owner: RecoveryOwner, reserved: boolean): boolean => {
    const record = records.get(owner.operationId);
    if (record === undefined) { return reserved; }
    if (record.compacted || record.kind !== 'repair' || record.scopeSha256 !== witness.scopeSha256) { return false; }
    const episode = record.recovery.episodes[owner.episodeOrdinal];
    return episode === undefined ? reserved && owner.episodeOrdinal === record.recovery.episodes.length && record.recovery.activeEpisode === null : episode.activationId === owner.activationId;
  };
  if (witness.phase === 'preparing') { return matches(witness.owner, true) && active.every(owner => sameRecoveryOwner(owner, witness.owner)); }
  if (witness.phase === 'transferring') {
    const successor = witness.successor;
    if (successor === null || !matches(witness.owner, true) || !matches(successor, true)
      || !active.every(owner => sameRecoveryOwner(owner, witness.owner) || sameRecoveryOwner(owner, successor))) { return false; }
    const record = records.get(successor.operationId);
    if (record === undefined) { return true; }
    if (record.compacted || record.kind !== 'repair') { return false; }
    return record.recovery.episodes[successor.episodeOrdinal] === undefined || successor.operationId === witness.owner.operationId
      || record.plan.inheritedRecovery !== null && sameRecoveryOwner(record.plan.inheritedRecovery, witness.owner);
  }
  if (!matches(witness.owner, false) || !active.every(owner => sameRecoveryOwner(owner, witness.owner))) { return false; }
  if (witness.phase === 'active') { return true; }
  const record = records.get(witness.owner.operationId)! as RepairOperation;
  const episode = record.recovery.episodes[witness.owner.episodeOrdinal]!;
  const checkpoint = episode.acceptedRecovery;
  const disclosure = witness.disclosure;
  return active.length === 0 && episode.phase === 'completed' && checkpoint !== null && disclosure !== null
    && checkpoint.journalId === disclosure.journalId && checkpoint.eventId === disclosure.eventId && checkpoint.sequence === disclosure.sequence && checkpoint.generation === disclosure.generation;
}

// Provider admission is independent of a successful core result or a readable
// fixed safety file alone. Every protected operation still participates.
export function hasProviderAuthority(state: StateSafety, inventory: OperationInventory): boolean {
  if (!hasSafetyRecordAuthority(state, inventory) || inventory.records.some(item => pendingOperationSafety(item.record)) || state.pendingCheck !== null) { return false; }
  const deferred = deferredCarryAuthority(inventory);
  if (deferred.state === 'unavailable' || deferred.owner !== null) { return false; }
  if (correctionAuthority(state, inventory) !== 'verified') { return false; }
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
