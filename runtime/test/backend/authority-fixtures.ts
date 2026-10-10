import assert from 'node:assert/strict';
import path from 'node:path';

import { DataRootUnavailableError, type PathAdmission } from '../../src/admission.ts';
import { Kernel, type KernelInput } from '../../src/backend/kernel.ts';
import { handoffFor } from '../../src/backend/recovery.ts';
import { CapacityObservation, RuntimeCapacityError } from '../../src/capacity.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import type { Deadline } from '../../src/deadline.ts';
import { eventRewriteMetadata, parseJournalCursor, parseJournalHeader } from '../../src/journal-records.ts';
import { parseStrictJson, stringifyJson, StrictJsonError, type JsonProfile, type JsonValue } from '../../src/json.ts';
import { parseOperation, type OperationRecord, type RepairOperation, type ReleaseOperation } from '../../src/operation-records.ts';
import type { JournalSnapshot, JournalTransaction } from '../../src/journal.ts';
import { parseStateSafety, SafetyUnavailableError, type CorrectionReason, type RecoveryWitness, type StateSafety } from '../../src/safety-records.ts';
import { parseSessionBinding, parseSessionIndex, type AgentSessionIndex } from '../../src/session-records.ts';
import { bytesHash, StorageConflictError, type ScopeStorage, type StoredDocument } from '../../src/storage.ts';
import { journalEvent } from '../support/journal-event.ts';

// These pre-existing authority controls assume resource admission and isolate
// durable safety predicates. The capacity integration controls use the real
// ResourceAuthority and separately test ownership, admission and invalidation.
export function admittedCapacityFixture() {
  const capacity = new CapacityObservation();
  return { capacity, reserve: async () => {}, reserveMaintenance: async () => {}, invalidate: () => capacity.invalidate(),
    invalidatePublication: () => capacity.invalidateOwed(), assertReservation: () => 'ordinary' as const,
    withTransition: <T>(_kind: string, action: () => Promise<T>): Promise<T> => action(),
    bind: <T>(action: () => Promise<T>): (() => Promise<T>) => action,
    sessionMutation: <T>(action: () => Promise<T>): Promise<T> => action(), currentSource: () => null,
    captureFailure: (error: unknown) => error instanceof RuntimeCapacityError ? error : null,
    reportFailure: (error: RuntimeCapacityError) => capacity.refused(error), prospectiveFailure: (error: Error) => error,
    preflight: async () => {}, workspace: async () => {} };
}

export const at = '2026-10-08T00:00:00.0000000Z';
export const scope = 'a'.repeat(64);
export const generation = 'b'.repeat(32);
export const correctionId = 'c'.repeat(32);
export const owner = { operationId: `jr-${'1'.repeat(32)}`, episodeOrdinal: 0, activationId: '2'.repeat(32) };
export const witness: RecoveryWitness = { scopeSha256: scope, owner, phase: 'active', successor: null, disclosure: null };

export function repair(changes: Partial<RepairOperation> = {}): RepairOperation {
  const value: RepairOperation = { operationVersion: 1, operationId: owner.operationId, scopeSha256: scope, kind: 'repair', cause: 'operationLost', compacted: false,
    startedAt: at, completedAt: null, outcome: null, plan: { lastGoodSequence: 0, affected: [], cursorTo: null, rejectedRecord: null, lostOperations: [], publishedVersions: null,
      retiredRecords: [], handoffs: [], correctionId, inheritedRecovery: null, skippedRanges: [] },
    recovery: { attempts: [{ publication: 'due', selectedRecord: null, journalEvent: null }], episodes: [{ activationId: owner.activationId, trigger: 'initial', phase: 'preparing',
      attemptAtStart: 0, replacementAttempt: null, prerequisite: null, acceptedRecovery: null, successorEpisode: null, releaseOperationId: null, startedAt: at, endedAt: null }], activeEpisode: 0 }, ...changes };
  return parseOperation(parseStrictJson(Buffer.from(stringifyJson(value, 'state-event')), 'state-event'), scope) as RepairOperation;
}

export function deferredRepair(state: 'waitingReplacement' | 'pendingCleanup' | 'resolved' = 'waitingReplacement'): RepairOperation {
  const original = journalEvent(1, { type: 'state.resync', coreRepairOperationId: owner.operationId, attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 },
    acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation } });
  const carryHash = '7'.repeat(64);
  const source = repair();
  const accepted = state === 'waitingReplacement' ? null : { journalId: 'journal', eventId: '2'.padStart(32, '0'), sequence: 2, generation, acceptedAt: at };
  return repair({ completedAt: state === 'resolved' ? at : null, outcome: state === 'resolved' ? 'completed' : null,
    plan: { ...source.plan, correctionId: null, handoffs: [handoffFor(original)] },
    recovery: { attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: original.logicalOutboxId, recordSha256: original.recordSha256 },
      journalEvent: { journalId: original.journalId, eventId: original.eventId, sequence: 1 } },
    { publication: accepted === null ? 'due' : 'observed', selectedRecord: accepted === null ? null : { logicalOutboxId: 'd'.repeat(32) + '-2', recordSha256: 'e'.repeat(64) },
      journalEvent: accepted === null ? null : { journalId: accepted.journalId, eventId: accepted.eventId, sequence: accepted.sequence } }],
    activeEpisode: state === 'resolved' ? null : 0,
    episodes: [{ ...source.recovery.episodes[0]!, replacementAttempt: 1, phase: state === 'waitingReplacement' ? 'publishing' : state === 'pendingCleanup' ? 'verifyingHistory' : 'completed',
      acceptedRecovery: accepted, endedAt: state === 'resolved' ? at : null,
      prerequisite: { kind: 'rewind', carry: { path: 'journal/recovery-event.json', sha256: carryHash }, carryRelease: { attemptRef: { operationId: source.operationId, attemptOrdinal: 1 } },
        nextAction: state === 'resolved' ? 2 : 1, skippedRanges: [], actions: [
          { kind: 'preserveRecovery', source: { root: 'scope', path: 'journal/events/0000000000000001.json', sha256: '8'.repeat(64), payloadBindingSha256: original.payloadBindingSha256 },
            target: { path: 'journal/recovery-event.json', before: null, after: carryHash }, metadata: eventRewriteMetadata(original) },
          ...(accepted === null ? [] : [{ kind: 'removeCarry' as const, target: { path: 'journal/recovery-event.json', before: carryHash, after: null } }]),
        ] } }] } });
}

export function release(changes: Partial<ReleaseOperation> = {}): ReleaseOperation {
  const value: ReleaseOperation = { operationVersion: 1, operationId: `rl-${'3'.repeat(32)}`, scopeSha256: scope, kind: 'release', cause: 'release', compacted: false,
    startedAt: at, completedAt: at, outcome: 'completed', safety: { obligationId: '4'.repeat(32), phase: 'transferred', correctionId },
    plan: { mode: 'abandon', abandonedSequences: [], journalId: 'journal', skippedRanges: [], unfinishedRepairs: [owner], witness, witnessUnavailable: false,
      result: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: true, abandonedCount: 0 },
      completedPhases: ['coreSwitched', 'cursorAdvanced', 'repairsAbandoned', 'dischargesPublished', 'complete'] }, ...changes };
  return parseOperation(parseStrictJson(Buffer.from(stringifyJson(value, 'state-event')), 'state-event'), scope) as ReleaseOperation;
}

export function carryTransfer(state: 'waitingReplacement' | 'resolved' = 'resolved') {
  const source = deferredRepair();
  const releaseRecord = release();
  const predecessor = repair({ ...source, completedAt: at, outcome: 'abandonedByRelease', recovery: { ...source.recovery, activeEpisode: null,
    episodes: [{ ...source.recovery.episodes[0]!, phase: 'abandonedByRelease', releaseOperationId: releaseRecord.operationId, endedAt: at }] } });
  const replacement = deferredRepair(state);
  const operationId = 'jr-' + '8'.repeat(32);
  const successor = repair({ ...replacement, operationId, plan: { ...replacement.plan, inheritedRecovery: owner }, recovery: { ...replacement.recovery,
    episodes: [{ ...replacement.recovery.episodes[0]!, prerequisite: { ...replacement.recovery.episodes[0]!.prerequisite!, carryRelease: { attemptRef: { operationId, attemptOrdinal: 1 } } } }] } });
  return { predecessor, successor, releaseRecord, records: [predecessor, successor, releaseRecord].map(record => ({ record, sha256: 'b'.repeat(64) })) };
}

export function journal(highWater = 0, acked = 0): JournalSnapshot {
  return { header: { status: 'valid', sha256: 'd'.repeat(64), value: { journalVersion: 1, journalId: 'journal', createdAt: at, highWaterSequence: highWater, historyVerified: true } },
    cursor: { status: 'valid', sha256: 'e'.repeat(64), value: { cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: acked,
      lastSentSequence: acked, lastAcceptedRevision: null, updatedAt: at } }, events: new Map(), damaged: [], historicalGaps: [], fault: null, firstBadSequence: null, unrecordedEvent: null };
}

export function stubJournalTransaction(kernel: Kernel, snapshot: JournalSnapshot): void {
  const unexpected = async (): Promise<never> => { throw new Error('A read-only journal fixture reached a write.'); };
  const transaction: JournalTransaction = { snapshot: () => structuredClone(snapshot), recoverHighWater: async () => structuredClone(snapshot),
    append: unexpected, rewrite: unexpected, acknowledge: unexpected, markSent: unexpected };
  kernel.journal.transact = (async action => action(transaction)) as typeof kernel.journal.transact;
}

// These fixtures model admitted storage and validated core observations. They use
// production control parsers/queues, but claim no native path or core assurance.
export class MemoryAuthority {
  readonly scope = { companionRoot: 'C:/Git/disco-elysium-companion/.tmp/authority-model', dataRoot: 'C:/Git/disco-elysium-companion/.tmp/authority-model/data',
    game: 'stubgame', principal: 'principal', bindingSha256: scope, createdHere: false };
  readonly files = new Map<string, Buffer>();
  readonly writes: string[] = [];
  readonly inspections: string[] = [];
  readonly unreadable = new Set<string>();

  private key(relative: string): string {
    const value = path.isAbsolute(relative) ? path.relative(this.scope.dataRoot, relative) : relative;
    const normalized = value.replaceAll(path.win32.sep, '/');
    assert.ok(normalized !== '..' && !normalized.startsWith('../') && !path.isAbsolute(normalized));
    return normalized;
  }

  private validate(relative: string, value: JsonValue): void {
    if (relative.startsWith('operations/')) {
      const operation = parseOperation(value, scope);
      assert.equal(relative, `operations/${operation.operationId}.json`);
    } else if (relative === 'state-safety.json') { parseStateSafety(value, scope); }
    else if (relative === 'journal/journal.json') { parseJournalHeader(value); }
    else if (relative === 'journal/cursor-agent-session.json') { parseJournalCursor(value); }
    else if (relative === 'agent-session.json') { parseSessionBinding(value); }
    else if (relative === 'agent-session-index.json') { parseSessionIndex(value); }
  }

  seed(relative: string, value: unknown, profile: JsonProfile = relative.startsWith('operations/') ? 'state-event' : 'config'): void {
    const key = this.key(relative);
    const bytes = Buffer.from(stringifyJson(value, profile));
    this.validate(key, parseStrictJson(bytes, profile));
    this.files.set(key, bytes);
  }

  async read<T>(relative: string, profile: JsonProfile, parse: (value: JsonValue) => T, deadline?: Deadline): Promise<StoredDocument<T>> {
    deadline?.check();
    const key = this.key(relative);
    if (this.unreadable.has(key)) { throw new DataRootUnavailableError('Fixture authority is unreadable.'); }
    const bytes = this.files.get(key);
    if (bytes === undefined) { return { status: 'absent' }; }
    try { return { status: 'valid', value: parse(parseStrictJson(bytes, profile)), sha256: bytesHash(bytes) }; }
    catch (error) {
      if (error instanceof ControlDocumentError || error instanceof StrictJsonError || error instanceof SafetyUnavailableError) { return { status: 'invalid', sha256: bytesHash(bytes) }; }
      throw error;
    }
  }

  async readMany<T>(relatives: readonly string[], profile: JsonProfile, parse: (value: JsonValue, index: number) => T, deadline?: Deadline): Promise<readonly StoredDocument<T>[]> {
    return Promise.all(relatives.map((relative, index) => this.read(relative, profile, value => parse(value, index), deadline)));
  }

  async write(relative: string, value: unknown, profile: JsonProfile, expected: string | null, deadline?: Deadline): Promise<string> {
    deadline?.check();
    const key = this.key(relative);
    const before = this.files.get(key);
    if ((before === undefined ? null : bytesHash(before)) !== expected) { throw new StorageConflictError('Fixture preimage changed.'); }
    this.seed(key, value, profile);
    this.writes.push(key);
    return bytesHash(this.files.get(key)!);
  }

  async replaceSessionIndex(value: AgentSessionIndex, bindingSha256: string, deadline?: Deadline): Promise<string> {
    assert.equal(bytesHash(this.files.get('agent-session.json')!), bindingSha256);
    const previous = this.files.get('agent-session-index.json');
    return this.write('agent-session-index.json', value, 'config', previous === undefined ? null : bytesHash(previous), deadline);
  }

  async list(relative: string, deadline?: Deadline): Promise<readonly string[]> {
    deadline?.check();
    const prefix = this.key(relative).replace(/\/$/, '') + '/';
    return [...this.files.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(key => key.slice(prefix.length)).sort();
  }

  async ensureDirectory(): Promise<void> {}
  async idle(): Promise<void> {}

  async inspect(_root: string, target: string, _allowMissing = false): Promise<PathAdmission> {
    const key = this.key(target); this.inspections.push(key);
    if (this.unreadable.has(key)) { throw new DataRootUnavailableError('Fixture authority is unreadable.'); }
    const exists = this.files.has(key);
    return { path: path.resolve(this.scope.dataRoot, key), exists, kind: exists ? 'file' : null, links: exists ? 1 : null,
      volume: exists ? '0'.repeat(16) : null, identity: exists ? bytesHash(Buffer.from(key)).slice(0, 32) : null, missing: exists ? [] : [path.basename(key)] };
  }

  value<T>(relative: string): T { return parseStrictJson(this.files.get(this.key(relative))!) as T; }
}

export function authorityModel(initialSafety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null }, initialJournal = journal()) {
  const memory = new MemoryAuthority();
  memory.seed('state-safety.json', initialSafety);
  assert.equal(initialJournal.header.status, 'valid'); assert.equal(initialJournal.cursor.status, 'valid');
  if (initialJournal.header.status === 'valid') { memory.seed('journal/journal.json', initialJournal.header.value); }
  if (initialJournal.cursor.status === 'valid') { memory.seed('journal/cursor-agent-session.json', initialJournal.cursor.value); }
  const invalidations: string[] = [];
  const diagnostics: unknown[] = [];
  const unexpectedNative = async (): Promise<never> => { throw new Error('A pure authority control reached a native boundary.'); };
  const kernel = new Kernel({
    config: { configVersion: 1, adapter: 'stub', game: 'stubgame', provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } },
    identities: { runtimeInstanceId: '5'.repeat(32), runtimeSessionId: '6'.repeat(32), adapterBindingEpoch: '7'.repeat(32) },
    scope: memory.scope, storage: memory as unknown as ScopeStorage, guard: { held: true },
    inspector: { inspect: memory.inspect.bind(memory), metadata: unexpectedNative }, supervisor: { run: unexpectedNative, verifyQuiescent: async () => {} },
    publisher: {}, resources: admittedCapacityFixture(),
    options: { companionRoot: memory.scope.companionRoot, onInvalidated: (reason: CorrectionReason) => { invalidations.push(reason); }, onDiagnostic: (_: string, error: unknown) => { diagnostics.push(error); } },
  } as unknown as KernelInput);
  kernel.journal.read = async () => {
    const header = await memory.read('journal/journal.json', 'config', parseJournalHeader);
    const cursor = await memory.read('journal/cursor-agent-session.json', 'config', parseJournalCursor);
    return { ...initialJournal, header, cursor } as JournalSnapshot;
  };
  kernel.outbox.list = async () => [];
  kernel.carryHash = async () => {
    await memory.inspect(memory.scope.dataRoot, path.join(memory.scope.dataRoot, 'journal/recovery-event.json'));
    const bytes = memory.files.get('journal/recovery-event.json');
    return bytes === undefined ? null : bytesHash(bytes);
  };
  return { kernel, memory, invalidations, diagnostics, records: async (): Promise<readonly OperationRecord[]> => (await kernel.operations.list()).records.map(entry => entry.record) };
}
