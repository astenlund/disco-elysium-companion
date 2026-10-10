import assert from 'node:assert/strict';
import test from 'node:test';

import { Deadline } from '../../src/deadline.ts';
import { authorityModel, stubJournalTransaction } from './authority-fixtures.ts';

test('each no-backlog drain derives handoffs from one current operation inventory', async () => {
  const model = authorityModel();
  stubJournalTransaction(model.kernel, await model.kernel.journal.read());
  const list = model.kernel.operations.list.bind(model.kernel.operations);
  let inventoryReads = 0;
  model.kernel.operations.list = async deadline => { inventoryReads += 1; return list(deadline); };
  await model.kernel.drain(Deadline.after(10000));
  assert.equal(inventoryReads, 1);
  await model.kernel.drain(Deadline.after(10000));
  assert.equal(inventoryReads, 2);
  assert.deepEqual(model.memory.writes, []);
});
