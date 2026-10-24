import assert from 'node:assert/strict';
import test from 'node:test';

import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import type { CoreResult, CoreWarning, PublishReceipt } from '../../src/core-client.ts';
import { Deadline } from '../../src/deadline.ts';
import { operationallyCurrent } from '../../src/operational.ts';
import { SupervisorError } from '../../src/process.ts';
import { authorityModel, deferredResyncModel, owner } from './authority-fixtures.ts';

const retainedWarning: CoreWarning = { code: 'pipeline-reaper-discovery-limit-exceeded', detail: 'tmp' };

function cleanReceipt(warnings: readonly CoreWarning[]): CoreResult<PublishReceipt> {
  return { success: true, value: { outcome: 'unchanged', kind: null, logicalOutboxId: null, sequence: null, schemaVersion: 2, adapterVersion: 1, game: 'stubgame',
    targetIdentitySha256: null, targetGeneratedAt: null, baselineApplied: null, cacheDegraded: false, warnings } };
}

for (const failure of [
  { name: 'supervisor', error: new SupervisorError('abnormal-exit', 'Synthetic core child failure.') },
  { name: 'parse', error: new SupervisorError('result-invalid', 'Synthetic unparseable core result.') },
]) {
  test(`a recovery-owned resync ${failure.name} failure before a result marks the operational observation unknown`, async () => {
    // Arrange
    const model = deferredResyncModel();
    model.kernel.operational.observe(cleanReceipt([]));
    model.kernel.operational.observe({ success: false, class: 'refresh', reason: 'cycle-failed', consumptionState: 'none', generationTimestamp: null, warnings: [retainedWarning] });
    model.kernel.operational.observe(cleanReceipt([retainedWarning]));
    assert.equal(model.kernel.operational.current.state, 'current');
    const statuses: string[] = [];
    const emit = model.kernel.emit.bind(model.kernel);
    model.kernel.emit = change => { emit(change); statuses.push(model.kernel.status.operational.state); };
    let coreCalls = 0;
    model.kernel.core.publish = async () => { coreCalls++; throw failure.error; };

    // Act
    await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), error => error === failure.error);

    // Assert
    assert.equal(coreCalls, 1);
    assert.deepEqual(model.kernel.operational.current, { state: 'unknown', warnings: [retainedWarning] });
    assert.equal(model.kernel.status.operational.state, 'unknown');
    assert.ok(statuses.includes('unknown'));
    assert.equal(operationallyCurrent(model.kernel.operational.current), false);
    assert.notEqual((await model.kernel.safety()).pendingCheck, null);
  });
}

test('a recovery-owned resync result the observer refuses marks the operational observation unknown', async () => {
  // Arrange
  const model = deferredResyncModel();
  model.kernel.operational.observe(cleanReceipt([retainedWarning]));
  assert.equal(model.kernel.operational.current.state, 'current');
  model.kernel.core.publish = async () => cleanReceipt([{ code: 'pipeline-reaper-discovery-limit-exceeded', detail: 'elsewhere' }]);

  // Act
  await assert.rejects(new RecoveryCoordinator(model.kernel).resume(owner.operationId), /invalid reaper root/);

  // Assert
  assert.deepEqual(model.kernel.operational.current, { state: 'unknown', warnings: [retainedWarning] });
  assert.equal(model.kernel.status.operational.state, 'unknown');
  assert.notEqual((await model.kernel.safety()).pendingCheck, null);
});

test('a Publish failure after its validated result keeps the observation that result established', async () => {
  // Arrange
  const model = authorityModel();
  const afterResult = new Error('Synthetic failure after the receipt was observed.');
  model.kernel.core.publish = async () => cleanReceipt([]);

  // Act
  await assert.rejects(model.kernel.publish(false, null, Deadline.after(60_000), async () => { throw afterResult; }), error => error === afterResult);

  // Assert
  assert.deepEqual(model.kernel.operational.current, { state: 'current', warnings: [] });
});
