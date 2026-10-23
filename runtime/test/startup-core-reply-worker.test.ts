import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { resolvePrincipal } from '../src/core-client.ts';
import { asInteger, isLowerHex, isObject, parseStrictJson } from '../src/json.ts';
import type { CommandResult } from '../src/process.ts';
import { encodeStartupWorkerFrame, FramedReplies } from '../src/startup-worker-framing.ts';
import { companionFixture } from './support/companion.ts';
import { testHelperImage } from './support/native-helper.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerScript = fileURLToPath(new URL('../scripts/StartupCoreReplyWorker.ps1', import.meta.url));
const readerScript = fileURLToPath(new URL('../scripts/Read-CoreReply.ps1', import.meta.url));

type CoreOperation = 'Publish' | 'Settlement' | 'Consumer';
interface CoreOutput { readonly exitCode: CommandResult['exitCode']; readonly stdout: string; readonly stderr: string }

test('startup core reply worker matches the one-shot validator for consumer, publication and settlement replies and survives a rejected reply', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
    const opened = backend;
    const nonce = randomBytes(16).toString('hex');
    const child = opened.supervisor.spawn('startupCoreReply', { command: 'pwsh',
      args: ['-NoProfile', '-File', workerScript, '-CompanionRoot', fixture.root, '-DataRoot', backend.scope.dataRoot,
        '-SourceRoot', repository, '-Nonce', nonce], cwd: fixture.root,
      env: { ...process.env, TEMP: path.join(fixture.root, '.tmp'), TMP: path.join(fixture.root, '.tmp') } });
    const replies = new FramedReplies(child);
    try {
      await child.ready;
      const hello = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(hello));
      assert.deepEqual(Object.keys(hello).sort(), ['nonce', 'scopeSha256', 'sourceSha256', 'version']);
      assert.equal(asInteger(hello['version']), 1);
      assert.equal(hello['nonce'], nonce);
      assert.equal(hello['scopeSha256'], backend.scope.bindingSha256);
      assert.ok(isLowerHex(hello['sourceSha256'], 64));

      // Real replies of the three core operations the runtime validates: consumer ownership, publication and its settlement.
      const runCore = async (script: string, args: readonly string[]): Promise<CoreOutput> => {
        const result = await opened.supervisor.run('core', { command: 'pwsh', args: ['-NoProfile', '-File', path.join(fixture.root, 'core', script),
          '-CompanionRoot', fixture.root, ...args], cwd: fixture.root }, 60000);
        await opened.supervisor.verifyQuiescent('core');
        return { exitCode: result.exitCode, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
      };
      const oneShot = async (operation: CoreOperation, core: CoreOutput): Promise<unknown> => {
        const result = await opened.inspector.metadata(readerScript, ['-CompanionRoot', fixture.root, '-Operation', operation], fixture.root, 30000, Buffer.from(JSON.stringify(core)));
        assert.equal(result.exitCode, 0, `${operation} one-shot validation failed.`);
        // The one-shot validator ran under the metadata role inside the inspector's queue, whose task included its stop proof.
        await opened.supervisor.verifyQuiescent('metadata');
        return parseStrictJson(result.stdout);
      };
      const warm = async (operation: CoreOperation, core: CoreOutput, stdout = core.stdout): Promise<Record<string, unknown>> => {
        const id = randomBytes(16).toString('hex');
        child.stdin.write(encodeStartupWorkerFrame({ version: 1, id, op: 'validateCore', root: fixture.root, remainingMs: 30000, operation, exitCode: core.exitCode, stdout, stderr: core.stderr }));
        const reply = parseStrictJson(await replies.next(30000));
        assert.ok(isObject(reply));
        assert.equal(asInteger(reply['version']), 1);
        assert.equal(reply['id'], id);
        assert.equal(reply['op'], 'validateCore');
        return reply;
      };
      const bothPaths = async (operation: CoreOperation, core: CoreOutput): Promise<Record<string, unknown>> => {
        const expected = await oneShot(operation, core);
        const reply = await warm(operation, core);
        assert.deepEqual(Object.keys(reply).sort(), ['id', 'op', 'result', 'status', 'version']);
        assert.equal(reply['status'], 'ok');
        assert.deepEqual(reply['result'], expected, `${operation} differs between the warm worker and the one-shot path.`);
        assert.ok(isObject(expected) && expected['success'] === true, `${operation} did not succeed.`);
        return expected;
      };

      const consumer = await runCore('Set-CompanionConsumer.ps1', ['-Owner', 'runtime']);
      const invalid = await warm('Consumer', consumer, 'invalid receipt');
      assert.deepEqual(Object.keys(invalid).sort(), ['code', 'id', 'op', 'status', 'version']);
      assert.equal(invalid['status'], 'error');
      assert.equal(invalid['code'], 'coreReplyInvalid');
      await bothPaths('Consumer', consumer);

      const published = await runCore('Publish-StateEvent.ps1', ['-Adapter', 'stub', '-Principal', await resolvePrincipal(opened.inspector), '-RequireRecord']);
      const publication = await bothPaths('Publish', published);
      assert.ok(isObject(publication['data']) && typeof publication['data']['logicalOutboxId'] === 'string');
      const logicalOutboxId = publication['data']['logicalOutboxId'];
      const sequence = asInteger(publication['data']['sequence']);
      assert.ok(sequence !== undefined && sequence > 0);
      const record = path.join(fixture.root, 'state', 'outbox', `event-${String(sequence).padStart(16, '0')}.json`);
      const observed = await opened.inspector.native('eventMetadata', { root: fixture.root, requestsJson: JSON.stringify([{ path: record, sequence }]), source: true });
      assert.ok(isObject(observed) && Array.isArray(observed['documents']));
      const document = observed['documents'][0];
      assert.ok(isObject(document) && typeof document['sha256'] === 'string');
      const settled = await runCore('Set-StateEventSettlement.ps1', ['-LogicalOutboxId', logicalOutboxId, '-RecordSha256', document['sha256'], '-JournalId', 'journal', '-EventId', 'event']);
      const settlement = await bothPaths('Settlement', settled);
      assert.ok(isObject(settlement['data']) && settlement['data']['outcome'] === 'settled');
    } finally {
      replies.close();
      child.stdin.end();
      await backend.supervisor.stop('startupCoreReply', 2000);
      const exit = await child.terminated;
      assert.equal(exit.code, 0);
      await backend.supervisor.verifyQuiescent('startupCoreReply');
    }
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
