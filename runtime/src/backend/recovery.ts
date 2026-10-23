import path from 'node:path';

import { requireControl } from '../control-values.ts';
import type { PublishReceipt } from '../core-client.ts';
import { RuntimeCapacityError } from '../capacity.ts';
import type { CapacityRewindResult } from './api.ts';
import type { CapacitySource } from '../resource-lifecycle/resources.ts';
import { Deadline } from '../deadline.ts';
import { EventReader, type EventRead, type EventReadRequest } from '../event-reader.ts';
import { observeFile } from '../file-observation.ts';
import { newIdentity, newOperationId } from '../identity.ts';
import { eventFileName, eventRewriteMetadata, hasCurrentAcceptance, logicalOutboxSequence, type EventDescription, type JournalCursor, type JournalHeader } from '../journal-records.ts';
import type { JournalEvent, JournalSnapshot } from '../journal.ts';
import { jsonBudgets, readBoundedFile, stringifyJson, stringifyProspectiveJson, utcNow } from '../json.ts';
import { effectivelyUnfinished, coreAttemptToken, type RepairOperation, type RetainedHandoff, type RecoveryEpisode } from '../operation-records.ts';
import { outboxRecordSequence } from '../outbox-name.ts';
import type { OutboxRead } from '../outbox.ts';
import { requireRepair, type OperationInventory, type StoredOperation } from '../operations.ts';
import { RecoveryExecutor, RecoveryDamageError } from '../recovery-executor.ts';
import { carryReleaseRemovalIndex, carryReleaseResolved, recognizeAction, validatePrerequisite, type ManifestObservation, type PayloadSource, type RecoveryAction, type RecoveryPrerequisite } from '../recovery-manifest.ts';
import { activeRecoveryOwner, bindRecoveryEvent, checkpointRecovery, completeRecovery, currentAttemptOrdinal, replacementCandidate, replayCandidate, selectRecoveryRecord, transferEpisode } from '../recovery-progress.ts';
import type { SkippedRange } from '../recovery-provenance.ts';
import { sameRecoveryOwner, SafetyUnavailableError, type RecoveryOwner, type StateSafety } from '../safety-records.ts';
import { bytesHash } from '../storage.ts';
import { Kernel, type RepairRequest } from './kernel.ts';
import { additionalHandoffCount, mergeHandoff } from './handoffs.ts';
import { reservedWitnessMatches } from './recovery-authority.ts';
import { deferredCarryAuthority, hasCarryAuthority } from './provider-authority.ts';

const headerPath = 'journal/journal.json';
const cursorPath = 'journal/cursor-agent-session.json';
const hashValue = (value: unknown): string => bytesHash(Buffer.from(stringifyJson(value)));

function recoveryHighWaterCeiling(prerequisite: RecoveryPrerequisite | null, snapshot: JournalSnapshot): number {
  // A later carry append can raise high water without restoring the earlier good prefix.
  const highWaters = [
    ...(snapshot.header.status === 'valid' ? [snapshot.header.value.highWaterSequence] : []),
    ...(prerequisite?.actions.flatMap(action => action.kind === 'publishHeader' || action.kind === 'raiseHighWater' ? [action.value.highWaterSequence] : []) ?? []),
  ];
  requireControl(highWaters.length > 0);
  return Math.min(...highWaters);
}

function recoveryPlanPosition(prerequisite: RecoveryPrerequisite | null, snapshot: JournalSnapshot, previousFloor: number): { lastGoodSequence: number; cursorTo: number | null } {
  if (prerequisite?.kind === 'header') { return { lastGoodSequence: 0, cursorTo: null }; }
  if (prerequisite?.kind === 'cursor') {
    requireControl(snapshot.header.status === 'valid');
    const cursorTo = snapshot.header.value.highWaterSequence;
    return { lastGoodSequence: cursorTo, cursorTo };
  }
  return { lastGoodSequence: Math.min(previousFloor, recoveryHighWaterCeiling(prerequisite, snapshot)), cursorTo: null };
}

function hasUnreplacedSelection(record: RepairOperation): boolean {
  const active = record.recovery.activeEpisode;
  if (active === null) { return false; }
  const episode = record.recovery.episodes[active]!;
  const ordinal = currentAttemptOrdinal(record);
  const attempt = record.recovery.attempts[ordinal]!;
  return episode.replacementAttempt === null && episode.attemptAtStart === ordinal && attempt.publication !== 'observed'
    && attempt.selectedRecord?.recordSha256 != null && attempt.journalEvent !== null;
}

interface PrerequisiteTransfer {
  readonly prerequisite: RecoveryPrerequisite;
  readonly replacement: { readonly logicalOutboxId: string; readonly recordSha256: string; readonly deferred?: boolean; readonly handoff?: RetainedHandoff;
    readonly reason?: 'missingPayload' | 'placementUnavailable' } | null;
}

interface OrdinaryCarryDecision {
  readonly kind: 'intact' | 'restore' | 'lost';
  readonly source?: PayloadSource;
  readonly slotInvalidSha256?: string;
  readonly recordedSlotCleanup?: boolean;
  readonly originalSource?: EventRead;
  readonly appendIndex: number;
}

function quarantineCarry(sha256: string): RecoveryAction {
  return { kind: 'quarantine', source: { path: 'journal/recovery-event.json', before: sha256, after: null },
    target: { path: `quarantine/recovery-event.json.${newIdentity()}.quarantined`, before: null, after: sha256 } };
}

export function handoffFor(event: EventDescription, presentation: RetainedHandoff['presentation'] = 'replayable'): RetainedHandoff {
  return { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256, payloadBindingSha256: event.payloadBindingSha256,
    journalId: event.acceptance?.journalId ?? event.journalId, eventId: event.acceptance?.eventId ?? event.eventId, acceptance: event.acceptance,
    presentation, coreRepairOperationId: event.coreRepairOperationId, attemptRef: event.attemptRef };
}

export class RecoveryCoordinator {
  readonly kernel: Kernel;
  private running = false;
  private damageEpisodeCreated = false;
  private selectedCapacityRoot: string | null = null;
  private capacitySource: CapacitySource | null = null;
  constructor(kernel: Kernel) {
    this.kernel = kernel;
    kernel.planRecovery = (request, deadline) => this.plan(request, deadline);
    kernel.authorizeDeferredCore = (record, deadline) => this.authorizeDeferredCore(record, deadline);
  }

  private async stored(id: string, deadline?: Deadline): Promise<StoredOperation & { record: RepairOperation }> {
    const result = await this.kernel.operations.read(id, deadline);
    requireControl(result.status === 'valid');
    return { record: requireRepair(result.value), sha256: result.sha256 };
  }

  private ownerProof(owner: RecoveryOwner) {
    return { verify: async (_current: StateSafety, deadline?: Deadline) => {
      const current = await this.stored(owner.operationId, deadline);
      const episode = current.record.recovery.episodes[owner.episodeOrdinal];
      return this.kernel.guard.held && current.record.scopeSha256 === this.kernel.scope.bindingSha256 && episode?.activationId === owner.activationId;
    } };
  }

  private async replayForJournal(record: RepairOperation, snapshot: JournalSnapshot, prerequisite: RecoveryPrerequisite | null): Promise<RepairOperation> {
    const replay = replayCandidate(record, await this.kernel.activationIdentity(), utcNow());
    return record.recovery.activeEpisode === null ? { ...replay, plan: { ...replay.plan, ...recoveryPlanPosition(prerequisite, snapshot, replay.plan.lastGoodSequence) } } : replay;
  }

  private async prepareReplayPublication(operationId: string): Promise<RepairOperation> {
    const k = this.kernel;
    let stored = await this.stored(operationId);
    let record = stored.record;
    const active = record.recovery.activeEpisode;
    requireControl(active !== null);
    if (!hasUnreplacedSelection(record)) { return record; }
    const ordinal = currentAttemptOrdinal(record);
    const selected = record.recovery.attempts[ordinal]!.selectedRecord!;
    const snapshot = await k.journal.read();
    if (snapshot.fault !== null || snapshot.damaged.length > 0 || snapshot.header.status !== 'valid' || snapshot.cursor.status !== 'valid') {
      throw new SafetyUnavailableError('Selected recovery source inspection requires a healthy journal.');
    }
    const matches = [...snapshot.events.values()].filter(event => event.metadata.logicalOutboxId === selected.logicalOutboxId);
    requireControl(matches.length <= 1 && matches.every(event => event.metadata.recordSha256 === selected.recordSha256 && event.metadata.type === 'state.resync'
      && event.metadata.coreRepairOperationId === coreAttemptToken(operationId, ordinal)
      && event.metadata.attemptRef?.operationId === operationId && event.metadata.attemptRef.attemptOrdinal === ordinal));
    const priorEvent = matches[0];
    requireControl(priorEvent === undefined || priorEvent.metadata.sequence <= snapshot.header.value.highWaterSequence);
    if (priorEvent !== undefined) {
      const handoff = handoffFor(priorEvent.metadata);
      const existing = record.plan.handoffs.findIndex(value => value.logicalOutboxId === handoff.logicalOutboxId);
      const bound = record.plan.handoffs[existing];
      requireControl(bound === undefined || bound.recordSha256 === handoff.recordSha256 && bound.journalId === handoff.journalId
        && bound.eventId === handoff.eventId && (bound.payloadBindingSha256 === null || bound.payloadBindingSha256 === handoff.payloadBindingSha256));
      const retained = existing < 0 ? [...record.plan.handoffs, handoff]
        : record.plan.handoffs.map((value, index) => index === existing ? mergeHandoff(value, handoff) : value);
      if (stringifyJson(retained, 'state-event') !== stringifyJson(record.plan.handoffs, 'state-event')) {
        await k.resources.reserve('repair', { retainedHandoffs: existing < 0 ? 1 : 0 });
        await k.operations.update(stored, value => {
          const repair = requireRepair(value);
          return { ...repair, plan: { ...repair.plan, handoffs: retained } };
        });
        stored = await this.stored(operationId);
        record = stored.record;
      }
    }
    const sequence = logicalOutboxSequence(selected.logicalOutboxId);
    requireControl(sequence !== null);
    const outboxName = `event-${String(sequence).padStart(16, '0')}.json`;
    const source = await k.outbox.read(outboxName);
    if (source.status === 'valid') {
      requireControl(source.metadata.logicalOutboxId === selected.logicalOutboxId && source.sha256 === selected.recordSha256
        && source.metadata.repairOperationId === coreAttemptToken(operationId, ordinal));
    }
    const carried = await k.carryHash();
    const plan = record.recovery.episodes[active]!.prerequisite;
    requireControl(carried === null || plan?.carry?.sha256 === carried);
    const preserved = carried !== null && plan?.actions.some(action => action.kind === 'preserveRecovery' && action.target.after === carried
      && action.metadata.logicalOutboxId === selected.logicalOutboxId && action.metadata.recordSha256 === selected.recordSha256) === true;
    const placedEvent = priorEvent !== undefined && !priorEvent.metadata.compacted && priorEvent.metadata.sequence > record.plan.lastGoodSequence;
    if (placedEvent || preserved) { return record; }
    if (source.status === 'valid') {
      const binding = record.plan.handoffs.find(value => value.logicalOutboxId === selected.logicalOutboxId && value.recordSha256 === selected.recordSha256);
      if (binding?.presentation !== 'replayable' || binding.payloadBindingSha256 === null) {
        throw new SafetyUnavailableError('Selected recovery has bytes without a proven original settlement binding.');
      }
      return record;
    }
    await k.resources.reserve('repair', { uncompactedEvents: 1 });
    await k.operations.update(stored, value => replacementCandidate(requireRepair(value), priorEvent === undefined ? 'missingPayload' : 'placementUnavailable'));
    return (await this.stored(operationId)).record;
  }

  private readableEvents(snapshot: JournalSnapshot): readonly JournalEvent[] {
    const events = [...snapshot.events.values()];
    for (const entry of snapshot.damaged) {
      if (entry.status === 'valid' && entry.metadata.adapter === this.kernel.scope.game && entry.metadata.principal === this.kernel.scope.principal
        && !events.some(event => event.sha256 === entry.sha256)) { events.push({ metadata: entry.metadata, sha256: entry.sha256 }); }
    }
    return events;
  }

  private handoffGrowth(candidates: Iterable<Pick<RetainedHandoff, 'logicalOutboxId' | 'recordSha256'>>, inventory: OperationInventory): number {
    const retained = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair' ? entry.record.plan.handoffs : []);
    return additionalHandoffCount(candidates, retained);
  }

  plan(request: RepairRequest, deadline?: Deadline): Promise<StoredOperation> {
    return this.kernel.resources.withTransition('repair', async () => { await this.kernel.resources.reserve('repair', {}, deadline); return this.planOwned(request, deadline); });
  }

  private async planOwned(request: RepairRequest, deadline?: Deadline): Promise<StoredOperation> {
    const k = this.kernel;
    const inventory = await k.operations.list(deadline);
    const deferred = deferredCarryAuthority(inventory);
    const priorCarry = deferred.owner === null ? null : inventory.records.find(entry => entry.record.operationId === deferred.owner!.operationId)?.record;
    const priorEpisode = priorCarry !== null && priorCarry !== undefined && !priorCarry.compacted && priorCarry.kind === 'repair'
      ? priorCarry.recovery.episodes[deferred.owner!.episodeOrdinal] : undefined;
    let inheritedCarry: { record: RepairOperation; owner: RecoveryOwner; prerequisite: RecoveryPrerequisite } | null = null;
    if (priorCarry !== null && priorCarry !== undefined && !priorCarry.compacted && priorCarry.kind === 'repair' && priorEpisode?.phase === 'abandonedByRelease'
      && priorEpisode.prerequisite?.carryRelease != null && !carryReleaseResolved(priorEpisode.prerequisite)) {
      const release = inventory.records.find(entry => entry.record.operationId === priorEpisode.releaseOperationId)?.record;
      const owner = { operationId: priorCarry.operationId, episodeOrdinal: deferred.owner!.episodeOrdinal, activationId: priorEpisode.activationId };
      requireControl(release !== undefined && !release.compacted && release.kind === 'release' && release.scopeSha256 === priorCarry.scopeSha256
        && release.completedAt !== null && release.outcome === 'completed' && release.plan.mode === 'abandon' && release.plan.result?.owner === 'bridge'
        && release.plan.completedPhases.includes('complete') && release.plan.unfinishedRepairs.some(value => value.operationId === owner.operationId
          && value.episodeOrdinal === owner.episodeOrdinal && value.activationId === owner.activationId));
      inheritedCarry = { record: priorCarry, owner, prerequisite: priorEpisode.prerequisite };
    }
    const inheritedRanges = inventory.records.flatMap(entry => entry.record.compacted || entry.record.kind === 'handover' ? [] : entry.record.plan.skippedRanges.filter(range => range.discharge === null));
    const unfinished = inventory.records.filter(item => !item.record.compacted && item.record.kind === 'repair' && effectivelyUnfinished(item.record));
    requireControl(unfinished.length <= 1);
    if (unfinished.length === 1) {
      let existing = unfinished[0]!;
      if (request.unboundCarrySha256 !== undefined) {
        existing = await k.operations.update(existing, value => {
          const repair = requireRepair(value);
          const ordinal = repair.recovery.activeEpisode;
          requireControl(ordinal !== null);
          const prerequisite = repair.recovery.episodes[ordinal]!.prerequisite;
          requireControl(prerequisite?.carry == null && !(prerequisite?.actions ?? []).some(action => action.kind === 'quarantine'
            ? action.source.path === 'journal/recovery-event.json' : action.target.path === 'journal/recovery-event.json'));
          const updated: RecoveryPrerequisite = { kind: 'rewind', nextAction: 0, carry: null, carryRelease: null, skippedRanges: [], ...prerequisite,
            actions: [...(prerequisite?.actions ?? []), quarantineCarry(request.unboundCarrySha256!)] };
          return { ...repair, recovery: { ...repair.recovery, episodes: repair.recovery.episodes.map((episode, index) => index === ordinal ? { ...episode, prerequisite: updated } : episode) } };
        }, deadline);
      }
      const currentSafety = await k.safetyStore.read(deadline);
      if (currentSafety.status !== 'valid') {
        const repair = requireRepair(existing.record);
        const owner = activeRecoveryOwner(repair);
        requireControl(owner !== null);
        const correction = { correctionId: repair.plan.correctionId ?? newIdentity(), reason: repair.plan.handoffs.some(item => item.presentation === 'rejected') ? 'coreRejected' as const : 'contextUncertain' as const,
          recoveryOperationId: repair.operationId };
        await k.safetyStore.recoverUnknown(owner, correction, this.ownerProof(owner), deadline);
        await k.safetyStore.activateWitness(owner, this.ownerProof(owner), deadline);
        await this.bindCorrection(repair.operationId, deadline);
      }
      if (request.rejectedEvent !== undefined) { return this.retireAndRewind(existing, request.rejectedEvent, request.cause === 'coreRejected' ? 'rejected' : 'unverified', request.journal, deadline); }
      return existing;
    }
    const readableEvents = this.readableEvents(request.journal);
    await k.resources.reserve('repair', { fullTerminalOperations: 1, uncompactedEvents: 2, retainedHandoffs: this.handoffGrowth(readableEvents.map(event => event.metadata), inventory) }, deadline);
    let safetyRead = await k.safetyStore.read(deadline);
    const reservedWitness = safetyRead.status === 'valid' ? safetyRead.value.recoveryWitness : null;
    const correctionRoot = safetyRead.status === 'valid' ? safetyRead.value.correction?.recoveryOperationId : null;
    const witnessedOwner = (correctionRoot === null || correctionRoot === undefined) && (reservedWitness?.phase === 'active' || reservedWitness?.phase === 'awaitingDisclosure')
      ? reservedWitness.owner : null;
    const historicalRoot = correctionRoot ?? witnessedOwner?.operationId;
    let historicalOwner = historicalRoot === null || historicalRoot === undefined ? undefined : inventory.records.find(entry => entry.record.operationId === historicalRoot);
    if (witnessedOwner !== null && historicalOwner !== undefined) {
      requireControl(!historicalOwner.record.compacted && historicalOwner.record.kind === 'repair'
        && historicalOwner.record.scopeSha256 === reservedWitness!.scopeSha256 && historicalOwner.record.recovery.activeEpisode === null
        && witnessedOwner.episodeOrdinal === historicalOwner.record.recovery.episodes.length - 1
        && historicalOwner.record.recovery.episodes[witnessedOwner.episodeOrdinal]?.activationId === witnessedOwner.activationId
        && historicalOwner.record.recovery.episodes[witnessedOwner.episodeOrdinal]?.phase === 'completed'
        && (historicalOwner.record.plan.correctionId === null || historicalOwner.record.plan.correctionId === (safetyRead.status === 'valid' ? safetyRead.value.correction?.correctionId : null)));
    }
    if (historicalOwner !== undefined && !historicalOwner.record.compacted && historicalOwner.record.kind === 'repair'
      && historicalOwner.record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease') {
      if (request.cause === 'contextUncertain' || request.cause === 'operationLost' || request.journal.damaged.length > 0 || witnessedOwner !== null) {
        await k.safetyStore.invalidate('contextUncertain', deadline);
      }
      const currentSafety = await k.safety(deadline);
      if (currentSafety.correction !== null) {
        requireControl(historicalOwner.record.plan.correctionId === null || historicalOwner.record.plan.correctionId === currentSafety.correction.correctionId);
        if (currentSafety.correction.recoveryOperationId === null || historicalOwner.record.plan.correctionId === null) {
          await this.bindCorrection(historicalOwner.record.operationId, deadline);
          historicalOwner = await this.stored(historicalOwner.record.operationId, deadline);
        }
      }
      const prerequisite = await this.prerequisite(request, deadline);
      const candidate = await this.replayForJournal(requireRepair(historicalOwner.record), request.journal, prerequisite);
      const owner = activeRecoveryOwner(candidate)!;
      const trigger = 'completedReplay';
      const retained = [...candidate.plan.handoffs];
      for (const event of readableEvents) {
        const existing = retained.findIndex(item => item.logicalOutboxId === event.metadata.logicalOutboxId);
        if (existing < 0) { retained.push(handoffFor(event.metadata)); }
        else { retained[existing] = mergeHandoff(retained[existing]!, handoffFor(event.metadata)); }
      }
      if (reservedWitness === null) { await k.safetyStore.prepareWitness(owner, deadline); }
      else { await k.safetyStore.prepareTransfer(owner, deadline); }
      let updated = await k.operations.update(historicalOwner, () => ({ ...candidate, plan: { ...candidate.plan, handoffs: retained,
        skippedRanges: mergeRanges(candidate.plan.skippedRanges, inheritedRanges, prerequisite?.skippedRanges ?? []) }, recovery: { ...candidate.recovery,
        episodes: candidate.recovery.episodes.map((episode, index) => index === owner.episodeOrdinal ? { ...episode, trigger, prerequisite } : episode) } }), deadline);
      await k.safetyStore.activateWitness(owner, this.ownerProof(owner), deadline);
      if (request.rejectedEvent !== undefined) { updated = await this.retireAndRewind(updated, request.rejectedEvent, request.cause === 'coreRejected' ? 'rejected' : 'unverified', request.journal, deadline); }
      return updated;
    }
    const preparingOwner = reservedWitness?.phase === 'preparing' ? reservedWitness.owner : reservedWitness?.phase === 'transferring' ? reservedWitness.successor : null;
    const operationId = preparingOwner?.operationId ?? newOperationId('repair');
    const activationId = preparingOwner?.activationId ?? await k.activationIdentity(deadline);
    const owner: RecoveryOwner = { operationId, episodeOrdinal: 0, activationId };
    const now = utcNow();
    let correction = safetyRead.status === 'valid' ? safetyRead.value.correction : null;
    if (safetyRead.status !== 'valid') {
      const pendingConsumer = inventory.records.find(entry => !entry.record.compacted && entry.record.kind !== 'repair' && entry.record.safety.phase === 'pending')?.record;
      if (pendingConsumer !== undefined && !pendingConsumer.compacted && pendingConsumer.kind !== 'repair') {
        correction = { correctionId: pendingConsumer.safety.obligationId, reason: 'contextUncertain', recoveryOperationId: null };
      }
    }
    const invalidates = ['contextUncertain', 'operationLost', 'coreRejected'].includes(request.cause) || request.journal.damaged.length > 0;
    if (safetyRead.status !== 'valid') {
      const recovered = await k.safetyStore.recoverUnknown(owner, correction, { verify: async candidate => {
        const observed = await k.safetyStore.read(deadline);
        return k.guard.held && observed.status !== 'valid' && candidate.recoveryWitness?.owner.operationId === operationId && candidate.correction !== null
          && (await k.operations.read(operationId, deadline)).status === 'absent';
      } }, deadline);
      safetyRead = { status: 'valid', ...recovered }; correction = recovered.value.correction;
    } else if (invalidates) {
      const changed = await k.safetyStore.invalidate(request.cause === 'coreRejected' ? 'coreRejected' : 'contextUncertain', deadline);
      safetyRead = { status: 'valid', ...changed }; correction = changed.value.correction;
    }
    const prerequisite = inheritedCarry === null ? await this.prerequisite(request, deadline) : { ...inheritedCarry.prerequisite,
      actions: inheritedCarry.prerequisite.actions.filter(action => action.kind !== 'removeCarry'),
      nextAction: Math.min(inheritedCarry.prerequisite.nextAction, inheritedCarry.prerequisite.actions.filter(action => action.kind !== 'removeCarry').length),
      carryRelease: { attemptRef: { operationId, attemptOrdinal: 0 } } };
    const position = recoveryPlanPosition(prerequisite, request.journal, request.journal.cursor.status === 'valid' ? request.journal.cursor.value.lastAckedSequence : 0);
    const handoffs: RetainedHandoff[] = [...(inheritedCarry?.record.plan.handoffs ?? [])];
    for (const event of readableEvents) {
      const handoff = handoffFor(event.metadata, request.rejectedEvent?.eventId === event.metadata.eventId ? request.cause === 'coreRejected' ? 'rejected' : 'unverified' : 'replayable');
      const previous = handoffs.findIndex(item => item.logicalOutboxId === handoff.logicalOutboxId);
      if (previous < 0) { handoffs.push(handoff); }
      else { handoffs[previous] = mergeHandoff(handoffs[previous]!, handoff); }
    }
    const episode: RecoveryEpisode = { activationId, trigger: 'initial', phase: 'preparing', attemptAtStart: 0, replacementAttempt: null, prerequisite,
      acceptedRecovery: null, successorEpisode: null, releaseOperationId: null, startedAt: now, endedAt: null };
    const record: RepairOperation = { operationVersion: 1, operationId, scopeSha256: k.scope.bindingSha256, kind: 'repair', cause: request.cause, compacted: false,
      startedAt: now, completedAt: null, outcome: null,
      plan: { ...position, affected: readableEvents.map(event => ({ sequence: event.metadata.sequence, eventId: event.metadata.eventId, fileSha256: event.sha256 })),
        rejectedRecord: request.rejected === undefined ? null : { name: request.rejected.name, sha256: request.rejected.sha256 },
        lostOperations: inventory.invalid.filter(item => item.sha256 !== null).map(item => ({ name: item.name, sha256: item.sha256!, destination: `quarantine/${item.name}.${newIdentity()}.quarantined` })), publishedVersions: null, retiredRecords: [], handoffs, correctionId: correction?.correctionId ?? null,
        inheritedRecovery: inheritedCarry?.owner ?? (reservedWitness !== null && !sameRecoveryOwner(reservedWitness.owner, owner) ? reservedWitness.owner : null), skippedRanges: mergeRanges(inheritedRanges, prerequisite?.skippedRanges ?? []) },
      recovery: { attempts: [{ publication: 'due', selectedRecord: null, journalEvent: null }], episodes: [episode], activeEpisode: 0 } };
    await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', operationId + '.json'), Buffer.from(stringifyProspectiveJson(record, 'state-event', 'operations/' + operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event', deadline);
    const witness = (await k.safety(deadline)).recoveryWitness;
    if (witness === null) { await k.safetyStore.prepareWitness(owner, deadline); }
    else if (!sameRecoveryOwner(witness.owner, owner)) { await k.safetyStore.prepareTransfer(owner, deadline); }
    let created = await k.operations.create(record, deadline);
    if (record.cause === 'capacity') { this.selectedCapacityRoot = record.operationId; this.capacitySource = k.resources.currentSource(); }
    await k.safetyStore.activateWitness(owner, this.ownerProof(owner), deadline);
    if (correction !== null) {
      if (correction.recoveryOperationId !== null && correction.recoveryOperationId !== operationId) {
        await this.transferLostCorrection(correction.correctionId, correction.recoveryOperationId, operationId, deadline);
      } else {
        await k.safetyStore.bindCorrection(correction.correctionId, operationId, { verify: async () => (await this.stored(operationId, deadline)).record.plan.correctionId === correction!.correctionId }, deadline);
      }
    }
    return created;
  }

  private async fileHash(relative: string, deadline?: Deadline): Promise<string | null> {
    const k = this.kernel;
    const target = await k.inspector.inspect(k.scope.dataRoot, path.join(k.scope.dataRoot, relative), true, deadline?.remaining());
    if (!target.exists) { return null; }
    requireControl(target.kind === 'file');
    return (await observeFile(target.path, deadline)).sha256;
  }

  private async prerequisite(request: RepairRequest, deadline?: Deadline, preserve = true): Promise<RecoveryPrerequisite | null> {
    const { journal, cause } = request;
    const structural = cause === 'header' || journal.header.status !== 'valid' ? 'header' : cause === 'cursor' || journal.cursor.status !== 'valid' ? 'cursor'
      : cause === 'gap' || journal.fault === 'gap' || journal.damaged.length > 0 ? 'gap' : ['coreRejected', 'settlementUnverified', 'versionChange', 'capacity'].includes(cause) ? 'rewind' : null;
    if (request.unboundCarrySha256 !== undefined) {
      // Do not rewrite a destructive structural plan around unknown payloads.
      // The preserved intent continues to block until that authority is repaired.
      requireControl(structural === null);
      return { kind: 'rewind', actions: [quarantineCarry(request.unboundCarrySha256)], nextAction: 0, carry: null, carryRelease: null, skippedRanges: [] };
    }
    if (structural === null) { return null; }
    const k = this.kernel;
    const now = utcNow();
    const actions: RecoveryAction[] = [];
    const ranges: SkippedRange[] = [];
    let header: JournalHeader;
    let cursor: JournalCursor;
    let highWater: number;
    if (structural === 'header') {
      header = { journalVersion: 1, journalId: newIdentity(), createdAt: now, highWaterSequence: 0, historyVerified: false };
      highWater = 0;
      const members = [headerPath, cursorPath, ...[...journal.events.keys()].map(sequence => `journal/events/${eventFileName(sequence)}`), ...journal.damaged.map(event => path.relative(k.scope.dataRoot, event.path).replaceAll(path.sep, '/'))];
      for (const relative of [...new Set(members)]) { await this.quarantineAction(relative, actions, deadline); }
      cursor = { cursorVersion: 1, journalId: header.journalId, consumerId: 'agent-session', lastAckedSequence: 0, lastSentSequence: 0, lastAcceptedRevision: null, updatedAt: now };
      actions.push({ kind: 'publishHeader', target: { path: headerPath, before: null, after: hashValue(header) }, value: header },
        { kind: 'publishCursor', target: { path: cursorPath, before: null, after: hashValue(cursor) }, value: cursor });
    } else {
      requireControl(journal.header.status === 'valid');
      header = journal.header.value;
      if (structural === 'cursor') {
        highWater = header.highWaterSequence;
        if (highWater > 0) { ranges.push({ journalId: header.journalId, firstSequence: 1, lastSequence: highWater, reason: 'cursorRecovery', discharge: null }); }
        cursor = { cursorVersion: 1, journalId: header.journalId, consumerId: 'agent-session', lastAckedSequence: highWater, lastSentSequence: highWater, lastAcceptedRevision: null, updatedAt: now };
        actions.push({ kind: 'publishCursor', target: { path: cursorPath, before: await this.fileHash(cursorPath, deadline), after: hashValue(cursor) }, value: cursor });
      } else {
        requireControl(journal.cursor.status === 'valid');
        const acked = journal.cursor.value.lastAckedSequence;
        highWater = structural === 'gap' ? (journal.firstBadSequence ?? acked + 1) - 1 : request.rejectedEvent !== undefined ? Math.max(acked, request.rejectedEvent.sequence - 1) : acked;
        const members = [...[...journal.events.keys()].filter(sequence => sequence > highWater).map(sequence => `journal/events/${eventFileName(sequence)}`),
          ...journal.damaged.filter(event => structural === 'gap' || Number(path.basename(event.path, '.json')) > highWater).map(event => path.relative(k.scope.dataRoot, event.path).replaceAll(path.sep, '/'))];
        for (const relative of [...new Set(members)]) { await this.quarantineAction(relative, actions, deadline); }
        const lowered = { ...header, highWaterSequence: highWater };
        cursor = { ...journal.cursor.value, lastSentSequence: Math.min(journal.cursor.value.lastSentSequence, highWater) };
        actions.push({ kind: 'publishCursor', target: { path: cursorPath, before: journal.cursor.sha256, after: hashValue(cursor) }, value: cursor },
          { kind: 'raiseHighWater', target: { path: headerPath, before: journal.header.sha256, after: hashValue(lowered) }, value: lowered });
      }
    }
    const preliminary: RecoveryPrerequisite = { kind: structural, actions, nextAction: 0, carry: null, carryRelease: null, skippedRanges: ranges };
    return preserve ? this.preserveRecovery(preliminary, journal, deadline) : preliminary;
  }

  private async preserveRecovery(plan: RecoveryPrerequisite, snapshot: JournalSnapshot, deadline?: Deadline): Promise<RecoveryPrerequisite> {
    const k = this.kernel;
    const safety = await k.safetyStore.read(deadline);
    if (safety.status !== 'valid' || safety.value.recoveryWitness === null) { return plan; }
    const witness = safety.value.recoveryWitness;
    const owner = await k.operations.read(witness.owner.operationId, deadline);
    if (owner.status !== 'valid' || owner.value.compacted || owner.value.kind !== 'repair') { return plan; }
    const selected = owner.value.recovery.attempts.at(-1)?.selectedRecord;
    const event = this.readableEvents(snapshot).find(entry => !entry.metadata.compacted && entry.metadata.type === 'state.resync' && entry.metadata.logicalOutboxId === selected?.logicalOutboxId
      && entry.metadata.recordSha256 === selected.recordSha256);
    if (event === undefined || !plan.actions.some(action => action.kind === 'quarantine' && action.source.path === `journal/events/${eventFileName(event.metadata.sequence)}`)) { return plan; }
    const sourcePath = `journal/events/${eventFileName(event.metadata.sequence)}`;
    const source = await this.readRecoverySource({ root: 'scope', path: sourcePath, sha256: event.sha256, payloadBindingSha256: event.metadata.payloadBindingSha256 }, deadline);
    const oldCarry = await this.fileHash('journal/recovery-event.json', deadline);
    requireControl(oldCarry === null);
    const metadata = eventRewriteMetadata(event.metadata);
    const carry = await k.codec.previewEvent('journal/recovery-event.json', source, metadata, 'event', event.metadata.payloadBindingSha256, 0, deadline);
    const preservation: RecoveryAction = { kind: 'preserveRecovery', target: { path: 'journal/recovery-event.json', before: null, after: carry.sha256 },
      source: { root: 'scope', path: sourcePath, sha256: event.sha256, payloadBindingSha256: event.metadata.payloadBindingSha256 }, metadata };
    const actions = [preservation, ...plan.actions];
    const finalHeaderAction = [...actions].reverse().find(action => action.kind === 'publishHeader' || action.kind === 'raiseHighWater');
    if (finalHeaderAction === undefined || finalHeaderAction.kind !== 'publishHeader' && finalHeaderAction.kind !== 'raiseHighWater') {
      return { ...plan, actions, carry: { path: 'journal/recovery-event.json', sha256: carry.sha256 } };
    }
    const header = finalHeaderAction.value;
    const restoredMetadata = { ...metadata, journalId: header.journalId, eventId: plan.kind === 'header' ? await k.eventIdentity(snapshot, deadline) : metadata.eventId,
      sequence: header.highWaterSequence + 1, acknowledgedAt: null };
    const destination = `journal/events/${eventFileName(restoredMetadata.sequence)}`;
    const restored = await k.codec.previewEvent(destination, source, restoredMetadata, 'event', event.metadata.payloadBindingSha256, 0, deadline);
    const raised = { ...header, highWaterSequence: restoredMetadata.sequence };
    actions.push({ kind: 'appendRecovery', target: { path: destination, before: null, after: restored.sha256 },
      source: { root: 'scope', path: 'journal/recovery-event.json', sha256: carry.sha256, payloadBindingSha256: event.metadata.payloadBindingSha256 }, metadata: restoredMetadata },
    { kind: 'raiseHighWater', target: { path: headerPath, before: finalHeaderAction.target.after, after: hashValue(raised) }, value: raised },
    { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: carry.sha256, after: null } });
    return { ...plan, actions, carry: { path: 'journal/recovery-event.json', sha256: carry.sha256 } };
  }

  private async quarantineAction(relative: string, actions: RecoveryAction[], deadline?: Deadline): Promise<void> {
    const sha256 = await this.fileHash(relative, deadline);
    if (sha256 === null) { return; }
    actions.push({ kind: 'quarantine', source: { path: relative, before: sha256, after: null },
      target: { path: `quarantine/${path.basename(relative)}.${newIdentity()}.quarantined`, before: null, after: sha256 } });
  }

  reconcileCarry(deadline?: Deadline): Promise<void> {
    return this.kernel.resources.withTransition('repair', () => this.reconcileCarryOwned(deadline));
  }

  private async reconcileCarryOwned(deadline?: Deadline): Promise<void> {
    const k = this.kernel;
    const inventory = await k.operations.list(deadline);
    const sha256 = await k.carryHash(deadline);
    if (sha256 === null) { return; }
    if (deferredCarryAuthority(inventory).state === 'unavailable') { throw new SafetyUnavailableError('Present carry has unavailable ownership.'); }
    if (hasCarryAuthority(sha256, inventory)) { return; }
    const unfinished = inventory.records.filter(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record));
    if (inventory.invalid.length === 0 && unfinished.length === 1) {
      const record = requireRepair(unfinished[0]!.record);
      const active = record.recovery.activeEpisode;
      const plan = active === null ? null : record.recovery.episodes[active]!.prerequisite;
      const appendIndex = plan?.carry === null || plan?.carryRelease !== null ? -1 : plan.actions.findIndex(action => action.kind === 'appendRecovery'
        && action.source.root === 'scope' && action.source.path === plan.carry!.path && action.source.sha256 === plan.carry!.sha256);
      if (record.scopeSha256 === k.scope.bindingSha256 && plan?.carry?.path === 'journal/recovery-event.json' && plan.carry.sha256 !== sha256
        && appendIndex >= plan.nextAction) {
        const slot = await this.stableEvent(plan.carry.path, 0, deadline);
        if (slot.status === 'invalid' && slot.sha256 === sha256) { return; }
      }
    }
    if (inventory.records.some(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record))) {
      await k.safetyStore.invalidate('contextUncertain', deadline);
    }
    await this.plan({ cause: 'operationLost', journal: await k.journal.read(deadline), unboundCarrySha256: sha256 }, deadline);
  }

  reconcileSafety(deadline?: Deadline): Promise<void> {
    return this.kernel.resources.withTransition('repair', () => this.reconcileSafetyOwned(deadline));
  }

  private async reconcileSafetyOwned(deadline?: Deadline): Promise<void> {
    const k = this.kernel;
    await this.reconcileCarry(deadline);
    let safetyRead = await k.safetyStore.read(deadline);
    if (safetyRead.status !== 'valid') {
      await this.plan({ cause: 'contextUncertain', journal: await k.journal.read(deadline) }, deadline);
      safetyRead = await k.safetyStore.read(deadline);
    }
    requireControl(safetyRead.status === 'valid');
    const currentInventory = await k.operations.list(deadline);
    const activeRoots = currentInventory.records.filter(entry => !entry.record.compacted && entry.record.kind === 'repair' && entry.record.recovery.activeEpisode !== null);
    requireControl(activeRoots.length <= 1);
    const reserved = safetyRead.value.recoveryWitness;
    if (reserved?.phase === 'preparing' || reserved?.phase === 'transferring') {
      const owner = reserved.phase === 'transferring' ? reserved.successor! : reserved.owner;
      const planned = await k.operations.read(owner.operationId, deadline);
      if (planned.status === 'invalid') { throw new SafetyUnavailableError('Reserved recovery authority is content-invalid.'); }
      if (planned.status === 'valid') {
        await this.restoreReservedEpisode(owner, deadline);
        // A durable reserved plan must become the active witnessed owner before
        // any dependent correction-pointer transfer can use it as authority.
        await this.activateReservedWitness(owner, deadline);
        safetyRead = await k.safetyStore.read(deadline);
        requireControl(safetyRead.status === 'valid');
      }
    }
    if (safetyRead.value.recoveryWitness === null && activeRoots.length === 0 && currentInventory.records.some(entry => !entry.record.compacted && entry.record.kind !== 'handover'
      && entry.record.plan.skippedRanges.some(range => range.discharge === null))) {
      await k.safetyStore.invalidate('contextUncertain', deadline);
      await this.plan({ cause: 'contextUncertain', journal: await k.journal.read(deadline) }, deadline);
      safetyRead = await k.safetyStore.read(deadline);
      requireControl(safetyRead.status === 'valid');
    }
    if (safetyRead.value.recoveryWitness === null && activeRoots.length === 1) {
      const repair = requireRepair(activeRoots[0]!.record);
      const owner = activeRecoveryOwner(repair)!;
      await k.safetyStore.invalidate(repair.plan.handoffs.some(item => item.presentation === 'rejected') ? 'coreRejected' : 'contextUncertain', deadline);
      await k.safetyStore.prepareWitness(owner, deadline);
      await k.safetyStore.activateWitness(owner, this.ownerProof(owner), deadline);
      await this.bindCorrection(repair.operationId, deadline);
      safetyRead = await k.safetyStore.read(deadline);
      requireControl(safetyRead.status === 'valid');
    }
    const predecessorId = safetyRead.value.correction?.recoveryOperationId;
    if (predecessorId !== null && predecessorId !== undefined) {
      const prior = await k.operations.read(predecessorId, deadline);
      if (prior.status !== 'valid') {
        await k.safetyStore.invalidate('contextUncertain', deadline);
        const replacement = await this.plan({ cause: 'operationLost', journal: await k.journal.read(deadline) }, deadline);
        await this.bindCorrection(replacement.record.operationId, deadline);
        safetyRead = await k.safetyStore.read(deadline);
        requireControl(safetyRead.status === 'valid');
      }
      if (prior.status === 'valid' && !prior.value.compacted && prior.value.kind === 'repair' && prior.value.recovery.episodes.at(-1)?.phase === 'abandonedByRelease') {
        const releaseId = prior.value.recovery.episodes.at(-1)!.releaseOperationId;
        const correction = safetyRead.value.correction!;
        await k.safetyStore.detachAbandonedCorrection(correction.correctionId, predecessorId, { verify: async () => {
          if (releaseId === null) { return false; }
          const release = await k.operations.read(releaseId, deadline);
          return release.status === 'valid' && !release.value.compacted && release.value.kind === 'release' && release.value.completedAt !== null && release.value.plan.mode === 'abandon'
            && release.value.plan.result?.owner === 'bridge' && release.value.plan.unfinishedRepairs.some(item => item.operationId === predecessorId);
        } }, deadline);
        safetyRead = await k.safetyStore.read(deadline);
        requireControl(safetyRead.status === 'valid');
      }
    }
    if (safetyRead.value.pendingCheck !== null) {
      await k.safetyStore.invalidate('contextUncertain', deadline);
      const intent = await this.plan({ cause: 'contextUncertain', journal: await k.journal.read(deadline) }, deadline);
      await this.bindCorrection(intent.record.operationId, deadline);
      const token = safetyRead.value.pendingCheck;
      const cleared = await k.safetyStore.finishCheck(token, { verify: async current => {
        const record = await this.stored(intent.record.operationId, deadline);
        return current.correction !== null && current.correction.recoveryOperationId === record.record.operationId && record.record.plan.correctionId === current.correction.correctionId
          && current.recoveryWitness?.owner.operationId === record.record.operationId;
      } }, deadline);
      requireControl(cleared);
    }
    const safety = await k.safety(deadline);
    if (safety.correction !== null && safety.correction.recoveryOperationId === null) {
      const inventory = await k.operations.list(deadline);
      const candidates = inventory.records.filter(item => !item.record.compacted && item.record.kind === 'repair' && item.record.plan.correctionId === safety.correction!.correctionId
        && item.record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease');
      requireControl(candidates.length <= 1);
      const witnessedRoot = safety.recoveryWitness;
      const witnessedRootLost = witnessedRoot !== null && (witnessedRoot.phase === 'active' || witnessedRoot.phase === 'awaitingDisclosure')
        && !inventory.records.some(item => item.record.operationId === witnessedRoot.owner.operationId);
      const record = candidates[0] ?? await this.plan({ cause: witnessedRootLost ? 'operationLost' : 'contextUncertain', journal: await k.journal.read(deadline) }, deadline);
      await this.bindCorrection(record.record.operationId, deadline);
    }
    const witness = (await k.safety(deadline)).recoveryWitness;
    if (witness !== null) {
      const owner = witness.phase === 'transferring' ? witness.successor! : witness.owner;
      const operation = await k.operations.read(owner.operationId, deadline);
      if (operation.status !== 'valid') {
        if (witness.phase === 'preparing' && operation.status === 'absent') { await this.plan({ cause: 'contextUncertain', journal: await k.journal.read(deadline) }, deadline); }
        else { await k.safetyStore.invalidate('contextUncertain', deadline); await this.plan({ cause: 'operationLost', journal: await k.journal.read(deadline) }, deadline); }
      } else if (witness.phase === 'preparing' || witness.phase === 'transferring') { await this.activateReservedWitness(owner, deadline); }
      else if (!operation.value.compacted && operation.value.kind === 'repair' && operation.value.recovery.activeEpisode === null && witness.phase === 'active') {
        const episode = operation.value.recovery.episodes[owner.episodeOrdinal];
        requireControl(operation.value.scopeSha256 === witness.scopeSha256 && owner.episodeOrdinal === operation.value.recovery.episodes.length - 1
          && episode?.activationId === owner.activationId && episode.phase === 'completed');
        const checkpoint = episode.acceptedRecovery;
        const snapshot = await k.journal.read(deadline);
        if (checkpoint !== null && await this.acceptedRecoveryUsable(operation.value, snapshot, owner.episodeOrdinal, deadline)) {
          await k.safetyStore.awaitDisclosure(owner, { journalId: checkpoint.journalId, eventId: checkpoint.eventId,
            sequence: checkpoint.sequence, generation: checkpoint.generation }, this.ownerProof(owner), deadline);
        } else { await this.plan({ cause: 'contextUncertain', journal: snapshot }, deadline); }
      }
    }
  }

  private async activateReservedWitness(owner: RecoveryOwner, deadline?: Deadline): Promise<void> {
    await this.kernel.safetyStore.activateWitness(owner, { verify: async current => {
      const witness = current.recoveryWitness;
      const planned = await this.stored(owner.operationId, deadline);
      return this.kernel.guard.held && witness !== null && reservedWitnessMatches(witness, planned.record);
    } }, deadline);
  }

  private async restoreReservedEpisode(owner: RecoveryOwner, deadline?: Deadline): Promise<void> {
    const k = this.kernel;
    const stored = await this.stored(owner.operationId, deadline);
    const witness = (await k.safety(deadline)).recoveryWitness;
    requireControl(witness !== null);
    if (reservedWitnessMatches(witness, stored.record)) { return; }
    const record = stored.record;
    requireControl(witness.scopeSha256 === record.scopeSha256 && owner.episodeOrdinal === record.recovery.episodes.length
      && !record.recovery.episodes.some(episode => episode.activationId === owner.activationId));
    if (record.recovery.activeEpisode === null) {
      const previous = record.recovery.episodes.at(-1)!;
      requireControl(previous.phase === 'completed' || previous.phase === 'recordRejected');
      requireControl(witness.phase === 'preparing' && sameRecoveryOwner(witness.owner, owner)
        || witness.phase === 'transferring' && witness.successor !== null && sameRecoveryOwner(witness.successor, owner)
        && sameRecoveryOwner(witness.owner, { operationId: record.operationId, episodeOrdinal: record.recovery.episodes.length - 1, activationId: previous.activationId }));
      const snapshot = await k.journal.read(deadline);
      const replay = replayCandidate(record, owner.activationId, utcNow());
      const position = snapshot.fault === null && snapshot.damaged.length === 0 && snapshot.header.status === 'valid' && snapshot.cursor.status === 'valid'
        ? recoveryPlanPosition(null, snapshot, replay.plan.lastGoodSequence) : null;
      await k.operations.update(stored, () => position === null ? replay : { ...replay, plan: { ...replay.plan, ...position } }, deadline);
      return;
    }
    requireControl(witness.phase === 'transferring' && witness.successor !== null && sameRecoveryOwner(witness.successor, owner)
      && sameRecoveryOwner(witness.owner, activeRecoveryOwner(record)!));
    const snapshot = await k.journal.read(deadline);
    const pending = record.recovery.episodes[record.recovery.activeEpisode!]!.prerequisite;
    if (pending !== null && snapshot.fault === null && snapshot.damaged.length === 0) {
      const decision = await this.ordinaryCarryDecision(record, pending, deadline);
      if (decision !== null && decision.kind !== 'intact') {
        await this.publishOrdinaryCarryEpisode(stored, owner, decision, true, false, deadline);
        return;
      }
    }
    await this.publishDamageEpisode(stored, snapshot, owner, deadline);
  }

  private async bindCorrection(operationId: string, deadline?: Deadline): Promise<void> {
    const k = this.kernel;
    const safety = await k.safety(deadline);
    const correction = safety.correction;
    if (correction === null) { return; }
    let stored = await this.stored(operationId, deadline);
    if (stored.record.plan.correctionId === null) {
      const updated = await k.operations.update(stored, record => ({ ...requireRepair(record), plan: { ...requireRepair(record).plan, correctionId: correction.correctionId } }), deadline);
      stored = { ...updated, record: requireRepair(updated.record) };
    }
    requireControl(stored.record.plan.correctionId === correction.correctionId);
    if (correction.recoveryOperationId !== null && correction.recoveryOperationId !== operationId) {
      await this.transferLostCorrection(correction.correctionId, correction.recoveryOperationId, operationId, deadline);
      return;
    }
    await k.safetyStore.bindCorrection(correction.correctionId, operationId, { verify: async () => (await this.stored(operationId, deadline)).record.plan.correctionId === correction.correctionId }, deadline);
  }

  private async transferLostCorrection(correctionId: string, predecessorId: string, operationId: string, deadline?: Deadline): Promise<void> {
    const k = this.kernel;
    await k.safetyStore.transferCorrection(correctionId, predecessorId, operationId, { verify: async current => {
      const successor = await this.stored(operationId, deadline);
      const owner = activeRecoveryOwner(successor.record);
      if (owner === null || successor.record.plan.correctionId !== correctionId || current.recoveryWitness?.phase !== 'active'
        || !sameRecoveryOwner(current.recoveryWitness.owner, owner)) { return false; }
      const predecessor = await k.operations.read(predecessorId, deadline);
      // Infrastructure failures propagate. Readable absence or invalid bytes can
      // transfer the correction without inventing an unknown episode activation.
      if (predecessor.status === 'valid') { return false; }
      const inherited = successor.record.plan.inheritedRecovery;
      if (predecessor.status === 'invalid' && (predecessor.sha256 === null || !successor.record.plan.lostOperations.some(item => item.name === `${predecessorId}.json` && item.sha256 === predecessor.sha256))) { return false; }
      // The independent witness can have advanced through another lost root
      // before the older correction pointer was published. Validate both losses.
      if (inherited !== null && inherited.operationId !== predecessorId) {
        const witnessed = await k.operations.read(inherited.operationId, deadline);
        if (witnessed.status === 'valid' || witnessed.status === 'invalid' && (witnessed.sha256 === null
          || !successor.record.plan.lostOperations.some(item => item.name === `${inherited.operationId}.json` && item.sha256 === witnessed.sha256))) { return false; }
      }
      const inventory = await k.operations.list(deadline);
      const matches = inventory.records.filter(entry => !entry.record.compacted && entry.record.kind === 'repair' && entry.record.plan.correctionId === correctionId
        && entry.record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease');
      return matches.length === 1 && matches[0]!.record.operationId === operationId;
    } }, deadline);
  }

  private async retireAndRewind(stored: StoredOperation, event: EventDescription, presentation: 'rejected' | 'unverified', snapshot: JournalSnapshot, deadline?: Deadline): Promise<StoredOperation> {
    const record = requireRepair(stored.record);
    const index = record.recovery.activeEpisode;
    requireControl(index !== null);
    const handoffs = [...record.plan.handoffs];
    for (const value of this.readableEvents(snapshot)) {
      const replacement = handoffFor(value.metadata, value.metadata.eventId === event.eventId ? presentation : 'replayable');
      const prior = handoffs.findIndex(item => item.logicalOutboxId === replacement.logicalOutboxId);
      if (prior < 0) { handoffs.push(replacement); }
      else { handoffs[prior] = mergeHandoff(handoffs[prior]!, replacement); }
    }
    const request: RepairRequest = { cause: presentation === 'rejected' ? 'coreRejected' : 'settlementUnverified', journal: snapshot, rejectedEvent: event };
    const previous = record.recovery.episodes[index]!.prerequisite;
    const deferred = previous !== null && !carryReleaseResolved(previous);
    if (deferred) { requireControl(!this.damageEpisodeCreated); }
    const prerequisite = deferred ? (await this.reconstructPrerequisite(previous, request, record, deadline)).prerequisite : await this.prerequisite(request, deadline);
    const successor = deferred ? { operationId: record.operationId, episodeOrdinal: record.recovery.episodes.length, activationId: await this.kernel.activationIdentity(deadline) } : null;
    const candidate = (() => {
      const item = record;
      const repair = requireRepair(item);
      const retiredRecords = presentation === 'rejected' && !repair.plan.retiredRecords.some(item => item.logicalOutboxId === event.logicalOutboxId && item.recordSha256 === event.recordSha256)
        ? [...repair.plan.retiredRecords, { name: `event-${event.logicalOutboxId.slice(33).padStart(16, '0')}.json`, logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }] : repair.plan.retiredRecords;
      const retained = { ...repair, plan: { ...repair.plan, handoffs, retiredRecords } };
      if (successor !== null) {
        return transferEpisode(retained, { activationId: successor.activationId, trigger: 'rewind', attemptAtStart: currentAttemptOrdinal(repair), replacementAttempt: null,
          prerequisite, acceptedRecovery: null, startedAt: utcNow() }, utcNow());
      }
      return { ...retained, recovery: { ...repair.recovery, episodes: repair.recovery.episodes.map((episode, ordinal) => ordinal === index ? { ...episode, prerequisite, phase: 'reconstructing' as const } : episode) } };
    })();
    if (successor !== null) {
      const k = this.kernel;
      await k.resources.reserve('repair', { uncompactedEvents: 1, retainedHandoffs: this.handoffGrowth(handoffs, await k.operations.list(deadline)) }, deadline);
      await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', record.operationId + '.json'),
        Buffer.from(stringifyProspectiveJson(candidate, 'state-event', 'operations/' + record.operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event', deadline);
      await k.safetyStore.prepareTransfer(successor, deadline);
    }
    const updated = await this.kernel.operations.update(stored, () => candidate, deadline);
    if (successor !== null) { await this.kernel.safetyStore.activateWitness(successor, this.ownerProof(successor), deadline); this.damageEpisodeCreated = true; }
    return updated;
  }

  private executor(operationId: string): RecoveryExecutor {
    const k = this.kernel;
    return new RecoveryExecutor({ scope: k.scope, inspector: k.inspector, publisher: k.publisher, codec: k.codec,
      admit: async action => {
        k.resources.capacity.invalidateOwed();
        const current = await this.stored(operationId);
        const owner = activeRecoveryOwner(current.record);
        const safety = await k.safety();
        requireControl(owner !== null && safety.recoveryWitness !== null && safety.recoveryWitness.phase === 'active' && sameRecoveryOwner(safety.recoveryWitness.owner, owner));
        const prerequisite = current.record.recovery.episodes[owner.episodeOrdinal]!.prerequisite;
        requireControl(prerequisite !== null && stringifyJson(prerequisite.actions[prerequisite.nextAction], 'state-event') === stringifyJson(action, 'state-event'));
        if (action.kind === 'removeCarry' && prerequisite.carryRelease !== null) {
          requireControl(this.hasCarryRemovalAuthorization(current.record, prerequisite));
        }
      },
      authorizeMutation: async action => {
        const current = await this.stored(operationId);
        const episode = current.record.recovery.episodes[current.record.recovery.activeEpisode!]!;
        if (action.kind === 'removeCarry' && episode.prerequisite?.carryRelease != null) { requireControl(await this.acceptedRecoveryUsable(current.record)); }
      },
      readPayloadSource: source => this.readRecoverySource(source) });
  }

  private hasCarryRemovalAuthorization(record: RepairOperation, plan: RecoveryPrerequisite): boolean {
    return plan.carryRelease !== null && record.recovery.episodes.some(episode => episode.acceptedRecovery !== null && episode.prerequisite?.carry?.sha256 === plan.carry?.sha256
      && episode.prerequisite?.carryRelease?.attemptRef.operationId === plan.carryRelease!.attemptRef.operationId
      && episode.prerequisite.carryRelease.attemptRef.attemptOrdinal === plan.carryRelease!.attemptRef.attemptOrdinal && carryReleaseRemovalIndex(episode.prerequisite) >= 0);
  }

  private async acceptedRecoveryUsable(record: RepairOperation, observedJournal?: JournalSnapshot,
    episodeOrdinal: number | null = record.recovery.activeEpisode, deadline?: Deadline): Promise<boolean> {
    const index = episodeOrdinal;
    requireControl(index !== null);
    const episode = record.recovery.episodes[index]!;
    const accepted = episode.acceptedRecovery;
    if (accepted === null || !this.kernel.guard.held) { return false; }
    const safety = await this.kernel.safety(deadline);
    const snapshot = observedJournal ?? await this.kernel.journal.read(deadline);
    if (safety.pendingCheck !== null || accepted.generation !== safety.generation || snapshot.fault !== null || snapshot.damaged.length > 0 || snapshot.header.status !== 'valid'
      || snapshot.cursor.status !== 'valid' || snapshot.header.value.journalId !== accepted.journalId || snapshot.header.value.highWaterSequence !== accepted.sequence) { return false; }
    const event = snapshot.events.get(accepted.sequence)?.metadata;
    if (event === undefined || event.eventId !== accepted.eventId || !hasCurrentAcceptance(event, safety.generation)) { return false; }
    const ordinal = currentAttemptOrdinal(record);
    const attempt = record.recovery.attempts[ordinal]!;
    return attempt.publication === 'observed' && attempt.selectedRecord?.logicalOutboxId === event.logicalOutboxId && attempt.selectedRecord.recordSha256 === event.recordSha256
      && attempt.journalEvent?.eventId === event.eventId && attempt.journalEvent.journalId === event.journalId && attempt.journalEvent.sequence === event.sequence
      && event.type === 'state.resync' && !event.compacted && event.sequence >= Math.max(1, record.plan.lastGoodSequence + 1)
      && event.coreRepairOperationId === coreAttemptToken(record.operationId, ordinal) && event.attemptRef?.operationId === record.operationId && event.attemptRef.attemptOrdinal === ordinal
      && (episode.prerequisite?.carryRelease == null || carryReleaseResolved(episode.prerequisite)
        || episode.prerequisite.carryRelease.attemptRef.operationId === record.operationId && episode.prerequisite.carryRelease.attemptRef.attemptOrdinal === ordinal);
  }

  private recoveryJournalRequests(record: RepairOperation, plan: RecoveryPrerequisite): readonly EventReadRequest[] {
    const sequences = new Set<number>();
    for (const attempt of record.recovery.attempts) { if (attempt.journalEvent !== null) { sequences.add(attempt.journalEvent.sequence); } }
    for (const affected of record.plan.affected) { sequences.add(affected.sequence); }
    for (const episode of record.recovery.episodes) {
      for (const action of episode.prerequisite?.actions ?? []) {
        if (action.kind === 'preserveRecovery' || action.kind === 'appendRecovery') { sequences.add(action.metadata.sequence); }
        const paths = action.kind === 'quarantine' ? [action.source.path, action.target.path]
          : action.kind === 'preserveRecovery' || action.kind === 'appendRecovery' ? [action.source.root === 'scope' ? action.source.path : '', action.target.path] : [action.target.path];
        for (const relative of paths) { if (relative.startsWith('journal/events/')) { sequences.add(Number(path.basename(relative, '.json'))); } }
      }
    }
    for (const action of plan.actions) { if (action.kind === 'preserveRecovery') { sequences.add(action.metadata.sequence); } }
    return [...sequences].sort((left, right) => left - right).map(sequence => ({ path: `journal/events/${eventFileName(sequence)}`, sequence }));
  }

  private async readRecoveryJournalSources(record: RepairOperation, plan: RecoveryPrerequisite, deadline?: Deadline): Promise<readonly JournalEvent[]> {
    const requests = this.recoveryJournalRequests(record, plan);
    if (requests.length === 0) { return []; }
    // Core admission also runs inside a journal transaction. Inspect exact
    // retained positions independently rather than reentering its writer queue.
    const results = await new EventReader(this.kernel.scope.dataRoot, this.kernel.inspector).readInventory(requests, deadline ?? Deadline.after(30000));
    return results.flatMap(result => result.status === 'valid' ? [{ metadata: result.metadata, sha256: result.sha256 }] : []);
  }

  private async deferredRestorationSource(record: RepairOperation, plan: RecoveryPrerequisite, deadline?: Deadline): Promise<PayloadSource | null> {
    requireControl(plan.carry !== null);
    const preservation = plan.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === plan.carry!.sha256);
    requireControl(preservation?.kind === 'preserveRecovery');
    const handoff = record.plan.handoffs.find(value => value.logicalOutboxId === preservation.metadata.logicalOutboxId && value.recordSha256 === preservation.metadata.recordSha256
      && value.payloadBindingSha256 === preservation.source.payloadBindingSha256);
    requireControl(handoff !== undefined);
    const sequence = logicalOutboxSequence(handoff.logicalOutboxId);
    requireControl(sequence !== null);
    const outboxSource: PayloadSource = { root: 'companion', path: `state/outbox/event-${eventFileName(sequence)}`, sha256: handoff.recordSha256,
      payloadBindingSha256: preservation.source.payloadBindingSha256 };
    const candidates: PayloadSource[] = [preservation.source];
    for (const episode of record.recovery.episodes) {
      for (const action of episode.prerequisite?.actions ?? []) {
        if ((action.kind === 'appendRecovery' || action.kind === 'preserveRecovery') && action.source.payloadBindingSha256 === preservation.source.payloadBindingSha256
          && action.metadata.logicalOutboxId === preservation.metadata.logicalOutboxId && action.metadata.recordSha256 === preservation.metadata.recordSha256) {
          if (action.source.root !== 'scope' || action.source.path !== plan.carry.path) { candidates.push(action.source); }
          if (action.kind === 'appendRecovery') { candidates.push({ root: 'scope', path: action.target.path, sha256: action.target.after!, payloadBindingSha256: action.source.payloadBindingSha256 }); }
        }
      }
    }
    const journalSources = new Map<string, string>();
    for (const event of await this.readRecoveryJournalSources(record, plan, deadline)) {
      if (event.metadata.compacted) { continue; }
      if (event.metadata.logicalOutboxId !== handoff.logicalOutboxId || event.metadata.recordSha256 !== handoff.recordSha256) { continue; }
      requireControl(event.metadata.payloadBindingSha256 === handoff.payloadBindingSha256 && event.metadata.adapter === preservation.metadata.adapter
        && event.metadata.principal === preservation.metadata.principal);
      const relative = `journal/events/${eventFileName(event.metadata.sequence)}`;
      journalSources.set(relative, event.sha256);
      candidates.push({ root: 'scope', path: relative, sha256: event.sha256, payloadBindingSha256: event.metadata.payloadBindingSha256 });
    }
    candidates.push(outboxSource);
    const paths = new Map<string, PayloadSource[]>();
    for (const source of candidates) {
      if (source.root === 'companion') { requireControl(source.path === outboxSource.path && source.sha256 === outboxSource.sha256); }
      const key = source.root + ':' + source.path;
      const grouped = paths.get(key) ?? [];
      grouped.push(source);
      paths.set(key, grouped);
    }
    let selected: PayloadSource | null = null;
    for (const group of paths.values()) {
      const location = group[0]!;
      if (location.root === 'scope') {
        if (!journalSources.has(location.path)) { continue; }
        const observed = await this.fileHash(location.path, deadline);
        requireControl(observed === journalSources.get(location.path));
        selected ??= group.find(source => source.sha256 === observed) ?? null;
      } else {
        const outbox = await this.kernel.outbox.read(path.basename(location.path), deadline);
        if (outbox.status === 'valid' && outbox.sha256 === outboxSource.sha256) {
          requireControl(outbox.metadata.logicalOutboxId === handoff.logicalOutboxId);
          selected ??= outboxSource;
        }
      }
    }
    return selected;
  }

  private async stableEvent(path: string, sequence: number, deadline?: Deadline): Promise<EventRead> {
    const reader = new EventReader(this.kernel.scope.dataRoot, this.kernel.inspector);
    const request = [{ path, sequence }];
    const first = (await reader.read(request, deadline?.remaining() ?? 30000))[0]!;
    if (first.status === 'valid') { return first; }
    const second = (await reader.read(request, deadline?.remaining() ?? 30000))[0]!;
    requireControl(second.status === first.status && second.sha256 === first.sha256 && (second.status !== 'invalid' || second.sha256 !== null));
    return second;
  }

  private async stableOutbox(name: string, deadline?: Deadline): Promise<OutboxRead> {
    const first = await this.kernel.outbox.read(name, deadline);
    if (first.status === 'valid') { return first; }
    const second = await this.kernel.outbox.read(name, deadline);
    requireControl(second.status === first.status && (first.status === 'absent' || second.status === 'invalid' && second.sha256 === first.sha256));
    return second;
  }

  private async ordinaryCarryDecision(record: RepairOperation, plan: RecoveryPrerequisite, deadline?: Deadline): Promise<OrdinaryCarryDecision | null> {
    if (plan.carry === null || plan.carryRelease !== null) { return null; }
    const appendIndex = plan.actions.findIndex(action => action.kind === 'appendRecovery' && action.source.root === 'scope'
      && action.source.path === plan.carry!.path && action.source.sha256 === plan.carry!.sha256);
    if (appendIndex < 0 || plan.nextAction > appendIndex) { return null; }
    const preservation = plan.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === plan.carry!.sha256);
    requireControl(preservation?.kind === 'preserveRecovery');
    const append = plan.actions[appendIndex]!;
    requireControl(append.kind === 'appendRecovery');
    const pendingCleanup = plan.actions[plan.nextAction];
    const followingPreservation = plan.actions[plan.nextAction + 1];
    const ownsPendingCleanup = pendingCleanup?.kind === 'quarantine' && pendingCleanup.source.path === plan.carry.path
      && followingPreservation?.kind === 'preserveRecovery' && followingPreservation.target.path === plan.carry.path
      && followingPreservation.target.before === null && followingPreservation.target.after === plan.carry.sha256;
    const carried = await this.kernel.carryHash(deadline);
    if (carried === plan.carry.sha256) {
      requireControl(!ownsPendingCleanup);
      return { kind: 'intact', appendIndex };
    }
    const destination = await this.stableEvent(append.target.path, append.metadata.sequence, deadline);
    const pendingQuarantines = plan.actions.slice(plan.nextAction, appendIndex).filter((action): action is RecoveryAction & { kind: 'quarantine' } => action.kind === 'quarantine'
      && action.source.path === append.target.path);
    const previouslyQuarantined = plan.actions.slice(0, plan.nextAction).some(action => action.kind === 'quarantine' && action.source.path === append.target.path);
    const recordedDestination = pendingQuarantines.length === 1 && pendingQuarantines[0]!.source.before === destination.sha256 && !previouslyQuarantined;
    if (destination.status === 'valid') {
      if (destination.sha256 === append.target.after) {
        requireControl(destination.metadata.logicalOutboxId === append.metadata.logicalOutboxId
          && destination.metadata.recordSha256 === append.metadata.recordSha256 && destination.metadata.payloadBindingSha256 === append.source.payloadBindingSha256);
        if (!ownsPendingCleanup) { return { kind: 'intact', appendIndex }; }
      } else {
        requireControl(recordedDestination || preservation.source.root === 'scope' && append.target.path === preservation.source.path && destination.sha256 === preservation.source.sha256
          && destination.metadata.logicalOutboxId === preservation.metadata.logicalOutboxId
          && destination.metadata.recordSha256 === preservation.metadata.recordSha256
          && destination.metadata.payloadBindingSha256 === preservation.source.payloadBindingSha256
          && !previouslyQuarantined);
      }
    }
    if (destination.status === 'invalid') {
      const invalidOriginal = preservation.source.root === 'scope' && append.target.path === preservation.source.path
        && pendingQuarantines.length === 1 && pendingQuarantines[0]!.source.before === preservation.source.sha256;
      requireControl(destination.sha256 !== null && (recordedDestination || invalidOriginal) && !previouslyQuarantined);
    }
    const slot = await this.stableEvent(plan.carry.path, 0, deadline);
    requireControl(slot.status !== 'valid' || slot.sha256 === plan.carry.sha256);
    if (slot.status === 'valid') {
      requireControl(!ownsPendingCleanup);
      return { kind: 'intact', appendIndex };
    }
    requireControl(slot.status === 'absent' && carried === null || slot.status === 'invalid' && slot.sha256 === carried);
    if (ownsPendingCleanup) {
      const targetHash = await this.fileHash(pendingCleanup.target.path, deadline);
      requireControl(targetHash === await this.fileHash(pendingCleanup.target.path, deadline)
        && (slot.status === 'invalid' && slot.sha256 === pendingCleanup.source.before && targetHash === null
          || slot.status === 'absent' && targetHash === pendingCleanup.source.before));
    }
    const handoff = record.plan.handoffs.filter(value => value.logicalOutboxId === preservation.metadata.logicalOutboxId
      && value.recordSha256 === preservation.metadata.recordSha256 && value.payloadBindingSha256 === preservation.source.payloadBindingSha256);
    requireControl(handoff.length === 1);
    const sequence = logicalOutboxSequence(handoff[0]!.logicalOutboxId);
    requireControl(sequence !== null);
    const outboxName = `event-${eventFileName(sequence)}`;
    const outbox = await this.stableOutbox(outboxName, deadline);
    if (outbox.status === 'valid') {
      requireControl(outbox.sha256 === handoff[0]!.recordSha256 && outbox.metadata.logicalOutboxId === handoff[0]!.logicalOutboxId
        && outbox.metadata.game === preservation.metadata.adapter && outbox.metadata.principal === preservation.metadata.principal);
    }
    const original = preservation.source.root === 'scope'
      ? await this.stableEvent(preservation.source.path, preservation.metadata.sequence, deadline) : undefined;
    if (destination.status === 'invalid' && preservation.source.root === 'scope' && append.target.path === preservation.source.path) {
      requireControl(original?.status === 'invalid' && original.sha256 === destination.sha256);
    }
    if (original?.status === 'valid') {
      requireControl(original.sha256 === preservation.source.sha256 && original.metadata.logicalOutboxId === handoff[0]!.logicalOutboxId
        && original.metadata.recordSha256 === handoff[0]!.recordSha256 && original.metadata.payloadBindingSha256 === handoff[0]!.payloadBindingSha256);
    }
    const source = await this.deferredRestorationSource(record, plan, deadline);
    if (ownsPendingCleanup) {
      requireControl(followingPreservation.kind === 'preserveRecovery');
      if (source !== null && source.root === followingPreservation.source.root && source.path === followingPreservation.source.path
        && source.sha256 === followingPreservation.source.sha256
        && source.payloadBindingSha256 === followingPreservation.source.payloadBindingSha256) { return { kind: 'intact', appendIndex }; }
    }
    if (source !== null) {
      const pending = plan.actions[plan.nextAction];
      if (slot.status === 'absent' && pending?.kind === 'preserveRecovery' && pending.target.before === null && pending.target.after === plan.carry.sha256
        && source.root === pending.source.root && source.path === pending.source.path && source.sha256 === pending.source.sha256
        && source.payloadBindingSha256 === pending.source.payloadBindingSha256) { return { kind: 'intact', appendIndex }; }
      const afterQuarantine = plan.actions[plan.nextAction + 1];
      if (slot.status === 'absent' && destination.status === 'invalid' && pending?.kind === 'quarantine'
        && pending.source.path === append.target.path && pending.source.before === destination.sha256
        && afterQuarantine?.kind === 'preserveRecovery' && afterQuarantine.target.before === null && afterQuarantine.target.after === plan.carry.sha256
        && source.root === afterQuarantine.source.root && source.path === afterQuarantine.source.path && source.sha256 === afterQuarantine.source.sha256
        && source.payloadBindingSha256 === afterQuarantine.source.payloadBindingSha256) { return { kind: 'intact', appendIndex }; }
      return { kind: 'restore', source, appendIndex, slotInvalidSha256: slot.status === 'invalid' ? slot.sha256! : undefined,
        recordedSlotCleanup: ownsPendingCleanup, originalSource: original };
    }
    requireControl(outbox.status !== 'valid' && original?.status !== 'valid');
    const repeatedOutbox = await this.kernel.outbox.read(outboxName, deadline);
    requireControl(repeatedOutbox.status === outbox.status && (outbox.status === 'absent'
      || repeatedOutbox.status === 'invalid' && repeatedOutbox.sha256 === outbox.sha256));
    const requests = this.recoveryJournalRequests(record, plan);
    if (requests.length > 0) {
      const reader = new EventReader(this.kernel.scope.dataRoot, this.kernel.inspector);
      const first = await reader.readInventory(requests, deadline ?? Deadline.after(30000));
      const second = await reader.readInventory(requests, deadline ?? Deadline.after(30000));
      for (const [index, entry] of first.entries()) {
        const repeated = second[index]!;
        requireControl(entry.status === repeated.status && entry.sha256 === repeated.sha256);
        requireControl(entry.status !== 'invalid' || entry.sha256 !== null);
        if (entry.status === 'valid' && entry.metadata.logicalOutboxId === handoff[0]!.logicalOutboxId) {
          requireControl(entry.metadata.recordSha256 === handoff[0]!.recordSha256 && entry.metadata.payloadBindingSha256 === handoff[0]!.payloadBindingSha256);
          requireControl(entry.metadata.compacted);
        }
      }
    }
    return { kind: 'lost', appendIndex, slotInvalidSha256: slot.status === 'invalid' ? slot.sha256! : undefined,
      recordedSlotCleanup: ownsPendingCleanup, originalSource: original };
  }

  private async ordinaryStructuralSuffix(plan: RecoveryPrerequisite, appendIndex: number, originalSource?: EventRead, deadline?: Deadline): Promise<RecoveryAction[]> {
    const preservation = plan.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === plan.carry?.sha256);
    requireControl(preservation?.kind === 'preserveRecovery');
    const suffix: RecoveryAction[] = [];
    for (const action of plan.actions.slice(plan.nextAction, appendIndex)) {
      if (action.kind === 'preserveRecovery') { continue; }
      if (action.kind !== 'quarantine' || action.source.path !== preservation.source.path || originalSource === undefined) { suffix.push(action); continue; }
      const sourceHash = await this.fileHash(action.source.path, deadline);
      const targetHash = await this.fileHash(action.target.path, deadline);
      const observations = new Map<string, ManifestObservation>([[action.source.path, { status: 'readable', sha256: sourceHash }],
        [action.target.path, { status: 'readable', sha256: targetHash }]]);
      const condition = recognizeAction(action, observations);
      if (condition === 'after') { suffix.push(action); continue; }
      if (condition === 'before') { requireControl(originalSource.status === 'valid'); suffix.push(action); continue; }
      requireControl(targetHash === null && (sourceHash === null && originalSource.status === 'absent'
        || sourceHash !== null && originalSource.status === 'invalid' && originalSource.sha256 === sourceHash));
      if (sourceHash !== null) { suffix.push({ ...action, source: { ...action.source, before: sourceHash }, target: { ...action.target, after: sourceHash } }); }
    }
    return suffix;
  }

  private async ordinaryCarryPlan(plan: RecoveryPrerequisite, decision: OrdinaryCarryDecision, deadline?: Deadline): Promise<RecoveryPrerequisite> {
    requireControl(decision.kind !== 'intact' && plan.carry !== null && plan.carryRelease === null && plan.nextAction <= decision.appendIndex);
    const structural = await this.ordinaryStructuralSuffix(plan, decision.appendIndex, decision.originalSource, deadline);
    const recordedCleanup = decision.recordedSlotCleanup ? structural[0] : undefined;
    requireControl(!decision.recordedSlotCleanup || recordedCleanup?.kind === 'quarantine' && recordedCleanup === plan.actions[plan.nextAction]
      && recordedCleanup.source.path === plan.carry.path);
    const cleanup: RecoveryAction[] = [];
    if (recordedCleanup !== undefined) { cleanup.push(recordedCleanup); }
    else if (decision.slotInvalidSha256 !== undefined) { cleanup.push(quarantineCarry(decision.slotInvalidSha256)); }
    const remainingStructural = recordedCleanup === undefined ? structural : structural.slice(1);
    if (decision.kind === 'lost') {
      return validatePrerequisite({ kind: plan.kind, actions: [...cleanup, ...remainingStructural], nextAction: 0, carry: null, carryRelease: null, skippedRanges: plan.skippedRanges });
    }
    requireControl(decision.source !== undefined);
    const preservation = await this.prepareCarryPreservation(plan, decision.source, deadline);
    const payloadSuffix = plan.actions.slice(decision.appendIndex);
    requireControl(payloadSuffix[0]?.kind === 'appendRecovery' && payloadSuffix.at(-1)?.kind === 'removeCarry');
    return validatePrerequisite({ kind: plan.kind, actions: [...cleanup, preservation.action, ...remainingStructural, ...payloadSuffix], nextAction: 0,
      carry: plan.carry, carryRelease: null, skippedRanges: plan.skippedRanges });
  }

  private async publishOrdinaryCarryEpisode(stored: StoredOperation & { record: RepairOperation }, owner: RecoveryOwner,
    decision: OrdinaryCarryDecision, reserved = false, activate = true, deadline?: Deadline): Promise<void> {
    requireControl(decision.kind !== 'intact');
    const k = this.kernel;
    const record = stored.record;
    const active = record.recovery.activeEpisode;
    requireControl(active !== null && owner.operationId === record.operationId && owner.episodeOrdinal === record.recovery.episodes.length);
    const previous = record.recovery.episodes[active]!.prerequisite;
    requireControl(previous !== null && previous.carryRelease === null);
    const prerequisite = await this.ordinaryCarryPlan(previous, decision, deadline);
    const at = utcNow();
    const moved = transferEpisode(record, { activationId: owner.activationId, trigger: 'recoveryMissing', attemptAtStart: currentAttemptOrdinal(record),
      replacementAttempt: null, prerequisite, acceptedRecovery: null, startedAt: at }, at);
    const candidate = decision.kind === 'lost' ? replacementCandidate(moved, 'missingPayload') : moved;
    await k.resources.reserve('repair', decision.kind === 'lost' ? { uncompactedEvents: 1 } : {}, deadline);
    await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', candidate.operationId + '.json'),
      Buffer.from(stringifyProspectiveJson(candidate, 'state-event', 'operations/' + candidate.operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event', deadline);
    if (!reserved) { await k.safetyStore.prepareTransfer(owner, deadline); }
    await k.operations.update(stored, () => candidate, deadline);
    if (activate) { await k.safetyStore.activateWitness(owner, this.ownerProof(owner), deadline); }
    this.damageEpisodeCreated = true;
  }

  private async authorizeDeferredCore(record: RepairOperation, deadline?: Deadline): Promise<boolean> {
    const current = (await this.stored(record.operationId, deadline)).record;
    const active = current.recovery.activeEpisode;
    if (active === null || active !== record.recovery.activeEpisode || currentAttemptOrdinal(current) !== currentAttemptOrdinal(record) || !this.kernel.guard.held) { return false; }
    const plan = current.recovery.episodes[active]!.prerequisite;
    if (plan === null || carryReleaseResolved(plan)) { return false; }
    const binding = plan.carryRelease!.attemptRef;
    if (binding.operationId !== current.operationId || binding.attemptOrdinal !== currentAttemptOrdinal(current)
      || !plan.actions.slice(plan.nextAction).every(action => action.kind === 'removeCarry')) { return false; }
    const observed = await this.kernel.carryHash(deadline);
    requireControl(observed === null || observed === plan.carry?.sha256);
    if (observed !== null) { return true; }
    if (await this.kernel.carryHash(deadline) !== null) { return false; }
    if (carryReleaseRemovalIndex(plan) >= 0 && this.hasCarryRemovalAuthorization(current, plan)) { return true; }
    return await this.deferredRestorationSource(current, plan, deadline) === null;
  }

  private async prepareCarryPreservation(plan: RecoveryPrerequisite, source: PayloadSource, deadline?: Deadline): Promise<{ action: RecoveryAction & { kind: 'preserveRecovery' }; bytes: Buffer }> {
    requireControl(plan.carry !== null);
    const preservation = plan.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === plan.carry!.sha256);
    requireControl(preservation?.kind === 'preserveRecovery');
    const bytes = await this.readRecoverySource(source, deadline);
    const preview = await this.kernel.codec.previewEvent(plan.carry.path, bytes, preservation.metadata, source.root === 'companion' ? 'outbox' : 'event', source.payloadBindingSha256,
      source.root === 'companion' ? Number(preservation.metadata.logicalOutboxId.slice(33)) : 0, deadline);
    requireControl(preview.cleanupComplete && preview.sha256 === plan.carry.sha256);
    return { bytes, action: { ...preservation, kind: 'preserveRecovery', source, target: { path: plan.carry.path, before: null, after: plan.carry.sha256 } } };
  }

  private async restoreDeferredCarry(stored: StoredOperation & { record: RepairOperation }): Promise<boolean> {
    const k = this.kernel;
    const record = stored.record;
    const previous = record.recovery.episodes[record.recovery.activeEpisode!]!.prerequisite!;
    requireControl(previous.carry !== null && previous.carryRelease !== null);
    const observed = await k.carryHash();
    requireControl(observed === null || observed === previous.carry.sha256);
    if (observed !== null || carryReleaseRemovalIndex(previous) >= 0) { return false; }
    requireControl(await k.carryHash() === null);
    const source = await this.deferredRestorationSource(record, previous);
    if (source === null) { return false; }
    requireControl(!this.damageEpisodeCreated);
    const prepared = await this.prepareCarryPreservation(previous, source);
    const prerequisite: RecoveryPrerequisite = { ...previous, nextAction: 0, actions: [prepared.action] };
    const owner = { operationId: record.operationId, episodeOrdinal: record.recovery.episodes.length, activationId: await k.activationIdentity() };
    const candidate = transferEpisode(record, { activationId: owner.activationId, trigger: 'recoveryMissing', attemptAtStart: currentAttemptOrdinal(record), replacementAttempt: null,
      prerequisite, acceptedRecovery: null, startedAt: utcNow() }, utcNow());
    await k.resources.reserve('repair');
    await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', record.operationId + '.json'),
      Buffer.from(stringifyProspectiveJson(candidate, 'state-event', 'operations/' + record.operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event');
    await k.safetyStore.prepareTransfer(owner);
    await k.operations.update(stored, () => candidate);
    await k.safetyStore.activateWitness(owner, this.ownerProof(owner));
    this.damageEpisodeCreated = true;
    return true;
  }

  private async readRecoverySource(source: PayloadSource, deadline?: Deadline): Promise<Buffer> {
    const k = this.kernel;
    const root = source.root === 'scope' ? k.scope.dataRoot : k.scope.companionRoot;
    const admission = await k.inspector.inspect(root, path.join(root, source.path), false, deadline?.remaining());
    requireControl(admission.kind === 'file');
    const bytes = await readBoundedFile(admission.path, jsonBudgets['state-event'].maxBytes);
    requireControl(bytesHash(bytes) === source.sha256);
    return bytes;
  }

  private async manifestRepairsFault(plan: RecoveryPrerequisite, snapshot: JournalSnapshot, deadline?: Deadline): Promise<boolean> {
    const remaining = plan.actions.slice(plan.nextAction);
    if (snapshot.fault !== 'header' && snapshot.fault !== 'cursor') {
      return remaining.some(action => action.kind !== 'preserveRecovery' && action.kind !== 'removeCarry');
    }
    const target = snapshot.fault === 'header' ? headerPath : cursorPath;
    const first = remaining.flatMap(action => action.kind === 'quarantine' ? [action.source, action.target] : [action.target]).find(change => change.path === target);
    if (first === undefined) { return false; }
    const observed = await this.fileHash(target, deadline);
    if (observed !== first.before && observed !== first.after) { return false; }
    let header = snapshot.header.status === 'valid' ? snapshot.header.value : null;
    let cursor = snapshot.cursor.status === 'valid' ? snapshot.cursor.value : null;
    for (const action of remaining) {
      if (action.kind === 'publishHeader' || action.kind === 'raiseHighWater') { header = action.value; }
      if (action.kind === 'publishCursor') { cursor = action.value; }
    }
    return header !== null && cursor !== null && header.journalId === cursor.journalId
      && cursor.lastAckedSequence <= header.highWaterSequence && cursor.lastSentSequence <= header.highWaterSequence;
  }

  private async runPrerequisite(operationId: string): Promise<void> {
    const k = this.kernel;
    await k.storage.ensureDirectory('quarantine');
    const executor = this.executor(operationId);
    for (;;) {
      const stored = await this.stored(operationId);
      const ordinal = stored.record.recovery.activeEpisode;
      requireControl(ordinal !== null);
      const plan = stored.record.recovery.episodes[ordinal]!.prerequisite;
      if (plan === null || plan.nextAction === plan.actions.length) {
        const snapshot = await k.journal.read();
        if (snapshot.fault === null && snapshot.damaged.length === 0) {
          if (plan !== null && !carryReleaseResolved(plan) && await this.restoreDeferredCarry(stored)) { continue; }
          const selected = stored.record.recovery.attempts.at(-1)?.selectedRecord;
          const restored = [...snapshot.events.values()].find(event => event.metadata.logicalOutboxId === selected?.logicalOutboxId && event.metadata.attemptRef?.operationId === operationId);
          const previous = stored.record.recovery.attempts.at(-1)?.journalEvent;
          if (restored !== undefined && (previous?.eventId !== restored.metadata.eventId || previous.journalId !== restored.metadata.journalId
            || previous.sequence !== restored.metadata.sequence)) {
            await k.operations.update(stored, value => bindRecoveryEvent(requireRepair(value), restored.metadata));
          }
          return;
        }
        if (this.damageEpisodeCreated) { throw new RecoveryDamageError('A second recovery damage episode requires a later command start.'); }
        await this.transferDamage(stored, snapshot);
        continue;
      }
      const action = plan.actions[plan.nextAction]!;
      const decision = await this.ordinaryCarryDecision(stored.record, plan);
      if (decision !== null && decision.kind !== 'intact') {
        if (this.damageEpisodeCreated) { throw new RecoveryDamageError('A second recovery payload-loss episode requires a later command start.'); }
        const owner = { operationId, episodeOrdinal: stored.record.recovery.episodes.length, activationId: await k.activationIdentity() };
        await this.publishOrdinaryCarryEpisode(stored, owner, decision);
        continue;
      }
      if (action.kind === 'preserveRecovery' && plan.carryRelease !== null && await k.carryHash() === null) {
        const source = await this.deferredRestorationSource(stored.record, plan);
        if (source === null || source.root !== action.source.root || source.path !== action.source.path || source.sha256 !== action.source.sha256) {
          if (this.damageEpisodeCreated) { throw new RecoveryDamageError('Deferred preservation source changed again during recovery.'); }
          await this.transferDamage(stored, await k.journal.read());
          continue;
        }
      }
      if (action.kind === 'removeCarry' && plan.carryRelease !== null) {
        const observed = await k.carryHash();
        requireControl(observed === null || observed === plan.carry?.sha256);
        const snapshot = observed === null ? null : await k.journal.read();
        if (snapshot !== null && !await this.acceptedRecoveryUsable(stored.record, snapshot)) {
          if ((snapshot.fault !== null || snapshot.damaged.length > 0) && !await this.manifestRepairsFault(plan, snapshot)) {
            if (this.damageEpisodeCreated) { throw new RecoveryDamageError('A second recovery damage episode requires a later command start.'); }
            await this.transferDamage(stored, snapshot);
            continue;
          }
          return;
        }
      }
      try { await executor.execute(action); }
      catch (error) {
        if (!(error instanceof RecoveryDamageError) || this.damageEpisodeCreated) { throw error; }
        const snapshot = await k.journal.read();
        await this.transferDamage(stored, snapshot);
        continue;
      }
      k.journal.invalidate();
      await k.operations.update(stored, value => {
        const record = requireRepair(value);
        return { ...record, recovery: { ...record.recovery, episodes: record.recovery.episodes.map((episode, index) => index === ordinal
          ? { ...episode, phase: episode.phase === 'verifyingHistory' ? 'verifyingHistory' : 'reconstructing', prerequisite: { ...plan, nextAction: plan.nextAction + 1 } } : episode) } };
      });
    }
  }

  private async transferDamage(stored: StoredOperation & { record: RepairOperation }, snapshot: JournalSnapshot): Promise<void> {
    const k = this.kernel;
    this.damageEpisodeCreated = true;
    const activationId = await k.activationIdentity();
    const successor = { operationId: stored.record.operationId, episodeOrdinal: stored.record.recovery.episodes.length, activationId };
    await this.publishDamageEpisode(stored, snapshot, successor);
    await k.safetyStore.activateWitness(successor, this.ownerProof(successor));
  }

  private async publishDamageEpisode(stored: StoredOperation & { record: RepairOperation }, snapshot: JournalSnapshot, successor: RecoveryOwner, deadline?: Deadline): Promise<void> {
    const k = this.kernel;
    const readable = this.readableEvents(snapshot);
    const inventory = await k.operations.list(deadline);
    await k.resources.reserve('repair', { uncompactedEvents: 1, retainedHandoffs: this.handoffGrowth(readable.map(event => event.metadata), inventory) }, deadline);
    const kind = snapshot.fault ?? 'gap';
    const previous = stored.record.recovery.episodes[stored.record.recovery.activeEpisode!]!.prerequisite;
    const pending = previous !== null && (previous.nextAction < previous.actions.length || !carryReleaseResolved(previous));
    const structuralDamage = pending && (snapshot.fault !== null || snapshot.damaged.length > 0) && !await this.manifestRepairsFault(previous, snapshot, deadline);
    const ordinary = pending ? await this.ordinaryCarryDecision(stored.record, previous!, deadline) : null;
    if (ordinary !== null && ordinary.kind !== 'intact' && !structuralDamage) {
      await this.publishOrdinaryCarryEpisode(stored, successor, ordinary, false, false, deadline);
      return;
    }
    const transfer = pending ? structuralDamage
      ? await this.reconstructPrerequisite(previous, { cause: kind, journal: snapshot }, stored.record, deadline, ordinary)
      : await this.rebasePrerequisite(previous, snapshot, stored.record, deadline) : null;
    const prerequisite = transfer?.prerequisite ?? await this.prerequisite({ cause: kind, journal: snapshot }, deadline);
    requireControl(prerequisite !== null);
    const candidate = (() => {
      const repair = stored.record;
      const handoffs = [...repair.plan.handoffs];
      for (const event of readable) {
        const index = handoffs.findIndex(item => item.logicalOutboxId === event.metadata.logicalOutboxId);
        if (index < 0) { handoffs.push(handoffFor(event.metadata)); }
        else { handoffs[index] = mergeHandoff(handoffs[index]!, handoffFor(event.metadata)); }
      }
      if (transfer?.replacement?.handoff !== undefined) {
        const handoff = transfer.replacement.handoff;
        const index = handoffs.findIndex(value => value.logicalOutboxId === handoff.logicalOutboxId);
        if (index < 0) { handoffs.push(handoff); } else { handoffs[index] = mergeHandoff(handoffs[index]!, handoff); }
      }
      const skippedRanges = [...repair.plan.skippedRanges, ...prerequisite.skippedRanges.filter(range => !repair.plan.skippedRanges.some(old => old.journalId === range.journalId && old.firstSequence === range.firstSequence && old.lastSequence === range.lastSequence))];
      const floorCandidate = prerequisite.kind === 'header' ? 0 : prerequisite.kind === 'cursor' && snapshot.header.status === 'valid' ? snapshot.header.value.highWaterSequence
        : pending ? repair.plan.lastGoodSequence : (snapshot.firstBadSequence ?? repair.plan.lastGoodSequence + 1) - 1;
      const lastGoodSequence = Math.min(floorCandidate, recoveryHighWaterCeiling(prerequisite, snapshot));
      const moved = transferEpisode({ ...repair, plan: { ...repair.plan, handoffs, skippedRanges, lastGoodSequence } }, { activationId: successor.activationId, trigger: kind,
        attemptAtStart: currentAttemptOrdinal(repair), replacementAttempt: null, prerequisite, acceptedRecovery: null, startedAt: utcNow() }, utcNow());
      if (transfer?.replacement == null) { return moved; }
      const selected = repair.recovery.attempts.at(-1)!.selectedRecord;
      requireControl(selected !== null && selected.logicalOutboxId === transfer.replacement.logicalOutboxId && selected.recordSha256 === transfer.replacement.recordSha256);
      return replacementCandidate(moved, transfer.replacement.reason ?? 'placementUnavailable', transfer.replacement.deferred ?? false);
    })();
    await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', candidate.operationId + '.json'),
      Buffer.from(stringifyProspectiveJson(candidate, 'state-event', 'operations/' + candidate.operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event', deadline);
    await k.safetyStore.prepareTransfer(successor, deadline);
    await k.operations.update(stored, () => candidate, deadline);
  }

  private async reconstructPrerequisite(previous: RecoveryPrerequisite, request: RepairRequest, record: RepairOperation, deadline?: Deadline,
    ordinary?: OrdinaryCarryDecision | null): Promise<PrerequisiteTransfer> {
    const k = this.kernel;
    const snapshot = request.journal;
    const structural = await this.prerequisite(request, deadline, false);
    requireControl(structural !== null);
    const kind = structural.kind;
    const pending = previous.actions.slice(previous.nextAction);
    const completed: RecoveryAction[] = [];
    const quarantines = new Map<string, Extract<RecoveryAction, { kind: 'quarantine' }>>();
    const missingPreservation = ordinary !== null && ordinary !== undefined && ordinary.kind !== 'intact'
      ? previous.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === previous.carry?.sha256) : undefined;
    for (const action of pending) {
      if (action.kind !== 'quarantine') { continue; }
      const sourceHash = await this.fileHash(action.source.path, deadline);
      const targetHash = await this.fileHash(action.target.path, deadline);
      const observations = new Map<string, ManifestObservation>([[action.source.path, { status: 'readable', sha256: sourceHash }],
        [action.target.path, { status: 'readable', sha256: targetHash }]]);
      const condition = recognizeAction(action, observations);
      if (condition === 'damage' && missingPreservation?.kind === 'preserveRecovery' && action.source.path === missingPreservation.source.path) {
        requireControl(targetHash === null && (sourceHash === null && ordinary?.originalSource?.status === 'absent'
          || sourceHash !== null && ordinary?.originalSource?.status === 'invalid' && ordinary.originalSource.sha256 === sourceHash));
        if (sourceHash !== null) {
          quarantines.set(action.source.path, { ...action, source: { ...action.source, before: sourceHash }, target: { ...action.target, after: sourceHash } });
        }
        continue;
      }
      requireControl(condition === 'before' || condition === 'after');
      if (condition === 'after') { completed.push(action); }
      else { requireControl(!quarantines.has(action.source.path)); quarantines.set(action.source.path, action); }
    }
    const structuralActions = structural.actions.map(action => {
      if (action.kind !== 'quarantine') { return action; }
      const retained = quarantines.get(action.source.path);
      if (retained === undefined) { return action; }
      requireControl(retained.source.before === action.source.before);
      quarantines.delete(action.source.path);
      return retained;
    });
    if (previous.carry === null) {
      requireControl(!pending.some(action => action.kind === 'appendRecovery' || action.kind === 'preserveRecovery' || action.kind === 'removeCarry'));
      return { prerequisite: validatePrerequisite({ ...structural, actions: [...completed, ...quarantines.values(), ...structuralActions], nextAction: completed.length,
        skippedRanges: mergeRanges(previous.skippedRanges, structural.skippedRanges) }), replacement: null };
    }
    if (ordinary?.kind === 'lost') {
      const selected = record.recovery.attempts[currentAttemptOrdinal(record)]!.selectedRecord;
      requireControl(selected !== null && selected.recordSha256 !== null && ordinary.appendIndex >= previous.nextAction);
      const slotCleanup = ordinary.slotInvalidSha256 === undefined || ordinary.recordedSlotCleanup ? [] : [quarantineCarry(ordinary.slotInvalidSha256)];
      return { prerequisite: validatePrerequisite({ ...structural, actions: [...completed, ...slotCleanup, ...quarantines.values(), ...structuralActions],
        nextAction: completed.length, skippedRanges: mergeRanges(previous.skippedRanges, structural.skippedRanges) }),
      replacement: { logicalOutboxId: selected.logicalOutboxId, recordSha256: selected.recordSha256, reason: 'missingPayload' } };
    }
    const preservation = previous.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === previous.carry!.sha256);
    requireControl(preservation?.kind === 'preserveRecovery');
    const binding = preservation.source.payloadBindingSha256;
    const carrySource: PayloadSource = { root: 'scope', path: previous.carry.path, sha256: previous.carry.sha256, payloadBindingSha256: binding };
    const recordedCleanup = quarantines.get(carrySource.path);
    requireControl(recordedCleanup === undefined || ordinary !== null && ordinary !== undefined && recordedCleanup === previous.actions[previous.nextAction]);
    if (recordedCleanup !== undefined) { quarantines.delete(carrySource.path); }
    for (const action of pending) {
      if (action.kind === 'appendRecovery') { requireControl(action.source.root === 'scope' && action.source.path === carrySource.path && action.source.sha256 === carrySource.sha256 && action.source.payloadBindingSha256 === binding); }
      if (action.kind === 'preserveRecovery') { requireControl(action.target.after === carrySource.sha256); }
      if (action.kind === 'removeCarry') { requireControl(action.target.before === carrySource.sha256); }
    }
    const carryHash = await this.fileHash(carrySource.path, deadline);
    requireControl(carryHash === null || carryHash === carrySource.sha256 || carryHash === recordedCleanup?.source.before
      || ordinary?.kind === 'restore' && carryHash === ordinary.slotInvalidSha256);
    if (previous.carryRelease !== null && !carryReleaseResolved(previous)) {
      const historical = record.recovery.episodes.flatMap(episode => episode.prerequisite?.actions.slice(0, episode.prerequisite.nextAction) ?? [])
        .find(action => action.kind === 'preserveRecovery' && action.target.after === carrySource.sha256);
      requireControl(historical?.kind === 'preserveRecovery');
      const source = carryHash === null ? await this.deferredRestorationSource(record, previous, deadline) : null;
      if (source === null) { completed.push(historical); }
      const restore: RecoveryAction[] = [];
      if (source !== null) {
        restore.push((await this.prepareCarryPreservation(previous, source, deadline)).action);
      }
      return { replacement: null, prerequisite: validatePrerequisite({ kind, carry: previous.carry, carryRelease: previous.carryRelease, nextAction: completed.length,
        skippedRanges: mergeRanges(previous.skippedRanges, structural.skippedRanges),
        actions: [...completed, ...restore, ...quarantines.values(), ...structuralActions, ...pending.filter(action => action.kind === 'removeCarry')] }) };
    }
    let bytes: Buffer;
    let selectedSource: PayloadSource = carrySource;
    const prepare: RecoveryAction[] = [];
    if (carryHash !== null) {
      if (carryHash === carrySource.sha256) {
        bytes = await this.readRecoverySource(carrySource, deadline);
        completed.push(preservation);
      } else {
        requireControl(ordinary?.kind === 'restore' && ordinary.source !== undefined || recordedCleanup !== undefined);
        selectedSource = ordinary?.kind === 'restore' ? ordinary.source! : preservation.source;
        const prepared = await this.prepareCarryPreservation(previous, selectedSource, deadline);
        bytes = prepared.bytes;
        prepare.push(recordedCleanup ?? quarantineCarry(carryHash), prepared.action);
      }
    } else {
      // An admitted exact source can recreate the absent slot. A missing or
      // contradictory source retains the obligation without writes.
      selectedSource = ordinary?.kind === 'restore' ? ordinary.source! : preservation.source;
      const prepared = await this.prepareCarryPreservation(previous, selectedSource, deadline);
      bytes = prepared.bytes;
      prepare.push(prepared.action);
    }
    const headerAction = structuralActions.find(action => action.kind === 'publishHeader');
    const header = kind === 'header' && headerAction?.kind === 'publishHeader' ? headerAction.value : snapshot.header.status === 'valid' ? snapshot.header.value : null;
    requireControl(header !== null);
    const sequence = header.highWaterSequence + 1;
    const destination = `journal/events/${eventFileName(sequence)}`;
    const oldCopies = this.readableEvents(snapshot).filter(event => event.metadata.logicalOutboxId === preservation.metadata.logicalOutboxId);
    requireControl(oldCopies.length <= 1 && (kind === 'header' || !this.readableEvents(snapshot).some(event => event.metadata.sequence >= sequence && event.metadata.logicalOutboxId !== preservation.metadata.logicalOutboxId)));
    if (kind === 'cursor') {
      const priorAppend = [...previous.actions].reverse().find(action => action.kind === 'appendRecovery' && action.metadata.journalId === header.journalId && action.source.sha256 === carrySource.sha256);
      const originalPosition = oldCopies[0]?.metadata.sequence ?? (priorAppend?.kind === 'appendRecovery' ? priorAppend.metadata.sequence : null);
      const placementAvailable = this.readableEvents(snapshot).every(event => event.metadata.logicalOutboxId === preservation.metadata.logicalOutboxId
        || originalPosition !== null && event.metadata.sequence < originalPosition);
      if (!placementAvailable) {
        const old = oldCopies[0];
        if (old === undefined) {
          requireControl(carryHash !== null);
          const handoff = handoffFor({ ...preservation.metadata, payloadBindingSha256: binding, targetIdentitySha256: null, stateGeneratedAt: null });
          return { replacement: { logicalOutboxId: preservation.metadata.logicalOutboxId, recordSha256: preservation.metadata.recordSha256, deferred: true, handoff },
            prerequisite: validatePrerequisite({ kind, carry: previous.carry, carryRelease: previous.carryRelease, nextAction: completed.length,
              skippedRanges: mergeRanges(previous.skippedRanges, structural.skippedRanges), actions: [...completed, ...quarantines.values(), ...structuralActions] }) };
        }
        requireControl(old !== undefined && old.metadata.journalId === header.journalId && old.metadata.sequence <= header.highWaterSequence
          && old.metadata.recordSha256 === preservation.metadata.recordSha256 && old.metadata.payloadBindingSha256 === binding && carryHash !== null);
        const oldPath = `journal/events/${eventFileName(old.metadata.sequence)}`;
        requireControl(await this.fileHash(oldPath, deadline) === old.sha256
          && ![...quarantines.values(), ...structuralActions].some(action => action.kind === 'quarantine' && action.source.path === oldPath));
        const currentHeaderHash = snapshot.header.status === 'valid' ? snapshot.header.sha256 : null;
        requireControl(currentHeaderHash !== null);
        completed.push({ kind: 'appendRecovery', target: { path: oldPath, before: null, after: old.sha256 }, source: carrySource, metadata: eventRewriteMetadata(old.metadata) },
          { kind: 'raiseHighWater', target: { path: headerPath, before: currentHeaderHash, after: currentHeaderHash }, value: header });
        return { replacement: { logicalOutboxId: old.metadata.logicalOutboxId, recordSha256: old.metadata.recordSha256 }, prerequisite: validatePrerequisite({ kind,
          carry: previous.carry, carryRelease: previous.carryRelease, nextAction: completed.length, skippedRanges: mergeRanges(previous.skippedRanges, structural.skippedRanges),
          actions: [...completed, ...quarantines.values(), ...structuralActions, { kind: 'removeCarry', target: { path: carrySource.path, before: carrySource.sha256, after: null } }] }) };
      }
    }
    for (const old of oldCopies) {
      requireControl(old.metadata.recordSha256 === preservation.metadata.recordSha256 && old.metadata.payloadBindingSha256 === binding);
      const sourcePath = `journal/events/${eventFileName(old.metadata.sequence)}`;
      if (![...quarantines.values(), ...structuralActions].some(action => action.kind === 'quarantine' && action.source.path === sourcePath)) {
        const removal: RecoveryAction[] = [];
        await this.quarantineAction(sourcePath, removal, deadline);
        requireControl(removal.length === 1 && removal[0]!.kind === 'quarantine' && removal[0]!.source.before === old.sha256);
        structuralActions.unshift(removal[0]!);
      }
    }
    const currentTarget = await this.fileHash(destination, deadline);
    requireControl(currentTarget === null || [...quarantines.values(), ...structuralActions].some(action => action.kind === 'quarantine' && action.source.path === destination && action.source.before === currentTarget));
    const metadata = { ...preservation.metadata, journalId: header.journalId, eventId: await k.eventIdentity(snapshot, deadline), sequence, acknowledgedAt: null };
    const selectedOutboxSequence = selectedSource.root === 'companion' ? outboxRecordSequence(path.basename(selectedSource.path)) : null;
    requireControl(selectedSource.root !== 'companion' || selectedOutboxSequence !== null
      && selectedOutboxSequence === logicalOutboxSequence(metadata.logicalOutboxId));
    const preview = await k.codec.previewEvent(destination, bytes, metadata, selectedSource.root === 'companion' ? 'outbox' : 'event', binding,
      selectedOutboxSequence ?? 0, deadline);
    requireControl(preview.cleanupComplete);
    const raised = { ...header, highWaterSequence: sequence };
    const beforeHeader = kind === 'header' ? hashValue(header) : snapshot.header.status === 'valid' ? snapshot.header.sha256 : null;
    requireControl(beforeHeader !== null);
    return { replacement: null, prerequisite: validatePrerequisite({ kind, carry: previous.carry, carryRelease: previous.carryRelease, nextAction: completed.length, skippedRanges: mergeRanges(previous.skippedRanges, structural.skippedRanges),
      actions: [...completed, ...prepare, ...quarantines.values(), ...structuralActions,
        { kind: 'appendRecovery', target: { path: destination, before: null, after: preview.sha256 }, source: carrySource, metadata },
        { kind: 'raiseHighWater', target: { path: headerPath, before: beforeHeader, after: hashValue(raised) }, value: raised },
        { kind: 'removeCarry', target: { path: carrySource.path, before: carrySource.sha256, after: null } }] }) };
  }

  private async rebasePrerequisite(previous: RecoveryPrerequisite, snapshot: JournalSnapshot, record: RepairOperation, deadline?: Deadline): Promise<PrerequisiteTransfer> {
    const firstPreservation = previous.actions[previous.nextAction];
    if (previous.carryRelease !== null && firstPreservation?.kind === 'preserveRecovery' && await this.fileHash(firstPreservation.target.path, deadline) === null) {
      const source = await this.deferredRestorationSource(record, previous, deadline);
      if (source === null) {
        const historical = record.recovery.episodes.flatMap(episode => episode.prerequisite?.actions.slice(0, episode.prerequisite.nextAction) ?? [])
          .find(action => action.kind === 'preserveRecovery' && action.target.after === previous.carry?.sha256);
        requireControl(historical?.kind === 'preserveRecovery');
        return { replacement: null, prerequisite: validatePrerequisite({ ...previous, nextAction: 1,
          actions: [historical, ...previous.actions.slice(previous.nextAction + 1)] }) };
      }
      if (source.root !== firstPreservation.source.root || source.path !== firstPreservation.source.path || source.sha256 !== firstPreservation.source.sha256) {
        const prepared = await this.prepareCarryPreservation(previous, source, deadline);
        return { replacement: null, prerequisite: validatePrerequisite({ ...previous, nextAction: 0,
          actions: [prepared.action, ...previous.actions.slice(previous.nextAction + 1)] }) };
      }
    }
    const actions = [...previous.actions.slice(previous.nextAction)];
    let firstPending = previous.nextAction;
    while (actions.length > 0) {
      const first = actions[0]!;
      const changes = first.kind === 'quarantine' ? [first.source, first.target] : [first.target];
      const observations = new Map<string, ManifestObservation>();
      for (const change of changes) { observations.set(change.path, { status: 'readable', sha256: await this.fileHash(change.path, deadline) }); }
      const condition = recognizeAction(first, observations);
      if (condition === 'after') { actions.shift(); firstPending++; continue; }
      if (condition === 'before') { break; }
      requireControl(first.kind === 'publishHeader' || first.kind === 'publishCursor' || first.kind === 'raiseHighWater');
      const observed = observations.get(first.target.path)!;
      requireControl(observed.status === 'readable');
      if (observed.sha256 === null) { return this.reconstructPrerequisite(previous, { cause: first.kind === 'publishCursor' ? 'cursor' : 'header', journal: snapshot }, record, deadline); }
      actions[0] = { ...first, target: { ...first.target, before: observed.sha256 } };
      break;
    }
    const carriedHash = await this.fileHash('journal/recovery-event.json', deadline);
    const removal = carryReleaseRemovalIndex(previous);
    if (previous.carryRelease !== null && removal >= 0 && firstPending > removal) {
      requireControl(this.hasCarryRemovalAuthorization(record, previous));
      return { replacement: null, prerequisite: validatePrerequisite({ ...previous, nextAction: firstPending }) };
    }
    if (previous.carryRelease !== null && carriedHash === null && actions.length === 0) {
      const source = await this.deferredRestorationSource(record, previous, deadline);
      if (source !== null) {
        const prepared = await this.prepareCarryPreservation(previous, source, deadline);
        return { replacement: null, prerequisite: validatePrerequisite({ ...previous, nextAction: 0, actions: [prepared.action] }) };
      }
      return { replacement: null, prerequisite: validatePrerequisite({ ...previous, actions: previous.actions, nextAction: firstPending }) };
    }
    let nextAction = 0;
    if (carriedHash !== null) {
      const completed: RecoveryAction[] = [];
      requireControl(previous.carry?.sha256 === carriedHash);
      const preservation = previous.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === carriedHash);
      requireControl(preservation !== undefined);
      completed.push(preservation);
      if (previous.carryRelease === null && !actions.some(action => action.kind === 'appendRecovery' && action.source.path === 'journal/recovery-event.json')) {
        const restored = previous.actions.findIndex(action => action.kind === 'appendRecovery' && action.source.path === 'journal/recovery-event.json' && action.source.sha256 === carriedHash);
        requireControl(restored >= 0);
        const append = previous.actions[restored]!;
        requireControl(append.kind === 'appendRecovery' && await this.fileHash(append.target.path, deadline) === append.target.after);
        completed.push(append);
        const headers = new Map<string, Extract<RecoveryAction, { kind: 'publishHeader' | 'raiseHighWater' }>>();
        for (const action of previous.actions.slice(restored + 1, firstPending)) {
          if (action.kind === 'raiseHighWater' || action.kind === 'publishHeader') { headers.set(action.target.path, action); }
        }
        for (const action of headers.values()) {
          // A retained write carries the header obligation through its own
          // admitted preimage. Otherwise keep its verified completed proof.
          if (!actions.some(pending => (pending.kind === 'raiseHighWater' || pending.kind === 'publishHeader') && pending.target.path === action.target.path)) {
            requireControl(await this.fileHash(action.target.path, deadline) === action.target.after);
            completed.push(action);
          }
        }
      }
      // Completed preservation stays explicit authority while the executable
      // suffix retains restoration and removal, including a lost progress write.
      actions.unshift(...completed);
      nextAction = completed.length;
    }
    const projected = new Map<string, string | null>();
    for (const action of actions.slice(nextAction)) {
      if (action.kind === 'preserveRecovery' || action.kind === 'appendRecovery') {
        const source = action.source;
        const outbox = source.root === 'companion' ? await this.kernel.outbox.read(path.basename(source.path), deadline) : null;
        const expected = source.root === 'scope' && projected.has(source.path) ? projected.get(source.path)
          : source.root === 'scope' ? await this.fileHash(source.path, deadline) : outbox?.status === 'valid' ? outbox.sha256 : null;
        requireControl(expected === source.sha256);
      }
      for (const change of action.kind === 'quarantine' ? [action.source, action.target] : [action.target]) {
        const expected = projected.has(change.path) ? projected.get(change.path) : await this.fileHash(change.path, deadline);
        requireControl(expected === change.before);
        projected.set(change.path, change.after);
      }
    }
    requireControl(carriedHash === null || previous.carryRelease !== null || actions.slice(nextAction).some(action => action.kind === 'removeCarry' && action.target.before === carriedHash));
    return { replacement: null, prerequisite: validatePrerequisite({ ...previous, actions, nextAction, carry: actions.some(action => action.kind === 'preserveRecovery' || action.kind === 'removeCarry'
      || action.kind === 'appendRecovery' && action.source.path === 'journal/recovery-event.json') ? previous.carry : null }) };
  }

  resume(operationId: string): Promise<void> {
    return this.kernel.resources.withTransition('repair', () => this.resumeOwned(operationId));
  }

  private async resumeOwned(operationId: string): Promise<void> {
    requireControl(!this.running);
    this.running = true;
    const k = this.kernel;
    const original = await this.stored(operationId);
    if (original.record.cause === 'capacity') { this.selectedCapacityRoot = operationId; this.capacitySource = k.resources.currentSource(); }
    k.emit({ journal: { ...k.status.journal, state: 'repairing', fault: null } });
    try {
      await k.resources.reserve('repair');
      await this.runPrerequisite(operationId);
      await this.quarantineLostOperations(operationId);
      let stored = await this.stored(operationId);
      let record = stored.record;
      const currentEpisode = record.recovery.episodes[record.recovery.activeEpisode!]!;
      if (currentEpisode.phase === 'recordRejected') {
        await k.operations.update(stored, value => replayCandidate(requireRepair(value), currentEpisode.activationId, utcNow()));
        stored = await this.stored(operationId); record = stored.record;
      }
      let ordinal = currentAttemptOrdinal(record);
      const episode = record.recovery.episodes[record.recovery.activeEpisode!]!;
      if (episode.phase === 'verifyingHistory' && (episode.prerequisite === null || carryReleaseResolved(episode.prerequisite)) && await this.acceptedRecoveryUsable(record)) { await this.finalize(operationId); return; }
      if (record.recovery.attempts[ordinal]!.publication !== 'observed') {
        await k.safetyStore.invalidate('contextUncertain');
        await this.bindCorrection(operationId);
        record = await this.prepareReplayPublication(operationId);
        ordinal = currentAttemptOrdinal(record);
        let replacementPlanned = false;
        const result = await k.publish(false, record, Deadline.after(3600000), async result => {
          if (!result.success) { return; }
          requireControl(result.value.kind === 'resync' && result.value.logicalOutboxId !== null && result.value.sequence !== null);
          const source = await k.outbox.read(`event-${String(result.value.sequence).padStart(16, '0')}.json`);
          const publicationJournal = await k.journal.read();
          const matchingEvents = [...publicationJournal.events.values()].filter(entry => entry.metadata.logicalOutboxId === result.value.logicalOutboxId);
          requireControl(matchingEvents.length <= 1);
          const retainedEvent = matchingEvents[0];
          requireControl(source.status !== 'invalid');
          if (source.status === 'valid') {
            requireControl(source.metadata.logicalOutboxId === result.value.logicalOutboxId && source.metadata.sequence === result.value.sequence
              && source.metadata.kind === 'resync' && source.metadata.repairOperationId === coreAttemptToken(operationId, ordinal)
              && source.metadata.game === k.scope.game && source.metadata.principal === k.scope.principal);
          }
          if (retainedEvent !== undefined) {
            requireControl(retainedEvent.metadata.coreRepairOperationId === coreAttemptToken(operationId, ordinal) && retainedEvent.metadata.type === 'state.resync'
              && retainedEvent.metadata.attemptRef?.operationId === operationId && retainedEvent.metadata.attemptRef.attemptOrdinal === ordinal
              && retainedEvent.metadata.adapter === k.scope.game && retainedEvent.metadata.principal === k.scope.principal);
          }
          requireControl(source.status !== 'valid' || retainedEvent === undefined || source.sha256 === retainedEvent.metadata.recordSha256
            && source.metadata.schemaVersion === retainedEvent.metadata.schemaVersion && source.metadata.adapterVersion === retainedEvent.metadata.adapterVersion);
          const current = await this.stored(operationId);
          const previous = current.record.recovery.attempts[ordinal]!.selectedRecord;
          const activePlan = current.record.recovery.episodes[current.record.recovery.activeEpisode!]!.prerequisite;
          const preservedCarry = activePlan?.carry === null || activePlan === null ? undefined : activePlan.actions.find(
            (action): action is RecoveryAction & { kind: 'preserveRecovery' } => action.kind === 'preserveRecovery'
              && action.target.after === activePlan.carry!.sha256 && action.metadata.logicalOutboxId === result.value.logicalOutboxId);
          if (preservedCarry !== undefined) {
            requireControl(preservedCarry.metadata.type === 'state.resync'
              && preservedCarry.metadata.coreRepairOperationId === coreAttemptToken(operationId, ordinal)
              && preservedCarry.metadata.attemptRef?.operationId === operationId && preservedCarry.metadata.attemptRef.attemptOrdinal === ordinal);
            const removal = carryReleaseRemovalIndex(activePlan!);
            if (removal >= 0 && removal < activePlan!.nextAction) {
              requireControl(await k.carryHash() === null);
              if (activePlan!.carryRelease === null) {
                const restoration = activePlan!.actions.findIndex(action => action.kind === 'appendRecovery'
                  && action.source.root === 'scope' && action.source.path === activePlan!.carry!.path && action.source.sha256 === activePlan!.carry!.sha256
                  && action.metadata.logicalOutboxId === result.value.logicalOutboxId);
                const restored = activePlan!.actions[restoration];
                requireControl(restoration >= 0 && restoration < removal && restored?.kind === 'appendRecovery' && retainedEvent !== undefined
                  && restored.target.path === `journal/events/${eventFileName(retainedEvent.metadata.sequence)}`
                  && restored.metadata.type === 'state.resync' && restored.metadata.journalId === retainedEvent.metadata.journalId
                  && restored.metadata.eventId === retainedEvent.metadata.eventId && restored.metadata.sequence === retainedEvent.metadata.sequence
                  && restored.metadata.recordSha256 === retainedEvent.metadata.recordSha256
                  && restored.metadata.schemaVersion === retainedEvent.metadata.schemaVersion && restored.metadata.adapterVersion === retainedEvent.metadata.adapterVersion
                  && restored.source.payloadBindingSha256 === retainedEvent.metadata.payloadBindingSha256
                  && restored.metadata.coreRepairOperationId === retainedEvent.metadata.coreRepairOperationId
                  && restored.metadata.attemptRef?.operationId === retainedEvent.metadata.attemptRef?.operationId
                  && restored.metadata.attemptRef?.attemptOrdinal === retainedEvent.metadata.attemptRef?.attemptOrdinal);
              }
            } else { requireControl(await k.carryHash() === activePlan!.carry!.sha256); }
          }
          const deferred = result.value.warnings.some(warning => warning.code === 'outbox-quarantine-deferred');
          const sourceVersionMismatch = source.status === 'valid' && (source.metadata.schemaVersion !== result.value.schemaVersion || source.metadata.adapterVersion !== result.value.adapterVersion);
          const eventVersionMismatch = retainedEvent !== undefined && (retainedEvent.metadata.schemaVersion !== result.value.schemaVersion || retainedEvent.metadata.adapterVersion !== result.value.adapterVersion);
          const carryVersionMismatch = preservedCarry !== undefined && (preservedCarry.metadata.schemaVersion !== result.value.schemaVersion
            || preservedCarry.metadata.adapterVersion !== result.value.adapterVersion);
          if (sourceVersionMismatch || eventVersionMismatch || carryVersionMismatch) {
            requireControl(result.value.outcome === 'replayed' && previous?.logicalOutboxId === result.value.logicalOutboxId && previous.recordSha256 !== null
              && (source.status !== 'valid' || source.sha256 === previous.recordSha256)
              && (retainedEvent === undefined || retainedEvent.metadata.recordSha256 === previous.recordSha256)
              && (preservedCarry === undefined || preservedCarry.metadata.recordSha256 === previous.recordSha256));
            if (!deferred) {
              const priorBindings = current.record.plan.handoffs.filter(item => item.logicalOutboxId === previous.logicalOutboxId);
              requireControl(priorBindings.length <= 1 && priorBindings.every(item => item.recordSha256 === previous.recordSha256));
              const preserved = priorBindings[0];
              const sourceHandoff = retainedEvent === undefined ? null : handoffFor(retainedEvent.metadata);
              const handoff = preserved === undefined ? sourceHandoff : sourceHandoff === null ? preserved : mergeHandoff(preserved, sourceHandoff);
              if (handoff === null) { throw new SafetyUnavailableError('Incompatible replay lacks its original settlement binding.'); }
              const oldHandoff = { ...handoff, presentation: 'rejected' as const };
              const handoffs = preserved === undefined ? [...current.record.plan.handoffs, oldHandoff]
                : current.record.plan.handoffs.map(item => item.logicalOutboxId === previous.logicalOutboxId ? oldHandoff : item);
              let prerequisite = current.record.recovery.episodes[current.record.recovery.activeEpisode!]!.prerequisite;
              let floor = current.record.plan.lastGoodSequence;
              let suffixInventory: OperationInventory | null = null;
              if (retainedEvent !== undefined) {
                requireControl(publicationJournal.header.status === 'valid' && publicationJournal.cursor.status === 'valid'
                  && publicationJournal.fault === null && publicationJournal.damaged.length === 0);
                if (retainedEvent.metadata.sequence > publicationJournal.cursor.value.lastAckedSequence) {
                  requireControl(prerequisite === null || prerequisite.nextAction === prerequisite.actions.length && carryReleaseResolved(prerequisite));
                  if (prerequisite !== null && prerequisite.carry !== null && await k.carryHash() !== null) {
                    throw new SafetyUnavailableError('Incompatible replay retains a protected recovery carry.');
                  }
                  const acked = publicationJournal.cursor.value.lastAckedSequence;
                  const suffix = [...publicationJournal.events.values()].filter(event => event.metadata.sequence > acked)
                    .sort((left, right) => left.metadata.sequence - right.metadata.sequence);
                  requireControl(suffix.length === publicationJournal.header.value.highWaterSequence - acked
                    && suffix.every((event, index) => event.metadata.sequence === acked + index + 1)
                    && suffix.some(event => event.metadata.eventId === retainedEvent.metadata.eventId));
                  const rewind = await this.prerequisite({ cause: 'versionChange', journal: publicationJournal }, undefined, false);
                  requireControl(rewind !== null && rewind.kind === 'rewind');
                  const quarantines = rewind.actions.filter((action): action is RecoveryAction & { kind: 'quarantine' } => action.kind === 'quarantine');
                  requireControl(quarantines.length === suffix.length && suffix.every(event => quarantines.some(action =>
                    action.source.path === `journal/events/${eventFileName(event.metadata.sequence)}` && action.source.before === event.sha256)));
                  const inventory = await k.operations.list();
                  if (inventory.invalid.length > 0) { throw new SafetyUnavailableError('Suffix handoff authority is unavailable.'); }
                  suffixInventory = inventory;
                  const admitted = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair' ? entry.record.plan.handoffs : []);
                  for (const event of suffix) {
                    const old = handoffs.findIndex(item => item.logicalOutboxId === event.metadata.logicalOutboxId);
                    requireControl(handoffs.filter(item => item.logicalOutboxId === event.metadata.logicalOutboxId).length <= 1
                      && (old < 0 || handoffs[old]!.recordSha256 === event.metadata.recordSha256));
                    const retired = event.metadata.schemaVersion !== result.value.schemaVersion || event.metadata.adapterVersion !== result.value.adapterVersion;
                    let observed = handoffFor(event.metadata, retired ? 'rejected' : 'replayable');
                    for (const historical of admitted.filter(item => item.logicalOutboxId === event.metadata.logicalOutboxId)) {
                      requireControl(historical.recordSha256 === event.metadata.recordSha256);
                      observed = mergeHandoff(historical, observed);
                    }
                    if (old < 0) { handoffs.push(observed); }
                    else { handoffs[old] = mergeHandoff(handoffs[old]!, observed); }
                  }
                  prerequisite = rewind;
                  floor = Math.min(floor, acked);
                }
              }
              const priorRetired = current.record.plan.retiredRecords.filter(item => item.logicalOutboxId === previous.logicalOutboxId
                || source.status === 'valid' && item.name === source.name);
              requireControl(source.status !== 'valid' || priorRetired.every(item => item.logicalOutboxId === previous.logicalOutboxId
                && item.name === source.name && item.recordSha256 === previous.recordSha256));
              const retiredRecords = source.status === 'valid' && priorRetired.length === 0
                ? [...current.record.plan.retiredRecords, { name: source.name, logicalOutboxId: previous.logicalOutboxId, recordSha256: previous.recordSha256 }]
                : current.record.plan.retiredRecords;
              const retained = { ...current.record, plan: { ...current.record.plan, handoffs, retiredRecords, lastGoodSequence: floor,
                cursorTo: current.record.plan.cursorTo === null ? null : Math.min(current.record.plan.cursorTo, floor) },
                recovery: { ...current.record.recovery, episodes: current.record.recovery.episodes.map((episode, index) => index === current.record.recovery.activeEpisode
                  ? { ...episode, prerequisite, phase: prerequisite === null ? episode.phase : 'reconstructing' as const } : episode) } };
              const observed = selectRecoveryRecord(retained, previous, 'observed', null);
              const versioned = { ...observed, plan: { ...observed.plan, publishedVersions: { schemaVersion: result.value.schemaVersion, adapterVersion: result.value.adapterVersion } } };
              const captured = await this.captureRetiredAtReceipt(versioned, result.value);
              const candidate = replacementCandidate(captured, 'acceptanceUnavailable');
              await k.resources.reserve('repair', { uncompactedEvents: 1, retainedHandoffs: this.handoffGrowth(handoffs, suffixInventory ?? await k.operations.list()) });
              await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', operationId + '.json'),
                Buffer.from(stringifyProspectiveJson(candidate, 'state-event', 'operations/' + operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event');
              await k.operations.update(current, () => candidate);
              replacementPlanned = true;
              return;
            }
          }
          const replayedWithoutSource = result.value.outcome === 'replayed' && source.status === 'absent' && retainedEvent === undefined
            && hasUnreplacedSelection(current.record) && previous?.logicalOutboxId === result.value.logicalOutboxId;
          const selectedIdentity = { logicalOutboxId: result.value.logicalOutboxId,
            recordSha256: source.status === 'valid' ? source.sha256 : retainedEvent?.metadata.recordSha256 ?? (replayedWithoutSource ? previous!.recordSha256 : null) };
          if (deferred && previous !== null && previous.logicalOutboxId !== selectedIdentity.logicalOutboxId) {
            await k.operations.update(current, value => selectRecoveryRecord(requireRepair(value), previous, 'deferred', null));
            return;
          }
          const captured = deferred ? current.record : await this.captureRetiredAtReceipt(current.record, result.value);
          const priorBindings = previous === null ? [] : captured.plan.handoffs.filter(item => item.logicalOutboxId === previous.logicalOutboxId);
          requireControl(previous === null || priorBindings.length <= 1 && priorBindings.every(item => item.recordSha256 === previous.recordSha256));
          const displaced = previous === null || previous.logicalOutboxId === selectedIdentity.logicalOutboxId ? null
            : priorBindings[0] ?? await this.displacedDeferredHandoff(captured, ordinal, result.value);
          requireControl(displaced === null || displaced.coreRepairOperationId === coreAttemptToken(operationId, ordinal)
            && (displaced.attemptRef === null || displaced.attemptRef.operationId === operationId && displaced.attemptRef.attemptOrdinal === ordinal));
          const selected = selectRecoveryRecord(captured, selectedIdentity, deferred ? 'deferred' : 'observed', displaced);
          const versioned = { ...selected, plan: { ...selected.plan, publishedVersions: { schemaVersion: result.value.schemaVersion, adapterVersion: result.value.adapterVersion } } };
          if (displaced !== null && !captured.plan.handoffs.some(item => item.logicalOutboxId === displaced.logicalOutboxId)) {
            await k.resources.reserve('repair', { retainedHandoffs: 1 });
          }
          await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', operationId + '.json'),
            Buffer.from(stringifyProspectiveJson(versioned, 'state-event', 'operations/' + operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event');
          await k.operations.update(current, () => versioned);
        });
        if (!result.success) {
          if (result.reason.startsWith('consumer-')) { k.emit({ consumer: 'notOwner' }); }
          throw new SafetyUnavailableError('Recovery publication did not complete.');
        }
        if (result.value.warnings.some(warning => warning.code === 'outbox-quarantine-deferred')) { throw new SafetyUnavailableError('Core quarantine remains deferred.'); }
        if (replacementPlanned) { this.running = false; await this.resume(operationId); return; }
      }
      for (let pass = 0; pass < 17; pass++) {
        await this.runPrerequisite(operationId);
        if (await this.reconcileObservedPublication(operationId)) { return; }
        // Startup/operator recovery is independent of a player interaction's
        // 120-second gate. CoreClient still caps each settlement at 120 seconds.
        const gate = Deadline.after(3600000);
        await k.drain(gate, operationId);
        stored = await this.stored(operationId);
        const active = stored.record.recovery.episodes[stored.record.recovery.activeEpisode!]!;
        if (active.prerequisite !== null && active.prerequisite.nextAction < active.prerequisite.actions.length
          && !(active.prerequisite.carryRelease !== null && active.prerequisite.actions.slice(active.prerequisite.nextAction).every(action => action.kind === 'removeCarry'))) { continue; }
        const attempt = stored.record.recovery.attempts[currentAttemptOrdinal(stored.record)]!;
        const snapshot = await k.journal.read();
        const event = [...snapshot.events.values()].find(item => item.metadata.logicalOutboxId === attempt.selectedRecord?.logicalOutboxId);
        const safety = await k.safety();
        if (event !== undefined && event.metadata.sequence > stored.record.plan.lastGoodSequence
          && event.metadata.eventId === [...snapshot.events.values()].at(-1)?.metadata.eventId && hasCurrentAcceptance(event.metadata, safety.generation)) {
          await k.operations.update(stored, value => checkpointRecovery(requireRepair(value), event.metadata, safety.generation, Math.max(1, requireRepair(value).plan.lastGoodSequence + 1), utcNow()));
          await this.runPrerequisite(operationId);
          await this.finalize(operationId);
          return;
        }
        const handoff = attempt.selectedRecord === null ? undefined : stored.record.plan.handoffs.find(item => item.logicalOutboxId === attempt.selectedRecord!.logicalOutboxId);
        const missingPayload = event === undefined && !(await k.outbox.list()).includes(`event-${String(attempt.selectedRecord === null ? 0 : Number(attempt.selectedRecord.logicalOutboxId.slice(33))).padStart(16, '0')}.json`);
        const unavailable = event !== undefined && event.metadata.settlement === 'unknown' && !hasCurrentAcceptance(event.metadata, safety.generation);
        const misplaced = event !== undefined && (event.metadata.sequence <= stored.record.plan.lastGoodSequence || event.metadata.eventId !== [...snapshot.events.values()].at(-1)?.metadata.eventId);
        if (attempt.selectedRecord !== null && active.replacementAttempt === null && (missingPayload || unavailable || misplaced)) {
          await k.resources.reserve('repair', { uncompactedEvents: 1, retainedHandoffs: handoff === undefined ? 1 : 0 });
          await k.operations.update(stored, value => {
            const retained = requireRepair(value);
            const withHandoff = event !== undefined && !retained.plan.handoffs.some(item => item.logicalOutboxId === event.metadata.logicalOutboxId)
              ? { ...retained, plan: { ...retained.plan, handoffs: [...retained.plan.handoffs, handoffFor(event.metadata)] } } : retained;
            return replacementCandidate(withHandoff, missingPayload ? 'missingPayload' : misplaced ? 'placementUnavailable' : 'acceptanceUnavailable');
          });
          this.running = false;
          await this.resume(operationId);
          return;
        }
        throw new SafetyUnavailableError('Recovery remains pending under its recorded attempt.');
      }
      throw new SafetyUnavailableError('Recovery reached the finite outbox rewind bound.');
    } catch (error) {
      error = k.resources.captureFailure(error) ?? error;
      k.diagnose('repair', error);
      throw error;
    } finally {
      this.running = false;
      const record = await this.stored(operationId);
      const unfinished = effectivelyUnfinished(record.record);
      const disagrees = record.record.recovery.activeEpisode !== null && record.record.recovery.episodes[record.record.recovery.activeEpisode]!.phase === 'recordRejected';
      k.emit({ journal: { ...k.status.journal, state: unfinished ? 'fault' : 'healthy', fault: disagrees ? 'recordRejected' : unfinished ? 'repairFailed' : null } });
    }
  }

  private async reconcileObservedPublication(operationId: string): Promise<boolean> {
    const k = this.kernel;
    const stored = await this.stored(operationId);
    const attempt = stored.record.recovery.attempts[currentAttemptOrdinal(stored.record)]!;
    if (attempt.publication !== 'observed') { return false; }
    requireControl(stored.record.plan.publishedVersions !== null);
    const rejected = stored.record.plan.rejectedRecord;
    if (rejected === null || !(await k.outbox.list()).includes(rejected.name)) { return false; }
    const surviving = await k.outbox.read(rejected.name);
    if (surviving.status === 'absent' || surviving.sha256 !== rejected.sha256) { return false; }
    await k.operations.update(stored, value => {
      const repair = requireRepair(value);
      return { ...repair, completedAt: repair.completedAt ?? utcNow(), outcome: repair.outcome ?? 'recordRejected', recovery: { ...repair.recovery,
        episodes: repair.recovery.episodes.map((episode, ordinal) => ordinal === repair.recovery.activeEpisode ? { ...episode, phase: 'recordRejected' } : episode) } };
    });
    k.emit({ journal: { ...k.status.journal, state: 'fault', fault: 'recordRejected' } });
    return true;
  }

  private async captureRetiredAtReceipt(record: RepairOperation, receipt: PublishReceipt): Promise<RepairOperation> {
    const k = this.kernel;
    requireControl(receipt.kind === 'resync' && receipt.logicalOutboxId !== null && receipt.sequence !== null);
    const inventory = await k.operations.list();
    if (inventory.invalid.length > 0) { throw new SafetyUnavailableError('Retired source bindings have unavailable operation authority.'); }
    const journal = await k.journal.read();
    if (journal.header.status !== 'valid' || journal.fault !== null || journal.damaged.length > 0) {
      throw new SafetyUnavailableError('Retired source binding inspection requires a healthy journal.');
    }
    const admitted = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair' ? entry.record.plan.handoffs : []);
    const admittedRetired = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair' ? entry.record.plan.retiredRecords : []);
    const retired = [...record.plan.retiredRecords];
    const handoffs = [...record.plan.handoffs];
    const reservedEventIds = [...admitted.map(item => item.eventId), ...handoffs.map(item => item.eventId)];
    for (const name of await k.outbox.list()) {
      const sequence = outboxRecordSequence(name);
      requireControl(sequence !== null);
      if (sequence >= receipt.sequence) { continue; }
      const source = await k.outbox.read(name);
      if (source.status === 'absent') { throw new SafetyUnavailableError('Listed retired candidate disappeared before inspection.'); }
      if (source.status === 'invalid') { continue; }
      requireControl(source.name === name && source.metadata.sequence === sequence && logicalOutboxSequence(source.metadata.logicalOutboxId) === sequence);
      if (source.metadata.game !== k.scope.game || source.metadata.principal !== k.scope.principal) { continue; }
      if (source.metadata.schemaVersion === receipt.schemaVersion && source.metadata.adapterVersion === receipt.adapterVersion) { continue; }
      const priorRetired = retired.find(item => item.name === name || item.logicalOutboxId === source.metadata.logicalOutboxId);
      requireControl(priorRetired === undefined || priorRetired.name === name && priorRetired.logicalOutboxId === source.metadata.logicalOutboxId && priorRetired.recordSha256 === source.sha256);
      const historicalRetired = admittedRetired.filter(item => item.name === name || item.logicalOutboxId === source.metadata.logicalOutboxId);
      requireControl(historicalRetired.every(item => item.name === name && item.logicalOutboxId === source.metadata.logicalOutboxId && item.recordSha256 === source.sha256));
      const priorAttempts = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair'
        ? entry.record.recovery.attempts.filter(attempt => attempt.selectedRecord?.logicalOutboxId === source.metadata.logicalOutboxId) : []);
      requireControl(priorAttempts.every(attempt => attempt.selectedRecord?.recordSha256 === source.sha256));
      if (priorRetired === undefined) {
        retired.push({ name, logicalOutboxId: source.metadata.logicalOutboxId, recordSha256: source.sha256 });
      }
      const old = handoffs.findIndex(item => item.logicalOutboxId === source.metadata.logicalOutboxId);
      const current = old < 0 ? null : handoffs[old]!;
      requireControl(current === null || current.recordSha256 === source.sha256);
      let bound = current;
      for (const candidate of admitted.filter(item => item.logicalOutboxId === source.metadata.logicalOutboxId)) {
        requireControl(candidate.recordSha256 === source.sha256);
        bound = bound === null ? candidate : mergeHandoff(bound, candidate);
      }
      for (const event of journal.events.values()) {
        if (event.metadata.logicalOutboxId !== source.metadata.logicalOutboxId) { continue; }
        requireControl(event.metadata.recordSha256 === source.sha256 && event.metadata.adapter === k.scope.game && event.metadata.principal === k.scope.principal);
        const candidate = handoffFor(event.metadata);
        bound = bound === null ? candidate : mergeHandoff(bound, candidate);
      }
      if (bound === null) {
        requireControl(priorRetired === undefined);
        if (historicalRetired.length > 0) {
          throw new SafetyUnavailableError('Historically retired source has no proven original settlement binding.');
        }
        if (priorAttempts.some(attempt => attempt.journalEvent !== null)) {
          throw new SafetyUnavailableError('Journaled retired source has no proven original settlement binding.');
        }
        const eventId = await k.eventIdentity(journal, undefined, reservedEventIds);
        reservedEventIds.push(eventId);
        bound = { logicalOutboxId: source.metadata.logicalOutboxId, recordSha256: source.sha256, payloadBindingSha256: null,
          journalId: journal.header.value.journalId, eventId, acceptance: null, presentation: 'unverified', coreRepairOperationId: source.metadata.repairOperationId, attemptRef: null };
      }
      const retained = { ...bound, presentation: bound.presentation === 'replayable' ? 'rejected' as const : bound.presentation };
      if (old < 0) { handoffs.push(retained); } else { handoffs[old] = retained; }
    }
    const candidate = { ...record, plan: { ...record.plan, retiredRecords: retired, handoffs } };
    await k.resources.reserve('repair', { retainedHandoffs: this.handoffGrowth(handoffs, inventory) });
    await k.resources.preflight(path.join(k.scope.dataRoot, 'operations', record.operationId + '.json'),
      Buffer.from(stringifyProspectiveJson(candidate, 'state-event', 'operations/' + record.operationId + '.json', error => k.resources.prospectiveFailure(error))), 'state-event');
    return candidate;
  }

  private async displacedDeferredHandoff(record: RepairOperation, ordinal: number, receipt: PublishReceipt): Promise<RetainedHandoff | null> {
    const k = this.kernel;
    const attempt = record.recovery.attempts[ordinal]!;
    const previous = attempt.selectedRecord;
    if (previous === null || previous.recordSha256 === null || previous.logicalOutboxId === receipt.logicalOutboxId) { return null; }
    const inventory = await k.operations.list();
    if (inventory.invalid.length > 0) { throw new SafetyUnavailableError('Displaced source binding authority is unavailable.'); }
    const journal = await k.journal.read();
    if (journal.header.status !== 'valid' || journal.fault !== null || journal.damaged.length > 0) {
      throw new SafetyUnavailableError('Displaced source binding inspection requires a healthy journal.');
    }
    let bound: RetainedHandoff | null = null;
    const oldToken = coreAttemptToken(record.operationId, ordinal);
    const allHandoffs = inventory.records.flatMap(entry => !entry.record.compacted && entry.record.kind === 'repair' ? entry.record.plan.handoffs : []);
    for (const handoff of allHandoffs.filter(item => item.logicalOutboxId === previous.logicalOutboxId)) {
      requireControl(handoff.recordSha256 === previous.recordSha256 && handoff.coreRepairOperationId === oldToken
        && (handoff.attemptRef === null || handoff.attemptRef.operationId === record.operationId && handoff.attemptRef.attemptOrdinal === ordinal));
      bound = bound === null ? handoff : mergeHandoff(bound, handoff);
    }
    for (const event of journal.events.values()) {
      if (event.metadata.logicalOutboxId !== previous.logicalOutboxId) { continue; }
      requireControl(event.metadata.recordSha256 === previous.recordSha256 && event.metadata.type === 'state.resync'
        && event.metadata.coreRepairOperationId === oldToken && event.metadata.attemptRef?.operationId === record.operationId
        && event.metadata.attemptRef.attemptOrdinal === ordinal && event.metadata.adapter === k.scope.game && event.metadata.principal === k.scope.principal);
      const handoff = handoffFor(event.metadata);
      bound = bound === null ? handoff : mergeHandoff(bound, handoff);
    }
    if (bound !== null) { return bound; }
    if (attempt.publication !== 'deferred' || attempt.journalEvent !== null) {
      throw new SafetyUnavailableError('Displaced selection lacks its original settlement binding.');
    }
    const oldSequence = logicalOutboxSequence(previous.logicalOutboxId);
    requireControl(oldSequence !== null);
    const name = `event-${String(oldSequence).padStart(16, '0')}.json`;
    const source = await k.outbox.read(name);
    requireControl(source.status !== 'invalid');
    if (source.status === 'valid') {
      requireControl(source.metadata.logicalOutboxId === previous.logicalOutboxId && source.sha256 === previous.recordSha256
        && source.metadata.kind === 'resync' && source.metadata.repairOperationId === coreAttemptToken(record.operationId, ordinal)
        && source.metadata.game === k.scope.game && source.metadata.principal === k.scope.principal);
    }
    for (const entry of inventory.records) {
      if (entry.record.compacted || entry.record.kind !== 'repair') { continue; }
      if (entry.record.plan.retiredRecords.some(item => item.logicalOutboxId === previous.logicalOutboxId || item.name === name)) {
        throw new SafetyUnavailableError('Displaced source has historical retirement without a binding.');
      }
      for (const [priorOrdinal, prior] of entry.record.recovery.attempts.entries()) {
        if (prior.selectedRecord?.logicalOutboxId !== previous.logicalOutboxId) { continue; }
        requireControl(prior.selectedRecord.recordSha256 === previous.recordSha256);
        if (prior.publication !== 'deferred' || prior.journalEvent !== null || entry.record.recovery.episodes.some(episode =>
          episode.acceptedRecovery !== null && (episode.attemptAtStart === priorOrdinal || episode.replacementAttempt === priorOrdinal))) {
          throw new SafetyUnavailableError('Displaced source has historical publication without a binding.');
        }
      }
    }
    const eventId = await k.eventIdentity(journal, undefined, [...allHandoffs, ...record.plan.handoffs].map(item => item.eventId));
    return { logicalOutboxId: previous.logicalOutboxId, recordSha256: previous.recordSha256, payloadBindingSha256: null,
      journalId: journal.header.value.journalId, eventId, acceptance: null, presentation: 'unverified',
      coreRepairOperationId: coreAttemptToken(record.operationId, ordinal), attemptRef: { operationId: record.operationId, attemptOrdinal: ordinal } };
  }

  private async quarantineLostOperations(operationId: string): Promise<void> {
    const k = this.kernel;
    const stored = await this.stored(operationId);
    for (const lost of stored.record.plan.lostOperations) {
      const source = `operations/${lost.name}`;
      const before = await this.fileHash(source);
      const after = await this.fileHash(lost.destination);
      if (before === null && after === lost.sha256) { continue; }
      requireControl(before === lost.sha256 && after === null);
      const witness = (await k.safety()).recoveryWitness;
      requireControl(witness?.phase === 'active' && witness.owner.operationId === operationId);
      k.resources.invalidatePublication(source);
      await k.publisher.exclusive(async () => {
        const outcome = await k.publisher.runNativeMutation('fileAction', { root: k.scope.dataRoot, action: 'Move', source: path.join(k.scope.dataRoot, source),
          sha256: lost.sha256, target: path.join(k.scope.dataRoot, lost.destination) }, 30000);
        if (!outcome.ended) { k.publisher.block(); }
        requireControl(outcome.ended);
        // An error reply or a lost one is settled against both exact postimages.
        requireControl(await this.fileHash(source) === null && await this.fileHash(lost.destination) === lost.sha256);
      });
    }
  }

  private async finalize(operationId: string): Promise<void> {
    const k = this.kernel;
    let stored = await this.stored(operationId);
    const ordinal = stored.record.recovery.activeEpisode;
    requireControl(ordinal !== null);
    const episode = stored.record.recovery.episodes[ordinal]!;
    requireControl(episode.prerequisite === null || episode.prerequisite.nextAction === episode.prerequisite.actions.length && carryReleaseResolved(episode.prerequisite));
    requireControl(await this.acceptedRecoveryUsable(stored.record));
    const accepted = episode.acceptedRecovery;
    const safety = await k.safety();
    const snapshot = await k.journal.read();
    requireControl(accepted !== null && accepted.generation === safety.generation && snapshot.header.status === 'valid' && snapshot.header.value.journalId === accepted.journalId);
    const event = snapshot.events.get(accepted.sequence);
    requireControl(event?.metadata.eventId === accepted.eventId && hasCurrentAcceptance(event.metadata, safety.generation));
    if (!snapshot.header.value.historyVerified) { await k.storage.write(headerPath, { ...snapshot.header.value, historyVerified: true }, 'config', snapshot.header.sha256); }
    const owner = activeRecoveryOwner(stored.record)!;
    stored = await this.stored(operationId);
    await k.operations.update(stored, value => completeRecovery(requireRepair(value), accepted.journalId, accepted.generation, utcNow()));
    await k.safetyStore.awaitDisclosure(owner, { journalId: accepted.journalId, eventId: accepted.eventId, sequence: accepted.sequence, generation: accepted.generation }, {
      verify: async () => {
        const current = await this.stored(operationId);
        return current.record.recovery.episodes[ordinal]!.acceptedRecovery?.eventId === event.metadata.eventId;
      },
    });
    k.emit({ journal: { ...k.status.journal, state: 'healthy', fault: null } });
  }

  startup(beforeResume?: () => Promise<boolean>, capacityCheckpoint?: () => Promise<void>): Promise<void> {
    return this.kernel.resources.withTransition('repair', () => this.startupOwned(beforeResume, capacityCheckpoint));
  }

  private async startupOwned(beforeResume?: () => Promise<boolean>, capacityCheckpoint?: () => Promise<void>): Promise<void> {
    const k = this.kernel;
    await this.reconcileSafety();
    if (await beforeResume?.()) { await this.reconcileSafety(); }
    let inventory = await k.operations.list();
    const unfinished = inventory.records.filter(item => !item.record.compacted && item.record.kind === 'repair' && effectivelyUnfinished(item.record));
    requireControl(unfinished.length <= 1);
    if (unfinished.length === 1) { await this.resume(unfinished[0]!.record.operationId); return; }
    const snapshot = await k.journal.read();
    const deferred = deferredCarryAuthority(inventory);
    if (deferred.state === 'unavailable' && await k.carryHash() !== null) { throw new SafetyUnavailableError('Present carry has unavailable ownership.'); }
    const cause = snapshot.fault === 'header' || snapshot.fault === 'cursor' ? snapshot.fault : inventory.invalid.length > 0 ? 'operationLost'
      : snapshot.fault ?? (snapshot.damaged.length > 0 ? 'contextUncertain' : null);
    if (cause !== null) { const record = await this.plan({ cause, journal: snapshot }); await this.resume(record.record.operationId); return; }
    if (deferred.state === 'unavailable') { throw new SafetyUnavailableError('Deferred carry ownership is unavailable.'); }
    if (deferred.owner !== null) {
      const source = inventory.records.find(entry => entry.record.operationId === deferred.owner!.operationId)!.record;
      requireControl(!source.compacted && source.kind === 'repair' && source.recovery.episodes[deferred.owner.episodeOrdinal]!.phase === 'abandonedByRelease');
      const successor = await this.plan({ cause: 'contextUncertain', journal: snapshot });
      await this.resume(successor.record.operationId);
      return;
    }
    const safety = await k.safety();
    const correctionRoot = safety.correction?.recoveryOperationId;
    if (correctionRoot !== null && correctionRoot !== undefined) {
      const entry = inventory.records.find(value => value.record.operationId === correctionRoot);
      requireControl(entry !== undefined && !entry.record.compacted && entry.record.kind === 'repair');
      const checkpoint = entry.record.recovery.episodes.at(-1)?.acceptedRecovery;
      if (checkpoint?.generation !== safety.generation) {
        const replay = await this.replayForJournal(entry.record, snapshot, null);
        const owner = activeRecoveryOwner(replay)!;
        if (safety.recoveryWitness === null) { await k.safetyStore.prepareWitness(owner); }
        else { await k.safetyStore.prepareTransfer(owner); }
        await k.operations.update(entry, () => replay);
        await k.safetyStore.activateWitness(owner, this.ownerProof(owner));
        await this.resume(correctionRoot);
        return;
      }
    }
    const names = new Set(await k.outbox.list());
    for (const entry of inventory.records) {
      if (entry.record.compacted || entry.record.kind !== 'repair' || entry.record.recovery.episodes.at(-1)?.phase === 'abandonedByRelease') { continue; }
      const record = entry.record;
      if (record.plan.rejectedRecord !== null && names.has(record.plan.rejectedRecord.name) || record.plan.retiredRecords.some(item => names.has(item.name))) {
        const replay = await this.replayForJournal(record, snapshot, null);
        const owner = activeRecoveryOwner(replay)!;
        const witness = (await k.safety()).recoveryWitness;
        if (witness === null) { await k.safetyStore.prepareWitness(owner); }
        else { await k.safetyStore.prepareTransfer(owner); }
        await k.operations.update(entry, () => replay);
        await k.safetyStore.activateWitness(owner, this.ownerProof(owner));
        await this.resume(record.operationId);
        return;
      }
    }
    await capacityCheckpoint?.();
  }

  async capacityCheckpoint(retain: () => Promise<void>): Promise<void> {
    const k = this.kernel;
    k.owned();
    await retain();
    const operations = await k.operations.list();
    const safety = await k.safety();
    const journal = await k.journal.read();
    requireControl(operations.invalid.length === 0 && !operations.records.some(entry => effectivelyUnfinished(entry.record))
      && safety.pendingCheck === null && journal.fault === null && journal.damaged.length === 0
      && journal.header.status === 'valid' && journal.cursor.status === 'valid');
    try { await k.resources.withTransition('ordinary', () => k.resources.reserve('ordinary')); return; }
    catch (error) {
      if (!(error instanceof RuntimeCapacityError) || error.transition !== 'ordinary' || error.state !== 'exhausted') { throw error; }
    }
    const plan = await this.plan({ cause: 'capacity', journal });
    this.selectedCapacityRoot = plan.record.operationId;
    await this.resume(plan.record.operationId);
  }

  async capacityResult(): Promise<CapacityRewindResult | null> {
    if (this.selectedCapacityRoot === null) { return null; }
    const unknown: CapacityRewindResult = { affectedEvents: null, fromSequence: null, throughSequence: null, retainedHandoffs: null,
      replayableHandoffs: null, presentationRetiredHandoffs: null, survivingCoreRecords: null };
    try {
      const record = (await this.stored(this.selectedCapacityRoot)).record;
      requireControl(record.cause === 'capacity');
      const original = record.recovery.episodes[0]?.prerequisite;
      requireControl(original?.kind === 'rewind');
      const actions = original.actions.filter(action => action.kind === 'quarantine' && action.source.path.startsWith('journal/events/'));
      const sequences = actions.map(action => {
        requireControl(action.kind === 'quarantine');
        const sequence = Number(path.basename(action.source.path, '.json'));
        requireControl(Number.isSafeInteger(sequence) && sequence > 0 && eventFileName(sequence) === path.basename(action.source.path)
          && record.plan.affected.some(event => event.sequence === sequence && event.fileSha256 === action.source.before));
        return sequence;
      }).sort((left, right) => left - right);
      requireControl(new Set(sequences).size === sequences.length);
      const handoffs = new Map<string, RetainedHandoff>();
      for (const handoff of record.plan.handoffs) {
        const key = handoff.logicalOutboxId + ':' + handoff.recordSha256;
        const prior = handoffs.get(key);
        handoffs.set(key, prior === undefined ? handoff : mergeHandoff(prior, handoff));
      }
      const values = [...handoffs.values()];
      let survivingCoreRecords: number | null = null;
      try {
        await this.kernel.resources.withSource(this.capacitySource, async () => {
          const names = await this.kernel.outbox.list();
          let count = 0;
          for (const name of names) {
            const source = await this.kernel.outbox.read(name);
            requireControl(source.status === 'valid');
            const matches = values.filter(handoff => handoff.logicalOutboxId === source.metadata.logicalOutboxId);
            if (matches.length > 0) { requireControl(matches.length === 1 && matches[0]!.recordSha256 === source.sha256); count++; }
          }
          survivingCoreRecords = count;
        });
      } catch { /* Missing or unreadable source evidence is reported as unknown. */ }
      return { affectedEvents: sequences.length, fromSequence: sequences[0] ?? null, throughSequence: sequences.at(-1) ?? null,
        retainedHandoffs: values.length, replayableHandoffs: values.filter(value => value.presentation === 'replayable').length,
        presentationRetiredHandoffs: values.filter(value => value.presentation !== 'replayable').length, survivingCoreRecords };
    } catch { return unknown; }
  }

}

function mergeRanges(...groups: readonly (readonly SkippedRange[])[]): SkippedRange[] {
  const values = new Map<string, SkippedRange>();
  for (const range of groups.flat()) {
    const key = stringifyJson([range.journalId, range.firstSequence, range.lastSequence, range.reason]);
    const previous = values.get(key);
    if (previous?.discharge !== null && previous?.discharge !== undefined && range.discharge !== null) { requireControl(stringifyJson(previous.discharge) === stringifyJson(range.discharge)); }
    values.set(key, previous?.discharge !== null && previous?.discharge !== undefined ? previous : range);
  }
  return [...values.values()];
}
