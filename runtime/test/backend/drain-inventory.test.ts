import assert from 'node:assert/strict';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { acquireWithPolicy } from '../../src/backend/acquisition-policy.ts';
import { Deadline } from '../../src/deadline.ts';
import { SafetyUnavailableError } from '../../src/safety-records.ts';
import { authorityModel, generation, repair, release, stubJournalTransaction } from './authority-fixtures.ts';

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

test('a non-owning drain retains an unfinished repair fault and skips later acquisition', async () => {
  for (const phase of ['preparing', 'recordRejected'] as const) {
    const model = authorityModel();
    const initial = repair();
    const active = repair({ ...initial, completedAt: phase === 'recordRejected' ? initial.startedAt : null,
      outcome: phase === 'recordRejected' ? 'recordRejected' : null,
      recovery: { ...initial.recovery, episodes: [{ ...initial.recovery.episodes[0]!, phase }] } });
    model.memory.seed(`operations/${active.operationId}.json`, active, 'state-event');
    const snapshot = await model.kernel.journal.read();
    stubJournalTransaction(model.kernel, snapshot);
    await model.kernel.drain(Deadline.after(10000));
    const expected = phase === 'recordRejected' ? 'recordRejected' : 'repairFailed';
    assert.equal(model.kernel.status.journal.fault, expected);
    const acquired = await acquireWithPolicy({ game: model.kernel.config.game, fault: () => model.kernel.status.journal.fault,
      readJournal: async () => { assert.fail('Faulted acquisition read the journal.'); },
      publish: async () => { assert.fail('Faulted acquisition ran core publication.'); } });
    assert.equal(acquired.skippedFault, expected);
    assert.deepEqual(model.memory.writes, []);
  }
});

test('a completed repair no longer supplies a drain fault', async () => {
  const model = authorityModel();
  const initial = repair();
  const completed = repair({ ...initial, completedAt: initial.startedAt, outcome: 'completed',
    recovery: { ...initial.recovery, activeEpisode: null,
      episodes: [{ ...initial.recovery.episodes[0]!, phase: 'completed', endedAt: initial.startedAt,
        acceptedRecovery: { journalId: 'journal', eventId: '2'.padStart(32, '0'), sequence: 1, generation, acceptedAt: initial.startedAt } }] } });
  model.memory.seed(`operations/${completed.operationId}.json`, completed, 'state-event');
  stubJournalTransaction(model.kernel, await model.kernel.journal.read());
  model.kernel.emit({ journal: { state: 'fault', fault: 'recordRejected', unacknowledgedEvents: 0 } });
  await model.kernel.drain(Deadline.after(10000));
  assert.equal(model.kernel.status.journal.fault, null);
  assert.equal(model.kernel.status.journal.state, 'healthy');
});
