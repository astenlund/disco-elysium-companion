import type { DialogQuestion, ProviderCapabilities } from './provider.ts';
import type { WindowSummary } from './window-recovery.ts';
import type { BackendStatus } from './backend/api.ts';

export interface Interaction {
  readonly interactionId: string;
  readonly requestReceivedAt: string;
  readonly ingressOrder: number;
}

export interface HostIdentities {
  readonly runtimeInstanceId: string;
  readonly runtimeSessionId: string;
  readonly adapter: string;
  readonly adapterBindingEpoch: string;
  readonly principal: string;
  readonly playSessionId: null;
}

export interface Correction { readonly correctionId: string; readonly reason: 'coreRejected' | 'contextUncertain' }
export interface HostStatus extends BackendStatus {
  readonly provider: { readonly state: 'starting' | 'ready' | 'reconnecting' | 'failed'; readonly credentialSource: string | null };
  readonly windowRecovery: WindowSummary | null;
}
export interface AgentSessionSummary {
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly createdAt: string;
  readonly turnsCompleted: number;
  readonly needsState: boolean;
}
export interface HostDialog extends Interaction {
  readonly dialogId: string;
  readonly questions: readonly DialogQuestion[];
}
export interface HostSnapshot extends HostIdentities {
  readonly sessionHostVersion: 1;
  readonly capabilities: ProviderCapabilities;
  readonly status: HostStatus;
  readonly agentSession: AgentSessionSummary | null;
  readonly openDialog: HostDialog | null;
}
export type StartReason = 'initial' | 'resumeUnavailable' | 'resumeFailed' | 'instructionsChanged' | 'requested' | 'stateInvalidated';
export type HostNotice =
  | { readonly type: 'notice'; readonly code: 'agentSessionStarted'; readonly reason: StartReason }
  | { readonly type: 'notice'; readonly code: 'sessionReconnected'; readonly reason: 'subprocessExited' | 'overrideReset' }
  | { readonly type: 'notice'; readonly code: 'stateRedelivered'; readonly reason: null }
  | { readonly type: 'notice'; readonly code: 'stateContextInvalidated'; readonly reason: Correction['reason'] };
export type TurnFailure = 'interrupted' | 'subprocessExited' | 'providerError' | 'authenticationFailed' | 'rateLimited' | 'contextExhausted' | 'stateInvalidated';
export type HostEvent = HostNotice
  | ({ readonly type: 'turn.started' } & Interaction)
  | ({ readonly type: 'turn.delta'; readonly fragment: string } & Interaction)
  | ({ readonly type: 'turn.completed'; readonly text: string } & Interaction)
  | ({ readonly type: 'turn.failed'; readonly code: TurnFailure; readonly retryable: boolean } & Interaction)
  | ({ readonly type: 'dialog.requested' } & HostDialog)
  | { readonly type: 'dialog.closed'; readonly dialogId: string; readonly reason: 'answered' | 'cancelled' | 'turnEnded' }
  | { readonly type: 'context.compacted' }
  | { readonly type: 'status.changed'; readonly status: HostStatus };
export type ClientSink = (event: HostEvent) => void;
export type SubmitResult = ({ readonly result: 'admitted' } & Interaction)
  | { readonly result: 'turnInProgress' | 'notReady' | 'providerUnavailable' | 'capabilityUnavailable' | 'invalidInput' };
export type ResumeResult = 'resumed' | 'unknownSession' | 'stateInvalidated' | 'instructionsChanged' | 'turnInProgress' | 'capabilityUnavailable' | 'providerUnavailable';

export interface SessionHostV1 {
  attach(sink: ClientSink): { readonly result: 'attached'; readonly snapshot: HostSnapshot } | { readonly result: 'clientAlreadyAttached' };
  detach(): void;
  submitChat(input: { readonly text: string; readonly questionOverride: boolean }): SubmitResult;
  answerDialog(input: { readonly dialogId: string; readonly answers: Readonly<Record<string, string>> } | { readonly dialogId: string; readonly cancelled: true }): 'accepted' | 'unknownDialog' | 'invalidAnswer';
  interrupt(): Promise<'interrupted' | 'noTurnInProgress' | 'capabilityUnavailable'>;
  startNewAgentSession(): Promise<'started' | 'turnInProgress' | 'providerUnavailable'>;
  resumeAgentSession(providerSessionId: string): Promise<ResumeResult>;
  shutdown(): Promise<void>;
}
