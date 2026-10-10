import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PathInspector } from '../admission.ts';
import { RuntimeCapacityError, runtimeLimits } from '../capacity.ts';
import { requireControl } from '../control-values.ts';
import type { Deadline } from '../deadline.ts';
import { EventReader } from '../event-reader.ts';
import type { Journal } from '../journal.ts';
import { eventRewriteMetadata, type EventDescription } from '../journal-records.ts';
import { asInteger, hasExactKeys, parseStrictJson, stringifyJson } from '../json.ts';
import { effectivelyUnfinished, operationHasUnresolvedCarryRelease, pendingOperationSafety } from '../operation-records.ts';
import type { OperationStore, StoredOperation } from '../operations.ts';
import type { OutboxReader } from '../outbox.ts';
import { inferMissingAcknowledgement, rangeResolutionTime, type ProvenanceInventory, type SkippedRange } from '../recovery-provenance.ts';
import { carryReleaseResolved } from '../recovery-manifest.ts';
import { selectJournalRetention, utcTicks, type RetentionEvidence } from '../retention.ts';
import type { SafetyStore } from '../safety.ts';
import type { StateSafety } from '../safety-records.ts';
import type { RuntimeScope } from '../scope.ts';
import { parseSessionBinding, parseSessionIndex } from '../session-records.ts';
import type { ScopeStorage } from '../storage.ts';
import type { ResourceAuthority } from './resources.ts';
import { deferredCarryAuthority, hasCarryAuthority, hasProviderAuthority } from '../backend/provider-authority.ts';

const ticksPerDay = 864000000000n;
const resourceScript = fileURLToPath(new URL('../../scripts/resource-lifecycle/Get-ResourceInventory.ps1', import.meta.url));
const identity = (value: { readonly logicalOutboxId: string; readonly recordSha256: string }): string => `${value.logicalOutboxId}:${value.recordSha256}`;
const sameEvent = (left: { readonly journalId: string; readonly eventId: string }, right: { readonly journalId: string; readonly eventId: string }): boolean => left.journalId === right.journalId && left.eventId === right.eventId;
const nowUtc = (): string => new Date().toISOString().replace(/([.][0-9]{3})Z$/, '$10000Z');

export interface RetentionInputs {
  readonly safety: StateSafety;
  readonly operations: readonly StoredOperation[];
  readonly events: readonly EventDescription[];
  readonly outbox: ReadonlySet<string>;
  readonly outboxNames: ReadonlySet<string>;
  readonly sessionGenerations: ReadonlySet<string>;
  readonly carryPresent: boolean;
}

export interface RetentionAuthority {
  readonly provenance: ProvenanceInventory;
  readonly protectedOperations: ReadonlySet<string>;
  readonly protectedQuarantine: ReadonlySet<string>;
  readonly protectedHandoffs: ReadonlySet<string>;
  readonly evidence: (event: EventDescription) => RetentionEvidence;
}

// This graph is built only from complete admitted inventories. Null and stale
// discharge claims remain protections; they cannot be upgraded by cursor position.
export function reconcileRetention(input: RetentionInputs): RetentionAuthority {
  const { safety, operations, events } = input;
  const byId = new Map(operations.map(entry => [entry.record.operationId, entry.record]));
  const journalIdentities = new Set(events.map(identity));
  const eventById = new Map(events.map(event => [`${event.journalId}:${event.eventId}`, event]));
  requireControl(byId.size === operations.length);
  const protectedOperations = new Set<string>();
  const deferred = deferredCarryAuthority({ records: operations, invalid: [], handoffCount: 0, fullTerminalCount: 0 });
  requireControl(deferred.state !== 'unavailable');
  for (const id of deferred.protectedOperations) { protectedOperations.add(id); }
  const protectedQuarantine = new Set<string>();
  const unresolvedIdentities = new Set<string>();
  const unresolvedEvents = new Set<string>();
  const rejectedIdentities = new Set<string>();
  const rangeMap = new Map<string, { range: SkippedRange; owners: Set<string> }>();
  const addRange = (range: SkippedRange, owner: string): void => {
    const key = `${range.journalId}:${range.firstSequence}:${range.lastSequence}:${range.reason}`;
    const prior = rangeMap.get(key);
    if (prior === undefined) { rangeMap.set(key, { range, owners: new Set([owner]) }); return; }
    prior.owners.add(owner);
    if (prior.range.discharge === null && range.discharge !== null) { prior.range = range; }
    else if (prior.range.discharge !== null && range.discharge !== null) {
      requireControl(prior.range.discharge.kind === range.discharge.kind && prior.range.discharge.operationId === range.discharge.operationId
        && prior.range.discharge.episodeOrdinal === range.discharge.episodeOrdinal);
      if (range.discharge.at > prior.range.discharge.at) { prior.range = range; }
    }
  };
  let unresolvedGlobal = safety.pendingCheck !== null || safety.correction !== null && safety.correction.recoveryOperationId === null;
  if (safety.correction?.recoveryOperationId != null) { protectedOperations.add(safety.correction.recoveryOperationId); }
  if (safety.recoveryWitness !== null) {
    protectedOperations.add(safety.recoveryWitness.owner.operationId);
    if (safety.recoveryWitness.successor !== null) { protectedOperations.add(safety.recoveryWitness.successor.operationId); }
    if (safety.recoveryWitness.disclosure !== null) { unresolvedEvents.add(`${safety.recoveryWitness.disclosure.journalId}:${safety.recoveryWitness.disclosure.eventId}`); }
  }
  for (const id of protectedOperations) { if (!byId.has(id) || byId.get(id)!.compacted) { unresolvedGlobal = true; } }
  for (const { record } of operations) {
    if (record.compacted) { continue; }
    if (effectivelyUnfinished(record) || operationHasUnresolvedCarryRelease(record) || pendingOperationSafety(record)) { protectedOperations.add(record.operationId); }
    if (pendingOperationSafety(record)) { unresolvedGlobal = true; }
    if (record.kind !== 'repair') {
      if (record.safety.phase === 'transferred' && record.safety.correctionId === safety.correction?.correctionId) { protectedOperations.add(record.operationId); }
      if (record.kind === 'release') {
        for (const range of record.plan.skippedRanges) { addRange(range, record.operationId); }
        if (effectivelyUnfinished(record)) {
          for (const root of record.plan.unfinishedRepairs) { protectedOperations.add(root.operationId); }
          if (record.plan.witness !== null) {
            protectedOperations.add(record.plan.witness.owner.operationId);
            if (record.plan.witness.successor !== null) { protectedOperations.add(record.plan.witness.successor.operationId); }
          }
        }
      }
      continue;
    }
    if (record.plan.correctionId !== null && record.plan.correctionId === safety.correction?.correctionId) { protectedOperations.add(record.operationId); }
    const protectsPayload = effectivelyUnfinished(record) || operationHasUnresolvedCarryRelease(record) || safety.correction?.recoveryOperationId === record.operationId || safety.recoveryWitness?.owner.operationId === record.operationId;
    if (protectsPayload) {
      for (const event of events) {
        if (record.plan.affected.some(affected => affected.eventId === event.eventId) || record.plan.handoffs.some(handoff => identity(handoff) === identity(event))
          || record.recovery.attempts.some(attempt => attempt.journalEvent !== null && sameEvent(attempt.journalEvent, event))) { unresolvedEvents.add(`${event.journalId}:${event.eventId}`); }
      }
    }
    for (const range of record.plan.skippedRanges) { addRange(range, record.operationId); }
    for (const episode of record.recovery.episodes) { for (const range of episode.prerequisite?.skippedRanges ?? []) { addRange(range, record.operationId); } }
    const obligations = record.recovery.episodes.filter((episode, index) => index === record.recovery.activeEpisode
      || episode.phase !== 'transferred' && episode.prerequisite !== null && !carryReleaseResolved(episode.prerequisite));
    for (const episode of obligations) {
      const prerequisite = episode.prerequisite;
      if (prerequisite === null) { continue; }
      if (prerequisite.carry !== null && input.carryPresent) { protectedOperations.add(record.operationId); }
      for (const action of prerequisite.actions.slice(prerequisite.nextAction)) {
        if (action.kind === 'quarantine') { protectedQuarantine.add(action.target.path); }
      }
    }
    if (record.plan.rejectedRecord !== null && input.outboxNames.has(record.plan.rejectedRecord.name)
      || record.plan.retiredRecords.some(item => input.outboxNames.has(item.name))) { protectedOperations.add(record.operationId); }
    for (const handoff of record.plan.handoffs) {
      const key = identity(handoff);
      const journalReference = journalIdentities.has(key);
      const sessionReference = handoff.acceptance !== null && input.sessionGenerations.has(handoff.acceptance.generation);
      const retained = journalReference || sessionReference || input.outbox.has(key) || effectivelyUnfinished(record)
        || safety.correction?.recoveryOperationId === record.operationId || safety.recoveryWitness?.owner.operationId === record.operationId;
      if (retained) { protectedOperations.add(record.operationId); }
      if (handoff.presentation !== 'replayable') {
        rejectedIdentities.add(key);
        if (effectivelyUnfinished(record) || input.outbox.has(key) || unresolvedGlobal) { unresolvedIdentities.add(key); }
      }
      if (retained && handoff.attemptRef !== null) { protectedOperations.add(handoff.attemptRef.operationId); }
    }
  }

  for (const event of events) {
    if (event.attemptRef !== null) { protectedOperations.add(event.attemptRef.operationId); }
  }
  const ranges = [...rangeMap.values()].map(entry => entry.range);
  for (const { range, owners } of rangeMap.values()) {
    const affected = events.filter(event => event.journalId === range.journalId && event.sequence >= range.firstSequence && event.sequence <= range.lastSequence);
    const proof = range.discharge;
    if (proof === null) { for (const owner of owners) { protectedOperations.add(owner); } continue; }
    const owner = byId.get(proof.operationId);
    requireControl(owner !== undefined && !owner.compacted && owner.completedAt !== null);
    if (proof.kind === 'abandonRelease') {
      requireControl(owner.kind === 'release' && owner.plan.mode === 'abandon' && owner.outcome === 'completed' && owner.plan.result?.owner === 'bridge'
        && owner.plan.completedPhases.includes('dischargesPublished') && owner.plan.completedPhases.includes('complete'));
      requireControl(owner.plan.skippedRanges.some(candidate => candidate.journalId === range.journalId && candidate.firstSequence <= range.firstSequence && candidate.lastSequence >= range.lastSequence
        && candidate.discharge?.kind === 'abandonRelease' && candidate.discharge.operationId === owner.operationId));
    } else {
      requireControl(owner.kind === 'repair' && proof.episodeOrdinal !== null);
      const episode = owner.recovery.episodes[proof.episodeOrdinal];
      const checkpoint = episode?.acceptedRecovery;
      requireControl(episode?.phase === 'completed' && checkpoint !== null && checkpoint !== undefined);
      const disclosed = eventById.get(`${checkpoint.journalId}:${checkpoint.eventId}`);
      requireControl(disclosed !== undefined && disclosed.sequence === checkpoint.sequence && disclosed.acknowledgedAt !== null && disclosed.acceptance !== null && disclosed.settlement !== 'pending');
      requireControl(owner.plan.skippedRanges.some(candidate => candidate.journalId === range.journalId && candidate.firstSequence <= range.firstSequence && candidate.lastSequence >= range.lastSequence
        && candidate.discharge?.kind === 'recoveryAcknowledged' && candidate.discharge.operationId === owner.operationId && candidate.discharge.episodeOrdinal === proof.episodeOrdinal));
    }
    if (affected.length > 0) { for (const owner of owners) { protectedOperations.add(owner); } protectedOperations.add(proof.operationId); }
  }

  // A root needed for a transfer or handoff keeps the complete predecessor proof.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { record } of operations) {
      if (record.compacted || record.kind !== 'repair' || !protectedOperations.has(record.operationId)) { continue; }
      const dependencies = [record.plan.inheritedRecovery?.operationId, ...record.plan.handoffs.map(item => item.attemptRef?.operationId), ...record.recovery.episodes.map(episode => episode.releaseOperationId)];
      for (const dependency of dependencies) {
        if (dependency != null && !protectedOperations.has(dependency)) { protectedOperations.add(dependency); changed = true; }
      }
    }
  }
  if (input.carryPresent && !operations.some(entry => !entry.record.compacted && entry.record.kind === 'repair' && entry.record.recovery.episodes.some(episode => episode.prerequisite?.carry !== null && episode.prerequisite?.carry !== undefined))) {
    unresolvedGlobal = true;
  }
  const provenance: ProvenanceInventory = { status: 'verified', ranges };
  const newestState = events.filter(event => !event.compacted && event.acceptance !== null && event.acceptance.generation === safety.generation && !rejectedIdentities.has(identity(event))).at(-1);
  const protectedHandoffs = new Set<string>();
  for (const { record } of operations) {
    if (!record.compacted && record.kind === 'repair' && protectedOperations.has(record.operationId)) { for (const handoff of record.plan.handoffs) { protectedHandoffs.add(identity(handoff)); } }
  }
  return { provenance, protectedOperations, protectedQuarantine, protectedHandoffs, evidence(event) {
    const skip = rangeResolutionTime(event, provenance);
    const unresolvedRange = ranges.some(range => range.journalId === event.journalId && event.sequence >= range.firstSequence && event.sequence <= range.lastSequence && range.discharge === null);
    if (unresolvedGlobal || unresolvedRange || unresolvedIdentities.has(identity(event)) || unresolvedEvents.has(`${event.journalId}:${event.eventId}`) || newestState !== undefined && sameEvent(event, newestState) || event.settlement === 'pending'
      || event.settlement === 'unknown' && event.acceptance === null) { return { state: 'protected', path: null, resolvedAt: null }; }
    if (skip !== null) { return { state: 'resolved', path: 'skipDischarged', resolvedAt: skip }; }
    if (event.acknowledgedAt !== null && event.acceptance !== null && !rejectedIdentities.has(identity(event))) { return { state: 'resolved', path: 'acknowledged', resolvedAt: event.acknowledgedAt }; }
    return { state: 'protected', path: null, resolvedAt: null };
  } };
}

export function selectOperationRetention(operations: readonly StoredOperation[], protectedIds: ReadonlySet<string>, now: string): readonly StoredOperation[] {
  const terminal = operations.filter(entry => !entry.record.compacted && entry.record.completedAt !== null);
  const eligible = terminal.filter(entry => !protectedIds.has(entry.record.operationId) && !effectivelyUnfinished(entry.record) && !operationHasUnresolvedCarryRelease(entry.record) && !pendingOperationSafety(entry.record))
    .sort((left, right) => left.record.completedAt! < right.record.completedAt! ? -1 : left.record.completedAt! > right.record.completedAt! ? 1 : left.record.operationId < right.record.operationId ? -1 : left.record.operationId > right.record.operationId ? 1 : 0);
  const selected: StoredOperation[] = [];
  const current = utcTicks(now);
  for (const entry of eligible) {
    if (current >= utcTicks(entry.record.completedAt!) + 365n * ticksPerDay || terminal.length - selected.length > runtimeLimits.fullTerminalOperations) { selected.push(entry); }
  }
  return selected;
}

export interface MaintenanceDependencies {
  readonly scope: RuntimeScope;
  readonly inspector: PathInspector;
  readonly storage: ScopeStorage;
  readonly journal: Journal;
  readonly operations: OperationStore;
  readonly safetyStore: SafetyStore;
  readonly resources: ResourceAuthority;
  readonly outbox: OutboxReader;
}

async function currentSessionGenerations(storage: ScopeStorage, generation: string, deadline?: Deadline): Promise<ReadonlySet<string>> {
  const binding = await storage.read('agent-session.json', 'config', parseSessionBinding, deadline);
  const index = await storage.read('agent-session-index.json', 'config', parseSessionIndex, deadline);
  requireControl(binding.status !== 'invalid' && index.status !== 'invalid');
  return new Set([...(binding.status === 'valid' && binding.value.stateGeneration === generation ? [generation] : []),
    ...(index.status === 'valid' ? index.value.sessions.filter(session => session.stateGeneration === generation).map(session => session.stateGeneration) : [])]);
}

async function maintain(deps: MaintenanceDependencies, deadline?: Deadline, options: { readonly reevaluate?: boolean } = {}): Promise<{ compactedEvents: number; compactedOperations: number; removedQuarantine: number }> {
  const safety = await deps.safetyStore.read(deadline);
  const operations = await deps.operations.list(deadline);
  requireControl(safety.status === 'valid' && operations.invalid.length === 0);
  await deps.resources.reserveMaintenance(deadline);
  const generations = await currentSessionGenerations(deps.storage, safety.value.generation, deadline);
  deps.resources.capacity.invalidateOwed(['pendingOutboxRecords']);
  const outboxEpoch = deps.resources.capacity.epoch;
  const names = await deps.outbox.list(deadline);
  const outbox = new Set<string>();
  for (const name of names) {
    const source = await deps.outbox.read(name, deadline);
    requireControl(source.status === 'valid');
    outbox.add(`${source.metadata.logicalOutboxId}:${source.sha256}`);
  }
  deps.resources.capacity.observeOwed({ pendingOutboxRecords: names.length }, outboxEpoch);
  const carry = await deps.inspector.inspect(deps.scope.dataRoot, path.join(deps.scope.dataRoot, 'journal/recovery-event.json'), true, deadline?.remaining());
  requireControl(!carry.exists || carry.kind === 'file');
  let carryHash: string | null = null;
  if (carry.exists) {
    const [observed] = await new EventReader(deps.scope.dataRoot, deps.inspector).read([{ path: carry.path, sequence: 0 }], deadline?.remaining());
    requireControl(observed?.status === 'valid' && !observed.metadata.compacted && operations.records.some(entry => !entry.record.compacted && entry.record.kind === 'repair'
      && entry.record.recovery.episodes.some(episode => episode.prerequisite?.carry?.sha256 === observed.sha256)));
    carryHash = observed.sha256;
  }
  requireControl(hasCarryAuthority(carryHash, operations));
  const snapshot = await deps.journal.read(deadline);
  requireControl(snapshot.fault === null && snapshot.damaged.length === 0 && snapshot.cursor.status === 'valid' && snapshot.header.status === 'valid');
  const inputs: RetentionInputs = { safety: safety.value, operations: operations.records, events: [...snapshot.events.values()].map(event => event.metadata),
    outbox, outboxNames: new Set(names), sessionGenerations: generations, carryPresent: carry.exists };
  const authority = reconcileRetention(inputs);
  const coherent = hasProviderAuthority(safety.value, operations) && hasCarryAuthority(carryHash, operations);
  const safetyDuty = safety.value.pendingCheck !== null || safety.value.correction !== null || deferredCarryAuthority(operations).owner !== null || operations.records.some(entry => pendingOperationSafety(entry.record));
  deps.resources.capacity.observeOwed({ protectedHandoffs: coherent ? authority.protectedHandoffs.size : null,
    historyDisclosure: coherent ? !snapshot.header.value.historyVerified || safety.value.recoveryWitness !== null
      || authority.provenance.status === 'verified' && authority.provenance.ranges.some(range => range.discharge === null) : null,
    safetyObligation: safetyDuty ? true : coherent ? false : null });
  let compactedEvents = 0;
  await deps.journal.transact(async transaction => {
    const current = transaction.snapshot();
    requireControl(current.fault === null && current.cursor.status === 'valid' && current.events.size === snapshot.events.size);
    for (const [sequence, event] of current.events) { requireControl(snapshot.events.get(sequence)?.sha256 === event.sha256); }
    // A durable ordinary cursor write may have preceded interrupted event stamps.
    // Synthetic ranges, discharged or otherwise, never acquire a false stamp.
    for (const event of current.events.values()) {
      const stamp = inferMissingAcknowledgement(event.metadata, current.cursor.value, authority.provenance);
      if (stamp !== null && event.metadata.acknowledgedAt === null && event.metadata.acceptance !== null && event.metadata.settlement !== 'pending'
        && safety.value.pendingCheck === null && safety.value.correction === null && safety.value.recoveryWitness === null
        && !operations.records.some(entry => effectivelyUnfinished(entry.record) || pendingOperationSafety(entry.record)) && !carry.exists) {
        await transaction.rewrite(event, value => ({ ...eventRewriteMetadata(value), acknowledgedAt: stamp }));
      }
    }
    const refreshed = reconcileRetention({ ...inputs, events: [...transaction.snapshot().events.values()].map(event => event.metadata) });
    const selected = selectJournalRetention([...transaction.snapshot().events.values()].map(event => ({ event: event.metadata, sha256: event.sha256, evidence: refreshed.evidence(event.metadata) })), nowUtc(), true);
    for (const selectedEvent of selected.compact) {
      const event = transaction.snapshot().events.get(selectedEvent.event.sequence)!;
      await transaction.rewrite(event, value => ({ ...eventRewriteMetadata(value), compacted: true }));
      compactedEvents++;
    }
  }, deadline);
  let compactedOperations = 0;
  for (const entry of selectOperationRetention(operations.records, authority.protectedOperations, nowUtc())) {
    await deps.operations.compact(entry, async candidate => {
      const current = await deps.safetyStore.read(deadline);
      requireControl(current.status === 'valid' && current.sha256 === safety.sha256);
      return !authority.protectedOperations.has(candidate.operationId) && !effectivelyUnfinished(candidate) && !pendingOperationSafety(candidate);
    }, deadline);
    compactedOperations++;
  }
  deps.resources.capacity.invalidateOwed();
  const removedQuarantine = await trimQuarantine(deps, authority.protectedQuarantine, deadline);
  if (options.reevaluate !== false) { await deps.resources.withTransition('ordinary', () => deps.resources.reserve('ordinary', {}, deadline)); }
  await refreshCapacityOwed(deps, deadline);
  return { compactedEvents, compactedOperations, removedQuarantine };
}

export async function maintainRuntimeStorage(deps: MaintenanceDependencies, deadline?: Deadline, options: { readonly reevaluate?: boolean } = {}): Promise<{ compactedEvents: number; compactedOperations: number; removedQuarantine: number }> {
  try { return await deps.resources.withTransition('maintenance', () => maintain(deps, deadline, options)); }
  catch (error) {
    throw deps.resources.captureFailure(error) ?? error;
  }
}

async function trimQuarantine(deps: MaintenanceDependencies, protectedPaths: ReadonlySet<string>, deadline?: Deadline): Promise<number> {
  await deps.storage.ensureDirectory('quarantine', deadline);
  const control = Buffer.from(stringifyJson([...protectedPaths]), 'utf8');
  const result = await deps.inspector.metadata(resourceScript, ['-Root', deps.scope.dataRoot, '-ScopeSha256', deps.scope.bindingSha256, '-Mode', 'Quarantine'], deps.scope.dataRoot, deadline?.remaining(), control);
  requireControl(result.exitCode === 0);
  const reply = parseStrictJson(result.stdout);
  requireControl(hasExactKeys(reply, ['removed', 'remaining']));
  const removed = asInteger(reply['removed']);
  const remaining = asInteger(reply['remaining']);
  requireControl(removed !== undefined && removed >= 0 && remaining !== undefined && remaining >= 0);
  if (remaining > runtimeLimits.quarantineFiles) { throw new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['quarantineFiles'] }, 'maintenance'); }
  return removed;
}

export async function readOwedOutbox(outbox: OutboxReader, deadline?: Deadline): Promise<{ readonly names: readonly string[]; readonly identities: ReadonlySet<string> }> {
  const names = await outbox.list(deadline);
  const identities = new Set<string>();
  for (const name of names) {
    const source = await outbox.read(name, deadline);
    requireControl(source.status === 'valid');
    const key = source.metadata.logicalOutboxId + ':' + source.sha256;
    requireControl(!identities.has(key)); identities.add(key);
  }
  const after = await outbox.list(deadline);
  requireControl(names.length === after.length && names.every((name, index) => name === after[index]));
  deadline?.check();
  return { names, identities };
}

// Status observation never starts retention, clears a capacity slot, or converts
// an unavailable component to zero. Each independent read may supply only itself.
export async function refreshCapacityOwed(deps: MaintenanceDependencies, deadline?: Deadline): Promise<void> {
  deps.resources.capacity.invalidateOwed();
  const epoch = deps.resources.capacity.epoch;
  let safety: Awaited<ReturnType<SafetyStore['read']>> | null = null;
  let operations: Awaited<ReturnType<OperationStore['list']>> | null = null;
  let snapshot: Awaited<ReturnType<Journal['read']>> | null = null;
  let outbox: Awaited<ReturnType<typeof readOwedOutbox>> | null = null;
  try { safety = await deps.safetyStore.read(deadline); } catch { /* Its component remains unknown. */ }
  try {
    operations = await deps.operations.list(deadline);
    if (operations.invalid.length === 0) {
      deps.resources.capacity.observeOwed({ unfinishedOperations: operations.records.filter(entry => effectivelyUnfinished(entry.record)).length }, epoch);
    }
  } catch { /* Its component remains unknown. */ }
  try {
    snapshot = await deps.journal.read(deadline);
    if (snapshot.fault === null && snapshot.damaged.length === 0 && snapshot.header.status === 'valid' && snapshot.cursor.status === 'valid') {
      const acked = snapshot.cursor.value.lastAckedSequence;
      deps.resources.capacity.observeOwed({ unacknowledgedEvents: [...snapshot.events.values()].filter(event => !event.metadata.compacted && event.metadata.sequence > acked).length }, epoch);
    }
    if (snapshot.header.status === 'valid' && !snapshot.header.value.historyVerified) { deps.resources.capacity.observeOwed({ historyDisclosure: true }, epoch); }
  } catch { /* Its component remains unknown. */ }
  try { outbox = await readOwedOutbox(deps.outbox, deadline); deps.resources.capacity.observeOwed({ pendingOutboxRecords: outbox.names.length }, epoch); }
  catch { /* A forecast or partial listing cannot supply the count. */ }
  if (safety?.status !== 'valid') { return; }
  const duty = safety.value.pendingCheck !== null || safety.value.correction !== null || operations !== null && deferredCarryAuthority(operations).owner !== null
    || operations?.records.some(entry => pendingOperationSafety(entry.record)) === true;
  if (duty) { deps.resources.capacity.observeOwed({ safetyObligation: true }, epoch); }
  if (operations === null || operations.invalid.length !== 0 || snapshot === null || snapshot.fault !== null || snapshot.damaged.length !== 0
    || snapshot.header.status !== 'valid' || snapshot.cursor.status !== 'valid' || outbox === null) { return; }
  try {
    const generations = await currentSessionGenerations(deps.storage, safety.value.generation, deadline);
    const carry = await deps.inspector.inspect(deps.scope.dataRoot, path.join(deps.scope.dataRoot, 'journal/recovery-event.json'), true, deadline?.remaining());
    let carryHash: string | null = null;
    if (carry.exists) {
      requireControl(carry.kind === 'file');
      const [event] = await new EventReader(deps.scope.dataRoot, deps.inspector).read([{ path: carry.path, sequence: 0 }], deadline?.remaining());
      requireControl(event?.status === 'valid' && !event.metadata.compacted); carryHash = event.sha256;
    }
    requireControl(hasCarryAuthority(carryHash, operations) && hasProviderAuthority(safety.value, operations));
    const graph = reconcileRetention({ safety: safety.value, operations: operations.records, events: [...snapshot.events.values()].map(event => event.metadata),
      outbox: outbox.identities, outboxNames: new Set(outbox.names), sessionGenerations: generations, carryPresent: carry.exists });
    deps.resources.capacity.observeOwed({ protectedHandoffs: graph.protectedHandoffs.size, safetyObligation: duty,
      historyDisclosure: !snapshot.header.value.historyVerified || safety.value.recoveryWitness !== null || graph.provenance.status === 'verified' && graph.provenance.ranges.some(range => range.discharge === null) }, epoch);
  } catch { /* Unproved graph relationships remain unknown. */ }
}
