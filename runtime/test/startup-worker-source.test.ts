import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../src/backend/index.ts';
import { guardScopeToken } from '../src/guard.ts';
import { asInteger, isLowerHex, isObject, parseStrictJson } from '../src/json.ts';
import type { ProcessRole } from '../src/process.ts';
import { encodeStartupMetadataFrame, FramedReplies, parseStartupMetadataReply, StartupMetadataSession } from '../src/startup-metadata.ts';
import { scopeFromAdmittedBinding } from '../src/scope.ts';
import { observeBootstrapWorkerSources } from '../src/startup-worker-sources.ts';
import { companionFixture } from './support/companion.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceScript = fileURLToPath(new URL('../scripts/Get-StartupWorkerSource.ps1', import.meta.url));
const priorSourceScript = fileURLToPath(new URL('../scripts/Get-StartupMetadataSource.ps1', import.meta.url));
const metadataWorker = fileURLToPath(new URL('../scripts/StartupMetadataWorker.ps1', import.meta.url));
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
    const combined = await observeBootstrapWorkerSources(backend.inspector, backend.scope);
    assert.equal(combined.status, 'present');
    if (combined.status === 'present') {
      assert.ok(combined.scopeBytes);
      assert.equal(scopeFromAdmittedBinding(backend.scope, combined.scopeBytes).bindingSha256, backend.scope.bindingSha256);
      assert.deepEqual(combined.evidence, { scopeSha256: evidence['scopeSha256'], metadataSha256: evidence['metadataSha256'],
        coreReplySha256: evidence['coreReplySha256'], mutationSha256: evidence['mutationSha256'] });
    }
    const metadataSession = await StartupMetadataSession.open(backend.inspector, backend.supervisor, backend.scope);
    assert.ok(metadataSession);
    try {
      assert.deepEqual(await metadataSession.observeWorkerSources(backend.scope), {
        scopeSha256: evidence['scopeSha256'], metadataSha256: evidence['metadataSha256'],
        coreReplySha256: evidence['coreReplySha256'], mutationSha256: evidence['mutationSha256'],
      });
    } finally { await metadataSession.close(); }
    await backend.supervisor.verifyQuiescent('startupMetadata');

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
    const absentScope = await backend.inspector.metadata(sourceScript, ['-CompanionRoot', fixture.root,
      '-DataRoot', path.join(fixture.root, 'runtime-data', 'private-missing'), '-SourceRoot', stagedSource, '-IncludeScopeBytes'], fixture.root);
    assert.equal(absentScope.exitCode, 0);
    assert.deepEqual(JSON.parse(absentScope.stdout.toString('utf8')), { status: 'scopeAbsent' });
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

test('the metadata worker proves jobs under the scope token Node supplies, not one it derives', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: Awaited<ReturnType<typeof openBackend>> | null = null;
  try {
    await fs.mkdir(path.join(fixture.root, '.tmp'), { recursive: true });
    backend = await openBackend({ companionRoot: fixture.root });
    const suppliedToken = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const child = backend.supervisor.spawn('startupMetadata', { command: 'pwsh', args: ['-NoProfile', '-File', metadataWorker,
      '-CompanionRoot', fixture.root, '-DataRoot', backend.scope.dataRoot, '-SourceRoot', repository, '-JobScopeToken', suppliedToken, '-Nonce', nonce],
    cwd: fixture.root, env: { ...process.env, TEMP: path.join(fixture.root, '.tmp'), TMP: path.join(fixture.root, '.tmp') } });
    const replies = new FramedReplies(child);
    try {
      await child.ready;
      const hello = parseStrictJson(await replies.next(30000));
      assert.ok(isObject(hello));
      assert.equal(hello['nonce'], nonce);
      const observe = async (token: string) => {
        const id = randomBytes(16).toString('hex');
        const name = ['Global', `game-companion-process-${token}-core`].join(path.win32.sep);
        child.stdin.write(encodeStartupMetadataFrame({ version: 1, id, op: 'jobBatch', root: backend!.scope.dataRoot, remainingMs: 5000,
          scopeSha256: backend!.scope.bindingSha256, names: [name] }));
        return parseStartupMetadataReply(await replies.next(30000), id, 'jobBatch');
      };
      const supplied = await observe(suppliedToken);
      assert.equal(supplied.exitCode, 0);
      assert.deepEqual(JSON.parse(supplied.stdout.toString('utf8')), { jobs: [{ name: ['Global', `game-companion-process-${suppliedToken}-core`].join(path.win32.sep),
        state: 'absent', processes: null }] });
      assert.equal((await observe(guardScopeToken(backend.scope.dataRoot))).exitCode, 1);
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
