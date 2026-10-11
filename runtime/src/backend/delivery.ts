import { requireControl } from '../control-values.ts';
import { capacityTransitions, firstCapacityRefusal, RuntimeCapacityError, type CapacityStatus } from '../capacity.ts';
import { Deadline, DeadlineExceededError } from '../deadline.ts';
import type { CoreResult, PublishReceipt } from '../core-client.ts';
import { hasCurrentAcceptance } from '../journal-records.ts';
import { SentMarkPublicationError, type JournalEvent, type JournalSnapshot } from '../journal.ts';
import { isObject, stringifyJson, utcNow } from '../json.ts';
import { effectivelyUnfinished } from '../operation-records.ts';
import { operationallyCurrent } from '../operational.ts';
import { ContextPreparer, type ContextCandidate, type ContextPreview, type PreparedContext } from '../prepared-context.ts';
import { SafetyUnavailableError, type StateSafety } from '../safety-records.ts';
import type { OperationInventory } from '../operations.ts';
import type { AgentSessionBinding } from '../session-records.ts';
import type { BoundSession } from '../session-store.ts';
import { bytesHash } from '../storage.ts';
import { recoveryFingerprint } from '../window-recovery.ts';
import { PendingStateCheckError, type AcknowledgementOptions, type BackendInteraction, type DeliveryHandle, type DeliveryPreview, type DeliverySnapshot, type Freshness, type ProviderIdentity, type SendContext } from './api.ts';
import { Kernel } from './kernel.ts';
import { reconcileAcknowledgedRecovery } from './recovery-disclosure.ts';
import { acquireWithPolicy, newestState } from './acquisition-policy.ts';

interface SnapshotState { readonly public: DeliverySnapshot; readonly events: readonly JournalEvent[]; readonly state: JournalEvent | null; readonly journalId: string | null; readonly cursor: number; readonly sent: number; readonly safetySha256: string; readonly correction: { readonly correctionId: string; readonly reason: string } | null; readonly awaitingDisclosure: boolean }
interface PreviewState { readonly snapshot: SnapshotState; readonly binding: AgentSessionBinding; readonly request: Record<string, unknown>; readonly relevanceFingerprint: string }
interface OpaqueFallback { readonly text: string; readonly candidate: ContextCandidate }
interface HandleState extends PreviewState { optionalMarkCapacity?: CapacityStatus; markAttempted?: boolean; relevanceFingerprint: string; prepared: PreparedContext; candidate: ContextCandidate; fallback: OpaqueFallback | null; forceRedelivery: boolean; disclosure: boolean; sent: boolean; discarded: boolean }

function contextRelevance(preview: ContextPreview, fallback: string): string {
  const candidate = preview.candidates.find(item => item.stateIncluded) ?? preview.candidates[0];
  return candidate?.fingerprint ?? fallback;
}

export class DeliveryCoordinator {
  private readonly kernel: Kernel;
  private readonly preparer: ContextPreparer;
  private readonly snapshots = new WeakMap<DeliverySnapshot, SnapshotState>();
  private readonly previews = new WeakMap<DeliveryPreview, PreviewState>();
  private readonly handles = new WeakMap<DeliveryHandle, HandleState>();
  private currentSnapshot: SnapshotState | null = null;
  private pendingDamage: JournalSnapshot | null = null;
  private activeHandle: HandleState | null = null;
  private readonly maintainStorage: () => Promise<void>;

  constructor(kernel: Kernel, maintainStorage: () => Promise<void>) {
    this.kernel = kernel;
    this.maintainStorage = maintainStorage;
    this.preparer = new ContextPreparer({ scope: kernel.scope, publisher: kernel.publisher,
      reserve: reservation => kernel.resources.workspace(reservation.inputBytes, reservation.maximumOutputBytes),
      admit: async (request, deadline) => {
        if (!isObject(request) || !kernel.guard.held || kernel.closing) { return false; }
        const safety = await kernel.safetyStore.read(deadline);
        if (safety.status !== 'valid' || safety.sha256 !== request['safetySha256'] || safety.value.generation !== request['generation']) { return false; }
        const operations = await kernel.operations.list(deadline);
        if (!await kernel.providerAuthority(safety.value, deadline, operations)) { return false; }
        const snapshot = this.currentSnapshot;
        if (snapshot === null || !isObject(request['template']) || request['template']['interactionId'] !== snapshot.public.interaction.interactionId) { return false; }
        if (request['disclosure'] === true) { return true; }
        return this.dependenciesCurrent(snapshot, deadline, { safety: safety.value, operations });
      } });
  }

  private async dependenciesCurrent(snapshot: SnapshotState, deadline?: Deadline, admitted?: { readonly safety: StateSafety; readonly operations: OperationInventory }): Promise<boolean> {
    const k = this.kernel;
    const safety = admitted?.safety ?? await k.safety(deadline);
    const operations = admitted?.operations ?? await k.operations.list(deadline);
    if (safety.generation !== snapshot.public.generation || !await k.providerAuthority(safety, deadline, operations)) { return false; }
    if (operations.records.some(entry => effectivelyUnfinished(entry.record))) { return false; }
    const current = await k.journal.read(deadline);
    if (current.fault !== null || current.damaged.length > 0) { this.pendingDamage = current; return false; }
    if (current.header.status !== 'valid' || current.cursor.status !== 'valid'
      || current.header.value.journalId !== snapshot.journalId || current.cursor.value.lastAckedSequence !== snapshot.cursor) { return false; }
    const newest = newestState(current);
    if ((newest?.metadata.eventId ?? null) !== (snapshot.state?.metadata.eventId ?? null)) {
      if (snapshot.state !== null && !current.events.has(snapshot.state.metadata.sequence)) { this.pendingDamage = current; }
      return false;
    }
    return [...snapshot.events, ...(snapshot.state === null ? [] : [snapshot.state])].every(event => {
      const actual = current.events.get(event.metadata.sequence);
      if (actual === undefined) { this.pendingDamage = current; }
      return actual?.sha256 === event.sha256 && actual.metadata.eventId === event.metadata.eventId && hasCurrentAcceptance(actual.metadata, safety.generation);
    });
  }

  private async invalidateObservedDamage(): Promise<void> {
    const snapshot = this.pendingDamage;
    if (snapshot === null) { return; }
    this.pendingDamage = null;
    const prepared = this.preparer.current;
    if (prepared !== null) {
      try { await this.preparer.discard(prepared); if (this.activeHandle?.prepared === prepared) { this.activeHandle.discarded = true; } }
      catch (error) { this.kernel.diagnose('damagedContextCleanup', error); }
    }
    await this.kernel.reportPayloadDamage(snapshot);
  }

  private async prepareOperation<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      // Admission is read-only. Persist its damage observation only after the
      // preparer has released publication ownership and its rejected operation.
      await this.invalidateObservedDamage();
      throw error;
    }
  }

  async acquire(interaction: BackendInteraction): Promise<DeliverySnapshot> {
    const k = this.kernel;
    k.owned();
    this.requireCapacity();
    try { await k.resources.reserve('ordinary', { uncompactedEvents: 1 }); }
    catch (error) {
      if (!(error instanceof RuntimeCapacityError)) { throw error; }
      await this.maintainStorage();
      await k.resources.reserve('ordinary', { uncompactedEvents: 1 });
    }
    this.requireCapacity();
    const knownFault = k.status.journal.fault;
    if (knownFault === null) { k.emit({ freshness: { ...k.status.freshness, state: 'acquiring', checkedAt: null } }); }
    let receipt: CoreResult<PublishReceipt> | null = null;
    let journal: JournalSnapshot | null = null;
    let failure: { class: string; reason: string } | null = null;
    let gate: Deadline | null = null;
    let capacityFailure: RuntimeCapacityError | null = null;
    try {
      const acquired = await acquireWithPolicy({ game: k.config.game, fault: () => k.status.journal.fault,
        readJournal: async () => {
          const snapshot = await k.journal.read();
          if (snapshot.fault !== null || snapshot.damaged.length > 0) { await k.reportPayloadDamage(snapshot); }
          return snapshot;
        },
        publish: (requireRecord, deadline, afterChild) => k.publish(requireRecord, null, deadline, undefined, afterChild), onGate: established => { gate = established; },
      });
      receipt = acquired.receipt; gate = acquired.gate;
      if (acquired.skippedFault !== null) { k.operational.unavailable(); failure = { class: 'journal', reason: acquired.skippedFault }; }
    } catch (error) {
      capacityFailure = k.resources.captureFailure(error) ?? capacityFailure;
      k.diagnose('acquisition', error);
      k.operational.unavailable();
      failure = { class: 'supervisor', reason: typeof error === 'object' && error !== null && 'reason' in error ? String(error.reason) : 'result-invalid' };
    }
    // This is the only post-acquisition settlement budget for the interaction.
    gate ??= Deadline.after(120000);
    try { journal = await k.drain(gate); }
    catch (error) {
      capacityFailure = k.resources.captureFailure(error) ?? capacityFailure;
      k.diagnose('interactionDrain', error); failure ??= { class: 'journal', reason: error instanceof DeadlineExceededError ? 'settlementPending' : 'journalUnavailable' };
    }
    if (journal === null) { try { journal = await k.journal.read(gate); } catch { /* No state authority is substituted. */ } }
    // The settlement gate is now closed. Read-only safety admission for a frozen
    // disclosure never starts another settlement or extends that gate.
    const authority = await k.observeSafety();
    const { safety, operations, stateSafety } = authority;
    if (stateSafety.state === 'recovering' && safety?.status === 'valid' && safety.value.pendingCheck !== null) {
      k.emit({ stateSafety, freshness: { ...k.status.freshness, state: 'failed', class: 'journal', reason: 'settlementPending', checkedAt: utcNow() } });
      throw new PendingStateCheckError();
    }
    if (capacityFailure !== null) { throw capacityFailure; }
    if (safety?.status !== 'valid' || operations === null || !authority.providerAllowed) {
      k.emit({ stateSafety, freshness: { ...k.status.freshness, state: 'failed', class: 'journal', reason: 'contextUnavailable', checkedAt: utcNow() } });
      throw new SafetyUnavailableError('State context is unavailable until durable safety reconciliation.', { cause: authority.failure });
    }
    const acked = journal?.cursor.status === 'valid' ? journal.cursor.value.lastAckedSequence : 0;
    const unacknowledged = journal === null ? [] : [...journal.events.values()].filter(event => event.metadata.sequence > acked);
    const state = journal === null ? null : newestState(journal);
    const blocked = journal === null || journal.fault !== null || journal.damaged.length > 0 || operations.invalid.length > 0 || operations.records.some(entry => effectivelyUnfinished(entry.record))
      || [...unacknowledged, ...(state === null ? [] : [state])].some(event => !hasCurrentAcceptance(event.metadata, safety.value.generation));
    if (receipt !== null && !receipt.success) { failure = { class: receipt.class, reason: receipt.reason }; }
    if (receipt?.success && receipt.value.game !== k.config.game) { failure = { class: 'journal', reason: 'adapterMismatch' }; }
    if (k.status.journal.fault !== null) { failure = { class: 'journal', reason: k.status.journal.fault }; }
    const matches = receipt?.success === true && state !== null && receipt.value.targetIdentitySha256 === state.metadata.targetIdentitySha256;
    if (blocked || !matches || !operationallyCurrent(k.operational.current)) { failure ??= { class: 'journal', reason: 'settlementPending' }; }
    const freshness: Freshness = { state: failure === null ? 'fresh' : 'failed', class: failure?.class ?? null, reason: failure?.reason ?? null,
      lastGoodGeneratedAt: state?.metadata.stateGeneratedAt ?? k.status.freshness.lastGoodGeneratedAt, checkedAt: utcNow() };
    const disclosureOnly = blocked || !matches || !operationallyCurrent(k.operational.current) || failure !== null;
    const publicValue: DeliverySnapshot = Object.freeze({ interaction: Object.freeze({ ...interaction }), generation: safety.value.generation, disclosureOnly, freshness: Object.freeze(freshness),
      relevanceFingerprint: recoveryFingerprint(safety.value.generation, state?.metadata.payloadBindingSha256 ?? '', ...unacknowledged.map(event => event.metadata.payloadBindingSha256)) });
    const internal: SnapshotState = { public: publicValue, events: disclosureOnly ? [] : unacknowledged, state: disclosureOnly ? null : state,
      journalId: journal?.header.status === 'valid' ? journal.header.value.journalId : null, cursor: journal?.cursor.status === 'valid' ? journal.cursor.value.lastAckedSequence : 0,
      sent: journal?.cursor.status === 'valid' ? Math.max(journal.cursor.value.lastSentSequence, k.sentMark) : k.sentMark, safetySha256: safety.sha256,
      correction: safety.value.correction === null ? null : { correctionId: safety.value.correction.correctionId, reason: safety.value.correction.reason },
      awaitingDisclosure: safety.value.recoveryWitness?.phase === 'awaitingDisclosure' };
    this.snapshots.set(publicValue, internal); this.currentSnapshot = internal;
    k.emit({ freshness, consumer: receipt !== null && !receipt.success && receipt.reason.startsWith('consumer-') ? 'notOwner' : receipt?.success ? 'owner' : k.status.consumer });
    await k.observeStatus(journal ?? undefined);
    return publicValue;
  }

  async preview(snapshot: DeliverySnapshot, binding: AgentSessionBinding, halfPrefixBytes: number | null, providerFingerprint?: string): Promise<DeliveryPreview> {
    this.requireCapacity();
    const source = this.snapshots.get(snapshot);
    requireControl(source !== undefined && source === this.currentSnapshot && binding.stateGeneration === snapshot.generation);
    const k = this.kernel;
    const wanted = source.events.length > 0 || binding.turnsCompleted === 0 || binding.needsState || source.correction !== null;
    const request: Record<string, unknown> = { contextRequestVersion: 1, scopeSha256: k.scope.bindingSha256, safetySha256: source.safetySha256, generation: snapshot.generation,
      journalId: source.journalId, game: k.scope.game, principal: k.scope.principal,
      template: { companionTurnContextVersion: 1, interactionId: snapshot.interaction.interactionId, requestReceivedAt: snapshot.interaction.requestReceivedAt, sessionOpening: binding.turnsCompleted === 0,
        freshness: { state: snapshot.freshness.state === 'fresh' ? 'fresh' : 'failed', class: snapshot.freshness.class, reason: snapshot.freshness.reason, lastGoodGeneratedAt: snapshot.freshness.lastGoodGeneratedAt },
        operational: k.operational.current, correction: source.correction },
      events: source.events.map(event => ({ sequence: event.metadata.sequence, sha256: event.sha256, redelivery: event.metadata.sequence <= source.sent })),
      state: wanted && source.state !== null ? { sequence: source.state.metadata.sequence, sha256: source.state.sha256 } : null, stateWanted: wanted, shape: null,
      failedBlockBytes: halfPrefixBytes === null ? null : Math.min(4194304, halfPrefixBytes * 2), instructionsSha256: binding.instructionsSha256,
      providerFingerprint: providerFingerprint ?? recoveryFingerprint(k.config.provider.model ?? '', k.config.provider.effort ?? ''), disclosure: snapshot.disclosureOnly };
    const candidates = await this.prepareOperation(() => this.preparer.preview(request));
    const preview = Object.freeze({ preview: candidates, relevanceFingerprint: contextRelevance(candidates, snapshot.relevanceFingerprint) });
    this.previews.set(preview, { snapshot: source, binding: Object.freeze({ ...binding }), request, relevanceFingerprint: preview.relevanceFingerprint });
    return preview;
  }

  async prepare(snapshot: DeliverySnapshot, preview: DeliveryPreview, candidate: ContextCandidate): Promise<DeliveryHandle> {
    this.requireCapacity();
    const state = this.previews.get(preview);
    requireControl(state !== undefined && state.snapshot.public === snapshot && preview.preview.candidates.includes(candidate));
    const variants = await this.prepareVariants(preview.preview, candidate);
    const { prepared, contextBlock } = variants;
    const handle = Object.freeze({ prepared, candidate, snapshot, contextBlock });
    const active = { ...state, prepared, candidate: variants.candidate, fallback: variants.fallback, forceRedelivery: false, disclosure: snapshot.disclosureOnly, sent: false, discarded: false };
    this.handles.set(handle, active); this.activeHandle = active;
    return handle;
  }

  private async prepareVariants(preview: ContextPreview, candidate: ContextCandidate): Promise<{ prepared: PreparedContext; candidate: ContextCandidate; contextBlock: string; fallback: OpaqueFallback }> {
    const prepared = await this.prepareOperation(() => this.preparer.prepare(preview, candidate));
    const variants = await this.prepareOperation(() => this.preparer.copyVariantsForSend(prepared));
    const alternate = variants.redeliveryCandidate;
    requireControl(alternate.fingerprint === candidate.fingerprint && alternate.eventCount === candidate.eventCount && alternate.stateIncluded === candidate.stateIncluded && alternate.degraded === candidate.degraded);
    const fallback = Object.freeze({ text: variants.redeliveryText, candidate: alternate });
    return { prepared, candidate, contextBlock: variants.text, fallback };
  }

  async markSent(handle: DeliveryHandle): Promise<boolean> {
    const state = this.handles.get(handle);
    requireControl(state !== undefined && !state.discarded && !state.sent);
    this.requireCapacity();
    requireControl(!state.markAttempted); state.markAttempted = true;
    if (state.disclosure) { return true; }
    const sent = state.snapshot.events.slice(0, state.candidate.eventCount).map(event => event.metadata);
    this.kernel.sentMark = Math.max(this.kernel.sentMark, sent.at(-1)?.sequence ?? 0);
    try { await this.kernel.journal.markSent(sent, handle.snapshot.generation); return true; }
    catch (error) {
      if (!(error instanceof SentMarkPublicationError) || !this.kernel.guard.held) { throw error; }
      if (this.kernel.resources.captureFailure(error.cause) !== null) { state.optionalMarkCapacity = this.kernel.resources.capacity.current; }
      state.forceRedelivery = true;
      return false;
    }
  }

  async copyForSend(handle: DeliveryHandle, binding: AgentSessionBinding, provider: ProviderIdentity): Promise<SendContext> {
    const state = this.handles.get(handle);
    requireControl(state !== undefined && !state.sent && !state.discarded && state.snapshot === this.currentSnapshot);
    const k = this.kernel;
    this.requireCapacity(state);
    if (binding.providerId !== state.binding.providerId || binding.providerSessionId !== state.binding.providerSessionId || binding.instructionsSha256 !== state.binding.instructionsSha256) {
      throw new SafetyUnavailableError('Prepared context belongs to a different logical provider binding.');
    }
    if (!await k.sessionProof(provider).verify(binding)) { throw new SafetyUnavailableError('Provider binding is no longer current.'); }
    const bound = await k.sessions.ready(k.sessionProof(provider));
    requireControl(bound !== null && stringifyJson(bound.binding) === stringifyJson(binding));
    const current = state.disclosure || await this.dependenciesCurrent(state.snapshot);
    if (this.pendingDamage !== null) { await this.invalidateObservedDamage(); throw new SafetyUnavailableError('Persisted payload damage invalidated this provider context.'); }
    const wanted = state.snapshot.events.length > 0 || binding.turnsCompleted === 0 || binding.needsState || state.snapshot.correction !== null;
    const bindingChanged = wanted !== state.request['stateWanted'] || (binding.turnsCompleted === 0) !== (state.binding.turnsCompleted === 0);
    if (state.forceRedelivery) {
      if (!current || bindingChanged || state.fallback === null) { throw new SafetyUnavailableError('The prepared redelivery fallback no longer satisfies current dependencies.'); }
      await k.supervisor.verifyQuiescent('publication');
      await k.supervisor.verifyQuiescent('core');
      if (!k.guard.held || !provider.isCurrent() || !await k.sessionProof(provider).verify(binding) || !await this.dependenciesCurrent(state.snapshot)) {
        await this.invalidateObservedDamage();
        throw new SafetyUnavailableError('Redelivery fallback lost its send authority.');
      }
      requireControl(bytesHash(Buffer.from(state.fallback.text, 'utf8')) === state.fallback.candidate.sha256);
      state.candidate = state.fallback.candidate;
      this.requireCapacity(state);
      state.sent = true;
      return { text: state.fallback.text, candidate: state.candidate, relevanceFingerprint: state.relevanceFingerprint, disclosureOnly: state.disclosure, redelivery: state.candidate.eventCount > 0 };
    }
    if (!current || bindingChanged) {
      await this.preparer.discard(state.prepared);
      const safety = await k.safetyStore.read();
      requireControl(safety.status === 'valid' && safety.value.generation === handle.snapshot.generation);
      const request: Record<string, unknown> = { ...state.request, safetySha256: safety.sha256 };
      if (!current) {
        const template = request['template'] as Record<string, unknown>;
        request['template'] = { ...template, freshness: { state: 'failed', class: 'journal', reason: 'settlementPending', lastGoodGeneratedAt: handle.snapshot.freshness.lastGoodGeneratedAt } };
        request['events'] = []; request['state'] = null; request['disclosure'] = true; request['shape'] = null; state.disclosure = true;
      } else {
        if (bindingChanged) {
          request['stateWanted'] = wanted;
          request['state'] = wanted && !state.disclosure && state.snapshot.state !== null ? { sequence: state.snapshot.state.metadata.sequence, sha256: state.snapshot.state.sha256 } : null;
          request['template'] = { ...(request['template'] as Record<string, unknown>), sessionOpening: binding.turnsCompleted === 0 };
        }
      }
      const preview = await this.prepareOperation(() => this.preparer.preview(request));
      const candidate = state.disclosure ? preview.candidates[0] : preview.candidates.find(item => item.shape >= state.candidate.shape);
      requireControl(candidate !== undefined);
      const variants = await this.prepareVariants(preview, candidate);
      state.relevanceFingerprint = contextRelevance(preview, state.relevanceFingerprint);
      state.prepared = variants.prepared; state.candidate = variants.candidate; state.fallback = variants.fallback;
    }
    const text = await this.prepareOperation(() => this.preparer.copyForSend(state.prepared));
    if (!provider.isCurrent()) { throw new SafetyUnavailableError('Provider identity changed before input.'); }
    this.requireCapacity(state);
    state.sent = true;
    return { text, candidate: state.candidate, relevanceFingerprint: state.relevanceFingerprint, disclosureOnly: state.disclosure, redelivery: !state.disclosure && state.candidate.eventCount > 0
      && (state.forceRedelivery || state.snapshot.events.slice(0, state.candidate.eventCount).some(event => event.metadata.sequence <= state.snapshot.sent)) };
  }

  private requireCapacity(state?: HandleState): void {
    const current = this.kernel.resources.capacity.current;
    const failure = firstCapacityRefusal(current);
    if (failure === null) { return; }
    const optional = state?.optionalMarkCapacity;
    if (state !== undefined && optional !== undefined && state.forceRedelivery && !state.sent && capacityTransitions.every(kind => current[kind].state !== 'unavailable'
      && current[kind].state !== 'exhausted' || current[kind] === optional[kind])) { return; }
    throw failure;
  }

  async discard(handle: DeliveryHandle): Promise<void> {
    const state = this.handles.get(handle);
    requireControl(state !== undefined);
    if (state.discarded) { return; }
    await this.preparer.discard(state.prepared); state.discarded = true;
    state.fallback = null;
    if (this.activeHandle === state) { this.activeHandle = null; }
  }

  async acknowledge(handle: DeliveryHandle, binding: AgentSessionBinding, provider: ProviderIdentity, options: AcknowledgementOptions): Promise<BoundSession | null> {
    const state = this.handles.get(handle);
    requireControl(state !== undefined && state.sent);
    const k = this.kernel;
    if (state.disclosure || !await k.sessionProof(provider).verify(binding)) { return null; }
    if (!await this.dependenciesCurrent(state.snapshot)) { await this.invalidateObservedDamage(); return null; }
    let currentBinding = binding;
    const candidate = state.candidate;
    if (candidate.degraded === 'stateTooLarge') {
      currentBinding = { ...binding, needsState: true };
      await k.sessions.bind(currentBinding, k.sessionProof(provider));
    }
    const sent = state.snapshot.events.slice(0, candidate.eventCount).map(event => event.metadata);
    const acknowledged = await k.journal.acknowledge(sent, handle.snapshot.generation);
    if (acknowledged.length !== sent.length) { return null; }
    const openingPermitted = handle.snapshot.freshness.state === 'fresh' && candidate.stateIncluded && candidate.degraded === null && operationallyCurrent(k.operational.current);
    const completed = currentBinding.turnsCompleted === 0 && !openingPermitted ? 0 : currentBinding.turnsCompleted + 1;
    const updated = await k.sessions.bind({ ...currentBinding, turnsCompleted: completed,
      needsState: !options.compactionCapability || options.compactedDuringTurn || !candidate.stateIncluded && currentBinding.needsState || candidate.degraded === 'stateTooLarge' }, k.sessionProof(provider));
    if (state.snapshot.awaitingDisclosure) { await reconcileAcknowledgedRecovery(k, () => this.maintainStorage()); }
    if (openingPermitted) { await this.discharge(state, updated, provider); }
    await k.observeStatus();
    return updated;
  }

  private async discharge(state: HandleState, bound: BoundSession, provider: ProviderIdentity): Promise<void> {
    const k = this.kernel;
    const safety = await k.safety();
    if (safety.correction !== null && state.snapshot.correction?.correctionId === safety.correction.correctionId) {
      await k.safetyStore.dischargeCorrection(state.snapshot.public.generation, safety.correction.correctionId, { verify: async current => {
        const ready = await k.sessions.ready(k.sessionProof(provider));
        const operation = current.correction?.recoveryOperationId === null || current.correction?.recoveryOperationId === undefined ? null : await k.operations.read(current.correction.recoveryOperationId);
        return current.recoveryWitness === null && ready?.bindingSha256 === bound.bindingSha256 && operation?.status === 'valid' && !operation.value.compacted && operation.value.kind === 'repair'
          && !effectivelyUnfinished(operation.value) && operation.value.recovery.episodes.at(-1)?.acceptedRecovery?.generation === current.generation;
      } });
    }
  }
}
