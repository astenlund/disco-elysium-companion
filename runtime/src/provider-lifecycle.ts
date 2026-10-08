import type { RuntimeBackend, ProviderIdentity } from './backend/api.ts';
import { isOpaqueToken } from './identity.ts';
import { utcNow } from './json.ts';
import type { Provider, ProviderCapabilities, ProviderReconnectReason, ProviderSession } from './provider.ts';
import type { AgentSessionBinding } from './session-records.ts';
import type { HostNotice, ResumeResult, StartReason } from './session-host-contract.ts';

export interface ProviderLifecycleOptions {
  readonly backend: RuntimeBackend;
  readonly provider: Provider;
  readonly instructionsSha256: string;
  readonly emit: (event: HostNotice) => void;
  readonly changed: () => void;
  readonly onExit: (instance: string, reason: ProviderReconnectReason) => void;
  readonly onBound: (session: ProviderSession) => void;
  readonly onTerminated: (instance: string) => Promise<void>;
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
  private stateValue: 'starting' | 'ready' | 'reconnecting' | 'failed' = 'starting';
  private source: string | null = null;

  constructor(options: ProviderLifecycleOptions) { this.options = options; }

  get session(): ProviderSession | null { return this.current; }
  get binding(): AgentSessionBinding | null { return this.bound; }
  get capabilities(): ProviderCapabilities { return this.current?.capabilities ?? this.options.provider.capabilities; }
  get status(): { readonly state: 'starting' | 'ready' | 'reconnecting' | 'failed'; readonly credentialSource: string | null } {
    return { state: this.stateValue, credentialSource: this.source };
  }
  isCurrent(instance: string): boolean { return this.usable && !this.closed && this.current?.providerInstanceId === instance; }
  identity(session: ProviderSession): ProviderIdentity {
    return { providerId: this.options.provider.providerId, providerSessionId: session.providerSessionId,
      isCurrent: () => !this.invalidated && !this.closed && !this.incompatible && this.current === session };
  }
  observeSource(instance: string, source: string | null): void {
    if (!this.isCurrent(instance)) { return; }
    this.source = source;
    this.options.changed();
  }
  suppress(): void { this.usable = false; this.invalidated = true; this.source = null; this.options.changed(); }
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

  private async establish(resume: AgentSessionBinding | null): Promise<void> {
    if (this.closed || this.incompatible) { throw new Error('The provider lifecycle is unavailable.'); }
    const safety = await this.options.backend.providerSafety();
    if (resume !== null && resume.stateGeneration !== safety.generation) { throw new Error('The session generation has expired.'); }
    const session = await this.options.provider.start(resume?.providerSessionId ?? null);
    if (this.closed) {
      await session.close();
      await this.options.onTerminated(session.providerInstanceId);
      throw new Error('The provider lifecycle closed during startup.');
    }
    this.current = session;
    this.usable = true;
    this.invalidated = false;
    const binding: AgentSessionBinding = resume === null
      ? { agentSessionVersion: 1, providerId: this.options.provider.providerId, providerSessionId: session.providerSessionId, createdAt: utcNow(), turnsCompleted: 0,
        needsState: true, instructionsSha256: this.options.instructionsSha256, stateGeneration: safety.generation }
      : { ...resume, needsState: true };
    try {
      if (session.providerSessionId !== binding.providerSessionId) { throw new Error('Provider returned another session.'); }
      const durable = await this.options.backend.sessions.bind(binding, this.options.backend.sessionProof(this.identity(session)));
      if (!this.isCurrent(session.providerInstanceId)) { throw new Error('Provider binding became unavailable.'); }
      this.bound = durable.binding;
      this.source = session.credentialSource;
      this.stateValue = 'ready';
      this.options.onBound(session);
      session.onExit(reason => {
        if (!this.isCurrent(session.providerInstanceId)) { return; }
        this.usable = false;
        this.source = null;
        if (reason === 'providerUnavailable') {
          this.incompatible = true;
          this.state('failed');
          return;
        }
        this.state('reconnecting');
        this.options.onExit(session.providerInstanceId, reason);
      });
      this.options.changed();
    } catch (error) {
      await this.endCurrent();
      throw error;
    }
  }

  private async attempts(resume: AgentSessionBinding | null): Promise<boolean> {
    for (const delay of [1000, 5000, 30000]) {
      if (this.closed) { return false; }
      await (this.options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(delay);
      if (this.closed) { return false; }
      try { await this.establish(resume); return true; }
      catch { await this.endCurrent(); }
    }
    this.state('failed');
    return false;
  }

  async start(): Promise<boolean> {
    if (this.incompatible) { return false; }
    this.state('starting');
    let safety;
    try { safety = await this.options.backend.providerSafety(); }
    catch {
      // A blocked state layer is not an observed provider failure. The client
      // remains attached to its startup status without launching a subprocess.
      return false;
    }
    try {
      const stored = await this.options.backend.sessions.readBinding();
      let reason: StartReason = 'initial';
      if (stored.status === 'valid') {
        if (stored.value.stateGeneration !== safety.generation) { reason = 'stateInvalidated'; }
        else if (stored.value.instructionsSha256 !== this.options.instructionsSha256) { reason = 'instructionsChanged'; }
        else if (stored.value.providerId !== this.options.provider.providerId || !this.options.provider.capabilities.resume) { reason = 'resumeUnavailable'; }
        else {
          try { await this.establish(stored.value); return true; }
          catch { reason = 'resumeFailed'; }
        }
      } else if (stored.status === 'invalid') { reason = 'stateInvalidated'; }
      try { await this.establish(null); }
      catch { if (!await this.attempts(null)) { return false; } }
      this.options.emit({ type: 'notice', code: 'agentSessionStarted', reason });
      return true;
    } catch { this.state('failed'); return false; }
  }

  async replace(reason: StartReason): Promise<boolean> {
    if (this.incompatible) { return false; }
    this.state('starting');
    try {
      await this.endCurrent();
      await this.establish(null);
      this.options.emit({ type: 'notice', code: 'agentSessionStarted', reason });
      return true;
    } catch { this.state('failed'); return false; }
  }

  async resume(sessionId: string): Promise<ResumeResult> {
    if (this.incompatible) { return 'providerUnavailable'; }
    if (!this.capabilities.resume) { return 'capabilityUnavailable'; }
    if (!isOpaqueToken(sessionId)) { return 'unknownSession'; }
    let admitted;
    try {
      const safety = await this.options.backend.providerSafety();
      admitted = await this.options.backend.sessions.admitNamed(this.options.provider.providerId, sessionId, safety.generation, this.options.instructionsSha256);
    } catch { return 'providerUnavailable'; }
    if (admitted.result !== 'admitted') { return admitted.result; }
    const previous = this.bound;
    this.state('starting');
    try {
      await this.endCurrent();
      await this.establish(admitted.binding);
      return 'resumed';
    } catch {
      // A failed named start preserves the old durable binding. Its subprocess
      // must be re-established because the provider owns one process namespace.
      try { await this.endCurrent(); if (previous !== null) { await this.establish(previous); } else { this.state('failed'); } }
      catch { this.state('failed'); }
      return 'unknownSession';
    }
  }

  async reconnect(reason: ProviderReconnectReason): Promise<boolean> {
    if (this.incompatible) { return false; }
    const previous = this.bound;
    this.state('reconnecting');
    try {
      await this.endCurrent();
      const safety = await this.options.backend.providerSafety();
      if (previous === null || previous.stateGeneration !== safety.generation) { return this.replace('stateInvalidated'); }
      if (!this.options.provider.capabilities.resume) { return this.replace('resumeUnavailable'); }
      if (!await this.attempts(previous)) { return false; }
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
    await this.endCurrent();
  }
}
