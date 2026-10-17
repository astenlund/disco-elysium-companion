import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { observeBootstrapWorkerSources, observeStartupWorkerSources, startupWorkerInstallationRoot } from '../src/startup-worker-sources.ts';

const scope = { companionRoot: 'C:/private-companion', dataRoot: 'C:/private-companion/data', bindingSha256: 'a'.repeat(64) } as RuntimeScope;
const present = { status: 'present', scopeSha256: scope.bindingSha256, metadataSha256: 'b'.repeat(64),
  coreReplySha256: 'c'.repeat(64), mutationSha256: 'd'.repeat(64) };

test('accepts one complete scoped source observation and an explicit absent temporary root', async () => {
  let calls = 0;
  const inspector = { async metadata(script: string, args: readonly string[], cwd: string) {
    calls++;
    assert.equal(path.basename(script), 'Get-StartupWorkerSource.ps1');
    assert.deepEqual(args, ['-CompanionRoot', scope.companionRoot, '-DataRoot', scope.dataRoot, '-SourceRoot', startupWorkerInstallationRoot]);
    assert.equal(cwd, scope.companionRoot);
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(calls === 1 ? present : { status: 'absent' })), stderr: Buffer.alloc(0) };
  } } as Pick<PathInspector, 'metadata'>;
  assert.deepEqual(await observeStartupWorkerSources(inspector, scope), {
    scopeSha256: present.scopeSha256, metadataSha256: present.metadataSha256,
    coreReplySha256: present.coreReplySha256, mutationSha256: present.mutationSha256,
  });
  assert.equal(await observeStartupWorkerSources(inspector, scope), null);
});

test('rejects partial, foreign and failed source observations without a worker digest', async () => {
  for (const fixture of [
    { exitCode: 0, stdout: JSON.stringify({ ...present, mutationSha256: undefined }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ ...present, scopeSha256: '0'.repeat(64) }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ ...present, coreReplySha256: '0'.repeat(63) }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ status: 'absent', metadataSha256: present.metadataSha256 }), stderr: '' },
    { exitCode: 1, stdout: JSON.stringify(present), stderr: 'source-evidence-unavailable' },
    { exitCode: 0, stdout: JSON.stringify(present), stderr: 'unexpected' },
    { exitCode: 0, stdout: '{', stderr: '' },
  ]) {
    const inspector = { async metadata() { return { exitCode: fixture.exitCode, stdout: Buffer.from(fixture.stdout), stderr: Buffer.from(fixture.stderr) }; } } as Pick<PathInspector, 'metadata'>;
    await assert.rejects(observeStartupWorkerSources(inspector, scope));
  }
});

test('combined bootstrap source proof returns only exact bound scope bytes', async () => {
  const bytes = Buffer.from('{"runtimeScopeVersion":1,"game":"game","principal":"principal"}');
  const candidate = { ...scope, bindingSha256: createHash('sha256').update(bytes).digest('hex') };
  const response = { ...present, scopeSha256: candidate.bindingSha256, scopeBytesBase64: bytes.toString('base64') };
  const inspector = { async metadata(script: string, args: readonly string[], cwd: string) {
    assert.equal(path.basename(script), 'Get-StartupWorkerSource.ps1');
    assert.deepEqual(args, ['-CompanionRoot', scope.companionRoot, '-DataRoot', scope.dataRoot,
      '-SourceRoot', startupWorkerInstallationRoot, '-IncludeScopeBytes']);
    assert.equal(cwd, scope.companionRoot);
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.alloc(0) };
  } } as Pick<PathInspector, 'metadata'>;
  const observed = await observeBootstrapWorkerSources(inspector, candidate);
  assert.equal(observed.status, 'present');
  if (observed.status === 'present') {
    assert.deepEqual(observed.scopeBytes, bytes);
    assert.equal(observed.evidence.scopeSha256, candidate.bindingSha256);
  }
  for (const invalid of [{ ...response, scopeSha256: '0'.repeat(64) }, { ...response, scopeBytesBase64: '!' },
    { ...response, extra: true }]) {
    const bad = { metadata: async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(invalid)), stderr: Buffer.alloc(0) }) } as Pick<PathInspector, 'metadata'>;
    await assert.rejects(observeBootstrapWorkerSources(bad, candidate));
  }
  const missing = { metadata: async () => ({ exitCode: 1, stdout: Buffer.alloc(0),
    stderr: Buffer.from('Get-StartupWorkerSource: source-evidence-unavailable') }) } as Pick<PathInspector, 'metadata'>;
  await assert.rejects(observeBootstrapWorkerSources(missing, candidate));
  const absentScope = { metadata: async () => ({ exitCode: 0, stdout: Buffer.from('{"status":"scopeAbsent"}'),
    stderr: Buffer.alloc(0) }) } as Pick<PathInspector, 'metadata'>;
  assert.deepEqual(await observeBootstrapWorkerSources(absentScope, candidate), { status: 'scopeAbsent' });
  const extra = { metadata: async () => ({ exitCode: 0, stdout: Buffer.from('{"status":"scopeAbsent","sourceSha256":"a"}'),
    stderr: Buffer.alloc(0) }) } as Pick<PathInspector, 'metadata'>;
  await assert.rejects(observeBootstrapWorkerSources(extra, candidate));
});
