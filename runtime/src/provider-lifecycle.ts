import { performance } from 'node:perf_hooks';

import type { RuntimeBackend, ProviderIdentity } from './backend/api.ts';
import { isOpaqueToken } from './identity.ts';
import { utcNow } from './json.ts';
import type { Provider, ProviderCapabilities, ProviderReconnectReason, ProviderSession } from './provider.ts';
import type { AgentSessionBinding } from './session-records.ts';
import type { HostNotice, ResumeResult, StartReason } from './session-host-contract.ts';
import { reportStartupPhase, type StartupPhase } from './startup-progress.ts';

export class PendingProviderStart {
  readonly resumeSessionId: string | null;
  readonly providerId: string;
  readonly generation: string;
  readonly instructionsSha256: string;
  private readonly controller = new AbortController();
  private readonly backend: RuntimeBackend;
  private readonly result: Promise<{ readonly session: ProviderSession } | { readonly error: unknown }>;
  private cancelled = false;
  private claimed = false;
  private taking = false;
  private stopped = false;

  constructor(backend: RuntimeBackend, provider: Provider, resumeSessionId: string | null, generation: string, instructionsSha256: string) {
    this.backend = backend;
    this.providerId = provider.providerId;
    this.resumeSessionId = resumeSessionId;
    this.generation = generation;
    this.instructionsSha256 = instructionsSha256;
    this.result = provider.start(resumeSessionId, this.controller.signal).then(
      async session => {
        if (this.cancelled) { await session.close(); await this.backend.supervisor.verifyQuiescent('provider'); this.stopped = true; }
        return { session };
      }, error => ({ error }));
  }

  async take(providerId: string, resumeSessionId: string | null, generation: string, instructionsSha256: string): Promise<ProviderSession | null> {
    if (this.taking) { throw new PendingProviderStopError('The pending provider is already being claimed.'); }
    if (this.cancelled || this.claimed || !this.backend.guardHeld() || this.providerId !== providerId || this.resumeSessionId !== resumeSessionId
      || this.generation !== generation || this.instructionsSha256 !== instructionsSha256) {
      await this.cancel();
      return null;
    }
    this.taking = true;
    const settled = await this.result;
    if ('error' in settled) {
      try { await this.backend.supervisor.verifyQuiescent('provider'); }
      catch { throw new PendingProviderStopError('Provider job absence could not be proved after failed start.'); }
      this.claimed = true;
      return null;
    }
    if (this.cancelled || !this.backend.guardHeld()) { await this.cancel(); throw new Error('The pending provider start lost its guard.'); }
    try { await settled.session.verifyLive(); }
    catch (error) { await this.cancel(); throw error; }
    this.claimed = true;
    return settled.session;
  }

  async cancel(): Promise<void> {
    if (this.claimed) { return; }
    this.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled: Awaited<typeof this.result> | null;
    try { settled = await Promise.race([this.result, new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 60_000); })]); }
    catch { throw new PendingProviderStopError('The pending provider failed while stopping.'); }
    finally { if (timeout !== undefined) { clearTimeout(timeout); } }
    if (settled === null) { throw new PendingProviderStopError('The pending provider start did not settle after cancellation.'); }
    if ('error' in settled) {
      try { await this.backend.supervisor.verifyQuiescent('provider'); }
      catch { throw new PendingProviderStopError('Provider job absence could not be proved after failed start.'); }
      this.claimed = true;
      return;
    }
    if (!this.stopped) {
      try { await settled.session.close(); await this.backend.supervisor.verifyQuiescent('provider'); }
      catch { throw new PendingProviderStopError('The pending provider could not be positively stopped.'); }
      this.stopped = true;
    }
    this.claimed = true;
  }

  abort(): void { this.cancelled = true; this.controller.abort(); }
}

export class PendingProviderStopError extends Error { override readonly name = 'PendingProviderStopError'; }
export class ProviderStartInvalidatedError extends Error {
  override readonly name = 'ProviderStartInvalidatedError';
  constructor() { super('Provider startup was invalidated before durable binding.'); }
}

export async function selectPendingProviderStart(backend: RuntimeBackend, provider: Provider, instructionsSha256: string): Promise<PendingProviderStart | null> {
  try {
    if (!backend.guardHeld()) { return null; }
    const stored = await backend.sessions.readBinding();
    const safety = await backend.safety();
    if (!backend.guardHeld() || stored.status === 'invalid' || safety.pendingCheck !== null || safety.correction !== null || safety.recoveryWitness !== null) { return null; }
    const resume = stored.status === 'valid' && stored.value.stateGeneration === safety.generation && stored.value.instructionsSha256 === instructionsSha256
      && stored.value.providerId === provider.providerId && provider.capabilities.resume ? stored.value.providerSessionId : null;
    return new PendingProviderStart(backend, provider, resume, safety.generation, instructionsSha256);
  } catch { return null; }
}

export interface ProviderLifecycleOptions {
  readonly backend: RuntimeBackend;
  readonly provider: Provider;
  readonly instructionsSha256: string;
  readonly emit: (event: HostNotice) => void;
  readonly changed: () => void;
  readonly onExit: (instance: string, reason: ProviderReconnectReason) => void;
  readonly onBound: (session: ProviderSession) => void;
  readonly onTerminated: (instance: string) => Promise<void>;
  readonly pendingStart?: PendingProviderStart | null;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export class ProviderLifecycle {
  private readonly options: ProviderLifecycleOptions;
  private current: ProviderSession | null = null;
  private bound: AgentSessionBinding | null = null;
  private usable = false;
  private invalidated = false;
  private closed = false;
  private incompatible = false;
  private invalidationEpoch = 0;
  private invalidatedGeneration: string | null = null;
  private observedSafetyGeneration: string | null = null;
  private initialStartActive = false;
  private pendingStart: PendingProviderStart | null;
  private stateValue: 'starting' | 'ready' | 'reconnecting' | 'failed' = 'starting';
  private source: string | null = null;

  constructor(options: ProviderLifecycleOptions) { this.options = options; this.pendingStart = options.pendingStart ?? null; }

  get session(): ProviderSession | null { return this.current; }
  get binding(): AgentSessionBinding | null { return this.bound; }
  get capabilities(): ProviderCapabilities { return this.current?.capabilities ?? this.options.provider.capabilities; }
  get status(): { readonly state: 'starting' | 'ready' | 'reconnecting' | 'failed'; readonly credentialSource: string | null } {
    return { state: this.stateValue, credentialSource: this.source };
  }
  isCurrent(instance: string): boolean { return this.usable && !this.closed && this.current?.providerInstanceId === instance && this.current.isLive(); }
  identity(session: ProviderSession): ProviderIdentity {
    return { providerId: this.options.provider.providerId, providerSessionId: session.providerSessionId,
      isCurrent: () => !this.invalidated && !this.closed && !this.incompatible && this.current === session && session.isLive() };
  }
  observeSource(instance: string, source: string | null): void {
    if (!this.isCurrent(instance)) { return; }
    this.source = source;
    this.options.changed();
  }
  suppress(): void {
    this.invalidationEpoch += 1;
    this.invalidatedGeneration = this.bound?.stateGeneration ?? this.observedSafetyGeneration;
    this.pendingStart?.abort();
    this.usable = false; this.invalidated = true; this.source = null; this.options.changed();
  }

  private requireEpoch(epoch: number): void {
    if (this.invalidationEpoch !== epoch || this.closed || this.incompatible || !this.options.backend.guardHeld()) {
      throw new ProviderStartInvalidatedError();
    }
  }

  private async awaitNewSafetyGeneration(epoch: number): Promise<void> {
    if (this.invalidatedGeneration === null) { return; }
    const until = performance.now() + 30_000;
    while (performance.now() < until) {
      this.requireEpoch(epoch);
      try { if ((await this.options.backend.safety()).generation !== this.invalidatedGeneration) { this.requireEpoch(epoch); return; } }
      catch { this.requireEpoch(epoch); }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    throw new ProviderStartInvalidatedError();
  }
  updateBinding(binding: AgentSessionBinding): void {
    if (this.current?.providerSessionId !== binding.providerSessionId || this.options.provider.providerId !== binding.providerId) { throw new Error('The acknowledged binding is no longer current.'); }
    this.bound = binding;
    this.options.changed();
  }

  private state(value: typeof this.stateValue): void {
    this.stateValue = value;
    if (value !== 'ready') { this.source = null; }
    this.options.changed();
  }

  private async endCurrent(): Promise<void> {
    this.usable = false;
    this.source = null;
    const previous = this.current;
    if (previous === null) { return; }
    await previous.close();
    await this.options.onTerminated(previous.providerInstanceId);
    if (this.current === previous) { this.current = null; }
  }

  private async establish(resume: AgentSessionBinding | null, onStartupPhase?: (phase: StartupPhase) => void, epoch = this.invalidationEpoch): Promise<void> {
    this.requireEpoch(epoch);
    const safety = await this.options.backend.providerSafety();
    this.requireEpoch(epoch);
    if (this.invalidatedGeneration === safety.generation) { throw new ProviderStartInvalidatedError(); }
    this.observedSafetyGeneration = safety.generation;
    if (resume !== null && resume.stateGeneration !== safety.generation) { throw new Error('The session generation has expired.'); }
    reportStartupPhase(onStartupPhase, 'providerStart');
    let candidate: ProviderSession | null | undefined;
    try { candidate = await this.pendingStart?.take(this.options.provider.providerId, resume?.providerSessionId ?? null, safety.generation, this.options.instructionsSha256); }
    catch (error) {
      // Any other refusal has positively stopped the candidate, so the existing fallback may start fresh.
      if (!(error instanceof PendingProviderStopError)) { this.pendingStart = null; }
      this.requireEpoch(epoch);
      throw error;
    }
    this.pendingStart = null;
    if (this.invalidationEpoch !== epoch || !this.options.backend.guardHeld()) {
      if (candidate !== undefined && candidate !== null) { await candidate.close(); await this.options.onTerminated(candidate.providerInstanceId); }
      throw new ProviderStartInvalidatedError();
    }
    const session = candidate ?? await this.options.provider.start(resume?.providerSessionId ?? null);
    try { this.requireEpoch(epoch); await session.verifyLive(); this.requireEpoch(epoch); }
    catch (error) { await session.close(); await this.options.onTerminated(session.providerInstanceId); throw error; }
    this.current = session;
    this.usable = true;
    this.invalidated = false;
    const binding: AgentSessionBinding = resume === null
      ? { agentSessionVersion: 1, providerId: this.options.provider.providerId, providerSessionId: session.providerSessionId, createdAt: utcNow(), turnsCompleted: 0,
        needsState: true, instructionsSha256: this.options.instructionsSha256, stateGeneration: safety.generation }
      : { ...resume, needsState: true };
    try {
      if (session.providerSessionId !== binding.providerSessionId) { throw new Error('Provider returned another session.'); }
      session.onExit(reason => {
        if (this.current !== session || this.closed || !this.usable) { return; }
        this.usable = false;
        this.source = null;
        if (reason === 'providerUnavailable') { this.incompatible = true; this.state('failed'); return; }
        this.state('reconnecting');
        this.options.onExit(session.providerInstanceId, reason);
      });
      reportStartupPhase(onStartupPhase, 'providerBinding');
      this.requireEpoch(epoch);
      const durable = await this.options.backend.sessions.bind(binding, this.options.backend.sessionProof(this.identity(session)));
      this.requireEpoch(epoch);
      await session.verifyLive();
      this.requireEpoch(epoch);
      if (!this.isCurrent(session.providerInstanceId)) { throw new Error('Provider binding became unavailable.'); }
      this.bound = durable.binding;
      this.invalidatedGeneration = null;
      this.source = session.credentialSource;
      this.stateValue = 'ready';
      this.options.onBound(session);
      this.options.changed();
    } catch (error) {
      await this.endCurrent();
      throw error;
    }
  }

  private async attempts(resume: AgentSessionBinding | null, onStartupPhase?: (phase: StartupPhase) => void, epoch = this.invalidationEpoch): Promise<boolean> {
    for (const delay of [1000, 5000, 30000]) {
      this.requireEpoch(epoch);
      reportStartupPhase(onStartupPhase, 'providerRetry');
      await (this.options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(delay);
      this.requireEpoch(epoch);
      try { await this.establish(resume, onStartupPhase, epoch); return true; }
      catch (error) { if (error instanceof PendingProviderStopError || error instanceof ProviderStartInvalidatedError) { throw error; } await this.endCurrent(); }
    }
    this.state('failed');
    return false;
  }

  async start(onStartupPhase?: (phase: StartupPhase) => void): Promise<boolean> {
    if (this.incompatible || this.initialStartActive || this.invalidated) { return false; }
    this.initialStartActive = true;
    const epoch = this.invalidationEpoch;
    try {
      this.requireEpoch(epoch);
      this.state('starting');
      let safety;
      try { safety = await this.options.backend.providerSafety(); this.requireEpoch(epoch); this.observedSafetyGeneration = safety.generation; }
      catch {
        // A blocked state layer is not an observed provider failure. The client
        // remains attached to its startup status without launching a subprocess.
        await this.discardPending();
        return false;
      }
      try {
        const stored = await this.options.backend.sessions.readBinding();
        this.requireEpoch(epoch);
        let reason: StartReason = 'initial';
        if (stored.status === 'valid') {
          if (stored.value.stateGeneration !== safety.generation) { reason = 'stateInvalidated'; }
          else if (stored.value.instructionsSha256 !== this.options.instructionsSha256) { reason = 'instructionsChanged'; }
          else if (stored.value.providerId !== this.options.provider.providerId || !this.options.provider.capabilities.resume) { reason = 'resumeUnavailable'; }
          else {
            try { await this.establish(stored.value, onStartupPhase, epoch); return true; }
            catch (error) { if (error instanceof PendingProviderStopError || error instanceof ProviderStartInvalidatedError) { throw error; } reason = 'resumeFailed'; reportStartupPhase(onStartupPhase, 'providerFallback'); }
          }
        } else if (stored.status === 'invalid') { reason = 'stateInvalidated'; }
        try { await this.establish(null, onStartupPhase, epoch); }
        catch (error) {
          if (error instanceof PendingProviderStopError || error instanceof ProviderStartInvalidatedError) { throw error; }
          if (!await this.attempts(null, onStartupPhase, epoch)) { await this.discardPending(); this.state('failed'); return false; }
        }
        this.options.emit({ type: 'notice', code: 'agentSessionStarted', reason });
        return true;
      } catch { await this.discardPending(); this.state('failed'); return false; }
    } finally { this.initialStartActive = false; }
  }

  async discardPending(): Promise<void> {
    const pending = this.pendingStart;
    this.pendingStart = null;
    await pending?.cancel();
  }

  async verifyLive(): Promise<void> {
    const session = this.current;
    if (session === null || !this.isCurrent(session.providerInstanceId) || this.stateValue !== 'ready') { throw new Error('The provider is not ready.'); }
    await session.verifyLive();
    if (!this.isCurrent(session.providerInstanceId)) { throw new Error('The provider changed during liveness verification.'); }
  }

  async finishFinalSafetyBlock(): Promise<void> {
    this.state('failed');
    await this.endCurrent();
  }

  async replace(reason: StartReason): Promise<boolean> {
    if (this.incompatible || this.initialStartActive) { return false; }
    const epoch = this.invalidationEpoch;
    this.state('starting');
    try {
      await this.endCurrent();
      this.requireEpoch(epoch);
      if (reason === 'stateInvalidated') { await this.awaitNewSafetyGeneration(epoch); }
      await this.establish(null, undefined, epoch);
      this.options.emit({ type: 'notice', code: 'agentSessionStarted', reason });
      return true;
    } catch { this.state('failed'); return false; }
  }

  async resume(sessionId: string): Promise<ResumeResult> {
    if (this.incompatible || this.initialStartActive) { return 'providerUnavailable'; }
    const epoch = this.invalidationEpoch;
    if (!this.capabilities.resume) { return 'capabilityUnavailable'; }
    if (!isOpaqueToken(sessionId)) { return 'unknownSession'; }
    let admitted;
    try {
      const safety = await this.options.backend.providerSafety();
      this.requireEpoch(epoch);
      admitted = await this.options.backend.sessions.admitNamed(this.options.provider.providerId, sessionId, safety.generation, this.options.instructionsSha256);
      this.requireEpoch(epoch);
    } catch { return 'providerUnavailable'; }
    if (admitted.result !== 'admitted') { return admitted.result; }
    const previous = this.bound;
    this.state('starting');
    try {
      await this.endCurrent();
      this.requireEpoch(epoch);
      await this.establish(admitted.binding, undefined, epoch);
      return 'resumed';
    } catch {
      // A failed named start preserves the old durable binding. Its subprocess
      // must be re-established because the provider owns one process namespace.
      try { await this.endCurrent(); this.requireEpoch(epoch); if (previous !== null) { await this.establish(previous, undefined, epoch); } else { this.state('failed'); } }
      catch { this.state('failed'); }
      return 'unknownSession';
    }
  }

  async reconnect(reason: ProviderReconnectReason): Promise<boolean> {
    if (this.incompatible || this.initialStartActive) { return false; }
    const epoch = this.invalidationEpoch;
    const previous = this.bound;
    this.state('reconnecting');
    try {
      await this.endCurrent();
      this.requireEpoch(epoch);
      const safety = await this.options.backend.providerSafety();
      this.requireEpoch(epoch);
      if (previous === null || previous.stateGeneration !== safety.generation) { return this.replace('stateInvalidated'); }
      if (!this.options.provider.capabilities.resume) { return this.replace('resumeUnavailable'); }
      if (!await this.attempts(previous, undefined, epoch)) { return false; }
      this.options.emit({ type: 'notice', code: 'sessionReconnected', reason });
      return true;
    } catch { this.state('failed'); return false; }
  }

  async compacted(): Promise<void> {
    const session = this.current;
    const binding = this.bound;
    if (session === null || binding === null || !this.isCurrent(session.providerInstanceId)) { return; }
    const durable = await this.options.backend.sessions.bind({ ...binding, needsState: true }, this.options.backend.sessionProof(this.identity(session)));
    this.updateBinding(durable.binding);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.suppress();
    await this.discardPending();
    await this.endCurrent();
  }
}
