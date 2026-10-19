import { performance } from 'node:perf_hooks';

import { PendingStateCheckError, type DeliveryHandle, type RuntimeBackend } from './backend/api.ts';
import { isCapacityBlocked, RuntimeCapacityError } from './capacity.ts';
import { Dialogs } from './dialogs.ts';
import { newIdentity } from './identity.ts';
import { utcNow } from './json.ts';
import { ProviderLifecycle, type PendingProviderStart } from './provider-lifecycle.ts';
import type { Provider, ProviderReconnectReason, ProviderSession, ProviderSignal } from './provider.ts';
import { SerialQueue } from './serial.ts';
import type { ClientSink, Correction, HostEvent, HostSnapshot, HostStatus, Interaction, ResumeResult, SessionHostV1, SubmitResult, TurnFailure } from './session-host-contract.ts';
import type { StartupPhase } from './startup-progress.ts';
import { recoveryFingerprint, WindowRecovery, type WindowAttempt } from './window-recovery.ts';

const startupWorkerRoles = ['startupMetadata', 'startupCoreReply', 'startupMutation'] as const;
const attachmentSafetyLifetimeMs = 3_000;
const attachmentLivenessLifetimeMs = 1_000;
interface AttachmentSafetyWitness {
  readonly generation: string;
  readonly binding: NonNullable<ProviderLifecycle['binding']>;
  readonly status: RuntimeBackend['status'];
  readonly observedAt: number;
}
interface AttachmentReservation {
  cancelled: boolean;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}
export type VerifiedAttachResult = ReturnType<SessionHostV1['attach']> | { readonly result: 'attachCancelled' | 'attachStateChanged' };

/** The final attachment check failed only because the bound provider exited or changed, not because safety refused. */
export class AttachmentProviderUnavailableError extends Error { override readonly name = 'AttachmentProviderUnavailableError'; }

export interface SessionHostOptions {
  readonly backend: RuntimeBackend;
  readonly provider: Provider;
  readonly instructionsSha256: string;
  readonly pendingStart?: PendingProviderStart | null;
  readonly requireVerifiedAttach?: boolean;
  readonly providerTerminated: (instance: string) => Promise<void>;
  readonly verifyTools: () => Promise<void>;
  readonly closeTools: () => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}
interface Turn extends Interaction {
  readonly text: string;
  readonly override: boolean;
  terminal: boolean;
  completed: boolean;
  interrupted: boolean;
  invalidated: boolean;
  compacted: boolean;
  sent: boolean;
  work: Promise<void>;
}

export class SessionHost implements SessionHostV1 {
  private readonly options: SessionHostOptions;
  private readonly monotonicNow: () => number;
  private readonly lifecycle: ProviderLifecycle;
  private readonly dialogs: Dialogs;
  private readonly maintenance = new SerialQueue();
  private readonly ordinaryFingerprint: string;
  private readonly overrideFingerprint: string | null;
  private readonly startupNotices: HostEvent[] = [];
  private recovery: WindowRecovery;
  private sink: ClientSink | null = null;
  private attachedOnce = false;
  private attachWitness = false;
  private attachmentReservation: AttachmentReservation | null = null;
  private attachmentSafetyWitness: AttachmentSafetyWitness | null = null;
  private active: Turn | null = null;
  private ingressOrder = 0;
  private ready = false;
  private pendingCheckBlocked = false;
  private initialStartCompleted = false;
  private initialStartupInvalidated = false;
  private invalidatedAfterStart = false;
  private finalSafetyBlocked = false;
  private initialStartPromise: Promise<boolean> | null = null;
  private closing = false;
  private switching = false;
  private sessionControl: Promise<unknown> | null = null;
  private reconnect: { readonly instance: string; readonly reason: ProviderReconnectReason } | null = null;
  private replacement = false;
  private transition: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private lastStatus = '';
  private maintenanceFailure: Error | null = null;
  private compactionToken = Symbol();

  constructor(options: SessionHostOptions) {
    this.options = options;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    const config = options.backend.config.provider;
    this.ordinaryFingerprint = recoveryFingerprint(options.provider.providerId, options.instructionsSha256, JSON.stringify({ model: config.model, effort: config.effort, verbatim: true }));
    this.overrideFingerprint = options.provider.capabilities.questionOverride && config.questionOverride !== null
      ? recoveryFingerprint(options.provider.providerId, options.instructionsSha256, JSON.stringify({ ...config.questionOverride, verbatim: true })) : null;
    this.recovery = new WindowRecovery('', this.ordinaryFingerprint, this.overrideFingerprint);
    this.lifecycle = new ProviderLifecycle({ backend: options.backend, provider: options.provider, instructionsSha256: options.instructionsSha256,
      pendingStart: options.pendingStart,
      emit: event => this.emit(event), changed: () => this.statusChanged(), onTerminated: options.providerTerminated,
      onBound: session => { this.maintenanceFailure = null; this.recovery.bind(session.providerSessionId, session.providerInstanceId); },
      onExit: (instance, reason) => { this.reconnect = { instance, reason }; if (this.active === null) { this.scheduleTransition(); } },
      ...(options.delay === undefined ? {} : { delay: options.delay }) });
    this.dialogs = new Dialogs(event => {
      if (event.type === 'dialog.closed') { this.emit(event); return; }
      const turn = this.active;
      if (turn === null || turn.terminal || turn.interrupted || turn.invalidated) { throw new Error('This turn no longer owns a dialog.'); }
      this.emit({ type: 'dialog.requested', ...this.interaction(turn), dialogId: event.dialog.dialogId, questions: event.dialog.questions });
    });
  }

  get status(): HostStatus {
    return { ...this.options.backend.status, provider: this.lifecycle.status, windowRecovery: this.recovery.summary() };
  }
  get turnInProgress(): boolean { return this.active !== null; }
  get requiresVerifiedAttach(): boolean { return this.options.requireVerifiedAttach ?? false; }
  isProviderCurrent(instance: string): boolean { return this.lifecycle.isCurrent(instance); }
  isToolActive(instance: string, session: string): boolean {
    return this.active !== null && this.active.sent && !this.active.terminal && !this.active.interrupted && !this.active.invalidated
      && this.lifecycle.isCurrent(instance) && this.lifecycle.session?.providerSessionId === session;
  }
  get dialogsAvailable(): boolean { return this.lifecycle.capabilities.dialogs; }

  async start(onStartupPhase?: (phase: StartupPhase) => void): Promise<boolean> {
    if (this.initialStartPromise !== null) { return this.initialStartPromise; }
    const starting = this.initialStartupInvalidated ? this.lifecycle.discardPending().then(() => false) : this.lifecycle.start(onStartupPhase);
    this.initialStartPromise = starting;
    try {
      const started = await starting;
      this.ready = started && !this.initialStartupInvalidated;
      return this.ready;
    } finally {
      this.initialStartCompleted = true;
      this.initialStartPromise = null;
      this.statusChanged();
      this.scheduleTransition();
    }
  }

  async prepareAttachmentWitness(): Promise<void> {
    this.attachmentSafetyWitness = null;
    const binding = this.lifecycle.binding;
    if (!this.options.backend.guardHeld()) { throw new Error('Ready attachment safety cannot be prepared without the guard.'); }
    if (!this.ready || binding === null) { throw this.attachmentUnavailable('Ready attachment safety cannot be prepared without a bound provider.'); }
    const safety = await this.options.backend.providerSafety();
    const observedAt = this.monotonicNow();
    const status = this.options.backend.status;
    if (safety.generation !== binding.stateGeneration || !this.options.backend.guardHeld()) { throw new Error('Ready attachment safety changed during preparation.'); }
    if (this.lifecycle.binding !== binding || !this.lifecycle.isCurrent(this.lifecycle.session?.providerInstanceId ?? '') || !this.providerReady) {
      throw this.attachmentUnavailable('The bound provider changed during attachment preparation.');
    }
    this.attachmentSafetyWitness = { generation: safety.generation, binding, status, observedAt };
  }

  // An invalidation also unreadies the provider but remains a safety refusal; only a plain provider exit is recoverable.
  private attachmentUnavailable(message: string): Error {
    return this.invalidatedAfterStart || this.initialStartupInvalidated || this.finalSafetyBlocked || this.closing
      ? new Error(message) : new AttachmentProviderUnavailableError(message);
  }

  /**
   * Waits for queued provider reconnects to finish, so attachment sees a settled provider. An invalidation stops the wait at once:
   * it is a safety refusal, and the final-safety block, not a replacement, owns what follows.
   */
  async settleProviderRecovery(): Promise<'ready' | 'unavailable' | 'invalidated'> {
    this.scheduleTransition();
    while (this.transition !== null && !this.invalidatedAfterStart) { await this.transition; }
    if (this.invalidatedAfterStart) { return 'invalidated'; }

    return this.ready && this.providerReady ? 'ready' : 'unavailable';
  }

  async blockAfterFinalSafety(): Promise<void> {
    this.ready = false;
    this.finalSafetyBlocked = true;
    this.attachmentSafetyWitness = null;
    this.replacement = false;
    this.reconnect = null;
    this.lifecycle.suppress();
    await this.transition;
    await this.lifecycle.finishFinalSafetyBlock();
    this.statusChanged();
  }

  attach(sink: ClientSink): ReturnType<SessionHostV1['attach']> {
    if (this.options.requireVerifiedAttach && !this.attachWitness) { throw new Error('Client attachment has not passed final admission.'); }
    this.attachWitness = false;
    if (this.sink !== null) { return { result: 'clientAlreadyAttached' }; }
    const binding = this.lifecycle.binding;
    const open = this.dialogs.open;
    const turn = this.active;
    const snapshot: HostSnapshot = {
      sessionHostVersion: 1, ...this.options.backend.identities, adapter: this.options.backend.config.game, principal: this.options.backend.scope.principal, playSessionId: null,
      capabilities: this.lifecycle.capabilities, status: this.status,
      agentSession: binding === null ? null : { providerId: binding.providerId, providerSessionId: binding.providerSessionId, createdAt: binding.createdAt, turnsCompleted: binding.turnsCompleted, needsState: binding.needsState },
      openDialog: open === null || turn === null ? null : { ...this.interaction(turn), dialogId: open.dialogId, questions: open.questions },
    };
    const deliveredSnapshot = structuredClone(snapshot);
    this.sink = sink;
    this.attachedOnce = true;
    queueMicrotask(() => { if (this.sink === sink) { for (const event of this.startupNotices.splice(0)) { this.emit(event); } } });
    return { result: 'attached', snapshot: deliveredSnapshot };
  }

  async attachVerified(sink: ClientSink): Promise<VerifiedAttachResult> {
    if (!this.options.requireVerifiedAttach) { return this.attach(sink); }
    if (this.sink !== null || this.attachmentReservation !== null) { return { result: 'clientAlreadyAttached' }; }
    let settle = () => {};
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const reservation: AttachmentReservation = { cancelled: false, settled, settle };
    this.attachmentReservation = reservation;
    try {
      return await this.attachVerifiedReserved(sink, reservation);
    } catch (error) {
      if (reservation.cancelled || this.closing) { return { result: 'attachCancelled' }; }
      throw error;
    } finally {
      if (this.attachmentReservation === reservation) { this.attachmentReservation = null; }
      reservation.settle();
    }
  }

  private async attachVerifiedReserved(sink: ClientSink, reservation: AttachmentReservation): Promise<VerifiedAttachResult> {
    if (!this.options.backend.guardHeld()) { throw new Error('Client attachment lost the runtime guard.'); }
    const verifyWorkers = () => Promise.all(startupWorkerRoles.map(role => this.options.backend.supervisor.verifyQuiescent(role)));
    const expectedStatus = this.options.backend.status;
    const expectedStatusBytes = JSON.stringify(expectedStatus);
    const expectedBinding = this.lifecycle.binding;
    const expectedSession = this.lifecycle.session;
    const expectedReady = this.ready;
    const expectedProviderState = this.lifecycle.status.state;
    if (this.ready) {
      const binding = this.lifecycle.binding;
      if (binding === null || !this.options.backend.guardHeld() || !this.providerReady) {
        throw new Error('Ready client attachment lost its startup authority.');
      }
      const status = this.options.backend.status;
      let witness = this.attachmentSafetyWitness;
      this.attachmentSafetyWitness = null;
      if (witness !== null && (witness.binding !== binding || witness.generation !== binding.stateGeneration || witness.status !== status)) {
        throw new Error('Ready client attachment changed after safety observation.');
      }
      const observeColdSafety = async (): Promise<AttachmentSafetyWitness> => {
        const safety = await this.options.backend.providerSafety();
        const observedAt = this.monotonicNow();
        if (safety.generation !== binding.stateGeneration || this.lifecycle.binding !== binding || this.options.backend.status !== status
          || !this.options.backend.guardHeld() || !this.providerReady) { throw new Error('Provider safety generation changed before attachment.'); }
        return { generation: safety.generation, binding, status, observedAt };
      };
      const usedWarmWitness = witness !== null && this.monotonicNow() - witness.observedAt <= attachmentSafetyLifetimeMs;
      if (witness === null || !usedWarmWitness) { witness = await observeColdSafety(); }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [livenessObservedAt] = await Promise.all([this.lifecycle.verifyLive().then(() => this.monotonicNow()), verifyWorkers()]);
        const observedAt = this.monotonicNow();
        if (this.options.backend.status !== status || this.lifecycle.binding !== binding || !this.options.backend.guardHeld() || !this.providerReady
          || witness.generation !== binding.stateGeneration || !this.lifecycle.isCurrent(this.lifecycle.session?.providerInstanceId ?? '')) {
          throw new Error('Ready client attachment changed during final proof.');
        }
        if (observedAt - witness.observedAt <= attachmentSafetyLifetimeMs && observedAt - livenessObservedAt <= attachmentLivenessLifetimeMs) { break; }
        if (!usedWarmWitness || attempt !== 0) { throw new Error('Ready client attachment witness expired during final proof.'); }
        witness = await observeColdSafety();
      }
    } else { await verifyWorkers(); }
    if (reservation.cancelled || this.attachmentReservation !== reservation || this.closing || this.sink !== null) { return { result: 'attachCancelled' }; }
    if (!this.options.backend.guardHeld() || this.options.backend.status !== expectedStatus || JSON.stringify(this.options.backend.status) !== expectedStatusBytes
      || this.lifecycle.binding !== expectedBinding || this.lifecycle.session !== expectedSession || this.ready !== expectedReady
      || !expectedReady && (this.transition !== null || this.replacement || this.reconnect !== null || this.lifecycle.status.state !== expectedProviderState)
      || expectedReady && !this.lifecycle.isCurrent(expectedSession?.providerInstanceId ?? '')) { return { result: 'attachStateChanged' }; }
    this.attachWitness = true;
    return this.attach(sink);
  }
  // Ready attachment needs provider safety authority, not a healthy status: failed freshness or a journal fault without a
  // safety refusal leaves a bound provider whose turns run disclosure-only.
  private get providerReady(): boolean { return this.lifecycle.status.state === 'ready'; }
  detach(): void { if (this.attachmentReservation !== null) { this.attachmentReservation.cancelled = true; } this.attachmentSafetyWitness = null; this.sink = null; }

  private interaction(turn: Interaction): Interaction { return { interactionId: turn.interactionId, requestReceivedAt: turn.requestReceivedAt, ingressOrder: turn.ingressOrder }; }
  private emit(event: HostEvent): void {
    if (this.sink === null) { if (!this.attachedOnce && event.type === 'notice') { this.startupNotices.push(structuredClone(event)); } return; }
    try { this.sink(structuredClone(event)); }
    catch { this.sink = null; }
  }
  statusChanged(): void {
    // Provider construction can report a transition before its field is assigned.
    if (this.lifecycle === undefined) { return; }
    const status = this.status;
    const serialized = JSON.stringify(status);
    if (serialized === this.lastStatus) { return; }
    this.lastStatus = serialized;
    this.emit({ type: 'status.changed', status });
  }

  submitChat(input: { readonly text: string; readonly questionOverride: boolean }): SubmitResult {
    if (input === null || typeof input !== 'object' || typeof input.text !== 'string' || !input.text.isWellFormed() || input.text.trim().length === 0 || typeof input.questionOverride !== 'boolean') { return { result: 'invalidInput' }; }
    if (this.active !== null) { return { result: 'turnInProgress' }; }
    if (this.pendingCheckBlocked || this.finalSafetyBlocked || isCapacityBlocked(this.options.backend.status.capacity)) { return { result: 'notReady' }; }
    if (this.lifecycle.status.state === 'failed') { return { result: 'providerUnavailable' }; }
    const status = this.options.backend.status;
    if (!this.ready || this.closing || this.switching || this.transition !== null || this.lifecycle.status.state !== 'ready'
      || status.journal.state === 'repairing' || status.journal.fault === 'runtimeCapacityExceeded' || this.ingressOrder === Number.MAX_SAFE_INTEGER) { return { result: 'notReady' }; }
    if (input.questionOverride && !this.lifecycle.capabilities.questionOverride) { return { result: 'capabilityUnavailable' }; }
    const turn: Turn = { interactionId: newIdentity(), requestReceivedAt: utcNow(), ingressOrder: ++this.ingressOrder,
      text: input.text, override: input.questionOverride, terminal: false, completed: false, interrupted: false, invalidated: false, compacted: false, sent: false, work: Promise.resolve() };
    this.active = turn;
    this.emit({ type: 'turn.started', ...this.interaction(turn) });
    // Admission is synchronous, and all later work belongs to that one interaction.
    turn.work = Promise.resolve().then(() => this.runTurn(turn));
    return { result: 'admitted', ...this.interaction(turn) };
  }

  answerDialog(input: Parameters<SessionHostV1['answerDialog']>[0]): ReturnType<SessionHostV1['answerDialog']> {
    if (input === null || typeof input !== 'object' || typeof input.dialogId !== 'string') { return 'invalidAnswer'; }
    const { dialogId, ...answer } = input;
    return this.dialogs.answer(dialogId, answer);
  }

  private fail(turn: Turn, code: TurnFailure, retryable: boolean): void {
    if (turn.terminal) { return; }
    turn.terminal = true;
    this.dialogs.endTurn(turn.interactionId);
    this.emit({ type: 'turn.failed', ...this.interaction(turn), code, retryable });
  }
  private requireTurn(turn: Turn): void {
    if (turn.invalidated || turn.interrupted || turn.terminal || this.closing) { throw new Error('The admitted turn is no longer active.'); }
  }

  async interrupt(): ReturnType<SessionHostV1['interrupt']> {
    const turn = this.active;
    if (turn === null || turn.terminal) { return 'noTurnInProgress'; }
    if (!this.lifecycle.capabilities.interrupt) { return 'capabilityUnavailable'; }
    turn.interrupted = true;
    this.dialogs.endTurn(turn.interactionId);
    this.fail(turn, 'interrupted', true);
    await this.lifecycle.session?.interrupt();
    return 'interrupted';
  }

  invalidate(reason: Correction['reason']): void {
    this.attachmentSafetyWitness = null;
    this.lifecycle.suppress();
    this.ready = false;
    if (this.initialStartCompleted) { this.replacement = true; this.invalidatedAfterStart = true; }
    else { this.initialStartupInvalidated = true; this.replacement = false; }
    this.emit({ type: 'notice', code: 'stateContextInvalidated', reason });
    const turn = this.active;
    if (turn !== null) { turn.invalidated = true; this.fail(turn, 'stateInvalidated', true); }
    // Close immediately to suppress native tools; replacement waits for the
    // acquisition or acknowledgement that raised invalidation to finish.
    void this.lifecycle.session?.close().catch(() => { this.ready = false; });
    if (turn === null && this.initialStartCompleted) { this.scheduleTransition(); }
  }

  passiveSignal(instance: string, signal: ProviderSignal): void { this.signal(instance, signal); }
  private requireMaintenance(): void {
    if (this.maintenanceFailure !== null) { throw this.maintenanceFailure; }
  }
  private signal(instance: string, signal: ProviderSignal): void {
    if (!this.lifecycle.isCurrent(instance) || this.closing) { return; }
    const turn = this.active;
    if (signal.kind === 'source') { this.lifecycle.observeSource(instance, signal.credentialSource); return; }
    if (signal.kind === 'compaction') {
      this.compactionToken = Symbol();
      this.recovery.compacted(instance);
      if (turn !== null) { turn.compacted = true; }
      this.emit({ type: 'context.compacted' });
      void this.maintenance.run(async () => { if (this.lifecycle.isCurrent(instance)) { await this.lifecycle.compacted(); } })
        .catch(error => {
          this.maintenanceFailure = error instanceof Error ? error : new Error('A required binding publication failed.', { cause: error });
          this.statusChanged();
        });
      this.statusChanged();
      return;
    }
    if (turn !== null && !turn.terminal && !turn.interrupted && !turn.invalidated && this.lifecycle.capabilities.streamingText) {
      this.emit({ type: 'turn.delta', ...this.interaction(turn), fragment: signal.fragment });
    }
  }

  private async runTurn(turn: Turn): Promise<void> {
    let handle: DeliveryHandle | null = null;
    let ticket: WindowAttempt | null = null;
    let session: ProviderSession | null = null;
    try {
      this.requireTurn(turn);
      this.recovery.select(turn.override ? 'override' : 'ordinary', turn.text);
      this.statusChanged();
      const snapshot = await this.options.backend.acquire(this.interaction(turn));
      this.requireTurn(turn);
      await this.maintenance.idle();
      this.requireMaintenance();
      session = this.lifecycle.session;
      const binding = this.lifecycle.binding;
      if (session === null || binding === null || !this.lifecycle.isCurrent(session.providerInstanceId) || binding.stateGeneration !== snapshot.generation) { throw new Error('The current session cannot use this generation.'); }
      const preview = await this.options.backend.preview(snapshot, binding, this.recovery.halfPrefixBytes, turn.override ? this.overrideFingerprint! : this.ordinaryFingerprint);
      this.requireTurn(turn);
      ticket = this.recovery.prepare(preview.preview.candidates, preview.relevanceFingerprint, snapshot.disclosureOnly);
      if (ticket === null) { this.fail(turn, 'contextExhausted', false); return; }
      const candidate = preview.preview.candidates.find(item => item.fingerprint === ticket!.candidate.fingerprint && item.shape === ticket!.candidate.shape)!;
      handle = await this.options.backend.prepare(snapshot, preview, candidate);
      this.requireTurn(turn);
      await this.options.backend.markSent(handle);
      this.requireTurn(turn);
      const selectedSession = session;
      const selectedHandle = handle;
      let redelivery = false;
      let admitEnqueue: (() => void) | null = null;
      const outcome = await selectedSession.sendTurn({ contextBlock: handle.contextBlock, playerText: turn.text,
        override: turn.override ? this.options.backend.config.provider.questionOverride : null,
        askUser: questions => this.lifecycle.capabilities.dialogs && !turn.terminal ? this.dialogs.ask(turn.interactionId, questions) : Promise.resolve({ cancelled: true }),
        onSignal: signal => this.signal(selectedSession.providerInstanceId, signal),
        beforeSend: async () => {
          this.requireTurn(turn);
          const compactionToken = this.compactionToken;
          await this.maintenance.idle();
          this.requireMaintenance();
          if (this.compactionToken !== compactionToken) { throw new Error('Provider context changed before send.'); }
          const latestBinding = this.lifecycle.binding;
          if (latestBinding === null) { throw new Error('Session binding is unavailable.'); }
          const current = await this.options.backend.copyForSend(selectedHandle, latestBinding, this.lifecycle.identity(selectedSession));
          redelivery = current.redelivery;
          this.requireTurn(turn);
          if (current.candidate.fingerprint !== ticket!.candidate.fingerprint || current.candidate.bytes !== ticket!.candidate.bytes || current.disclosureOnly !== ticket!.disclosureOnly
            || current.relevanceFingerprint !== preview.relevanceFingerprint) {
            this.recovery.cancelBeforeSend(ticket!);
            ticket = this.recovery.prepare([current.candidate], current.relevanceFingerprint, current.disclosureOnly);
            if (ticket === null) { this.fail(turn, 'contextExhausted', false); throw new Error('The disclosure candidate is exhausted.'); }
          }
          admitEnqueue = () => {
            this.requireTurn(turn);
            this.requireMaintenance();
            if (!this.lifecycle.isCurrent(selectedSession.providerInstanceId) || this.compactionToken !== compactionToken || this.lifecycle.binding !== latestBinding) {
              throw new Error('Provider context changed before enqueue.');
            }
          };
          return current.text;
        },
        beforeEnqueue: () => {
          if (admitEnqueue === null) { throw new Error('Provider context was not prepared for enqueue.'); }
          admitEnqueue();
        },
        onSent: () => {
          turn.sent = true;
          this.recovery.sent(ticket!, selectedSession.providerInstanceId);
          if (redelivery) { this.emit({ type: 'notice', code: 'stateRedelivered', reason: null }); }
        },
      });
      await this.maintenance.idle();
      if (turn.sent) { this.recovery.finished(ticket!, selectedSession.providerInstanceId, outcome.kind === 'completed' ? 'success' : outcome.code === 'contextExhausted' ? 'contextExhausted' : 'otherFailure'); }
      else { this.recovery.cancelBeforeSend(ticket!); }
      ticket = null;
      if (turn.terminal) { return; }
      if (outcome.kind === 'completed') {
        this.requireTurn(turn);
        if (!turn.sent) { throw new Error('This completion has no admitted send.'); }
      }
      this.requireMaintenance();
      if (outcome.kind === 'completed') {
        turn.completed = true;
        turn.terminal = true;
        this.dialogs.endTurn(turn.interactionId);
        this.emit({ type: 'turn.completed', ...this.interaction(turn), text: outcome.text });
        await this.maintenance.run(async () => {
          const currentBinding = this.lifecycle.binding;
          if (currentBinding === null) { throw new Error('Session binding is unavailable.'); }
          const acknowledged = await this.options.backend.acknowledge(selectedHandle, currentBinding, this.lifecycle.identity(selectedSession),
            { compactedDuringTurn: turn.compacted, compactionCapability: selectedSession.capabilities.compactionBoundaries });
          if (acknowledged !== null) { this.lifecycle.updateBinding(acknowledged.binding); }
        });
        await this.maintenance.idle();
      } else {
        let retryable = outcome.retryable;
        if (outcome.code === 'contextExhausted') {
          // Only candidate preparation is repeated. A provider retry always
          // requires a new player submission and its own acquisition.
          retryable = false;
          try {
            await this.options.backend.discard(handle);
            handle = null;
            const nextPreview = await this.options.backend.preview(snapshot, this.lifecycle.binding ?? binding, this.recovery.halfPrefixBytes,
              turn.override ? this.overrideFingerprint! : this.ordinaryFingerprint);
            const nextAttempt = this.recovery.prepare(nextPreview.preview.candidates, nextPreview.relevanceFingerprint, snapshot.disclosureOnly);
            retryable = nextAttempt !== null;
            if (nextAttempt !== null) { this.recovery.cancelBeforeSend(nextAttempt); }
          } catch { /* Failed candidate verification grants no further attempt. */ }
        }
        this.fail(turn, outcome.code, retryable);
      }
    } catch (error) {
      const pendingCheck = error instanceof PendingStateCheckError;
      const capacity = error instanceof RuntimeCapacityError;
      if (pendingCheck) { this.pendingCheckBlocked = true; }
      this.statusChanged();
      const invalidated = pendingCheck || turn.invalidated || this.options.backend.status.stateSafety.state === 'unavailable';
      const code: TurnFailure = invalidated ? 'stateInvalidated' : turn.interrupted || this.closing ? 'interrupted' : capacity ? 'capacityBlocked' : 'providerError';
      this.fail(turn, code, !this.closing && !pendingCheck && code !== 'capacityBlocked');
    } finally {
      if (ticket !== null) {
        try { if (turn.sent && session !== null) { this.recovery.finished(ticket, session.providerInstanceId, 'otherFailure'); } else { this.recovery.cancelBeforeSend(ticket); } }
        catch { /* WindowRecovery preserves its own unavailable state. */ }
      }
      if (handle !== null) { try { await this.options.backend.discard(handle); } catch { this.ready = false; } }
      this.dialogs.endTurn(turn.interactionId);
      if (this.active === turn) { this.active = null; }
      this.statusChanged();
      if (!this.closing) { this.scheduleTransition(); }
    }
  }

  private scheduleTransition(): void {
    if (this.closing || this.initialStartupInvalidated || this.finalSafetyBlocked || !this.initialStartCompleted || this.active !== null || this.transition !== null
      || this.switching || this.sessionControl !== null || this.initialStartPromise !== null || !this.replacement && this.reconnect === null) { return; }
    this.transition = Promise.resolve().then(async () => {
      await this.maintenance.idle();
      if (this.closing || this.finalSafetyBlocked || this.initialStartupInvalidated || !this.initialStartCompleted || this.active !== null
        || this.switching || this.sessionControl !== null) { return; }
      if (this.replacement) { this.replacement = false; this.reconnect = null; this.ready = await this.lifecycle.replace('stateInvalidated'); }
      else {
        const pending = this.reconnect;
        this.reconnect = null;
        if (pending !== null && this.lifecycle.session?.providerInstanceId === pending.instance) { this.ready = await this.lifecycle.reconnect(pending.reason); }
      }
    }).catch(() => { this.ready = false; }).finally(() => { this.transition = null; this.statusChanged(); if (!this.closing) { this.scheduleTransition(); } });
  }

  async startNewAgentSession(): ReturnType<SessionHostV1['startNewAgentSession']> {
    if (this.active !== null) { return 'turnInProgress'; }
    if (this.pendingCheckBlocked || this.finalSafetyBlocked || this.lifecycle.status.state === 'failed' || this.initialStartupInvalidated || !this.initialStartCompleted) { return 'providerUnavailable'; }
    if (this.closing || this.switching || this.transition !== null) { return 'providerUnavailable'; }
    this.switching = true;
    const control = (async () => { await this.maintenance.idle(); this.ready = await this.lifecycle.replace('requested'); return this.ready ? 'started' as const : 'providerUnavailable' as const; })();
    this.sessionControl = control;
    try { return await control; }
    finally { this.sessionControl = null; this.switching = false; this.statusChanged(); this.scheduleTransition(); }
  }
  async resumeAgentSession(sessionId: string): Promise<ResumeResult> {
    if (this.active !== null) { return 'turnInProgress'; }
    if (this.pendingCheckBlocked || this.finalSafetyBlocked || this.initialStartupInvalidated || !this.initialStartCompleted) { return 'stateInvalidated'; }
    if (this.closing || this.switching || this.transition !== null || this.lifecycle.status.state === 'failed') { return 'providerUnavailable'; }
    this.switching = true;
    const control = (async () => { await this.maintenance.idle(); const result = await this.lifecycle.resume(sessionId); this.ready = this.lifecycle.status.state === 'ready'; return result; })();
    this.sessionControl = control;
    try { return await control; }
    finally { this.sessionControl = null; this.switching = false; this.statusChanged(); this.scheduleTransition(); }
  }

  shutdown(): Promise<void> { this.shutdownPromise ??= this.close(); return this.shutdownPromise; }
  private async close(): Promise<void> {
    this.closing = true;
    this.ready = false;
    this.attachmentSafetyWitness = null;
    if (this.attachmentReservation !== null) { this.attachmentReservation.cancelled = true; await this.attachmentReservation.settled; }
    const turn = this.active;
    if (turn !== null && !turn.terminal) { turn.interrupted = true; this.fail(turn, 'interrupted', false); await this.lifecycle.session?.interrupt(); }
    if (turn?.completed) { await turn.work; }
    this.lifecycle.suppress();
    const owning = await Promise.allSettled([this.initialStartPromise, this.sessionControl, this.transition]);
    const ownerFailure = owning.find(result => result.status === 'rejected');
    if (ownerFailure?.status === 'rejected') { throw ownerFailure.reason; }
    const stopping = this.options.backend.beginShutdown();
    const closed = await Promise.allSettled([this.lifecycle.close(), stopping]);
    const failure = closed.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') { throw failure.reason; }
    await this.sessionControl;
    await turn?.work;
    await this.transition;
    await this.maintenance.idle();
    await this.options.verifyTools();
    await this.options.backend.shutdown(true);
    await this.options.closeTools();
    this.sink = null;
  }
}
