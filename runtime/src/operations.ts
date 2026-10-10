import type { Deadline } from './deadline.ts';
import { controlHash, requireControl } from './control-values.ts';
import { parseStrictJson, stringifyJson, stringifyProspectiveJson, type ProspectiveJsonFailure } from './json.ts';
import { effectivelyUnfinished, parseOperation, pendingOperationSafety, type CompactOperation, type FullOperation, type OperationRecord, type RepairOperation } from './operation-records.ts';
import { carryReleaseResolved } from './recovery-manifest.ts';
import { isRepairOperationId } from './safety-records.ts';
import { ScopeStorage, type StoredDocument } from './storage.ts';
import { SerialQueue } from './serial.ts';

export interface StoredOperation { readonly record: OperationRecord; readonly sha256: string }
export interface OperationInventory { readonly records: readonly StoredOperation[]; readonly invalid: readonly { readonly name: string; readonly sha256: string | null }[]; readonly handoffCount: number; readonly fullTerminalCount: number }

function serialize(value: unknown): string { return stringifyJson(value, 'state-event'); }
function equal(left: unknown, right: unknown): boolean { return serialize(left) === serialize(right); }
function fileName(id: string): string {
  requireControl(typeof id === 'string' && ['jr-', 'rl-', 'ho-'].includes(id.slice(0, 3)));
  controlHash(id.slice(3), 32);
  return `${id}.json`;
}

export function validateOperationTransition(previous: FullOperation, next: FullOperation): void {
  for (const field of ['operationVersion', 'operationId', 'scopeSha256', 'kind', 'cause', 'startedAt'] as const) { requireControl(previous[field] === next[field]); }
  if (previous.completedAt !== null) { requireControl(previous.completedAt === next.completedAt && previous.outcome === next.outcome); }
  if (previous.kind !== 'repair') {
    requireControl(next.kind !== 'repair' && previous.safety.obligationId === next.safety.obligationId);
    if (previous.safety.phase === 'transferred') { requireControl(next.safety.phase === 'transferred' && previous.safety.correctionId === next.safety.correctionId); }
    if (previous.safety.phase === 'discharged') { requireControl(next.safety.phase === 'discharged'); }
    requireControl(previous.plan.completedPhases.every(phase => (next.plan.completedPhases as readonly string[]).includes(phase)));
    if (previous.plan.result !== null) { requireControl(equal(previous.plan.result, next.plan.result)); }
    if (previous.kind === 'release') {
      requireControl(next.kind === 'release' && previous.plan.mode === next.plan.mode);
      if (previous.plan.journalId !== null) { requireControl(next.plan.journalId === previous.plan.journalId); }
      requireControl(previous.plan.abandonedSequences.every(sequence => next.plan.abandonedSequences.includes(sequence)));
      for (const range of previous.plan.skippedRanges) {
        requireControl(next.plan.skippedRanges.some(item => item.journalId === range.journalId && item.firstSequence === range.firstSequence && item.lastSequence === range.lastSequence && item.reason === range.reason && (range.discharge === null || equal(range.discharge, item.discharge))));
      }
    }
    return;
  }
  requireControl(next.kind === 'repair' && next.recovery.attempts.length >= previous.recovery.attempts.length && next.recovery.episodes.length >= previous.recovery.episodes.length);
  if (previous.plan.correctionId !== null) { requireControl(next.plan.correctionId === previous.plan.correctionId); }
  if (previous.plan.inheritedRecovery !== null) { requireControl(equal(previous.plan.inheritedRecovery, next.plan.inheritedRecovery)); }
  for (const handoff of previous.plan.handoffs) {
    const retained = next.plan.handoffs.find(item => item.logicalOutboxId === handoff.logicalOutboxId && item.recordSha256 === handoff.recordSha256);
    requireControl(retained !== undefined && retained.journalId === handoff.journalId && retained.eventId === handoff.eventId && retained.coreRepairOperationId === handoff.coreRepairOperationId);
    if (handoff.payloadBindingSha256 !== null) { requireControl(retained.payloadBindingSha256 === handoff.payloadBindingSha256); }
    if (handoff.attemptRef !== null) { requireControl(equal(retained.attemptRef, handoff.attemptRef)); }
    if (handoff.presentation !== 'replayable') { requireControl(retained.presentation !== 'replayable'); }
    if (handoff.presentation === 'rejected') { requireControl(retained.presentation === 'rejected'); }
    if (handoff.acceptance !== null) { requireControl(retained.acceptance !== null && retained.acceptance.journalId === handoff.acceptance.journalId && retained.acceptance.eventId === handoff.acceptance.eventId); }
  }
  for (const [index, attempt] of previous.recovery.attempts.entries()) {
    const updated = next.recovery.attempts[index]!;
    if (attempt.selectedRecord !== null) {
      requireControl(updated.selectedRecord !== null);
      if (attempt.selectedRecord.logicalOutboxId !== updated.selectedRecord.logicalOutboxId) {
        requireControl(attempt.selectedRecord.recordSha256 !== null && next.plan.handoffs.some(item => item.logicalOutboxId === attempt.selectedRecord!.logicalOutboxId && item.recordSha256 === attempt.selectedRecord!.recordSha256));
      } else if (attempt.selectedRecord.recordSha256 !== null) { requireControl(updated.selectedRecord.recordSha256 === attempt.selectedRecord.recordSha256); }
    }
  }
  for (const [index, episode] of previous.recovery.episodes.entries()) {
    const updated = next.recovery.episodes[index]!;
    requireControl(updated.activationId === episode.activationId && updated.trigger === episode.trigger && updated.startedAt === episode.startedAt && updated.attemptAtStart === episode.attemptAtStart);
    if (episode.replacementAttempt !== null) { requireControl(updated.replacementAttempt === episode.replacementAttempt); }
    if (episode.endedAt !== null) { requireControl(equal(episode, updated)); }
    const prerequisite = episode.prerequisite;
    if (episode.endedAt === null && prerequisite?.carryRelease != null && !carryReleaseResolved(prerequisite)) {
      const destination = updated.phase === 'transferred' ? next.recovery.episodes[updated.successorEpisode!]! : updated;
      const carried = destination.prerequisite;
      requireControl(carried?.carryRelease != null && equal(carried.carry, prerequisite.carry));
      if (!equal(carried.carryRelease, prerequisite.carryRelease)) {
        const target = carried.carryRelease.attemptRef;
        requireControl(target.operationId === next.operationId && target.attemptOrdinal >= previous.recovery.attempts.length
          && destination.replacementAttempt === target.attemptOrdinal);
      }
    }
  }
  for (const range of previous.plan.skippedRanges) {
    requireControl(next.plan.skippedRanges.some(item => item.journalId === range.journalId && item.firstSequence === range.firstSequence && item.lastSequence === range.lastSequence && item.reason === range.reason && (range.discharge === null || equal(range.discharge, item.discharge))));
  }
}

export class OperationStore {
  private readonly storage: ScopeStorage;
  private readonly queue = new SerialQueue();

  private readonly prospectiveFailure: ProspectiveJsonFailure | undefined;
  private readonly bind: <T>(action: () => Promise<T>) => () => Promise<T>;
  constructor(storage: ScopeStorage, prospectiveFailure?: ProspectiveJsonFailure, bind = <T>(action: () => Promise<T>): (() => Promise<T>) => action) {
    this.storage = storage; this.prospectiveFailure = prospectiveFailure; this.bind = bind;
  }
  private queued<T>(action: () => Promise<T>): Promise<T> { return this.queue.run(this.bind(action)); }

  read(id: string, deadline?: Deadline): Promise<StoredDocument<OperationRecord>> {
    return this.storage.read(`operations/${fileName(id)}`, 'state-event', value => {
      const record = parseOperation(value, this.storage.scope.bindingSha256);
      requireControl(record.operationId === id);
      return record;
    }, deadline);
  }

  async list(deadline?: Deadline): Promise<OperationInventory> {
    const records: StoredOperation[] = [];
    const invalid: { name: string; sha256: string | null }[] = [];
    const names = await this.storage.list('operations', deadline);
    for (const name of names) { requireControl(name.endsWith('.json') && fileName(name.slice(0, -5)) === name); }
    const values = await this.storage.readMany(names.map(name => `operations/${name}`), 'state-event', (value, index) => {
      const record = parseOperation(value, this.storage.scope.bindingSha256);
      requireControl(record.operationId === names[index]!.slice(0, -5));
      return record;
    }, deadline);
    for (const [index, value] of values.entries()) {
      const name = names[index]!;
      if (value.status === 'valid') { records.push({ record: value.value, sha256: value.sha256 }); }
      else { invalid.push({ name, sha256: value.status === 'invalid' ? value.sha256 : null }); }
    }
    records.sort((left, right) => left.record.startedAt < right.record.startedAt ? -1 : left.record.startedAt > right.record.startedAt ? 1 : left.record.operationId < right.record.operationId ? -1 : left.record.operationId > right.record.operationId ? 1 : 0);
    const handoffCount = records.reduce((sum, value) => sum + (!value.record.compacted && value.record.kind === 'repair' ? value.record.plan.handoffs.length : 0), 0);
    const fullTerminalCount = records.filter(value => !value.record.compacted && value.record.completedAt !== null).length;
    deadline?.check();
    return { records, invalid, handoffCount, fullTerminalCount };
  }

  create(record: FullOperation, deadline?: Deadline): Promise<StoredOperation> {
    return this.queued(async () => {
      deadline?.check();
      const validated = parseOperation(parseStrictJson(Buffer.from(stringifyProspectiveJson(record, 'state-event', 'operations/' + fileName(record.operationId), this.prospectiveFailure), 'utf8'), 'state-event'), this.storage.scope.bindingSha256);
      requireControl(!validated.compacted && validated.completedAt === null);
      await this.storage.ensureDirectory('operations', deadline);
      const sha256 = await this.storage.write(`operations/${fileName(record.operationId)}`, validated, 'state-event', null, deadline);
      return { record: validated, sha256 };
    });
  }

  update(expected: StoredOperation, change: (current: FullOperation) => FullOperation, deadline?: Deadline): Promise<StoredOperation> {
    return this.queued(async () => {
      deadline?.check();
      const current = await this.read(expected.record.operationId, deadline);
      requireControl(current.status === 'valid' && current.sha256 === expected.sha256 && !current.value.compacted);
      const next = parseOperation(parseStrictJson(Buffer.from(stringifyProspectiveJson(change(current.value), 'state-event', 'operations/' + fileName(current.value.operationId), this.prospectiveFailure), 'utf8'), 'state-event'), this.storage.scope.bindingSha256);
      requireControl(!next.compacted);
      validateOperationTransition(current.value, next);
      const sha256 = await this.storage.write(`operations/${fileName(next.operationId)}`, next, 'state-event', current.sha256, deadline);
      return { record: next, sha256 };
    });
  }

  compact(expected: StoredOperation, eligible: (record: FullOperation, deadline?: Deadline) => Promise<boolean>, deadline?: Deadline): Promise<StoredOperation> {
    return this.queued(async () => {
      deadline?.check();
      const current = await this.read(expected.record.operationId, deadline);
      requireControl(current.status === 'valid' && current.sha256 === expected.sha256 && !current.value.compacted && !effectivelyUnfinished(current.value) && !pendingOperationSafety(current.value) && await eligible(current.value, deadline));
      const record = current.value;
      const compact: CompactOperation = { operationVersion: 1, operationId: record.operationId, scopeSha256: record.scopeSha256, kind: record.kind, cause: record.cause,
        startedAt: record.startedAt, completedAt: record.completedAt, outcome: record.outcome, compacted: true, sourceRecordSha256: current.sha256 };
      parseOperation(parseStrictJson(Buffer.from(stringifyProspectiveJson(compact, 'state-event', 'operations/' + fileName(record.operationId), this.prospectiveFailure), 'utf8'), 'state-event'), this.storage.scope.bindingSha256);
      const sha256 = await this.storage.write(`operations/${fileName(record.operationId)}`, compact, 'state-event', current.sha256, deadline);
      return { record: compact, sha256 };
    });
  }
}

export function requireRepair(operation: OperationRecord): RepairOperation {
  requireControl(!operation.compacted && operation.kind === 'repair' && isRepairOperationId(operation.operationId));
  return operation;
}
