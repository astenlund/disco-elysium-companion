import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { companionFixture } from '../support/companion.ts';
import { createTestNative, testHelperImage } from '../support/native-helper.ts';
import { startOrphanWatcher } from '../support/orphan-watcher.ts';
import { openSyntheticChat, type SyntheticChat } from '../support/synthetic-chat.ts';

const openChild = fileURLToPath(new URL('../backend/fixtures/open-backend-child.ts', import.meta.url));

async function openInChild(companionRoot: string): Promise<unknown> {
  const child = spawn(process.execPath, [openChild, companionRoot], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  await new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });

  return JSON.parse(output);
}

describe('operator recovery from a content-invalid runtime marker', () => {
  it('refuses without writing, still refuses a live watcher job once moved aside, then starts as an unclean shutdown', { timeout: 600000 }, async () => {
    // Arrange: a first start shuts down cleanly, so an unclean reading afterward can only come from the marker's absence.
    const fixture = await companionFixture('runtime-owned');
    const image = await testHelperImage();
    let orphan: Awaited<ReturnType<typeof startOrphanWatcher>> | null = null;
    let second: SyntheticChat | null = null;
    try {
      const first = await openSyntheticChat(fixture.root, image);
      const jobName = first.backend.supervisor.jobName('watcher');
      const marker = path.join(first.backend.scope.dataRoot, 'runtime.json');
      await first.host.shutdown();
      const invalid = '{"runtimeInstanceId":"not a marker"}';
      await fs.writeFile(marker, invalid);

      // Act and assert: the content-invalid marker refuses the start and survives it.
      assert.deepEqual(await openInChild(fixture.root), { opened: false, code: 'dataRootUnavailable' });
      assert.equal(await fs.readFile(marker, 'utf8'), invalid);

      // Act and assert: the operator moves it out of the scope; a live watcher job, which no marker now names, still refuses.
      const evidence = path.join(fixture.root, 'runtime.json.invalid');
      await fs.rename(marker, evidence);
      const probe = await createTestNative(fixture.root);
      try { orphan = await startOrphanWatcher(fixture.root, jobName, probe.helper); }
      finally { await probe.close(); }
      assert.deepEqual(await openInChild(fixture.root), { opened: false, code: 'dataRootUnavailable' });
      await assert.rejects(fs.access(marker));

      // Act: the operator resolves the job and starts again.
      orphan.kill();
      await orphan.closed;
      orphan = null;
      second = await openSyntheticChat(fixture.root, image);

      // Assert: the start publishes a fresh marker, reads the prior shutdown as unclean and leaves the evidence alone.
      assert.equal(second.backend.status.previousShutdownClean, false);
      assert.equal((JSON.parse(await fs.readFile(marker, 'utf8')) as { readonly cleanShutdown: boolean }).cleanShutdown, false);
      assert.equal(await fs.readFile(evidence, 'utf8'), invalid);
    } finally {
      orphan?.kill();
      await orphan?.closed;
      await second?.host.shutdown();
      await fixture.close();
    }
  });
});
