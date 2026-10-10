import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PathInspector } from '../admission.ts';
import { handoffIdentity, handoffIdentityDigest, mergeHandoff } from '../backend/handoffs.ts';
import type { CodecReservation } from '../codec.ts';
import { CapacityObservation, capacityError, requireCapacity, RuntimeCapacityError, type CapacityInventory, type CapacityOwed, type CapacityReason, type CapacityTransition, type DocumentReservation, type ResourceCounts, type TransitionReservation } from '../capacity.ts';
import { requireControl } from '../control-values.ts';
import type { Deadline } from '../deadline.ts';
import { PublicationPathAdmissionError, type AdmitPublicationScope } from '../files.ts';
import { eventFileSequence } from '../journal-records.ts';
import { asInteger, hasExactKeys, isLowerHex, jsonBudgets, parseStrictJson, readBoundedFile, ProspectiveJsonBudgetError, stringifyProspectiveJson, type JsonProfile } from '../json.ts';
import { effectivelyUnfinished, pendingOperationSafety, parseOperation, type FullOperation, type RepairOperation, type RetainedHandoff } from '../operation-records.ts';
import type { OperationStore } from '../operations.ts';
import type { RuntimeScope } from '../scope.ts';
import { parseStateSafety } from '../safety-records.ts';
import { bytesHash } from '../storage.ts';

const script = fileURLToPath(new URL('../../scripts/resource-lifecycle/Get-ResourceInventory.ps1', import.meta.url));
const zero: ResourceCounts = Object.freeze({ uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 });
const fixedControls = new Set(['scope.json', 'runtime.json', 'state-safety.json', 'agent-session.json', 'agent-session-index.json', 'journal/journal.json', 'journal/cursor-agent-session.json']);
const maximumPendingOutbox = 16;
const maximumRecoveryEvents = 2;
const controlWorkspace = 4_194_304n;
const stamp = '9999-12-31T23:59:59.9999999Z';
const token = 'f'.repeat(32);
const maximumOpaque = String.fromCodePoint(0x10000).repeat(128);

export interface ResourceObservation extends CapacityInventory {
  readonly potentialHandoffs: number;
  readonly unfinishedOperations: number;
  readonly invalidEvents: number;
  readonly pendingOutbox: number;
  readonly recoveryEvents?: number;
  readonly activeRepair?: boolean;
  readonly pendingConsumer?: boolean;
}

function unavailable(dimension: string): never { throw new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: [dimension] }); }
function assertProjectedDocument(value: unknown): void {
  try { stringifyProspectiveJson(value, 'state-event', 'operation-finalization'); }
  catch (error) {
    if (!(error instanceof ProspectiveJsonBudgetError)) { throw error; }
    const dimensions = [...new Set(error.limits.map(item => item.dimension === 'bytes' ? 'operationFinalization:bytes' : 'operationFinalization:tokensOrText'))];
    throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions }, null, { cause: error });
  }
}

// Unknown future documents reserve their complete profile. These slots cover
// every possible pending source, both recovery publications and release control.
export function completeReservation(kind: TransitionReservation['kind'], inventory: ResourceObservation, additions: Partial<ResourceCounts> = {}): TransitionReservation {
  for (const count of Object.values(additions)) { if (!Number.isSafeInteger(count) || count < 0) { unavailable('additions'); } }
  if (!Number.isSafeInteger(inventory.potentialHandoffs) || inventory.potentialHandoffs < inventory.counts.retainedHandoffs) { unavailable('inventory'); }
  const recoveryEvents = inventory.recoveryEvents ?? maximumRecoveryEvents;
  const incoming = kind === 'release' ? 0 : inventory.pendingOutbox + (kind === 'ordinary' ? 1 : recoveryEvents);
  const recoveryReserve = kind === 'ordinary' ? recoveryEvents : 0;
  const handoffGrowth = kind === 'release' ? 0 : (kind === 'repair' && inventory.activeRepair && recoveryEvents === 0 ? 0 : Math.max(0, inventory.potentialHandoffs - inventory.counts.retainedHandoffs)) + incoming;
  const newRoot = kind === 'release' ? inventory.pendingConsumer ? 0 : 1 : inventory.activeRepair ? 0 : 1;
  const result: ResourceCounts = {
    uncompactedEvents: Math.max(incoming, additions.uncompactedEvents ?? 0),
    retainedHandoffs: Math.max(handoffGrowth, additions.retainedHandoffs ?? 0),
    fullTerminalOperations: Math.max(inventory.unfinishedOperations + newRoot, additions.fullTerminalOperations ?? 0),
  };
  const documents: DocumentReservation[] = [...fixedControls].map(name => ({ name, profile: 'config', usage: null }));
  documents.push({ name: 'repair-plan', profile: 'state-event', usage: null }, { name: 'release-intent', profile: 'state-event', usage: null },
    { name: 'recovery-carry', profile: 'state-event', usage: null });
  for (let index = 0; index < incoming + recoveryReserve; index++) { documents.push({ name: `incoming-${index}`, profile: 'state-event', usage: null }); }
  return {
    kind, additions: result,
    remainingControlReserve: kind === 'ordinary' ? { uncompactedEvents: recoveryReserve, retainedHandoffs: recoveryReserve, fullTerminalOperations: inventory.pendingConsumer ? 0 : 1 }
      : kind === 'repair' ? { ...zero, fullTerminalOperations: inventory.pendingConsumer ? 0 : 1 } : zero,
    documents,
    // Source/control staging, codec output, target input/temp/backup and the
    // prepared context coexist only within this serialized publication budget.
    workspaceBytes: BigInt(jsonBudgets['state-event'].maxBytes) * 6n + BigInt(jsonBudgets.config.maxBytes) * 3n + controlWorkspace,
  };
}

export function validateOperationExpansion(record: FullOperation, futureRecords = maximumPendingOutbox + maximumRecoveryEvents): void {
  const projected = structuredClone(record);
  // These are bounded control metadata, never source payload. Validate the full
  // final shape including the replacement and finalization fields before writing.
  const terminal = { ...projected, completedAt: projected.completedAt ?? stamp, outcome: projected.outcome ?? 'completed' };
  if (projected.kind !== 'repair') {
    const result = projected.plan.result ?? { owner: projected.kind === 'release' ? 'bridge' : 'runtime', previousOwner: 'runtime', changed: true, baselineRemoved: true, abandonedCount: Number.MAX_SAFE_INTEGER };
    assertProjectedDocument({ ...terminal, safety: { ...projected.safety, phase: 'transferred', correctionId: token }, plan: { ...projected.plan, result,
      completedPhases: projected.kind === 'release' ? ['coreSwitched', 'cursorAdvanced', 'repairsAbandoned', 'dischargesPublished', 'complete'] : ['coreSwitched', 'historyPublished', 'complete'],
      ...(projected.kind === 'release' ? { skippedRanges: projected.plan.skippedRanges.map(range => ({ ...range, discharge: range.discharge ?? { kind: 'abandonRelease', operationId: projected.operationId, episodeOrdinal: null, at: stamp } })) } : {}) } });
    return;
  }
  const recovery = structuredClone(projected.recovery);
  const attempts = [...recovery.attempts];
  const active = recovery.activeEpisode;
  if (active !== null && recovery.episodes[active]!.replacementAttempt === null) { attempts.push({ publication: 'due', selectedRecord: null, journalEvent: null }); }
  const reference = { journalId: maximumOpaque, eventId: token, sequence: Number.MAX_SAFE_INTEGER };
  const expandedAttempts = attempts.map(attempt => ({ ...attempt, publication: 'observed', selectedRecord: attempt.selectedRecord ?? { logicalOutboxId: `${token}-${Number.MAX_SAFE_INTEGER}`, recordSha256: 'f'.repeat(64) }, journalEvent: attempt.journalEvent ?? reference }));
  const episodes = recovery.episodes.map((episode, index) => index !== active ? episode : { ...episode, phase: 'abandonedByRelease', endedAt: stamp,
    acceptedRecovery: episode.acceptedRecovery ?? { ...reference, generation: token, acceptedAt: stamp }, releaseOperationId: `rl-${token}`,
    replacementAttempt: episode.replacementAttempt ?? attempts.length - 1,
    prerequisite: episode.prerequisite === null ? null : { ...episode.prerequisite, nextAction: episode.prerequisite.actions.length } });
  const ranges = projected.plan.skippedRanges.map(range => ({ ...range, discharge: range.discharge ?? { kind: 'recoveryAcknowledged', operationId: projected.operationId, episodeOrdinal: active ?? 0, at: stamp } }));
  const futureCount = effectivelyUnfinished(projected) ? futureRecords : 0;
  const handoffs = [...projected.plan.handoffs];
  const retiredRecords = [...projected.plan.retiredRecords];
  for (let index = 0; index < futureCount; index++) {
    const logicalOutboxId = `${token}-${Number.MAX_SAFE_INTEGER - index}`;
    handoffs.push({ logicalOutboxId, recordSha256: 'f'.repeat(64), payloadBindingSha256: 'f'.repeat(64), journalId: maximumOpaque, eventId: maximumOpaque,
      acceptance: { journalId: maximumOpaque, eventId: maximumOpaque, generation: token }, presentation: 'unverified', coreRepairOperationId: maximumOpaque,
      attemptRef: { operationId: projected.operationId, attemptOrdinal: Number.MAX_SAFE_INTEGER } });
    retiredRecords.push({ name: `event-${Number.MAX_SAFE_INTEGER - index}.json`, logicalOutboxId, recordSha256: 'f'.repeat(64) });
  }
  if (handoffs.length > 8192) { throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['retainedHandoffs'] }); }
  assertProjectedDocument({ ...terminal, plan: { ...projected.plan, handoffs, retiredRecords, correctionId: projected.plan.correctionId ?? token, skippedRanges: ranges,
    publishedVersions: projected.plan.publishedVersions ?? { schemaVersion: 9223372036854775807n, adapterVersion: -9223372036854775808n } },
  recovery: { ...recovery, attempts: expandedAttempts, episodes, activeEpisode: null } });
}

export function remainingRecoveryPublications(record: RepairOperation): number {
  if (record.recovery.activeEpisode === null) { return maximumRecoveryEvents; }
  const episode = record.recovery.episodes[record.recovery.activeEpisode]!;
  const attempt = record.recovery.attempts.at(-1)!;
  if (episode.phase === 'verifyingHistory') { return 0; }
  const publicationDue = attempt.publication !== 'observed' || episode.phase === 'recordRejected';
  return (publicationDue ? 1 : 0) + (episode.replacementAttempt === null ? 1 : 0);
}

export interface CapacitySource { readonly kind: CapacityTransition }
interface CapacityLease {
  readonly source: CapacitySource;
  readonly epoch: number;
  readonly reservation: TransitionReservation;
  readonly targets: ReadonlySet<string> | null;
  readonly newEvents: Set<string>;
  readonly newOperations: Set<string>;
}
interface SourceContext { readonly source: CapacitySource; readonly bound: boolean; readonly lease: CapacityLease | null }

export class ResourceAuthority {
  readonly capacity = new CapacityObservation();
  private readonly scope: RuntimeScope;
  private readonly inspector: PathInspector;
  private readonly operations: OperationStore;
  private readonly context = new AsyncLocalStorage<SourceContext | null>();
  private readonly sources = new WeakMap<CapacitySource, { lease: CapacityLease | null }>();
  private authorityEpoch = 0;

  constructor(scope: RuntimeScope, inspector: PathInspector, operations: OperationStore) { this.scope = scope; this.inspector = inspector; this.operations = operations; }

  createSource(kind: CapacityTransition): CapacitySource {
    const source = Object.freeze({ kind });
    this.sources.set(source, { lease: null });
    return source;
  }

  currentSource(): CapacitySource | null {
    const source = this.context.getStore()?.source;
    return source !== undefined && this.sources.has(source) ? source : null;
  }

  withSource<T>(source: CapacitySource | null, action: () => Promise<T>): Promise<T> {
    const admitted = source !== null && this.sources.has(source);
    return this.context.run(admitted ? { source, bound: false, lease: null } : null, action);
  }

  withTransition<T>(kind: CapacityTransition, action: () => Promise<T>): Promise<T> {
    const source = this.currentSource();
    return source?.kind === kind ? action() : this.withSource(this.createSource(kind), action);
  }

  bind<T>(action: () => Promise<T>): () => Promise<T> {
    const current = this.context.getStore();
    const captured = current == null ? null : { source: current.source, bound: true, lease: this.lease(current) };
    return () => this.context.run(captured, action);
  }

  private lease(context = this.context.getStore()): CapacityLease | null {
    if (context == null || !this.sources.has(context.source)) { return null; }
    return context.bound ? context.lease : this.sources.get(context.source)!.lease;
  }

  private valid(lease: CapacityLease | null): lease is CapacityLease {
    return lease !== null && lease.epoch === this.authorityEpoch && this.sources.get(lease.source)?.lease === lease;
  }

  assertReservation(): CapacityTransition {
    const lease = this.lease();
    if (!this.valid(lease)) { this.refuse(new Error('Required capacity reservation is stale.'), null, 'otherAuthority'); }
    return lease.source.kind;
  }

  private source(kind: CapacityTransition): CapacitySource {
    const context = this.context.getStore();
    if (context == null || context.bound || !this.sources.has(context.source) || context.source.kind !== kind) {
      this.refuse(new Error('Capacity source ownership is unavailable.'), null, 'otherAuthority');
    }
    return context.source;
  }

  invalidate(): void { this.authorityEpoch++; this.capacity.invalidate(); }
  reportFailure(error: RuntimeCapacityError): void { this.capacity.refused(error); }

  prospectiveFailure(error: ProspectiveJsonBudgetError): RuntimeCapacityError {
    const lease = this.lease();
    const kind = this.valid(lease) ? lease.source.kind : null;
    const failure = capacityError(error, kind);
    if (lease !== null) { this.sources.get(lease.source)!.lease = null; }
    this.capacity.invalidateOwed(); this.reportFailure(failure);
    return failure;
  }

  captureFailure(error: unknown): RuntimeCapacityError | null {
    if (error instanceof RuntimeCapacityError) { this.reportFailure(error); return error; }
    if (!(error instanceof ProspectiveJsonBudgetError)) { return null; }
    const failure = capacityError(error, null);
    this.invalidate(); this.reportFailure(failure);
    return failure;
  }

  private refuse(error: unknown, kind: CapacityTransition | null, dependency: CapacityReason, owed: Partial<CapacityOwed> = {}): never {
    const failure = capacityError(error, kind, dependency);
    const source = this.currentSource();
    if (source !== null) { this.sources.get(source)!.lease = null; }
    if (kind === null) { this.invalidate(); } else { this.capacity.invalidateOwed(); }
    this.capacity.observeOwed(owed); this.reportFailure(failure);
    throw failure;
  }

  invalidatePublication(relative: string): void {
    if (relative === 'runtime.json') { return; }
    const fields: readonly (keyof CapacityOwed)[] = relative === 'agent-session.json' || relative === 'agent-session-index.json'
      ? ['protectedHandoffs', 'safetyObligation', 'historyDisclosure']
      : relative === 'state-safety.json' ? ['protectedHandoffs', 'safetyObligation', 'historyDisclosure']
        : relative.startsWith('operations/') ? ['unfinishedOperations', 'protectedHandoffs', 'safetyObligation', 'historyDisclosure']
          : relative.startsWith('journal/') ? ['unacknowledgedEvents', 'protectedHandoffs', 'safetyObligation', 'historyDisclosure']
            : ['unacknowledgedEvents', 'pendingOutboxRecords', 'unfinishedOperations', 'protectedHandoffs', 'safetyObligation', 'historyDisclosure'];
    this.capacity.invalidateOwed(fields);
  }

  async beforeWrite(relative: string, deadline?: Deadline): Promise<void> {
    const source = this.currentSource();
    if (source === null) { this.refuse(new Error('Publication source is absent.'), null, 'otherAuthority'); }
    if (!this.valid(this.lease())) {
      if (this.context.getStore()?.bound) { this.refuse(new Error('Queued publication reservation is stale.'), null, 'otherAuthority'); }
      if (source.kind === 'runtimeMarker') { await this.reserveRuntimeMarker(deadline); }
      else if (source.kind === 'maintenance') { await this.reserveMaintenance(deadline); }
      else { await this.reserve(source.kind, {}, deadline); }
    }
    this.invalidatePublication(relative);
  }

  async sessionMutation<T>(action: () => Promise<T>, deadline?: Deadline): Promise<T> {
    if (this.currentSource() !== null) { return action(); }
    return this.withTransition('ordinary', async () => {
      await this.reserveControls('ordinary', new Set(['agent-session.json', 'agent-session-index.json']), false, deadline);
      return action();
    });
  }

  private async observe(mode: 'Inventory' | 'Marker', deadline?: Deadline): Promise<ResourceObservation & { readonly retainedHandoffIdentitySha256: string }> {
    const reply = await this.inspector.metadata(script, ['-Root', this.scope.dataRoot, '-ScopeSha256', this.scope.bindingSha256, '-CompanionRoot', this.scope.companionRoot, '-Mode', mode], this.scope.dataRoot, deadline?.remaining());
    if (reply.exitCode !== 0) { unavailable('inventory'); }
    const value = parseStrictJson(reply.stdout);
    if (!hasExactKeys(value, ['uncompactedEvents', 'retainedHandoffs', 'retainedHandoffIdentitySha256', 'potentialHandoffs', 'fullTerminalOperations', 'unfinishedOperations', 'invalidEvents', 'invalidOperations', 'pendingOutbox', 'uncertainWorkspace', 'freeBytes'])) { unavailable('inventory'); }
    const counts = ['uncompactedEvents', 'retainedHandoffs', 'potentialHandoffs', 'fullTerminalOperations', 'unfinishedOperations', 'invalidEvents', 'invalidOperations', 'pendingOutbox'].map(name => asInteger(value[name]));
    if (!isLowerHex(value['retainedHandoffIdentitySha256'], 64) || counts.some(count => count === undefined || count < 0) || typeof value['freeBytes'] !== 'string' || !/^[0-9]+$/.test(value['freeBytes']) || typeof value['uncertainWorkspace'] !== 'boolean') { unavailable('inventory'); }
    return { complete: true, retainedHandoffIdentitySha256: value['retainedHandoffIdentitySha256'] as string, counts: { uncompactedEvents: counts[0]!, retainedHandoffs: counts[1]!, fullTerminalOperations: counts[3]! + counts[6]! },
      potentialHandoffs: counts[2]! + counts[5]!, unfinishedOperations: counts[4]!, invalidEvents: counts[5]!, pendingOutbox: counts[7]!, freeBytes: BigInt(value['freeBytes']), uncertainWorkspace: value['uncertainWorkspace'] };
  }

  async inventory(deadline?: Deadline, recovering = false, observeOwed?: (owed: Partial<CapacityOwed>) => void): Promise<ResourceObservation> {
    try {
      const observation = await this.observe('Inventory', deadline);
      const operations = await this.operations.list(deadline);
      observeOwed?.({ unfinishedOperations: operations.invalid.length === 0 ? operations.records.filter(entry => effectivelyUnfinished(entry.record)).length : null });
      if (operations.records.some(entry => pendingOperationSafety(entry.record))) { observeOwed?.({ safetyObligation: true }); }
      const active = operations.records.filter(entry => !entry.record.compacted && entry.record.kind === 'repair' && effectivelyUnfinished(entry.record));
      if (active.length > 1) { unavailable('recoveryAuthority'); }
      let recoveryEvents = maximumRecoveryEvents;
      const activeRecord = active[0]?.record;
      if (activeRecord !== undefined && !activeRecord.compacted && activeRecord.kind === 'repair' && activeRecord.recovery.activeEpisode !== null) {
        recoveryEvents = remainingRecoveryPublications(activeRecord);
      }
      const unique = new Map<string, RetainedHandoff>();
      for (const { record } of operations.records) {
        if (record.compacted || record.kind !== 'repair') { continue; }
        for (const handoff of record.plan.handoffs) {
          const key = handoffIdentity(handoff);
          const prior = unique.get(key);
          unique.set(key, prior === undefined ? handoff : mergeHandoff(prior, handoff));
        }
      }
      if (!recovering && operations.invalid.length === 0 && (observation.counts.retainedHandoffs !== unique.size
        || observation.retainedHandoffIdentitySha256 !== handoffIdentityDigest(unique.values()))) { unavailable('inventory'); }
      const complete = recovering ? operations.invalid.every(entry => entry.sha256 !== null) : operations.invalid.length === 0 && observation.invalidEvents === 0;
      deadline?.check();
      return { ...observation, complete, counts: { ...observation.counts, retainedHandoffs: unique.size, fullTerminalOperations: operations.fullTerminalCount + operations.invalid.length },
        potentialHandoffs: Math.max(observation.potentialHandoffs, unique.size), recoveryEvents, activeRepair: active.length > 0,
        unfinishedOperations: operations.records.filter(entry => !entry.record.compacted && entry.record.completedAt === null).length,
        pendingConsumer: operations.records.some(entry => !entry.record.compacted && entry.record.kind !== 'repair' && entry.record.completedAt === null) };
    } catch (error) { if (observeOwed === undefined) { this.invalidate(); } throw error; }
  }

  private async readSafety(deadline?: Deadline): Promise<ReturnType<typeof parseStateSafety>> {
    const target = path.join(this.scope.dataRoot, 'state-safety.json');
    const admitted = await this.inspector.inspect(this.scope.dataRoot, target, false, deadline?.remaining());
    if (admitted.kind !== 'file') { unavailable('stateSafety'); }
    return parseStateSafety(parseStrictJson(await readBoundedFile(target, jsonBudgets.config.maxBytes)), this.scope.bindingSha256);
  }

  async reserve(kind: TransitionReservation['kind'], additions: Partial<ResourceCounts> = {}, deadline?: Deadline): Promise<void> {
    const source = this.source(kind);
    const epoch = this.authorityEpoch;
    this.sources.get(source)!.lease = null;
    this.capacity.invalidateOwed();
    const owedEpoch = this.capacity.epoch;
    const owed: Partial<CapacityOwed> = {};
    const observed = (value: Partial<CapacityOwed>): void => { Object.assign(owed, value); this.capacity.observeOwed(value, owedEpoch); };
    try {
      const inventory = await this.inventory(deadline, kind !== 'ordinary', observed);
      if (kind === 'ordinary') {
        const safety = await this.readSafety(deadline);
        if (safety.pendingCheck !== null || safety.correction !== null) { observed({ safetyObligation: true }); }
      }
      const reservation = completeReservation(kind, inventory, additions);
      if (epoch !== this.authorityEpoch) { this.refuse(new Error('Capacity authority changed.'), null, 'otherAuthority'); }
      if (owedEpoch !== this.capacity.epoch) { unavailable('inventory'); }
      requireCapacity(inventory, reservation);
      this.sources.get(source)!.lease = { source, epoch, reservation, targets: null, newEvents: new Set(), newOperations: new Set() };
      this.capacity.admitted(kind);
    } catch (error) { this.refuse(error, epoch === this.authorityEpoch ? kind : null, 'inventory', owedEpoch === this.capacity.epoch ? owed : {}); }
  }

  async reserveRuntimeMarker(deadline?: Deadline): Promise<void> {
    await this.reserveControls('runtimeMarker', new Set(['runtime.json']), true, deadline);
  }

  private async reserveControls(kind: 'runtimeMarker' | 'ordinary', targets: ReadonlySet<string>, complete: boolean, deadline?: Deadline): Promise<void> {
    const source = this.source(kind);
    const epoch = this.authorityEpoch;
    this.sources.get(source)!.lease = null;
    try {
      const inventory = await this.observe('Marker', deadline);
      const reservation: TransitionReservation = { kind: 'release', additions: zero, remainingControlReserve: zero,
        documents: [...targets].map(name => ({ name, profile: 'config', usage: null })), workspaceBytes: BigInt(jsonBudgets.config.maxBytes) * 3n };
      if (epoch !== this.authorityEpoch) { this.refuse(new Error('Control reservation changed.'), null, 'otherAuthority'); }
      requireCapacity(inventory, reservation);
      this.sources.get(source)!.lease = { source, epoch, reservation, targets, newEvents: new Set(), newOperations: new Set() };
      if (complete) { this.capacity.admitted(kind); }
    } catch (error) { this.refuse(error, epoch === this.authorityEpoch ? kind : null, 'inventory'); }
  }

  async reserveMaintenance(deadline?: Deadline): Promise<void> {
    const source = this.source('maintenance');
    const epoch = this.authorityEpoch;
    this.sources.get(source)!.lease = null;
    this.capacity.invalidateOwed();
    const owedEpoch = this.capacity.epoch;
    const owed: Partial<CapacityOwed> = {};
    const observed = (value: Partial<CapacityOwed>): void => { Object.assign(owed, value); this.capacity.observeOwed(value, owedEpoch); };
    try {
      const inventory = await this.inventory(deadline, true, observed);
      const reservation: TransitionReservation = { kind: 'release', additions: zero, remainingControlReserve: zero,
        documents: [{ name: 'event-compaction', profile: 'state-event', usage: null }, { name: 'operation-compaction', profile: 'state-event', usage: null }],
        workspaceBytes: BigInt(jsonBudgets['state-event'].maxBytes) * 6n + BigInt(jsonBudgets.config.maxBytes) * 3n };
      if (epoch !== this.authorityEpoch || owedEpoch !== this.capacity.epoch) { this.refuse(new Error('Maintenance inventory changed.'), null, 'otherAuthority'); }
      requireCapacity(inventory, reservation);
      this.sources.get(source)!.lease = { source, epoch, reservation, targets: null, newEvents: new Set(), newOperations: new Set() };
      this.capacity.admitted('maintenance');
    } catch (error) { this.refuse(error, epoch === this.authorityEpoch ? 'maintenance' : null, 'inventory', owedEpoch === this.capacity.epoch ? owed : {}); }
  }

  async preflight(target: string, bytes: Readonly<Uint8Array>, profile: JsonProfile, deadline?: Deadline, admit?: AdmitPublicationScope): Promise<void> {
    const lease = this.lease();
    const kind = this.valid(lease) ? lease.source.kind : null;
    try {
      this.invalidatePublication(path.relative(this.scope.dataRoot, target).replaceAll(path.sep, '/'));
      deadline?.check();
      if (!this.valid(lease)) { this.refuse(new Error('Publication owner is stale.'), null, 'otherAuthority'); }
      const reservation = lease.reservation;
      if (bytes.byteLength > jsonBudgets[profile].maxBytes) {
        throw new ProspectiveJsonBudgetError([{ dimension: 'bytes', actual: bytes.byteLength, limit: jsonBudgets[profile].maxBytes }], path.relative(this.scope.dataRoot, target));
      }
      const relative = path.relative(this.scope.dataRoot, target).replaceAll(path.sep, '/');
      if (relative.startsWith('..') || path.isAbsolute(relative) || lease.targets !== null && !lease.targets.has(relative)) { unavailable('publicationScope'); }
      const binding = path.join(this.scope.dataRoot, 'scope.json');
      const admittedBinding = admit === undefined ? await this.inspector.inspect(this.scope.dataRoot, binding, false, deadline?.remaining()) : (await admit(binding))[0]!;
      if (admittedBinding.kind !== 'file' || bytesHash(await readBoundedFile(binding, jsonBudgets.config.maxBytes)) !== this.scope.bindingSha256) { unavailable('scopeAuthority'); }
      const event = relative.startsWith('journal/events/') && eventFileSequence(relative.slice('journal/events/'.length)) !== null;
      const operation = /^operations\/(?:jr|rl|ho)-[a-f0-9]{32}\.json$/.test(relative);
      if (fixedControls.has(relative)) {
        requireControl(profile === 'config'); parseStrictJson(bytes, profile);
        if (relative === 'scope.json' && bytesHash(Buffer.from(bytes)) !== this.scope.bindingSha256) { unavailable('scopeAuthority'); }
      }
      else if (operation) {
        requireControl(profile === 'state-event');
        const record = parseOperation(parseStrictJson(bytes, profile), this.scope.bindingSha256);
        if (!record.compacted) { validateOperationExpansion(record, reservation.additions.uncompactedEvents + reservation.remainingControlReserve.uncompactedEvents); }
      } else if (event || relative === 'journal/recovery-event.json') {
        requireControl(profile === 'state-event');
        const result = await this.inspector.metadata(script, ['-Root', this.scope.dataRoot, '-ScopeSha256', this.scope.bindingSha256, '-Mode', 'Event'], this.scope.dataRoot, deadline?.remaining(), Buffer.from(bytes));
        if (result.exitCode !== 0 || !hasExactKeys(parseStrictJson(result.stdout), ['admitted']) || (parseStrictJson(result.stdout) as { admitted?: unknown }).admitted !== true) { unavailable('eventFinalization'); }
      } else { unavailable('publicationScope'); }
      if (event || operation) {
        let exists = true;
        try { await fs.stat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { exists = false; } else { throw error; } }
        if (!exists) {
          const set = event ? lease!.newEvents : lease!.newOperations;
          set.add(relative);
          const capacity = event ? reservation.additions.uncompactedEvents + reservation.remainingControlReserve.uncompactedEvents : reservation.additions.fullTerminalOperations + reservation.remainingControlReserve.fullTerminalOperations;
          if (set.size > capacity) { unavailable('unreservedAddition'); }
        }
      }
      if (!this.valid(lease)) { this.refuse(new Error('Publication owner changed.'), null, 'otherAuthority'); }
      deadline?.check();
    } catch (error) {
      if (error instanceof PublicationPathAdmissionError) { throw error; }
      this.refuse(error, this.valid(lease) ? kind : null, 'publicationScope');
    }
  }

  async workspace(inputBytes: number, outputBytes: number, deadline?: Deadline): Promise<void> {
    const lease = this.lease();
    const kind = this.valid(lease) ? lease.source.kind : null;
    try {
      deadline?.check();
      if (!this.valid(lease)) { this.refuse(new Error('Workspace owner is stale.'), null, 'otherAuthority'); }
      if ( !Number.isSafeInteger(inputBytes) || !Number.isSafeInteger(outputBytes) || inputBytes < 0 || outputBytes < 0
        || BigInt(inputBytes) + BigInt(outputBytes) > lease.reservation.workspaceBytes) { unavailable('workspace'); }
    } catch (error) { this.refuse(error, this.valid(lease) ? kind : null, 'workspace'); }
  }

  async codec(reservation: CodecReservation, deadline?: Deadline, admit?: AdmitPublicationScope): Promise<void> {
    const lease = this.lease();
    const kind = this.valid(lease) ? lease.source.kind : null;
    try {
      if (!this.valid(lease)) { this.refuse(new Error('Codec owner is stale.'), null, 'otherAuthority'); }
      if (reservation.publication) { this.invalidatePublication(path.relative(this.scope.dataRoot, reservation.target).replaceAll(path.sep, '/')); }
      await this.workspace(reservation.inputBytes + reservation.controlBytes, reservation.maximumOutputBytes, deadline);
      const relative = path.relative(this.scope.dataRoot, reservation.target).replaceAll(path.sep, '/');
      const event = relative.startsWith('journal/events/') && eventFileSequence(relative.slice('journal/events/'.length)) !== null;
      if (lease.targets !== null || (!event && relative !== 'journal/recovery-event.json' && relative !== 'codec.json') || reservation.publication && relative === 'codec.json') { unavailable('codecScope'); }
      const binding = path.join(this.scope.dataRoot, 'scope.json');
      const admitted = admit === undefined ? await this.inspector.inspectMany(this.scope.dataRoot, [binding, reservation.target], true, deadline?.remaining()) : await admit(binding);
      if (admitted[0]!.kind !== 'file' || bytesHash(await readBoundedFile(binding, jsonBudgets.config.maxBytes)) !== this.scope.bindingSha256) { unavailable('scopeAuthority'); }
      if (event && reservation.publication && !admitted[1]!.exists) {
        lease!.newEvents.add(relative);
        if (lease!.newEvents.size > lease.reservation.additions.uncompactedEvents + lease.reservation.remainingControlReserve.uncompactedEvents) { unavailable('unreservedAddition'); }
      }
      if (!this.valid(lease)) { this.refuse(new Error('Codec owner changed.'), null, 'otherAuthority'); }
      deadline?.check();
    } catch (error) {
      if (error instanceof PublicationPathAdmissionError) { throw error; }
      this.refuse(error, this.valid(lease) ? kind : null, 'codecScope');
    }
  }
}
