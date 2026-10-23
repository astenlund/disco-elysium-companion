import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PathInspector } from '../src/admission.ts';
import { PayloadCodec, CodecDocumentError } from '../src/codec.ts';
import { Deadline } from '../src/deadline.ts';
import { OutboxReader } from '../src/outbox.ts';
import { authorityModel } from './backend/authority-fixtures.ts';
import { FilePublisher } from '../src/files.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { Journal, JournalUnavailableError, SentMarkPublicationError, type JournalTransaction } from '../src/journal.ts';
import { eventRewriteMetadata } from '../src/journal-records.ts';
import { parseStrictJson, utcNow } from '../src/json.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

describe('journal durable write ordering', () => {
  it('recovers event-before-high-water without settling early and acknowledges only the accepted copy', { timeout: 360000 }, async () => {
    const fixture = await companionFixture('state-event');
    const dataRoot = path.join(fixture.root, 'runtime-data');
    await fs.mkdir(path.join(dataRoot, 'journal', 'events'), { recursive: true });
    const supervisor = (await createTestNative(dataRoot, { companionRoot: fixture.root, dataRoot })).supervisor;
    const inspector = new PathInspector(supervisor);
    const native = inspector.native.bind(inspector);
    let eventInspections = 0;
    inspector.native = async (op, ...args) => {
      if (op === 'eventBatch' || op === 'hash') { eventInspections++; }
      return native(op, ...args);
    };
    const guard = await takeInstanceGuard(dataRoot, error => { throw error; });
    let refuseHeader = false;
    let refuseSent = false;
    const publisher = new FilePublisher({
      root: dataRoot, supervisor, inspector, guard, invalidate: () => {},
      preflight: async (target, bytes, profile) => {
        parseStrictJson(bytes, profile);
        if (refuseHeader && path.basename(target) === 'journal.json') { refuseHeader = false; throw new Error('fixture high-water publication refused'); }
        if (refuseSent && path.basename(target) === 'cursor-agent-session.json') { refuseSent = false; throw new Error('fixture sent-mark publication refused'); }
      },
    });
    // This fixture checks storage ordering. Complete-transition capacity, safety and
    // repair permissions are separate coordinator obligations and are stubbed here.
    const codec = new PayloadCodec(publisher, async () => {});
    const mutations: string[] = [];
    const journal = new Journal({
      root: dataRoot, game: 'stubgame', principal: 'S-1-5-21-1000-1001-1002-1003',
      identities: { runtimeInstanceId: 'a'.repeat(32), runtimeSessionId: 'b'.repeat(32), adapterBindingEpoch: 'c'.repeat(32) },
      inspector, publisher, codec, admitMutation: async kind => { mutations.push(kind); }, eventIdAvailable: async () => true,
    });
    try {
      const now = utcNow();
      await publisher.publishJson('journal/journal.json', { journalVersion: 1, journalId: 'd'.repeat(32), createdAt: now, highWaterSequence: 0, historyVerified: false }, true);
      await publisher.publishJson('journal/cursor-agent-session.json', { cursorVersion: 1, journalId: 'd'.repeat(32), consumerId: 'agent-session', lastAckedSequence: 0, lastSentSequence: 0, lastAcceptedRevision: null, updatedAt: now }, true);
      const sourcePath = path.join(fixture.root, 'state', 'outbox', 'event-0000000000000001.json');
      const source = await fs.readFile(sourcePath);
      const outbox = new OutboxReader(fixture.root, inspector, codec);
      const model = authorityModel();
      model.memory.scope.principal = 'S-1-5-21-1000-1001-1002-1003';
      model.kernel.journal.transact = journal.transact.bind(journal);
      model.kernel.outbox.list = outbox.list.bind(outbox);
      model.kernel.outbox.read = outbox.read.bind(outbox);
      let sourceInspections = 0;
      const inspectSource = codec.inspectSource.bind(codec);
      codec.inspectSource = async (...args) => { sourceInspections++; return inspectSource(...args); };
      refuseHeader = true;
      // The owned-repair argument permits this deliberately unverified initial header.
      // Header publication fails before settlement; authority controls remain modeled.
      await assert.rejects(model.kernel.drain(Deadline.after(120000), 'receipt-fixture'), /high-water publication refused/);
      assert.equal(sourceInspections, 1);
      const interrupted = await journal.read();
      assert.equal(interrupted.fault, null);
      assert.equal(interrupted.header.status, 'valid');
      if (interrupted.header.status !== 'valid') { throw new Error('Fixture header is unavailable.'); }
      assert.equal(interrupted.header.value.highWaterSequence, 0);
      assert.equal(interrupted.header.value.historyVerified, false);
      assert.equal(interrupted.unrecordedEvent?.metadata.sequence, 1);
      assert.equal(interrupted.unrecordedEvent?.metadata.acceptance, null);
      assert.deepEqual(await fs.readFile(sourcePath), source);
      await assert.rejects(journal.append(source, 1), JournalUnavailableError);

      const recovered = await journal.recoverHighWater();
      assert.equal(recovered.unrecordedEvent, null);
      const pending = recovered.events.get(1)!;
      const inspectedDuplicate = await codec.inspectSourceWithReceipt(source, 1);
      inspectedDuplicate.metadata['game'] = 'changed-public-copy';
      const beforeDuplicate = sourceInspections;
      await journal.transact(async work => {
        const duplicate = await work.append(source, 1, undefined, inspectedDuplicate.receipt);
        assert.equal(duplicate.sha256, pending.sha256);
      });
      assert.equal(sourceInspections, beforeDuplicate + 1);
      await assert.rejects(journal.transact(work => work.append(source, 1, undefined, inspectedDuplicate.receipt)), CodecDocumentError);
      const changedDuplicate = await codec.inspectSourceWithReceipt(source, 1);
      await assert.rejects(journal.transact(work => work.append(Buffer.concat([source, Buffer.from(' ')]), 1, undefined, changedDuplicate.receipt)), CodecDocumentError);
      const beforeDefault = sourceInspections;
      await journal.append(source, 1);
      assert.equal(sourceInspections, beforeDefault + 1);
      assert.equal(pending.metadata.settlement, 'pending');
      assert.equal(pending.metadata.acceptance, null);
      const generation = 'e'.repeat(32);
      assert.deepEqual(await journal.acknowledge([pending.metadata], generation), []);
      await assert.rejects(journal.markSent([pending.metadata], generation), JournalUnavailableError);
      const settled = await supervisor.run('core', {
        command: 'pwsh', cwd: fixture.root,
        args: ['-NoProfile', '-File', path.join(fixture.root, 'core', 'Set-StateEventSettlement.ps1'), '-CompanionRoot', fixture.root,
          '-LogicalOutboxId', pending.metadata.logicalOutboxId, '-RecordSha256', pending.metadata.recordSha256, '-JournalId', pending.metadata.journalId, '-EventId', pending.metadata.eventId],
      }, 120000);
      assert.equal(settled.exitCode, 0, settled.stderr.toString());
      const accepted = await journal.rewrite(pending, current => ({ ...eventRewriteMetadata(current), settlement: 'accepted', acceptance: { journalId: current.journalId, eventId: current.eventId, generation } }));
      assert.equal(accepted.metadata.payloadBindingSha256, pending.metadata.payloadBindingSha256);
      refuseSent = true;
      await assert.rejects(journal.markSent([accepted.metadata], generation), error => error instanceof SentMarkPublicationError && error.cause instanceof Error && error.cause.message === 'fixture sent-mark publication refused');
      const unchangedCursor = JSON.parse(await fs.readFile(path.join(dataRoot, 'journal', 'cursor-agent-session.json'), 'utf8'));
      assert.equal(unchangedCursor.lastSentSequence, 0);
      const scansBefore = eventInspections;
      const retained: { view: JournalTransaction | null } = { view: null };
      await journal.transact(async work => {
        retained.view = work;
        (work.snapshot().events as Map<number, unknown>).clear();
        assert.equal(work.snapshot().events.size, 1);
        await work.markSent([accepted.metadata], generation);
        const marked = work.snapshot().cursor;
        assert.ok(marked.status === 'valid');
        assert.equal(marked.value.lastSentSequence, 1);
        assert.equal(marked.value.lastAckedSequence, 0);
        assert.deepEqual(await work.acknowledge([accepted.metadata], 'f'.repeat(32)), []);
        assert.equal((await work.acknowledge([accepted.metadata], generation)).length, 1);
        assert.notEqual(work.snapshot().events.get(1)!.metadata.acknowledgedAt, null);
        return accepted;
      });
      assert.equal(eventInspections - scansBefore, 1);
      assert.ok(retained.view !== null);
      assert.throws(() => retained.view!.snapshot(), JournalUnavailableError);
      await assert.rejects(retained.view.append(source, 1), JournalUnavailableError);
      const acknowledged = await journal.read();
      assert.equal(acknowledged.fault, null);
      if (acknowledged.cursor.status !== 'valid') { throw new Error('Fixture cursor is unavailable.'); }
      assert.equal(acknowledged.cursor.value.lastAckedSequence, 1);
      assert.equal(acknowledged.cursor.value.lastSentSequence, 1);
      assert.notEqual(acknowledged.events.get(1)!.metadata.acknowledgedAt, null);
      await assert.rejects(journal.rewrite(accepted, current => eventRewriteMetadata(current)), JournalUnavailableError);
      assert.equal(publisher.blocked, false);
      assert.ok(mutations.includes('highWater') && mutations.includes('sent') && mutations.includes('acknowledge'));
      await assert.rejects(journal.transact(async work => {
        journal.invalidate();
        assert.throws(() => work.snapshot(), JournalUnavailableError);
        await assert.rejects(work.markSent([], generation), JournalUnavailableError);
      }), JournalUnavailableError);
    } finally {
      await journal.idle();
      await publisher.idle();
      await guard.release();
      await fixture.close();
    }
  });
});
