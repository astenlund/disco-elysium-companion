import { requireControl } from '../control-values.ts';
import type { ConsumerReceipt, CoreRequest, CoreResult } from '../core-client.ts';
import { Deadline } from '../deadline.ts';
import { newIdentity, newOperationId } from '../identity.ts';
import { utcNow } from '../json.ts';
import { effectivelyUnfinished, pendingOperationSafety, type FullOperation, type HandoverOperation, type ReleaseOperation, type OperationSafety } from '../operation-records.ts';
import { requireRepair, type StoredOperation } from '../operations.ts';
import { abandonRecovery } from '../recovery-progress.ts';
import type { SkippedRange } from '../recovery-provenance.ts';
import { sameRecoveryOwner, type RecoveryWitness } from '../safety-records.ts';
import { Kernel } from './kernel.ts';
import { releaseJournalEvidence, releaseNamesOwner, releaseNamesWitness } from './release-authority.ts';
import type { BackendCommand, BackendStartup } from './api.ts';
import { hasCarryAuthority } from './provider-authority.ts';

export class ReleaseRefusedError extends Error {
  override readonly name = 'ReleaseRefusedError';
  readonly code = 'undelivered';
  readonly details: readonly string[];
  constructor(details: readonly string[]) { super('Explicit abandonment is required before releasing undelivered state.'); this.details = details; }
}

class ConsumerResumeError extends Error {
  readonly result: Extract<CoreResult<ConsumerReceipt>, { success: false }>;
  constructor(result: Extract<CoreResult<ConsumerReceipt>, { success: false }>) {
    super('An earlier consumer operation remains incomplete.');
    this.result = result;
  }
}

export class ConsumerCoordinator {
  readonly kernel: Kernel;
  constructor(kernel: Kernel) { this.kernel = kernel; }

  async startup(command: BackendCommand): Promise<BackendStartup | null> {
    let released: boolean;
    try { released = await this.pending(); }
    catch (error) {
      if (command.kind !== 'consumer' || !(error instanceof ConsumerResumeError)) { throw error; }
      return { notOwner: false, consumerResult: error.result };
    }
    if (released && command.kind === 'chat') { return { notOwner: true, consumerResult: null }; }
    if (command.kind !== 'consumer') { return null; }
    const result = await this.switch(command.owner, command.abandonUndelivered);
    return { notOwner: result.success && result.value.owner === 'bridge', consumerResult: result };
  }

  async pending(): Promise<boolean> {
    const inventory = await this.kernel.operations.list();
    const releases = inventory.records.flatMap(({ record }) => !record.compacted && record.kind === 'release' && record.completedAt !== null ? [record] : []);
    if (releases.length > 0) {
      let witness: RecoveryWitness | null = null;
      try { witness = (await this.kernel.safety()).recoveryWitness; }
      catch (error) { this.kernel.diagnose('releaseWitnessReconciliation', error); }
      if (witness !== null) {
        for (const release of releases) {
          if (releaseNamesWitness(release, witness) && await this.reconcileReleaseWitness(release.operationId)) { break; }
        }
      }
    }
    const pending = inventory.records.filter(entry => !entry.record.compacted && entry.record.kind !== 'repair' && entry.record.completedAt === null);
    requireControl(pending.length <= 1);
    let released = false;
    for (const entry of pending) {
      const result = await this.execute(entry, true);
      if (!result.success && (await this.current(entry.record.operationId)).record.completedAt === null) { throw new ConsumerResumeError(result); }
      released = result.success && result.value.owner === 'bridge';
    }
    return released;
  }

  async transferPending(): Promise<boolean> {
    const k = this.kernel;
    const inventory = await k.operations.list();
    requireControl(inventory.invalid.length === 0);
    const pending = inventory.records.filter(item => pendingOperationSafety(item.record));
    if (pending.length === 0) { return false; }
    const first = pending[0]!.record;
    requireControl(!first.compacted && first.kind !== 'repair');
    // The durable correction is written before any protected intent is transferred.
    const changed = await k.safetyStore.invalidate('contextUncertain', undefined, first.safety.obligationId);
    requireControl(changed.value.correction !== null);
    for (const entry of pending) {
      await k.operations.update(entry, record => {
        requireControl(record.kind !== 'repair');
        return { ...record, safety: { ...record.safety, phase: 'transferred', correctionId: changed.value.correction!.correctionId } };
      });
    }
    return true;
  }

  private async releaseEvidence(): Promise<{ complete: boolean; details: string[]; plan: ReleaseOperation['plan'] }> {
    const k = this.kernel;
    const details: string[] = [];
    let snapshot: Awaited<ReturnType<typeof k.journal.read>> | null = null;
    let inventory: Awaited<ReturnType<typeof k.operations.list>> | null = null;
    let safety: Awaited<ReturnType<typeof k.safety>> | null = null;
    try { snapshot = await k.journal.read(); } catch { details.push('journalUnavailable'); }
    try { inventory = await k.operations.list(); } catch { details.push('operationsUnavailable'); }
    try { safety = await k.safety(); } catch { details.push('contextUnavailable'); }
    try { if (inventory === null || !hasCarryAuthority(await k.carryHash(), inventory)) { details.push('recoveryCarryUnbound'); } }
    catch { details.push('recoveryCarryUnavailable'); }
    const outbox = await k.outbox.list();
    if (outbox.length > 0) { details.push(`${outbox.length} outbox records`); }
    const names = await k.storage.list('journal/events', Deadline.after(120000));
    const { header, cursor, abandonedSequences } = releaseJournalEvidence(snapshot, names);
    if (header === null || cursor === null || snapshot?.fault !== null || snapshot?.damaged.length !== 0) { details.push('journalUnverified'); }
    if (header !== null && !header.historyVerified) { details.push('historyUnverified'); }
    if (abandonedSequences.length > 0) { details.push(`${abandonedSequences.length} unacknowledged events`); }
    const unfinishedRepairs = (inventory?.records ?? []).flatMap(entry => {
      if (entry.record.compacted || entry.record.kind !== 'repair' || !effectivelyUnfinished(entry.record)) { return []; }
      details.push(entry.record.operationId);
      const ordinal = entry.record.recovery.activeEpisode;
      for (const event of entry.record.plan.affected) { if (!abandonedSequences.includes(event.sequence)) { abandonedSequences.push(event.sequence); } }
      return [{ operationId: entry.record.operationId, episodeOrdinal: ordinal, activationId: ordinal === null ? null : entry.record.recovery.episodes[ordinal]!.activationId }];
    });
    if (inventory === null || inventory.invalid.length > 0) { details.push('operationLost'); }
    if (safety === null || safety.recoveryWitness !== null) { details.push('recoveryDisclosureOwed'); }
    const skippedRanges: SkippedRange[] = header === null || header.highWaterSequence === 0 ? [] : [{ journalId: header.journalId, firstSequence: cursor === null ? 1 : Math.min(header.highWaterSequence, cursor.lastAckedSequence + 1),
      lastSequence: header.highWaterSequence, reason: 'abandonRelease', discharge: null }];
    if (cursor !== null && header !== null && cursor.lastAckedSequence === header.highWaterSequence) { skippedRanges.length = 0; }
    for (const entry of inventory?.records ?? []) {
      if (entry.record.compacted || entry.record.kind === 'handover') { continue; }
      for (const range of entry.record.plan.skippedRanges) {
        if (range.discharge === null && !skippedRanges.some(existing => sameRange(existing, range))) { skippedRanges.push(range); }
      }
    }
    if (skippedRanges.length > 0) { details.push('missingHistoryUndischarged'); }
    return { complete: details.length === 0, details, plan: { mode: 'abandon', abandonedSequences: abandonedSequences.sort((a, b) => a - b), journalId: header?.journalId ?? null,
      skippedRanges, unfinishedRepairs, witness: safety?.recoveryWitness ?? null, witnessUnavailable: safety === null, result: null, completedPhases: [] } };
  }

  private async releaseWitnessProof(operationId: string, witness: RecoveryWitness): Promise<boolean> {
    const k = this.kernel;
    const release = (await this.current(operationId)).record;
    if (release.kind !== 'release' || !releaseNamesWitness(release, witness)) { return false; }
    for (const owner of [witness.owner, ...(witness.successor === null ? [] : [witness.successor])]) {
      const retained = await k.operations.read(owner.operationId);
      if (retained.status !== 'valid') {
        if (release.plan.witness === null) { return false; }
        continue;
      }
      if (retained.value.compacted || retained.value.kind !== 'repair' || retained.value.scopeSha256 !== release.scopeSha256) { return false; }
      if (retained.value.plan.skippedRanges.some(range => range.discharge === null)) { return false; }
      const episode = retained.value.recovery.episodes[owner.episodeOrdinal];
      if (episode?.activationId !== owner.activationId || retained.value.recovery.activeEpisode !== null) { return false; }
      if (releaseNamesOwner(release, owner)) {
        if (episode.phase !== 'abandonedByRelease' || episode.releaseOperationId !== operationId) { return false; }
        continue;
      }
      // Awaiting disclosure is not an unfinished structural repair. Its completed
      // episode stays historical while the recorded witness carries the release duty.
      if (release.plan.witness === null || !sameRecoveryOwner(owner, witness.owner)) { return false; }
      if (episode.phase === 'completed') {
        const accepted = episode.acceptedRecovery;
        const disclosure = witness.disclosure;
        if (accepted === null || disclosure === null || accepted.journalId !== disclosure.journalId || accepted.eventId !== disclosure.eventId
          || accepted.sequence !== disclosure.sequence || accepted.generation !== disclosure.generation) { return false; }
      } else if (episode.phase === 'transferred') {
        if (witness.successor?.operationId !== owner.operationId || episode.successorEpisode !== witness.successor.episodeOrdinal) { return false; }
      } else if (episode.phase !== 'recordRejected') { return false; }
    }
    return true;
  }

  private async reconcileReleaseWitness(operationId: string): Promise<boolean> {
    const k = this.kernel;
    try {
      const safety = await k.safety();
      if (safety.recoveryWitness === null || !await this.releaseWitnessProof(operationId, safety.recoveryWitness)) { return false; }
      return await k.safetyStore.dischargeWitness(safety.recoveryWitness.owner, 'abandoned', { verify: current =>
        current.recoveryWitness === null ? Promise.resolve(false) : this.releaseWitnessProof(operationId, current.recoveryWitness) });
    } catch (error) {
      // The completed release retains its exact proof until fixed authority and
      // publication are available. This never asserts current consumer ownership.
      k.diagnose('releaseWitnessReconciliation', error);
      return false;
    }
  }

  async switch(owner: 'runtime' | 'bridge', abandon: boolean): Promise<CoreResult<ConsumerReceipt>> {
    const k = this.kernel;
    const evidence = owner === 'bridge' ? await this.releaseEvidence() : null;
    if (evidence !== null && !evidence.complete && !abandon) { throw new ReleaseRefusedError(evidence.details); }
    await k.resources.reserve('release', { fullTerminalOperations: 1 });
    const now = utcNow();
    const safety: OperationSafety = { obligationId: newIdentity(), phase: 'pending', correctionId: null };
    const base = { operationVersion: 1 as const, scopeSha256: k.scope.bindingSha256, compacted: false as const, startedAt: now, completedAt: null, outcome: null, safety };
    const operation: HandoverOperation | ReleaseOperation = owner === 'runtime'
      ? { ...base, operationId: newOperationId('handover'), kind: 'handover', cause: 'handover', plan: { owner: 'runtime', result: null, completedPhases: [] } }
      : { ...base, operationId: newOperationId('release'), kind: 'release', cause: 'release', plan: { ...evidence!.plan, mode: abandon ? 'abandon' : 'confirmed' } };
    return this.execute(await k.operations.create(operation), false);
  }

  private async current(operationId: string): Promise<StoredOperation & { record: HandoverOperation | ReleaseOperation }> {
    const read = await this.kernel.operations.read(operationId);
    requireControl(read.status === 'valid' && !read.value.compacted && read.value.kind !== 'repair');
    return { record: read.value, sha256: read.sha256 };
  }

  private async execute(input: StoredOperation, resumed: boolean): Promise<CoreResult<ConsumerReceipt>> {
    const k = this.kernel;
    const id = input.record.operationId;
    let stored = await this.current(id);
    let record = stored.record;
    requireControl(record.completedAt === null);
    await k.resources.reserve('release');
    if (record.kind === 'release' && record.plan.mode === 'confirmed' && resumed) {
      const evidence = await this.releaseEvidence();
      if (!evidence.complete) {
        await k.operations.update(stored, value => ({ ...value, completedAt: utcNow(), outcome: 'refused' }));
        return { success: false, class: 'release', reason: 'release-pending-records', consumptionState: 'none', generationTimestamp: null, warnings: [] };
      }
    }
    const opaque = record.kind === 'release' && record.plan.mode === 'abandon';
    if (resumed || opaque) {
      try {
        const before = await k.safety();
        await this.transferPending();
        if (opaque && (await k.safety()).generation === before.generation) { await k.safetyStore.invalidate('contextUncertain', undefined, record.safety.obligationId); }
      }
      catch { /* The durable consumer intent carries unreadable fixed authority. */ }
      stored = await this.current(id); record = stored.record;
    }
    // A resumed attempt retains any transferred obligation and arms a new one in
    // the fixed safety record when readable. Its operation remains protected.
    const request: CoreRequest = record.kind === 'handover' ? { kind: 'consumer', owner: 'runtime' } : { kind: 'consumer', owner: 'bridge', mode: record.plan.mode };
    const result = await k.checked(request, () => k.core.consumer(request, Deadline.after(120000)), async (result, generation) => {
      if (!result.success && result.class === 'outbox' && result.reason === 'outbox-record-invalid') {
        const invalidated = await k.safetyStore.invalidate('coreRejected');
        requireControl(invalidated.value.correction !== null);
        await k.operations.update(await this.current(id), value => {
          requireControl(value.kind !== 'repair');
          return { ...value, safety: { ...value.safety, phase: 'transferred', correctionId: invalidated.value.correction!.correctionId } };
        });
      }
      const current = await this.current(id);
      if (result.success) {
        await k.operations.update(current, value => {
          requireControl(value.kind !== 'repair');
          return { ...value, plan: { ...value.plan, result: value.plan.result ?? result.value, completedPhases: [...new Set([...value.plan.completedPhases, 'coreSwitched' as const])] } } as FullOperation;
        });
      }
      if (generation !== null && !resumed && !opaque && (result.success || result.reason === 'release-pending-records')) {
        const fresh = await this.current(id);
        await k.operations.update(fresh, value => {
          requireControl(value.kind !== 'repair');
          return { ...value, safety: { ...value.safety, phase: 'discharged', correctionId: null } };
        });
      }
    }, undefined, id);
    if (!result.success) {
      if (result.reason === 'release-pending-records') { await k.operations.update(await this.current(id), value => ({ ...value, completedAt: utcNow(), outcome: 'refused' })); }
      return result;
    }
    stored = await this.current(id); record = stored.record;
    if (record.kind === 'release' && record.plan.mode === 'abandon') { await this.abandon(stored); }
    stored = await this.current(id); record = stored.record;
    if (record.kind === 'handover' && record.plan.result?.previousOwner === 'bridge') {
      const snapshot = await k.journal.read();
      if (snapshot.header.status === 'valid') { await k.storage.write('journal/journal.json', { ...snapshot.header.value, historyVerified: true }, 'config', snapshot.header.sha256); }
      await k.operations.update(stored, value => {
        requireControl(value.kind === 'handover');
        return { ...value, plan: { ...value.plan, completedPhases: [...new Set([...value.plan.completedPhases, 'historyPublished' as const])] } };
      });
    }
    stored = await this.current(id);
    await k.operations.update(stored, value => {
      requireControl(value.kind !== 'repair');
      return { ...value, completedAt: utcNow(), outcome: 'completed', plan: { ...value.plan, completedPhases: [...new Set([...value.plan.completedPhases, 'complete' as const])] } } as FullOperation;
    });
    if (record.kind === 'release' && record.plan.mode === 'abandon') {
      await this.reconcileReleaseWitness(id);
    }
    k.emit({ consumer: result.value.owner === 'runtime' ? 'owner' : 'notOwner' });
    return result;
  }

  private async abandon(input: StoredOperation & { record: HandoverOperation | ReleaseOperation }): Promise<void> {
    const k = this.kernel;
    requireControl(input.record.kind === 'release');
    const id = input.record.operationId;
    const at = utcNow();
    let stored = await this.current(id);
    requireControl(stored.record.kind === 'release');
    const ranges = stored.record.plan.skippedRanges.map(range => ({ ...range, discharge: range.discharge ?? { kind: 'abandonRelease' as const, operationId: id, episodeOrdinal: null, at } }));
    await k.operations.update(stored, value => {
      requireControl(value.kind === 'release');
      return { ...value, plan: { ...value.plan, skippedRanges: ranges } };
    });
    if (stored.record.plan.journalId !== null) {
      const snapshot = await k.journal.read();
      requireControl(snapshot.header.status === 'valid' && snapshot.header.value.journalId === stored.record.plan.journalId);
      const header = snapshot.header.value;
      const cursor = { cursorVersion: 1, journalId: header.journalId, consumerId: 'agent-session', lastAckedSequence: header.highWaterSequence, lastSentSequence: header.highWaterSequence, lastAcceptedRevision: null, updatedAt: at };
      const oldCursor = await k.storage.read('journal/cursor-agent-session.json', 'config', value => value);
      requireControl(oldCursor.status !== 'invalid' || oldCursor.sha256 !== null);
      await k.storage.write('journal/cursor-agent-session.json', cursor, 'config', oldCursor.status === 'absent' ? null : oldCursor.sha256);
      await k.storage.write('journal/journal.json', { ...header, historyVerified: true }, 'config', snapshot.header.sha256);
    }
    for (const item of stored.record.plan.unfinishedRepairs) {
      const source = await k.operations.read(item.operationId);
      if (source.status !== 'valid' || source.value.compacted || source.value.kind !== 'repair') { continue; }
      await k.operations.update({ record: source.value, sha256: source.sha256 }, value => abandonRecovery(requireRepair(value), id, at));
    }
    // The release plan owns the discharge before any inherited carrier changes.
    // A failed carrier write leaves this intent incomplete for the same retry.
    for (const entry of (await k.operations.list()).records) {
      const record = entry.record;
      if (record.compacted || record.kind === 'handover' || record.operationId === id) { continue; }
      if (!record.plan.skippedRanges.some(range => range.discharge === null && ranges.some(owned => sameRange(owned, range)))) { continue; }
      await k.operations.update(entry, value => {
        requireControl(value.kind !== 'handover');
        return { ...value, plan: { ...value.plan, skippedRanges: value.plan.skippedRanges.map(range => range.discharge === null
          ? ranges.find(owned => sameRange(owned, range)) ?? range : range) } } as FullOperation;
      });
    }
    try {
      const safety = await k.safety();
      if (safety.correction?.recoveryOperationId !== null && safety.correction?.recoveryOperationId !== undefined
        && stored.record.plan.unfinishedRepairs.some(item => item.operationId === safety.correction!.recoveryOperationId)) {
        const correction = safety.correction;
        await k.safetyStore.detachAbandonedCorrection(correction.correctionId, correction.recoveryOperationId!, { verify: async () => {
          const predecessor = await k.operations.read(correction.recoveryOperationId!);
          return predecessor.status === 'valid' && !predecessor.value.compacted && predecessor.value.kind === 'repair'
            && predecessor.value.recovery.episodes.at(-1)?.phase === 'abandonedByRelease';
        } });
      }
    } catch { /* Persisted release and operation safety preserve unresolved context. */ }
    stored = await this.current(id);
    await k.operations.update(stored, value => {
      requireControl(value.kind === 'release');
      return { ...value, plan: { ...value.plan, completedPhases: [...new Set([...value.plan.completedPhases, 'cursorAdvanced' as const, 'repairsAbandoned' as const, 'dischargesPublished' as const])] } };
    });
  }
}

function sameRange(left: SkippedRange, right: SkippedRange): boolean {
  return left.journalId === right.journalId && left.firstSequence === right.firstSequence && left.lastSequence === right.lastSequence && left.reason === right.reason;
}
