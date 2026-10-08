import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CoreResult, CoreWarning, PublishReceipt } from '../src/core-client.ts';
import { OperationalObservation, operationallyCurrent } from '../src/operational.ts';

function success(warnings: readonly CoreWarning[]): CoreResult<PublishReceipt> {
  return { success: true, value: { outcome: 'unchanged', kind: null, logicalOutboxId: null, sequence: null, schemaVersion: 2, adapterVersion: 2, game: 'game', targetIdentitySha256: 'a'.repeat(64), targetGeneratedAt: '2026-10-08T00:00:00.0000000Z', baselineApplied: null, cacheDegraded: false, warnings } };
}
const reaper = (detail: 'tmp' | 'state'): CoreWarning => ({ code: 'pipeline-reaper-discovery-limit-exceeded', detail });

describe('current operational observations', () => {
  it('retains both reaper roots through failures and cleanup-degraded success until a clean observation clears each', () => {
    const observation = new OperationalObservation();
    assert.deepEqual(observation.current, { state: 'unknown', warnings: [] });
    observation.observe(success([reaper('tmp')]));
    assert.equal(observation.current.state, 'current');
    assert.equal(operationallyCurrent(observation.current), false);
    observation.observe({ success: false, class: 'refresh', reason: 'cycle-failed', consumptionState: 'none', generationTimestamp: null, warnings: [reaper('state')] });
    assert.deepEqual(observation.current.warnings, [reaper('state'), reaper('tmp')]);
    observation.observe(success([{ code: 'pipeline-cleanup-degraded', detail: null }]));
    assert.equal(observation.current.state, 'unknown');
    assert.equal(observation.current.warnings.length, 3);
    observation.observe(success([reaper('state')]));
    assert.deepEqual(observation.current.warnings, [reaper('state')]);
    observation.observe(success([]));
    assert.equal(operationallyCurrent(observation.current), true);
    assert.deepEqual(observation.current.warnings, []);
  });

  it('keeps warnings on skipped or unparseable acquisition and does not report duplicate observations as changes', () => {
    const observation = new OperationalObservation();
    observation.observe(success([reaper('tmp'), reaper('tmp')]));
    assert.equal(observation.current.warnings.length, 1);
    assert.equal(observation.unavailable(), true);
    assert.equal(observation.unavailable(), false);
    assert.deepEqual(observation.current.warnings, [reaper('tmp')]);
    assert.equal(operationallyCurrent(observation.current), false);
  });
});
