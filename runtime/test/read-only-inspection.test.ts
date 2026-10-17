import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError } from '../src/admission.ts';
import { ProcessSupervisor, SupervisorError } from '../src/process.ts';
import { createReadOnlyInspection } from '../src/read-only-inspection.ts';
import { companionFixture } from './support/companion.ts';

const childScript = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));

describe('independent read-only metadata ownership', () => {
  it('allows concurrent readers without creating state or reusing a closed helper owner', { timeout: 30000 }, async () => {
    const fixture = await companionFixture();
    const first = await createReadOnlyInspection(fixture.root);
    const second = await createReadOnlyInspection(fixture.root);
    try {
      const [left, right] = await Promise.all([first.inspector.inspect(fixture.root, fixture.root), second.inspector.inspect(fixture.root, fixture.root)]);
      assert.equal(left.kind, 'directory');
      assert.equal(left.identity, right.identity);
      assert.deepEqual(await fs.readdir(fixture.root), []);
      await first.close();
      await assert.rejects(first.inspector.inspect(fixture.root, fixture.root), DataRootUnavailableError);
      assert.equal((await second.inspector.inspect(fixture.root, fixture.root)).kind, 'directory');
    } finally { await first.close(); await second.close(); await fixture.close(); }
  });

  it('retains verified process ownership in a distinct guarded namespace after bootstrap closes', { timeout: 30000 }, async () => {
    const fixture = await companionFixture();
    const bootstrap = await createReadOnlyInspection(fixture.root);
    const scope = path.join(fixture.root, 'runtime-data');
    const guarded = bootstrap.supervisorFor(scope);
    const competitor = await ProcessSupervisor.create(scope);
    try {
      await bootstrap.close();
      const child = guarded.spawn('watcher', { command: process.execPath, args: [childScript, 'wait'], cwd: fixture.root });
      child.stdout.resume(); child.stderr.resume(); child.stdin.end();
      try {
        await child.ready;
        await assert.rejects(competitor.verifyQuiescent('watcher'), SupervisorError);
      } finally { await guarded.stop('watcher'); }
      await competitor.verifyQuiescent('watcher');
      assert.deepEqual(await fs.readdir(fixture.root), []);
    } finally { await bootstrap.close(); await fixture.close(); }
  });
});
