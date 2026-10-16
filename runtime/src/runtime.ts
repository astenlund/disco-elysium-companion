import { openBackend } from './backend/index.ts';
import type { RuntimeBackend } from './backend/api.ts';
import { ClaudeProvider } from './claude-provider.ts';
import { FileToolAdapter } from './file-tool-adapter.ts';
import { assembleInstructions } from './instructions.ts';
import { SessionHost } from './session-host.ts';
import type { Correction } from './session-host-contract.ts';
import { reportStartupPhase, type StartupPhase } from './startup-progress.ts';

export type ChatRuntime = { readonly result: 'ready'; readonly host: SessionHost }
  | { readonly result: 'notOwner' } | { readonly result: 'providerUnavailable' };

/** @internal Cleanup must continue even when the worker cannot close. */
export async function cleanupFailedChatRuntime(error: unknown, backend: RuntimeBackend | null, host: SessionHost | null, files: FileToolAdapter | null,
  onStartupPhase?: (phase: StartupPhase) => void): Promise<never> {
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  if (backend !== null) { reportStartupPhase(onStartupPhase, 'startupWorkerClosure'); }
  try { await backend?.closeStartupWorkers(); }
  catch (failure) { cleanupFailed = true; cleanupFailure = failure; }
  try {
    if (host !== null) { await host.shutdown(); }
    else if (backend !== null) {
      await backend.beginShutdown();
      await backend.supervisor.verifyQuiescent('provider');
      await files?.verifyQuiescent();
      await backend.shutdown(true);
      await files?.close();
    }
  } catch (failure) { cleanupFailed = true; cleanupFailure = failure; }
  if (cleanupFailed) { throw cleanupFailure; }
  throw error;
}

export async function createChatRuntime(companionRoot: string, onStartupPhase?: (phase: StartupPhase) => void): Promise<ChatRuntime> {
  const reportPhase = onStartupPhase === undefined ? undefined : (phase: StartupPhase) => reportStartupPhase(onStartupPhase, phase);
  let host: SessionHost | null = null;
  let backend: RuntimeBackend | null = null;
  let files: FileToolAdapter | null = null;
  try {
    const opened: RuntimeBackend = await openBackend({ companionRoot, startupMetadata: true, onStatus: () => host?.statusChanged(), onInvalidated: (reason: Correction['reason']) => host?.invalidate(reason), onStartupPhase: reportPhase });
    backend = opened;
    const startup = await backend.startup({ kind: 'chat' });
    if (startup.notOwner) { reportPhase?.('startupWorkerClosure'); await backend.closeStartupWorkers(); await backend.shutdown(true); return { result: 'notOwner' }; }
    reportPhase?.('providerPreparation');
    const instructions = await assembleInstructions(backend.inspector, backend.scope.companionRoot);
    files = await FileToolAdapter.create({ companionRoot: backend.scope.companionRoot, inspector: backend.inspector, supervisor: backend.supervisor,
      isActive: (instance, session) => host?.isToolActive(instance, session) ?? false, dialogsAvailable: () => host?.dialogsAvailable ?? false });
    const fileTools = files;
    const provider = new ClaudeProvider({ companionRoot: backend.scope.companionRoot, config: backend.config, appendText: instructions.text, supervisor: backend.supervisor,
      boundary: instance => fileTools.boundary(instance), isCurrent: instance => host?.isProviderCurrent(instance) ?? false,
      onPassiveSignal: (instance, signal) => host?.passiveSignal(instance, signal) });
    host = new SessionHost({ backend, provider, instructionsSha256: instructions.sha256,
      providerTerminated: instance => fileTools.providerTerminated(instance), verifyTools: () => fileTools.verifyQuiescent(), closeTools: () => fileTools.close() });
    reportPhase?.('providerSelection');
    if (!await host.start(reportPhase) && host.status.provider.state === 'failed') {
      reportPhase?.('startupWorkerClosure');
      await backend.closeStartupWorkers();
      await host.shutdown();
      return { result: 'providerUnavailable' };
    }
    reportPhase?.('startupWorkerClosure');
    await backend.closeStartupWorkers();
    return { result: 'ready', host };
  } catch (error) {
    return cleanupFailedChatRuntime(error, backend, host, files, reportPhase);
  }
}
