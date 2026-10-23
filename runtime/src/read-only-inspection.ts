import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import { newIdentity } from './identity.ts';
import type { JsonValue } from './json.ts';
import type { HelperOperation, NativeHelper } from './native-helper.ts';
import { ProcessSupervisor, type CommandResult, type ProcessIdentity } from './process.ts';

class CommandInspector extends PathInspector {
  private accepting = true;

  override metadata(script: string, args: readonly string[], cwd: string, timeoutMs = 30000, input?: Uint8Array): Promise<CommandResult> {
    if (!this.accepting) { return Promise.reject(new DataRootUnavailableError('Read-only inspection has closed.')); }
    return super.metadata(script, args, cwd, timeoutMs, input);
  }

  override native(op: HelperOperation, fields: Record<string, unknown>, timeoutMs = 30000): Promise<JsonValue> {
    if (!this.accepting) { return Promise.reject(new DataRootUnavailableError('Read-only inspection has closed.')); }
    return super.native(op, fields, timeoutMs);
  }

  stop(): void { this.accepting = false; }
}

export interface ReadOnlyInspection {
  readonly inspector: PathInspector;
  readonly parentIdentity: ProcessIdentity;
  supervisorFor(canonicalScope: string): ProcessSupervisor;
  close(): Promise<void>;
}

// Status and pre-identity admission must not contend for the live writer's metadata
// job. This per-command namespace is only a name; no directory or scope is created.
// The helper belongs to the caller, which closes it.
export async function createReadOnlyInspection(companionRoot: string, helper: NativeHelper): Promise<ReadOnlyInspection> {
  const namespace = path.join(companionRoot, '.tmp', `inspection-${process.pid}-${newIdentity()}`);
  const supervisor = await ProcessSupervisor.create(namespace, helper);
  const inspector = new CommandInspector(supervisor);
  let completion: Promise<void> | null = null;
  return Object.freeze({ inspector, parentIdentity: supervisor.parentIdentity(), supervisorFor: (canonicalScope: string) => supervisor.forScope(canonicalScope),
    close: () => {
      inspector.stop();
      completion ??= (async () => { await inspector.idle(); await supervisor.verifyQuiescent('metadata'); })();
      return completion;
    } });
}
