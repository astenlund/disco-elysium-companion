import { PendingStateCheckError, type DeliveryHandle, type RuntimeBackend } from './backend/api.ts';
import { isCapacityBlocked, RuntimeCapacityError } from './capacity.ts';
import { Dialogs } from './dialogs.ts';
import { newIdentity } from './identity.ts';
import { utcNow } from './json.ts';
import { ProviderLifecycle } from './provider-lifecycle.ts';
import type { Provider, ProviderReconnectReason, ProviderSession, ProviderSignal } from './provider.ts';
import { SerialQueue } from './serial.ts';
import type { ClientSink, Correction, HostEvent, HostSnapshot, HostStatus, Interaction, ResumeResult, SessionHostV1, SubmitResult, TurnFailure } from './session-host-contract.ts';
import { recoveryFingerprint, WindowRecovery, type WindowAttempt } from './window-recovery.ts';

export interface SessionHostOptions {
  readonly backend: RuntimeBackend;
  readonly provider: Provider;
  readonly instructionsSha256: string;
  readonly providerTerminated: (instance: string) => Promise<void>;
  readonly verifyTools: () => Promise<void>;
  readonly closeTools: () => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}
interface Turn extends Interaction {
  readonly text: string;
  readonly override: boolean;
  terminal: boolean;
  interrupted: boolean;
  invalidated: boolean;
  compacted: boolean;
  sent: boolean;
  work: Promise<void>;
}

export class SessionHost implements SessionHostV1 {
  private readonly options: SessionHostOptions;
  private readonly lifecycle: ProviderLifecycle;
  private readonly dialogs: Dialogs;
  private readonly maintenance = new SerialQueue();
  private readonly ordinaryFingerprint: string;
  private readonly overrideFingerprint: string | null;
  private readonly startupNotices: HostEvent[] = [];
  private recovery: WindowRecovery;
  private sink: ClientSink | null = null;
  private attachedOnce = false;
  private active: Turn | null = null;
  private ingressOrder = 0;
  private ready = false;
  private pendingCheckBlocked = false;
  private closing = false;
  private switching = false;
  private sessionControl: Promise<unknown> | null = null;
  private reconnect: { readonly instance: string; readonly reason: ProviderReconnectReason } | null = null;
  private replacement = false;
  private transition: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private lastStatus = '';
  private maintenanceFailure = false;

  constructor(options: SessionHostOptions) {
    this.options = options;
    const config = options.backend.config.provider;
    this.ordinaryFingerprint = recoveryFingerprint(options.provider.providerId, options.instructionsSha256, JSON.stringify({ model: config.model, effort: config.effort, verbatim: true }));
    this.overrideFingerprint = options.provider.capabilities.questionOverride && config.questionOverride !== null
      ? recoveryFingerprint(options.provider.providerId, options.instructionsSha256, JSON.stringify({ ...config.questionOverride, verbatim: true })) : null;
    this.recovery = new WindowRecovery('', this.ordinaryFingerprint, this.overrideFingerprint);
    this.lifecycle = new ProviderLifecycle({ backend: options.backend, provider: options.provider, instructionsSha256: options.instructionsSha256,
      emit: event => this.emit(event), changed: () => this.statusChanged(), onTerminated: options.providerTerminated,
      onBound: session => { this.maintenanceFailure = false; this.recovery.bind(session.providerSessionId, session.providerInstanceId); },
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
  isProviderCurrent(instance: string): boolean { return this.lifecycle.isCurrent(instance); }
  isToolActive(instance: string, session: string): boolean {
    return this.active !== null && this.active.sent && !this.active.terminal && !this.active.interrupted && !this.active.invalidated
      && this.lifecycle.isCurrent(instance) && this.lifecycle.session?.providerSessionId === session;
  }
  get dialogsAvailable(): boolean { return this.lifecycle.capabilities.dialogs; }

  async start(): Promise<boolean> {
    const started = await this.lifecycle.start();
    this.ready = started;
    this.statusChanged();
    return started;
  }

  attach(sink: ClientSink): ReturnType<SessionHostV1['attach']> {
    if (this.sink !== null) { return { result: 'clientAlreadyAttached' }; }
    this.sink = sink;
    this.attachedOnce = true;
    const binding = this.lifecycle.binding;
    const open = this.dialogs.open;
    const turn = this.active;
    const snapshot: HostSnapshot = {
      sessionHostVersion: 1, ...this.options.backend.identities, adapter: this.options.backend.config.game, principal: this.options.backend.scope.principal, playSessionId: null,
      capabilities: this.lifecycle.capabilities, status: this.status,
      agentSession: binding === null ? null : { providerId: binding.providerId, providerSessionId: binding.providerSessionId, createdAt: binding.createdAt, turnsCompleted: binding.turnsCompleted, needsState: binding.needsState },
      openDialog: open === null || turn === null ? null : { ...this.interaction(turn), dialogId: open.dialogId, questions: open.questions },
    };
    queueMicrotask(() => { if (this.sink === sink) { for (const event of this.startupNotices.splice(0)) { this.emit(event); } } });
    return { result: 'attached', snapshot: structuredClone(snapshot) };
  }
  detach(): void { this.sink = null; }

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
    if (this.pendingCheckBlocked || isCapacityBlocked(this.options.backend.status.capacity)) { return { result: 'notReady' }; }
    if (this.lifecycle.status.state === 'failed') { return { result: 'providerUnavailable' }; }
    const status = this.options.backend.status;
    if (!this.ready || this.closing || this.switching || this.transition !== null || this.lifecycle.status.state !== 'ready'
      || status.journal.state === 'repairing' || status.journal.fault === 'runtimeCapacityExceeded' || this.ingressOrder === Number.MAX_SAFE_INTEGER) { return { result: 'notReady' }; }
    if (input.questionOverride && !this.lifecycle.capabilities.questionOverride) { return { result: 'capabilityUnavailable' }; }
    const turn: Turn = { interactionId: newIdentity(), requestReceivedAt: utcNow(), ingressOrder: ++this.ingressOrder,
      text: input.text, override: input.questionOverride, terminal: false, interrupted: false, invalidated: false, compacted: false, sent: false, work: Promise.resolve() };
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
    this.lifecycle.suppress();
    this.replacement = true;
    this.emit({ type: 'notice', code: 'stateContextInvalidated', reason });
    const turn = this.active;
    if (turn !== null) { turn.invalidated = true; this.fail(turn, 'stateInvalidated', true); }
    // Close immediately to suppress native tools; replacement waits for the
    // acquisition or acknowledgement that raised invalidation to finish.
    void this.lifecycle.session?.close().catch(() => { this.ready = false; });
    if (turn === null) { this.scheduleTransition(); }
  }

  passiveSignal(instance: string, signal: ProviderSignal): void { this.signal(instance, signal); }
  private signal(instance: string, signal: ProviderSignal): void {
    if (!this.lifecycle.isCurrent(instance) || this.closing) { return; }
    const turn = this.active;
    if (signal.kind === 'source') { this.lifecycle.observeSource(instance, signal.credentialSource); return; }
    if (signal.kind === 'compaction') {
      this.recovery.compacted(instance);
      if (turn !== null) { turn.compacted = true; }
      this.emit({ type: 'context.compacted' });
      void this.maintenance.run(async () => { if (this.lifecycle.isCurrent(instance)) { await this.lifecycle.compacted(); } })
        .catch(() => { this.maintenanceFailure = true; this.statusChanged(); });
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
      if (this.maintenanceFailure) { throw new Error('A required binding publication failed.'); }
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
      const outcome = await selectedSession.sendTurn({ contextBlock: handle.contextBlock, playerText: turn.text,
        override: turn.override ? this.options.backend.config.provider.questionOverride : null,
        askUser: questions => this.lifecycle.capabilities.dialogs && !turn.terminal ? this.dialogs.ask(turn.interactionId, questions) : Promise.resolve({ cancelled: true }),
        onSignal: signal => this.signal(selectedSession.providerInstanceId, signal),
        beforeSend: async () => {
          this.requireTurn(turn);
          await this.maintenance.idle();
          if (this.maintenanceFailure) { throw new Error('A required binding publication failed.'); }
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
          return current.text;
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
        if (!turn.sent || this.maintenanceFailure) { throw new Error('This completion has no admitted send or binding.'); }
        await this.maintenance.run(async () => {
          const currentBinding = this.lifecycle.binding;
          if (currentBinding === null) { throw new Error('Session binding is unavailable.'); }
          const acknowledged = await this.options.backend.acknowledge(selectedHandle, currentBinding, this.lifecycle.identity(selectedSession),
            { compactedDuringTurn: turn.compacted, compactionCapability: selectedSession.capabilities.compactionBoundaries });
          if (acknowledged !== null) { this.lifecycle.updateBinding(acknowledged.binding); }
        });
        await this.maintenance.idle();
        this.requireTurn(turn);
        turn.terminal = true;
        this.dialogs.endTurn(turn.interactionId);
        this.emit({ type: 'turn.completed', ...this.interaction(turn), text: outcome.text });
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
    if (this.closing || this.active !== null || this.transition !== null || !this.replacement && this.reconnect === null) { return; }
    this.transition = Promise.resolve().then(async () => {
      await this.maintenance.idle();
      if (this.closing) { return; }
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
    if (this.pendingCheckBlocked) { return 'providerUnavailable'; }
    if (this.closing || this.switching || this.transition !== null) { return 'providerUnavailable'; }
    this.switching = true;
    const control = (async () => { await this.maintenance.idle(); this.ready = await this.lifecycle.replace('requested'); return this.ready ? 'started' as const : 'providerUnavailable' as const; })();
    this.sessionControl = control;
    try { return await control; }
    finally { this.sessionControl = null; this.switching = false; this.statusChanged(); }
  }
  async resumeAgentSession(sessionId: string): Promise<ResumeResult> {
    if (this.active !== null) { return 'turnInProgress'; }
    if (this.pendingCheckBlocked) { return 'stateInvalidated'; }
    if (this.closing || this.switching || this.transition !== null || this.lifecycle.status.state === 'failed') { return 'providerUnavailable'; }
    this.switching = true;
    const control = (async () => { await this.maintenance.idle(); const result = await this.lifecycle.resume(sessionId); this.ready = this.lifecycle.status.state === 'ready'; return result; })();
    this.sessionControl = control;
    try { return await control; }
    finally { this.sessionControl = null; this.switching = false; this.statusChanged(); }
  }

  shutdown(): Promise<void> { this.shutdownPromise ??= this.close(); return this.shutdownPromise; }
  private async close(): Promise<void> {
    this.closing = true;
    this.ready = false;
    const turn = this.active;
    if (turn !== null) { turn.interrupted = true; this.fail(turn, 'interrupted', false); await this.lifecycle.session?.interrupt(); }
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
