import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireControl } from '../control-values.ts';
import { RuntimeCapacityError } from '../capacity.ts';
import type { CapacityRewindResult } from './api.ts';
import type { CapacitySource } from '../resource-lifecycle/resources.ts';
import { Deadline } from '../deadline.ts';
import { observeFile } from '../file-observation.ts';
import { newIdentity, newOperationId } from '../identity.ts';
import { eventFileName, eventRewriteMetadata, hasCurrentAcceptance, type EventDescription, type JournalCursor, type JournalHeader } from '../journal-records.ts';
import type { JournalEvent, JournalSnapshot } from '../journal.ts';
import { jsonBudgets, readBoundedFile, stringifyJson, stringifyProspectiveJson, utcNow } from '../json.ts';
import { effectivelyUnfinished, coreAttemptToken, type RepairOperation, type RetainedHandoff, type RecoveryEpisode } from '../operation-records.ts';
import { requireRepair, type OperationInventory, type StoredOperation } from '../operations.ts';
import { RecoveryExecutor, RecoveryDamageError } from '../recovery-executor.ts';
import type { RecoveryAction, RecoveryPrerequisite } from '../recovery-manifest.ts';
import { activeRecoveryOwner, bindRecoveryEvent, checkpointRecovery, completeRecovery, currentAttemptOrdinal, replacementCandidate, replayCandidate, selectRecoveryRecord, transferEpisode } from '../recovery-progress.ts';
import type { SkippedRange } from '../recovery-provenance.ts';
import { sameRecoveryOwner, SafetyUnavailableError, type RecoveryOwner, type StateSafety } from '../safety-records.ts';
import { bytesHash } from '../storage.ts';
import { Kernel, type RepairRequest } from './kernel.ts';
import { additionalHandoffCount, mergeHandoff } from './handoffs.ts';
import { reservedWitnessMatches } from './recovery-authority.ts';
import { hasCarryAuthority } from './provider-authority.ts';

const headerPath = 'journal/journal.json';
const cursorPath = 'journal/cursor-agent-session.json';
const hashValue = (value: unknown): string => bytesHash(Buffer.from(stringifyJson(value)));

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
  constructor(kernel: Kernel) { this.kernel = kernel; kernel.planRecovery = (request, deadline) => this.plan(request, deadline); }

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
          const updated: RecoveryPrerequisite = { kind: 'rewind', nextAction: 0, carry: null, skippedRanges: [], ...prerequisite,
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
    const historicalOwner = correctionRoot === null || correctionRoot === undefined ? undefined : inventory.records.find(entry => entry.record.operationId === correctionRoot);
    if (historicalOwner !== undefined && !historicalOwner.record.compacted && historicalOwner.record.kind === 'repair'
      && historicalOwner.record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease') {
      if (request.cause === 'contextUncertain' || request.cause === 'operationLost' || request.journal.damaged.length > 0) { await k.safetyStore.invalidate('contextUncertain', deadline); }
      const candidate = replayCandidate(historicalOwner.record, await k.activationIdentity(deadline), utcNow());
      const owner = activeRecoveryOwner(candidate)!;
      const prerequisite = await this.prerequisite(request, deadline);
      const trigger = request.cause === 'header' || request.cause === 'cursor' || request.cause === 'gap' ? request.cause : 'completedReplay';
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
    const prerequisite = await this.prerequisite(request, deadline);
    const lastGood = request.journal.cursor.status === 'valid' ? request.journal.cursor.value.lastAckedSequence : 0;
    const handoffs: RetainedHandoff[] = [];
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
      plan: { lastGoodSequence: prerequisite?.kind === 'header' ? 0 : lastGood, affected: readableEvents.map(event => ({ sequence: event.metadata.sequence, eventId: event.metadata.eventId, fileSha256: event.sha256 })),
        cursorTo: prerequisite?.kind === 'cursor' && request.journal.header.status === 'valid' ? request.journal.header.value.highWaterSequence : null,
        rejectedRecord: request.rejected ?? null, lostOperations: inventory.invalid.filter(item => item.sha256 !== null).map(item => ({ name: item.name, sha256: item.sha256!, destination: `quarantine/${item.name}.${newIdentity()}.quarantined` })), publishedVersions: null, retiredRecords: [], handoffs, correctionId: correction?.correctionId ?? null,
        inheritedRecovery: reservedWitness !== null && !sameRecoveryOwner(reservedWitness.owner, owner) ? reservedWitness.owner : null, skippedRanges: mergeRanges(inheritedRanges, prerequisite?.skippedRanges ?? []) },
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

  private async prerequisite(request: RepairRequest, deadline?: Deadline): Promise<RecoveryPrerequisite | null> {
    const { journal, cause } = request;
    const structural = cause === 'header' || journal.header.status !== 'valid' ? 'header' : cause === 'cursor' || journal.cursor.status !== 'valid' ? 'cursor'
      : cause === 'gap' || journal.damaged.length > 0 ? 'gap' : ['coreRejected', 'settlementUnverified', 'versionChange', 'capacity'].includes(cause) ? 'rewind' : null;
    if (request.unboundCarrySha256 !== undefined) {
      // Do not rewrite a destructive structural plan around unknown payloads.
      // The preserved intent continues to block until that authority is repaired.
      requireControl(structural === null);
      return { kind: 'rewind', actions: [quarantineCarry(request.unboundCarrySha256)], nextAction: 0, carry: null, skippedRanges: [] };
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
    const preliminary: RecoveryPrerequisite = { kind: structural, actions, nextAction: 0, carry: null, skippedRanges: ranges };
    return this.preserveRecovery(preliminary, journal, deadline);
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
    const source = await readBoundedFile(path.join(k.scope.dataRoot, sourcePath), jsonBudgets['state-event'].maxBytes);
    requireControl(bytesHash(source) === event.sha256);
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
    if (hasCarryAuthority(sha256, inventory)) { return; }
    requireControl(sha256 !== null);
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
      const candidates = (await k.operations.list(deadline)).records.filter(item => !item.record.compacted && item.record.kind === 'repair' && item.record.plan.correctionId === safety.correction!.correctionId
        && item.record.recovery.episodes.at(-1)?.phase !== 'abandonedByRelease');
      requireControl(candidates.length <= 1);
      const record = candidates[0] ?? await this.plan({ cause: 'contextUncertain', journal: await k.journal.read(deadline) }, deadline);
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
        const checkpoint = operation.value.recovery.episodes[owner.episodeOrdinal]?.acceptedRecovery;
        const snapshot = await k.journal.read(deadline);
        if (checkpoint !== null && checkpoint !== undefined && checkpoint.generation === (await k.safety(deadline)).generation
          && snapshot.events.get(checkpoint.sequence)?.metadata.eventId === checkpoint.eventId) {
          await k.safetyStore.awaitDisclosure(owner, checkpoint, this.ownerProof(owner), deadline);
        } else { throw new SafetyUnavailableError('Completed recovery lost its accepted disclosure checkpoint.'); }
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
    const prerequisite = await this.prerequisite({ cause: presentation === 'rejected' ? 'coreRejected' : 'settlementUnverified', journal: snapshot, rejectedEvent: event }, deadline);
    return this.kernel.operations.update(stored, item => {
      const repair = requireRepair(item);
      const retiredRecords = presentation === 'rejected' && !repair.plan.retiredRecords.some(item => item.logicalOutboxId === event.logicalOutboxId && item.recordSha256 === event.recordSha256)
        ? [...repair.plan.retiredRecords, { name: `event-${event.logicalOutboxId.slice(33).padStart(16, '0')}.json`, logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }] : repair.plan.retiredRecords;
      return { ...repair, plan: { ...repair.plan, handoffs, retiredRecords }, recovery: { ...repair.recovery, episodes: repair.recovery.episodes.map((episode, ordinal) => ordinal === index ? { ...episode, prerequisite, phase: 'reconstructing' } : episode) } };
    }, deadline);
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
      },
      readPayloadSource: async source => {
        const root = source.root === 'scope' ? k.scope.dataRoot : k.scope.companionRoot;
        const admission = await k.inspector.inspect(root, path.join(root, source.path));
        requireControl(admission.kind === 'file');
        const bytes = await readBoundedFile(admission.path, jsonBudgets['state-event'].maxBytes);
        requireControl(bytesHash(bytes) === source.sha256);
        return bytes;
      } });
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
      try { await executor.execute(plan.actions[plan.nextAction]!); }
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
          ? { ...episode, phase: 'reconstructing', prerequisite: { ...plan, nextAction: plan.nextAction + 1 } } : episode) } };
      });
    }
  }

  private async transferDamage(stored: StoredOperation & { record: RepairOperation }, snapshot: JournalSnapshot): Promise<void> {
    const k = this.kernel;
    this.damageEpisodeCreated = true;
    const inventory = await k.operations.list();
    await k.resources.reserve('repair', { uncompactedEvents: 1, retainedHandoffs: this.handoffGrowth([...snapshot.events.values()].map(event => event.metadata), inventory) });
    const activationId = await k.activationIdentity();
    const kind = snapshot.fault ?? 'gap';
    const prerequisite = await this.prerequisite({ cause: kind, journal: snapshot });
    requireControl(prerequisite !== null);
    const successor = { operationId: stored.record.operationId, episodeOrdinal: stored.record.recovery.episodes.length, activationId };
    await k.safetyStore.prepareTransfer(successor);
    await k.operations.update(stored, value => {
      const repair = requireRepair(value);
      const handoffs = [...repair.plan.handoffs];
      for (const event of snapshot.events.values()) { if (!handoffs.some(item => item.logicalOutboxId === event.metadata.logicalOutboxId)) { handoffs.push(handoffFor(event.metadata)); } }
      const skippedRanges = [...repair.plan.skippedRanges, ...prerequisite.skippedRanges.filter(range => !repair.plan.skippedRanges.some(old => old.journalId === range.journalId && old.firstSequence === range.firstSequence && old.lastSequence === range.lastSequence))];
      const lastGoodSequence = kind === 'header' ? 0 : kind === 'cursor' && snapshot.header.status === 'valid' ? snapshot.header.value.highWaterSequence : (snapshot.firstBadSequence ?? repair.plan.lastGoodSequence + 1) - 1;
      return transferEpisode({ ...repair, plan: { ...repair.plan, handoffs, skippedRanges, lastGoodSequence } }, { activationId, trigger: kind,
        attemptAtStart: currentAttemptOrdinal(repair), replacementAttempt: null, prerequisite, acceptedRecovery: null, startedAt: utcNow() }, utcNow());
    });
    await k.safetyStore.activateWitness(successor, this.ownerProof(successor));
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
      const ordinal = currentAttemptOrdinal(record);
      const episode = record.recovery.episodes[record.recovery.activeEpisode!]!;
      if (episode.phase === 'verifyingHistory') { await this.finalize(operationId); return; }
      if (record.recovery.attempts[ordinal]!.publication !== 'observed') {
        await k.safetyStore.invalidate('contextUncertain');
        await this.bindCorrection(operationId);
        record = (await this.stored(operationId)).record;
        const result = await k.publish(false, record, Deadline.after(3600000), async result => {
          if (!result.success) { return; }
          requireControl(result.value.kind === 'resync' && result.value.logicalOutboxId !== null);
          const source = await k.outbox.read(`event-${String(result.value.sequence).padStart(16, '0')}.json`);
          const retainedEvent = source.status === 'absent' ? [...(await k.journal.read()).events.values()].find(entry => entry.metadata.logicalOutboxId === result.value.logicalOutboxId) : undefined;
          requireControl(source.status !== 'invalid');
          if (source.status === 'valid') { requireControl(source.metadata.logicalOutboxId === result.value.logicalOutboxId && source.metadata.repairOperationId === coreAttemptToken(operationId, ordinal)); }
          if (retainedEvent !== undefined) { requireControl(retainedEvent.metadata.coreRepairOperationId === coreAttemptToken(operationId, ordinal)); }
          const selectedIdentity = { logicalOutboxId: result.value.logicalOutboxId, recordSha256: source.status === 'valid' ? source.sha256 : retainedEvent?.metadata.recordSha256 ?? null };
          const current = await this.stored(operationId);
          const previous = current.record.recovery.attempts[ordinal]!.selectedRecord;
          const displaced = previous === null || previous.logicalOutboxId === selectedIdentity.logicalOutboxId ? null : current.record.plan.handoffs.find(item => item.logicalOutboxId === previous.logicalOutboxId) ?? null;
          await k.operations.update(current, value => {
            const selected = selectRecoveryRecord(requireRepair(value), selectedIdentity, result.value.warnings.some(warning => warning.code === 'outbox-quarantine-deferred') ? 'deferred' : 'observed', displaced);
            return { ...selected, plan: { ...selected.plan, publishedVersions: { schemaVersion: result.value.schemaVersion, adapterVersion: result.value.adapterVersion } } };
          });
        });
        if (!result.success) {
          if (result.reason.startsWith('consumer-')) { k.emit({ consumer: 'notOwner' }); }
          throw new SafetyUnavailableError('Recovery publication did not complete.');
        }
        if (result.value.warnings.some(warning => warning.code === 'outbox-quarantine-deferred')) { throw new SafetyUnavailableError('Core quarantine remains deferred.'); }
        await this.recordRetiredVersions(operationId);
        const latest = await this.stored(operationId);
        const rejected = latest.record.plan.rejectedRecord;
        if (rejected !== null && (await k.outbox.list()).includes(rejected.name)) {
          const surviving = await k.outbox.read(rejected.name);
          if (surviving.status !== 'absent' && surviving.sha256 === rejected.sha256) {
            await k.operations.update(latest, value => {
              const repair = requireRepair(value);
              return { ...repair, completedAt: repair.completedAt ?? utcNow(), outcome: repair.outcome ?? 'recordRejected', recovery: { ...repair.recovery,
                episodes: repair.recovery.episodes.map((episode, ordinal) => ordinal === repair.recovery.activeEpisode ? { ...episode, phase: 'recordRejected' } : episode) } };
            });
            k.emit({ journal: { ...k.status.journal, state: 'fault', fault: 'recordRejected' } });
            return;
          }
        }
      }
      for (let pass = 0; pass < 17; pass++) {
        await this.runPrerequisite(operationId);
        // Startup/operator recovery is independent of a player interaction's
        // 120-second gate. CoreClient still caps each settlement at 120 seconds.
        const gate = Deadline.after(3600000);
        await k.drain(gate, operationId);
        stored = await this.stored(operationId);
        const active = stored.record.recovery.episodes[stored.record.recovery.activeEpisode!]!;
        if (active.prerequisite !== null && active.prerequisite.nextAction < active.prerequisite.actions.length) { continue; }
        const attempt = stored.record.recovery.attempts[currentAttemptOrdinal(stored.record)]!;
        const snapshot = await k.journal.read();
        const event = [...snapshot.events.values()].find(item => item.metadata.logicalOutboxId === attempt.selectedRecord?.logicalOutboxId);
        const safety = await k.safety();
        if (event !== undefined && event.metadata.eventId === [...snapshot.events.values()].at(-1)?.metadata.eventId && hasCurrentAcceptance(event.metadata, safety.generation)) {
          await k.operations.update(stored, value => checkpointRecovery(requireRepair(value), event.metadata, safety.generation, Math.max(1, requireRepair(value).plan.lastGoodSequence + 1), utcNow()));
          await this.finalize(operationId);
          return;
        }
        const handoff = attempt.selectedRecord === null ? undefined : stored.record.plan.handoffs.find(item => item.logicalOutboxId === attempt.selectedRecord!.logicalOutboxId);
        const missingPayload = event === undefined && !(await k.outbox.list()).includes(`event-${String(attempt.selectedRecord === null ? 0 : Number(attempt.selectedRecord.logicalOutboxId.slice(33))).padStart(16, '0')}.json`);
        const unavailable = event !== undefined && event.metadata.settlement === 'unknown' && !hasCurrentAcceptance(event.metadata, safety.generation);
        const misplaced = event !== undefined && event.metadata.eventId !== [...snapshot.events.values()].at(-1)?.metadata.eventId;
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

  private async recordRetiredVersions(operationId: string): Promise<void> {
    const k = this.kernel;
    let stored = await this.stored(operationId);
    const versions = stored.record.plan.publishedVersions;
    requireControl(versions !== null);
    const journal = await k.journal.read();
    requireControl(journal.header.status === 'valid');
    const retired = [...stored.record.plan.retiredRecords];
    const handoffs = [...stored.record.plan.handoffs];
    for (const name of await k.outbox.list()) {
      const source = await k.outbox.read(name);
      if (source.status !== 'valid' || source.metadata.schemaVersion === versions.schemaVersion && source.metadata.adapterVersion === versions.adapterVersion) { continue; }
      if (!retired.some(item => item.logicalOutboxId === source.metadata.logicalOutboxId && item.recordSha256 === source.sha256)) {
        retired.push({ name, logicalOutboxId: source.metadata.logicalOutboxId, recordSha256: source.sha256 });
      }
      const old = handoffs.findIndex(item => item.logicalOutboxId === source.metadata.logicalOutboxId);
      if (old >= 0) { handoffs[old] = { ...handoffs[old]!, presentation: 'rejected' }; }
      else {
        const event = [...journal.events.values()].find(item => item.metadata.logicalOutboxId === source.metadata.logicalOutboxId);
        handoffs.push(event !== undefined ? handoffFor(event.metadata, 'rejected') : { logicalOutboxId: source.metadata.logicalOutboxId, recordSha256: source.sha256, payloadBindingSha256: null,
          journalId: journal.header.value.journalId, eventId: await k.eventIdentity(journal, undefined, handoffs.map(item => item.eventId)), acceptance: null, presentation: 'unverified', coreRepairOperationId: source.metadata.repairOperationId, attemptRef: null });
      }
    }
    if (retired.length !== stored.record.plan.retiredRecords.length || stringifyJson(handoffs, 'state-event') !== stringifyJson(stored.record.plan.handoffs, 'state-event')) {
      await k.resources.reserve('repair', { retainedHandoffs: this.handoffGrowth(handoffs, await k.operations.list()) });
      await k.operations.update(stored, value => ({ ...requireRepair(value), plan: { ...requireRepair(value).plan, retiredRecords: retired, handoffs } }));
    }
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
      await k.publisher.exclusive(async options => {
        const actualScript = fileURLToPath(new URL('../../scripts/Invoke-FileAction.ps1', import.meta.url));
        await options.supervisor.run('publication', { command: 'pwsh', args: ['-NoProfile', '-File', actualScript, '-Root', k.scope.dataRoot, '-Action', 'Move',
          '-Source', path.join(k.scope.dataRoot, source), '-Target', path.join(k.scope.dataRoot, lost.destination), '-Sha256', lost.sha256], cwd: k.scope.dataRoot }, 30000);
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
    const cause = snapshot.fault === 'header' || snapshot.fault === 'cursor' ? snapshot.fault : inventory.invalid.length > 0 ? 'operationLost'
      : snapshot.fault ?? (snapshot.damaged.length > 0 ? 'contextUncertain' : null);
    if (cause !== null) { const record = await this.plan({ cause, journal: snapshot }); await this.resume(record.record.operationId); return; }
    const safety = await k.safety();
    const correctionRoot = safety.correction?.recoveryOperationId;
    if (correctionRoot !== null && correctionRoot !== undefined) {
      const entry = inventory.records.find(value => value.record.operationId === correctionRoot);
      requireControl(entry !== undefined && !entry.record.compacted && entry.record.kind === 'repair');
      const checkpoint = entry.record.recovery.episodes.at(-1)?.acceptedRecovery;
      if (checkpoint?.generation !== safety.generation) {
        const replay = replayCandidate(entry.record, await k.activationIdentity(), utcNow());
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
        const replay = replayCandidate(record, await k.activationIdentity(), utcNow());
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
