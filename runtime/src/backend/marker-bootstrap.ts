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

interface MarkerWorker { close(): Promise<void> }

/**
 * @internal The common pre-command marker path; openBackend owns scope and guard admission and the helper's binding.
 * All-role predecessor admission, the bound helper job included, is checked before the marker is published; a warm
 * worker, when prepared, opens beside that publication.
 */
export async function initializeRuntimeMarker<TWorker extends MarkerWorker = MarkerWorker>(dependencies: MarkerBootstrap,
  cleanup = cleanupRuntimeMarkerResidue, prepareWorker?: () => Promise<(() => Promise<TWorker | null>) | null>) {
  const { scope, guard, inspector, supervisor, storage, resources } = dependencies;
  await cleanup(scope, guard, inspector, supervisor);
  return resources.withTransition('runtimeMarker', async () => {
    await resources.reserveRuntimeMarker();
    const previous = await storage.read('runtime.json', 'config', parseRuntimeRecord);
    requireControl(previous.status !== 'invalid');
    if (previous.status === 'valid' && previous.value.watcher !== null) {
      await reconcileWatcherOrphan(previous.value, supervisor);
    }
    requireControl(guard.held);
    await supervisor.admitStartup();
    requireControl(guard.held);
    const launch = prepareWorker === undefined ? null : await prepareWorker();
    requireControl(guard.held);
    const identities = mintProcessIdentities(previous.status === 'valid' ? previous.value.runtimeInstanceId : null);
    const runtime: RuntimeRecord = { runtimeInstanceId: identities.runtimeInstanceId, startedAt: utcNow(), cleanShutdown: false, watcher: null };
    const write = () => storage.write('runtime.json', runtime, 'config', previous.status === 'valid' ? previous.sha256 : null);
    if (launch === null) {
      const sha256 = await write();

      return { identities, runtime, sha256, previous, startupWorker: null as TWorker | null };
    }
    const opening = Promise.resolve().then(launch);
    const publication = write();
    const [workerResult, writeResult] = await Promise.allSettled([opening, publication]);
    if (workerResult.status === 'rejected' || writeResult.status === 'rejected') {
      if (workerResult.status === 'fulfilled') { await workerResult.value?.close(); }
      if (writeResult.status === 'rejected') { throw writeResult.reason; }
      throw (workerResult as PromiseRejectedResult).reason;
    }

    return { identities, runtime, sha256: writeResult.value, previous, startupWorker: workerResult.value };
  });
}
