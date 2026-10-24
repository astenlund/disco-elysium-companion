import assert from 'node:assert/strict';
import test from 'node:test';

import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { isCapacityBlocked, RuntimeCapacityError } from '../../src/capacity.ts';
import { Deadline } from '../../src/deadline.ts';
import { authorityModel, deferredResyncModel, journal, owner, repair as unfinishedRepair, stubJournalTransaction } from './authority-fixtures.ts';

function refusal(state: 'unavailable' | 'exhausted'): RuntimeCapacityError {
  return new RuntimeCapacityError({ admitted: false, state, dimensions: [state === 'unavailable' ? 'inventory' : 'uncompactedEvents'] }, 'ordinary');
}

// Holds the repair inside its resync Publish step until the test releases it.
function pausedRepair(model: ReturnType<typeof deferredResyncModel>) {
  let reached!: () => void;
  let release!: (error: Error) => void;
  const atStep = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<never>((_, reject) => { release = reject; });
  model.kernel.publish = async () => { reached(); return released; };
  const running = new RecoveryCoordinator(model.kernel).resume(owner.operationId);

  return { atStep, running, release };
}

for (const cause of ['operationLost', 'capacity'] as const) {
  test(`an executing ${cause} repair stays repairing through capacity exhaustion, reclassification and failure`, async () => {
    // Arrange
    const model = deferredResyncModel({ cause });
    const repair = pausedRepair(model);
    await repair.atStep;
    assert.deepEqual({ state: model.kernel.status.journal.state, fault: model.kernel.status.journal.fault }, { state: 'repairing', fault: null });

    // Act
    model.kernel.resources.reportFailure(refusal('exhausted')); model.kernel.emit();
    const exhausted = model.kernel.status;
    model.kernel.resources.reportFailure(refusal('unavailable')); model.kernel.emit();
    const reclassified = model.kernel.status;
    model.kernel.resources.reportFailure(refusal('exhausted')); model.kernel.emit();
    const stepFailure = new Error('Synthetic repair step failure.');
    repair.release(stepFailure);
    await assert.rejects(repair.running, error => error === stepFailure);
    const failed = model.kernel.status;

    // Assert
    assert.deepEqual({ state: exhausted.journal.state, fault: exhausted.journal.fault }, { state: 'repairing', fault: 'runtimeCapacityExceeded' });
    assert.equal(exhausted.capacity.ordinary.state, 'exhausted');
    assert.equal(isCapacityBlocked(exhausted.capacity), true);
    assert.deepEqual({ state: reclassified.journal.state, fault: reclassified.journal.fault }, { state: 'repairing', fault: null });
    assert.deepEqual(reclassified.capacity.ordinary, { state: 'unavailable', reason: 'inventory', dimensions: [] });
    assert.deepEqual({ state: failed.journal.state, fault: failed.journal.fault }, { state: 'fault', fault: 'repairFailed' });
    assert.equal(failed.capacity.ordinary.state, 'exhausted');
  });
}

test('a repair-owned drain keeps the repairing cue for the steps that follow it', async () => {
  // Arrange
  const model = authorityModel();
  model.memory.seed(`operations/${owner.operationId}.json`, unfinishedRepair());
  stubJournalTransaction(model.kernel, journal());
  model.kernel.emit({ journal: { state: 'repairing', fault: null, unacknowledgedEvents: 0 } });

  // Act
  await model.kernel.drain(Deadline.after(10_000), owner.operationId);
  const drained = model.kernel.status.journal;
  model.kernel.resources.reportFailure(refusal('exhausted')); model.kernel.emit();
  const exhausted = model.kernel.status.journal;
  model.kernel.resources.capacity.admitted('ordinary'); model.kernel.emit();
  await model.kernel.drain(Deadline.after(10_000));
  const unowned = model.kernel.status.journal;

  // Assert
  assert.deepEqual({ state: drained.state, fault: drained.fault }, { state: 'repairing', fault: null });
  assert.deepEqual({ state: exhausted.state, fault: exhausted.fault }, { state: 'repairing', fault: 'runtimeCapacityExceeded' });
  assert.deepEqual({ state: unowned.state, fault: unowned.fault }, { state: 'fault', fault: 'repairFailed' });
});

for (const exhausted of [false, true]) {
  test(`a repair whose record is unreadable when its step ends settles on repairFailed${exhausted ? ' beside capacity exhaustion' : ''}`, async () => {
    // Arrange
    const model = deferredResyncModel();
    const repair = pausedRepair(model);
    await repair.atStep;
    if (exhausted) { model.kernel.resources.reportFailure(refusal('exhausted')); model.kernel.emit(); }
    model.memory.unreadable.add(`operations/${owner.operationId}.json`);

    // Act
    repair.release(new Error('Synthetic repair step failure.'));
    await assert.rejects(repair.running);
    const settled = model.kernel.status.journal;

    // Assert
    assert.deepEqual({ state: settled.state, fault: settled.fault }, { state: 'fault', fault: 'repairFailed' });
  });
}
