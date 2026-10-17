import type { ModelChoice } from './config.ts';

export interface ProviderCapabilities {
  readonly streamingText: boolean;
  readonly dialogs: boolean;
  readonly resume: boolean;
  readonly interrupt: boolean;
  readonly questionOverride: boolean;
  readonly compactionBoundaries: boolean;
}

export interface DialogOption { readonly label: string; readonly description: string; readonly preview?: string }
export interface DialogQuestion { readonly question: string; readonly header: string; readonly options: readonly DialogOption[]; readonly multiSelect: boolean }
export type DialogAnswer = { readonly answers: Readonly<Record<string, string>> } | { readonly cancelled: true };
export type ProviderFailureCode = 'interrupted' | 'subprocessExited' | 'providerError' | 'authenticationFailed' | 'rateLimited' | 'contextExhausted';
export type ProviderOutcome = { readonly kind: 'completed'; readonly text: string } | { readonly kind: 'failed'; readonly code: ProviderFailureCode; readonly retryable: boolean };
export type ProviderSignal = { readonly kind: 'text'; readonly fragment: string } | { readonly kind: 'compaction' } | { readonly kind: 'source'; readonly credentialSource: string | null };

export interface ProviderTurn {
  readonly contextBlock: string;
  readonly playerText: string;
  readonly override: ModelChoice | null;
  readonly askUser: (questions: readonly DialogQuestion[]) => Promise<DialogAnswer>;
  readonly onSignal: (signal: ProviderSignal) => void;
  // Recheck after override setup. A changed dependency may replace the prepared
  // block with this interaction's frozen disclosure block before any input is sent.
  readonly beforeSend: (preparedContext: string) => Promise<string>;
  // The provider must call this synchronously after preparation, immediately before enqueue.
  readonly beforeEnqueue: () => void;
  readonly onSent: () => void;
}

export type ProviderReconnectReason = 'subprocessExited' | 'overrideReset';
export type ProviderExitReason = ProviderReconnectReason | 'providerUnavailable';
export interface ProviderSession {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly capabilities: ProviderCapabilities;
  readonly credentialSource: string | null;
  sendTurn(request: ProviderTurn): Promise<ProviderOutcome>;
  interrupt(): Promise<boolean>;
  isLive(): boolean;
  verifyLive(): Promise<void>;
  close(): Promise<void>;
  onExit(listener: (reason: ProviderExitReason) => void): void;
}

export interface Provider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  start(resumeSessionId: string | null, signal?: AbortSignal): Promise<ProviderSession>;
}
