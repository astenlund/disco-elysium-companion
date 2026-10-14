import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { observeStartupWorkerSources, startupWorkerInstallationRoot } from '../src/startup-worker-sources.ts';

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
