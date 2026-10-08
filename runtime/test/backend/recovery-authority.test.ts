import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reservedWitnessMatches } from '../../src/backend/recovery-authority.ts';
import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { replayCandidate, transferEpisode } from '../../src/recovery-progress.ts';
import { sameRecoveryOwner, SafetyUnavailableError, type RecoveryWitness, type StateSafety } from '../../src/safety-records.ts';
import type { SafetyProof } from '../../src/safety.ts';
import { at, authorityModel, correctionId, generation, journal, owner, repair, witness } from './authority-fixtures.ts';
import { DataRootUnavailableError } from '../../src/admission.ts';
import { bytesHash } from '../../src/storage.ts';

describe('reserved recovery ownership', () => {
  it('requires the exact active plan before activating a preparing witness', () => {
    const preparing = { ...witness, phase: 'preparing' as const };
    assert.equal(reservedWitnessMatches(preparing, repair()), true);
    assert.equal(reservedWitnessMatches({ ...preparing, owner: { ...owner, activationId: 'f'.repeat(32) } }, repair()), false);
    assert.equal(reservedWitnessMatches({ ...preparing, scopeSha256: '0'.repeat(64) }, repair()), false);
    assert.equal(reservedWitnessMatches(preparing, repair({ operationId: `jr-${'9'.repeat(32)}` })), false);
  });

  it('preserves exact predecessor ownership across roots and episode transfers', () => {
    const source = repair();
    const successor = { operationId: `jr-${'8'.repeat(32)}`, episodeOrdinal: 0, activationId: owner.activationId };
    const previous = { ...owner, activationId: '7'.repeat(32) };
    const transfer: RecoveryWitness = { ...witness, owner: previous, phase: 'transferring', successor };
    const candidate = repair({ operationId: successor.operationId, plan: { ...source.plan, inheritedRecovery: previous } });
    assert.equal(reservedWitnessMatches(transfer, candidate), true);
    assert.equal(reservedWitnessMatches(transfer, { ...candidate, plan: { ...candidate.plan, inheritedRecovery: null } }), false);
    const moved = transferEpisode(source, { ...source.recovery.episodes[0]!, activationId: '6'.repeat(32), trigger: 'gap' }, at);
    const withinRoot: RecoveryWitness = { ...witness, phase: 'transferring', successor: { ...owner, episodeOrdinal: 1, activationId: '6'.repeat(32) } };
    assert.equal(reservedWitnessMatches(withinRoot, moved), true);
    assert.equal(reservedWitnessMatches({ ...withinRoot, owner: { ...owner, activationId: '5'.repeat(32) } }, moved), false);
  });

  it('admits completed replay without rewriting the historical terminal episode', () => {
    const source = repair();
    const terminal = repair({ ...source, completedAt: at, outcome: 'recordRejected', recovery: { ...source.recovery, activeEpisode: null,
      episodes: [{ ...source.recovery.episodes[0]!, phase: 'recordRejected', endedAt: at }] } });
    const replayed = replayCandidate(terminal, '4'.repeat(32), at);
    assert.equal(reservedWitnessMatches({ ...witness, phase: 'transferring', successor: { ...owner, episodeOrdinal: 1, activationId: '4'.repeat(32) } }, replayed), true);
    assert.deepEqual(replayed.recovery.episodes[0], terminal.recovery.episodes[0]);
  });
});

describe('deciding authority controls', () => {
  it('recovers the direct lost-owner control with real control persistence', async () => {
    const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'coreRejected', recoveryOperationId: owner.operationId }, recoveryWitness: witness };
    const model = authorityModel(initial);
    await new RecoveryCoordinator(model.kernel).reconcileSafety();
    const safety = await model.kernel.safety();
    assert.equal(safety.recoveryWitness?.phase, 'active');
    assert.equal(safety.correction?.recoveryOperationId, safety.recoveryWitness?.owner.operationId);
    assert.equal(safety.correction?.correctionId, correctionId);
    assert.equal(safety.correction?.reason, 'coreRejected');
    assert.equal((await model.records()).length, 1);
  });

  it('preserves the older correction when an activated successor is lost before pointer transfer', async context => {
    const older = `jr-${'9'.repeat(32)}`;
    const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'coreRejected', recoveryOperationId: older }, recoveryWitness: witness };
    const model = authorityModel(initial);
    let failure: unknown;
    try { await new RecoveryCoordinator(model.kernel).reconcileSafety(); } catch (error) { failure = error; }
    const safety = await model.kernel.safety();
    const records = await model.records();
    context.diagnostic(JSON.stringify({ error: failure instanceof Error ? failure.message : null, correctionOwner: safety.correction?.recoveryOperationId,
      witnessOwner: safety.recoveryWitness?.owner.operationId, witnessPhase: safety.recoveryWitness?.phase, operations: records.length }));
    assert.equal(failure, undefined, 'A newer witnessed predecessor and an older correction pointer are separate preserved duties.');
    assert.equal(safety.correction?.recoveryOperationId, safety.recoveryWitness?.owner.operationId);
    assert.equal(safety.correction?.correctionId, correctionId);
    assert.equal(safety.correction?.reason, 'coreRejected');
    assert.equal(records.length, 1);
    assert.ok(!records[0]!.compacted && records[0]!.kind === 'repair');
    if (!records[0]!.compacted && records[0]!.kind === 'repair') { assert.deepEqual(records[0]!.plan.inheritedRecovery, witness.owner); }
  });

  it('binds exact invalid predecessor bytes independently for both lost owners', async () => {
    for (const invalid of ['correction', 'witness', 'both']) {
      const older = `jr-${'9'.repeat(32)}`;
      const model = authorityModel({ stateSafetyVersion: 1, generation, pendingCheck: null,
        correction: { correctionId, reason: 'coreRejected', recoveryOperationId: older }, recoveryWitness: witness });
      const damaged = new Map<string, Buffer>();
      if (invalid !== 'witness') { damaged.set(older, Buffer.from('invalid older correction root')); }
      if (invalid !== 'correction') { damaged.set(owner.operationId, Buffer.from('invalid witnessed root')); }
      for (const [id, bytes] of damaged) { model.memory.files.set(`operations/${id}.json`, bytes); }
      await new RecoveryCoordinator(model.kernel).reconcileSafety();
      const safety = await model.kernel.safety();
      assert.equal(safety.correction?.recoveryOperationId, safety.recoveryWitness?.owner.operationId);
      const replacement = (await model.records()).find(record => record.operationId === safety.correction?.recoveryOperationId)!;
      assert.ok(!replacement.compacted && replacement.kind === 'repair');
      assert.deepEqual(replacement.plan.inheritedRecovery, owner);
      for (const [id, bytes] of damaged) { assert.ok(replacement.plan.lostOperations.some(lost => lost.name === `${id}.json` && lost.sha256 === bytesHash(bytes))); }
    }
  });

  it('keeps the correction pointer when either required predecessor is unreadable', async () => {
    for (const unreadable of [`jr-${'9'.repeat(32)}`, owner.operationId]) {
      const initial: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
        correction: { correctionId, reason: 'coreRejected', recoveryOperationId: `jr-${'9'.repeat(32)}` }, recoveryWitness: witness };
      const model = authorityModel(initial);
      model.memory.files.set(`operations/${unreadable}.json`, Buffer.from('unreadable root'));
      model.memory.unreadable.add(`operations/${unreadable}.json`);
      await assert.rejects(new RecoveryCoordinator(model.kernel).reconcileSafety(), DataRootUnavailableError);
      assert.deepEqual((await model.kernel.safety()).correction, initial.correction);
      assert.equal(model.memory.writes.length, 0);
    }
  });
});

describe('successor plan resume ordering', () => {
  it('activates the durable reserved owner before rebinding an older lost correction pointer', async () => {
    const predecessorId = `jr-${'9'.repeat(32)}`;
    const planned = repair();
    let safety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null,
      correction: { correctionId, reason: 'coreRejected', recoveryOperationId: predecessorId }, recoveryWitness: { ...witness, phase: 'preparing' } };
    const writes: string[] = [];
    const stop = new Error('Stop after durable pointer publication.');
    const inventory = { records: [{ record: planned, sha256: 'a'.repeat(64) }], invalid: [], fullTerminalCount: 0, handoffCount: 0 };
    const kernel = { guard: { held: true }, scope: { bindingSha256: witness.scopeSha256 }, safety: async () => safety, carryHash: async () => null,
      operations: { list: async () => inventory, read: async (id: string) => id === planned.operationId ? { status: 'valid', value: planned, sha256: 'a'.repeat(64) } : { status: 'absent' } },
      journal: { read: async () => journal() }, safetyStore: {
        read: async () => ({ status: 'valid', value: safety, sha256: 'b'.repeat(64) }),
        activateWitness: async (candidate: typeof owner, proof: SafetyProof) => {
          assert.equal(sameRecoveryOwner(candidate, owner), true);
          assert.equal(await proof.verify(safety), true);
          writes.push('active'); safety = { ...safety, recoveryWitness: { ...witness, phase: 'active' } };
        },
        invalidate: async () => { writes.push('generation'); safety = { ...safety, generation: 'd'.repeat(32) }; return { value: safety, sha256: 'b'.repeat(64) }; },
        transferCorrection: async (id: string, prior: string, successor: string, proof: SafetyProof) => {
          assert.equal(safety.recoveryWitness?.phase, 'active');
          assert.equal(id, correctionId); assert.equal(prior, predecessorId); assert.equal(successor, owner.operationId);
          assert.equal(await proof.verify(safety), true);
          writes.push('pointer'); safety = { ...safety, correction: { ...safety.correction!, recoveryOperationId: successor } }; throw stop;
        },
      } } as unknown as Kernel;
    await assert.rejects(new RecoveryCoordinator(kernel).reconcileSafety(), error => error === stop);
    assert.deepEqual(writes, ['active', 'generation', 'pointer']);
    assert.equal(safety.correction?.reason, 'coreRejected');
    assert.equal(safety.correction?.correctionId, correctionId);
    assert.equal(safety.correction?.recoveryOperationId, owner.operationId);
  });

  it('does not allocate a replacement for a content-invalid reserved plan', async () => {
    let writes = 0;
    const safety: StateSafety = { stateSafetyVersion: 1, generation, pendingCheck: null, correction: null, recoveryWitness: { ...witness, phase: 'preparing' } };
    const kernel = { carryHash: async () => null, safetyStore: { read: async () => ({ status: 'valid', value: safety, sha256: 'b'.repeat(64) }), invalidate: async () => { writes++; } },
      operations: { list: async () => ({ records: [], invalid: [{ name: `${owner.operationId}.json`, sha256: 'c'.repeat(64) }], fullTerminalCount: 0, handoffCount: 0 }),
        read: async () => ({ status: 'invalid', sha256: 'c'.repeat(64) }) } } as unknown as Kernel;
    await assert.rejects(new RecoveryCoordinator(kernel).reconcileSafety(), SafetyUnavailableError);
    assert.equal(writes, 0);
  });
});
