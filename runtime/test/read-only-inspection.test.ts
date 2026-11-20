import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError } from '../src/admission.ts';
import type { NativeHelper } from '../src/native-helper.ts';
import { SupervisorError } from '../src/process.ts';
import { createReadOnlyInspection, type ReadOnlyInspection } from '../src/read-only-inspection.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative, startTestHelper } from './support/native-helper.ts';
import { releaseAll } from './support/release.ts';

const childScript = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));

describe('independent read-only metadata ownership', () => {
  it('allows concurrent readers without creating state or reusing a closed helper owner', { timeout: 30000 }, async () => {
    const fixture = await companionFixture();
    let helper: NativeHelper | null = null;
    let first: ReadOnlyInspection | null = null;
    let second: ReadOnlyInspection | null = null;
    try {
      helper = await startTestHelper();
      first = await createReadOnlyInspection(fixture.root, helper);
      second = await createReadOnlyInspection(fixture.root, helper);
      assert.equal(first.parentIdentity.pid, process.pid);
      assert.match(first.parentIdentity.created, /^[1-9][0-9]{0,18}$/);
      assert.deepEqual(second.parentIdentity, first.parentIdentity);
      const [left, right] = await Promise.all([first.inspector.inspect(fixture.root, fixture.root), second.inspector.inspect(fixture.root, fixture.root)]);
      assert.equal(left.kind, 'directory');
      assert.equal(left.identity, right.identity);
      assert.deepEqual(await fs.readdir(fixture.root), []);
      await first.close();
      await assert.rejects(first.inspector.inspect(fixture.root, fixture.root), DataRootUnavailableError);
      await assert.rejects(first.inspector.native('principal', {}), DataRootUnavailableError);
      assert.equal((await second.inspector.inspect(fixture.root, fixture.root)).kind, 'directory');
    } finally { await releaseAll(() => first?.close(), () => second?.close(), () => helper?.close(), () => fixture.close()); }
  });

  it('retains verified process ownership in a distinct guarded namespace after bootstrap closes', { timeout: 30000 }, async () => {
    const fixture = await companionFixture();
    let helper: NativeHelper | null = null;
    let bootstrap: ReadOnlyInspection | null = null;
    try {
      helper = await startTestHelper();
      bootstrap = await createReadOnlyInspection(fixture.root, helper);
      const scope = path.join(fixture.root, 'runtime-data');
      const guarded = bootstrap.supervisorFor(scope);
      const competitor = (await createTestNative(scope)).supervisor;
      await bootstrap.close();
      const child = guarded.spawn('watcher', { command: process.execPath, args: [childScript, 'wait'], cwd: fixture.root });
      child.stdout.resume(); child.stderr.resume(); child.stdin.end();
      try {
        await child.ready;
        await assert.rejects(competitor.verifyQuiescent('watcher'), SupervisorError);
      } finally { await guarded.stop('watcher'); }
      await competitor.verifyQuiescent('watcher');
      assert.deepEqual(await fs.readdir(fixture.root), []);
    } finally { await releaseAll(() => bootstrap?.close(), () => helper?.close(), () => fixture.close()); }
  });
});
