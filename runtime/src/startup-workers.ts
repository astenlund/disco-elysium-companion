import type { PathInspector } from './admission.ts';
import type { ProcessSupervisor } from './process.ts';
import type { RuntimeScope } from './scope.ts';
import { StartupCoreReplySession } from './startup-core-reply.ts';
import { StartupMetadataSession } from './startup-metadata.ts';
import { StartupMutationSession } from './startup-mutation.ts';
import { observeStartupWorkerSources, type StartupWorkerEvidence } from './startup-worker-sources.ts';

interface StartupWorkerOpeners {
  readonly observe: typeof observeStartupWorkerSources;
  readonly metadata: typeof StartupMetadataSession.prepareWithEvidence;
  readonly coreReply: typeof StartupCoreReplySession.open;
  readonly mutation: typeof StartupMutationSession.open;
}

const defaultOpeners: StartupWorkerOpeners = {
  observe: observeStartupWorkerSources,
  metadata: StartupMetadataSession.prepareWithEvidence,
  coreReply: StartupCoreReplySession.open,
  mutation: StartupMutationSession.open,
};

export class StartupWorkerGroup {
  readonly metadata: StartupMetadataSession | null;
  readonly coreReply: StartupCoreReplySession | null;
  readonly mutation: StartupMutationSession | null;
  private closePromise: Promise<void> | null = null;

  private constructor(metadata: StartupMetadataSession | null, coreReply: StartupCoreReplySession | null,
    mutation: StartupMutationSession | null) { this.metadata = metadata; this.coreReply = coreReply; this.mutation = mutation; }

  static async prepare(inspector: PathInspector, supervisor: ProcessSupervisor, scope: RuntimeScope,
    openers: StartupWorkerOpeners = defaultOpeners, existingMetadata: StartupMetadataSession | null = null,
    launchMetadata = true, proveEarly?: (evidence: StartupWorkerEvidence) => void): Promise<(() => Promise<StartupWorkerGroup | null>) | null> {
    const evidence = existingMetadata === null ? await openers.observe(inspector, scope) : await existingMetadata.observeWorkerSources(scope);
    if (evidence === null) {
      if (existingMetadata !== null) { throw new Error('Startup metadata source disappeared after worker admission.'); }
      return null;
    }
    if (existingMetadata !== null && !existingMetadata.matchesStartupEvidence(scope, evidence)) {
      throw new Error('Startup metadata ownership or source changed after worker admission.');
    }
    if (existingMetadata !== null) { proveEarly?.(evidence); }
    const openMetadata = existingMetadata !== null ? async () => existingMetadata
      : launchMetadata ? openers.metadata(supervisor, scope, evidence) : async () => null;
    let used = false;

    return async () => {
      if (used) { throw new Error('Startup workers cannot be opened twice.'); }
      used = true;
      const opened = await Promise.allSettled([
        openMetadata(),
        openers.coreReply(supervisor, scope, evidence.coreReplySha256),
        openers.mutation(supervisor, scope, evidence.mutationSha256),
      ]);
      const failure = opened.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        const close = await Promise.allSettled(opened.map((result, index) => result.status === 'fulfilled' && (index !== 0 || existingMetadata === null)
          ? result.value?.close() : undefined));
        const closeFailure = close.find(result => result.status === 'rejected');
        if (closeFailure?.status === 'rejected') { throw closeFailure.reason; }
        throw failure.reason;
      }
      const [metadata, coreReply, mutation] = opened.map(result => result.status === 'fulfilled' ? result.value : null) as
        [StartupMetadataSession | null, StartupCoreReplySession | null, StartupMutationSession | null];
      return metadata === null && coreReply === null && mutation === null ? null : new StartupWorkerGroup(metadata, coreReply, mutation);
    };
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      const results = await Promise.allSettled([this.metadata?.close(), this.coreReply?.close(), this.mutation?.close()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') { throw failure.reason; }
    })();
    return this.closePromise;
  }
}
