import type { PathInspector } from './admission.ts';
import type { ProcessSupervisor } from './process.ts';
import type { RuntimeScope } from './scope.ts';
import { StartupCoreReplySession } from './startup-core-reply.ts';
import { observeStartupWorkerSources } from './startup-worker-sources.ts';

interface StartupWorkerOpeners {
  readonly observe: typeof observeStartupWorkerSources;
  readonly coreReply: typeof StartupCoreReplySession.open;
}

const defaultOpeners: StartupWorkerOpeners = { observe: observeStartupWorkerSources, coreReply: StartupCoreReplySession.open };

/** The warm core reply worker that chat startup opens beside marker publication and closes before client attachment. */
export class StartupWorkerGroup {
  readonly coreReply: StartupCoreReplySession;
  private closePromise: Promise<void> | null = null;

  private constructor(coreReply: StartupCoreReplySession) { this.coreReply = coreReply; }

  /** Observes the source evidence now and returns the opener, or null when the companion .tmp is absent. */
  static async prepare(inspector: Pick<PathInspector, 'native'>, supervisor: ProcessSupervisor, scope: RuntimeScope,
    openers: StartupWorkerOpeners = defaultOpeners): Promise<(() => Promise<StartupWorkerGroup | null>) | null> {
    const evidence = await openers.observe(inspector, scope);
    if (evidence === null) { return null; }
    let used = false;

    return async () => {
      if (used) { throw new Error('Startup workers cannot be opened twice.'); }
      used = true;
      const coreReply = await openers.coreReply(supervisor, scope, evidence.coreReplySha256);
      return coreReply === null ? null : new StartupWorkerGroup(coreReply);
    };
  }

  close(): Promise<void> {
    this.closePromise ??= this.coreReply.close();
    return this.closePromise;
  }
}
