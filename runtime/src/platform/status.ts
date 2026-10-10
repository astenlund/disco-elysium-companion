import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, maximumPathAdmissionBatchEntries, maximumPathAdmissionControlBytes, type PathAdmission, type PathInspector } from '../admission.ts';
import { deferredCarryAuthority, hasCarryAuthority, hasSafetyRecordAuthority, type CarryReleaseStatus } from '../backend/provider-authority.ts';
import { loadRuntimeConfig, type RuntimeConfig } from '../config.ts';
import { ControlDocumentError, requireControl } from '../control-values.ts';
import { Deadline } from '../deadline.ts';
import { EventReader, type EventRead } from '../event-reader.ts';
import { isOpaqueToken, operationIdPattern } from '../identity.ts';
import { eventFileSequence, JournalDocumentError, parseJournalCursor, parseJournalHeader, type JournalCursor, type JournalHeader } from '../journal-records.ts';
import { hasExactKeys, jsonBudgets, parseStrictJson, readBoundedFile, StrictJsonError, utcNow, type JsonProfile, type JsonValue } from '../json.ts';
import { effectivelyUnfinished, parseOperation, pendingOperationSafety, type OperationRecord } from '../operation-records.ts';
import type { OperationInventory } from '../operations.ts';
import { carryReleaseState } from '../recovery-manifest.ts';
import { createReadOnlyInspection } from '../read-only-inspection.ts';
import { parseRuntimeRecord, type RuntimeRecord } from '../runtime-records.ts';
import { parseStateSafety, SafetyUnavailableError, type StateSafety } from '../safety-records.ts';
import { discoverScope, readScope, type RuntimeScope } from '../scope.ts';
import { parseSessionBinding, type AgentSessionBinding } from '../session-records.ts';
import { bytesHash } from '../storage.ts';
import { isPublicationResidue } from './publication-residue.ts';

export type StatusDocument<T> = { readonly status: 'absent' | 'invalid' | 'unreadable' } | { readonly status: 'valid'; readonly value: T };
export interface OperationStatus {
  readonly operationId: string;
  readonly kind: OperationRecord['kind'];
  readonly cause: OperationRecord['cause'];
  readonly outcome: OperationRecord['outcome'];
  readonly effectivelyUnfinished: boolean;
  readonly pendingSafety: boolean;
  readonly carryRelease: CarryReleaseStatus;
}
export interface JournalStatus {
  readonly state: 'healthy' | 'repairing' | 'fault' | 'unavailable' | 'notInitialized';
  readonly fault: 'repairFailed' | null;
  readonly integrity: 'valid' | 'header' | 'cursor' | 'gap' | 'unavailable';
  readonly historyVerified: boolean | null;
  readonly unacknowledgedEvents: number | null;
  readonly retainedEvents: number;
  readonly unrecordedEvent: boolean;
}
export interface StandaloneRuntimeStatus {
  readonly mode: 'readOnly';
  readonly initialized: boolean;
  readonly observedAt: string;
  readonly consistency: 'stable' | 'changedDuringRead';
  readonly config: RuntimeConfig;
  readonly runtime: StatusDocument<RuntimeRecord>;
  readonly journal: JournalStatus;
  readonly stateSafety: { readonly state: 'ready' | 'recovering' | 'unavailable'; readonly record: StatusDocument<StateSafety>; readonly pendingOperationSafety: boolean; readonly carryRelease: CarryReleaseStatus };
  readonly agentSession: StatusDocument<AgentSessionBinding>;
  readonly operations: { readonly records: readonly OperationStatus[]; readonly unavailable: readonly string[] };
  readonly consumer: 'unavailable';
  readonly freshness: 'unavailable';
  readonly operational: 'unavailable';
  readonly watcher: 'unavailable';
  readonly provider: 'unavailable';
  readonly windowRecovery: 'unavailable';
  readonly capacity: 'unavailable';
  readonly liveStateNotice: string;
}

const principalScript = fileURLToPath(new URL('../../scripts/Get-Principal.ps1', import.meta.url));
const volatile = Object.freeze({ consumer: 'unavailable', freshness: 'unavailable', operational: 'unavailable', watcher: 'unavailable', provider: 'unavailable', windowRecovery: 'unavailable', capacity: 'unavailable',
  liveStateNotice: 'Consumer, freshness, operational warnings, watcher, provider, window recovery and capacity state are available only in the running chat client.' } as const);

export class StatusIdentityError extends Error { override readonly name = 'StatusIdentityError'; readonly code = 'identityUnavailable'; }

export function summarizeCarryStatus(safety: StatusDocument<StateSafety>, inventory: OperationInventory, carryHash: string | null | undefined): CarryReleaseStatus {
  if (safety.status !== 'valid' || carryHash === undefined || !hasSafetyRecordAuthority(safety.value, inventory) || !hasCarryAuthority(carryHash, inventory)) { return 'unavailable'; }
  return deferredCarryAuthority(inventory).state;
}

interface Observation { readonly profile: JsonProfile; readonly hash: string | null }

function admissionBatches(targets: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const target of targets) {
    const expanded = [...batch, target];
    if (batch.length === maximumPathAdmissionBatchEntries || Buffer.byteLength(JSON.stringify(expanded), 'utf8') > maximumPathAdmissionControlBytes) {
      if (batch.length === 0) { throw new DataRootUnavailableError('Path admission target exceeds its control budget.'); }
      batches.push(batch);
      batch = [target];
    } else { batch = expanded; }
    if (Buffer.byteLength(JSON.stringify(batch), 'utf8') > maximumPathAdmissionControlBytes) {
      throw new DataRootUnavailableError('Path admission target exceeds its control budget.');
    }
  }
  if (batch.length > 0) { batches.push(batch); }
  return batches;
}

class StatusReader {
  private readonly scope: RuntimeScope;
  private readonly inspector: PathInspector;
  private readonly deadline: Deadline;
  private readonly observations = new Map<string, Observation>();
  private readonly inventories = new Map<string, readonly string[]>();

  constructor(scope: RuntimeScope, inspector: PathInspector, deadline: Deadline) { this.scope = scope; this.inspector = inspector; this.deadline = deadline; }

  async binding(): Promise<void> {
    const target = path.join(this.scope.dataRoot, 'scope.json');
    const admission = await this.inspector.inspect(this.scope.dataRoot, target, false, this.deadline.remaining());
    if (admission.kind !== 'file' || bytesHash(await readBoundedFile(target, jsonBudgets.config.maxBytes)) !== this.scope.bindingSha256) {
      throw new DataRootUnavailableError('Read-only status lost its immutable scope binding.');
    }
  }

  async read<T>(relative: string, profile: JsonProfile, parse: (value: JsonValue) => T): Promise<StatusDocument<T>> {
    return (await this.readMany([relative], profile, parse))[0]!;
  }

  async readMany<T>(relatives: readonly string[], profile: JsonProfile, parse: (value: JsonValue, relative: string) => T): Promise<readonly StatusDocument<T>[]> {
    const documents: StatusDocument<T>[] = [];
    let offset = 0;
    for (const targets of admissionBatches(relatives.map(relative => path.join(this.scope.dataRoot, relative)))) {
      const admissions = await this.inspector.inspectMany(this.scope.dataRoot, targets, true, this.deadline.remaining());
      for (const admission of admissions) { documents.push(await this.readAdmitted(relatives[offset++]!, profile, parse, admission)); }
    }
    return documents;
  }

  private async readAdmitted<T>(relative: string, profile: JsonProfile, parse: (value: JsonValue, relative: string) => T,
    admission: PathAdmission): Promise<StatusDocument<T>> {
    const target = path.join(this.scope.dataRoot, relative);
    if (!admission.exists) { this.observations.set(relative, { profile, hash: null }); return { status: 'absent' }; }
    if (admission.kind !== 'file') { throw new DataRootUnavailableError('Runtime status document has an unsupported object kind.'); }
    try {
      const bytes = await readBoundedFile(target, jsonBudgets[profile].maxBytes);
      this.observations.set(relative, { profile, hash: bytesHash(bytes) });
      return { status: 'valid', value: parse(parseStrictJson(bytes, profile), relative) };
    } catch (error) {
      if (error instanceof StrictJsonError || error instanceof ControlDocumentError || error instanceof JournalDocumentError || error instanceof SafetyUnavailableError) { return { status: 'invalid' }; }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.observations.set(relative, { profile, hash: null }); return { status: 'absent' }; }
      return { status: 'unreadable' };
    }
  }

  async list(relative: string): Promise<readonly string[]> {
    const directory = path.join(this.scope.dataRoot, relative);
    const admitted = await this.inspector.inspect(this.scope.dataRoot, directory, true, this.deadline.remaining());
    if (!admitted.exists) { this.inventories.set(relative, []); return []; }
    if (admitted.kind !== 'directory') { throw new DataRootUnavailableError('Runtime status inventory has an unsupported object kind.'); }
    const names: string[] = [];
    for await (const entry of await fs.opendir(directory)) {
      this.deadline.check();
      if (names.length >= 65536) { throw new DataRootUnavailableError('Runtime status inventory exceeds its discovery bound.'); }
      names.push(entry.name);
    }
    names.sort();
    this.inventories.set(relative, names);
    const needsSeparateAdmission = relative === 'journal/events' ? names.filter(name => eventFileSequence(name) === null) : names;
    for (const targets of admissionBatches(needsSeparateAdmission.map(name => path.join(directory, name)))) {
      const observations = await this.inspector.inspectMany(this.scope.dataRoot, targets, false, this.deadline.remaining());
      if (observations.some(item => item.kind !== 'file')) { throw new DataRootUnavailableError('Runtime status inventory contains an unsupported object.'); }
    }
    return names.filter(name => !isPublicationResidue(path.join(relative, name)));
  }

  async unchanged(): Promise<boolean> {
    await this.binding();
    const observed = [...this.observations];
    let offset = 0;
    for (const targets of admissionBatches(observed.map(([relative]) => path.join(this.scope.dataRoot, relative)))) {
      const admissions = await this.inspector.inspectMany(this.scope.dataRoot, targets, true, this.deadline.remaining());
      for (const admitted of admissions) {
        const [relative, observation] = observed[offset++]!;
        const target = path.join(this.scope.dataRoot, relative);
        if (!admitted.exists) { if (observation.hash !== null) { return false; } continue; }
        if (admitted.kind !== 'file') { throw new DataRootUnavailableError('Runtime status document changed object kind.'); }
        try { if (bytesHash(await readBoundedFile(target, jsonBudgets[observation.profile].maxBytes)) !== observation.hash) { return false; } }
        catch { return false; }
      }
    }
    const previous = [...this.inventories];
    for (const [relative, names] of previous) {
      await this.list(relative);
      const next = this.inventories.get(relative)!;
      if (names.length !== next.length || names.some((name, index) => next[index] !== name)) { return false; }
    }
    return true;
  }
}

export function summarizeJournal(header: StatusDocument<JournalHeader>, cursor: StatusDocument<JournalCursor>, events: readonly EventRead[],
  game: string, principal: string, operations: readonly OperationStatus[], unavailableOperations: readonly string[]): JournalStatus {
  const historyVerified = header.status === 'valid' ? header.value.historyVerified : null;
  const empty: JournalStatus = { state: 'unavailable', fault: null, integrity: 'unavailable', historyVerified, unacknowledgedEvents: null, retainedEvents: events.length, unrecordedEvent: false };
  if (header.status === 'unreadable' || cursor.status === 'unreadable') { return empty; }
  if (header.status === 'absent' && cursor.status === 'absent' && events.length === 0 && operations.length === 0 && unavailableOperations.length === 0) { return { ...empty, state: 'notInitialized' }; }
  if (header.status !== 'valid') { return { ...empty, state: 'fault', fault: 'repairFailed', integrity: 'header' }; }
  if (cursor.status !== 'valid' || cursor.value.journalId !== header.value.journalId || cursor.value.lastAckedSequence > header.value.highWaterSequence || cursor.value.lastSentSequence > header.value.highWaterSequence) {
    return { ...empty, state: 'fault', fault: 'repairFailed', integrity: 'cursor' };
  }
  const sorted = [...events].sort((left, right) => left.status === 'valid' && right.status === 'valid' ? left.metadata.sequence - right.metadata.sequence : 0);
  const ids = new Set<string>();
  const logicalIds = new Set<string>();
  let expected = cursor.value.lastAckedSequence + 1;
  let unrecordedEvent = false;
  for (const result of sorted) {
    if (result.status !== 'valid') { return { ...empty, state: 'fault', fault: 'repairFailed', integrity: 'gap' }; }
    const event = result.metadata;
    if (event.journalId !== header.value.journalId || event.adapter !== game || event.principal !== principal || ids.has(event.eventId) || logicalIds.has(event.logicalOutboxId)) {
      return { ...empty, state: 'fault', fault: 'repairFailed', integrity: 'gap' };
    }
    ids.add(event.eventId); logicalIds.add(event.logicalOutboxId);
    if (event.sequence <= cursor.value.lastAckedSequence) { continue; }
    if (event.sequence !== expected || event.compacted || event.sequence > header.value.highWaterSequence + 1) { return { ...empty, state: 'fault', fault: 'repairFailed', integrity: 'gap' }; }
    expected++;
    if (event.sequence === header.value.highWaterSequence + 1) { unrecordedEvent = true; }
  }
  if (expected <= header.value.highWaterSequence) { return { ...empty, state: 'fault', fault: 'repairFailed', integrity: 'gap' }; }
  const repairing = operations.some(operation => operation.kind === 'repair' && operation.effectivelyUnfinished);
  return { ...empty, state: unavailableOperations.length > 0 ? 'fault' : repairing ? 'repairing' : 'healthy', fault: unavailableOperations.length > 0 || repairing ? 'repairFailed' : null,
    integrity: 'valid', unacknowledgedEvents: header.value.highWaterSequence - cursor.value.lastAckedSequence + (unrecordedEvent ? 1 : 0), unrecordedEvent };
}

export async function readAdmittedRuntimeStatus(scope: RuntimeScope, inspector: PathInspector, config: RuntimeConfig, deadline = Deadline.after(3_600_000)): Promise<StandaloneRuntimeStatus> {
  const reader = new StatusReader(scope, inspector, deadline);
  await reader.binding();
  const runtime = await reader.read('runtime.json', 'config', parseRuntimeRecord);
  const safety = await reader.read('state-safety.json', 'config', value => parseStateSafety(value, scope.bindingSha256));
  const session = await reader.read('agent-session.json', 'config', parseSessionBinding);
  const header = await reader.read('journal/journal.json', 'config', parseJournalHeader);
  const cursor = await reader.read('journal/cursor-agent-session.json', 'config', parseJournalCursor);
  const operations: OperationStatus[] = [];
  const operationRecords: { record: OperationRecord; sha256: string }[] = [];
  const unavailable: string[] = [];
  const operationNames = await reader.list('operations');
  const admittedNames = operationNames.filter(name => name.endsWith('.json') && operationIdPattern.test(name.slice(0, -5)));
  const documents = await reader.readMany(admittedNames.map(name => `operations/${name}`), 'state-event', (value, relative) => {
    const record = parseOperation(value, scope.bindingSha256);
    requireControl(record.operationId === path.basename(relative, '.json'));
    return record;
  });
  let documentIndex = 0;
  for (const name of operationNames) {
    if (!name.endsWith('.json') || !operationIdPattern.test(name.slice(0, -5))) { unavailable.push(name); continue; }
    const result = documents[documentIndex++]!;
    if (result.status !== 'valid') { unavailable.push(name); continue; }
    const record = result.value;
    operationRecords.push({ record, sha256: '' });
    const carryStates = record.compacted || record.kind !== 'repair' ? [] : record.recovery.episodes.filter(episode => episode.phase !== 'transferred').map(episode => carryReleaseState(episode.prerequisite));
    operations.push({ operationId: record.operationId, kind: record.kind, cause: record.cause, outcome: record.outcome,
      effectivelyUnfinished: effectivelyUnfinished(record), pendingSafety: pendingOperationSafety(record),
      carryRelease: carryStates.includes('pendingCleanup') ? 'pendingCleanup' : carryStates.includes('waitingReplacement') ? 'waitingReplacement' : carryStates.includes('resolved') ? 'resolved' : 'none' });
  }
  const names = await reader.list('journal/events');
  const targets = names.map(name => ({ path: path.join(scope.dataRoot, 'journal', 'events', name), sequence: eventFileSequence(name) }));
  const eventReader = new EventReader(scope.dataRoot, inspector);
  const carryPath = path.join(scope.dataRoot, 'journal/recovery-event.json');
  const observeCarry = async (): Promise<string | null> => {
    const admitted = await inspector.inspect(scope.dataRoot, carryPath, true, deadline.remaining());
    if (!admitted.exists) { return null; }
    requireControl(admitted.kind === 'file');
    const [carry] = await eventReader.read([{ path: carryPath, sequence: 0 }], deadline.remaining());
    requireControl(carry?.status === 'valid' && !carry.metadata.compacted);
    return carry.sha256;
  };
  const carryInventory = { records: operationRecords, invalid: unavailable.map(name => ({ name, sha256: null })), handoffCount: 0, fullTerminalCount: 0 };
  const deferred = deferredCarryAuthority(carryInventory);
  let carryStatus: CarryReleaseStatus = 'unavailable';
  let carryHash: string | null | undefined;
  try {
    carryHash = await observeCarry();
    carryStatus = summarizeCarryStatus(safety, carryInventory, carryHash);
  } catch { /* Unreadable or unbound slot authority cannot report clean cleanup. */ }
  const events = await eventReader.readInventory(targets.filter((item): item is { path: string; sequence: number } => item.sequence !== null), deadline);
  const unknown: EventRead[] = targets.filter(item => item.sequence === null).map(item => ({ path: item.path, status: 'invalid', sha256: null }));
  let stable = await reader.unchanged();
  if (carryHash !== undefined) {
    try { stable = stable && await observeCarry() === carryHash; }
    catch { stable = false; }
  }
  if (stable && events.length > 0) {
    const current = await eventReader.readInventory(targets.filter((item): item is { path: string; sequence: number } => item.sequence !== null), deadline);
    stable = current.length === events.length && current.every((item, index) => item.status === events[index]!.status && item.sha256 === events[index]!.sha256);
  }
  const pendingSafety = unavailable.length > 0 || operations.some(operation => operation.pendingSafety);
  const ready = safety.status === 'valid' && safety.value.pendingCheck === null && safety.value.correction === null && safety.value.recoveryWitness === null && !pendingSafety && deferred.owner === null;
  const journal = summarizeJournal(header, cursor, [...events, ...unknown], scope.game, scope.principal, operations, unavailable);
  return { mode: 'readOnly', initialized: true, observedAt: utcNow(), consistency: stable ? 'stable' : 'changedDuringRead', config, runtime,
    journal: stable ? journal : { ...journal, state: 'unavailable', integrity: 'unavailable', historyVerified: null, unacknowledgedEvents: null },
    stateSafety: { state: !stable || safety.status !== 'valid' || carryStatus === 'unavailable' ? 'unavailable' : ready ? 'ready' : 'recovering', record: safety, pendingOperationSafety: pendingSafety,
      carryRelease: stable ? carryStatus : 'unavailable' },
    agentSession: session, operations: { records: operations, unavailable }, ...volatile };
}

export async function readRuntimeStatus(companionRoot: string): Promise<StandaloneRuntimeStatus> {
  const config = await loadRuntimeConfig(path.join(companionRoot, 'runtime', 'companion.config.json'));
  const inspection = await createReadOnlyInspection(companionRoot);
  try {
    let principal: string;
    try {
      const result = await inspection.inspector.metadata(principalScript, [], companionRoot);
      const value = parseStrictJson(result.stdout);
      if (result.exitCode !== 0 || !hasExactKeys(value, ['sid']) || !isOpaqueToken(value['sid'])) { throw new StatusIdentityError('Windows principal is unavailable.'); }
      principal = value['sid'];
    } catch { throw new StatusIdentityError('Windows principal is unavailable.'); }
    const candidate = await discoverScope(inspection.inspector, companionRoot, config.game, principal);
    const scope = await readScope(inspection.inspector, candidate);
    if (scope !== null) { return await readAdmittedRuntimeStatus(scope, inspection.inspector, config); }
    const absent = { status: 'absent' } as const;
    return { mode: 'readOnly', initialized: false, observedAt: utcNow(), consistency: 'stable', config, runtime: absent,
      journal: { state: 'notInitialized', fault: null, integrity: 'unavailable', historyVerified: null, unacknowledgedEvents: null, retainedEvents: 0, unrecordedEvent: false },
      stateSafety: { state: 'unavailable', record: absent, pendingOperationSafety: false, carryRelease: 'unavailable' }, agentSession: absent, operations: { records: [], unavailable: [] }, ...volatile };
  } finally { await inspection.close(); }
}
