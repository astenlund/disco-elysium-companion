import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { asInteger, isLowerHex, isObject, parseStrictJson } from '../src/json.ts';
import type { ProcessRole } from '../src/process.ts';
import { FramedReplies } from '../src/startup-metadata.ts';
import { companionFixture } from './support/companion.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceScript = fileURLToPath(new URL('../scripts/Get-StartupWorkerSource.ps1', import.meta.url));
const priorSourceScript = fileURLToPath(new URL('../scripts/Get-StartupMetadataSource.ps1', import.meta.url));
const coreWorker = fileURLToPath(new URL('../scripts/StartupCoreReplyWorker.ps1', import.meta.url));
const mutationWorker = fileURLToPath(new URL('../scripts/StartupMutationWorker.ps1', import.meta.url));

test('one source observation matches each private startup worker bundle', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root });
    const args = ['-CompanionRoot', fixture.root, '-DataRoot', backend.scope.dataRoot, '-SourceRoot', repository];
    const observed = await backend.inspector.metadata(sourceScript, args, fixture.root);
    assert.equal(observed.exitCode, 0);
    assert.equal(observed.stderr.length, 0);
    const evidence = parseStrictJson(observed.stdout);
    assert.ok(isObject(evidence));
    assert.deepEqual(Object.keys(evidence).sort(), ['coreReplySha256', 'metadataSha256', 'mutationSha256', 'scopeSha256', 'status']);
    assert.equal(evidence['status'], 'present');
    assert.equal(evidence['scopeSha256'], backend.scope.bindingSha256);
    for (const key of ['metadataSha256', 'coreReplySha256', 'mutationSha256']) { assert.ok(isLowerHex(evidence[key], 64)); }
    const prior = await backend.inspector.metadata(priorSourceScript, args, fixture.root);
    assert.equal(prior.exitCode, 0);
    const priorEvidence = parseStrictJson(prior.stdout);
    assert.ok(isObject(priorEvidence));
    assert.equal(evidence['metadataSha256'], priorEvidence['sourceSha256']);

    const observeWorker = async (role: ProcessRole, script: string): Promise<ReturnType<typeof parseStrictJson>> => {
      const nonce = randomBytes(16).toString('hex');
      const child = backend!.supervisor.spawn(role, { command: 'pwsh', args: ['-NoProfile', '-File', script,
        '-CompanionRoot', fixture.root, '-DataRoot', backend!.scope.dataRoot, '-SourceRoot', repository, '-Nonce', nonce],
      cwd: fixture.root, env: { ...process.env, TEMP: path.join(fixture.root, '.tmp'), TMP: path.join(fixture.root, '.tmp') } });
      const replies = new FramedReplies(child);
      try {
        await child.ready;
        const hello = parseStrictJson(await replies.next(30000));
        assert.ok(isObject(hello));
        assert.equal(asInteger(hello['version']), 1);
        assert.equal(hello['nonce'], nonce);
        assert.equal(hello['scopeSha256'], backend!.scope.bindingSha256);
        return hello;
      } finally {
        replies.close();
        child.stdin.end();
        await backend!.supervisor.stop(role, 2000);
        const exit = await child.terminated;
        assert.equal(exit.code, 0);
        await backend!.supervisor.verifyQuiescent(role);
      }
    };
    const core = await observeWorker('startupCoreReply', coreWorker);
    const mutation = await observeWorker('startupMutation', mutationWorker);
    assert.ok(isObject(core) && isObject(mutation));
    assert.equal(core['sourceSha256'], evidence['coreReplySha256']);
    assert.equal(mutation['sourceSha256'], evidence['mutationSha256']);

    const stagedSource = path.join(fixture.root, 'source-copy');
    await fs.mkdir(path.join(stagedSource, 'runtime'), { recursive: true });
    await fs.cp(path.join(repository, 'runtime', 'scripts'), path.join(stagedSource, 'runtime', 'scripts'), { recursive: true });
    const stagedArgs = ['-CompanionRoot', fixture.root, '-DataRoot', backend.scope.dataRoot, '-SourceRoot', stagedSource];
    const complete = await backend.inspector.metadata(sourceScript, stagedArgs, fixture.root);
    assert.equal(complete.exitCode, 0);
    await fs.rm(path.join(stagedSource, 'runtime', 'scripts', 'StartupMutationWorker.ps1'));
    const missing = await backend.inspector.metadata(sourceScript, stagedArgs, fixture.root);
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.stdout.length, 0);
    assert.equal(missing.stderr.toString('utf8').trim(), 'Get-StartupWorkerSource: source-evidence-unavailable');
  } finally {
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
