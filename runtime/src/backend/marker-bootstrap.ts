import { DataRootUnavailableError, type PathInspector } from '../admission.ts';
import { requireControl } from '../control-values.ts';
import type { InstanceGuard } from '../guard.ts';
import { mintProcessIdentities } from '../identity.ts';
import { utcNow } from '../json.ts';
import { cleanupRuntimeMarkerResidue, reconcileWatcherOrphan } from '../platform/index.ts';
import type { ProcessSupervisor } from '../process.ts';
import { parseRuntimeRecord, type RuntimeRecord } from '../runtime-records.ts';
import type { RuntimeScope } from '../scope.ts';
import type { StartupMetadataSession } from '../startup-metadata.ts';
import type { StartupWorkerEvidence } from '../startup-worker-sources.ts';
import type { ScopeStorage } from '../storage.ts';
import type { ResourceAuthority } from './resources.ts';

interface MarkerBootstrap {
  readonly scope: RuntimeScope;
  readonly guard: Pick<InstanceGuard, 'held'>;
  readonly inspector: PathInspector;
  readonly supervisor: ProcessSupervisor;
  readonly storage: Pick<ScopeStorage, 'read' | 'write'>;
  readonly resources: Pick<ResourceAuthority, 'withTransition' | 'reserveRuntimeMarker'>;
  readonly earlyMetadata?: StartupMetadataSession | null;
}

interface MarkerWorker { close(): Promise<void> }

/** @internal The common pre-command marker path; openBackend owns scope and guard admission. */
export async function initializeRuntimeMarker<TWorker extends MarkerWorker = MarkerWorker>(dependencies: MarkerBootstrap,
  cleanup = cleanupRuntimeMarkerResidue,
  prepareWorker?: (proveEarly?: (evidence: StartupWorkerEvidence) => void) => Promise<(() => Promise<TWorker | null>) | null>) {
  const { scope, guard, inspector, supervisor, storage, resources } = dependencies;
  await cleanup(scope, guard, inspector, supervisor);
  return resources.withTransition('runtimeMarker', async () => {
    await resources.reserveRuntimeMarker();
    const previous = await storage.read('runtime.json', 'config', parseRuntimeRecord);
    requireControl(previous.status !== 'invalid');
    if (previous.status === 'valid' && previous.value.watcher !== null) {
      await reconcileWatcherOrphan(previous.value, supervisor, scope.companionRoot);
    }
    const earlyMetadata = dependencies.earlyMetadata;
    if (earlyMetadata !== null && earlyMetadata !== undefined && prepareWorker === undefined) {
      throw new DataRootUnavailableError('Early startup metadata requires fresh worker source preparation.');
    }
    requireControl(guard.held);
    await supervisor.admitStartup(earlyMetadata !== null && earlyMetadata !== undefined);
    requireControl(guard.held);
    let proof: StartupWorkerEvidence | null = null;
    const proveEarly = earlyMetadata === null || earlyMetadata === undefined ? undefined : (evidence: StartupWorkerEvidence): void => {
      requireControl(guard.held);
      if (proof !== null || !earlyMetadata.matchesStartupEvidence(scope, evidence)) {
        throw new DataRootUnavailableError('Early startup metadata source or scope binding changed before admission.');
      }
      proof = evidence;
    };
    const launch = prepareWorker === undefined ? null : await prepareWorker(proveEarly);
    if (earlyMetadata !== null && earlyMetadata !== undefined && (proof === null || launch === null
      || !earlyMetadata.matchesStartupEvidence(scope, proof))) {
      throw new DataRootUnavailableError('Early startup metadata source proof is incomplete.');
    }
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
