import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { asInteger, isLowerHex, isObject, parseStrictJson } from '../src/json.ts';
import { encodeStartupWorkerFrame, FramedReplies } from '../src/startup-worker-framing.ts';
import { companionFixture } from './support/companion.ts';
import { testHelperImage } from './support/native-helper.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerScript = fileURLToPath(new URL('../scripts/StartupCoreReplyWorker.ps1', import.meta.url));
const readerScript = fileURLToPath(new URL('../scripts/Read-CoreReply.ps1', import.meta.url));

test('startup core reply worker matches the one-shot validator and survives a rejected reply', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
    const nonce = randomBytes(16).toString('hex');
    const child = backend.supervisor.spawn('startupCoreReply', { command: 'pwsh',
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

      const core = await backend.supervisor.run('core', { command: 'pwsh',
        args: ['-NoProfile', '-File', path.join(fixture.root, 'core', 'Set-CompanionConsumer.ps1'),
          '-CompanionRoot', fixture.root, '-Owner', 'runtime'], cwd: fixture.root }, 30000);
      await backend.supervisor.verifyQuiescent('core');
      const stdout = core.stdout.toString('utf8');
      const stderr = core.stderr.toString('utf8');
      const input = Buffer.from(JSON.stringify({ exitCode: core.exitCode, stdout, stderr }));
      const oneShot = await backend.inspector.metadata(readerScript, ['-CompanionRoot', fixture.root, '-Operation', 'Consumer'], fixture.root, 30000, input);
      assert.equal(oneShot.exitCode, 0);
      // The one-shot validator ran under the metadata role inside the inspector's queue, whose task included its stop proof.
      await backend.supervisor.verifyQuiescent('metadata');
      const request = (id: string, stream: string) => ({ version: 1, id, op: 'validateCore', root: fixture.root,
        remainingMs: 30000, operation: 'Consumer', exitCode: core.exitCode, stdout: stream, stderr });
      const invalidId = randomBytes(16).toString('hex');
      child.stdin.write(encodeStartupWorkerFrame(request(invalidId, 'invalid receipt')));
      const invalid = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(invalid));
      assert.deepEqual(Object.keys(invalid).sort(), ['code', 'id', 'op', 'status', 'version']);
      assert.equal(asInteger(invalid['version']), 1);
      assert.equal(invalid['id'], invalidId);
      assert.equal(invalid['op'], 'validateCore');
      assert.equal(invalid['status'], 'error');
      assert.equal(invalid['code'], 'coreReplyInvalid');

      const validId = randomBytes(16).toString('hex');
      child.stdin.write(encodeStartupWorkerFrame(request(validId, stdout)));
      const valid = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(valid));
      assert.deepEqual(Object.keys(valid).sort(), ['id', 'op', 'result', 'status', 'version']);
      assert.equal(asInteger(valid['version']), 1);
      assert.equal(valid['id'], validId);
      assert.equal(valid['status'], 'ok');
      assert.deepEqual(valid['result'], parseStrictJson(oneShot.stdout));
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
