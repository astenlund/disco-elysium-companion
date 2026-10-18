import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import { newIdentity } from './identity.ts';
import { ProcessSupervisor, type BrokerSpawn, type CommandResult, type PrivateNativeStartupJobs, type ProcessIdentity } from './process.ts';

class CommandInspector extends PathInspector {
  private accepting = true;

  override metadata(script: string, args: readonly string[], cwd: string, timeoutMs = 30000, input?: Uint8Array): Promise<CommandResult> {
    if (!this.accepting) { return Promise.reject(new DataRootUnavailableError('Read-only inspection has closed.')); }
    return super.metadata(script, args, cwd, timeoutMs, input);
  }

  stop(): void { this.accepting = false; }
}

export interface ReadOnlyInspection { readonly inspector: PathInspector; readonly parentIdentity: ProcessIdentity;
  supervisorFor(canonicalScope: string, createBroker?: BrokerSpawn, nativeJobs?: PrivateNativeStartupJobs): ProcessSupervisor; close(): Promise<void> }

// Status and pre-identity admission must not contend for the live writer's metadata
// job. This per-command namespace is only a name; no directory or scope is created.
export async function createReadOnlyInspection(companionRoot: string): Promise<ReadOnlyInspection> {
  const namespace = path.join(companionRoot, '.tmp', `inspection-${process.pid}-${newIdentity()}`);
  const supervisor = await ProcessSupervisor.create(namespace);
  const inspector = new CommandInspector(supervisor);
  let completion: Promise<void> | null = null;
  return Object.freeze({ inspector, parentIdentity: supervisor.parentIdentity(), supervisorFor: (canonicalScope: string, createBroker?: BrokerSpawn,
    nativeJobs?: PrivateNativeStartupJobs) => supervisor.forScope(canonicalScope, createBroker, nativeJobs), close: () => {
    inspector.stop();
    completion ??= (async () => { await inspector.idle(); await supervisor.verifyQuiescent('metadata'); })();
    return completion;
  } });
}
