import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from '../admission.ts';
import { capacityError, firstCapacityRefusal, RuntimeCapacityError } from '../capacity.ts';
import type { CapacitySource } from '../resource-lifecycle/resources.ts';
import { loadRuntimeConfig } from '../config.ts';
import { requireDirectMainToken } from '../direct-main-capability.ts';
import { compiledBrokerSpawn, type CompiledBrokerArtifact } from '../compiled-broker.ts';
import { requireControl } from '../control-values.ts';
import { resolvePrincipal } from '../core-client.ts';
import { Deadline } from '../deadline.ts';
import { FilePublisher, type PublicationOptions } from '../files.ts';
import { takeInstanceGuard } from '../guard.ts';
import { initializeJournal } from '../journal-initialization.ts';
import { releaseGoBrokerSpawn } from '../go-broker-artifact.ts';
import { jsonBudgets, utcNow, type ProspectiveJsonBudgetError } from '../json.ts';
import { OperationStore } from '../operations.ts';
import { releaseNativeJobObserverArtifact } from '../native-observer-artifact.ts';
import { effectivelyUnfinished } from '../operation-records.ts';
import { cleanupPublicationResidue, WatcherSupervisor } from '../platform/index.ts';
import { ProcessSupervisor, processRoles, type BrokerSpawn, type PrivateNativeStartupJobs } from '../process.ts';
import { createReadOnlyInspection } from '../read-only-inspection.ts';
import { maintainRuntimeStorage } from '../resource-lifecycle/retention.ts';
import type { RuntimeRecord } from '../runtime-records.ts';
import { discoverScope, discoverScopeWithPrincipal, initializeScope, scopeFromAdmittedBinding, type ScopeCandidate } from '../scope.ts';
import { observeSourceBoundBootstrap } from '../source-bound-bootstrap.ts';
import { SerialQueue } from '../serial.ts';
import { ScopeStorage } from '../storage.ts';
import { StartupMetadataSession } from '../startup-metadata.ts';
import { StartupWorkerGroup } from '../startup-workers.ts';
import { observeBootstrapWorkerSources, observeStartupWorkerSources } from '../startup-worker-sources.ts';
import type { BackendCommand, BackendOptions, BackendStartup, RuntimeBackend } from './api.ts';
import { ConsumerCoordinator } from './consumer.ts';
import { PendingStateCheckError } from './api.ts';
import { DeliveryCoordinator } from './delivery.ts';
import { reconcileAcknowledgedRecovery } from './recovery-disclosure.ts';
import { Kernel } from './kernel.ts';
import { initializeRuntimeMarker } from './marker-bootstrap.ts';
import { RecoveryCoordinator } from './recovery.ts';
import { ResourceAuthority } from './resources.ts';

export { readRuntimeStatus as readBackendStatus } from '../platform/index.ts';
export type * from './api.ts';

/** @internal Private fixture selector. Production callers omit this symbol. */
export const privateStartupMetadataPlacement = Symbol('privateStartupMetadataPlacement');
export const privateScopeSourceBatch = Symbol('privateScopeSourceBatch');
export const privateRecheckSupervisorIdentity = Symbol('privateRecheckSupervisorIdentity');
export const privateWarmJobObserver = Symbol('privateWarmJobObserver');
export const privateCombinedBootstrap = Symbol('privateCombinedBootstrap');
export const privateCompiledProcessBroker = Symbol('privateCompiledProcessBroker');
export const privateGoBrokerSpawn = Symbol('privateGoBrokerSpawn');
export const privateNativeStartupJobs = Symbol('privateNativeStartupJobs');
export const privateSelectedImageBootstrap = Symbol('privateSelectedImageBootstrap');
export interface SelectedImageBootstrap {
  readonly token: symbol;
  readonly imageRoot: string;
  readonly scratch: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly markPossibleTransfer: () => void;
  readonly onVerifiedPins: (status: 'ready' | 'absent') => void;
}
type FixtureBackendOptions = BackendOptions & { readonly [privateStartupMetadataPlacement]?: 'postGuard'; readonly [privateScopeSourceBatch]?: true;
  readonly [privateRecheckSupervisorIdentity]?: true; readonly [privateWarmJobObserver]?: true;
  readonly [privateCombinedBootstrap]?: true; readonly [privateCompiledProcessBroker]?: CompiledBrokerArtifact;
  readonly [privateGoBrokerSpawn]?: BrokerSpawn;
  readonly [privateNativeStartupJobs]?: PrivateNativeStartupJobs;
  readonly [privateSelectedImageBootstrap]?: SelectedImageBootstrap };

/** @internal Composition of already-admitted primitives; openBackend owns admission. */
export class CoordinatorBackend implements RuntimeBackend {
  private readonly kernel: Kernel;
  private readonly recovery: RecoveryCoordinator;
  private readonly consumer: ConsumerCoordinator;
  private readonly delivery: DeliveryCoordinator;
  private readonly queue = new SerialQueue();
  private readonly queueContext = new AsyncLocalStorage<{ active: boolean }>();
  private readonly deliverySources = new WeakMap<object, CapacitySource>();
  private readonly watcher: WatcherSupervisor;
  private readonly onStartupPhase: BackendOptions['onStartupPhase'];
  private runtime: { value: RuntimeRecord; sha256: string };
  private started = false;
  private shuttingDown: Promise<void> | null = null;

  constructor(kernel: Kernel, runtime: { value: RuntimeRecord; sha256: string }, onStartupPhase?: BackendOptions['onStartupPhase']) {
    this.onStartupPhase = onStartupPhase;
    this.kernel = kernel; this.runtime = runtime;
    this.recovery = new RecoveryCoordinator(kernel); this.consumer = new ConsumerCoordinator(kernel); this.delivery = new DeliveryCoordinator(kernel, () => this.retention(false));
    this.watcher = new WatcherSupervisor({ companionRoot: kernel.scope.companionRoot, adapter: kernel.config.adapter, enabled: kernel.config.watcher.enabled, supervisor: kernel.supervisor,
      persistWatcher: watcher => this.enqueue(() => kernel.resources.withTransition('runtimeMarker', async () => {
        await kernel.resources.reserveRuntimeMarker();
        const value = { ...this.runtime.value, watcher };
        const sha256 = await kernel.storage.write('runtime.json', value, 'config', this.runtime.sha256);
        this.runtime = { value, sha256 };
      })), onState: watcher => kernel.emit({ watcher }), onFailure: error => { this.recordFailure(error); } });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.queueContext.getStore()?.active === true) { return action(); }
    return this.queue.run(() => {
      const owner = { active: true };
      return this.queueContext.run(owner, async () => { try { return await action(); } finally { owner.active = false; } });
    });
  }

  private async preparationFailed(error: unknown): Promise<BackendStartup> {
    this.recordFailure(error);
    const k = this.kernel;
    const observed = await k.observeSafety();
    const capacity = firstCapacityRefusal(k.resources.capacity.current);
    const pending = observed.stateSafety.state === 'recovering' && observed.safety?.status === 'valid' && observed.safety.value.pendingCheck !== null;
    k.emit({ stateSafety: observed.stateSafety, freshness: { ...k.status.freshness, state: 'failed', class: 'journal',
      reason: pending ? 'settlementPending' : k.status.journal.fault ?? (capacity?.state === 'unavailable' ? 'capacityUnavailable' : 'journalUnavailable'), checkedAt: utcNow() } });
    return { notOwner: false, consumerResult: null, requiredWorkCompleted: false, capacityRewind: null };
  }
  private async cleanup(): Promise<void> {
    const k = this.kernel; await cleanupPublicationResidue(k.scope, k.guard, k.inspector, k.supervisor);
  }
  private async initializeStorage(): Promise<void> {
    const k = this.kernel;
    await k.resources.withTransition('release', async () => {
      requireControl(k.resources.assertReservation() === 'release');
      if (k.scope.createdHere) { await k.safetyStore.initializeNew(); }
      await initializeJournal(k.storage, k.inspector, k.publisher);
      await k.storage.ensureDirectory('operations'); await k.storage.ensureDirectory('quarantine');
    });
  }

  get config() { return this.kernel.config; }
  get identities() { return this.kernel.identities; }
  get scope() { return this.kernel.scope; }
  get sessions() { return this.kernel.sessions; }
  get supervisor() { return this.kernel.supervisor; }
  get inspector() { return this.kernel.inspector; }
  get status() { return this.kernel.status; }
  guardHeld(): boolean { return this.kernel.guard.held; }
  safety(...args: Parameters<Kernel['safety']>) { return this.kernel.safety(...args); }
  providerSafety(deadline?: Deadline) {
    return this.enqueue(async () => {
      await this.recovery.reconcileCarry(deadline);
      const snapshot = await this.kernel.journal.read(deadline);
      if (snapshot.fault !== null || snapshot.damaged.length > 0) { await this.kernel.reportPayloadDamage(snapshot, deadline); }
      const safety = await this.kernel.safety(deadline);
      requireControl(await this.kernel.providerAuthority(safety, deadline));
      return safety;
    });
  }
  sessionProof(...args: Parameters<Kernel['sessionProof']>) { return this.kernel.sessionProof(...args); }

  startup(command: BackendCommand): Promise<BackendStartup> {
    return this.enqueue(async () => {
      requireControl(!this.started); this.started = true;
      const k = this.kernel;
      this.onStartupPhase?.('storageRecovery');
      try { await k.resources.withTransition('maintenance', () => this.cleanup()); }
      catch (error) { return this.preparationFailed(capacityError(error, 'maintenance', 'publicationScope')); }
      let failed = false;
      try {
        await k.resources.withTransition('release', async () => {
          try { await k.resources.reserve('release'); }
          catch (error) {
            if (!(error instanceof RuntimeCapacityError)) { throw error; }
            await this.retention(false);
            await k.resources.reserve('release');
          }
          try { await this.initializeStorage(); }
          catch (error) { failed = true; this.recordFailure(error); k.diagnose('initializeJournalAndSafety', error); }
        });
      } catch (error) { return this.preparationFailed(error); }
      try {
        this.onStartupPhase?.('consumerReconciliation');
        const consumerStartup = await this.consumer.startup(command);
        if (consumerStartup !== null) { return consumerStartup; }
      } catch (error) {
        if (command.kind === 'consumer') { throw this.recordFailure(error); }
        failed = true; this.recordFailure(error);
      }
      try {
        this.onStartupPhase?.('streamRecovery');
        await this.recovery.startup(() => this.consumer.transferPending(), command.kind === 'repair' ? () => this.recovery.capacityCheckpoint(() => this.retention(false)) : undefined);
        this.onStartupPhase?.('outboxDrain');
        await k.resources.withTransition('ordinary', async () => { await k.resources.reserve('ordinary'); await k.drain(Deadline.after(120000)); });
        const active = (await k.operations.list()).records.find(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record));
        if (active !== undefined) { this.onStartupPhase?.('streamRecovery'); await this.recovery.resume(active.record.operationId); }
      } catch (error) { failed = true; this.recordFailure(error); }
      if (command.kind === 'chat') {
        try {
          this.onStartupPhase?.('startupAcquisition');
          await k.resources.withTransition('ordinary', () => this.delivery.acquire({ interactionId: k.identities.runtimeSessionId, requestReceivedAt: utcNow() }));
        } catch (error) { failed = true; this.recordFailure(error); }
        if (k.status.consumer === 'notOwner') { return { notOwner: true, consumerResult: null, requiredWorkCompleted: false, capacityRewind: null }; }
        try {
          this.onStartupPhase?.('safetyReconciliation');
          const safety = await k.safety();
          const unfinished = (await k.operations.list()).records.some(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record));
          if (unfinished || safety.pendingCheck !== null || safety.recoveryWitness?.phase === 'preparing' || safety.recoveryWitness?.phase === 'transferring') { await this.recovery.startup(); }
        } catch (error) { failed = true; this.recordFailure(error); }
      }
      this.onStartupPhase?.('retention');
      try { await this.retention(); await reconcileAcknowledgedRecovery(k); } catch (error) { failed = true; this.recordFailure(error); }
      if (failed) { k.emit({ freshness: { ...k.status.freshness, state: 'failed', class: 'journal', reason: k.status.journal.fault ?? k.status.freshness.reason ?? 'journalUnavailable' } }); }
      try { await k.observeStatus(); } catch { k.emit({ stateSafety: { state: 'unavailable', correction: null, carryRelease: 'unavailable' } }); }
      if (command.kind === 'chat') { this.onStartupPhase?.('watcher'); await this.watcher.start(); }
      let complete = !failed;
      if (command.kind === 'repair') {
        try {
          const operations = await k.operations.list();
          const safety = await k.safety();
          complete = complete && operations.invalid.length === 0 && !operations.records.some(entry => effectivelyUnfinished(entry.record)) && safety.pendingCheck === null;
        } catch (error) { complete = false; this.recordFailure(error); }
      }
      const capacityRewind = command.kind === 'repair' ? await this.recovery.capacityResult() : null;
      if (capacityRewind !== null) {
        const extent = capacityRewind.affectedEvents;
        const rangeKnown = extent === 0 ? capacityRewind.fromSequence === null && capacityRewind.throughSequence === null
          : extent !== null && capacityRewind.fromSequence !== null && capacityRewind.throughSequence !== null && capacityRewind.fromSequence <= capacityRewind.throughSequence;
        complete = complete && rangeKnown && capacityRewind.retainedHandoffs !== null && capacityRewind.replayableHandoffs !== null
          && capacityRewind.presentationRetiredHandoffs !== null && capacityRewind.survivingCoreRecords !== null;
      }
      return { notOwner: k.status.consumer === 'notOwner', consumerResult: null, requiredWorkCompleted: complete, capacityRewind };
    });
  }

  private recordFailure(error: unknown): unknown {
    error = this.kernel.resources.captureFailure(error) ?? error;
    this.kernel.diagnose('startupOrAdmission', error);
    if (error instanceof RuntimeCapacityError) {
      this.kernel.resources.reportFailure(error);
      this.kernel.emit({ freshness: { ...this.status.freshness, state: 'failed', class: 'journal',
        reason: this.status.journal.fault ?? (error.state === 'unavailable' ? 'capacityUnavailable' : 'runtimeCapacityExceeded'), checkedAt: utcNow() } });
    }
    return error;
  }

  private deliveryCall<T>(action: () => Promise<T>, source: CapacitySource | null): Promise<T> {
    return this.enqueue(() => this.kernel.resources.withSource(source, async () => {
      try { return await action(); }
      catch (error) {
        error = this.recordFailure(error);
        if (error instanceof RuntimeCapacityError) {
          const authority = await this.kernel.observeSafety();
          if (authority.stateSafety.state === 'recovering' && authority.safety?.status === 'valid' && authority.safety.value.pendingCheck !== null) {
            this.kernel.emit({ stateSafety: authority.stateSafety, freshness: { ...this.status.freshness, state: 'failed', class: 'journal', reason: 'settlementPending', checkedAt: utcNow() } });
            throw new PendingStateCheckError();
          }
          this.kernel.emit({ stateSafety: authority.stateSafety });
        }
        throw error;
      }
    }));
  }
  async acquire(...args: Parameters<DeliveryCoordinator['acquire']>) {
    const source = this.kernel.resources.createSource('ordinary');
    const snapshot = await this.deliveryCall(() => this.delivery.acquire(...args), source);
    this.deliverySources.set(snapshot, source); return snapshot;
  }
  preview(...args: Parameters<DeliveryCoordinator['preview']>) { return this.deliveryCall(() => this.delivery.preview(...args), this.deliverySources.get(args[0]) ?? null); }
  async prepare(...args: Parameters<DeliveryCoordinator['prepare']>) {
    const source = this.deliverySources.get(args[0]) ?? null;
    const handle = await this.deliveryCall(() => this.delivery.prepare(...args), source);
    if (source !== null) { this.deliverySources.set(handle, source); }
    return handle;
  }
  copyForSend(...args: Parameters<DeliveryCoordinator['copyForSend']>) { return this.deliveryCall(() => this.delivery.copyForSend(...args), this.deliverySources.get(args[0]) ?? null); }
  discard(...args: Parameters<DeliveryCoordinator['discard']>) { return this.deliveryCall(() => this.delivery.discard(...args), this.deliverySources.get(args[0]) ?? null); }
  markSent(...args: Parameters<DeliveryCoordinator['markSent']>) { return this.deliveryCall(() => this.delivery.markSent(...args), this.deliverySources.get(args[0]) ?? null); }
  acknowledge(...args: Parameters<DeliveryCoordinator['acknowledge']>) { return this.deliveryCall(() => this.delivery.acknowledge(...args), this.deliverySources.get(args[0]) ?? null); }

  private async retention(reevaluate = true): Promise<void> {
    await maintainRuntimeStorage(this.kernel, undefined, { reevaluate });
  }

  beginShutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      this.kernel.closing = true;
      await Promise.all([this.watcher.stop(), this.kernel.supervisor.stop('core', 30000)]);
    })();
    return this.shuttingDown;
  }

  closeStartupMetadata(): Promise<void> { return this.closeStartupWorkers(); }

  async closeStartupWorkers(): Promise<void> {
    const k = this.kernel;
    k.supervisor.clearStartupJobObserver();
    const closed = await Promise.allSettled([k.inspector.closeStartupSession(), k.publisher.closeStartupMutationSession()]);
    const closeFailure = closed.find(result => result.status === 'rejected');
    if (closeFailure?.status === 'rejected') { throw closeFailure.reason; }
    const absent = await Promise.allSettled([
      k.supervisor.verifyQuiescent('startupMetadata'), k.supervisor.verifyQuiescent('startupCoreReply'),
      k.supervisor.verifyQuiescent('startupMutation'),
    ]);
    const absenceFailure = absent.find(result => result.status === 'rejected');
    if (absenceFailure?.status === 'rejected') { throw absenceFailure.reason; }
  }

  async shutdown(providerAndToolsQuiescent: boolean): Promise<void> {
    await this.beginShutdown();
    requireControl(providerAndToolsQuiescent);
    await this.queue.idle();
    const k = this.kernel;
    await k.core.idle(); await k.journal.idle(); await k.storage.idle(); await k.publisher.idle(); await k.inspector.idle();
    await this.closeStartupWorkers();
    for (const role of processRoles) { await k.supervisor.verifyQuiescent(role); }
    await k.resources.withTransition('runtimeMarker', async () => {
      await k.resources.reserveRuntimeMarker();
      const value = { ...this.runtime.value, cleanShutdown: true, watcher: null };
      const sha256 = await k.storage.write('runtime.json', value, 'config', this.runtime.sha256);
      this.runtime = { value, sha256 };
    }).catch(error => { throw this.recordFailure(error); });
    await k.supervisor.verifyQuiescent('metadata'); await k.supervisor.verifyQuiescent('startupMetadata');
    await k.supervisor.verifyQuiescent('startupCoreReply'); await k.supervisor.verifyQuiescent('startupMutation');
    await k.supervisor.verifyQuiescent('publication');
    k.journal.invalidate();
    await k.guard.release();
  }
}

export async function openBackend(options: FixtureBackendOptions): Promise<RuntimeBackend> {
  const selected = options[privateSelectedImageBootstrap];
  if (selected !== undefined) { requireDirectMainToken(selected.token); }
  if (selected !== undefined && (options[privateCompiledProcessBroker] !== undefined
    || options[privateGoBrokerSpawn] !== undefined || options[privateNativeStartupJobs] !== undefined
    || options[privateRecheckSupervisorIdentity] === true)) {
    throw new Error('Selected image bootstrap conflicts with private process selectors.');
  }
  if (options[privateCompiledProcessBroker] !== undefined && options[privateGoBrokerSpawn] !== undefined) {
    throw new Error('Private broker selectors conflict.');
  }
  if (options[privateGoBrokerSpawn] !== undefined && options[privateGoBrokerSpawn].controlVersion !== 2) {
    throw new Error('Private Go broker requires protocol version 2.');
  }
  options.onStartupPhase?.('configuration');
  const config = await loadRuntimeConfig(path.join(options.companionRoot, 'runtime', 'companion.config.json'));
  options.onStartupPhase?.('scopeAdmission');
  const bootstrap = await createReadOnlyInspection(options.companionRoot, selected?.environment);
  let guard: Awaited<ReturnType<typeof takeInstanceGuard>> | null = null;
  let kernel: Kernel | null = null;
  let supervisor: ProcessSupervisor | null = null;
  let resources: ResourceAuthority | null = null;
  let startupInspector: PathInspector | null = null;
  let startupPublisher: FilePublisher | null = null;
  let earlyMetadata: StartupMetadataSession | null = null;
  let startupGroup: StartupWorkerGroup | null = null;
  try {
    let candidate: ScopeCandidate;
    let selectedPins: 'ready' | 'absent' | null = null;
    if (selected !== undefined) {
      const observed = await observeSourceBoundBootstrap(selected.token, bootstrap.inspector, bootstrap.parentIdentity,
        options.companionRoot, config.game, selected.imageRoot, selected.environment, selected.markPossibleTransfer);
      candidate = observed.candidate;
      selectedPins = observed.imagePins.status;
      selected.onVerifiedPins(selectedPins);
    } else if (options[privateCombinedBootstrap] === true) {
      candidate = await discoverScopeWithPrincipal(bootstrap.inspector, options.companionRoot, config.game);
    } else {
      let principal: string;
      try { principal = await resolvePrincipal(bootstrap.inspector, options.companionRoot); }
      catch { throw Object.assign(new Error('Windows principal identity is unavailable.'), { code: 'identityUnavailable' }); }
      candidate = await discoverScope(bootstrap.inspector, options.companionRoot, config.game, principal);
    }
    options.onStartupPhase?.('instanceGuard');
    guard = await takeInstanceGuard(candidate.dataRoot, () => { kernel?.journal.invalidate(); kernel?.resources.invalidate(); options.onInvalidated?.('contextUncertain'); });
    const broker = selectedPins === 'ready' ? releaseGoBrokerSpawn(selected!.imageRoot, selected!.scratch)
      : options[privateGoBrokerSpawn] ?? (options[privateCompiledProcessBroker] === undefined
        ? undefined : compiledBrokerSpawn(options[privateCompiledProcessBroker]));
    const nativeJobs = selectedPins === 'ready' ? releaseNativeJobObserverArtifact(selected!.imageRoot, selected!.scratch)
      : options[privateNativeStartupJobs];
    supervisor = options[privateRecheckSupervisorIdentity] === true
      ? await ProcessSupervisor.create(candidate.dataRoot, broker, nativeJobs) : bootstrap.supervisorFor(candidate.dataRoot, broker, nativeJobs);
    const inspector = new PathInspector(supervisor);
    startupInspector = inspector;
    const prospectiveFailure = (error: ProspectiveJsonBudgetError): Error => resources?.prospectiveFailure(error) ?? error;
    const publisher = new FilePublisher({ root: candidate.dataRoot, guard, inspector, supervisor, prospectiveFailure,
      bind: action => resources?.bind(action) ?? action, beforeWrite: (relative, deadline) => resources?.beforeWrite(relative, deadline) ?? Promise.resolve(),
      get preflightWithAdmission(): PublicationOptions['preflightWithAdmission'] {
        const authority = resources;
        return authority === null ? undefined : (target, bytes, profile, admit, deadline) => authority.preflight(target, bytes, profile, deadline, admit);
      },
      preflight: async (target, bytes, profile, deadline) => {
        if (resources !== null) { await resources.preflight(target, bytes, profile, deadline); return; }
        // The sole bootstrap publication is a new immutable scope binding.
        requireControl(path.basename(target) === 'scope.json' && profile === 'config' && bytes.byteLength < jsonBudgets.config.maxBytes);
        const free = await fs.statfs(candidate.companionRoot, { bigint: true });
        requireControl(free.bavail * free.bsize >= BigInt(bytes.byteLength) * 4n);
      }, invalidate: () => { kernel?.journal.invalidate(); resources?.invalidate(); } });
    startupPublisher = publisher;
    const hoistMetadata = options.startupMetadata === true && options[privateStartupMetadataPlacement] === 'postGuard';
    const batchScope = hoistMetadata && options[privateScopeSourceBatch] === true;
    if (batchScope) { await supervisor.verifyQuiescent('startupMetadata'); }
    const bootstrapProof = batchScope ? await observeBootstrapWorkerSources(inspector, candidate) : null;
    const scope = bootstrapProof?.status === 'present' && bootstrapProof.scopeBytes !== null
      ? scopeFromAdmittedBinding(candidate, bootstrapProof.scopeBytes)
      : await initializeScope(inspector, candidate, guard, publisher);
    requireControl(guard.held);
    if (hoistMetadata) {
      if (!batchScope) { await supervisor.verifyQuiescent('startupMetadata'); }
      const evidence = bootstrapProof?.status === 'present' ? bootstrapProof.evidence
        : bootstrapProof?.status === 'absent' ? null : await observeStartupWorkerSources(inspector, scope);
      if (evidence !== null && evidence.scopeSha256 !== scope.bindingSha256) {
        throw new DataRootUnavailableError('Bootstrap scope changed before startup worker admission.');
      }
      if (evidence !== null) {
        earlyMetadata = await StartupMetadataSession.prepareWithEvidence(supervisor, scope, evidence)();
        if (earlyMetadata !== null) {
          inspector.attachStartupSession(earlyMetadata);
          if (options[privateWarmJobObserver] === true) {
            supervisor.attachStartupJobObserver((names, timeoutMs) => inspector.observeStartupJobs(names, timeoutMs));
          }
        }
      }
    }
    options.onStartupPhase?.('runtimeMarker');
    const storage = new ScopeStorage({ scope, guard, inspector, publisher, prospectiveFailure, bind: action => resources?.bind(action) ?? action,
      beforeWrite: (relative, deadline) => resources?.beforeWrite(relative, deadline) ?? Promise.resolve() });
    const operations = new OperationStore(storage, prospectiveFailure, action => resources?.bind(action) ?? action);
    resources = new ResourceAuthority(scope, inspector, operations);
    const markerSupervisor = supervisor;
    const { identities, runtime, sha256, previous, startupWorker } = await initializeRuntimeMarker(
      { scope, guard, inspector, supervisor: markerSupervisor, storage, resources, earlyMetadata }, undefined,
      options.startupMetadata === true ? proveEarly => hoistMetadata
        ? bootstrapProof?.status === 'absent' ? Promise.resolve(null)
          : StartupWorkerGroup.prepare(inspector, markerSupervisor, scope, undefined, earlyMetadata, false, proveEarly)
        : StartupWorkerGroup.prepare(inspector, markerSupervisor, scope) : undefined);
    startupGroup = startupWorker;
    if (startupGroup?.metadata !== null && startupGroup?.metadata !== undefined && startupGroup.metadata !== earlyMetadata) {
      inspector.attachStartupSession(startupGroup.metadata);
    }
    if (startupGroup?.coreReply !== null && startupGroup?.coreReply !== undefined) { inspector.attachStartupCoreReplySession(startupGroup.coreReply); }
    if (startupGroup?.mutation !== null && startupGroup?.mutation !== undefined) { publisher.attachStartupMutationSession(startupGroup.mutation); }
    kernel = new Kernel({ config, identities, scope, guard, supervisor, inspector, publisher, storage, resources, options });
    kernel.emit({ previousShutdownClean: previous.status === 'valid' && previous.value.cleanShutdown });
    await bootstrap.close();
    return new CoordinatorBackend(kernel, { value: runtime, sha256 }, options.onStartupPhase);
  } catch (error) {
    let failure: unknown = resources?.captureFailure(error) ?? error;
    try {
      supervisor?.clearStartupJobObserver();
      const closed = await Promise.allSettled([startupInspector?.closeStartupSession(), startupPublisher?.closeStartupMutationSession(), startupGroup?.close(), earlyMetadata?.close()]);
      const closeFailure = closed.find(result => result.status === 'rejected');
      await bootstrap.close();
      if (guard !== null && supervisor !== null) {
        // Failed native termination retains the instance guard while this process
        // lives. A second writer must never race a possibly active predecessor.
        for (const role of processRoles) { await supervisor.verifyQuiescent(role); }
        if (closeFailure?.status === 'rejected') { throw closeFailure.reason; }
        await guard.release();
      }
      if (closeFailure?.status === 'rejected') { failure = closeFailure.reason; }
    } catch (cleanupFailure) { failure = cleanupFailure; }
    throw phaseFatalError(failure);
  }
}

const phaseFatalCodes: ReadonlySet<unknown> = new Set(['configurationInvalid', 'identityUnavailable', 'dataRootUnavailable', 'runtimeAlreadyRunning']);

/** @internal Phases A through C fail only with their four fatal codes; any other failure keeps its cause under `dataRootUnavailable`. */
export function phaseFatalError(error: unknown): unknown {
  if (error !== null && typeof error === 'object' && 'code' in error && phaseFatalCodes.has(error.code)) { return error; }
  return new DataRootUnavailableError(error instanceof Error ? error.message : 'Runtime startup authority is unavailable.', { cause: error });
}
