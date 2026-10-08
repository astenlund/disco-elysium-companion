import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';

import type { EventDescription } from '../../src/journal-records.ts';
import type { OperationRecord, RepairOperation } from '../../src/operation-records.ts';
import type { StateSafety } from '../../src/safety-records.ts';
import { CrashFixture, childTimeout, crashExit, preparationTimeout, publicationExit, readDocument, recoveryCuts, selectedCases } from './support.ts';

const allCases = ['absent', 'invalid'].flatMap(predecessor => recoveryCuts.map(boundary => predecessor + '-' + boundary));
const cases = selectedCases(allCases);

it('retains a witness-null lost correction through successor-plan and pointer publication crashes', { timeout: preparationTimeout + childTimeout * (cases.length * 2 + 2) }, async context => {
  context.diagnostic(JSON.stringify({ selectedCases: cases, skippedCases: allCases.filter(value => !cases.includes(value)) }));
  const fixture = await CrashFixture.create('recovery', cases, allCases);
  try {
    const prepared = await fixture.child('prepare');
    const dataRoot = prepared.dataRoot;
    const predecessorPath = path.join(dataRoot, 'operations', prepared.repairId! + '.json');
    const safetyPath = path.join(dataRoot, 'state-safety.json');
    const cursorPath = path.join(dataRoot, 'journal/cursor-agent-session.json');
    const eventPath = path.join(dataRoot, 'journal/events/0000000000000001.json');
    const eventBefore = await fs.readFile(eventPath);
    const event = JSON.parse(eventBefore.toString('utf8')) as EventDescription;
    const cursorBefore = await fs.readFile(cursorPath);
    const safetyBefore = await readDocument<StateSafety>(safetyPath);
    await fixture.capture();
    for (const predecessor of ['absent', 'invalid'] as const) {
      for (const boundary of recoveryCuts) {
        if (!cases.includes(predecessor + '-' + boundary)) { continue; }
        await context.test(`${predecessor}: ${boundary}`, { timeout: childTimeout * 2 }, async () => {
          await fixture.restore();
          // These are deliberate disk-loss fixtures, not grants of clean safety:
          // the durable correction remains bound to the lost real operation.
          if (predecessor === 'absent') { await fs.unlink(predecessorPath); }
          else { await fs.writeFile(predecessorPath, '{'); }
          await fs.writeFile(safetyPath, JSON.stringify({ ...safetyBefore, recoveryWitness: null }) + '\n');
          const label = predecessor + '-' + boundary;
          await fixture.preserve('input-' + label);
          const cut = await fixture.child('recovery-cut', boundary, crashExit);
          assert.equal(cut.boundary, boundary);
          await fixture.preserve('cut-' + label);
          const interrupted = await readDocument<StateSafety>(safetyPath);
          assert.equal(interrupted.correction?.correctionId, prepared.correctionId);
          assert.ok(interrupted.recoveryWitness);
          const intendedOwner = interrupted.recoveryWitness.phase === 'transferring' ? interrupted.recoveryWitness.successor! : interrupted.recoveryWitness.owner;
          assert.notEqual(intendedOwner.operationId, prepared.repairId);
          assert.equal(interrupted.correction?.recoveryOperationId, boundary === 'correctionTransferred' ? intendedOwner.operationId : prepared.repairId);
          const resumed = await fixture.child('recovery-resume', label, publicationExit);
          assert.equal(resumed.boundary, 'beforeRecoveryPublication');
          assert.equal(resumed.repairId, intendedOwner.operationId, 'A resumed partial successor must retain its reserved identity.');
          assert.equal(resumed.correctionId, prepared.correctionId);
          await fixture.preserve('resumed-' + label);
          const safety = await readDocument<StateSafety>(safetyPath);
          assert.equal(safety.correction?.recoveryOperationId, intendedOwner.operationId);
          assert.equal(safety.correction?.reason, safetyBefore.correction!.reason);
          assert.equal(safety.recoveryWitness?.phase, 'active');
          assert.deepEqual(safety.recoveryWitness?.owner, intendedOwner);
          assert.ok(safety.pendingCheck);
          assert.notEqual(safety.generation, safetyBefore.generation);
          const successor = await readDocument<RepairOperation>(path.join(dataRoot, 'operations', intendedOwner.operationId + '.json'));
          assert.equal(successor.plan.correctionId, prepared.correctionId);
          assert.equal(successor.plan.inheritedRecovery, null, 'Lost witness details cannot be fabricated from a correction pointer.');
          assert.equal(successor.completedAt, null);
          assert.equal(successor.outcome, null);
          assert.equal(successor.recovery.episodes.length, 1);
          assert.equal(successor.recovery.attempts.length, 1);
          assert.equal(successor.recovery.attempts[0]!.publication, 'due');
          const retained = successor.plan.handoffs.find(item => item.logicalOutboxId === event.logicalOutboxId);
          assert.ok(retained);
          assert.equal(retained.recordSha256, event.recordSha256);
          assert.equal(retained.payloadBindingSha256, event.payloadBindingSha256);
          assert.equal(retained.journalId, event.acceptance!.journalId);
          assert.equal(retained.eventId, event.acceptance!.eventId);
          assert.deepEqual(retained.acceptance, event.acceptance);
          const validRepairs: RepairOperation[] = [];
          for (const name of await fs.readdir(path.join(dataRoot, 'operations'))) {
            if (name === prepared.repairId + '.json') { continue; }
            const operation = await readDocument<OperationRecord>(path.join(dataRoot, 'operations', name));
            if (!operation.compacted && operation.kind === 'repair') { validRepairs.push(operation); }
          }
          assert.equal(validRepairs.length, 1, 'Partial transfer must not create a competing active recovery.');
          if (predecessor === 'invalid') {
            const retainedInvalid = successor.plan.lostOperations.find(item => item.name === prepared.repairId + '.json');
            assert.ok(retainedInvalid, 'Invalid predecessor bytes need an exact quarantine obligation.');
            assert.equal((await fs.readFile(path.join(dataRoot, retainedInvalid.destination), 'utf8')), '{');
          }
          assert.deepEqual(await fs.readFile(cursorPath), cursorBefore);
          assert.deepEqual(await fs.readFile(eventPath), eventBefore);
          assert.equal((await readDocument<{ owner: string }>(path.join(fixture.fixture.root, 'state/consumer.json'))).owner, 'runtime');
        });
      }
    }
  } finally { await fixture.close(); }
});
