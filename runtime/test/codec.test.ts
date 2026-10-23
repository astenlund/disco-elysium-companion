import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { NativeOperationError, PathInspector } from '../src/admission.ts';
import { PayloadCodec, CodecDocumentError } from '../src/codec.ts';
import { EventReader } from '../src/event-reader.ts';
import { FilePublisher, PublicationError } from '../src/files.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { asInteger, hasExactKeys, parseStrictJson, utcNow } from '../src/json.ts';
import { OutboxReader } from '../src/outbox.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

describe('file-backed lossless codec', () => {
  it('preserves the payload through private-core settlement, reload, compaction and a lost helper reply', { timeout: 240000 }, async () => {
    const fixture = await companionFixture('state-event');
    const dataRoot = path.join(fixture.root, 'runtime-data');
    const supervisor = (await createTestNative(fixture.root, { companionRoot: fixture.root, dataRoot })).supervisor;
    const inspector = new PathInspector(supervisor);
    const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
    await fs.mkdir(dataRoot);
    const invalidated: string[] = [];
    const publisher = new FilePublisher({ root: dataRoot, guard, supervisor, inspector, preflight: async () => {}, invalidate: target => invalidated.push(target) });
    let reservations = 0;
    const codec = new PayloadCodec(publisher, async reservation => {
      assert.ok(reservation.inputBytes > 0 && reservation.controlBytes > 0);
      assert.equal(reservation.maximumOutputBytes, reservation.publication ? 33554432 : 0);
      reservations++;
    });
    const principal = 'S-1-5-21-1000-1001-1002-1003';
    try {
      const core = async (name: string, args: string[]) => supervisor.run('core', { command: 'pwsh', args: ['-NoProfile', '-File', path.join(fixture.root, 'core', name), '-CompanionRoot', fixture.root, ...args], cwd: fixture.root }, 120000);
      const records = (await fs.readdir(path.join(fixture.root, 'state', 'outbox'))).filter(name => /^event-[0-9]{16}\.json$/.test(name));
      assert.equal(records.length, 1);
      const sourcePath = path.join(fixture.root, 'state', 'outbox', records[0]!);
      const source = await fs.readFile(sourcePath);
      const outbox = new OutboxReader(fixture.root, inspector, codec);
      assert.deepEqual(await outbox.list(), records);
      const inspected = await outbox.read(records[0]!);
      assert.equal(inspected.status, 'valid');
      if (inspected.status !== 'valid') { throw new Error('Fixture outbox record was not admitted.'); }
      await assert.rejects(outbox.read('ledger.json'));
      assert.deepEqual(await outbox.read('event-0000000000000002.json'), { status: 'absent', name: 'event-0000000000000002.json' });
      assert.equal(inspected.metadata['principal'], principal);
      assert.equal(asInteger(inspected.metadata['sequence']), 1);
      assert.deepEqual(inspected.bytes, source);
      assert.equal(publisher.blocked, false);
      assert.deepEqual(await fs.readdir(dataRoot), []);
      const now = utcNow();
      const metadata = {
        eventVersion: 1, journalId: '1'.repeat(32), sequence: 1, eventId: '2'.repeat(32), type: `state.${inspected.metadata['kind']}`,
        occurredAt: now, runtimeInstanceId: '3'.repeat(32), adapter: inspected.metadata['game'], adapterBindingEpoch: '4'.repeat(32), principal,
        logicalOutboxId: inspected.metadata['logicalOutboxId'], recordSha256: inspected.sha256, coreRepairOperationId: null, attemptRef: null,
        schemaVersion: inspected.metadata['schemaVersion'], adapterVersion: inspected.metadata['adapterVersion'], settlement: 'pending', acceptance: null,
        acknowledgedAt: null, compacted: false,
      };
      await assert.rejects(codec.createEvent('invalid.json', Buffer.from('{}'), metadata, 1), CodecDocumentError);
      await assert.rejects(codec.createEvent('wrong-sequence.json', source, metadata, 2), CodecDocumentError);
      await assert.rejects(codec.createEvent('wrong-hash.json', source, { ...metadata, recordSha256: '0'.repeat(64) }, 1), CodecDocumentError);
      assert.deepEqual(await fs.readdir(dataRoot), []);
      const created = await codec.createEvent('event.json', source, metadata, 1);
      assert.equal(created.metadata['settlement'], 'pending');
      assert.equal(created.metadata['acceptance'], null);
      assert.equal(created.metadata['targetIdentitySha256'], inspected.metadata['targetIdentitySha256']);
      assert.equal(created.cleanupComplete, true);
      assert.deepEqual(await fs.readdir(dataRoot), ['event.json']);
      const reader = new EventReader(dataRoot, inspector);
      const [observations, physical] = await Promise.all([
        reader.read([{ path: 'event.json', sequence: 1 }, { path: 'missing.json', sequence: 2 }, { path: 'event.json', sequence: 2 }]),
        inspector.inspect(dataRoot, path.join(dataRoot, 'event.json')),
      ]);
      assert.equal(physical.exists, true);
      assert.equal(observations[0]!.status, 'valid');
      assert.equal(observations[0]!.sha256, created.sha256);
      assert.equal(observations[1]!.status, 'absent');
      assert.equal(observations[2]!.status, 'invalid');
      assert.deepEqual(await fs.readdir(dataRoot), ['event.json']);
      await assert.rejects(codec.createEvent('event.json', source, metadata, 1), PublicationError);
      const destinationMetadata = { ...metadata, journalId: 'replacement-journal', eventId: '6'.repeat(32) };
      const preview = await codec.previewEvent('copy.json', source, destinationMetadata, 'outbox', created.metadata['payloadBindingSha256'] as string, 1);
      await assert.rejects(fs.readFile(path.join(dataRoot, 'copy.json')), { code: 'ENOENT' });
      const reconstructed = await codec.reconstructEvent('copy.json', source, destinationMetadata, 1, created.metadata['payloadBindingSha256'] as string);
      assert.equal(reconstructed.sha256, preview.sha256);
      assert.equal(reconstructed.metadata['payloadBindingSha256'], created.metadata['payloadBindingSha256']);
      await fs.unlink(path.join(dataRoot, 'copy.json'));

      const settled = await core('Set-StateEventSettlement.ps1', ['-LogicalOutboxId', String(metadata.logicalOutboxId), '-RecordSha256', inspected.sha256, '-JournalId', metadata.journalId, '-EventId', metadata.eventId]);
      assert.equal(settled.exitCode, 0, settled.stderr.toString());
      const settlement = parseStrictJson(settled.stdout);
      assert.ok(hasExactKeys(settlement, ['outcome', 'logicalOutboxId']));
      assert.equal(settlement['outcome'], 'settled');
      await assert.rejects(fs.readFile(sourcePath), { code: 'ENOENT' });

      const acceptedMetadata = { ...metadata, settlement: 'accepted', acceptance: { journalId: metadata.journalId, eventId: metadata.eventId, generation: '5'.repeat(32) } };
      const accepted = await codec.rewriteEvent('event.json', created.bytes, acceptedMetadata, false);
      assert.equal(accepted.metadata['payloadBindingSha256'], created.metadata['payloadBindingSha256']);
      assert.equal(accepted.metadata['targetIdentitySha256'], created.metadata['targetIdentitySha256']);
      const reloaded = await codec.inspectEvent(await fs.readFile(path.join(dataRoot, 'event.json')));
      assert.deepEqual(reloaded.bytes, accepted.bytes);
      assert.equal(reloaded.metadata['settlement'], 'accepted');

      const rejectedInput = Buffer.from(accepted.bytes.toString('utf8').replace('"baselineReset":true', '"baselineReset":false'));
      assert.notDeepEqual(rejectedInput, accepted.bytes);
      await assert.rejects(codec.inspectEvent(rejectedInput), CodecDocumentError);
      assert.equal(publisher.blocked, false);
      const compacted = await codec.rewriteEvent('event.json', accepted.bytes, { ...acceptedMetadata, compacted: true }, true);
      assert.equal(compacted.metadata['payloadBindingSha256'], created.metadata['payloadBindingSha256']);
      assert.equal(compacted.metadata['targetIdentitySha256'], null);
      assert.equal(compacted.metadata['stateGeneratedAt'], null);
      assert.deepEqual(await fs.readdir(dataRoot), ['event.json']);
      assert.equal(publisher.blocked, false);
      assert.equal(reservations, 11);
      assert.deepEqual(invalidated, ['invalid.json', 'wrong-sequence.json', 'wrong-hash.json'].map(name => path.join(dataRoot, name)));

      const run = publisher.runNativeMutation.bind(publisher);
      let executions = 0;
      let verifications = 0;
      publisher.runNativeMutation = async (op, fields, timeout) => {
        const outcome = await run(op, fields, timeout);
        if (op !== 'codec') { return outcome; }
        if (fields['verifyOnly'] === true) { verifications++; return outcome; }
        executions++;
        // The fixture discards the first complete native reply.
        return executions === 1 ? { result: null, ended: true, failure: new NativeOperationError('unavailable') } : outcome;
      };
      const recovered = await codec.rewriteEvent('event.json', compacted.bytes, { ...acceptedMetadata, compacted: true, acknowledgedAt: now }, true);
      assert.equal(recovered.metadata['acknowledgedAt'], now);
      assert.equal(recovered.metadata['payloadBindingSha256'], created.metadata['payloadBindingSha256']);
      assert.deepEqual(await fs.readFile(path.join(dataRoot, 'event.json')), recovered.bytes);
      assert.equal(recovered.cleanupComplete, false);
      assert.equal(publisher.blocked, true);
      await assert.rejects(publisher.publishJson('next.json', {}), PublicationError);
      assert.deepEqual(await fs.readdir(dataRoot), ['event.json']);
      assert.equal(reservations, 12);
      assert.equal(executions, 1);
      assert.equal(verifications, 1);
    } finally {
      await publisher.idle();
      await guard.release();
      await fixture.close();
    }
  });

  it('refuses a missing complete-transition reservation before creating staging', { timeout: 60000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = (await createTestNative(fixture.root, { companionRoot: fixture.root, dataRoot: fixture.root })).supervisor;
    const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
    const publisher = new FilePublisher({ root: fixture.root, guard, supervisor, inspector: new PathInspector(supervisor), preflight: async () => {}, invalidate: () => {} });
    const codec = new PayloadCodec(publisher, async () => { throw new Error('transition refused'); });
    try {
      await assert.rejects(codec.inspectSource(Buffer.from('{}'), 1), /transition refused/);
      assert.deepEqual(await fs.readdir(fixture.root), []);
      assert.equal(publisher.blocked, false);
    } finally { await guard.release(); await fixture.close(); }
  });
});
