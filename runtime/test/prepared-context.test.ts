import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { NativeOperationError, PathInspector } from '../src/admission.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { FilePublisher, PublicationError } from '../src/files.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { isObject, parseStrictJson, stringifyJson } from '../src/json.ts';
import { ContextPreparer } from '../src/prepared-context.ts';
import { ScopeStorage } from '../src/storage.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function contextHarness(withEvent = false) {
  const fixture = await companionFixture(withEvent ? 'context-event' : 'context');
  const native = await createTestNative(fixture.root, { companionRoot: fixture.root, dataRoot: fixture.root });
  const supervisor = native.supervisor;
  const inspector = new PathInspector(supervisor);
  const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
  const scopeSha256 = hash(await fs.readFile(path.join(fixture.root, 'scope.json')));
  const safetySha256 = hash(await fs.readFile(path.join(fixture.root, 'state-safety.json')));
  const control = { current: true, invalidated: [] as string[], beforeAdmission: async () => {} };
  const publisher = new FilePublisher({ root: fixture.root, guard, supervisor, inspector, preflight: async () => {}, invalidate: target => control.invalidated.push(target) });
  // This component fixture checks actual scope/safety files; full coordinator
  // operation and provider-binding proofs belong to the production integration.
  const scope = { companionRoot: fixture.root, dataRoot: fixture.root, game: 'game', principal: 'principal', bindingSha256: scopeSha256, createdHere: false };
  const preparer = new ContextPreparer({ scope, publisher,
    admit: async request => { await control.beforeAdmission(); return control.current && isObject(request) && request['safetySha256'] === hash(await fs.readFile(path.join(fixture.root, 'state-safety.json'))); },
    reserve: async reservation => { assert.ok(reservation.inputBytes > 0); } });
  const request = { contextRequestVersion: 1, scopeSha256, safetySha256, generation: '1'.repeat(32), journalId: null, game: 'game', principal: 'principal',
    template: { companionTurnContextVersion: 1, interactionId: 'interaction', requestReceivedAt: '2026-10-08T06:00:00.0000000Z', sessionOpening: true,
      freshness: { state: 'failed', class: 'journal', reason: 'settlementPending', lastGoodGeneratedAt: null }, operational: { state: 'unknown', warnings: [] }, correction: null },
    events: [], state: null, stateWanted: true, shape: null, failedBlockBytes: null, instructionsSha256: 'a'.repeat(64), providerFingerprint: 'b'.repeat(64), disclosure: true };
  return { fixture, supervisor, inspector, guard, control, publisher, preparer, request, scope,
    close: async () => { await publisher.idle(); await native.close(); await guard.release(); await fixture.close(); } };
}

describe('prepared context ownership', () => {
  it('copies an exact native redelivery variant after a lost publication reply without changing nested payload flags', { timeout: 120000 }, async () => {
    const harness = await contextHarness(true);
    const { fixture, preparer, publisher, request } = harness;
    try {
      const eventHash = hash(await fs.readFile(path.join(fixture.root, 'journal/events/0000000000000001.json')));
      const selected = { ...request, journalId: 'journal', events: [{ sequence: 1, sha256: eventHash, redelivery: false }], state: { sequence: 1, sha256: eventHash }, disclosure: false,
        template: { ...request.template, freshness: { state: 'fresh', class: null, reason: null, lastGoodGeneratedAt: null }, operational: { state: 'current', warnings: [] } } };
      const preview = await preparer.preview(selected);
      const candidate = preview.candidates.find(item => item.shape === 1)!;
      const run = publisher.runNativeMutation.bind(publisher);
      publisher.runNativeMutation = async (op, fields, timeout) => {
        const outcome = await run(op, fields, timeout);
        // The fixture discards a complete publication reply.
        return op === 'contextPreparation' && fields['mode'] === 'Publish' ? { result: null, ended: true, failure: new NativeOperationError('unavailable') } : outcome;
      };
      const prepared = await preparer.prepare(preview, candidate);
      const copies = await preparer.copyVariantsForSend(prepared);
      assert.equal(publisher.blocked, true);
      assert.equal(prepared.cleanupComplete, false);
      assert.equal(copies.redeliveryText, copies.text.replace('"redelivery":false', '"redelivery":true'));
      assert.ok(copies.redeliveryText.includes('"nested":{"redelivery":false}'));
      for (const lexeme of ['9007199254740993', '0.123456789012345678901', '1e400', '"negativeZero":-0', String.raw`\u0061`, '2026-10-07T01:23:45.1234567Z']) {
        assert.ok(copies.text.includes(lexeme), lexeme);
        assert.ok(copies.redeliveryText.includes(lexeme), lexeme);
      }
      assert.equal(hash(Buffer.from(copies.text)), candidate.sha256);
      assert.equal(hash(Buffer.from(copies.redeliveryText)), copies.redeliveryCandidate.sha256);
      assert.equal(copies.redeliveryCandidate.bytes, candidate.bytes - 1);
      assert.equal(copies.redeliveryCandidate.fingerprint, candidate.fingerprint);
      assert.equal(await fs.readFile(path.join(fixture.root, 'prepared-context.txt'), 'utf8'), copies.text);
      assert.ok(Object.isFrozen(copies));
    } finally { await harness.close(); }
  });

  it('finishes admission alongside an actual storage write without reversing queue ownership', { timeout: 180000 }, async () => {
    const harness = await contextHarness();
    const { publisher, preparer, request, control, scope, guard, inspector } = harness;
    const storage = new ScopeStorage({ scope, guard, inspector, publisher });
    const queued = Promise.withResolvers<void>();
    let write: Promise<string> | null = null;
    let storagePublication = false;
    let contextOwned = false;
    let triggered = false;
    const exclusive = publisher.exclusive.bind(publisher);
    publisher.exclusive = (operation, deadline) => {
      const isStorage = storagePublication;
      return exclusive(async options => {
        if (!isStorage) { contextOwned = true; }
        try { return await operation(options); }
        finally { if (!isStorage) { contextOwned = false; } }
      }, deadline);
    };
    const publish = publisher.publish.bind(publisher);
    publisher.publish = (...args) => {
      storagePublication = true;
      try { const pending = publish(...args); queued.resolve(); return pending; }
      finally { storagePublication = false; }
    };
    control.beforeAdmission = async () => {
      assert.equal(contextOwned, false, 'Context admission must not hold the publication queue while reading storage.');
      await storage.read('agent-session.json', 'config', value => value, Deadline.after(120000));
    };
    const run = publisher.runNativeMutation.bind(publisher);
    publisher.runNativeMutation = async (op, fields, ...rest) => {
      if (!triggered && op === 'contextPreparation' && fields['mode'] === 'Preview') {
        triggered = true;
        write = storage.write('agent-session.json', { bindingVersion: 1 }, 'config', null, Deadline.after(120000));
        void write.catch(error => queued.reject(error));
        await queued.promise;
      }
      return run(op, fields, ...rest);
    };
    try {
      const preview = await preparer.preview(request, Deadline.after(120000));
      assert.equal(triggered, true);
      assert.notEqual(write, null);
      await write;
      assert.equal(preview.candidates.length, 1);
      assert.equal((await storage.read('agent-session.json', 'config', value => value)).status, 'valid');
      assert.equal(publisher.blocked, false);
    } finally { await storage.idle(); await harness.close(); }
  });

  it('retires only its own artifact when final admission fails and retains uncertain cleanup ownership', { timeout: 180000 }, async () => {
    for (const cleanupFault of [false, true]) {
      const harness = await contextHarness();
      const { fixture, preparer, publisher, inspector, request, control } = harness;
      try {
        const preview = await preparer.preview(request);
        const run = publisher.runNativeMutation.bind(publisher);
        publisher.runNativeMutation = async (op, fields, ...rest) => {
          const outcome = await run(op, fields, ...rest);
          if (op === 'contextPreparation' && fields['mode'] === 'Publish') { control.current = false; }
          return outcome;
        };
        control.beforeAdmission = async () => {
          if (!control.current && cleanupFault) {
            const inspect = inspector.inspect.bind(inspector);
            inspector.inspect = async (root, target, ...args) => {
              if (path.basename(target) === 'prepared-context.txt') { throw new Error('Fixture cleanup authority unavailable.'); }
              return inspect(root, target, ...args);
            };
          }
        };
        await assert.rejects(preparer.prepare(preview, preview.candidates[0]!), /no current authority/);
        assert.equal(publisher.blocked, cleanupFault);
        assert.equal(preparer.current !== null, cleanupFault);
        assert.equal((await fs.readdir(fixture.root)).includes('prepared-context.txt'), cleanupFault);
      } finally { await harness.close(); }
    }
  });

  it('rejects malformed offset metadata and a validly framed but wrong native redelivery hash', { timeout: 180000 }, async () => {
    for (const fault of ['offset', 'hash'] as const) {
      const harness = await contextHarness();
      const { fixture, preparer, request, publisher } = harness;
      try {
        const run = publisher.runNativeMutation.bind(publisher);
        publisher.runNativeMutation = async (op, fields, ...rest) => {
          const outcome = await run(op, fields, ...rest);
          if (op === 'contextPreparation' && fields['mode'] === 'Preview' && outcome.result !== null) {
            const response = JSON.parse(stringifyJson(outcome.result));
            if (fault === 'offset') { response.redeliveryOffsets = '!!!!'; }
            else { response.candidates[0].redeliverySha256 = '0'.repeat(64); }
            return { ...outcome, result: parseStrictJson(Buffer.from(JSON.stringify(response))) };
          }
          return outcome;
        };
        if (fault === 'offset') {
          await assert.rejects(preparer.preview(request), /redelivery offsets are invalid/);
          assert.equal(publisher.blocked, false);
          assert.equal((await fs.readdir(fixture.root)).includes('prepared-context.txt'), false);
        } else {
          const preview = await preparer.preview(request);
          await assert.rejects(preparer.prepare(preview, preview.candidates[0]!), /native hash/);
          assert.equal(publisher.blocked, true);
          assert.equal((await fs.readdir(fixture.root)).includes('prepared-context.txt'), true);
          assert.equal(preparer.current, null);
        }
      } finally { await harness.close(); }
    }
  });

  it('publishes exact preview bytes, rechecks send authority and retires one-use artifacts', { timeout: 120000 }, async () => {
    const harness = await contextHarness();
    const { fixture, publisher, preparer, request, control } = harness;
    try {
      let clock = 0;
      const expired = Deadline.after(1, () => clock);
      clock = 1;
      await assert.rejects(preparer.preview(request, expired), DeadlineExceededError);
      const preview = await preparer.preview(request);
      assert.equal(preview.candidates.length, 1);
      assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['scope.json', 'state-safety.json']);
      const candidate = preview.candidates[0]!;
      const prepared = await preparer.prepare(preview, candidate);
      assert.equal(prepared.cleanupComplete, true);
      const text = await preparer.copyForSend(prepared);
      assert.equal(hash(Buffer.from(text)), candidate.sha256);
      assert.equal(Buffer.byteLength(text), candidate.bytes);
      assert.equal(text, await fs.readFile(path.join(fixture.root, 'prepared-context.txt'), 'utf8'));
      await assert.rejects(preparer.preview(request), PublicationError);
      control.current = false;
      await assert.rejects(preparer.copyForSend(prepared), PublicationError);
      control.current = true;
      const scopePath = path.join(fixture.root, 'scope.json');
      const scopeBytes = await fs.readFile(scopePath);
      await fs.writeFile(scopePath, '{}');
      await assert.rejects(preparer.copyForSend(prepared), PublicationError);
      await assert.rejects(preparer.discard(prepared), PublicationError);
      assert.equal(await fs.readFile(path.join(fixture.root, 'prepared-context.txt'), 'utf8'), text);
      await fs.writeFile(scopePath, scopeBytes);
      await preparer.discard(prepared);
      await assert.rejects(preparer.prepare(preview, candidate), PublicationError);
      await assert.rejects(preparer.copyForSend(prepared), PublicationError);
      assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['scope.json', 'state-safety.json']);

      const changedPreview = await preparer.preview(request);
      const safetyPath = path.join(fixture.root, 'state-safety.json');
      const safetyBytes = await fs.readFile(safetyPath);
      await fs.writeFile(safetyPath, '{}');
      await assert.rejects(preparer.prepare(changedPreview, changedPreview.candidates[0]!), PublicationError);
      assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['scope.json', 'state-safety.json']);
      await fs.writeFile(safetyPath, safetyBytes);

      const lostReplyPreview = await preparer.preview(request);
      const run = publisher.runNativeMutation.bind(publisher);
      publisher.runNativeMutation = async (op, fields, timeout) => {
        const outcome = await run(op, fields, timeout);
        // The fixture discards the complete context reply.
        return op === 'contextPreparation' && fields['mode'] === 'Publish' ? { result: null, ended: true, failure: new NativeOperationError('unavailable') } : outcome;
      };
      const recovered = await preparer.prepare(lostReplyPreview, lostReplyPreview.candidates[0]!);
      assert.equal(recovered.cleanupComplete, false);
      assert.equal(hash(Buffer.from(await preparer.copyForSend(recovered))), recovered.candidate.sha256);
      assert.equal(publisher.blocked, true);
      await assert.rejects(preparer.preview(request), PublicationError);
      assert.equal(preparer.current, recovered);
    } finally { await harness.close(); }
  });

  it('retains ownership on unknown termination and distinguishes unreadable postconditions from incomplete cleanup', { timeout: 180000 }, async () => {
    for (const fault of ['termination', 'postcondition', 'cleanup'] as const) {
      const harness = await contextHarness();
      const { fixture, inspector, publisher, preparer, request, control } = harness;
      try {
        const preview = await preparer.preview(request);
        const run = publisher.runNativeMutation.bind(publisher);
        let published = false;
        publisher.runNativeMutation = async (op, fields, timeout) => {
          const publishing = op === 'contextPreparation' && fields['mode'] === 'Publish';
          if (publishing && fault === 'termination') {
            // The injected outcome carries no observed service exit.
            return { result: null, ended: false, failure: new NativeOperationError('unavailable') };
          }
          const outcome = await run(op, fields, timeout);
          if (publishing) { published = true; }
          return outcome;
        };
        const inspect = inspector.inspect.bind(inspector);
        inspector.inspect = async (root, target, ...args) => {
          if (published && (fault === 'postcondition' && path.basename(target) === 'prepared-context.txt' || fault === 'cleanup' && target.endsWith('.tmp'))) {
            throw new Error('Fixture readback I/O failure.');
          }
          return inspect(root, target, ...args);
        };
        if (fault === 'cleanup') {
          const prepared = await preparer.prepare(preview, preview.candidates[0]!);
          assert.equal(prepared.cleanupComplete, false);
          assert.equal(hash(Buffer.from(await preparer.copyForSend(prepared))), prepared.candidate.sha256);
          // Incomplete cleanup blocks the publisher, which invalidates the data root; the published target stays valid.
          assert.deepEqual(new Set(control.invalidated), new Set([fixture.root]));
        } else {
          await assert.rejects(preparer.prepare(preview, preview.candidates[0]!));
          assert.equal(preparer.current, null);
          // The attempted target is invalidated, and blocking the publisher invalidates the whole data root.
          assert.ok(control.invalidated.includes(path.join(fixture.root, 'prepared-context.txt')));
          assert.deepEqual(new Set(control.invalidated), new Set([fixture.root, path.join(fixture.root, 'prepared-context.txt')]));
        }
        assert.equal(publisher.blocked, true);
        await assert.rejects(preparer.preview(request), PublicationError);
        const siblings = (await fs.readdir(fixture.root)).filter(name => name.endsWith('.tmp'));
        assert.equal(siblings.length, fault === 'postcondition' ? 0 : 1);
      } finally { await harness.close(); }
    }
  });
});
