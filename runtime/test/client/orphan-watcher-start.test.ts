import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readProcessIdentity } from '../../src/process.ts';
import { companionFixture } from '../support/companion.ts';
import { testHelperImage } from '../support/native-helper.ts';
import { plantOrphanWatcher, type OrphanWatcher } from '../support/orphan-watcher.ts';
import { openSyntheticChat, startAndStopSyntheticChat, type SyntheticChat } from '../support/synthetic-chat.ts';

describe('chat start over an orphaned watcher', () => {
  it('terminates a live watcher its prior marker records and reaches attachment', { timeout: 600000 }, async () => {
    // Arrange: a first start creates the scope and its marker and shuts down; then a live process tree is planted in that
    // scope's watcher job and the marker is rewritten as an unclean runtime that recorded it as its watcher.
    const fixture = await companionFixture('runtime-owned');
    const image = await testHelperImage();
    let orphan: OrphanWatcher | null = null;
    let second: SyntheticChat | null = null;
    try {
      const { watcherJob, marker } = await startAndStopSyntheticChat(fixture.root, image);
      orphan = await plantOrphanWatcher(fixture.root, watcherJob);
      await fs.rm(path.join(fixture.root, 'descendant.json'), { force: true });
      const previous = JSON.parse(await fs.readFile(marker, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(marker, JSON.stringify({ ...previous, cleanShutdown: false, watcher: orphan.identity }));

      // Act: all-role startup admission would refuse while the watcher job is live, so reaching ready proves the start
      // terminated it first.
      second = await openSyntheticChat(fixture.root, image);
      const attached = await second.host.attachVerified(() => {});

      // Assert
      await orphan.closed;
      assert.equal(await readProcessIdentity(second.backend.supervisor.nativeHelper, orphan.identity.pid), null);
      assert.equal(await second.backend.supervisor.observeJobAbsent('watcher'), true);
      assert.equal(attached.result, 'attached');
    } finally {
      orphan?.kill();
      await orphan?.closed;
      await second?.host.shutdown();
      await fixture.close();
    }
  });
});
