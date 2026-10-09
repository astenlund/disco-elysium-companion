import type { PathInspector } from '../admission.ts';
import { requireControl } from '../control-values.ts';
import type { InstanceGuard } from '../guard.ts';
import { mintProcessIdentities } from '../identity.ts';
import { utcNow } from '../json.ts';
import { cleanupRuntimeMarkerResidue, reconcileWatcherOrphan } from '../platform/index.ts';
import type { ProcessSupervisor } from '../process.ts';
import { parseRuntimeRecord, type RuntimeRecord } from '../runtime-records.ts';
import type { RuntimeScope } from '../scope.ts';
import type { ScopeStorage } from '../storage.ts';
import type { ResourceAuthority } from './resources.ts';

interface MarkerBootstrap {
  readonly scope: RuntimeScope;
  readonly guard: Pick<InstanceGuard, 'held'>;
  readonly inspector: PathInspector;
  readonly supervisor: ProcessSupervisor;
  readonly storage: Pick<ScopeStorage, 'read' | 'write'>;
  readonly resources: Pick<ResourceAuthority, 'withTransition' | 'reserveRuntimeMarker'>;
}

/** @internal The common pre-command marker path; openBackend owns scope and guard admission. */
export async function initializeRuntimeMarker(dependencies: MarkerBootstrap, cleanup = cleanupRuntimeMarkerResidue) {
  const { scope, guard, inspector, supervisor, storage, resources } = dependencies;
  await cleanup(scope, guard, inspector, supervisor);
  return resources.withTransition('runtimeMarker', async () => {
    await resources.reserveRuntimeMarker();
    const previous = await storage.read('runtime.json', 'config', parseRuntimeRecord);
    requireControl(previous.status !== 'invalid');
    await reconcileWatcherOrphan(previous.status === 'valid' ? previous.value : null, supervisor, scope.companionRoot);
    await supervisor.admitStartup();
    const identities = mintProcessIdentities(previous.status === 'valid' ? previous.value.runtimeInstanceId : null);
    const runtime: RuntimeRecord = { runtimeInstanceId: identities.runtimeInstanceId, startedAt: utcNow(), cleanShutdown: false, watcher: null };
    const sha256 = await storage.write('runtime.json', runtime, 'config', previous.status === 'valid' ? previous.sha256 : null);
    return { identities, runtime, sha256, previous };
  });
}
