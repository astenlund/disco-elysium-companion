import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConsumerCoordinator, ReleaseRefusedError } from '../../src/backend/consumer.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { releaseJournalEvidence, releaseNamesWitness } from '../../src/backend/release-authority.ts';
import { eventFileName } from '../../src/journal-records.ts';
import type { JournalSnapshot } from '../../src/journal.ts';
import { parseOperation, type HandoverOperation, type OperationRecord, type RepairOperation, type ReleaseOperation } from '../../src/operation-records.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import { abandonRecovery } from '../../src/recovery-progress.ts';
import type { RecoveryWitness, StateSafety } from '../../src/safety-records.ts';
import type { SafetyProof } from '../../src/safety.ts';
import { admittedCapacityFixture, at, authorityModel, correctionId, deferredRepair, generation, journal, owner, release, repair, scope, witness } from './authority-fixtures.ts';

describe('release obligation evidence', () => {
  const names = [eventFileName(2), eventFileName(1)];

  it('refuses confirmed release for an abandoned but unresolved deferred carry', async () => {
    const original = deferredRepair();
    const abandoned = repair({ ...original, completedAt: at, outcome: 'abandonedByRelease', recovery: { ...original.recovery, activeEpisode: null,
      episodes: [{ ...original.recovery.episodes[0]!, phase: 'abandonedByRelease', releaseOperationId: release().operationId, endedAt: at }] } });
    const model = authorityModel();
    model.memory.seed('operations/' + abandoned.operationId + '.json', abandoned);
    const before = [...model.memory.files];
    await assert.rejects(new ConsumerCoordinator(model.kernel).switch('bridge', false), error => error instanceof ReleaseRefusedError && error.details.includes('waitingReplacement'));
    assert.deepEqual([...model.memory.files], before);
  });

  it('preserves the carry, binding and handoff across explicit abandon and re-hand-over', async () => {
    const original = deferredRepair();
    const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: witness });
    model.memory.seed('operations/' + original.operationId + '.json', original);
    const bytes = Buffer.from('Exact protected fixture bytes.');
    model.memory.files.set('journal/recovery-event.json', bytes);
    model.kernel.carryHash = async () => '7'.repeat(64);
    let calls = 0;
    model.kernel.core.consumer = async request => {
      calls++;
      return { success: true, value: { owner: request.owner, previousOwner: request.owner === 'bridge' ? 'runtime' : 'bridge', changed: true,
        baselineRemoved: request.owner === 'bridge', abandonedCount: 0 } };
    };
    const consumer = new ConsumerCoordinator(model.kernel);
    assert.equal((await consumer.switch('bridge', true)).success, true);
    assert.equal((await consumer.switch('runtime', false)).success, true);
    assert.equal(calls, 2);
    assert.deepEqual(model.memory.files.get('journal/recovery-event.json'), bytes);
    const retained = (await model.records()).find(record => record.operationId === original.operationId) as RepairOperation;
    assert.equal(retained.recovery.activeEpisode, null);
    assert.equal(retained.recovery.episodes[0]!.phase, 'abandonedByRelease');
    assert.deepEqual(retained.recovery.episodes[0]!.prerequisite, original.recovery.episodes[0]!.prerequisite);
    assert.deepEqual(retained.plan.handoffs, original.plan.handoffs);
  });

  it('retains canonical filenames when payloads or the journal header cannot be admitted', () => {
    const damaged = { ...journal(2, 1), damaged: [{ status: 'invalid' as const, path: names[0]!, sha256: null }] };
    assert.deepEqual(releaseJournalEvidence(damaged, names).abandonedSequences, [2]);
    for (const snapshot of [null, { ...damaged, header: { status: 'absent' as const } }, { ...damaged, header: { status: 'invalid' as const } }]) {
      const evidence = releaseJournalEvidence(snapshot, names);
      assert.equal(evidence.header, null);
      assert.equal(evidence.cursor, null);
      assert.deepEqual(evidence.abandonedSequences, [1, 2]);
    }
  });

  it('does not treat an absent, invalid, mismatched or out-of-range cursor as acknowledgement', () => {
    const snapshot = journal(2, 1);
    assert.equal(snapshot.cursor.status, 'valid');
    if (snapshot.cursor.status !== 'valid') { return; }
    const variants: JournalSnapshot['cursor'][] = [{ status: 'absent' }, { status: 'invalid' },
      { ...snapshot.cursor, value: { ...snapshot.cursor.value, journalId: 'different' } },
      { ...snapshot.cursor, value: { ...snapshot.cursor.value, lastAckedSequence: 3 } },
      { ...snapshot.cursor, value: { ...snapshot.cursor.value, lastSentSequence: 3 } }];
    for (const cursor of variants) { assert.deepEqual(releaseJournalEvidence({ ...snapshot, cursor }, names).abandonedSequences, [1, 2]); }
    assert.throws(() => releaseJournalEvidence(snapshot, ['unrecognized.json']));
  });

  it('binds the completed release to the exact witness and completed discharge', () => {
    const completed = release();
    assert.equal(releaseNamesWitness(completed, witness), true);
    const variants: RecoveryWitness[] = [{ ...witness, scopeSha256: 'f'.repeat(64) }, { ...witness, phase: 'preparing' },
      { ...witness, owner: { ...owner, activationId: '5'.repeat(32) } }, { ...witness, owner: { ...owner, episodeOrdinal: 1 } },
      { ...witness, owner: { ...owner, operationId: `jr-${'6'.repeat(32)}` } },
      { ...witness, phase: 'transferring', successor: { ...owner, activationId: '7'.repeat(32) } }];
    for (const other of variants) { assert.equal(releaseNamesWitness(completed, other), false); }
    assert.equal(releaseNamesWitness({ ...completed, completedAt: null, outcome: null }, witness), false);
    assert.equal(releaseNamesWitness({ ...completed, plan: { ...completed.plan, completedPhases: ['coreSwitched'] } }, witness), false);
    assert.equal(releaseNamesWitness({ ...completed, plan: { ...completed.plan, skippedRanges: [{ journalId: 'journal', firstSequence: 1, lastSequence: 2, reason: 'abandonRelease', discharge: null }] } }, witness), false);
  });

  it('requires a recorded exact owner when the fixed witness was unreadable during release', () => {
    const completed = release();
    const unknown = release({ plan: { ...completed.plan, witness: null, witnessUnavailable: true } });
    assert.equal(releaseNamesWitness(unknown, witness), true);
    assert.equal(releaseNamesWitness({ ...unknown, plan: { ...unknown.plan, unfinishedRepairs: [] } }, witness), false);
  });

  it('unions discovered filenames and quarantined sequences retained by an unfinished repair before recording intent', async () => {
    const source = repair();
    const active = repair({ plan: { ...source.plan, affected: [{ sequence: 5, eventId: '5'.repeat(32), fileSha256: '6'.repeat(64) }] } });
    const stop = new Error('Stop after observing the complete intent.');
    const intents: ReleaseOperation[] = [];
    let reservations = 0;
    const kernel = { scope: { bindingSha256: scope }, journal: { read: async () => ({ ...journal(), header: { status: 'invalid' }, fault: 'header' }) },
      operations: { list: async () => ({ records: [{ record: active, sha256: '7'.repeat(64) }], invalid: [], fullTerminalCount: 0, handoffCount: 0 }),
        create: async (record: ReleaseOperation) => {
          const validated = parseOperation(parseStrictJson(Buffer.from(stringifyJson(record, 'state-event')), 'state-event'), scope);
          assert.ok(!validated.compacted && validated.kind === 'release');
          intents.push(validated); throw stop;
        } },
      safety: async () => ({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness }),
      outbox: { list: async () => [] }, storage: { list: async (relative: string) => { assert.equal(relative, 'journal/events'); return names; } },
      resources: { ...admittedCapacityFixture(), reserve: async () => { reservations++; } } } as unknown as Kernel;
    const consumer = new ConsumerCoordinator(kernel);
    await assert.rejects(consumer.switch('bridge', false), ReleaseRefusedError);
    assert.equal(reservations, 0);
    assert.equal(intents.length, 0);
    await assert.rejects(consumer.switch('bridge', true), error => error === stop);
    assert.equal(reservations, 1);
    assert.deepEqual(intents[0]!.plan.abandonedSequences, [1, 2, 5]);
    assert.equal(intents[0]!.plan.journalId, null);
    assert.deepEqual(intents[0]!.plan.skippedRanges, []);
    assert.deepEqual(intents[0]!.plan.unfinishedRepairs, [owner]);
  });

  it('refuses incomplete filename enumeration without recording intent or beginning a switch', async () => {
    const denied = new Error('Directory enumeration failed.');
    let mutations = 0;
    const kernel = { journal: { read: async () => { throw new Error('Journal is unreadable.'); } },
      operations: { list: async () => ({ records: [], invalid: [], fullTerminalCount: 0, handoffCount: 0 }), create: async () => { mutations++; } },
      safety: async () => ({ stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: null }),
      outbox: { list: async () => [] }, storage: { list: async () => { throw denied; } }, resources: { ...admittedCapacityFixture(), reserve: async () => { mutations++; } } } as unknown as Kernel;
    await assert.rejects(new ConsumerCoordinator(kernel).switch('bridge', true), error => error === denied);
    assert.equal(mutations, 0);
  });
});

describe('phase-E consumer routing', () => {
  it('preserves pending-first order, current release result and prior failures', async () => {
    const consumer = new ConsumerCoordinator({ resources: admittedCapacityFixture() } as unknown as Kernel);
    const calls: string[] = [];
    consumer.pending = async () => { calls.push('pending'); return true; };
    consumer.switch = async selected => { calls.push(selected); return { success: true, value: { owner: selected, previousOwner: 'runtime', changed: false, baselineRemoved: false, abandonedCount: 0 } }; };
    assert.deepEqual(await consumer.startup({ kind: 'chat' }), { notOwner: true, consumerResult: null, requiredWorkCompleted: true, capacityRewind: null });
    assert.deepEqual(calls, ['pending']);
    calls.length = 0;
    assert.equal((await consumer.startup({ kind: 'consumer', owner: 'runtime', abandonUndelivered: false }))?.notOwner, false);
    assert.deepEqual(calls, ['pending', 'runtime']);
    calls.length = 0;
    const failure = new Error('pending failed');
    consumer.pending = async () => { calls.push('pending'); throw failure; };
    await assert.rejects(consumer.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true }), error => error === failure);
    assert.deepEqual(calls, ['pending']);
  });
});

describe('deciding authority controls', () => {
  it('records explicit abandon discharge for an inherited synthetic cursor range before clearing its witness', async context => {
    const range = { journalId: 'journal', firstSequence: 1, lastSequence: 1, reason: 'cursorRecovery' as const, discharge: null };
    const source = repair();
    const active = repair({ cause: 'cursor', plan: { ...source.plan, cursorTo: 1, skippedRanges: [range] }, recovery: { ...source.recovery,
      episodes: [{ ...source.recovery.episodes[0]!, prerequisite: { kind: 'cursor', actions: [], nextAction: 0, carry: null, carryRelease: null, skippedRanges: [range] } }] } });
    const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness };
    const model = authorityModel(initial, { ...journal(1, 1), historicalGaps: [{ from: 1, to: 1 }] });
    model.memory.seed(`operations/${active.operationId}.json`, active);
    model.kernel.core.consumer = async () => ({ success: true, value: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: true, abandonedCount: 0 } });
    assert.equal((await new ConsumerCoordinator(model.kernel).startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true }))?.consumerResult?.success, true);
    const records = await model.records();
    const abandoned = records.find(record => record.operationId === active.operationId) as RepairOperation;
    const completed = records.find(record => record.kind === 'release') as ReleaseOperation;
    const safety = await model.kernel.safety();
    context.diagnostic(JSON.stringify({ releaseCompleted: completed.outcome === 'completed', witnessCleared: safety.recoveryWitness === null,
      inheritedDischarge: abandoned.plan.skippedRanges[0]?.discharge, releaseRanges: completed.plan.skippedRanges }));
    assert.equal(abandoned.plan.skippedRanges[0]?.discharge?.kind, 'abandonRelease');
    assert.equal(abandoned.plan.skippedRanges[0]?.discharge?.operationId, completed.operationId);
    assert.ok(completed.plan.skippedRanges.some(value => value.journalId === range.journalId && value.firstSequence === 1 && value.lastSequence === 1));
    assert.equal(model.memory.writes.some(relative => relative.startsWith('journal/events/')), false, 'Synthetic discharge never stamps actual acknowledgement.');
    assert.equal(safety.correction?.correctionId, correctionId);
  });

  it('does not leave an older unfinished handover able to reverse a successful newer release', async context => {
    const pending: HandoverOperation = { operationVersion: 1, operationId: `ho-${'8'.repeat(32)}`, scopeSha256: scope, kind: 'handover', cause: 'handover', compacted: false,
      startedAt: at, completedAt: null, outcome: null, safety: { obligationId: '9'.repeat(32), phase: 'pending', correctionId: null }, plan: { owner: 'runtime', result: null, completedPhases: [] } };
    const model = authorityModel();
    model.memory.seed(`operations/${pending.operationId}.json`, pending);
    let consumerOwner: 'runtime' | 'bridge' = 'runtime';
    let rejectionPending = true;
    const observations: string[] = [];
    model.kernel.core.consumer = async request => {
      if (request.owner === 'runtime' && rejectionPending) {
        observations.push('runtime:refused');
        return { success: false, class: 'outbox', reason: 'outbox-record-invalid', consumptionState: 'none', generationTimestamp: null, warnings: [] };
      }
      const previousOwner = consumerOwner;
      consumerOwner = request.owner;
      if (consumerOwner === 'bridge') { rejectionPending = false; }
      observations.push(consumerOwner + ':succeeded');
      return { success: true, value: { owner: consumerOwner, previousOwner, changed: previousOwner !== consumerOwner, baselineRemoved: consumerOwner === 'bridge', abandonedCount: 0 } };
    };
    const consumer = new ConsumerCoordinator(model.kernel);
    const newer = await consumer.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true });
    if (newer?.consumerResult?.success !== true) {
      assert.deepEqual(observations, ['runtime:refused']);
      assert.equal((await model.records()).some(record => record.kind === 'release'), false);
      return;
    }
    const prior = (await model.records()).find(record => record.operationId === pending.operationId)!;
    await consumer.startup({ kind: 'chat' });
    context.diagnostic(JSON.stringify({ newerReleaseSucceeded: true, olderIntentCompletedAtRelease: prior.completedAt !== null,
      ownerAfterNextStart: consumerOwner, observations }));
    assert.notEqual(prior.completedAt, null, 'A successful newer switch cannot leave its unfinished predecessor queued.');
    assert.equal(consumerOwner, 'bridge');
  });

  it('retains the release intent through an inherited carrier write failure and resumes its exact discharge', async () => {
    const source = repair();
    const range = { journalId: 'older-journal', firstSequence: 3, lastSequence: 7, reason: 'cursorRecovery' as const, discharge: null };
    const active = repair({ plan: { ...source.plan, skippedRanges: [range] } });
    const historical = repair({ operationId: `jr-${'8'.repeat(32)}`, completedAt: at, outcome: 'recordRejected',
      plan: { ...source.plan, correctionId: null, skippedRanges: [range] }, recovery: { ...source.recovery, activeEpisode: null,
        episodes: [{ ...source.recovery.episodes[0]!, phase: 'recordRejected', endedAt: at }] } });
    const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: owner.operationId }, recoveryWitness: witness });
    model.memory.seed(`operations/${active.operationId}.json`, active);
    model.memory.seed(`operations/${historical.operationId}.json`, historical);
    model.kernel.core.consumer = async () => ({ success: true, value: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: true, abandonedCount: 0 } });
    const write = model.memory.write.bind(model.memory);
    const failure = new Error('Carrier publication refused.');
    model.memory.write = async (...args) => {
      if (args[0] === `operations/${historical.operationId}.json`) { throw failure; }
      return write(...args);
    };
    const consumer = new ConsumerCoordinator(model.kernel);
    await assert.rejects(consumer.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true }), error => error === failure);
    const releaseBefore = (await model.records()).find(record => record.kind === 'release') as ReleaseOperation;
    assert.equal(releaseBefore.completedAt, null);
    assert.equal(releaseBefore.plan.skippedRanges.length, 1);
    assert.equal(releaseBefore.plan.skippedRanges[0]!.discharge?.operationId, releaseBefore.operationId);
    assert.notEqual((await model.kernel.safety()).recoveryWitness, null);
    model.memory.write = write;
    assert.equal(await consumer.pending(), true);
    const repaired = (await model.records()).find(record => record.operationId === historical.operationId) as RepairOperation;
    assert.deepEqual(repaired.recovery, historical.recovery, 'Historical episodes remain immutable.');
    assert.deepEqual(repaired.plan.skippedRanges[0]!.discharge, releaseBefore.plan.skippedRanges[0]!.discharge);
    assert.equal((await model.kernel.safety()).recoveryWitness, null);
    assert.equal(model.memory.writes.some(value => value.startsWith('journal/events/')), false);
    assert.equal((await model.records()).filter(record => record.kind === 'release').length, 1);
  });

  it('refuses ambiguous multiple unfinished consumer intents before calling the core', async () => {
    const model = authorityModel();
    const base = release();
    for (const digit of ['5', '6']) {
      model.memory.seed(`operations/rl-${digit.repeat(32)}.json`, release({ operationId: `rl-${digit.repeat(32)}`, completedAt: null, outcome: null,
        plan: { ...base.plan, result: null, completedPhases: [] } }));
    }
    let calls = 0;
    model.kernel.core.consumer = async () => { calls++; throw new Error('Must not run.'); };
    await assert.rejects(new ConsumerCoordinator(model.kernel).startup({ kind: 'consumer', owner: 'runtime', abandonUndelivered: false }), ControlDocumentError);
    assert.equal(calls, 0);
    assert.equal(model.memory.writes.length, 0);
  });
});

function coordinator(completed: ReleaseOperation, retained: RepairOperation | null, initialWitness = witness, unreadable = false) {
  let safety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: { correctionId, reason: 'contextUncertain', recoveryOperationId: null }, recoveryWitness: initialWitness };
  let writes = 0;
  const errors: unknown[] = [];
  const records = [completed, ...(retained === null ? [] : [retained])];
  const inventory = { records: records.map(record => ({ record, sha256: 'd'.repeat(64) })), invalid: [], fullTerminalCount: records.length, handoffCount: 0 };
  const kernel = { resources: admittedCapacityFixture(), operations: { list: async () => inventory, read: async (id: string) => {
    if (unreadable && id === owner.operationId) { throw new Error('read refused'); }
    const value: OperationRecord | undefined = records.find(record => record.operationId === id);
    return value === undefined ? { status: 'absent' } : { status: 'valid', value, sha256: 'd'.repeat(64) };
  } }, safety: async () => safety, safetyStore: { dischargeWitness: async (_: unknown, kind: string, proof: SafetyProof) => {
    assert.equal(kind, 'abandoned');
    if (!await proof.verify(safety)) { return false; }
    writes++; safety = { ...safety, recoveryWitness: null }; return true;
  } }, diagnose: (_: string, error: unknown) => { errors.push(error); } } as unknown as Kernel;
  return { value: new ConsumerCoordinator(kernel), safety: () => safety, writes: () => writes, errors };
}

describe('completed release reconciliation', () => {
  it('finishes the matching witness clear without claiming current bridge ownership or clearing correction', async () => {
    const completed = release();
    const fixture = coordinator(completed, abandonRecovery(repair(), completed.operationId, at));
    assert.equal(await fixture.value.pending(), false);
    assert.equal(fixture.writes(), 1);
    assert.equal(fixture.safety().recoveryWitness, null);
    assert.equal(fixture.safety().generation, generation);
    assert.equal(fixture.safety().correction?.correctionId, correctionId);
    assert.deepEqual(fixture.errors, []);
    await fixture.value.pending();
    assert.equal(fixture.writes(), 1);
  });

  it('preserves mismatched activations, contradictory readable roots and unreadable authority', async () => {
    const completed = release();
    const abandoned = abandonRecovery(repair(), completed.operationId, at);
    for (const fixture of [coordinator(completed, abandoned, { ...witness, owner: { ...owner, activationId: '8'.repeat(32) } }),
      coordinator(completed, repair()), coordinator(completed, abandoned, witness, true)]) {
      const before = fixture.safety();
      await fixture.value.pending();
      assert.deepEqual(fixture.safety(), before);
      assert.equal(fixture.writes(), 0);
    }
  });

  it('can discharge a missing historical root only from an exact recorded witness', async () => {
    const fixture = coordinator(release(), null);
    await fixture.value.pending();
    assert.equal(fixture.writes(), 1);
    const completed = release();
    const unknown = coordinator(release({ plan: { ...completed.plan, witness: null, witnessUnavailable: true } }), null);
    await unknown.value.pending();
    assert.equal(unknown.writes(), 0);
  });

  it('releases an awaiting disclosure without rewriting its historical completed episode', async () => {
    const source = repair();
    const accepted = { journalId: 'journal', eventId: '9'.repeat(32), sequence: 1, generation, acceptedAt: at };
    const terminal = repair({ completedAt: at, outcome: 'completed', recovery: {
      attempts: [{ publication: 'observed', selectedRecord: { logicalOutboxId: `${'8'.repeat(32)}-1`, recordSha256: '7'.repeat(64) },
        journalEvent: { journalId: accepted.journalId, eventId: accepted.eventId, sequence: accepted.sequence } }],
      episodes: [{ ...source.recovery.episodes[0]!, phase: 'completed', acceptedRecovery: accepted, endedAt: at }], activeEpisode: null,
    } });
    const awaiting: RecoveryWitness = { ...witness, phase: 'awaitingDisclosure', disclosure: { journalId: accepted.journalId, eventId: accepted.eventId, sequence: accepted.sequence, generation } };
    const completed = release();
    const fixture = coordinator(release({ plan: { ...completed.plan, witness: awaiting, unfinishedRepairs: [] } }), terminal, awaiting);
    const before = structuredClone(terminal);
    await fixture.value.pending();
    assert.equal(fixture.writes(), 1);
    assert.deepEqual(terminal, before);
    assert.equal(fixture.safety().correction?.correctionId, correctionId);
  });

  it('checks recorded owners when an unreadable fixed witness later becomes available', async () => {
    const completed = release();
    const unknown = release({ plan: { ...completed.plan, witness: null, witnessUnavailable: true } });
    const fixture = coordinator(unknown, abandonRecovery(repair(), completed.operationId, at));
    await fixture.value.pending();
    assert.equal(fixture.writes(), 1);
    const contradictory = coordinator(unknown, repair());
    await contradictory.value.pending();
    assert.equal(contradictory.writes(), 0);
  });
});
