import type { PathInspector } from './admission.ts';
import { FileOperationGuard } from './file-operation.ts';
import { takeInstanceGuard, type InstanceGuard } from './guard.ts';
import type { ProviderProcessOwner } from './claude-provider.ts';
import { ToolBoundary } from './tool-boundary.ts';

export interface FileToolAdapterOptions {
  readonly companionRoot: string;
  readonly inspector: PathInspector;
  readonly supervisor: ProviderProcessOwner;
  readonly isActive: (instance: string, session: string) => boolean;
  readonly dialogsAvailable: () => boolean;
}

// The pinned native tool footprints have not passed their live enforcement
// probes. Owning the namespace and admitting paths cannot replace that evidence.
// Keep the native operations refused until each operation's complete footprint
// has been verified; web tools and client dialogs retain their own decisions.
export class FileToolAdapter {
  private readonly options: FileToolAdapterOptions;
  private readonly namespace: InstanceGuard | null;
  private readonly operations: FileOperationGuard;

  private constructor(options: FileToolAdapterOptions, namespace: InstanceGuard | null) {
    this.options = options;
    this.namespace = namespace;
    this.operations = new FileOperationGuard(namespace ?? { held: false });
  }

  static async create(options: FileToolAdapterOptions): Promise<FileToolAdapter> {
    let adapter: FileToolAdapter | null = null;
    let namespace: InstanceGuard | null = null;
    try {
      const root = await options.inspector.inspect(options.companionRoot, options.companionRoot);
      if (root.kind === 'directory') { namespace = await takeInstanceGuard(root.path, () => adapter?.operations.namespaceLost(), 'file-tools'); }
    } catch { /* Unavailable ownership denies file tools without disabling chat. */ }
    adapter = new FileToolAdapter(options, namespace);
    if (namespace !== null) {
      try { await options.supervisor.verifyQuiescent('provider'); adapter.operations.admitQuiescentNamespace(); }
      catch { adapter.operations.namespaceLost(); }
    }
    return adapter;
  }

  boundary(providerInstance: string): ToolBoundary {
    return new ToolBoundary({ providerInstance, fileOperations: this.operations, isActive: this.options.isActive,
      dialogsAvailable: this.options.dialogsAvailable,
      admitFile: async () => null,
      verifyFileCompletion: async () => false });
  }

  async providerTerminated(instance: string): Promise<void> {
    await this.options.supervisor.verifyQuiescent('provider');
    this.operations.providerTerminated(instance);
  }

  async verifyQuiescent(): Promise<void> {
    await this.options.supervisor.verifyQuiescent('provider');
    await this.options.inspector.idle();
    if (this.operations.identity !== null) { throw new Error('File-operation completion is unverified.'); }
  }

  async close(): Promise<void> {
    await this.verifyQuiescent();
    await this.release();
  }

  /**
   * Releases the namespace without another proof. Graceful shutdown calls it last, after the host verified tool quiescence
   * and the backend proved every role quiescent and observed the helper service's exit, so no helper remains to repeat it.
   */
  async release(): Promise<void> {
    this.operations.namespaceLost();
    await this.namespace?.release();
  }
}
