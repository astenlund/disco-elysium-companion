import assert from 'node:assert/strict';

import type { AcknowledgementOptions, BackendInteraction, BackendStatus, DeliveryHandle, DeliveryPreview, DeliverySnapshot, ProviderIdentity, RuntimeBackend, SendContext } from '../../src/backend/api.ts';
import { parseRuntimeConfig } from '../../src/config.ts';
import type { ContextCandidate } from '../../src/prepared-context.ts';
import type { Provider, ProviderCapabilities, ProviderExitReason, ProviderOutcome, ProviderSession, ProviderTurn } from '../../src/provider.ts';
import type { StateSafety } from '../../src/safety-records.ts';
import { admitNamedSession, indexCurrentBinding, type AgentSessionBinding, type AgentSessionIndex } from '../../src/session-records.ts';
import { initialCapacity } from '../../src/capacity.ts';
import type { BoundSession, SessionBindingProof, SessionStore } from '../../src/session-store.ts';
import type { StoredDocument } from '../../src/storage.ts';
import { recoveryFingerprint } from '../../src/window-recovery.ts';

export const generation = '1'.repeat(32);
export const instructionHash = '2'.repeat(64);
export const timestamp = '2026-10-08T12:00:00.0000000Z';
export const capabilities: ProviderCapabilities = { streamingText: true, dialogs: true, resume: true, interrupt: true, questionOverride: true, compactionBoundaries: true };
export const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };
export async function until(predicate: () => boolean): Promise<void> {
  for (let iteration = 0; iteration < 100; iteration += 1) { if (predicate()) { return; } await flush(); }
  assert.fail('Expected asynchronous transition did not settle.');
}
export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export class FakeSession implements ProviderSession {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly capabilities: ProviderCapabilities;
  readonly credentialSource: string | null;
  private readonly exits: ((reason: ProviderExitReason) => void)[] = [];
  readonly requests: ProviderTurn[] = [];
  action: (request: ProviderTurn, session: FakeSession) => Promise<ProviderOutcome> = async () => ({ kind: 'completed', text: 'answer' });
  beforeSend: (() => Promise<void>) | null = null;
  interruptCount = 0;
  closed = false;
  private stopped = deferred<ProviderOutcome>();

  constructor(id: number, session: string, declarations: ProviderCapabilities) {
    this.providerInstanceId = String(id).padStart(32, '0'); this.providerSessionId = session; this.capabilities = declarations; this.credentialSource = null;
  }
  async sendTurn(request: ProviderTurn): Promise<ProviderOutcome> {
    this.requests.push(request);
    await this.beforeSend?.();
    const contextBlock = await request.beforeSend(request.contextBlock);
    request.onSent();
    return Promise.race([this.action({ ...request, contextBlock }, this), this.stopped.promise]);
  }
  async interrupt(): Promise<boolean> { this.interruptCount += 1; this.stopped.resolve({ kind: 'failed', code: 'interrupted', retryable: true }); return true; }
  async close(): Promise<void> { this.closed = true; this.stopped.resolve({ kind: 'failed', code: 'subprocessExited', retryable: true }); }
  onExit(listener: (reason: ProviderExitReason) => void): void { this.exits.push(listener); }
  exit(reason: ProviderExitReason): void { for (const listener of this.exits) { listener(reason); } }
}
export class FakeProvider implements Provider {
  readonly providerId = 'fake';
  readonly capabilities: ProviderCapabilities;
  readonly sessions: FakeSession[] = [];
  readonly calls: (string | null)[] = [];
  failures = new Set<string>();
  failAll = false;
  configure: (session: FakeSession) => void = () => {};
  constructor(declarations: Partial<ProviderCapabilities> = {}) { this.capabilities = { ...capabilities, ...declarations }; }
  async start(resume: string | null): Promise<ProviderSession> {
    this.calls.push(resume);
    if (this.failAll || resume !== null && this.failures.has(resume)) { throw new Error('Provider start failed.'); }
    const session = new FakeSession(this.sessions.length + 1, resume ?? `session-${this.sessions.length + 1}`, this.capabilities);
    this.configure(session);
    this.sessions.push(session);
    return session;
  }
  get current(): FakeSession { return this.sessions.at(-1)!; }
}

export class FakeBackend {
  readonly config = parseRuntimeConfig({ configVersion: 1, adapter: 'fixture', game: 'fixture', provider: { model: 'ordinary', effort: 'medium', questionOverride: { model: 'override', effort: 'high' } }, watcher: { enabled: false } });
  readonly identities = { runtimeInstanceId: 'a'.repeat(32), runtimeSessionId: 'b'.repeat(32), adapterBindingEpoch: 'c'.repeat(32) };
  readonly scope = { companionRoot: 'C:\\fixture', dataRoot: 'C:\\fixture\\runtime-data', game: 'fixture', principal: 'fixture-principal', bindingSha256: 'd'.repeat(64) };
  readonly events: string[] = [];
  binding: AgentSessionBinding | null = null;
  index: AgentSessionIndex | null = null;
  readonly status: BackendStatus = { consumer: 'owner', freshness: { state: 'fresh', class: null, reason: null, lastGoodGeneratedAt: timestamp, checkedAt: timestamp },
    operational: { state: 'current', warnings: [] }, stateSafety: { state: 'ready', correction: null }, journal: { state: 'healthy', fault: null, unacknowledgedEvents: 0 }, capacity: initialCapacity(), watcher: 'disabled', previousShutdownClean: true };
  safetyValue: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null };
  unavailable = false;
  acquireWait: Promise<void> | null = null;
  ackWait: Promise<void> | null = null;
  ackCount = 0;
  acquisitionCount = 0;
  copied: SendContext | null = null;
  disclosureOnly = false;
  fallback = false;
  failAck = false;

  readonly sessions = {
    readBinding: async (): Promise<StoredDocument<AgentSessionBinding>> => this.binding === null ? { status: 'absent' } : { status: 'valid', value: this.binding, sha256: 'e'.repeat(64) },
    readIndex: async (): Promise<StoredDocument<AgentSessionIndex>> => this.index === null ? { status: 'absent' } : { status: 'valid', value: this.index, sha256: 'f'.repeat(64) },
    admitNamed: async (provider: string, session: string, currentGeneration: string, instructions: string) => admitNamedSession(this.index, provider, session, currentGeneration, instructions),
    bind: async (binding: AgentSessionBinding, proof: SessionBindingProof): Promise<BoundSession> => {
      assert.ok(await proof.verify(binding));
      this.events.push(`bind:${binding.providerSessionId}:${binding.turnsCompleted}:${binding.needsState}`);
      this.binding = binding;
      this.index = indexCurrentBinding(this.index, binding, timestamp);
      return { binding, bindingSha256: 'e'.repeat(64), indexSha256: 'f'.repeat(64) };
    },
  } as SessionStore;

  async safety(): Promise<StateSafety> { if (this.unavailable) { throw new Error('Safety unavailable.'); } return this.safetyValue; }
  async providerSafety(): Promise<StateSafety> {
    const safety = await this.safety();
    if (safety.pendingCheck !== null || safety.correction !== null && safety.correction.recoveryOperationId === null) { throw new Error('Provider history admission is unresolved.'); }
    return safety;
  }
  sessionProof(provider: ProviderIdentity): SessionBindingProof {
    return { verify: async binding => !this.unavailable && provider.isCurrent() && binding.stateGeneration === this.safetyValue.generation
      && binding.providerId === provider.providerId && binding.providerSessionId === provider.providerSessionId };
  }
  async acquire(interaction: BackendInteraction): Promise<DeliverySnapshot> {
    this.acquisitionCount += 1; this.events.push('acquire'); await this.acquireWait;
    return { interaction, generation: this.safetyValue.generation, disclosureOnly: this.disclosureOnly, freshness: this.status.freshness, relevanceFingerprint: recoveryFingerprint('content') };
  }
  async preview(_snapshot: DeliverySnapshot, _binding: AgentSessionBinding, _half: number | null): Promise<DeliveryPreview> {
    if (_snapshot.disclosureOnly) {
      return { preview: { candidates: [{ shape: 1, sha256: 'd'.repeat(64), fingerprint: recoveryFingerprint('disclosure'), bytes: 70, eventCount: 0, stateIncluded: false, degraded: null }] }, relevanceFingerprint: recoveryFingerprint('content') };
    }
    const candidates: ContextCandidate[] = [1, 2, 3, 4].map(shape => ({ shape: shape as 1 | 2 | 3 | 4, sha256: String(shape).repeat(64), fingerprint: recoveryFingerprint(`shape-${shape}`), bytes: 500 - 100 * shape,
      eventCount: 1, stateIncluded: shape < 4, degraded: shape === 4 ? 'stateTooLarge' : null }));
    return { preview: { candidates }, relevanceFingerprint: recoveryFingerprint('content') };
  }
  async prepare(snapshot: DeliverySnapshot, preview: DeliveryPreview, candidate: ContextCandidate): Promise<DeliveryHandle> {
    assert.ok(preview.preview.candidates.includes(candidate)); this.events.push('prepare');
    return { snapshot, candidate, prepared: { candidate, cleanupComplete: true }, contextBlock: '<companion-turn-context>context</companion-turn-context>' };
  }
  async copyForSend(handle: DeliveryHandle, binding: AgentSessionBinding, provider: ProviderIdentity): Promise<SendContext> {
    assert.ok(await this.sessionProof(provider).verify(binding)); this.events.push('copy');
    const disclosureOnly = this.fallback || handle.snapshot.disclosureOnly;
    const candidate = disclosureOnly ? { ...handle.candidate, shape: 1 as const, fingerprint: recoveryFingerprint('disclosure'), bytes: 70, stateIncluded: false, eventCount: 0, degraded: null } : handle.candidate;
    this.copied = { text: disclosureOnly ? '<companion-turn-context>disclosure</companion-turn-context>' : '<companion-turn-context>context</companion-turn-context>', candidate, disclosureOnly, redelivery: false, relevanceFingerprint: recoveryFingerprint('content') };
    return this.copied;
  }
  async markSent(): Promise<boolean> { this.events.push('markSent'); return true; }
  async discard(): Promise<void> { this.events.push('discard'); }
  async acknowledge(_handle: DeliveryHandle, binding: AgentSessionBinding, provider: ProviderIdentity, options: AcknowledgementOptions): Promise<BoundSession | null> {
    this.events.push('ack-start'); await this.ackWait;
    if (this.failAck || this.copied?.disclosureOnly) { return null; }
    assert.ok(await this.sessionProof(provider).verify(binding));
    this.ackCount += 1;
    const result = await this.sessions.bind({ ...binding, turnsCompleted: binding.turnsCompleted + 1, needsState: options.compactedDuringTurn || !options.compactionCapability }, this.sessionProof(provider));
    this.events.push('ack-end'); return result;
  }
  async shutdown(quiescent: boolean): Promise<void> { assert.equal(quiescent, true); this.events.push('shutdown'); }
  async beginShutdown(): Promise<void> { this.events.push('stopping'); }
  asRuntime(): RuntimeBackend { return this as unknown as RuntimeBackend; }
}
