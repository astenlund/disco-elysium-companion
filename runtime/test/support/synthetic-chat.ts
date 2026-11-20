import path from 'node:path';

import type { RuntimeBackend } from '../../src/backend/api.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
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

/**
 * Kills the chat's helper service and then its one replacement, and returns once the helper reports itself exhausted with
 * no service running. Throws when either step does not happen within its timeout.
 */
export async function exhaustHelper(chat: SyntheticChat, timeoutMs = 30_000): Promise<void> {
  const helper = chat.backend.supervisor.nativeHelper;
  const servicePid = (): number | null => { try { return helper.owner().pid; } catch { return null; } };
  const until = async (condition: () => boolean, step: string): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
      if (performance.now() > deadline) { throw new Error(`The helper did not reach ${step}.`); }
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
  };
  const first = servicePid();
  if (first === null) { throw new Error('The helper has no running service to kill.'); }
  process.kill(first);
  await until(() => { const current = servicePid(); return current !== null && current !== first; }, 'a replacement service');
  process.kill(servicePid()!);
  await until(() => helper.exhausted && servicePid() === null, 'exhaustion');
}

/**
 * Ends any provider broker a test left running, as one that fails before its shutdown can, closes the native helper, whether
 * or not the test exhausted it, and only then releases the guard a failed shutdown keeps held, before the fixture is closed.
 * A chat that never opened leaves only the fixture to close.
 */
export async function releaseExhaustedChat(chat: SyntheticChat | null, fixture: { close(): Promise<void> }): Promise<void> {
  try {
    if (chat !== null) {
      try { await chat.provider.endChildren(); }
      finally {
        // A close the helper cannot complete must not keep the guard and fixture held, nor replace the test's own failure.
        await chat.backend.supervisor.nativeHelper.close().catch(() => undefined);
        await (chat.backend as unknown as { readonly kernel: Kernel }).kernel.guard.release().catch(() => undefined);
      }
    }
  } finally { await fixture.close(); }
}

/** A clean first chat start and shutdown, naming the watcher job and runtime marker of the scope it leaves behind. */
export async function startAndStopSyntheticChat(companionRoot: string, image: HelperImage): Promise<{ readonly watcherJob: string; readonly marker: string }> {
  const first = await openSyntheticChat(companionRoot, image);
  const watcherJob = first.backend.supervisor.jobName('watcher');
  const marker = path.join(first.backend.scope.dataRoot, 'runtime.json');
  await first.host.shutdown();

  return { watcherJob, marker };
}
