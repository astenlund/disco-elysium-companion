import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';

import { DataRootUnavailableError, PathInspector } from '../src/admission.ts';
import type { PayloadCodec } from '../src/codec.ts';
import { Deadline } from '../src/deadline.ts';
import type { FilePublisher } from '../src/files.ts';
import { Journal } from '../src/journal.ts';
import { eventFileName, eventRewriteMetadata } from '../src/journal-records.ts';
import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { ProcessSupervisor } from '../src/process.ts';
import { scopeComponents } from '../src/scope.ts';
import { companionFixture } from './support/companion.ts';
import { journalEvent } from './support/journal-event.ts';

function readOnlyJournal(root: string, inspector: PathInspector): Journal {
  return new Journal({ root, game: 'game', principal: 'principal', identities: { runtimeInstanceId: '1'.repeat(32), runtimeSessionId: '2'.repeat(32), adapterBindingEpoch: '3'.repeat(32) },
    inspector, publisher: {} as FilePublisher, codec: {} as PayloadCodec, admitMutation: async () => { throw new Error('unexpected mutation'); }, eventIdAvailable: async () => { throw new Error('unexpected mutation'); } });
}

async function measureColdHistory(context: TestContext, count: number): Promise<void> {
    const fixture = await companionFixture('context-event');
    const root = path.join(fixture.root, ...scopeComponents('game', 'principal'));
    await fs.mkdir(path.join(root, 'journal', 'events'), { recursive: true });
    const supervisor = await ProcessSupervisor.create(root);
    const inspector = new PathInspector(supervisor);
    const nativeMetadata = inspector.metadata.bind(inspector);
    const batches: { records: number; wireBytes: number; expandedBytes: number; elapsedMs: number }[] = [];
    const returnedDocuments: unknown[] = [];
    inspector.metadata = async (script, ...args) => {
      const started = performance.now();
      const reply = await nativeMetadata(script, ...args);
      if (path.basename(script) === 'Get-EventMetadata.ps1' && reply.exitCode === 0) {
        const expanded = inflateSync(reply.stdout);
        const parsed = JSON.parse(expanded.toString('utf8')) as { documents: unknown[] };
        parseStrictJson(expanded);
        assert.ok(reply.stdout.length <= 65536);
        const batch = { records: parsed.documents.length, wireBytes: reply.stdout.length, expandedBytes: expanded.length, elapsedMs: Math.round(performance.now() - started) };
        batches.push(batch);
        returnedDocuments.push(...parsed.documents);
        if (count <= 512) { context.diagnostic(JSON.stringify({ batch })); }
      }
      return reply;
    };
    const journal = readOnlyJournal(root, inspector);
    try {
      const directory = path.join(root, 'journal', 'events');
      const template = await fs.readFile(path.join(fixture.root, 'journal', 'events', eventFileName(1)), 'utf8');
      const payloadStart = template.indexOf(',"payload":');
      assert.ok(payloadStart > 0);
      // Only metadata is reserialized. Every full fixture preserves the shared
      // native sample's exact raw payload and its existing integrity binding.
      const templateMetadata = JSON.parse(template.slice(0, payloadStart) + '}') as Record<string, unknown>;
      const rawPayloadSuffix = template.slice(payloadStart);
      const timestamp = '2026-10-08T01:00:00.0000000Z';
      await fs.writeFile(path.join(root, 'journal', 'journal.json'), stringifyJson({ journalVersion: 1, journalId: 'journal', createdAt: timestamp, highWaterSequence: count, historyVerified: true }));
      await fs.writeFile(path.join(root, 'journal', 'cursor-agent-session.json'), stringifyJson({ cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: count, lastSentSequence: count, lastAcceptedRevision: null, updatedAt: timestamp }));
      for (const kind of ['compact', 'full'] as const) {
        const hashes: string[] = [];
        let totalBytes = 0;
        let minimumBytes = Infinity;
        let maximumBytes = 0;
        for (let sequence = 1; sequence <= count; sequence++) {
          const token = (): string => randomBytes(16).toString('hex');
          const metadata = { ...templateMetadata, sequence, eventId: token(), runtimeInstanceId: token(), adapterBindingEpoch: token(), logicalOutboxId: `${token()}-${sequence}`, compacted: kind === 'compact',
            acceptance: { journalId: token(), eventId: token(), generation: token() } };
          const bytes = Buffer.from(kind === 'compact' ? stringifyJson(metadata) : stringifyJson(metadata).slice(0, -1) + rawPayloadSuffix);
          hashes.push(createHash('sha256').update(bytes).digest('hex'));
          totalBytes += bytes.length;
          minimumBytes = Math.min(minimumBytes, bytes.length);
          maximumBytes = Math.max(maximumBytes, bytes.length);
          await fs.writeFile(path.join(directory, eventFileName(sequence)), bytes);
        }
        assert.equal(new Set(hashes).size, count);
        journal.invalidate();
        batches.length = 0;
        returnedDocuments.length = 0;
        const started = performance.now();
        const snapshot = await journal.read(Deadline.after(120000)).catch(error => {
          context.diagnostic(JSON.stringify({ kind, count, failed: true, elapsedMs: Math.round(performance.now() - started), eventPathBytes: Buffer.byteLength(path.join(directory, eventFileName(1))), batches }));
          throw error;
        });
        const elapsedMs = Math.round(performance.now() - started);
        assert.equal(snapshot.fault, null);
        assert.equal(snapshot.damaged.length, 0);
        assert.equal(snapshot.events.size, count);
        for (let sequence = 1; sequence <= count; sequence++) {
          const event = snapshot.events.get(sequence)!;
          assert.equal(event.sha256, hashes[sequence - 1]);
          assert.equal(event.metadata.compacted, kind === 'compact');
          assert.equal(event.metadata.targetIdentitySha256 === null, kind === 'compact');
        }
        assert.equal(batches.reduce((sum, batch) => sum + batch.records, 0), count);
        if (count <= 512) {
          const complete = Buffer.from(JSON.stringify({ requestSha256: 'a'.repeat(64), documents: returnedDocuments }));
          let configError: string | null = null;
          try { parseStrictJson(complete); } catch (error) { configError = String(error); }
          let tokens = 0;
          let decodedTextBytes = 0;
          const charge = (value: unknown): void => {
            if (Array.isArray(value)) { tokens += 2; for (const item of value) { charge(item); } }
            else if (typeof value === 'object' && value !== null) {
              tokens += 2;
              for (const [key, item] of Object.entries(value)) { tokens++; decodedTextBytes += Buffer.byteLength(key); charge(item); }
            } else { tokens++; if (typeof value === 'string') { decodedTextBytes += Buffer.byteLength(value); } }
          };
          charge(JSON.parse(complete.toString('utf8')));
          context.diagnostic(JSON.stringify({ kind, completeProjectionBytes: complete.length, tokens, decodedTextBytes, configError,
            levelOneProjectionWireBytes: deflateSync(complete, { level: 1 }).length }));
        }
        context.diagnostic(JSON.stringify({ kind, count, totalBytes, minimumBytes, maximumBytes, eventPathBytes: Buffer.byteLength(path.join(directory, eventFileName(1))), independentlyRandomIdentityFields: 7,
          rawPayloadBytes: kind === 'full' ? Buffer.byteLength(rawPayloadSuffix.slice(11, -1)) : 0,
          elapsedMs, nativeMetadataCalls: batches.length, batches, maximumWireBytes: Math.max(...batches.map(batch => batch.wireBytes)), maximumExpandedBytes: Math.max(...batches.map(batch => batch.expandedBytes)), completeHashesVerified: count }));
      }
    } finally { await journal.idle(); await inspector.idle(); await fixture.close(); }
}

describe('native journal cache admission', () => {
  it('measures one 512-record scoped cold metadata request', { timeout: 120000 }, async context => { await measureColdHistory(context, 512); });
  it('admits cold 8192-record scoped compact and full histories within their original deadline', { timeout: 360000 }, async context => { await measureColdHistory(context, 8192); });

  it('rehashes retained history without restarting a parser for each small batch and detects physical or byte damage', { timeout: 240000 }, async context => {
    const fixture = await companionFixture();
    const root = fixture.root;
    const supervisor = await ProcessSupervisor.create(root);
    const inspector = new PathInspector(supervisor);
    const metadata = inspector.metadata.bind(inspector);
    const calls: string[] = [];
    inspector.metadata = (script, ...args) => { calls.push(path.basename(script)); return metadata(script, ...args); };
    // This read-only fixture refuses every mutation; it measures actual journal admission.
    const journal = readOnlyJournal(root, inspector);
    try {
      const directory = path.join(root, 'journal', 'events');
      await fs.mkdir(directory, { recursive: true });
      for (let sequence = 1; sequence <= 128; sequence++) {
        const event = journalEvent(sequence, { compacted: true, targetIdentitySha256: null, stateGeneratedAt: null });
        await fs.writeFile(path.join(directory, eventFileName(sequence)), stringifyJson({ ...eventRewriteMetadata(event), payloadBindingSha256: event.payloadBindingSha256 }));
      }
      const timestamp = '2026-10-08T01:00:00.0000000Z';
      await fs.writeFile(path.join(root, 'journal', 'journal.json'), stringifyJson({ journalVersion: 1, journalId: 'journal', createdAt: timestamp, highWaterSequence: 128, historyVerified: true }));
      await fs.writeFile(path.join(root, 'journal', 'cursor-agent-session.json'), stringifyJson({ cursorVersion: 1, journalId: 'journal', consumerId: 'agent-session', lastAckedSequence: 128, lastSentSequence: 128, lastAcceptedRevision: null, updatedAt: timestamp }));
      const started = performance.now();
      assert.equal((await journal.read(Deadline.after(120000))).events.size, 128);
      context.diagnostic(`cold128Ms=${Math.round(performance.now() - started)} metadataCalls=${calls.length}`);
      assert.equal(calls.filter(name => name === 'Get-EventMetadata.ps1').length, 1);
      calls.length = 0;
      const warmStarted = performance.now();
      assert.equal((await journal.read(Deadline.after(120000))).events.size, 128);
      context.diagnostic(`warm128Ms=${Math.round(performance.now() - warmStarted)} metadataCalls=${calls.length}`);
      assert.equal(calls.filter(name => name === 'Get-EventMetadata.ps1').length, 0);
      assert.equal(calls.filter(name => name === 'Get-FileHashes.ps1').length, 1);
      assert.equal(calls.filter(name => name === 'Get-PathAdmission.ps1').length, 1);
      const first = path.join(directory, eventFileName(1));
      const original = await fs.readFile(first);
      await fs.writeFile(first, '{}');
      const damaged = await journal.read();
      assert.equal(damaged.events.has(1), false);
      assert.equal(damaged.damaged.length, 1);
      await fs.writeFile(first, original);
      assert.equal((await journal.read()).events.size, 128);
      const hardlink = path.join(root, 'unexpected-hardlink.json');
      await fs.link(first, hardlink);
      await assert.rejects(journal.read(), DataRootUnavailableError);
      await fs.unlink(hardlink);
      const cursorPath = path.join(root, 'journal', 'cursor-agent-session.json');
      const cursorBytes = await fs.readFile(cursorPath);
      await fs.unlink(cursorPath);
      assert.equal((await journal.read()).fault, 'cursor');
      await fs.mkdir(cursorPath);
      await assert.rejects(journal.read(), /control path is not a file/);
      await fs.rmdir(cursorPath);
      await fs.writeFile(cursorPath, cursorBytes);
      const controlLink = path.join(root, 'linked-header.json');
      await fs.link(path.join(root, 'journal', 'journal.json'), controlLink);
      await assert.rejects(journal.read(), DataRootUnavailableError);
      await fs.unlink(controlLink);
    } finally { await journal.idle(); await inspector.idle(); await fixture.close(); }
  });
});
