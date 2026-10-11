import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileAcknowledgedRecovery } from '../../src/backend/recovery-disclosure.ts';
import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import { coreAttemptToken } from '../../src/operation-records.ts';
import { bindRecoveryEvent, checkpointRecovery, completeRecovery, selectRecoveryRecord } from '../../src/recovery-progress.ts';
import { maintainRuntimeStorage, reconcileRetention, selectOperationRetention, type RetentionInputs } from '../../src/resource-lifecycle/retention.ts';
import type { JournalSnapshot } from '../../src/journal.ts';
import { at, authorityModel, generation, journal, owner, repair, stubJournalTransaction, witness } from './authority-fixtures.ts';
import { journalEvent } from '../support/journal-event.ts';

const predecessorId = 'jr-' + '0'.repeat(32);
const successorPath = `operations/${owner.operationId}.json`;
const predecessorPath = `operations/${predecessorId}.json`;
const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'cursorRecovery' as const, discharge: null };

function completed(operationId: string, sequence: number) {
  const event = journalEvent(sequence, { adapter: 'stubgame', type: 'state.resync', acknowledgedAt: at,
    coreRepairOperationId: coreAttemptToken(operationId, 0), attemptRef: { operationId, attemptOrdinal: 0 },
    acceptance: { journalId: 'journal', eventId: String(sequence).padStart(32, '0'), generation } });
  const base = repair();
  let record = repair({ operationId, cause: 'lostJournal', plan: { ...base.plan, correctionId: null,
    publishedVersions: { schemaVersion: 2, adapterVersion: 1 }, skippedRanges: [range],
    inheritedRecovery: operationId === owner.operationId ? { ...owner, operationId: predecessorId } : null } });
  record = selectRecoveryRecord(record, { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }, 'observed', null);
  record = bindRecoveryEvent(record, event);
  record = checkpointRecovery(record, event, generation, sequence, at);
  record = completeRecovery(record, 'journal', generation, at);
  return { record, event };
}

function setup() {
  const predecessor = completed(predecessorId, 2);
  const successor = completed(owner.operationId, 3);
  const skipped = journalEvent(1, { acknowledgedAt: null, acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation } });
  const snapshot: JournalSnapshot = { ...journal(3, 3), events: new Map([
    [1, { metadata: skipped, sha256: 'c'.repeat(64) }],
    [2, { metadata: predecessor.event, sha256: 'd'.repeat(64) }],
    [3, { metadata: successor.event, sha256: 'e'.repeat(64) }],
  ]) };
  const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: null,
    recoveryWitness: { ...witness, phase: 'awaitingDisclosure', disclosure: {
      journalId: 'journal', eventId: successor.event.eventId, sequence: 3, generation } } }, snapshot);
  model.memory.seed(predecessorPath, predecessor.record);
  model.memory.seed(successorPath, successor.record);
  const inputs = async (): Promise<RetentionInputs> => ({ activeJournalId: 'journal', safety: await model.kernel.safety(), operations: (await model.kernel.operations.list()).records,
    events: [...snapshot.events.values()].map(entry => entry.metadata), outbox: new Set<string>(), outboxNames: new Set<string>(),
    sessionGenerations: new Set<string>(), carryPresent: false });
  return { model, snapshot, skipped, inputs };
}

test('a partial inherited proof stays unresolved and protected until its owner proof is published', async () => {
  const { model, snapshot, skipped, inputs } = setup();
  const write = model.memory.write.bind(model.memory);
  const interruption = new Error('Interrupted after predecessor proof publication.');
  let injected = false;
  model.memory.write = async (relative, value, profile, expected, deadline) => {
    const sha256 = await write(relative, value, profile, expected, deadline);
    if (relative === predecessorPath && !injected) { injected = true; throw interruption; }
    return sha256;
  };
  await assert.rejects(reconcileAcknowledgedRecovery(model.kernel), error => error === interruption);
  const partialInputs = await inputs();
  const partial = reconcileRetention(partialInputs);
  assert.equal(partial.provenance.status, 'verified');
  if (partial.provenance.status !== 'verified') { throw new Error('Expected verified provenance.'); }
  assert.equal(partial.provenance.ranges[0]?.discharge, null);
  assert.equal(partial.evidence(skipped).state, 'protected');
  assert.equal(skipped.acknowledgedAt, null);
  assert.equal(partial.protectedOperations.has(predecessorId), true);
  assert.equal(partial.protectedOperations.has(owner.operationId), true);
  assert.deepEqual(selectOperationRetention(partialInputs.operations, partial.protectedOperations, '2028-01-01T00:00:00.0000000Z'), []);
  const withoutSkippedFile = reconcileRetention({ ...partialInputs, events: partialInputs.events.filter(event => event.sequence !== 1) });
  assert.equal(withoutSkippedFile.protectedOperations.has(predecessorId), true);
  assert.equal(withoutSkippedFile.protectedOperations.has(owner.operationId), true);

  await new RecoveryCoordinator(model.kernel).startup();
  stubJournalTransaction(model.kernel, snapshot);
  model.kernel.inspector.metadata = async () => ({ exitCode: 0, stdout: Buffer.from('{"removed":0,"remaining":0}'), stderr: Buffer.alloc(0) });
  await maintainRuntimeStorage(model.kernel);
  assert.equal((await model.kernel.safety()).recoveryWitness?.phase, 'awaitingDisclosure');
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), true);
  const settled = reconcileRetention(await inputs());
  assert.equal(settled.provenance.status, 'verified');
  if (settled.provenance.status !== 'verified') { throw new Error('Expected verified provenance.'); }
  assert.notEqual(settled.provenance.ranges[0]?.discharge, null);
  assert.equal(settled.evidence(skipped).path, 'skipDischarged');
  assert.equal(skipped.acknowledgedAt, null);
  assert.equal((await model.kernel.safety()).recoveryWitness, null);
  const settledInputs = await inputs();
  const successor = settledInputs.operations.find(entry => entry.record.operationId === owner.operationId)!;
  assert.equal(successor.record.kind, 'repair');
  if (successor.record.compacted || successor.record.kind !== 'repair') { throw new Error('Expected a full successor record.'); }
  const episode = successor.record.recovery.episodes[0]!;
  const historical = { ...successor, record: { ...successor.record, recovery: { ...successor.record.recovery,
    episodes: [{ ...episode, prerequisite: { kind: 'gap' as const, nextAction: 0, actions: [], carry: null, carryRelease: null, skippedRanges: [range] } }] } } };
  const historicalGraph = reconcileRetention({ ...settledInputs,
    operations: settledInputs.operations.map(entry => entry.record.operationId === owner.operationId ? historical : entry) });
  assert.equal(historicalGraph.provenance.status, 'verified');
  if (historicalGraph.provenance.status !== 'verified') { throw new Error('Expected verified historical provenance.'); }
  assert.notEqual(historicalGraph.provenance.ranges[0]?.discharge, null);
  const writes = model.memory.writes.length;
  assert.equal(await reconcileAcknowledgedRecovery(model.kernel), false);
  assert.equal(model.memory.writes.length, writes);
});

test('partial proof admission rejects mismatched or incomplete authority', async () => {
  const { model, inputs } = setup();
  const write = model.memory.write.bind(model.memory);
  const interruption = new Error('Interrupted after predecessor proof publication.');
  model.memory.write = async (relative, value, profile, expected, deadline) => {
    const sha256 = await write(relative, value, profile, expected, deadline);
    if (relative === predecessorPath) { throw interruption; }
    return sha256;
  };
  await assert.rejects(reconcileAcknowledgedRecovery(model.kernel), error => error === interruption);
  const valid = await inputs();
  const predecessor = valid.operations.find(entry => entry.record.operationId === predecessorId)!;
  const successor = valid.operations.find(entry => entry.record.operationId === owner.operationId)!;
  assert.equal(predecessor.record.kind, 'repair');
  assert.equal(successor.record.kind, 'repair');
  if (predecessor.record.compacted || predecessor.record.kind !== 'repair' || successor.record.compacted || successor.record.kind !== 'repair') { throw new Error('Expected full repair records.'); }
  const wrongTime = { ...predecessor, record: { ...predecessor.record, plan: { ...predecessor.record.plan,
    skippedRanges: predecessor.record.plan.skippedRanges.map(item => ({ ...item, discharge: { ...item.discharge!, at: '2026-10-08T00:00:01.0000000Z' } })) } } };
  assert.throws(() => reconcileRetention({ ...valid, operations: [wrongTime, successor] }), ControlDocumentError);
  const noOwnerRange = { ...successor, record: { ...successor.record, plan: { ...successor.record.plan, skippedRanges: [] } } };
  assert.throws(() => reconcileRetention({ ...valid, operations: [predecessor, noOwnerRange] }), ControlDocumentError);
  const predecessorEpisode = predecessor.record.recovery.episodes[0]!;
  const prerequisiteOnly = { ...predecessor, record: { ...predecessor.record,
    plan: { ...predecessor.record.plan, skippedRanges: [range] },
    recovery: { ...predecessor.record.recovery, episodes: [{ ...predecessorEpisode,
      prerequisite: { kind: 'gap' as const, nextAction: 0, actions: [], carry: null, carryRelease: null,
        skippedRanges: predecessor.record.plan.skippedRanges } }] } } };
  assert.throws(() => reconcileRetention({ ...valid, operations: [prerequisiteOnly, successor] }), ControlDocumentError);
  assert.throws(() => reconcileRetention({ ...valid, operations: [predecessor] }), ControlDocumentError);
  const witness = valid.safety.recoveryWitness!;
  assert.throws(() => reconcileRetention({ ...valid, safety: { ...valid.safety, recoveryWitness: { ...witness,
    owner: { ...witness.owner, activationId: 'f'.repeat(32) } } } }), ControlDocumentError);
  assert.throws(() => reconcileRetention({ ...valid, safety: { ...valid.safety, pendingCheck: 'f'.repeat(32) } }), ControlDocumentError);
});
