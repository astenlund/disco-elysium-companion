import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';

import { eventFileSequence, type JournalCursor, type JournalHeader } from '../../src/journal-records.ts';
import { newIdentity } from '../../src/identity.ts';
import type { OperationRecord, ReleaseOperation, RepairOperation } from '../../src/operation-records.ts';
import type { StateSafety } from '../../src/safety-records.ts';
import { CrashFixture, childTimeout, crashExit, preparationTimeout, readDocument, releaseCuts, selectedCases } from './support.ts';

const allCases = ['malformed-header', 'contradictory-witness', ...releaseCuts];
const cases = selectedCases(allCases);

it('resumes an explicit release after each durable phase without acknowledging skipped events', { timeout: preparationTimeout + childTimeout * (cases.length * 2 + 2) }, async context => {
  context.diagnostic(JSON.stringify({ selectedCases: cases, skippedCases: allCases.filter(value => !cases.includes(value)) }));
  const fixture = await CrashFixture.create('release', cases, allCases);
  try {
    const prepared = await fixture.child('prepare');
    const dataRoot = prepared.dataRoot;
    const repairPath = path.join(dataRoot, 'operations', prepared.repairId! + '.json');
    const repairBefore = await readDocument<RepairOperation>(repairPath);
    const eventPath = path.join(dataRoot, 'journal/events/0000000000000001.json');
    const eventBefore = await fs.readFile(eventPath);
    const safetyBefore = await readDocument<StateSafety>(path.join(dataRoot, 'state-safety.json'));
    assert.ok(repairBefore.plan.handoffs.length > 0);
    assert.ok(repairBefore.recovery.activeEpisode !== null);
    await fixture.capture();
    if (cases.includes('malformed-header')) { await context.test('malformed header preserves damaged event filename evidence in the intent', { timeout: childTimeout }, async () => {
      await fixture.restore();
      const headerPath = path.join(dataRoot, 'journal/journal.json');
      const cursorPath = path.join(dataRoot, 'journal/cursor-agent-session.json');
      const cursorBefore = await fs.readFile(cursorPath);
      const secondName = '0000000000000002.json';
      assert.equal(eventFileSequence(path.basename(eventPath)), 1);
      assert.equal(eventFileSequence(secondName), 2);
      await fs.writeFile(headerPath, '{');
      await fs.writeFile(eventPath, '{');
      await fs.writeFile(path.join(dataRoot, 'journal/events', secondName), '{');
      await fixture.preserve('input-malformed-header');
      const cut = await fixture.child('release-cut', 'intent', crashExit);
      assert.equal(cut.boundary, 'intent');
      await fixture.preserve('cut-malformed-header');
      const releases = await Promise.all((await fs.readdir(path.join(dataRoot, 'operations'))).filter(name => name.startsWith('rl-')).map(name => readDocument<ReleaseOperation>(path.join(dataRoot, 'operations', name))));
      assert.equal(releases.length, 1);
      const release = releases[0]!;
      assert.equal(release.plan.mode, 'abandon');
      assert.equal(release.plan.journalId, null, 'Unreadable metadata cannot invent a journal identity.');
      assert.deepEqual(release.plan.skippedRanges, [], 'Filename evidence is not authority for a synthetic cursor range.');
      assert.deepEqual(release.plan.abandonedSequences, [1, 2], 'A damaged payload does not erase its admitted event filename.');
      assert.equal(await fs.readFile(headerPath, 'utf8'), '{');
      assert.deepEqual(await fs.readFile(cursorPath), cursorBefore);
      assert.equal(await fs.readFile(eventPath, 'utf8'), '{');
      assert.equal(await fs.readFile(path.join(dataRoot, 'journal/events', secondName), 'utf8'), '{');
      assert.equal((await readDocument<{ owner: string }>(path.join(fixture.fixture.root, 'state/consumer.json'))).owner, 'runtime');
    }); }
    if (cases.includes('contradictory-witness')) { await context.test('a completed release cannot discharge a different witnessed activation', { timeout: childTimeout * 2 }, async () => {
      await fixture.restore();
      assert.equal((await fixture.child('release-cut', 'complete', crashExit)).boundary, 'complete');
      const safetyPath = path.join(dataRoot, 'state-safety.json');
      const before = await readDocument<StateSafety>(safetyPath);
      assert.ok(before.recoveryWitness);
      const activationId = newIdentity();
      assert.notEqual(activationId, before.recoveryWitness.owner.activationId);
      const contradicted: StateSafety = { ...before, recoveryWitness: { ...before.recoveryWitness,
        owner: { ...before.recoveryWitness.owner, activationId } } };
      await fs.writeFile(safetyPath, JSON.stringify(contradicted) + '\n');
      const cursorBefore = await fs.readFile(path.join(dataRoot, 'journal/cursor-agent-session.json'));
      const repairAtCut = await fs.readFile(repairPath);
      await fixture.preserve('input-contradictory-witness');
      assert.equal((await fixture.child('release-refused', 'contradictory-witness')).boundary, 'releaseRefused');
      await fixture.preserve('refused-contradictory-witness');
      assert.deepEqual((await readDocument<StateSafety>(safetyPath)).recoveryWitness, contradicted.recoveryWitness);
      assert.deepEqual(await fs.readFile(repairPath), repairAtCut);
      assert.deepEqual(await fs.readFile(path.join(dataRoot, 'journal/cursor-agent-session.json')), cursorBefore);
      assert.deepEqual(await fs.readFile(eventPath), eventBefore);
      assert.equal((await readDocument<{ owner: string }>(path.join(fixture.fixture.root, 'state/consumer.json'))).owner, 'bridge');
    }); }
    for (const boundary of releaseCuts) {
      if (!cases.includes(boundary)) { continue; }
      await context.test(boundary, { timeout: childTimeout * 2 }, async () => {
        await fixture.restore();
        const cut = await fixture.child('release-cut', boundary, crashExit);
        assert.equal(cut.boundary, boundary);
        await fixture.preserve('cut-' + boundary);
        assert.equal((await readDocument<{ cleanShutdown: boolean }>(path.join(dataRoot, 'runtime.json'))).cleanShutdown, false);
        const records = await Promise.all((await fs.readdir(path.join(dataRoot, 'operations'))).map(name => readDocument<OperationRecord>(path.join(dataRoot, 'operations', name))));
        const releases = records.filter(record => !record.compacted && record.kind === 'release') as ReleaseOperation[];
        assert.equal(releases.length, 1);
        const release = releases[0]!;
        assert.equal(release.plan.mode, 'abandon');
        assert.equal(release.plan.witness?.owner.operationId, prepared.repairId);
        assert.ok(release.plan.unfinishedRepairs.some(item => item.operationId === prepared.repairId));
        assert.deepEqual(await fs.readFile(eventPath), eventBefore, 'A synthetic cursor must not stamp actual acknowledgement.');
        const safetyAtCut = await readDocument<StateSafety>(path.join(dataRoot, 'state-safety.json'));
        assert.equal(safetyAtCut.correction?.correctionId, safetyBefore.correction!.correctionId);
        assert.equal(safetyAtCut.recoveryWitness === null, boundary === 'witnessCleared');
        await fixture.child('release-resume', boundary);
        await fixture.preserve('resumed-' + boundary);
        const completed = await readDocument<ReleaseOperation>(path.join(dataRoot, 'operations', release.operationId + '.json'));
        assert.equal(completed.operationId, release.operationId);
        assert.equal(completed.plan.mode, 'abandon');
        assert.equal(completed.outcome, 'completed');
        assert.ok(completed.completedAt);
        assert.equal(completed.plan.result?.owner, 'bridge');
        assert.ok(completed.plan.completedPhases.includes('dischargesPublished'));
        assert.ok(completed.plan.skippedRanges.length > 0);
        for (const range of completed.plan.skippedRanges) {
          assert.equal(range.discharge?.kind, 'abandonRelease');
          assert.equal(range.discharge?.operationId, release.operationId);
          assert.equal(range.discharge?.episodeOrdinal, null);
        }
        const repaired = await readDocument<RepairOperation>(repairPath);
        assert.deepEqual(repaired.plan.handoffs, repairBefore.plan.handoffs, 'Release must preserve original settlement bindings and presentation dispositions.');
        assert.equal(repaired.recovery.activeEpisode, null);
        assert.equal(repaired.recovery.episodes.at(-1)?.phase, 'abandonedByRelease');
        assert.equal(repaired.recovery.episodes.at(-1)?.releaseOperationId, release.operationId);
        const header = await readDocument<JournalHeader>(path.join(dataRoot, 'journal/journal.json'));
        const cursor = await readDocument<JournalCursor>(path.join(dataRoot, 'journal/cursor-agent-session.json'));
        assert.equal(header.historyVerified, true);
        assert.equal(cursor.lastAckedSequence, header.highWaterSequence);
        assert.equal(cursor.lastSentSequence, header.highWaterSequence);
        assert.equal(cursor.lastAcceptedRevision, null);
        assert.deepEqual(await fs.readFile(eventPath), eventBefore);
        assert.equal((await readDocument<{ owner: string }>(path.join(fixture.fixture.root, 'state/consumer.json'))).owner, 'bridge');
        await assert.rejects(fs.access(path.join(fixture.fixture.root, 'state/baseline.json')), { code: 'ENOENT' });
        const safety = await readDocument<StateSafety>(path.join(dataRoot, 'state-safety.json'));
        assert.equal(safety.recoveryWitness, null);
        assert.equal(safety.correction?.correctionId, prepared.correctionId);
        assert.equal(safety.correction?.reason, safetyBefore.correction!.reason);
        assert.equal(safety.correction?.recoveryOperationId, null);
        if (safetyAtCut.pendingCheck !== null) {
          assert.equal(safety.pendingCheck, safetyAtCut.pendingCheck, 'A consumer-only resume must retain a lost check until correction recovery is planned.');
        }
      });
    }
  } finally { await fixture.close(); }
});
