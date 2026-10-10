import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { PayloadCodec, CodecDocumentError } from '../src/codec.ts';
import { Deadline } from '../src/deadline.ts';
import { FilePublisher, PublicationError } from '../src/files.ts';
import { asInt64, parseStrictJson } from '../src/json.ts';

function model(cleanupComplete = true) {
  let blocked = false;
  const publisher = { assertAvailable: () => { if (blocked) { throw new PublicationError('Fixture workspace blocked.'); } }, block: () => { blocked = true; } };
  const codec = new PayloadCodec(publisher as unknown as FilePublisher, async () => {});
  // Native parsing is exercised by codec.test.ts; these controls isolate receipt ownership.
  codec.inspectSource = async bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), metadata: { game: 'stubgame', nested: { value: 'one' }, adapterVersion: parseStrictJson(Buffer.from('9223372036854775807')) }, bytes: Buffer.from(bytes), cleanupComplete });
  return { codec, publisher };
}

test('source receipt is exact-byte, sequence-bound, codec-local, single-use and metadata-isolated', async () => {
  const { codec } = model();
  const bytes = Buffer.from('frozen source');
  const inspected = await codec.inspectSourceWithReceipt(bytes, 1);
  inspected.metadata['game'] = 'changed';
  (inspected.metadata['nested'] as { value: string }).value = 'two';
  const consumed = codec.consumeSourceInspection(inspected.receipt, bytes, 1);
  assert.equal(consumed.metadata['game'], 'stubgame');
  assert.equal((consumed.metadata['nested'] as { value: string }).value, 'one');
  assert.equal(asInt64(consumed.metadata['adapterVersion']), 9223372036854775807n);
  assert.throws(() => codec.consumeSourceInspection(inspected.receipt, bytes, 1), CodecDocumentError);
  assert.throws(() => codec.consumeSourceInspection({ sourceInspection: true }, bytes, 1), CodecDocumentError);
  const wrongCodec = await codec.inspectSourceWithReceipt(bytes, 1);
  assert.throws(() => model().codec.consumeSourceInspection(wrongCodec.receipt, bytes, 1), CodecDocumentError);
  const wrongSequence = await codec.inspectSourceWithReceipt(bytes, 1);
  assert.throws(() => codec.consumeSourceInspection(wrongSequence.receipt, bytes, 2), CodecDocumentError);
  assert.throws(() => codec.consumeSourceInspection(wrongSequence.receipt, bytes, 1), CodecDocumentError);
  const changed = await codec.inspectSourceWithReceipt(bytes, 1);
  assert.throws(() => codec.consumeSourceInspection(changed.receipt, Buffer.from('changed source'), 1), CodecDocumentError);
});

test('source receipt cannot bypass failed cleanup, blocked publication or an expired deadline', async () => {
  const bytes = Buffer.from('frozen source');
  const incomplete = model(false);
  await assert.rejects(incomplete.codec.inspectSourceWithReceipt(bytes, 1), PublicationError);
  assert.throws(() => incomplete.publisher.assertAvailable(), PublicationError);
  const blocked = model();
  const inspected = await blocked.codec.inspectSourceWithReceipt(bytes, 1);
  blocked.publisher.block();
  assert.throws(() => blocked.codec.consumeSourceInspection(inspected.receipt, bytes, 1), PublicationError);
  const timed = model();
  const expiring = await timed.codec.inspectSourceWithReceipt(bytes, 1);
  assert.throws(() => timed.codec.consumeSourceInspection(expiring.receipt, bytes, 1, Deadline.fromStart(0, 1, () => 2)));
  assert.throws(() => timed.codec.consumeSourceInspection(expiring.receipt, bytes, 1), CodecDocumentError);
});
