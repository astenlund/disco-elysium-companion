import { PathInspector } from '../admission.ts';
import { capacityJournalFault, firstCapacityRefusal, type CapacityOwed } from '../capacity.ts';
import { PayloadCodec, type CodecReservation } from '../codec.ts';
import type { RuntimeConfig } from '../config.ts';
import { requireControl } from '../control-values.ts';
import { CoreClient, type CoreRequest, type CoreResult, type PublishReceipt } from '../core-client.ts';
import { Deadline } from '../deadline.ts';
import { FilePublisher } from '../files.ts';
import { readFileHashes } from '../file-hashes.ts';
import type { InstanceGuard } from '../guard.ts';
import type { ProcessIdentities } from '../identity.ts';
import { Journal, type JournalEvent, type JournalSnapshot, type JournalTransaction } from '../journal.ts';
import { eventRewriteMetadata, hasCurrentAcceptance, logicalOutboxSequence, type EventDescription } from '../journal-records.ts';
import { stringifyJson } from '../json.ts';
import { OperationStore, requireRepair, type StoredOperation, type OperationInventory } from '../operations.ts';
import { coreAttemptToken, effectivelyUnfinished, pendingOperationSafety, type RepairCause, type RepairOperation, type RetainedHandoff } from '../operation-records.ts';
import { OperationalObservation } from '../operational.ts';
import { OutboxReader, type OutboxRead } from '../outbox.ts';
import { ProcessSupervisor } from '../process.ts';
import { bindRecoveryEvent, currentAttemptOrdinal } from '../recovery-progress.ts';
import { SafetyStore } from '../safety.ts';
import { SafetyUnavailableError, type StateSafety } from '../safety-records.ts';
import type { RuntimeScope } from '../scope.ts';
import { SessionStore, type SessionBindingProof } from '../session-store.ts';
import { decideSettlement, eventSettlementBinding } from '../settlement.ts';
import { ScopeStorage, type StoredDocument } from '../storage.ts';
import type { BackendOptions, BackendStatus, ProviderIdentity } from './api.ts';
import { ResourceAuthority } from './resources.ts';
import { hasCarryAuthority, hasProviderAuthority } from './provider-authority.ts';
import { mergeHandoff } from './handoffs.ts';
import { allocateUniqueToken } from './tokens.ts';
import { newestState } from './acquisition-policy.ts';

interface SafetyObservation {
  readonly safety: StoredDocument<StateSafety> | null;
  readonly operations: OperationInventory | null;
  readonly stateSafety: BackendStatus['stateSafety'];
  readonly providerAllowed: boolean;
  readonly failure: unknown;
}

export interface KernelInput { readonly config: RuntimeConfig; readonly identities: ProcessIdentities; readonly scope: RuntimeScope; readonly guard: InstanceGuard;
  readonly inspector: PathInspector; readonly supervisor: ProcessSupervisor; readonly publisher: FilePublisher; readonly storage: ScopeStorage; readonly options: BackendOptions; readonly resources: ResourceAuthority }
export interface RepairRequest { readonly cause: RepairCause; readonly journal: JournalSnapshot; readonly rejected?: { readonly name: string; readonly sha256: string }; readonly rejectedEvent?: EventDescription; readonly unboundCarrySha256?: string }

export class Kernel {
  readonly config: RuntimeConfig;
  readonly identities: ProcessIdentities;
  readonly scope: RuntimeScope;
  readonly guard: InstanceGuard;
  readonly inspector: PathInspector;
  readonly supervisor: ProcessSupervisor;
  readonly publisher: FilePublisher;
  readonly storage: ScopeStorage;
  readonly resources: ResourceAuthority;
  readonly operations: OperationStore;
  readonly sessions: SessionStore;
  readonly safetyStore: SafetyStore;
  readonly codec: PayloadCodec;
  readonly journal: Journal;
  readonly outbox: OutboxReader;
  readonly core: CoreClient;
  readonly operational = new OperationalObservation();
  readonly options: BackendOptions;
  status: BackendStatus;
  sentMark = 0;
  closing = false;
  planRecovery!: (request: RepairRequest, deadline?: Deadline) => Promise<StoredOperation>;
  private admission: { request: CoreRequest; token: string | null; operationId: string | null } | null = null;
  private readonly reportedDamage = new Set<string>();
  private adapterMismatch = false;
  private journalObservation: BackendStatus['journal'] = { state: 'healthy', fault: null, unacknowledgedEvents: 0 };

  constructor(input: KernelInput) {
    this.config = input.config; this.identities = input.identities; this.scope = input.scope; this.guard = input.guard; this.inspector = input.inspector;
    this.supervisor = input.supervisor; this.publisher = input.publisher; this.storage = input.storage; this.options = input.options; this.resources = input.resources;
    this.operations = new OperationStore(input.storage, error => this.resources.prospectiveFailure(error), action => this.resources.bind(action));
    this.sessions = new SessionStore(input.storage, { mutation: (action, deadline) => this.resources.sessionMutation(action, deadline),
      bind: action => this.resources.bind(action), prospectiveFailure: error => this.resources.prospectiveFailure(error) });
    this.status = { capacity: this.resources.capacity.current, consumer: 'unknown', freshness: { state: 'unknown', class: null, reason: null, lastGoodGeneratedAt: null, checkedAt: null },
      operational: this.operational.current, stateSafety: { state: 'unavailable', correction: null }, journal: { state: 'healthy', fault: null, unacknowledgedEvents: 0 },
      watcher: input.config.watcher.enabled ? 'stopped' : 'disabled', previousShutdownClean: false };
    this.resources.capacity.subscribe(() => this.emit());
    this.safetyStore = new SafetyStore({ storage: input.storage, bindingGenerations: deadline => this.bindingGenerations(deadline), suppressProvider: reason => this.options.onInvalidated?.(reason) });
    this.codec = new PayloadCodec(input.publisher, (reservation: CodecReservation, deadline?: Deadline) => this.resources.codec(reservation, deadline));
    this.journal = new Journal({ root: input.scope.dataRoot, game: input.scope.game, principal: input.scope.principal, identities: input.identities,
      inspector: input.inspector, publisher: input.publisher, codec: this.codec,
      admitMutation: async (kind, snapshot, deadline) => {
        this.owned();
        const state = await this.safety(deadline);
        if (kind === 'acknowledge' || kind === 'sent') { requireControl(state.pendingCheck === null && await this.providerAuthority(state, deadline)); }
        requireControl(snapshot.header.status === 'valid');
      },
      eventIdAvailable: async (eventId, _, deadline) => !(await this.retainedEventIdentities(deadline)).has(eventId),
    });
    this.outbox = new OutboxReader(input.scope.companionRoot, input.inspector, this.codec);
    this.core = new CoreClient({ companionRoot: input.scope.companionRoot, adapter: input.config.adapter, inspector: input.inspector, supervisor: input.supervisor,
      admit: async (request, deadline) => {
        this.owned();
        const capacityKind = this.resources.assertReservation();
        if (capacityKind === 'ordinary') {
          const refusal = firstCapacityRefusal(this.resources.capacity.current); if (refusal !== null) { throw refusal; }
        }
        const admission = this.admission;
        requireControl(admission !== null && stringifyJson(admission.request) === stringifyJson(request));
        const bounded = deadline instanceof Deadline ? deadline : undefined;
        if (request.kind !== 'consumer') {
          const inventory = await this.operations.list(bounded);
          requireControl(inventory.invalid.length === 0 && !inventory.records.some(entry => !entry.record.compacted && entry.record.kind !== 'repair'
            && (entry.record.completedAt === null || pendingOperationSafety(entry.record))));
        }
        if (admission.token !== null) { requireControl((await this.safety(bounded)).pendingCheck === admission.token); }
        else {
          requireControl(request.kind === 'consumer' && admission.operationId !== null);
          const intent = await this.operations.read(admission.operationId, bounded);
          requireControl(intent.status === 'valid' && !intent.value.compacted && intent.value.kind !== 'repair' && intent.value.safety.phase !== 'discharged');
        }
      } });
  }

  owned(): void { if (!this.guard.held || this.closing) { throw new SafetyUnavailableError('Runtime writer ownership is unavailable.'); } }
  emit(change: Partial<BackendStatus> = {}): void {
    if (change.journal !== undefined) {
      this.journalObservation = change.journal.fault === 'runtimeCapacityExceeded'
        ? { ...this.journalObservation, unacknowledgedEvents: change.journal.unacknowledgedEvents } : change.journal;
    }
    const capacity = this.resources.capacity.current;
    const fault = capacityJournalFault(capacity, this.journalObservation.fault);
    const journal = { ...this.journalObservation, fault, state: fault !== null ? 'fault' as const : this.journalObservation.state === 'fault' ? 'healthy' as const : this.journalObservation.state };
    this.status = Object.freeze({ ...this.status, ...change, capacity, journal, operational: this.operational.current }); this.options.onStatus?.(this.status);
  }
  diagnose(phase: string, error: unknown): void {
    try { this.options.onDiagnostic?.(phase, error); }
    catch { /* Diagnostics cannot replace the classified failure or its obligation. */ }
  }

  async bindingGenerations(deadline?: Deadline): Promise<readonly string[]> {
    const { binding, index } = await this.sessions.readPair(deadline);
    return [...(binding.status === 'valid' ? [binding.value.stateGeneration] : []), ...(index.status === 'valid' ? index.value.sessions.map(entry => entry.stateGeneration) : [])];
  }

  private async retainedEventIdentities(deadline?: Deadline): Promise<Set<string>> {
    const identities = new Set<string>();
    for (const { record } of (await this.operations.list(deadline)).records) {
      if (record.compacted || record.kind !== 'repair') { continue; }
      for (const handoff of record.plan.handoffs) { identities.add(handoff.eventId); }
      for (const attempt of record.recovery.attempts) { if (attempt.journalEvent !== null) { identities.add(attempt.journalEvent.eventId); } }
      for (const episode of record.recovery.episodes) {
        if (episode.acceptedRecovery !== null) { identities.add(episode.acceptedRecovery.eventId); }
        for (const action of episode.prerequisite?.actions ?? []) { if (action.kind === 'appendRecovery' || action.kind === 'preserveRecovery') { identities.add(action.metadata.eventId); } }
      }
    }
    return identities;
  }

  async eventIdentity(snapshot: JournalSnapshot, deadline?: Deadline, reserved: readonly string[] = []): Promise<string> {
    const identities = await this.retainedEventIdentities(deadline);
    for (const event of snapshot.events.values()) { identities.add(event.metadata.eventId); }
    for (const event of snapshot.damaged) { if (event.status === 'valid') { identities.add(event.metadata.eventId); } }
    for (const identity of reserved) { identities.add(identity); }
    return allocateUniqueToken(identities);
  }

  async activationIdentity(deadline?: Deadline): Promise<string> {
    const identities = new Set<string>();
    for (const { record } of (await this.operations.list(deadline)).records) {
      if (!record.compacted && record.kind === 'repair') { for (const episode of record.recovery.episodes) { identities.add(episode.activationId); } }
    }
    const safety = await this.safetyStore.read(deadline);
    if (safety.status === 'valid' && safety.value.recoveryWitness !== null) {
      identities.add(safety.value.recoveryWitness.owner.activationId);
      if (safety.value.recoveryWitness.successor !== null) { identities.add(safety.value.recoveryWitness.successor.activationId); }
    }
    return allocateUniqueToken(identities);
  }

  async safety(deadline?: Deadline): Promise<StateSafety> {
    const value = await this.safetyStore.read(deadline);
    if (value.status !== 'valid') { throw new SafetyUnavailableError('Context safety authority is unavailable.'); }
    return value.value;
  }

  reportPayloadDamage(snapshot: JournalSnapshot, deadline?: Deadline): Promise<void> {
    return this.resources.withTransition('repair', () => this.reportPayloadDamageOwned(snapshot, deadline));
  }
  private async reportPayloadDamageOwned(snapshot: JournalSnapshot, deadline?: Deadline): Promise<void> {
    const safety = await this.safety(deadline);
    const identity = stringifyJson({ fault: snapshot.fault, firstBadSequence: snapshot.firstBadSequence,
      journalId: snapshot.header.status === 'valid' ? snapshot.header.value.journalId : null,
      damaged: snapshot.damaged.map(event => ({ path: event.path, status: event.status, sha256: event.sha256 })) });
    if (this.reportedDamage.has(`${safety.generation}:${identity}`)) { return; }
    const invalidated = await this.safetyStore.invalidate('contextUncertain', deadline);
    await this.planRecovery({ cause: 'contextUncertain', journal: snapshot }, deadline);
    this.reportedDamage.add(`${invalidated.value.generation}:${identity}`);
    if (this.reportedDamage.size > 16) { this.reportedDamage.delete(this.reportedDamage.values().next().value!); }
  }

  async carryHash(deadline?: Deadline): Promise<string | null> {
    const [sha256] = await readFileHashes(this.inspector, this.scope.dataRoot, ['journal/recovery-event.json'], deadline ?? Deadline.after(30000), this.scope.bindingSha256);
    requireControl(sha256 !== undefined);
    return sha256;
  }

  async providerAuthority(state: StateSafety, deadline?: Deadline, admitted?: OperationInventory): Promise<boolean> {
    const inventory = admitted ?? await this.operations.list(deadline);
    return hasProviderAuthority(state, inventory) && hasCarryAuthority(await this.carryHash(deadline), inventory);
  }

  sessionProof(provider: ProviderIdentity): SessionBindingProof {
    return { verify: async (binding, deadline) => {
      if (!this.guard.held || this.closing || !provider.isCurrent() || binding.providerId !== provider.providerId || binding.providerSessionId !== provider.providerSessionId) { return false; }
      const safety = await this.safety(deadline);
      return binding.stateGeneration === safety.generation && await this.providerAuthority(safety, deadline) && provider.isCurrent();
    } };
  }

  async observeSafety(deadline?: Deadline): Promise<SafetyObservation> {
    this.resources.capacity.invalidateOwed(['safetyObligation', 'historyDisclosure', 'protectedHandoffs', 'unfinishedOperations']);
    const capacityEpoch = this.resources.capacity.epoch;
    let safety: StoredDocument<StateSafety> | null = null;
    let operations: OperationInventory | null = null;
    let stateSafety: BackendStatus['stateSafety'] = { state: 'unavailable', correction: null };
    let providerAllowed = false;
    let failure: unknown = null;
    try {
      safety = await this.safetyStore.read(deadline);
      if (safety.status !== 'valid') { return { safety, operations, stateSafety, providerAllowed, failure }; }
      const value = safety.value;
      const correction = value.correction === null ? null : { correctionId: value.correction.correctionId, reason: value.correction.reason };
      stateSafety = { state: 'unavailable', correction };
      operations = await this.operations.list(deadline);
      this.resources.capacity.observeOwed({ unfinishedOperations: operations.invalid.length === 0 ? operations.records.filter(entry => effectivelyUnfinished(entry.record)).length : null }, capacityEpoch);
      const witness = value.recoveryWitness;
      const owner = witness === null ? null : operations.records.find(entry => entry.record.operationId === witness.owner.operationId)?.record;
      const missingWitnessOwner = witness !== null && (witness.phase === 'active' || witness.phase === 'awaitingDisclosure')
        && (owner === undefined || owner === null || owner.compacted || owner.kind !== 'repair' || owner.recovery.episodes[witness.owner.episodeOrdinal]?.activationId !== witness.owner.activationId);
      const missingCorrectionOwner = value.correction?.recoveryOperationId !== null && value.correction?.recoveryOperationId !== undefined
        && !operations.records.some(entry => !entry.record.compacted && entry.record.kind === 'repair' && entry.record.operationId === value.correction!.recoveryOperationId);
      const unwitnessedRoot = witness === null && operations.records.some(entry => !entry.record.compacted && entry.record.kind === 'repair' && entry.record.recovery.activeEpisode !== null);
      if (operations.invalid.length === 0 && !missingWitnessOwner && !missingCorrectionOwner && !unwitnessedRoot && hasCarryAuthority(await this.carryHash(deadline), operations)) {
        const recovering = value.pendingCheck !== null || correction !== null || value.recoveryWitness !== null || operations.records.some(item => pendingOperationSafety(item.record));
        stateSafety = { state: recovering ? 'recovering' : 'ready', correction };
        providerAllowed = hasProviderAuthority(value, operations);
      }
    } catch (error) { failure = error; stateSafety = { state: 'unavailable', correction: stateSafety.correction }; providerAllowed = false; }
    if (safety?.status === 'valid') {
      const value = safety.value;
      const validatedDuty = value.pendingCheck !== null || value.correction !== null || operations?.records.some(entry => pendingOperationSafety(entry.record)) === true;
      this.resources.capacity.observeOwed({ safetyObligation: stateSafety.state === 'unavailable' ? null : validatedDuty ? true : stateSafety.state === 'ready' ? false : null,
        historyDisclosure: stateSafety.state === 'unavailable' ? null : value.recoveryWitness !== null ? true : null }, capacityEpoch);
    }
    return { safety, operations, stateSafety, providerAllowed, failure };
  }

  async observeStatus(_snapshot?: JournalSnapshot, deadline?: Deadline): Promise<void> {
    const { stateSafety } = await this.observeSafety(deadline);
    const capacityEpoch = this.resources.capacity.epoch;
    const journal = await this.journal.read(deadline);
    const count = journal.header.status === 'valid' && journal.cursor.status === 'valid' ? Math.max(0, journal.header.value.highWaterSequence - journal.cursor.value.lastAckedSequence) : 0;
    const cursor = journal.cursor.status === 'valid' ? journal.cursor.value : null;
    const owed: Partial<CapacityOwed> = { unacknowledgedEvents: journal.fault === null && journal.damaged.length === 0 && journal.header.status === 'valid' && cursor !== null
      ? [...journal.events.values()].filter(event => !event.metadata.compacted && event.metadata.sequence > cursor.lastAckedSequence).length : null };
    if (journal.header.status === 'valid' && !journal.header.value.historyVerified) { (owed as { historyDisclosure?: boolean }).historyDisclosure = true; }
    this.resources.capacity.observeOwed(owed, capacityEpoch);
    this.emit({ stateSafety, journal: { ...this.status.journal, unacknowledgedEvents: count } });
  }

  async checked<T>(request: CoreRequest, action: () => Promise<CoreResult<T>>, accept: (result: CoreResult<T>, generation: string | null) => Promise<void>, deadline?: Deadline, operationId: string | null = null, completionDeadline?: () => Deadline): Promise<CoreResult<T>> {
    requireControl(this.admission === null);
    if (this.resources.assertReservation() === 'ordinary') {
      const failure = firstCapacityRefusal(this.resources.capacity.current); if (failure !== null) { throw failure; }
    }
    this.resources.capacity.invalidateOwed();
    let token: string | null = null;
    let generation: string | null = null;
    try {
      const safety = await this.safetyStore.armCheck(deadline);
      token = safety.checkToken; generation = safety.value.generation;
    } catch (error) {
      const capacity = this.resources.captureFailure(error); if (capacity !== null) { throw capacity; }
      if (request.kind !== 'consumer' || operationId === null) { throw error; }
      const intent = await this.operations.read(operationId, deadline);
      requireControl(intent.status === 'valid' && !intent.value.compacted && intent.value.kind !== 'repair' && intent.value.safety.phase !== 'discharged');
    }
    this.admission = { request, token, operationId };
    try {
      const result = await action();
      await accept(result, generation);
      if (token !== null) {
        const capturedToken = token;
        const finished = await this.safetyStore.finishCheck(capturedToken, { verify: async current => {
          // The correlated result remains local to this uninterrupted checked call.
          // Dependent durable writes in accept have completed before this proof.
          await this.supervisor.verifyQuiescent('core');
          return this.admission?.token === capturedToken && current.pendingCheck === capturedToken && this.guard.held;
        } }, completionDeadline?.() ?? deadline);
        requireControl(finished);
      }
      return result;
    } finally { this.admission = null; }
  }

  async publish(requireRecord: boolean, repair: RepairOperation | null, deadline: Deadline, accept?: (result: CoreResult<PublishReceipt>) => Promise<void>, afterChild?: (result: CoreResult<PublishReceipt> | null, terminatedAt: number | null) => Deadline): Promise<CoreResult<PublishReceipt>> {
    const repairOperationId = repair === null ? null : coreAttemptToken(repair.operationId, currentAttemptOrdinal(repair));
    const request: CoreRequest = { kind: 'publish', principal: this.scope.principal, requireRecord, repairOperationId };
    let workDeadline = deadline;
    return this.checked(request, async () => {
      let result: CoreResult<PublishReceipt> | null = null;
      let terminatedAt: number | null = null;
      try { result = await this.core.publish(this.scope.principal, requireRecord, repairOperationId, deadline, at => { terminatedAt = at; }); return result; }
      finally { workDeadline = afterChild?.(result, terminatedAt) ?? deadline; }
    }, async result => {
      this.operational.observe(result);
      if (result.success) { this.emit({ consumer: 'owner' }); }
      else if (['consumer-not-owner', 'consumer-outbox-pending', 'consumer-owner-invalid', 'consumer-owner-unreadable'].includes(result.reason)) { this.emit({ consumer: 'notOwner' }); }
      if (result.success && result.value.game !== this.config.game) {
        this.adapterMismatch = true;
        this.emit({ journal: { ...this.status.journal, state: 'fault', fault: 'adapterMismatch' } });
      }
      if (result.success && repair === null && result.value.game === this.config.game) {
        const snapshot = await this.journal.read(workDeadline);
        const acked = snapshot.cursor.status === 'valid' ? snapshot.cursor.value.lastAckedSequence : 0;
        if ([...snapshot.events.values()].some(event => event.metadata.sequence > acked && (event.metadata.schemaVersion !== result.value.schemaVersion || event.metadata.adapterVersion !== result.value.adapterVersion))) {
          await this.planRecovery({ cause: 'versionChange', journal: snapshot }, workDeadline);
        }
      }
      if (!result.success && result.class === 'outbox' && result.reason === 'outbox-record-invalid') {
        await this.safetyStore.invalidate('coreRejected', workDeadline);
        const snapshot = await this.journal.read(workDeadline);
        await this.planRecovery({ cause: 'coreRejected', journal: snapshot }, workDeadline);
      }
      await accept?.(result);
    }, deadline, null, () => workDeadline);
  }

  private async handoffs(inventory: OperationInventory, deadline?: Deadline): Promise<readonly RetainedHandoff[]> {
    if (inventory.invalid.length > 0) { throw new SafetyUnavailableError('Operation handoff authority is damaged.'); }
    if (inventory.handoffCount === 0) { return []; }
    const generation = (await this.safety(deadline)).generation;
    const values = new Map<string, RetainedHandoff>();
    for (const entry of inventory.records) {
      if (entry.record.compacted || entry.record.kind !== 'repair') { continue; }
      for (const handoff of entry.record.plan.handoffs) {
        const key = handoff.logicalOutboxId;
        const previous = values.get(key);
        values.set(key, previous === undefined ? handoff : mergeHandoff(previous, handoff, generation));
      }
    }
    return [...values.values()];
  }

  async drain(deadline: Deadline, owningRepair: string | null = null): Promise<JournalSnapshot> {
    this.owned();
    const operations = await this.operations.list(deadline);
    requireControl(operations.invalid.length === 0);
    const unfinished = operations.records.filter(item => !item.record.compacted && item.record.kind === 'repair' && effectivelyUnfinished(item.record));
    requireControl(unfinished.length <= 1);
    const mayAppend = unfinished.length === 0 || unfinished[0]!.record.operationId === owningRepair;
    const blockedPrerequisite = !mayAppend && unfinished.some(entry => {
      const repair = requireRepair(entry.record);
      const episode = repair.recovery.activeEpisode === null ? null : repair.recovery.episodes[repair.recovery.activeEpisode];
      return episode?.prerequisite !== null && episode?.prerequisite !== undefined && episode.prerequisite.nextAction < episode.prerequisite.actions.length;
    });
    if (blockedPrerequisite) { return this.journal.read(deadline); }
    const handoffs = await this.handoffs(operations, deadline);
    const sources = new Set<string>();
    let pendingFault: string | null = this.adapterMismatch ? 'adapterMismatch' : null;
    let neededRepair: RepairRequest | null = null;
    const result = await this.journal.transact(async transaction => {
      let snapshot = await transaction.recoverHighWater();
      if (snapshot.fault !== null || snapshot.damaged.length > 0) { throw new SafetyUnavailableError('Journal requires structural recovery.'); }
      {
        for (const name of await this.outbox.list(deadline)) {
          const record = await this.outbox.read(name, deadline);
          if (record.status === 'absent') { continue; }
          if (record.status === 'invalid') { neededRepair = { cause: 'outboxInvalid', journal: transaction.snapshot(), rejected: record }; break; }
          if (record.metadata.game !== this.scope.game || record.metadata.principal !== this.scope.principal) { pendingFault ??= 'foreignRecord'; break; }
          const handoff = handoffs.find(item => item.logicalOutboxId === record.metadata.logicalOutboxId);
          const existing = [...transaction.snapshot().events.values()].find(item => item.metadata.logicalOutboxId === record.metadata.logicalOutboxId);
          if (handoff !== undefined && handoff.recordSha256 !== record.sha256 || existing !== undefined && existing.metadata.recordSha256 !== record.sha256) { pendingFault = 'outboxConflict'; break; }
          if (!mayAppend && existing === undefined) { continue; }
          sources.add(record.metadata.logicalOutboxId);
          if (handoff !== undefined && handoff.presentation !== 'replayable') { continue; }
          if (!mayAppend) { continue; }
          if (existing === undefined) {
            const before = transaction.snapshot();
            if (owningRepair === null && before.header.status === 'valid' && !before.header.value.historyVerified && before.header.value.highWaterSequence === 0) {
              neededRepair = { cause: 'lostJournal', journal: before };
              break;
            }
            let appended = await transaction.append(record.bytes, record.metadata.sequence);
            if (handoff !== undefined) {
              requireControl(handoff.payloadBindingSha256 !== null && handoff.payloadBindingSha256 === appended.metadata.payloadBindingSha256);
              appended = await transaction.rewrite(appended, current => ({ ...eventRewriteMetadata(current), acceptance: handoff.acceptance, attemptRef: handoff.attemptRef }));
            }
            if (owningRepair !== null && record.metadata.kind === 'resync') { await this.associateRecovery(transaction, appended, record, owningRepair, deadline); }
          } else if (owningRepair !== null && record.metadata.kind === 'resync') {
            await this.associateRecovery(transaction, existing, record, owningRepair, deadline);
          }
        }
      }
      snapshot = transaction.snapshot();
      const targets = new Map<string, { event: JournalEvent | null; handoff: RetainedHandoff | null }>();
      const selectedGeneration = (await this.safety(deadline)).generation;
      const chosenState = newestState(snapshot)?.metadata.eventId;
      requireControl(snapshot.cursor.status === 'valid');
      const acknowledgedThrough = snapshot.cursor.value.lastAckedSequence;
      for (const event of snapshot.events.values()) {
        const required = !event.metadata.compacted && (event.metadata.sequence > acknowledgedThrough || event.metadata.eventId === chosenState);
        if (sources.has(event.metadata.logicalOutboxId) || required && (event.metadata.settlement !== 'accepted' || !hasCurrentAcceptance(event.metadata, selectedGeneration))) {
          targets.set(event.metadata.logicalOutboxId, { event, handoff: handoffs.find(item => item.logicalOutboxId === event.metadata.logicalOutboxId) ?? null });
        }
      }
      for (const handoff of handoffs) { if (sources.has(handoff.logicalOutboxId) && !targets.has(handoff.logicalOutboxId)) { targets.set(handoff.logicalOutboxId, { event: null, handoff }); } }
      for (const target of [...targets.values()].sort((left, right) => logicalOutboxSequence((left.event?.metadata ?? left.handoff!).logicalOutboxId)! - logicalOutboxSequence((right.event?.metadata ?? right.handoff!).logicalOutboxId)!)) {
        deadline.check();
        const current = target.event === null ? null : transaction.snapshot().events.get(target.event.metadata.sequence)!;
        const retained = target.handoff;
        const binding = retained === null ? eventSettlementBinding(current!.metadata) : { logicalOutboxId: retained.logicalOutboxId, recordSha256: retained.recordSha256, journalId: retained.journalId, eventId: retained.eventId };
        let proceed = true;
        await this.checked({ kind: 'settlement', binding }, () => this.core.settle(binding, deadline), async (result, generation) => {
          requireControl(generation !== null);
          const decision = decideSettlement(current?.metadata ?? null, binding, result, generation, retained?.presentation ?? 'replayable');
          if (decision.kind === 'outboxInvalid') {
            await this.safetyStore.invalidate('coreRejected', deadline);
            await this.planRecovery({ cause: 'coreRejected', journal: transaction.snapshot(), ...(current === null ? {} : { rejectedEvent: current.metadata }) }, deadline);
            proceed = false;
            return;
          }
          if (decision.kind === 'conflict') { pendingFault = 'outboxConflict'; proceed = false; return; }
          if (current === null) {
            if (decision.kind === 'quarantined' && retained?.presentation !== 'rejected') {
              await this.safetyStore.invalidate('coreRejected', deadline);
              await this.planRecovery({ cause: 'coreRejected', journal: transaction.snapshot() }, deadline);
              proceed = false;
            }
            if (decision.kind === 'retry') { proceed = false; }
            return;
          }
          if (decision.kind === 'accept' || decision.kind === 'unknown') {
            await transaction.rewrite(current, () => decision.metadata);
            if (decision.kind === 'unknown' && !decision.currentEvidence) {
              await this.planRecovery({ cause: 'settlementUnverified', journal: transaction.snapshot(), rejectedEvent: current.metadata }, deadline);
              proceed = false;
            }
          } else if (decision.kind === 'quarantined') {
            if (retained?.presentation === 'rejected' && current.metadata.acceptance?.generation !== generation) { return; }
            await this.safetyStore.invalidate('coreRejected', deadline);
            await this.planRecovery({ cause: 'coreRejected', journal: transaction.snapshot(), rejectedEvent: current.metadata }, deadline);
            proceed = false;
          } else if (decision.kind === 'retry') { proceed = false; }
        }, deadline);
        if (!proceed) { break; }
      }
      return transaction.snapshot();
    }, deadline);
    if (neededRepair !== null) { await this.planRecovery(neededRepair, deadline); }
    this.emit({ journal: { state: pendingFault === null ? 'healthy' : 'fault', fault: pendingFault, unacknowledgedEvents: result.header.status === 'valid' && result.cursor.status === 'valid' ? result.header.value.highWaterSequence - result.cursor.value.lastAckedSequence : 0 } });
    return result;
  }

  private async associateRecovery(transaction: JournalTransaction, event: JournalEvent, source: Extract<OutboxRead, { status: 'valid' }>, operationId: string, deadline: Deadline): Promise<void> {
    const current = await this.operations.read(operationId, deadline);
    requireControl(current.status === 'valid');
    const repair = requireRepair(current.value);
    const ordinal = currentAttemptOrdinal(repair);
    const selected = repair.recovery.attempts[ordinal]!.selectedRecord;
    if (selected?.logicalOutboxId !== source.metadata.logicalOutboxId || selected.recordSha256 !== source.sha256) { return; }
    requireControl(source.metadata.repairOperationId === coreAttemptToken(operationId, ordinal));
    const associated = await transaction.rewrite(event, metadata => ({ ...eventRewriteMetadata(metadata), attemptRef: { operationId, attemptOrdinal: ordinal } }));
    await this.operations.update({ record: repair, sha256: current.sha256 }, value => bindRecoveryEvent(requireRepair(value), associated.metadata), deadline);
  }
}
