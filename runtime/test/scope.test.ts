import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import { EventReader } from '../src/event-reader.ts';
import { FilePublisher } from '../src/files.ts';
import { initializeJournal } from '../src/journal-initialization.ts';
import { parseJournalHeader } from '../src/journal-records.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { jsonBudgets, parseStrictJson } from '../src/json.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { discoverScope, initializeScope, readScope, scopeComponents } from '../src/scope.ts';
import { ScopeStorage, StorageConflictError } from '../src/storage.ts';
import { OperationStore } from '../src/operations.ts';
import { emptyRepairPlan, initialRecovery, type RepairOperation } from '../src/operation-records.ts';
import { SafetyStore } from '../src/safety.ts';
import { SessionStore } from '../src/session-store.ts';
import type { AgentSessionBinding } from '../src/session-records.ts';
import { PayloadCodec } from '../src/codec.ts';
import { RecoveryExecutor, RecoveryDamageError } from '../src/recovery-executor.ts';
import type { RecoveryAction } from '../src/recovery-manifest.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

async function openScopeFixture() {
  const fixture = await companionFixture();
  let guard: Awaited<ReturnType<typeof takeInstanceGuard>> | null = null;
  const close = async (): Promise<void> => {
    try { await guard?.release(); }
    finally { await fixture.close(); }
  };
  try {
    const supervisor = (await createTestNative(fixture.root)).supervisor;
    const inspector = new PathInspector(supervisor);
    const candidate = await discoverScope(inspector, fixture.root, 'game/opaque', 'principal:opaque');
    await supervisor.proveBindable();
    await supervisor.nativeHelper.bind({ token: supervisor.scopeToken, companionRoot: fixture.root, dataRoot: candidate.dataRoot });
    assert.equal(await readScope(inspector, candidate), null);
    assert.deepEqual(await fs.readdir(fixture.root), []);
    guard = await takeInstanceGuard(candidate.dataRoot, error => { throw error; });
    const publisher = new FilePublisher({ root: candidate.dataRoot, guard, inspector, supervisor, preflight: async (_target, bytes, profile) => { parseStrictJson(bytes, profile); }, invalidate: () => {} });
    const initialized = await initializeScope(inspector, candidate, guard, publisher);
    assert.equal(initialized.createdHere, true);
    assert.match(initialized.bindingSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await fs.readdir(candidate.dataRoot), ['scope.json']);
    const existing = await initializeScope(inspector, candidate, guard, publisher);
    assert.equal(existing.bindingSha256, initialized.bindingSha256);
    assert.equal(existing.createdHere, false);
    const storage = new ScopeStorage({ scope: initialized, guard, inspector, publisher });
    const generations: string[] = [];
    const suppressed: string[] = [];
    const safety = new SafetyStore({ storage, bindingGenerations: async () => generations, suppressProvider: reason => { suppressed.push(reason); } });
    const initializedSafety = await safety.initializeNew();
    generations.push(initializedSafety.value.generation);
    assert.equal(initializedSafety.value.correction, null);
    await assert.rejects(safety.initializeNew());
    const sessions = new SessionStore(storage);
    assert.deepEqual(await sessions.readPair(), { binding: { status: 'absent' }, index: { status: 'absent' } });
    const binding: AgentSessionBinding = { agentSessionVersion: 1, providerId: 'fixture', providerSessionId: 'session', createdAt: '2026-10-08T06:00:00.0000000Z',
      turnsCompleted: 0, needsState: true, instructionsSha256: 'f'.repeat(64), stateGeneration: initializedSafety.value.generation };
    const sessionProof = { verify: async (value: AgentSessionBinding) => {
      const current = await safety.read();
      return current.status === 'valid' && current.value.generation === value.stateGeneration && current.value.pendingCheck === null && current.value.correction === null;
    } };
    const operations = new OperationStore(storage);
    const time = '2026-10-08T06:00:00.0000000Z';
    const record: RepairOperation = { operationVersion: 1, operationId: `jr-${'a'.repeat(32)}`, scopeSha256: initialized.bindingSha256, kind: 'repair', cause: 'lostJournal', startedAt: time, completedAt: null, outcome: null,
      compacted: false, plan: emptyRepairPlan(), recovery: initialRecovery(time, 'b'.repeat(32)) };
    return { inspector, candidate, guard, publisher, initialized, storage, suppressed, safety, initializedSafety, sessions, binding, sessionProof, operations, record, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe('immutable runtime scope', () => {
  it('maps opaque identity bytes to safe case-distinct components', () => {
    const ordinary = scopeComponents('a/b', 'principal:token');
    assert.equal(ordinary[0], 'runtime-data');
    assert.match(ordinary[1]!, /^g-[a-f0-9]{64}$/);
    assert.match(ordinary[2]!, /^p-[a-f0-9]{64}$/);
    assert.notEqual(scopeComponents('Case', 'principal')[1], scopeComponents('case', 'principal')[1]);
  });

  it('preserves scope ownership and requires proof to replace damaged safety', { timeout: 360000 }, async context => {
    context.diagnostic('Initializing an isolated scope.');
    const fixture = await openScopeFixture();
    const { inspector, candidate, guard, publisher, storage, suppressed, safety, initializedSafety, sessions, binding, sessionProof, operations, record } = fixture;
    try {
      context.diagnostic('Scope initialized; checking safety and ownership.');
      await sessions.bind(binding, sessionProof);
      const hash = await storage.write('probe.json', { value: 1 }, 'config', null);
      assert.equal((await storage.read('probe.json', 'config', value => value)).status, 'valid');
      await assert.rejects(storage.write('probe.json', { value: 2 }, 'config', '0'.repeat(64)), StorageConflictError);
      assert.equal(await fs.readFile(path.join(candidate.dataRoot, 'probe.json'), 'utf8'), '{"value":1}');
      await storage.write('probe.json', { value: 2 }, 'config', hash);
      const stored = await operations.create(record);
      assert.equal((await operations.list()).records.length, 1);
      await assert.rejects(operations.compact(stored, async () => true));
      const safetyPath = path.join(candidate.dataRoot, 'state-safety.json');
      const oversizedSafety = Buffer.alloc(jsonBudgets.config.maxBytes + 1, 32);
      oversizedSafety[0] = 123; oversizedSafety[1] = 125;
      await fs.writeFile(safetyPath, oversizedSafety);
      assert.deepEqual(await safety.read(), { status: 'invalid', sha256: createHash('sha256').update(oversizedSafety).digest('hex') });
      const owner = { operationId: record.operationId, episodeOrdinal: 1, activationId: 'b'.repeat(32) };
      const knownCorrection = { correctionId: 'e'.repeat(32), reason: 'coreRejected' as const, recoveryOperationId: record.operationId };
      await assert.rejects(safety.recoverUnknown(owner, knownCorrection, { verify: async () => false }));
      assert.deepEqual(await fs.readFile(safetyPath), oversizedSafety);
      const recovered = await safety.recoverUnknown(owner, knownCorrection, { verify: async () => true });
      assert.deepEqual(recovered.value.correction, knownCorrection);
      assert.notEqual(recovered.value.generation, initializedSafety.value.generation);
      assert.equal(recovered.value.recoveryWitness?.phase, 'preparing');
      assert.deepEqual(await sessions.admitNamed('fixture', 'session', recovered.value.generation, binding.instructionsSha256), { result: 'stateInvalidated' });
      assert.deepEqual(suppressed, ['coreRejected', 'coreRejected']);
      const recoveredBytes = await fs.readFile(safetyPath);
      await fs.unlink(safetyPath);
      await fs.mkdir(safetyPath);
      await assert.rejects(safety.recoverUnknown(owner, knownCorrection, { verify: async () => true }), DataRootUnavailableError);
      assert.equal((await fs.stat(safetyPath)).isDirectory(), true);
      await fs.rmdir(safetyPath);
      await fs.writeFile(safetyPath, recoveredBytes);
      const bindingPath = path.join(candidate.dataRoot, 'scope.json');
      const changed = '{"runtimeScopeVersion":1,"game":"other","principal":"principal:opaque"}';
      await fs.writeFile(bindingPath, changed);
      await assert.rejects(readScope(inspector, candidate), DataRootUnavailableError);
      await assert.rejects(initializeScope(inspector, candidate, guard, publisher), DataRootUnavailableError);
      await assert.rejects(storage.read('probe.json', 'config', value => value), DataRootUnavailableError);
      assert.equal(await fs.readFile(bindingPath, 'utf8'), changed);
      await fs.unlink(bindingPath);
      await fs.writeFile(path.join(candidate.dataRoot, 'scope.json.' + 'a'.repeat(32) + '.tmp'), 'interrupted');
      await assert.rejects(initializeScope(inspector, candidate, guard, publisher), DataRootUnavailableError);
    } finally {
      context.diagnostic('Closing the owned scope fixture.');
      await fixture.close();
    }
  });

  it('reconstructs only the derived session index after a partial binding write', { timeout: 360000 }, async context => {
    context.diagnostic('Initializing an isolated scope.');
    const fixture = await openScopeFixture();
    const { inspector, candidate, publisher, sessions, binding, sessionProof } = fixture;
    try {
      context.diagnostic('Scope initialized; checking session-index reconstruction.');
      const publish = publisher.publish.bind(publisher);
      publisher.publish = async (relative, ...args) => {
        if (relative === 'agent-session-index.json') { throw new Error('fixture index write failed'); }
        return publish(relative, ...args);
      };
      await assert.rejects(sessions.bind(binding, sessionProof), /fixture index write failed/);
      assert.equal((await sessions.readBinding()).status, 'valid');
      assert.equal(await sessions.ready(sessionProof), null);
      publisher.publish = publish;
      await sessions.bind(binding, sessionProof);
      const native = inspector.native.bind(inspector);
      const pairCalls: string[] = [];
      inspector.native = (op, ...args) => { pairCalls.push(op); return native(op, ...args); };
      const pair = await sessions.readPair();
      assert.deepEqual(pairCalls, ['hash']);
      assert.equal(pair.binding.status, 'valid');
      assert.equal(pair.index.status, 'valid');
      if (pair.binding.status === 'valid') { assert.deepEqual(pair.binding.value, binding); }
      let now = 0;
      const expired = Deadline.after(1, () => now);
      now = 1;
      await assert.rejects(sessions.readPair(expired), DeadlineExceededError);
      assert.equal(pairCalls.length, 1);
      inspector.native = native;
      assert.deepEqual((await sessions.ready(sessionProof))?.binding, binding);
      await fs.writeFile(path.join(candidate.dataRoot, 'agent-session-index.json'), '{}');
      const damagedPair = await sessions.readPair();
      assert.deepEqual(damagedPair.index, { status: 'invalid', sha256: createHash('sha256').update('{}').digest('hex') });
      assert.deepEqual(damagedPair.binding, pair.binding);
      assert.equal(await sessions.ready(sessionProof), null);
      assert.deepEqual(await sessions.admitNamed('fixture', 'session', binding.stateGeneration, binding.instructionsSha256), { result: 'unknownSession' });
      await sessions.bind(binding, sessionProof);
      assert.equal((await sessions.admitNamed('fixture', 'session', binding.stateGeneration, binding.instructionsSha256)).result, 'admitted');
      await assert.rejects(sessions.bind({ ...binding, stateGeneration: 'f'.repeat(32) }, { verify: async () => true }));
    } finally {
      context.diagnostic('Closing the owned scope fixture.');
      await fixture.close();
    }
  });

  it('initializes only an empty journal and preserves exact quarantine bytes', { timeout: 360000 }, async context => {
    context.diagnostic('Initializing an isolated scope.');
    const fixture = await openScopeFixture();
    const { inspector, candidate, publisher, initialized, storage, operations, record } = fixture;
    try {
      context.diagnostic('Scope initialized; checking journal initialization and quarantine.');
      await operations.create(record);
      assert.equal(await initializeJournal(storage, inspector, publisher), true);
      const firstHeader = await storage.read('journal/journal.json', 'config', parseJournalHeader);
      assert.ok(firstHeader.status === 'valid');
      assert.equal(firstHeader.value.historyVerified, false);
      assert.equal(firstHeader.value.highWaterSequence, 0);
      assert.equal(await initializeJournal(storage, inspector, publisher), false);
      assert.deepEqual(await storage.read('journal/journal.json', 'config', parseJournalHeader), firstHeader);
      await fs.unlink(path.join(candidate.dataRoot, 'journal', 'cursor-agent-session.json'));
      assert.equal(await initializeJournal(storage, inspector, publisher), false);
      await assert.rejects(fs.readFile(path.join(candidate.dataRoot, 'journal', 'cursor-agent-session.json')), { code: 'ENOENT' });
      await storage.ensureDirectory('quarantine');
      const corruptBytes = Buffer.alloc(jsonBudgets['state-event'].maxBytes + 1, 32);
      corruptBytes[0] = 123;
      const source = 'journal/events/0000000000000001.json';
      const destination = `quarantine/0000000000000001.json.${'c'.repeat(32)}.quarantined`;
      const sourceHash = createHash('sha256').update(corruptBytes).digest('hex');
      await fs.writeFile(path.join(candidate.dataRoot, source), corruptBytes);
      const [damaged] = await new EventReader(candidate.dataRoot, inspector).read([{ path: source, sequence: 1 }]);
      assert.equal(damaged?.status, 'invalid');
      assert.equal(damaged?.sha256, sourceHash);
      const invalidOperationName = `jr-${'d'.repeat(32)}.json`;
      await fs.writeFile(path.join(candidate.dataRoot, 'operations', invalidOperationName), corruptBytes);
      const inventory = await operations.list();
      assert.deepEqual(inventory.invalid, [{ name: invalidOperationName, sha256: sourceHash }]);
      assert.equal(inventory.records.length, 1);
      const executor = new RecoveryExecutor({ scope: initialized, inspector, publisher, codec: new PayloadCodec(publisher, async () => {}), admit: async () => {}, readPayloadSource: async () => { throw new Error('Quarantine is never a replay source.'); } });
      const move: RecoveryAction = { kind: 'quarantine', source: { path: source, before: sourceHash, after: null }, target: { path: destination, before: null, after: sourceHash } };
      assert.equal(await executor.execute(move), 'applied');
      assert.equal(await executor.execute(move), 'alreadyApplied');
      assert.deepEqual(await fs.readFile(path.join(candidate.dataRoot, destination)), corruptBytes);
      await fs.writeFile(path.join(candidate.dataRoot, source), corruptBytes);
      await assert.rejects(executor.execute(move), RecoveryDamageError);
      assert.deepEqual(await fs.readFile(path.join(candidate.dataRoot, source)), corruptBytes);
    } finally {
      context.diagnostic('Closing the owned scope fixture.');
      await fixture.close();
    }
  });

});
