import type { InstanceGuard } from './guard.ts';

export const fileToolDenial = 'This file operation is unavailable for this turn.';
export type FileOperationState = 'unavailable' | 'idle' | 'preflight' | 'permitted' | 'uncertain';
export interface FileOperationIdentity { readonly providerInstance: string; readonly toolUseId: string }
export interface FileAdmission { readonly canonicalInput: Readonly<Record<string, unknown>>; readonly evidence: Readonly<Record<string, unknown>> }
export type FilePermission = { readonly allowed: false; readonly reason: typeof fileToolDenial } | { readonly allowed: true; readonly input: Readonly<Record<string, unknown>> };

interface Operation {
  readonly identity: FileOperationIdentity;
  readonly abort: AbortController;
  scanning: boolean;
  cancelled: boolean;
  nativeMayHaveRun: boolean;
  providerEnded: boolean;
  admission: FileAdmission | null;
}

const denied = (): FilePermission => ({ allowed: false, reason: fileToolDenial });

// This guard coordinates already-verified SDK tool paths. It never substitutes for
// native operation-footprint verification or physical object admission.
export class FileOperationGuard {
  private readonly namespace: Pick<InstanceGuard, 'held'>;
  private readonly now: () => number;
  private namespaceAdmitted = false;
  private stateValue: FileOperationState = 'unavailable';
  private owner: Operation | null = null;

  constructor(namespace: Pick<InstanceGuard, 'held'>, now: () => number = () => performance.now()) { this.namespace = namespace; this.now = now; }

  get state(): FileOperationState { return this.stateValue; }
  get identity(): FileOperationIdentity | null { return this.owner?.identity ?? null; }
  get admission(): FileAdmission | null { return this.owner?.admission ?? null; }

  admitQuiescentNamespace(): boolean {
    if (!this.namespace.held || this.owner !== null) { return false; }
    this.namespaceAdmitted = true;
    this.stateValue = 'idle';
    return true;
  }

  private matches(identity: FileOperationIdentity): boolean {
    return this.owner !== null && this.owner.identity.providerInstance === identity.providerInstance && this.owner.identity.toolUseId === identity.toolUseId;
  }

  private retire(operation: Operation): void {
    if (this.owner !== operation || operation.scanning || operation.nativeMayHaveRun && !operation.providerEnded) { return; }
    this.owner = null;
    this.stateValue = this.namespace.held && this.namespaceAdmitted ? 'idle' : 'unavailable';
  }

  async request(identity: FileOperationIdentity, preflight: (signal: AbortSignal) => Promise<FileAdmission | null>): Promise<FilePermission> {
    if (this.stateValue !== 'idle' || !this.namespace.held || !this.namespaceAdmitted || identity.providerInstance.length === 0 || identity.toolUseId.length === 0) { return denied(); }
    const deadline = this.now() + 5000;
    const operation: Operation = { identity: Object.freeze({ ...identity }), abort: new AbortController(), scanning: true, cancelled: false, nativeMayHaveRun: false, providerEnded: false, admission: null };
    this.owner = operation;
    this.stateValue = 'preflight';
    let expire: (permission: FilePermission) => void = () => {};
    const timeout = new Promise<FilePermission>(resolve => { expire = resolve; });
    const timer = setTimeout(() => {
      if (this.owner === operation && operation.scanning) {
        operation.cancelled = true;
        operation.abort.abort();
        this.stateValue = 'uncertain';
      }
      expire(denied());
    }, 5000);
    const scan = (async (): Promise<FilePermission> => {
      try {
        const admission = await preflight(operation.abort.signal);
        if (this.owner !== operation || operation.cancelled || operation.providerEnded || !this.namespace.held || !this.namespaceAdmitted || this.now() >= deadline || admission === null || this.stateValue !== 'preflight') { return denied(); }
        operation.nativeMayHaveRun = true;
        operation.admission = admission;
        this.stateValue = 'permitted';
        return { allowed: true, input: admission.canonicalInput };
      } catch {
        return denied();
      } finally {
        operation.scanning = false;
        clearTimeout(timer);
        this.retire(operation);
      }
    })();
    return Promise.race([scan, timeout]);
  }

  completed(identity: FileOperationIdentity, footprintFinished: boolean): void {
    if (!this.matches(identity)) { return; }
    const operation = this.owner!;
    if (operation.scanning) {
      // Native completion before preflight has finished is an ordering failure.
      operation.cancelled = true;
      operation.nativeMayHaveRun = true;
      operation.abort.abort();
      this.stateValue = 'uncertain';
      return;
    }
    if (!footprintFinished) { this.stateValue = 'uncertain'; return; }
    operation.nativeMayHaveRun = false;
    this.retire(operation);
  }

  cancelled(identity: FileOperationIdentity): void {
    if (!this.matches(identity)) { return; }
    const operation = this.owner!;
    operation.cancelled = true;
    operation.abort.abort();
    this.stateValue = 'uncertain';
    this.retire(operation);
  }

  providerTerminated(providerInstance: string): void {
    if (this.owner?.identity.providerInstance !== providerInstance) { return; }
    const operation = this.owner;
    operation.providerEnded = true;
    operation.cancelled = true;
    operation.abort.abort();
    this.stateValue = 'uncertain';
    this.retire(operation);
  }

  namespaceLost(): void {
    this.namespaceAdmitted = false;
    if (this.owner === null) { this.stateValue = 'unavailable'; return; }
    this.cancelled(this.owner.identity);
  }
}
