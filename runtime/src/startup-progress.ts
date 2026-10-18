import { performance } from 'node:perf_hooks';

export type StartupPhase = 'configuration' | 'scopeAdmission' | 'instanceGuard' | 'runtimeMarker' | 'storageRecovery'
  | 'consumerReconciliation' | 'streamRecovery' | 'outboxDrain' | 'startupAcquisition' | 'safetyReconciliation'
  | 'retention' | 'watcher' | 'providerPreparation' | 'providerPrestart' | 'providerSelection' | 'providerStart' | 'providerBinding' | 'providerFallback' | 'providerRetry' | 'attachmentSafety' | 'startupWorkerClosure';
export type StartupProgressKind = 'phase' | 'heartbeat' | 'imageAbsent' | 'ready' | 'notOwner' | 'providerUnavailable' | 'failed';
export interface StartupProgress {
  readonly kind: StartupProgressKind;
  readonly phase: StartupPhase | null;
  readonly at: string;
  readonly elapsedMs: number;
  readonly selectionMs?: number;
}
export type StartupProgressSink = (event: StartupProgress) => void;
export const startupHeartbeatMs = 15000;

const phaseLabels: Readonly<Record<StartupPhase, string>> = {
  configuration: 'loading configuration',
  scopeAdmission: 'validating the companion scope',
  instanceGuard: 'claiming the runtime instance',
  runtimeMarker: 'initializing runtime metadata',
  storageRecovery: 'checking durable storage',
  consumerReconciliation: 'reconciling consumer ownership',
  streamRecovery: 'reconciling recovery',
  outboxDrain: 'draining pending state records',
  startupAcquisition: 'acquiring current state',
  safetyReconciliation: 'checking state safety',
  retention: 'finishing storage maintenance',
  watcher: 'starting the save watcher',
  providerPreparation: 'preparing provider tools and instructions',
  providerPrestart: 'checking guarded unbound provider startup',
  providerSelection: 'checking provider safety and session binding',
  providerStart: 'starting the provider session',
  providerBinding: 'binding the provider session durably',
  providerFallback: 'switching to a fresh provider session',
  providerRetry: 'waiting to retry provider startup',
  attachmentSafety: 'checking final attachment safety',
  startupWorkerClosure: 'closing startup workers',
};

export function reportStartupPhase(callback: ((phase: StartupPhase) => void) | undefined, phase: StartupPhase): void {
  try { callback?.(phase); }
  catch { /* Progress reporting cannot change startup authority or its failure path. */ }
}

export function formatStartupProgress(event: StartupProgress): string {
  const elapsed = `${Math.floor(event.elapsedMs / 1000)}s`;
  const prefix = `[${event.at}] startup: `;
  if (event.kind === 'phase' || event.kind === 'heartbeat') {
    const label = event.phase === null ? 'working' : phaseLabels[event.phase];
    return `${prefix}${label}; elapsed ${elapsed}${event.kind === 'heartbeat' ? '; still working' : ''}`;
  }
  if (event.kind === 'imageAbsent') {
    const selection = Math.floor((event.selectionMs ?? 0) / 1000);
    return `${prefix}compiled images absent; using PowerShell fallback; image selection ${selection}s; elapsed ${elapsed}`;
  }
  const outcome = event.kind === 'ready' ? 'chat client ready' : event.kind === 'notOwner' ? 'stopped: runtime is not the consumer'
    : event.kind === 'providerUnavailable' ? 'stopped: provider unavailable' : 'failed';
  return `${prefix}${outcome}; elapsed ${elapsed}`;
}

export class StartupProgressReporter {
  private readonly startedAt: number;
  private readonly timer: NodeJS.Timeout | null;
  private readonly sink: StartupProgressSink | undefined;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => Date;
  private currentPhase: StartupPhase | null = null;
  private lastProgressAt: number;
  private finished = false;

  constructor(sink?: StartupProgressSink, heartbeatMs = startupHeartbeatMs,
    monotonicNow: () => number = () => performance.now(), wallNow: () => Date = () => new Date()) {
    this.sink = sink;
    this.monotonicNow = monotonicNow;
    this.wallNow = wallNow;
    this.startedAt = this.monotonicNow();
    this.lastProgressAt = this.startedAt;
    this.timer = sink === undefined ? null : setInterval(() => {
      const now = this.monotonicNow();
      if (this.currentPhase !== null && !this.finished && now - this.lastProgressAt >= heartbeatMs) {
        this.lastProgressAt = now;
        this.emit('heartbeat', this.currentPhase);
      }
    }, heartbeatMs);
    this.timer?.unref();
  }

  phase(phase: StartupPhase): void {
    if (this.finished || this.currentPhase === phase) { return; }
    this.currentPhase = phase;
    this.lastProgressAt = this.monotonicNow();
    this.emit('phase', phase);
  }

  imageAbsent(selectionMs: number): void {
    if (this.finished) { return; }
    this.emit('imageAbsent', this.currentPhase, Number.isFinite(selectionMs) && selectionMs >= 0 ? selectionMs : 0);
  }

  finish(kind: 'ready' | 'notOwner' | 'providerUnavailable' | 'failed'): void {
    if (this.finished) { return; }
    this.finished = true;
    if (this.timer !== null) { clearInterval(this.timer); }
    this.emit(kind, null);
  }

  private emit(kind: StartupProgressKind, phase: StartupPhase | null, selectionMs?: number): void {
    try { this.sink?.({ kind, phase, at: this.wallNow().toISOString(), elapsedMs: Math.max(0, this.monotonicNow() - this.startedAt),
      ...(selectionMs === undefined ? {} : { selectionMs }) }); }
    catch { /* Progress output cannot change startup authority or its failure path. */ }
  }
}
