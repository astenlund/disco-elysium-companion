import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { asInteger, isLowerHex, isObject, parseStrictJson } from '../src/json.ts';
import { encodeStartupMetadataFrame, FramedReplies } from '../src/startup-metadata.ts';
import { companionFixture } from './support/companion.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerScript = fileURLToPath(new URL('../scripts/StartupMutationWorker.ps1', import.meta.url));
const writerScript = fileURLToPath(new URL('../scripts/Write-RuntimeFile.ps1', import.meta.url));
const codecScript = fileURLToPath(new URL('../scripts/Invoke-PayloadCodec.ps1', import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('startup mutation worker matches native publication and codec on a private root', { timeout: 240000 }, async () => {
  const fixture = await companionFixture('runtime-owned');
  let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
  const created: string[] = [];
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root });
    const root = backend.scope.dataRoot;
    const nonce = randomBytes(16).toString('hex');
    const child = backend.supervisor.spawn('startupMutation', { command: 'pwsh',
      args: ['-NoProfile', '-File', workerScript, '-CompanionRoot', fixture.root, '-DataRoot', root,
        '-SourceRoot', repository, '-Nonce', nonce], cwd: fixture.root,
      env: { ...process.env, TEMP: path.join(fixture.root, '.tmp'), TMP: path.join(fixture.root, '.tmp') } });
    const replies = new FramedReplies(child);
    const request = async (fields: Record<string, unknown>) => {
      const id = randomBytes(16).toString('hex');
      child.stdin.write(encodeStartupMetadataFrame({ version: 1, id, root, remainingMs: 30000, ...fields }));
      const response = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(response));
      assert.equal(response['id'], id);
      assert.equal(asInteger(response['version']), 1);
      assert.equal(response['op'], fields['op']);
      return response;
    };
    const stage = async (target: string, bytes: Uint8Array) => {
      const input = `${target}.${randomBytes(16).toString('hex')}.tmp`;
      await fs.writeFile(input, bytes, { flag: 'wx' });
      created.push(input);
      return { input, hash: sha256(bytes) };
    };
    try {
      await child.ready;
      const hello = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(hello));
      assert.deepEqual(Object.keys(hello).sort(), ['nonce', 'scopeSha256', 'sourceSha256', 'version']);
      assert.equal(hello['nonce'], nonce);
      assert.equal(hello['scopeSha256'], backend.scope.bindingSha256);
      assert.ok(isLowerHex(hello['sourceSha256'], 64));

      const bytes = Buffer.from(JSON.stringify({ privateWorkerProbe: true }));
      const target = path.join(root, 'worker-publish.json');
      const source = await stage(target, bytes);
      created.push(target);
      const publish = { op: 'publish', target, inputFile: source.input, inputSha256: source.hash, profile: 'config', createOnly: true };
      const first = await request(publish);
      assert.equal(first['status'], 'ok');
      assert.deepEqual(await fs.readFile(target), bytes);
      const collision = await request(publish);
      assert.equal(collision['status'], 'error');
      assert.equal(collision['code'], 'publicationFailed');

      const oneShotTarget = path.join(root, 'worker-one-shot.json');
      const oneShotSource = await stage(oneShotTarget, bytes);
      created.push(oneShotTarget);
      const oneShot = await backend.supervisor.run('publication', { command: 'pwsh', args: ['-NoProfile', '-File', writerScript,
        '-Root', root, '-Target', oneShotTarget, '-InputFile', oneShotSource.input, '-Sha256', oneShotSource.hash,
        '-Profile', 'config', '-CreateOnly'], cwd: root }, 30000);
      assert.equal(oneShot.exitCode, 0);
      assert.deepEqual(first['result'], parseStrictJson(oneShot.stdout));

      const records = (await fs.readdir(path.join(fixture.root, 'state', 'outbox'))).filter(name => /^event-[0-9]{16}\.json$/.test(name));
      assert.equal(records.length, 1);
      const event = await fs.readFile(path.join(fixture.root, 'state', 'outbox', records[0]!));
      const control = Buffer.from(JSON.stringify({ mode: 'source', metadata: null, compact: false,
        expectedSequence: 1, createOnly: false, binding: null }));
      const codecTarget = path.join(root, 'worker-codec.json');
      const codecInput = await stage(codecTarget, event);
      const codecControl = await stage(codecTarget, control);
      const codec = { op: 'codec', target: codecTarget, inputFile: codecInput.input, inputSha256: codecInput.hash,
        controlFile: codecControl.input, controlSha256: codecControl.hash, verifyOnly: false, preview: false };
      const warmCodec = await request(codec);
      assert.equal(warmCodec['status'], 'ok');
      const nativeCodec = await backend.supervisor.run('publication', { command: 'pwsh', args: ['-NoProfile', '-File', codecScript,
        '-Root', root, '-Target', codecTarget, '-InputFile', codecInput.input, '-InputSha256', codecInput.hash,
        '-ControlFile', codecControl.input, '-ControlSha256', codecControl.hash], cwd: root }, 30000);
      assert.equal(nativeCodec.exitCode, 0);
      assert.deepEqual(warmCodec['result'], parseStrictJson(nativeCodec.stdout));
    } finally {
      replies.close();
      child.stdin.end();
      await backend.supervisor.stop('startupMutation', 2000);
      const exit = await child.terminated;
      assert.equal(exit.code, 0);
      await backend.supervisor.verifyQuiescent('startupMutation');
    }
  } finally {
    for (const file of created.reverse()) { await fs.rm(file, { force: true }); }
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
