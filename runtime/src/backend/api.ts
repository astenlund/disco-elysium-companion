import type { RuntimeConfig } from '../config.ts';
import type { CapacityStatus } from '../capacity.ts';
import type { ConsumerReceipt, CoreResult } from '../core-client.ts';
import type { ProcessIdentities } from '../identity.ts';
import type { OperationalStatus } from '../operational.ts';
import type { ContextCandidate, ContextPreview, PreparedContext } from '../prepared-context.ts';
import type { CorrectionReason, StateSafety } from '../safety-records.ts';
import type { RuntimeScope } from '../scope.ts';
import type { AgentSessionBinding } from '../session-records.ts';
import type { BoundSession, SessionBindingProof, SessionStore } from '../session-store.ts';
import type { Deadline } from '../deadline.ts';
import type { PathInspector } from '../admission.ts';
import type { ProcessSupervisor } from '../process.ts';
import type { StartupPhase } from '../startup-progress.ts';
import type { CarryReleaseStatus } from './provider-authority.ts';

export type BackendCommand = { readonly kind: 'chat' | 'repair' } | { readonly kind: 'consumer'; readonly owner: 'runtime' | 'bridge'; readonly abandonUndelivered: boolean };

export class PendingStateCheckError extends Error {
  override readonly name = 'PendingStateCheckError';
  constructor() { super('A durable state check remains pending until startup reconciliation.'); }
}

export interface Freshness {
  readonly state: 'unknown' | 'acquiring' | 'fresh' | 'failed';
  readonly class: string | null;
  readonly reason: string | null;
  readonly lastGoodGeneratedAt: string | null;
  readonly checkedAt: string | null;
}
export interface BackendStatus {
  readonly capacity: CapacityStatus;
  readonly consumer: 'owner' | 'notOwner' | 'unknown';
  readonly freshness: Freshness;
  readonly operational: OperationalStatus;
  readonly stateSafety: { readonly state: 'ready' | 'recovering' | 'unavailable'; readonly correction: { readonly correctionId: string; readonly reason: CorrectionReason } | null; readonly carryRelease: CarryReleaseStatus };
  readonly journal: { readonly state: 'healthy' | 'repairing' | 'fault'; readonly fault: string | null; readonly unacknowledgedEvents: number };
  readonly watcher: 'disabled' | 'running' | 'restarting' | 'stopped';
  readonly previousShutdownClean: boolean;
}
export interface BackendInteraction { readonly interactionId: string; readonly requestReceivedAt: string }
export interface DeliverySnapshot {
  readonly interaction: BackendInteraction;
  readonly generation: string;
  readonly disclosureOnly: boolean;
  readonly freshness: Freshness;
  readonly relevanceFingerprint: string;
}
export interface DeliveryPreview {
  readonly preview: ContextPreview;
  readonly relevanceFingerprint: string;
}
export interface DeliveryHandle {
  readonly contextBlock: string;
  readonly prepared: PreparedContext;
  readonly candidate: ContextCandidate;
  readonly snapshot: DeliverySnapshot;
}
export interface SendContext { readonly text: string; readonly candidate: ContextCandidate; readonly relevanceFingerprint: string; readonly disclosureOnly: boolean; readonly redelivery: boolean }
export interface ProviderIdentity {
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly isCurrent: () => boolean;
}
export interface AcknowledgementOptions { readonly compactedDuringTurn: boolean; readonly compactionCapability: boolean }
export interface CapacityRewindResult {
  readonly affectedEvents: number | null;
  readonly fromSequence: number | null;
  readonly throughSequence: number | null;
  readonly retainedHandoffs: number | null;
  readonly replayableHandoffs: number | null;
  readonly presentationRetiredHandoffs: number | null;
  readonly survivingCoreRecords: number | null;
}
export interface BackendStartup { readonly notOwner: boolean; readonly consumerResult: CoreResult<ConsumerReceipt> | null; readonly requiredWorkCompleted: boolean; readonly capacityRewind: CapacityRewindResult | null }
export interface BackendOptions {
  readonly companionRoot: string;
  readonly startupMetadata?: boolean;
  readonly onStatus?: (status: BackendStatus) => void;
  readonly onInvalidated?: (reason: CorrectionReason) => void;
  readonly onDiagnostic?: (phase: string, error: unknown) => void;
  readonly onStartupPhase?: (phase: StartupPhase) => void;
}

export interface RuntimeBackend {
  readonly config: RuntimeConfig;
  readonly identities: ProcessIdentities;
  readonly scope: RuntimeScope;
  readonly sessions: SessionStore;
  readonly supervisor: ProcessSupervisor;
  readonly inspector: PathInspector;
  readonly status: BackendStatus;
  guardHeld(): boolean;
  startup(command: BackendCommand): Promise<BackendStartup>;
  safety(deadline?: Deadline): Promise<StateSafety>;
  providerSafety(deadline?: Deadline): Promise<StateSafety>;
  sessionProof(provider: ProviderIdentity): SessionBindingProof;
  acquire(interaction: BackendInteraction): Promise<DeliverySnapshot>;
  preview(snapshot: DeliverySnapshot, binding: AgentSessionBinding, halfPrefixBytes: number | null, providerFingerprint?: string): Promise<DeliveryPreview>;
  prepare(snapshot: DeliverySnapshot, preview: DeliveryPreview, candidate: ContextCandidate): Promise<DeliveryHandle>;
  copyForSend(handle: DeliveryHandle, binding: AgentSessionBinding, provider: ProviderIdentity): Promise<SendContext>;
  discard(handle: DeliveryHandle): Promise<void>;
  markSent(handle: DeliveryHandle): Promise<boolean>;
  acknowledge(handle: DeliveryHandle, binding: AgentSessionBinding, provider: ProviderIdentity, options: AcknowledgementOptions): Promise<BoundSession | null>;
  beginShutdown(): Promise<void>;
  closeStartupMetadata(): Promise<void>;
  closeStartupWorkers(): Promise<void>;
  shutdown(providerAndToolsQuiescent: boolean): Promise<void>;
}
