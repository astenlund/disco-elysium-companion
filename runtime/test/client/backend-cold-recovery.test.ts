import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openBackend } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { parseJournalCursor, parseJournalHeader } from '../../src/journal-records.ts';
import { parseOperation } from '../../src/operation-records.ts';
import { activeRecoveryOwner } from '../../src/recovery-progress.ts';
import { parseStateSafety } from '../../src/safety-records.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { bytesHash } from '../../src/storage.ts';
import { CrashFixture, readDocument } from '../backend-crash/support.ts';
import { FakeProvider, instructionHash } from './support.ts';

test('first owner resumes a witnessed lostJournal repair before provider input and discharges it on acknowledgement', { timeout: 5400000 }, async () => {
  const fixture = await CrashFixture.create('first-owner-recovery', ['lostJournalPrepared'], ['lostJournalPrepared'], 'runtime');
  let backend: RuntimeBackend | null = null;
  let host: SessionHost | null = null;
  try {
    assert.equal((await fixture.child('first-owner-handover')).boundary, 'firstOwnerHandedOver');
    const cut = await fixture.child('first-owner-cut', 'lostJournalPrepared');
    assert.equal(cut.boundary, 'lostJournalPrepared');
    assert.ok(cut.repairId);
    const repairId = cut.repairId;
    const dataRoot = cut.dataRoot;
    const scopeHash = bytesHash(await fs.readFile(path.join(dataRoot, 'scope.json')));
    const safetyPath = path.join(dataRoot, 'state-safety.json');
    const operationPath = path.join(dataRoot, 'operations', repairId + '.json');
    const headerPath = path.join(dataRoot, 'journal', 'journal.json');
    const safetyBefore = parseStateSafety(await readDocument(safetyPath), scopeHash);
    const repairBefore = parseOperation(await readDocument(operationPath), scopeHash);
    const headerBefore = parseJournalHeader(await readDocument(headerPath));
    assert.equal(repairBefore.kind, 'repair');
    if (repairBefore.compacted || repairBefore.kind !== 'repair') { assert.fail('The persisted repair is not active.'); }
    assert.equal(repairBefore.cause, 'lostJournal');
    assert.equal(repairBefore.recovery.episodes[0]?.phase, 'preparing');
    assert.equal(repairBefore.recovery.attempts[0]?.publication, 'due');
    assert.equal(repairBefore.recovery.activeEpisode, 0);
    assert.equal(safetyBefore.recoveryWitness?.phase, 'preparing');
    assert.deepEqual(safetyBefore.recoveryWitness?.owner, activeRecoveryOwner(repairBefore));
    assert.equal(safetyBefore.pendingCheck, null);
    assert.equal(headerBefore.highWaterSequence, 0);
    assert.equal(headerBefore.historyVerified, false);
    assert.equal((await readDocument<{ owner: string }>(path.join(fixture.fixture.root, 'state', 'consumer.json'))).owner, 'runtime');
    await assert.rejects(fs.access(path.join(dataRoot, 'agent-session.json')), { code: 'ENOENT' });

    backend = await openBackend({ companionRoot: fixture.fixture.root });
    const blockedProvider = new FakeProvider();
    host = new SessionHost({ backend, provider: blockedProvider, instructionsSha256: instructionHash,
      providerTerminated: async () => backend!.supervisor.verifyQuiescent('provider'),
      verifyTools: async () => backend!.supervisor.verifyQuiescent('provider'), closeTools: async () => {}, delay: async () => {} });
    assert.equal(await host.start(), false);
    assert.equal(host.submitChat({ text: 'No state is ready.', questionOverride: false }).result, 'notReady');
    assert.deepEqual(blockedProvider.calls, []);
    assert.deepEqual(blockedProvider.sessions, []);
    await host.shutdown(); host = null; backend = null;

    backend = await openBackend({ companionRoot: fixture.fixture.root });
    const repaired = await backend.startup({ kind: 'repair' });
    assert.equal(repaired.notOwner, false);
    const headerAfterRepair = parseJournalHeader(await readDocument(headerPath));
    const repairAfter = parseOperation(await readDocument(operationPath), scopeHash);
    const safetyAfterRepair = parseStateSafety(await readDocument(safetyPath), scopeHash);
    assert.equal(headerAfterRepair.historyVerified, true);
    assert.equal(repairAfter.kind, 'repair');
    if (repairAfter.compacted || repairAfter.kind !== 'repair') { assert.fail('The repair lost its durable authority.'); }
    assert.equal(repairAfter.operationId, repairId);
    assert.equal(repairAfter.recovery.activeEpisode, null);
    assert.equal(repairAfter.recovery.episodes[0]?.phase, 'completed');
    assert.ok(repairAfter.recovery.episodes[0]?.acceptedRecovery);
    const checkpoint = repairAfter.recovery.episodes[0].acceptedRecovery;
    assert.equal(safetyAfterRepair.recoveryWitness?.phase, 'awaitingDisclosure');
    assert.deepEqual(safetyAfterRepair.recoveryWitness?.owner, safetyBefore.recoveryWitness?.owner);
    assert.equal((await fs.readdir(path.join(dataRoot, 'operations'))).filter(name => name.startsWith('jr-')).length, 1);
    await backend.shutdown(true); backend = null;

    backend = await openBackend({ companionRoot: fixture.fixture.root });
    assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
    const provider = new FakeProvider();
    let deliveredResync = false;
    provider.configure = session => { session.action = async request => {
      assert.match(request.contextBlock, /^<companion-turn-context>/);
      const context = JSON.parse(request.contextBlock.slice('<companion-turn-context>'.length, -'</companion-turn-context>'.length)) as Record<string, unknown>;
      assert.notEqual(context.state, null);
      deliveredResync = Array.isArray(context.events) && context.events.some(event => {
        const value = event as { type?: string; eventId?: string; sequence?: number };
        return value.type === 'state.resync' && value.eventId === checkpoint.eventId && value.sequence === checkpoint.sequence;
      });
      return { kind: 'completed', text: 'Private recovery acknowledged.' };
    }; };
    host = new SessionHost({ backend, provider, instructionsSha256: instructionHash,
      providerTerminated: async () => backend!.supervisor.verifyQuiescent('provider'),
      verifyTools: async () => backend!.supervisor.verifyQuiescent('provider'), closeTools: async () => {}, delay: async () => {} });
    assert.deepEqual(provider.calls, []);
    assert.equal(await host.start(), true);
    assert.equal(provider.current.requests.length, 0);
    let terminal: ((event: HostEvent) => void) | null = null;
    const completed = new Promise<HostEvent>(resolve => { terminal = resolve; });
    host.attach(event => { if (event.type === 'turn.completed' || event.type === 'turn.failed') { terminal?.(event); } });
    assert.equal(host.submitChat({ text: 'Inspect the private recovery.', questionOverride: false }).result, 'admitted');
    assert.equal((await completed).type, 'turn.completed');
    assert.equal(deliveredResync, true);
    await host.shutdown(); host = null;
    const cursor = parseJournalCursor(await readDocument(path.join(dataRoot, 'journal', 'cursor-agent-session.json')));
    assert.ok(cursor.lastAckedSequence >= checkpoint.sequence);
    assert.equal((parseStateSafety(await readDocument(safetyPath), scopeHash)).recoveryWitness, null);
    const binding = await backend.sessions.readBinding();
    assert.equal(binding.status, 'valid');
    if (binding.status !== 'valid') { assert.fail('The accepted turn has no durable binding.'); }
    assert.equal(binding.value.turnsCompleted, 1);
    const sessionId = binding.value.providerSessionId;
    backend = null;

    backend = await openBackend({ companionRoot: fixture.fixture.root });
    assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
    const resumedProvider = new FakeProvider();
    host = new SessionHost({ backend, provider: resumedProvider, instructionsSha256: instructionHash,
      providerTerminated: async () => backend!.supervisor.verifyQuiescent('provider'),
      verifyTools: async () => backend!.supervisor.verifyQuiescent('provider'), closeTools: async () => {}, delay: async () => {} });
    assert.equal(await host.start(), true);
    assert.equal(resumedProvider.calls[0], sessionId);
    const resumedBinding = await backend.sessions.readBinding();
    assert.equal(resumedBinding.status, 'valid');
    if (resumedBinding.status !== 'valid') { assert.fail('The resumed provider lost its binding.'); }
    assert.equal(resumedBinding.value.turnsCompleted, 1);
    assert.equal(resumedBinding.value.needsState, true);
    await host.shutdown(); host = null; backend = null;
  } catch (error) {
    try { await fixture.preserve('failed-first-owner'); }
    catch { /* Evidence copying cannot replace the original test failure. */ }
    throw error;
  } finally {
    if (host !== null) { await host.shutdown(); backend = null; }
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
