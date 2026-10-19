import { openBackend, privateCombinedBootstrap, privateCompiledProcessBroker, privateGoBrokerSpawn,
  privateNativeStartupJobs, privateScopeSourceBatch, privateSelectedImageBootstrap,
  privateStartupMetadataPlacement, privateWarmJobObserver, type SelectedImageBootstrap } from './backend/index.ts';
import type { RuntimeBackend } from './backend/api.ts';
import { ClaudeProvider } from './claude-provider.ts';
import { FileToolAdapter } from './file-tool-adapter.ts';
import type { CompiledBrokerArtifact } from './compiled-broker.ts';
import type { BrokerSpawn, PrivateNativeStartupJobs } from './process.ts';
import { assembleInstructions } from './instructions.ts';
import { PendingProviderStart, selectPendingProviderStart } from './provider-lifecycle.ts';
import type { Provider } from './provider.ts';
import { AttachmentProviderUnavailableError, SessionHost } from './session-host.ts';
import type { Correction } from './session-host-contract.ts';
import { reportStartupPhase, type StartupPhase } from './startup-progress.ts';

export type ChatRuntime = { readonly result: 'ready'; readonly host: SessionHost }
  | { readonly result: 'notOwner' } | { readonly result: 'providerUnavailable' };

export const privateRuntimeStartup = Symbol('privateRuntimeStartup');
export interface PrivateRuntimeStartupOptions {
  readonly [privateRuntimeStartup]?: {
    readonly allowUnboundProviderPrestart?: boolean;
    readonly fastCopiedStartup?: true;
    readonly compiledBroker?: CompiledBrokerArtifact;
    readonly goBrokerSpawn?: BrokerSpawn;
    readonly nativeStartupJobs?: PrivateNativeStartupJobs;
    readonly selectedImageBootstrap?: SelectedImageBootstrap;
    readonly providerFactory?: (text: string, fileTools: FileToolAdapter, backend: RuntimeBackend) => Provider;
  };
}

/** @internal Private copied-root routing; production does not supply the selector. */
export function chatBackendOptions(companionRoot: string, onStatus: () => void, onInvalidated: (reason: Correction['reason']) => void,
  onStartupPhase: ((phase: StartupPhase) => void) | undefined, fastCopiedStartup: boolean,
  compiledBroker?: CompiledBrokerArtifact, nativeStartupJobs?: PrivateNativeStartupJobs,
  goBrokerSpawn?: BrokerSpawn, selectedImageBootstrap?: SelectedImageBootstrap): Parameters<typeof openBackend>[0] {
  return { companionRoot, startupMetadata: true, onStatus, onInvalidated, onStartupPhase,
    ...(fastCopiedStartup || selectedImageBootstrap !== undefined ? { [privateCombinedBootstrap]: true as const, [privateScopeSourceBatch]: true as const,
      [privateWarmJobObserver]: true as const, [privateStartupMetadataPlacement]: 'postGuard' as const,
      ...(compiledBroker === undefined ? {} : { [privateCompiledProcessBroker]: compiledBroker }),
      ...(goBrokerSpawn === undefined ? {} : { [privateGoBrokerSpawn]: goBrokerSpawn }),
      ...(nativeStartupJobs === undefined ? {} : { [privateNativeStartupJobs]: nativeStartupJobs }),
      ...(selectedImageBootstrap === undefined ? {} : { [privateSelectedImageBootstrap]: selectedImageBootstrap }) } : {}) };
}

/**
 * @internal Cleanup must continue even when the worker cannot close. A pending provider candidate whose stop is unproved
 * still lets startup workers close, but then fails closed: no shutdown, so the guard stays held and no clean marker is written.
 */
export async function cleanupFailedChatRuntime(error: unknown, backend: RuntimeBackend | null, host: SessionHost | null, files: FileToolAdapter | null,
  onStartupPhase?: (phase: StartupPhase) => void, pending: Pick<PendingProviderStart, 'cancel'> | null = null): Promise<never> {
  let candidateFailure: { readonly reason: unknown } | null = null;
  try { await pending?.cancel(); }
  catch (failure) { candidateFailure = { reason: failure }; }
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  if (backend !== null) { reportStartupPhase(onStartupPhase, 'startupWorkerClosure'); }
  try { await backend?.closeStartupWorkers(); }
  catch (failure) { cleanupFailed = true; cleanupFailure = failure; }
  if (candidateFailure !== null) { throw candidateFailure.reason; }
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

const attachmentPreparationAttempts = 3;

/**
 * @internal A final safety refusal, including an invalidation at any point after the provider started, leaves only a positively
 * stopped status client. A provider that merely exited gets its reconnect ladder settled and a fresh full check; once attempts run
 * out, attachment proceeds from that settled state, ready with its own cold check or status-only as after any failed reconnect.
 */
export async function finalizeAttachmentSafety(host: SessionHost, backend: RuntimeBackend): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let failure: unknown;
    try { await host.prepareAttachmentWitness(); return; }
    catch (error) { failure = error; }
    if (!backend.guardHeld()) { throw failure; }
    if (failure instanceof AttachmentProviderUnavailableError) {
      const settled = await host.settleProviderRecovery();
      if (settled === 'ready' && attempt < attachmentPreparationAttempts) { continue; }
      if (settled !== 'invalidated') { return; }
    }
    await host.blockAfterFinalSafety();
    if (!backend.guardHeld()) { throw failure; }
    return;
  }
}

/**
 * @internal Starts the final provider whether or not phase D-H work completed: provider safety, not the startup result, decides
 * between a bound provider and a status-only client.
 */
export async function startChatProvider(host: SessionHost, backend: RuntimeBackend, reportPhase?: (phase: StartupPhase) => void): Promise<ChatRuntime> {
  reportPhase?.('providerSelection');
  const providerStarted = await host.start(reportPhase);
  if (!providerStarted && host.status.provider.state === 'failed') {
    reportPhase?.('startupWorkerClosure');
    await backend.closeStartupWorkers();
    await host.shutdown();
    return { result: 'providerUnavailable' };
  }
  if (providerStarted) { reportPhase?.('attachmentSafety'); await finalizeAttachmentSafety(host, backend); }
  reportPhase?.('startupWorkerClosure');
  await backend.closeStartupWorkers();
  return { result: 'ready', host };
}

export async function createChatRuntime(companionRoot: string, onStartupPhase?: (phase: StartupPhase) => void,
  privateOptions: PrivateRuntimeStartupOptions = {}): Promise<ChatRuntime> {
  const reportPhase = onStartupPhase === undefined ? undefined : (phase: StartupPhase) => reportStartupPhase(onStartupPhase, phase);
  let host: SessionHost | null = null;
  let backend: RuntimeBackend | null = null;
  let files: FileToolAdapter | null = null;
  let pending: PendingProviderStart | null = null;
  let invalidatedBeforeHost: Correction['reason'] | null = null;
  try {
    const opened: RuntimeBackend = await openBackend(chatBackendOptions(companionRoot, () => host?.statusChanged(),
      (reason: Correction['reason']) => { pending?.abort(); if (host === null) { invalidatedBeforeHost = reason; } else { host.invalidate(reason); } }, reportPhase,
      privateOptions[privateRuntimeStartup]?.fastCopiedStartup === true, privateOptions[privateRuntimeStartup]?.compiledBroker,
      privateOptions[privateRuntimeStartup]?.nativeStartupJobs, privateOptions[privateRuntimeStartup]?.goBrokerSpawn,
      privateOptions[privateRuntimeStartup]?.selectedImageBootstrap));
    backend = opened;
    let earlyInstructions: Awaited<ReturnType<typeof assembleInstructions>> | null = null;
    if (privateOptions[privateRuntimeStartup]?.allowUnboundProviderPrestart === true) {
      reportPhase?.('providerPreparation');
      try { earlyInstructions = await assembleInstructions(backend.inspector, backend.scope.companionRoot); }
      catch { /* Final instruction admission still owns the startup decision. */ }
    }
    const makeTools = () => FileToolAdapter.create({ companionRoot: backend!.scope.companionRoot, inspector: backend!.inspector, supervisor: backend!.supervisor,
      isActive: (instance, session) => host?.isToolActive(instance, session) ?? false, dialogsAvailable: () => host?.dialogsAvailable ?? false });
    const makeProvider = (text: string, fileTools: FileToolAdapter): Provider => privateOptions[privateRuntimeStartup]?.providerFactory?.(text, fileTools, backend!)
      ?? new ClaudeProvider({ companionRoot: backend!.scope.companionRoot, config: backend!.config,
      appendText: text, supervisor: backend!.supervisor, boundary: instance => fileTools.boundary(instance), isCurrent: instance => host?.isProviderCurrent(instance) ?? false,
      onPassiveSignal: (instance, signal) => host?.passiveSignal(instance, signal) });
    if (earlyInstructions !== null && invalidatedBeforeHost === null) {
      files = await makeTools();
      reportPhase?.('providerPrestart');
      pending = await selectPendingProviderStart(backend, makeProvider(earlyInstructions.text, files), earlyInstructions.sha256);
    }
    const startup = await backend.startup({ kind: 'chat' });
    if (startup.notOwner) { await pending?.cancel(); pending = null; reportPhase?.('startupWorkerClosure'); await backend.closeStartupWorkers(); await files?.close(); await backend.shutdown(true); return { result: 'notOwner' }; }
    if (!startup.requiredWorkCompleted) { await pending?.cancel(); pending = null; }
    reportPhase?.('providerPreparation');
    const instructions = await assembleInstructions(backend.inspector, backend.scope.companionRoot);
    if (pending !== null && (earlyInstructions?.sha256 !== instructions.sha256 || earlyInstructions.text !== instructions.text)) { await pending.cancel(); pending = null; }
    files ??= await makeTools();
    const fileTools = files;
    const provider = makeProvider(instructions.text, fileTools);
    host = new SessionHost({ backend, provider, instructionsSha256: instructions.sha256, requireVerifiedAttach: true,
      pendingStart: pending,
      providerTerminated: instance => fileTools.providerTerminated(instance), verifyTools: () => fileTools.verifyQuiescent(), closeTools: () => fileTools.close() });
    pending = null;
    if (invalidatedBeforeHost !== null) { host.invalidate(invalidatedBeforeHost); }
    // A phase D-H fault cancelled the unbound candidate above; the final start still runs and providerSafety decides.
    return await startChatProvider(host, backend, reportPhase);
  } catch (error) {
    return cleanupFailedChatRuntime(error, backend, host, files, reportPhase, pending);
  }
}
