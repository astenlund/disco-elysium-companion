import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileAcknowledgedRecovery } from '../../src/backend/recovery-disclosure.ts';
import { coreAttemptToken } from '../../src/operation-records.ts';
import { bindRecoveryEvent, checkpointRecovery, completeRecovery, selectRecoveryRecord } from '../../src/recovery-progress.ts';
import type { JournalEvent, JournalSnapshot, JournalTransaction } from '../../src/journal.ts';
import type { EventDescription, EventMetadata } from '../../src/journal-records.ts';
import { maintainRuntimeStorage } from '../../src/resource-lifecycle/retention.ts';
import { at, authorityModel, correctionId, generation, journal, owner, repair, stubJournalTransaction, witness } from './authority-fixtures.ts';
import { journalEvent } from '../support/journal-event.ts';

const operationPath = `operations/${owner.operationId}.json`;

function completedDisclosure(acked: number, stamped: boolean, withCorrection: boolean) {
  const event = journalEvent(2, { adapter: 'stubgame', type: 'state.resync', coreRepairOperationId: coreAttemptToken(owner.operationId, 0),
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 }, acknowledgedAt: stamped ? at : null,
    acceptance: { journalId: 'journal', eventId: '2'.padStart(32, '0'), generation } });
  const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'cursorRecovery' as const, discharge: null };
  const base = repair();
  let record = repair({ cause: 'lostJournal', plan: { ...base.plan, correctionId: withCorrection ? correctionId : null,
    publishedVersions: { schemaVersion: 2, adapterVersion: 1 }, skippedRanges: [range] } });
  record = selectRecoveryRecord(record, { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }, 'observed', null);
  record = bindRecoveryEvent(record, event);
  record = checkpointRecovery(record, event, generation, 2, at);
  record = completeRecovery(record, 'journal', generation, at);
  const baseJournal = journal(2, acked);
  const snapshot: JournalSnapshot = { ...baseJournal, events: new Map([[2, { metadata: event, sha256: 'f'.repeat(64) }]]) };
  const safety = { stateSafetyVersion: 1 as const, generation, pendingCheck: null,
    correction: withCorrection ? { correctionId, reason: 'contextUncertain' as const, recoveryOperationId: owner.operationId } : null,
    recoveryWitness: { ...witness, phase: 'awaitingDisclosure' as const,
      disclosure: { journalId: event.journalId, eventId: event.eventId, sequence: event.sequence, generation } } };
  const model = authorityModel(safety, snapshot);
  model.memory.seed(operationPath, record);
  return { ...model, event, snapshot };
}

function writableJournal(model: ReturnType<typeof completedDisclosure>, initial: JournalSnapshot = model.snapshot) {
  let current = initial;
  model.kernel.journal.read = async () => current;
  model.kernel.journal.transact = (async action => {
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected journal mutation.'); };
    const transaction = { snapshot: () => structuredClone(current), recoverHighWater: unexpected, append: unexpected, acknowledge: unexpected, markSent: unexpected,
      rewrite: async (expected: JournalEvent, change: (value: EventDescription) => EventMetadata) => {
        const before = current.events.get(expected.metadata.sequence);
        assert.equal(before?.sha256, expected.sha256);
        const rewritten = { metadata: { ...expected.metadata, ...change(structuredClone(expected.metadata)) }, sha256: 'e'.repeat(64) };
        current = { ...current, events: new Map(current.events).set(expected.metadata.sequence, rewritten) };
        return rewritten;
      } } as unknown as JournalTransaction;
    return action(transaction);
  }) as typeof model.kernel.journal.transact;
  model.kernel.inspector.metadata = async () => ({ exitCode: 0, stdout: Buffer.from('{"removed":0,"remaining":0}'), stderr: Buffer.alloc(0) });
  return () => current;
}

test('recovery disclosure waits for an actual cursor advance', async () => {
  const model = completedDisclosure(0, false, false);
  const writes = model.memory.writes.length;
  let restorationCalls = 0;
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel, async () => { restorationCalls++; }), false);
  assert.equal(restorationCalls, 0);
  assert.equal(model.memory.writes.length, writes);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
});

for (const withCorrection of [false, true]) {
  test(`recovery disclosure resumes cursor-before-stamp with correction ${withCorrection}`, async () => {
    const model = completedDisclosure(2, false, withCorrection);
    let current = model.snapshot;
    model.kernel.journal.read = async () => current;
    assert.equal(await reconcileAcknowledgedRecovery(model.kernel), false);
    assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
    let restores = 0;
    const reconciled = await reconcileAcknowledgedRecovery(model.kernel, async () => {
      restores++;
      current = { ...current, events: new Map(current.events).set(2, { metadata: { ...model.event, acknowledgedAt: at }, sha256: 'e'.repeat(64) }) };
    });
    assert.equal(reconciled, true);
    assert.equal(restores, 1);
    const safety = await model.kernel.safety();
    assert.equal(safety.recoveryWitness, null);
    assert.equal(safety.correction !== null, withCorrection);
    const record = await model.kernel.operations.read(owner.operationId);
    assert.equal(record.status, 'valid');
    if (record.status !== 'valid' || record.value.compacted || record.value.kind !== 'repair') { throw new Error('Expected full repair record.'); }
    assert.deepEqual(record.value.plan.skippedRanges[0]?.discharge,
      { kind: 'recoveryAcknowledged', operationId: owner.operationId, episodeOrdinal: 0, at });
    const writes = model.memory.writes.length;
    assert.equal(await reconcileAcknowledgedRecovery(model.kernel), false);
    assert.equal(model.memory.writes.length, writes);
  });
}

test('a stamped disclosure completes proof publication without restoration', async () => {
  const model = completedDisclosure(2, true, false);
  let restorationCalls = 0;
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel, async () => { restorationCalls++; }), true);
  assert.equal(restorationCalls, 0);
  assert.equal((await model.kernel.safety()).recoveryWitness, null);
});

test('a missing designated event does not create a discharge proof', async () => {
  const model = completedDisclosure(2, false, false);
  model.kernel.journal.read = async () => ({ ...model.snapshot, events: new Map(), fault: 'gap', firstBadSequence: 2 });
  const writes = model.memory.writes.length;
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), false);
  assert.equal(model.memory.writes.length, writes);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
});

test('proof publication interrupted after its durable write resumes without replacing the proof', async () => {
  const model = completedDisclosure(2, true, false);
  const write = model.memory.write.bind(model.memory);
  const interrupted = new Error('Interrupted after the range proof.');
  let injected = false;
  model.memory.write = async (relative, value, profile, expected, deadline) => {
    const sha256 = await write(relative, value, profile, expected, deadline);
    if (relative === operationPath && !injected) { injected = true; throw interrupted; }
    return sha256;
  };
  await assert.rejects(reconcileAcknowledgedRecovery(model.kernel), error => error === interrupted);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
  const proof = await model.kernel.operations.read(owner.operationId);
  assert.equal(proof.status, 'valid');
  if (proof.status !== 'valid' || proof.value.compacted || proof.value.kind !== 'repair') { throw new Error('Expected retained proof.'); }
  assert.notEqual(proof.value.plan.skippedRanges[0]?.discharge, null);
  const writes = model.memory.writes.filter(relative => relative === operationPath).length;
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), true);
  assert.equal(model.memory.writes.filter(relative => relative === operationPath).length, writes);
  assert.equal((await model.kernel.safety()).recoveryWitness, null);
});

test('witness clearing interrupted after its durable write resumes as complete', async () => {
  const model = completedDisclosure(2, true, true);
  const write = model.memory.write.bind(model.memory);
  const interrupted = new Error('Interrupted after witness clear.');
  let injected = false;
  model.memory.write = async (relative, value, profile, expected, deadline) => {
    const sha256 = await write(relative, value, profile, expected, deadline);
    if (relative === 'state-safety.json' && !injected) { injected = true; throw interrupted; }
    return sha256;
  };
  await assert.rejects(reconcileAcknowledgedRecovery(model.kernel), error => error === interrupted);
  const safety = await model.kernel.safety();
  assert.equal(safety.recoveryWitness, null);
  assert.notEqual(safety.correction, null);
  const writes = model.memory.writes.length;
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), false);
  assert.equal(model.memory.writes.length, writes);
});

for (const withCorrection of [false, true]) {
  test(`maintenance restores only the actually acknowledged disclosure with correction ${withCorrection}`, async () => {
    const model = completedDisclosure(2, false, withCorrection);
    const skipped = journalEvent(1, { acknowledgedAt: null, acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation } });
    const snapshot = { ...model.snapshot, events: new Map(model.snapshot.events).set(1, { metadata: skipped, sha256: 'd'.repeat(64) }) };
    const current = writableJournal(model, snapshot);
    await maintainRuntimeStorage(model.kernel);
    assert.equal(current().events.get(1)?.metadata.acknowledgedAt, null);
    assert.equal(current().events.get(2)?.metadata.acknowledgedAt, at);
    assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
    assert.equal(await reconcileAcknowledgedRecovery(model.kernel), true);
    const safety = await model.kernel.safety();
    assert.equal(safety.recoveryWitness, null);
    assert.equal(safety.correction !== null, withCorrection);
  });
}

test('a later ordinary cursor advance uses its conservative durable timestamp', async () => {
  const model = completedDisclosure(2, false, false);
  const later = '2026-10-08T00:00:01.0000000Z';
  const cursor = model.snapshot.cursor;
  assert.equal(cursor.status, 'valid');
  if (cursor.status !== 'valid') { throw new Error('Expected a valid cursor.'); }
  const snapshot: JournalSnapshot = { ...model.snapshot, cursor: { ...cursor, value: { ...cursor.value, updatedAt: later } } };
  const current = writableJournal(model, snapshot);
  await maintainRuntimeStorage(model.kernel);
  assert.equal(current().events.get(2)?.metadata.acknowledgedAt, later);
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), true);
  const proof = await model.kernel.operations.read(owner.operationId);
  assert.equal(proof.status, 'valid');
  if (proof.status !== 'valid' || proof.value.compacted || proof.value.kind !== 'repair') { throw new Error('Expected retained repair proof.'); }
  assert.equal(proof.value.plan.skippedRanges[0]?.discharge?.at, later);
});

test('an acknowledged recovery proof survives a later healthy journal replacement', async () => {
  const model = completedDisclosure(2, true, false);
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), true);
  const replacementId = 'new-journal';
  const fresh = journal(0, 0);
  assert.equal(fresh.header.status, 'valid');
  assert.equal(fresh.cursor.status, 'valid');
  if (fresh.header.status !== 'valid' || fresh.cursor.status !== 'valid') { throw new Error('Expected a valid replacement journal.'); }
  const headerValue = { ...fresh.header.value, journalId: replacementId, historyVerified: false };
  const cursorValue = { ...fresh.cursor.value, journalId: replacementId };
  const snapshot: JournalSnapshot = { ...fresh,
    header: { ...fresh.header, value: headerValue }, cursor: { ...fresh.cursor, value: cursorValue } };
  model.memory.seed('journal/journal.json', headerValue);
  model.memory.seed('journal/cursor-agent-session.json', cursorValue);
  const safety = await model.kernel.safety();
  model.memory.seed('state-safety.json', { ...safety, generation: '9'.repeat(32) });
  model.kernel.journal.read = async () => snapshot;
  stubJournalTransaction(model.kernel, snapshot);
  model.kernel.inspector.metadata = async () => ({ exitCode: 0, stdout: Buffer.from('{"removed":0,"remaining":0}'), stderr: Buffer.alloc(0) });
  const writes = model.memory.writes.length;
  await maintainRuntimeStorage(model.kernel);
  await maintainRuntimeStorage(model.kernel);
  assert.equal(model.memory.writes.length, writes);
  const operation = await model.kernel.operations.read(owner.operationId);
  assert.equal(operation.status, 'valid');
  if (operation.status !== 'valid' || operation.value.compacted || operation.value.kind !== 'repair') { throw new Error('Expected retained historical certificate.'); }
  assert.equal(operation.value.plan.skippedRanges[0]?.discharge?.kind, 'recoveryAcknowledged');
});
