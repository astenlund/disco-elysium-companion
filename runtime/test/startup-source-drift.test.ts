import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { guardScopeToken } from '../src/guard.ts';
import { isObject, parseStrictJson } from '../src/json.ts';
import { encodeStartupMetadataFrame, FramedReplies } from '../src/startup-metadata.ts';
import { companionFixture } from './support/companion.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('metadata worker rejects the next request after its source changes', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root });
    const sourceRoot = path.join(fixture.root, 'source-copy');
    const scripts = path.join(sourceRoot, 'runtime', 'scripts');
    await fs.mkdir(path.dirname(scripts), { recursive: true });
    await fs.cp(path.join(repository, 'runtime', 'scripts'), scripts, { recursive: true });
    const nonce = randomBytes(16).toString('hex');
    const child = backend.supervisor.spawn('startupMetadata', { command: 'pwsh', args: ['-NoProfile', '-File', path.join(scripts, 'StartupMetadataWorker.ps1'),
      '-CompanionRoot', fixture.root, '-DataRoot', backend.scope.dataRoot, '-SourceRoot', sourceRoot, '-JobScopeToken', guardScopeToken(backend.scope.dataRoot),
      '-Nonce', nonce],
    cwd: fixture.root, env: { ...process.env, TEMP: path.join(fixture.root, '.tmp'), TMP: path.join(fixture.root, '.tmp') } });
    const replies = new FramedReplies(child);
    try {
      await child.ready;
      const hello = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(hello));
      assert.equal(hello['nonce'], nonce);

      const request = (id: string) => ({ version: 1, id, op: 'admit', root: fixture.root,
        remainingMs: 30000, targets: [fixture.root], allowMissing: false });
      child.stdin.write(encodeStartupMetadataFrame(request(randomBytes(16).toString('hex'))));
      const first = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(first));
      assert.equal(first['status'], 'ok');

      await fs.appendFile(path.join(scripts, 'StartupWorkerProtocol.ps1'), String.fromCharCode(10) + '# private source-drift fixture' + String.fromCharCode(10));
      child.stdin.write(encodeStartupMetadataFrame(request(randomBytes(16).toString('hex'))));
      await assert.rejects(replies.next(30000));
    } finally {
      replies.close();
      child.stdin.end();
      await backend.supervisor.stop('startupMetadata', 2000);
      await backend.supervisor.verifyQuiescent('startupMetadata');
    }
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
