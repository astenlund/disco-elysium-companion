import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from '../admission.ts';
import { RuntimeCapacityError } from '../capacity.ts';
import { loadRuntimeConfig } from '../config.ts';
import { requireControl } from '../control-values.ts';
import { resolvePrincipal } from '../core-client.ts';
import { Deadline } from '../deadline.ts';
import { FilePublisher } from '../files.ts';
import { takeInstanceGuard } from '../guard.ts';
import { mintProcessIdentities } from '../identity.ts';
import { initializeJournal } from '../journal-initialization.ts';
import { jsonBudgets, utcNow } from '../json.ts';
import { OperationStore } from '../operations.ts';
import { effectivelyUnfinished } from '../operation-records.ts';
import { cleanupPublicationResidue, reconcileWatcherOrphan, WatcherSupervisor } from '../platform/index.ts';
import { ProcessSupervisor } from '../process.ts';
import { createReadOnlyInspection } from '../read-only-inspection.ts';
import { maintainRuntimeStorage } from '../resource-lifecycle/retention.ts';
import { parseRuntimeRecord, type RuntimeRecord } from '../runtime-records.ts';
import { discoverScope, initializeScope } from '../scope.ts';
import { SerialQueue } from '../serial.ts';
import { ScopeStorage } from '../storage.ts';
import type { BackendCommand, BackendOptions, BackendStartup, RuntimeBackend } from './api.ts';
import { ConsumerCoordinator } from './consumer.ts';
import { DeliveryCoordinator } from './delivery.ts';
import { Kernel } from './kernel.ts';
import { RecoveryCoordinator } from './recovery.ts';
import { ResourceAuthority } from './resources.ts';

export { readRuntimeStatus as readBackendStatus } from '../platform/index.ts';
export type * from './api.ts';

/** @internal Composition of already-admitted primitives; openBackend owns admission. */
export class CoordinatorBackend implements RuntimeBackend {
  private readonly kernel: Kernel;
  private readonly recovery: RecoveryCoordinator;
  private readonly consumer: ConsumerCoordinator;
  private readonly delivery: DeliveryCoordinator;
  private readonly queue = new SerialQueue();
  private readonly watcher: WatcherSupervisor;
  private runtime: { value: RuntimeRecord; sha256: string };
  private started = false;
  private shuttingDown: Promise<void> | null = null;

  constructor(kernel: Kernel, runtime: { value: RuntimeRecord; sha256: string }) {
    this.kernel = kernel; this.runtime = runtime;
    this.recovery = new RecoveryCoordinator(kernel); this.consumer = new ConsumerCoordinator(kernel); this.delivery = new DeliveryCoordinator(kernel, () => this.retention(false));
    this.watcher = new WatcherSupervisor({ companionRoot: kernel.scope.companionRoot, adapter: kernel.config.adapter, enabled: kernel.config.watcher.enabled, supervisor: kernel.supervisor,
      persistWatcher: async watcher => {
        const value = { ...this.runtime.value, watcher };
        const sha256 = await kernel.storage.write('runtime.json', value, 'config', this.runtime.sha256);
        this.runtime = { value, sha256 };
      }, onState: watcher => kernel.emit({ watcher }) });
  }

  get config() { return this.kernel.config; }
  get identities() { return this.kernel.identities; }
  get scope() { return this.kernel.scope; }
  get sessions() { return this.kernel.sessions; }
  get supervisor() { return this.kernel.supervisor; }
  get inspector() { return this.kernel.inspector; }
  get status() { return this.kernel.status; }
  safety(...args: Parameters<Kernel['safety']>) { return this.kernel.safety(...args); }
  providerSafety(deadline?: Deadline) {
    return this.queue.run(async () => {
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
    return this.queue.run(async () => {
      requireControl(!this.started); this.started = true;
      const k = this.kernel;
      await cleanupPublicationResidue(k.scope, k.guard, k.inspector, k.supervisor);
      try { await k.resources.reserve('release'); }
      catch (error) {
        if (!(error instanceof RuntimeCapacityError)) { throw error; }
        await this.retention(false);
        await k.resources.reserve('release');
      }
      let failed = false;
      try {
        if (k.scope.createdHere) { await k.safetyStore.initializeNew(); }
        await initializeJournal(k.storage, k.inspector, k.publisher);
        await k.storage.ensureDirectory('operations');
        await k.storage.ensureDirectory('quarantine');
      } catch (error) { failed = true; k.diagnose('initializeJournalAndSafety', error); }
      try {
        const consumerStartup = await this.consumer.startup(command);
        if (consumerStartup !== null) { return consumerStartup; }
      } catch (error) {
        if (command.kind === 'consumer') { throw error; }
        failed = true; this.recordFailure(error);
      }
      try {
        await this.recovery.startup(() => this.consumer.transferPending());
        await k.resources.reserve('ordinary');
        await k.drain(Deadline.after(120000));
        const active = (await k.operations.list()).records.find(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record));
        if (active !== undefined) { await this.recovery.resume(active.record.operationId); }
      } catch (error) { failed = true; this.recordFailure(error); }
      if (command.kind === 'chat') {
        try {
          await this.delivery.acquire({ interactionId: k.identities.runtimeSessionId, requestReceivedAt: utcNow() });
        } catch (error) { failed = true; this.recordFailure(error); }
        if (k.status.consumer === 'notOwner') { return { notOwner: true, consumerResult: null }; }
        try {
          const safety = await k.safety();
          const unfinished = (await k.operations.list()).records.some(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record));
          if (unfinished || safety.pendingCheck !== null || safety.recoveryWitness?.phase === 'preparing' || safety.recoveryWitness?.phase === 'transferring') { await this.recovery.startup(); }
        } catch (error) { failed = true; this.recordFailure(error); }
      }
      try { await this.retention(); } catch (error) { failed = true; this.recordFailure(error); }
      if (failed) { k.emit({ freshness: { ...k.status.freshness, state: 'failed', class: 'journal', reason: k.status.journal.fault ?? 'journalUnavailable' } }); }
      try { await k.observeStatus(); } catch { k.emit({ stateSafety: { state: 'unavailable', correction: null } }); }
      if (command.kind === 'chat') { await this.watcher.start(); }
      return { notOwner: k.status.consumer === 'notOwner', consumerResult: null };
    });
  }

  private recordFailure(error: unknown): void {
    this.kernel.diagnose('startupOrAdmission', error);
    if (error instanceof RuntimeCapacityError) {
      this.kernel.emit({ journal: { ...this.status.journal, state: 'fault', fault: 'runtimeCapacityExceeded' } });
    }
  }

  acquire(...args: Parameters<DeliveryCoordinator['acquire']>) {
    return this.queue.run(async () => {
      try { return await this.delivery.acquire(...args); }
      catch (error) { this.recordFailure(error); throw error; }
    });
  }
  preview(...args: Parameters<DeliveryCoordinator['preview']>) { return this.queue.run(() => this.delivery.preview(...args)); }
  prepare(...args: Parameters<DeliveryCoordinator['prepare']>) { return this.queue.run(() => this.delivery.prepare(...args)); }
  copyForSend(...args: Parameters<DeliveryCoordinator['copyForSend']>) { return this.queue.run(() => this.delivery.copyForSend(...args)); }
  discard(...args: Parameters<DeliveryCoordinator['discard']>) { return this.queue.run(() => this.delivery.discard(...args)); }
  markSent(...args: Parameters<DeliveryCoordinator['markSent']>) { return this.queue.run(() => this.delivery.markSent(...args)); }
  acknowledge(...args: Parameters<DeliveryCoordinator['acknowledge']>) { return this.queue.run(() => this.delivery.acknowledge(...args)); }

  private async retention(reevaluate = true): Promise<void> {
    await maintainRuntimeStorage(this.kernel, undefined, { reevaluate });
  }

  beginShutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      this.kernel.closing = true;
      await this.watcher.stop();
      await this.kernel.supervisor.stop('core', 30000);
    })();
    return this.shuttingDown;
  }

  async shutdown(providerAndToolsQuiescent: boolean): Promise<void> {
    await this.beginShutdown();
    requireControl(providerAndToolsQuiescent);
    await this.queue.idle();
    const k = this.kernel;
    await k.core.idle(); await k.journal.idle(); await k.storage.idle(); await k.publisher.idle(); await k.inspector.idle();
    for (const role of ['core', 'publication', 'provider', 'watcher', 'metadata'] as const) { await k.supervisor.verifyQuiescent(role); }
    const value = { ...this.runtime.value, cleanShutdown: true, watcher: null };
    const sha256 = await k.storage.write('runtime.json', value, 'config', this.runtime.sha256);
    this.runtime = { value, sha256 };
    k.journal.invalidate();
    await k.guard.release();
  }
}

export async function openBackend(options: BackendOptions): Promise<RuntimeBackend> {
  const config = await loadRuntimeConfig(path.join(options.companionRoot, 'runtime', 'companion.config.json'));
  const bootstrap = await createReadOnlyInspection(options.companionRoot);
  let guard: Awaited<ReturnType<typeof takeInstanceGuard>> | null = null;
  let kernel: Kernel | null = null;
  let supervisor: ProcessSupervisor | null = null;
  try {
    let principal: string;
    try { principal = await resolvePrincipal(bootstrap.inspector, options.companionRoot); }
    catch { throw Object.assign(new Error('Windows principal identity is unavailable.'), { code: 'identityUnavailable' }); }
    const candidate = await discoverScope(bootstrap.inspector, options.companionRoot, config.game, principal);
    guard = await takeInstanceGuard(candidate.dataRoot, () => { kernel?.journal.invalidate(); kernel?.resources.invalidate(); options.onInvalidated?.('contextUncertain'); });
    supervisor = await ProcessSupervisor.create(candidate.dataRoot);
    const inspector = new PathInspector(supervisor);
    let resources: ResourceAuthority | null = null;
    const publisher = new FilePublisher({ root: candidate.dataRoot, guard, inspector, supervisor,
      preflight: async (target, bytes, profile, deadline) => {
        if (resources !== null) { await resources.preflight(target, bytes, profile, deadline); return; }
        // The sole bootstrap publication is a new immutable scope binding.
        requireControl(path.basename(target) === 'scope.json' && profile === 'config' && bytes.byteLength < jsonBudgets.config.maxBytes);
        const free = await fs.statfs(candidate.companionRoot, { bigint: true });
        requireControl(free.bavail * free.bsize >= BigInt(bytes.byteLength) * 4n);
      }, invalidate: () => { kernel?.journal.invalidate(); resources?.invalidate(); } });
    const scope = await initializeScope(inspector, candidate, guard, publisher);
    const storage = new ScopeStorage({ scope, guard, inspector, publisher });
    const operations = new OperationStore(storage);
    resources = new ResourceAuthority(scope, inspector, operations);
    await resources.reserveRuntimeMarker();
    const previous = await storage.read('runtime.json', 'config', parseRuntimeRecord);
    requireControl(previous.status !== 'invalid');
    await reconcileWatcherOrphan(previous.status === 'valid' ? previous.value : null, supervisor, scope.companionRoot);
    await supervisor.admitStartup();
    const identities = mintProcessIdentities(previous.status === 'valid' ? previous.value.runtimeInstanceId : null);
    const runtime: RuntimeRecord = { runtimeInstanceId: identities.runtimeInstanceId, startedAt: utcNow(), cleanShutdown: false, watcher: null };
    const sha256 = await storage.write('runtime.json', runtime, 'config', previous.status === 'valid' ? previous.sha256 : null);
    kernel = new Kernel({ config, identities, scope, guard, supervisor, inspector, publisher, storage, resources, options });
    kernel.emit({ previousShutdownClean: previous.status === 'valid' && previous.value.cleanShutdown });
    await bootstrap.close();
    return new CoordinatorBackend(kernel, { value: runtime, sha256 });
  } catch (error) {
    await bootstrap.close();
    if (guard !== null && supervisor !== null) {
      // Failed native termination retains the instance guard while this process
      // lives. A second writer must never race a possibly active predecessor.
      for (const role of ['core', 'publication', 'provider', 'watcher', 'metadata'] as const) { await supervisor.verifyQuiescent(role); }
      await guard.release();
    }
    if (error !== null && typeof error === 'object' && 'code' in error) { throw error; }
    throw new DataRootUnavailableError(error instanceof Error ? error.message : 'Runtime startup authority is unavailable.');
  }
}
