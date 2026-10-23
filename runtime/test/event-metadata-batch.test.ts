import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DataRootUnavailableError, NativeOperationError, PathInspector } from '../src/admission.ts';
import { Deadline } from '../src/deadline.ts';
import { EventReader } from '../src/event-reader.ts';
import { eventFileName } from '../src/journal-records.ts';
import { jsonBudgets, stringifyJson } from '../src/json.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

describe('native bounded event metadata batches', () => {
  it('preserves complete valid and invalid hashes, absence and unreadable failures', { timeout: 120000 }, async () => {
    const fixture = await companionFixture('context-event');
    const inspector = new PathInspector((await createTestNative(fixture.root)).supervisor);
    const reader = new EventReader(fixture.root, inspector);
    const target = path.join('journal', 'events', eventFileName(1));
    const requests = [{ path: target, sequence: 1 }, { path: 'missing.json', sequence: 2 }, { path: 'invalid.json', sequence: 3 }];
    try {
      const valid = await fs.readFile(path.join(fixture.root, target));
      const invalid = Buffer.from('{"broken":');
      await fs.writeFile(path.join(fixture.root, 'invalid.json'), invalid);
      const result = await reader.readInventory(requests);
      assert.deepEqual(result.map(value => value.status), ['valid', 'absent', 'invalid']);
      assert.deepEqual(result.map(value => value.sha256), [createHash('sha256').update(valid).digest('hex'), null, createHash('sha256').update(invalid).digest('hex')]);
      assert.deepEqual(await reader.read(requests), result);
      await fs.mkdir(path.join(fixture.root, 'directory'));
      await assert.rejects(reader.readInventory([{ path: 'directory', sequence: 4 }]), DataRootUnavailableError);
      const bytes = Buffer.alloc(jsonBudgets['state-event'].maxBytes + 1, 32);
      valid.copy(bytes);
      await fs.writeFile(path.join(fixture.root, 'oversized.json'), bytes);
      const oversized = await reader.readInventory([{ path: 'oversized.json', sequence: 5 }]);
      assert.equal(oversized[0]!.status, 'invalid');
      assert.equal(oversized[0]!.sha256, createHash('sha256').update(bytes).digest('hex'));
    } finally { await inspector.idle(); await fixture.close(); }
  });

  it('returns a useful prefix before the next full-profile file and preserves direct source mode', { timeout: 120000 }, async context => {
    const fixture = await companionFixture('context-event');
    const inspector = new PathInspector((await createTestNative(fixture.root)).supervisor);
    const reader = new EventReader(fixture.root, inspector);
    try {
      const first = path.join('journal', 'events', eventFileName(1));
      const template = await fs.readFile(path.join(fixture.root, first));
      const maximum = Buffer.alloc(jsonBudgets['state-event'].maxBytes, 32);
      template.copy(maximum);
      await fs.writeFile(path.join(fixture.root, first), maximum);
      const second = path.join('journal', 'events', eventFileName(2));
      await fs.writeFile(path.join(fixture.root, second), template.toString('utf8').replace('"sequence":1', '"sequence":2'));
      let calls = 0;
      const native = inspector.native.bind(inspector);
      inspector.native = (op, ...args) => { if (op === 'eventBatch') { calls++; } return native(op, ...args); };
      const result = await reader.readInventory([{ path: first, sequence: 1 }, { path: second, sequence: 2 }], Deadline.after(60000));
      assert.equal(calls, 2);
      assert.deepEqual(result.map(value => value.status), ['valid', 'valid']);
      assert.equal(result[0]!.sha256, createHash('sha256').update(maximum).digest('hex'));
      context.diagnostic(`profileBytes=${maximum.length} records=2 nativeCalls=${calls}`);
      const sourceRequest = JSON.stringify([{ path: path.join(fixture.root, 'missing-source.json'), sequence: 1 }]);
      const source = await native('eventMetadata', { root: fixture.root, requestsJson: sourceRequest, source: true });
      assert.deepEqual(JSON.parse(stringifyJson(source)), { documents: [{ path: path.join(fixture.root, 'missing-source.json'), status: 'absent', sha256: null, metadata: null }] });
    } finally { await inspector.idle(); await fixture.close(); }
  });

  it('returns a correct metadata prefix of a large batch within the document budget', { timeout: 120000 }, async context => {
    const fixture = await companionFixture('context-event');
    const inspector = new PathInspector((await createTestNative(fixture.root)).supervisor);
    try {
      const directory = path.join(fixture.root, 'journal', 'events');
      const text = await fs.readFile(path.join(directory, eventFileName(1)), 'utf8');
      const marker = text.indexOf(',"payload":');
      assert.ok(marker > 0);
      const template = JSON.parse(text.slice(0, marker) + '}') as Record<string, unknown>;
      const requests = [];
      const expected = new Map<string, string>();
      for (let sequence = 1; sequence <= 512; sequence++) {
        const token = (): string => randomBytes(64).toString('hex');
        const target = path.join(directory, eventFileName(sequence));
        const bytes = Buffer.from(JSON.stringify({ ...template, sequence, compacted: true, journalId: token(), principal: token(), acceptance: { journalId: token(), eventId: token(), generation: randomBytes(16).toString('hex') } }));
        await fs.writeFile(target, bytes);
        expected.set(target, createHash('sha256').update(bytes).digest('hex'));
        requests.push({ path: target, sequence });
      }
      const input = Buffer.from(JSON.stringify(requests));
      const reply = stringifyJson(await inspector.native('eventBatch', { root: fixture.root, inputBase64: input.toString('base64') }));
      assert.ok(Buffer.byteLength(reply, 'utf8') <= jsonBudgets.config.maxBytes);
      const result = JSON.parse(reply) as { requestSha256: string; documents: { path: string; status: string; sha256: string; metadata: { sequence: number } }[] };
      assert.equal(result.requestSha256, createHash('sha256').update(input).digest('hex'));
      assert.ok(result.documents.length > 0 && result.documents.length <= requests.length);
      for (const [index, document] of result.documents.entries()) {
        assert.equal(document.path, requests[index]!.path);
        assert.equal(document.metadata.sequence, requests[index]!.sequence);
        assert.equal(document.status, 'valid');
        assert.equal(document.sha256, expected.get(document.path));
      }
      context.diagnostic(`requested=${requests.length} returned=${result.documents.length} replyBytes=${Buffer.byteLength(reply, 'utf8')}`);
    } finally { await inspector.idle(); await fixture.close(); }
  });

  it('rejects malformed, over-count, over-text and over-byte native requests', { timeout: 120000 }, async () => {
    const fixture = await companionFixture();
    const inspector = new PathInspector((await createTestNative(fixture.root)).supervisor);
    try {
      const badRequests = [
        '[{"path":"a","path":"b","sequence":1}]',
        '[{"path":"a","sequence":1.5}]',
        JSON.stringify(Array.from({ length: 513 }, () => ({ path: 'a', sequence: 1 }))),
        JSON.stringify([{ path: 'a'.repeat(jsonBudgets.config.maxTextBytes), sequence: 1 }]),
        ' '.repeat(jsonBudgets.config.maxBytes + 1),
      ];
      for (const request of badRequests) {
        await assert.rejects(inspector.native('eventBatch', { root: fixture.root, inputBase64: Buffer.from(request).toString('base64') }),
          error => error instanceof NativeOperationError && error.code === 'inspectionUnavailable');
      }
      assert.deepEqual(await fs.readdir(fixture.root), []);
    } finally { await inspector.idle(); await fixture.close(); }
  });
});
