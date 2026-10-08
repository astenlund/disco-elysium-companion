import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Deadline } from '../../src/deadline.ts';
import type { CoreResult } from '../../src/core-client.ts';
import type { RepairOperation } from '../../src/operation-records.ts';
import type { OutboxRead } from '../../src/outbox.ts';
import { handoffDigestOperations } from '../support/handoff-digest-fixture.ts';
import { journalEvent } from '../support/journal-event.ts';
import { authorityModel, generation, journal, repair, scope, stubJournalTransaction } from './authority-fixtures.ts';

async function cleanupFixture(currentEvent: boolean, presentation: 'replayable' | 'rejected' = 'rejected', unfinished = false) {
  const original = (await handoffDigestOperations(scope))[0]!;
  const handoff = { ...original.plan.handoffs[0]!, presentation };
  const base = unfinished ? repair() : original;
  const operation: RepairOperation = { ...base, plan: { ...base.plan, handoffs: [handoff] } };
  const chosen = journalEvent(1, { adapter: 'stubgame', logicalOutboxId: `${'f'.repeat(32)}-100`,
    acceptance: { journalId: 'journal', eventId: '1'.padStart(32, '0'), generation } });
  const retired = journalEvent(2, { adapter: 'stubgame', logicalOutboxId: handoff.logicalOutboxId,
    recordSha256: handoff.recordSha256, acceptance: handoff.acceptance });
  const events = new Map([[1, { metadata: chosen, sha256: '1'.repeat(64) }]]);
  if (currentEvent) { events.set(2, { metadata: retired, sha256: '2'.repeat(64) }); }
  const snapshot = { ...journal(currentEvent ? 2 : 1, currentEvent ? 2 : 1), events };
  const model = authorityModel(undefined, snapshot);
  model.memory.seed(`operations/${operation.operationId}.json`, operation);
  stubJournalTransaction(model.kernel, snapshot);
  model.kernel.outbox.list = async () => ['event-0000000000000010.json'];
  model.kernel.outbox.read = async name => ({ status: 'valid', name, sha256: handoff.recordSha256, bytes: Buffer.alloc(0), receipt: {},
    metadata: { game: 'stubgame', principal: 'principal', logicalOutboxId: handoff.logicalOutboxId, sequence: 10 } } as OutboxRead);
  const plans: string[] = [];
  model.kernel.planRecovery = async request => { plans.push(request.cause); return { record: operation, sha256: '3'.repeat(64) }; };
  return { model, plans, handoff, operation };
}

describe('cleanup-only retained settlement', () => {
  for (const reason of ['outbox-record-invalid', 'settlement-hash-mismatch'] as const) {
    for (const currentEvent of [false, true]) {
      it(`classifies ${reason} with ${currentEvent ? 'current' : 'retired'} journal evidence`, async () => {
        const { model, plans } = await cleanupFixture(currentEvent);
        let coreCalls = 0;
        model.kernel.core.settle = async () => {
          coreCalls++;
          return { success: false, class: reason === 'outbox-record-invalid' ? 'outbox' : 'settlement', reason,
            consumptionState: 'none', generationTimestamp: null, warnings: [] };
        };

        await model.kernel.drain(Deadline.after(10000));

        const safety = await model.kernel.safety();
        assert.equal(coreCalls, 1);
        assert.equal(safety.pendingCheck, null);
        if (reason === 'outbox-record-invalid') {
          assert.deepEqual(model.invalidations, ['coreRejected']);
          assert.deepEqual(plans, ['coreRejected']);
          assert.notEqual(safety.generation, generation);
          assert.equal(safety.correction?.reason, 'coreRejected');
          assert.equal(await model.kernel.providerAuthority(safety), false);
        } else {
          assert.deepEqual(model.invalidations, []);
          assert.deepEqual(plans, []);
          assert.equal(safety.generation, generation);
          assert.equal(model.kernel.status.journal.fault, 'outboxConflict');
        }
      });
    }
  }

  it('does not revive a rejected handoff after successful cleanup', async () => {
    const { model, operation } = await cleanupFixture(false);
    model.kernel.core.settle = async () => ({ success: true, value: 'already-settled' } as CoreResult<'settled' | 'already-settled'>);

    await model.kernel.drain(Deadline.after(10000));

    const retained = (await model.records()).find(record => record.operationId === operation.operationId) as RepairOperation;
    assert.equal(retained.plan.handoffs[0]?.presentation, 'rejected');
    assert.deepEqual(model.invalidations, []);
    assert.equal(model.kernel.status.journal.fault, null);
  });
});

describe('non-owning drain during unfinished repair', () => {
  it('withholds a replayable source until its journal event can be appended', async () => {
    const { model, operation, handoff } = await cleanupFixture(false, 'replayable', true);
    let settlements = 0;
    model.kernel.core.settle = async () => { settlements++; return { success: true, value: 'settled' }; };

    await model.kernel.drain(Deadline.after(10000));

    const retained = (await model.records()).find(record => record.operationId === operation.operationId) as RepairOperation;
    assert.equal(settlements, 0);
    assert.equal(retained.plan.handoffs[0]?.logicalOutboxId, handoff.logicalOutboxId);
    assert.equal(retained.plan.handoffs[0]?.presentation, 'replayable');
    assert.deepEqual(await model.kernel.outbox.list(), ['event-0000000000000010.json']);
  });

  it('still settles a source that already has a journal event', async () => {
    const { model } = await cleanupFixture(true, 'replayable', true);
    let settlements = 0;
    model.kernel.core.settle = async () => {
      settlements++;
      return { success: false, class: 'settlement', reason: 'settlement-out-of-order', consumptionState: 'none', generationTimestamp: null, warnings: [] };
    };

    await model.kernel.drain(Deadline.after(10000));

    assert.equal(settlements, 1);
    assert.deepEqual(model.invalidations, []);
  });
});
