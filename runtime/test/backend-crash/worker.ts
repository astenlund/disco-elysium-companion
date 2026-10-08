import assert from 'node:assert/strict';
import { writeSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { openBackend } from '../../src/backend/index.ts';
import { ReleaseRefusedError } from '../../src/backend/consumer.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import { Deadline } from '../../src/deadline.ts';
import type { OperationRecord, RepairOperation } from '../../src/operation-records.ts';
import { activeRecoveryOwner } from '../../src/recovery-progress.ts';
import type { StateSafety } from '../../src/safety-records.ts';
import { bytesHash } from '../../src/storage.ts';
import { crashExit, publicationExit, privateFixture, sourceManifest, type ChildProof, type RecoveryCut, type ReleaseCut } from './support.ts';

const root = privateFixture(process.argv[2] ?? '');
const mode = process.argv[3] ?? '';
const boundary = process.argv[4] ?? '';
const manifest = await sourceManifest();
const diagnostics: string[] = [];
const backend = await openBackend({ companionRoot: root, onDiagnostic: (phase, error) => { diagnostics.push(`${phase}: ${error instanceof Error ? error.message : String(error)}`); } });
const k = (backend as unknown as { readonly kernel: Kernel }).kernel;
const run = backend.supervisor.run.bind(backend.supervisor);
const processHistory: Record<string, unknown>[] = [];
let processOrdinal = 0;
let failureTraces = 0;
backend.supervisor.run = async (role, options, timeout, input) => {
  const startedAt = performance.now();
  const fileArgument = options.args.indexOf('-File');
  const entry: Record<string, unknown> = { ordinal: ++processOrdinal, role, script: fileArgument < 0 ? null : path.basename(options.args[fileArgument + 1] ?? ''), timeout, outcome: 'started' };
  processHistory.push(entry);
  if (processHistory.length > 32) { processHistory.shift(); }
  try {
    const result = await run(role, options, timeout, input);
    entry.outcome = 'completed'; entry.exitCode = result.exitCode;
    return result;
  } catch (error) {
    entry.outcome = 'failed'; entry.error = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
    entry.reason = error !== null && typeof error === 'object' && 'reason' in error ? error.reason : null;
    entry.elapsedMs = Math.round(performance.now() - startedAt);
    if (failureTraces++ < 4) { writeSync(2, JSON.stringify({ fixtureProcessFailure: true, mode, boundary, history: processHistory }) + '\n'); }
    throw error;
  } finally { entry.elapsedMs = Math.round(performance.now() - startedAt); }
};

function proof(value: Omit<ChildProof, 'dataRoot' | 'sourceManifest'>): ChildProof {
  return { ...value, dataRoot: backend.scope.dataRoot, sourceManifest: manifest };
}

function exitAt(value: Omit<ChildProof, 'dataRoot' | 'sourceManifest'>, code: number): never {
  writeSync(1, JSON.stringify(proof(value)) + '\n');
  process.exit(code);
}

function releaseMatch(relative: string, value: unknown, cut: ReleaseCut): boolean {
  const operation = value as OperationRecord;
  const release = relative.startsWith('operations/') && !operation.compacted && operation.kind === 'release' ? operation : null;
  const repair = relative.startsWith('operations/') && !operation.compacted && operation.kind === 'repair' ? operation : null;
  const safety = relative === 'state-safety.json' ? value as StateSafety : null;
  switch (cut) {
    case 'intent': return release !== null && release.safety.phase === 'pending' && release.plan.result === null;
    case 'safetyTransferred': return release !== null && release.safety.phase === 'transferred' && release.plan.result === null;
    case 'coreSwitched': return release !== null && release.plan.completedPhases.includes('coreSwitched');
    case 'rangesDischarged': return release !== null && release.plan.skippedRanges.some(range => range.discharge !== null);
    case 'cursorAdvanced': return relative === 'journal/cursor-agent-session.json' && (value as { lastAckedSequence: number }).lastAckedSequence > 0;
    case 'historyVerified': return relative === 'journal/journal.json' && (value as { historyVerified: boolean }).historyVerified;
    case 'repairAbandoned': return repair !== null && repair.recovery.episodes.at(-1)?.phase === 'abandonedByRelease';
    case 'correctionDetached': return safety?.correction !== null && safety?.correction !== undefined && safety.correction.recoveryOperationId === null;
    case 'dischargesPublished': return release !== null && release.plan.completedPhases.includes('dischargesPublished');
    case 'complete': return release !== null && release.completedAt !== null;
    case 'witnessCleared': return safety !== null && safety.recoveryWitness === null;
  }
}

function recoveryMatch(relative: string, value: unknown, cut: RecoveryCut, predecessor: string): boolean {
  const safety = relative === 'state-safety.json' ? value as StateSafety : null;
  const operation = value as OperationRecord;
  const repair = relative.startsWith('operations/') && !operation.compacted && operation.kind === 'repair' && operation.operationId !== predecessor ? operation : null;
  switch (cut) {
    case 'witnessReserved': return safety?.recoveryWitness?.phase === 'preparing' || safety?.recoveryWitness?.phase === 'transferring';
    case 'successorRecorded': return repair !== null;
    case 'witnessActivated': return safety?.recoveryWitness?.phase === 'active' && safety.recoveryWitness.owner.operationId !== predecessor;
    case 'correctionTransferred': return safety?.correction?.recoveryOperationId !== undefined && safety.correction.recoveryOperationId !== null && safety.correction.recoveryOperationId !== predecessor;
  }
}

try {
  if (mode === 'prepare') {
    assert.equal((await backend.startup({ kind: 'consumer', owner: 'runtime', abandonUndelivered: false })).consumerResult?.success, true);
    // The first drain records lostJournal. The second executes the normal append
    // and real core settlement under that recorded owner, without a resync run.
    await k.drain(Deadline.after(600000));
    let inventory = await k.operations.list();
    const initial = inventory.records.find(item => !item.record.compacted && item.record.kind === 'repair');
    assert.ok(initial && !initial.record.compacted && initial.record.kind === 'repair');
    const snapshot = await k.drain(Deadline.after(600000), initial.record.operationId);
    assert.equal(snapshot.events.size, 1);
    const event = [...snapshot.events.values()][0]!;
    assert.equal(event.metadata.settlement, 'accepted');
    assert.ok(event.metadata.acceptance);
    assert.equal(event.metadata.acknowledgedAt, null);
    assert.equal((await k.outbox.list()).length, 0);
    // Inject context uncertainty through the real safety and recovery APIs. No
    // accepted checkpoint, acknowledgement or completion is supplied by a fixture.
    await k.safetyStore.invalidate('contextUncertain');
    const recovery = new RecoveryCoordinator(k);
    await recovery.plan({ cause: 'contextUncertain', journal: snapshot, rejectedEvent: event.metadata });
    await recovery.reconcileSafety();
    inventory = await k.operations.list();
    const repair = inventory.records.find(item => item.record.operationId === initial.record.operationId)!.record as RepairOperation;
    const safety = await backend.safety();
    assert.equal(repair.plan.handoffs.length, 1);
    assert.equal(repair.plan.handoffs[0]!.recordSha256, event.metadata.recordSha256);
    assert.deepEqual(repair.plan.handoffs[0]!.acceptance, event.metadata.acceptance);
    assert.equal(safety.recoveryWitness?.phase, 'active');
    assert.equal(safety.correction?.recoveryOperationId, repair.operationId);
    assert.equal(safety.pendingCheck, null);
    assert.notEqual(safety.generation, event.metadata.acceptance!.generation);
    await backend.shutdown(true);
    writeSync(1, JSON.stringify(proof({ boundary: 'prepared', repairId: repair.operationId, correctionId: safety.correction!.correctionId })) + '\n');
  } else {
    const predecessor = (await backend.safety()).correction?.recoveryOperationId;
    const nativeWrite = k.storage.write.bind(k.storage);
    k.storage.write = async (relative, value, profile, expected, deadline) => {
      const result = await nativeWrite(relative, value, profile, expected, deadline);
      const normalized = relative.replaceAll(path.sep, '/');
      const matches = mode === 'release-cut' ? releaseMatch(normalized, value, boundary as ReleaseCut)
        : mode === 'recovery-cut' && predecessor !== null && predecessor !== undefined ? recoveryMatch(normalized, value, boundary as RecoveryCut, predecessor) : false;
      if (matches) {
        assert.equal(bytesHash(await fs.readFile(path.join(k.scope.dataRoot, relative))), result);
        exitAt({ boundary, relative: normalized, sha256: result }, crashExit);
      }
      return result;
    };
    if (mode.startsWith('recovery-')) {
      k.core.publish = async () => {
        const safety = await backend.safety();
        assert.ok(safety.correction);
        assert.equal(safety.recoveryWitness?.phase, 'active');
        const owner = safety.recoveryWitness!.owner;
        assert.equal(safety.correction.recoveryOperationId, owner.operationId);
        const stored = await k.operations.read(owner.operationId);
        assert.ok(stored.status === 'valid' && !stored.value.compacted && stored.value.kind === 'repair');
        assert.deepEqual(activeRecoveryOwner(stored.value), owner);
        assert.equal(stored.value.plan.correctionId, safety.correction.correctionId);
        assert.ok(safety.pendingCheck, 'The real checked operation must arm its intent before the core call.');
        assert.equal(stored.value.completedAt, null);
        exitAt({ boundary: 'beforeRecoveryPublication', repairId: owner.operationId, correctionId: safety.correction.correctionId }, publicationExit);
      };
      await backend.startup({ kind: 'repair' });
      assert.fail(`Recovery never reached its required boundary: ${diagnostics.join('; ')}`);
    } else if (mode === 'release-cut') {
      await backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true });
      assert.fail(`Release never reached its required boundary: ${boundary}`);
    } else if (mode === 'release-refused') {
      const before = await backend.safety();
      let coreCalls = 0;
      k.core.consumer = async () => { coreCalls++; throw new Error('Contradictory witness authority reached a core switch.'); };
      await assert.rejects(backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: false }), error =>
        error instanceof ReleaseRefusedError && error.details.includes('recoveryDisclosureOwed') || error instanceof ControlDocumentError);
      assert.equal(coreCalls, 0);
      const after = await backend.safety();
      assert.deepEqual(after.recoveryWitness, before.recoveryWitness);
      assert.equal(after.correction?.correctionId, before.correction?.correctionId);
      await backend.shutdown(true);
      writeSync(1, JSON.stringify(proof({ boundary: 'releaseRefused' })) + '\n');
    } else if (mode === 'release-resume') {
      // A new confirmed request follows phase E. It cannot excuse a lost pending
      // release or missing witness discharge, and performs no repair or acquisition.
      const result = await backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: false });
      assert.equal(result.consumerResult?.success, true);
      assert.equal(result.notOwner, true);
      const safety = await backend.safety();
      assert.equal(safety.recoveryWitness, null);
      assert.ok(safety.correction, 'Explicit abandon never proves corrected guidance.');
      assert.equal(safety.correction.recoveryOperationId, null);
      await backend.shutdown(true);
      writeSync(1, JSON.stringify(proof({ boundary: 'releaseResumed', correctionId: safety.correction.correctionId })) + '\n');
    } else { assert.fail(`Unknown crash worker mode: ${mode}`); }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${diagnostics.join('\n')}\n`);
  await backend.shutdown(true);
  process.exitCode = 1;
}
