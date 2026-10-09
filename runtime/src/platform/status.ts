import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from '../admission.ts';
import { loadRuntimeConfig, type RuntimeConfig } from '../config.ts';
import { ControlDocumentError, requireControl } from '../control-values.ts';
import { Deadline } from '../deadline.ts';
import { EventReader, type EventRead } from '../event-reader.ts';
import { isOpaqueToken, operationIdPattern } from '../identity.ts';
import { eventFileSequence, JournalDocumentError, parseJournalCursor, parseJournalHeader, type JournalCursor, type JournalHeader } from '../journal-records.ts';
import { hasExactKeys, jsonBudgets, parseStrictJson, readBoundedFile, StrictJsonError, utcNow, type JsonProfile, type JsonValue } from '../json.ts';
import { effectivelyUnfinished, parseOperation, pendingOperationSafety, type OperationRecord } from '../operation-records.ts';
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
  readonly stateSafety: { readonly state: 'ready' | 'recovering' | 'unavailable'; readonly record: StatusDocument<StateSafety>; readonly pendingOperationSafety: boolean };
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

interface Observation { readonly profile: JsonProfile; readonly hash: string | null }

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
    const target = path.join(this.scope.dataRoot, relative);
    const admission = await this.inspector.inspect(this.scope.dataRoot, target, true, this.deadline.remaining());
    if (!admission.exists) { this.observations.set(relative, { profile, hash: null }); return { status: 'absent' }; }
    if (admission.kind !== 'file') { throw new DataRootUnavailableError('Runtime status document has an unsupported object kind.'); }
    try {
      const bytes = await readBoundedFile(target, jsonBudgets[profile].maxBytes);
      this.observations.set(relative, { profile, hash: bytesHash(bytes) });
      return { status: 'valid', value: parse(parseStrictJson(bytes, profile)) };
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
    for (let offset = 0; offset < names.length; offset += 64) {
      const observations = await this.inspector.inspectMany(this.scope.dataRoot, names.slice(offset, offset + 64).map(name => path.join(directory, name)), false, this.deadline.remaining());
      if (observations.some(item => item.kind !== 'file')) { throw new DataRootUnavailableError('Runtime status inventory contains an unsupported object.'); }
    }
    return names.filter(name => !isPublicationResidue(path.join(relative, name)));
  }

  async unchanged(): Promise<boolean> {
    await this.binding();
    for (const [relative, observation] of this.observations) {
      const target = path.join(this.scope.dataRoot, relative);
      const admitted = await this.inspector.inspect(this.scope.dataRoot, target, true, this.deadline.remaining());
      if (!admitted.exists) { if (observation.hash !== null) { return false; } continue; }
      if (admitted.kind !== 'file') { throw new DataRootUnavailableError('Runtime status document changed object kind.'); }
      try { if (bytesHash(await readBoundedFile(target, jsonBudgets[observation.profile].maxBytes)) !== observation.hash) { return false; } }
      catch { return false; }
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

export async function readAdmittedRuntimeStatus(scope: RuntimeScope, inspector: PathInspector, config: RuntimeConfig, deadline = Deadline.after(120000)): Promise<StandaloneRuntimeStatus> {
  const reader = new StatusReader(scope, inspector, deadline);
  await reader.binding();
  const runtime = await reader.read('runtime.json', 'config', parseRuntimeRecord);
  const safety = await reader.read('state-safety.json', 'config', value => parseStateSafety(value, scope.bindingSha256));
  const session = await reader.read('agent-session.json', 'config', parseSessionBinding);
  const header = await reader.read('journal/journal.json', 'config', parseJournalHeader);
  const cursor = await reader.read('journal/cursor-agent-session.json', 'config', parseJournalCursor);
  const operations: OperationStatus[] = [];
  const unavailable: string[] = [];
  for (const name of await reader.list('operations')) {
    if (!name.endsWith('.json') || !operationIdPattern.test(name.slice(0, -5))) { unavailable.push(name); continue; }
    const result = await reader.read(`operations/${name}`, 'state-event', value => {
      const record = parseOperation(value, scope.bindingSha256);
      requireControl(record.operationId === name.slice(0, -5));
      return record;
    });
    if (result.status !== 'valid') { unavailable.push(name); continue; }
    const record = result.value;
    operations.push({ operationId: record.operationId, kind: record.kind, cause: record.cause, outcome: record.outcome,
      effectivelyUnfinished: effectivelyUnfinished(record), pendingSafety: pendingOperationSafety(record) });
  }
  const names = await reader.list('journal/events');
  const targets = names.map(name => ({ path: path.join(scope.dataRoot, 'journal', 'events', name), sequence: eventFileSequence(name) }));
  const eventReader = new EventReader(scope.dataRoot, inspector);
  const events = await eventReader.readInventory(targets.filter((item): item is { path: string; sequence: number } => item.sequence !== null), deadline);
  const unknown: EventRead[] = targets.filter(item => item.sequence === null).map(item => ({ path: item.path, status: 'invalid', sha256: null }));
  let stable = await reader.unchanged();
  if (stable && events.length > 0) {
    const current = await eventReader.readInventory(targets.filter((item): item is { path: string; sequence: number } => item.sequence !== null), deadline);
    stable = current.length === events.length && current.every((item, index) => item.status === events[index]!.status && item.sha256 === events[index]!.sha256);
  }
  const pendingSafety = unavailable.length > 0 || operations.some(operation => operation.pendingSafety);
  const ready = safety.status === 'valid' && safety.value.pendingCheck === null && safety.value.correction === null && safety.value.recoveryWitness === null && !pendingSafety;
  const journal = summarizeJournal(header, cursor, [...events, ...unknown], scope.game, scope.principal, operations, unavailable);
  return { mode: 'readOnly', initialized: true, observedAt: utcNow(), consistency: stable ? 'stable' : 'changedDuringRead', config, runtime,
    journal: stable ? journal : { ...journal, state: 'unavailable', integrity: 'unavailable', historyVerified: null, unacknowledgedEvents: null },
    stateSafety: { state: !stable || safety.status !== 'valid' ? 'unavailable' : ready ? 'ready' : 'recovering', record: safety, pendingOperationSafety: pendingSafety },
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
      stateSafety: { state: 'unavailable', record: absent, pendingOperationSafety: false }, agentSession: absent, operations: { records: [], unavailable: [] }, ...volatile };
  } finally { await inspection.close(); }
}
