import type { RuntimeBackend } from '../../src/backend/api.ts';
import type { HelperImage } from '../../src/native-image.ts';
import { createChatRuntime, privateRuntimeStartup } from '../../src/runtime.ts';
import type { SessionHost } from '../../src/session-host.ts';
import type { StartupPhase } from '../../src/startup-progress.ts';
import { SyntheticProvider } from './synthetic-provider.ts';

export interface SyntheticChat {
  readonly host: SessionHost;
  readonly backend: RuntimeBackend;
  readonly provider: SyntheticProvider;
}

/**
 * Opens the product chat runtime on a companion root with the synthetic provider in place of the real one. Throws when
 * chat does not become ready; the caller attaches and shuts the host down.
 */
export async function openSyntheticChat(companionRoot: string, image: HelperImage, prestart = false,
  onStartupPhase?: (phase: StartupPhase) => void): Promise<SyntheticChat> {
  let backend: RuntimeBackend | null = null;
  let provider: SyntheticProvider | null = null;
  const opened = await createChatRuntime(companionRoot, onStartupPhase, {
    [privateRuntimeStartup]: {
      allowUnboundProviderPrestart: prestart,
      providerFactory: (_text, _tools, current) => {
        backend ??= current;
        if (current !== backend) { throw new Error('The fixture backend changed.'); }
        provider ??= new SyntheticProvider(current.supervisor, companionRoot);
        return provider;
      },
    } }, image);
  if (opened.result !== 'ready') { throw new Error(`Chat did not become ready: ${opened.result}.`); }
  if (backend === null || provider === null) { throw new Error('The fixture provider was never created.'); }

  return { host: opened.host, backend, provider };
}
