import { openBackend } from './backend/index.ts';
import type { RuntimeBackend } from './backend/api.ts';
import { ClaudeProvider } from './claude-provider.ts';
import { FileToolAdapter } from './file-tool-adapter.ts';
import { assembleInstructions } from './instructions.ts';
import { SessionHost } from './session-host.ts';
import type { Correction } from './session-host-contract.ts';
import type { StartupPhase } from './startup-progress.ts';

export type ChatRuntime = { readonly result: 'ready'; readonly host: SessionHost }
  | { readonly result: 'notOwner' } | { readonly result: 'providerUnavailable' };

export async function createChatRuntime(companionRoot: string, onStartupPhase?: (phase: StartupPhase) => void): Promise<ChatRuntime> {
  let host: SessionHost | null = null;
  let backend: RuntimeBackend | null = null;
  let files: FileToolAdapter | null = null;
  try {
    const opened: RuntimeBackend = await openBackend({ companionRoot, onStatus: () => host?.statusChanged(), onInvalidated: (reason: Correction['reason']) => host?.invalidate(reason), onStartupPhase });
    backend = opened;
    const startup = await backend.startup({ kind: 'chat' });
    if (startup.notOwner) { await backend.shutdown(true); return { result: 'notOwner' }; }
    onStartupPhase?.('providerPreparation');
    const instructions = await assembleInstructions(backend.inspector, backend.scope.companionRoot);
    files = await FileToolAdapter.create({ companionRoot: backend.scope.companionRoot, inspector: backend.inspector, supervisor: backend.supervisor,
      isActive: (instance, session) => host?.isToolActive(instance, session) ?? false, dialogsAvailable: () => host?.dialogsAvailable ?? false });
    const fileTools = files;
    const provider = new ClaudeProvider({ companionRoot: backend.scope.companionRoot, config: backend.config, appendText: instructions.text, supervisor: backend.supervisor,
      boundary: instance => fileTools.boundary(instance), isCurrent: instance => host?.isProviderCurrent(instance) ?? false,
      onPassiveSignal: (instance, signal) => host?.passiveSignal(instance, signal) });
    host = new SessionHost({ backend, provider, instructionsSha256: instructions.sha256,
      providerTerminated: instance => fileTools.providerTerminated(instance), verifyTools: () => fileTools.verifyQuiescent(), closeTools: () => fileTools.close() });
    onStartupPhase?.('providerStart');
    if (!await host.start() && host.status.provider.state === 'failed') { await host.shutdown(); return { result: 'providerUnavailable' }; }
    return { result: 'ready', host };
  } catch (error) {
    if (host !== null) { await host.shutdown(); }
    else if (backend !== null) {
      await backend.supervisor.verifyQuiescent('provider');
      await files?.verifyQuiescent();
      await backend.shutdown(true);
      await files?.close();
    }
    throw error;
  }
}
