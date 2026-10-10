import assert from 'node:assert/strict';
import test from 'node:test';

import { RecoveryCoordinator } from '../../src/backend/recovery.ts';
import { Deadline } from '../../src/deadline.ts';
import { authorityModel, stubJournalTransaction } from './authority-fixtures.ts';

const rejected = { status: 'invalid' as const, name: 'event-0000000000000001.json', sha256: 'e'.repeat(64) };

test('invalid reader results and projected controls persist the same exact rejection evidence', async () => {
  for (const candidate of [rejected, { name: rejected.name, sha256: rejected.sha256 }]) {
    const model = authorityModel();
    const recovery = new RecoveryCoordinator(model.kernel);
    await recovery.plan({ cause: 'outboxInvalid', journal: await model.kernel.journal.read(), rejected: candidate });
    const records = await model.records();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, 'repair');
    if (records[0]?.kind !== 'repair' || records[0].compacted) { assert.fail('The outbox repair record was not persisted.'); }
    assert.deepEqual(records[0].plan.rejectedRecord, { name: rejected.name, sha256: rejected.sha256 });
  }
});

test('drain routes an invalid legal-name record into a durable repair plan', async () => {
  const model = authorityModel();
  new RecoveryCoordinator(model.kernel);
  const snapshot = await model.kernel.journal.read();
  stubJournalTransaction(model.kernel, snapshot);
  model.kernel.outbox.list = async () => [rejected.name];
  model.kernel.outbox.read = async () => rejected;

  await model.kernel.drain(Deadline.after(10000));
  const records = await model.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, 'repair');
  if (records[0]?.kind !== 'repair' || records[0].compacted) { assert.fail('The outbox repair record was not persisted.'); }
  assert.deepEqual(records[0].plan.rejectedRecord, { name: rejected.name, sha256: rejected.sha256 });
});
