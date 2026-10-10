import assert from 'node:assert/strict';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { Deadline } from '../../src/deadline.ts';
import { SafetyUnavailableError } from '../../src/safety-records.ts';
import { authorityModel, repair, release, stubJournalTransaction } from './authority-fixtures.ts';

test('each no-handoff drain reads one current operation inventory and safety generation', async () => {
  const model = authorityModel();
  const emptyRepair = repair();
  model.memory.seed(`operations/${emptyRepair.operationId}.json`, emptyRepair, 'state-event');
  const completedRelease = release();
  model.memory.seed(`operations/${completedRelease.operationId}.json`, completedRelease, 'state-event');
  stubJournalTransaction(model.kernel, await model.kernel.journal.read());
  const list = model.kernel.operations.list.bind(model.kernel.operations);
  const readSafety = model.kernel.safetyStore.read.bind(model.kernel.safetyStore);
  let inventoryReads = 0;
  let safetyReads = 0;
  model.kernel.operations.list = async deadline => { inventoryReads += 1; return list(deadline); };
  model.kernel.safetyStore.read = async deadline => { safetyReads += 1; return readSafety(deadline); };
  await model.kernel.drain(Deadline.after(10000));
  assert.equal(inventoryReads, 1);
  assert.equal(safetyReads, 1);
  await model.kernel.drain(Deadline.after(10000));
  assert.equal(inventoryReads, 2);
  assert.equal(safetyReads, 2);
  assert.deepEqual(model.memory.writes, []);
});

test('no-handoff drain refuses absent, invalid and unreadable safety', async () => {
  for (const failure of ['absent', 'invalid', 'unreadable'] as const) {
    const model = authorityModel();
    stubJournalTransaction(model.kernel, await model.kernel.journal.read());
    if (failure === 'absent') { model.memory.files.delete('state-safety.json'); }
    else if (failure === 'invalid') { model.memory.files.set('state-safety.json', Buffer.from('{')); }
    else { model.memory.unreadable.add('state-safety.json'); }
    await assert.rejects(model.kernel.drain(Deadline.after(10000)), failure === 'unreadable'
      ? DataRootUnavailableError : SafetyUnavailableError);
    assert.deepEqual(model.memory.writes, []);
  }
});
