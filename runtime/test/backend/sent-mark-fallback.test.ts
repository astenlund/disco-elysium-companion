import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PathInspector } from '../../src/admission.ts';
import { takeInstanceGuard } from '../../src/guard.ts';
import { newIdentity } from '../../src/identity.ts';
import { companionFixture } from '../support/companion.ts';
import { createTestNative } from '../support/native-helper.ts';

it('sends the precomputed redelivery bytes after a blocked sent publication and exits uncleanly', { timeout: 3600000 }, async () => {
  const fixture = await companionFixture('runtime-owned');
  const script = fileURLToPath(new URL('./fixtures/sent-mark-child.ts', import.meta.url));
  const supervisor = (await createTestNative(path.join(fixture.root, `test-process-${newIdentity()}`))).supervisor;
  let quiescent = false;
  try {
    const result = await supervisor.run('core', { command: process.execPath, args: [script, fixture.root], cwd: fixture.root }, 3500000);
    quiescent = true;
    assert.equal(result.exitCode, 0, result.stderr.toString('utf8'));
    const proof = JSON.parse(result.stdout.toString('utf8')) as { proof: string; dataRoot: string; events: number; failedPublicationCode: string; additionalPublications: number; retainedInput: string; cleanShutdown: boolean };
    assert.equal(proof.proof, 'sent-mark-fallback');
    assert.ok(proof.events > 0);
    assert.equal(proof.failedPublicationCode, 'publicationFailed');
    assert.equal(proof.additionalPublications, 0);
    assert.match(proof.retainedInput, /^cursor-agent-session[.]json[.][a-f0-9]{32}[.]tmp$/);
    assert.equal(proof.cleanShutdown, false);
    const inspector = new PathInspector(supervisor);
    const admitted = await inspector.inspect(fixture.root, proof.dataRoot);
    assert.equal(admitted.kind, 'directory');
    const record = JSON.parse(await fs.readFile(path.join(admitted.path, 'runtime.json'), 'utf8'));
    assert.equal(record.cleanShutdown, false);
    // The child ended without production shutdown. Its OS-held guard must now be
    // available; the parent never reset the failed publication authority.
    const guard = await takeInstanceGuard(admitted.path, error => { throw error; });
    await guard.release();
    await inspector.idle();
    await supervisor.verifyQuiescent('metadata');
  } finally {
    if (!quiescent) { await supervisor.verifyQuiescent('core'); quiescent = true; }
    if (quiescent) { await fixture.close(); }
  }
});
