import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { describe, it } from 'node:test';

import { takeInstanceGuard } from '../../src/guard.ts';
import { ProviderUnavailableError } from '../../src/provider-support.ts';
import { createChatRuntime } from '../../src/runtime.ts';
import { companionFixture } from '../support/companion.ts';
import { testHelperImage } from '../support/native-helper.ts';

describe('failed chat start cleanup on the native helper', () => {
  it('surfaces a provider refusal after file tools exist and releases the file-tool namespace', { timeout: 300000 }, async () => {
    // Arrange: a runtime-owned root and an inherited profile redirection the real provider refuses after file tools exist.
    const fixture = await companionFixture('runtime-owned');
    const image = await testHelperImage();
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = fixture.root;
    try {
      // Act
      const start = createChatRuntime(fixture.root, undefined, {}, image);

      // Assert: the original refusal surfaces, not a cleanup failure through the closed helper, and the namespace is free.
      await assert.rejects(start, error => error instanceof ProviderUnavailableError);
      const namespace = await takeInstanceGuard(realpathSync.native(fixture.root), () => {}, 'file-tools');
      assert.equal(namespace.held, true);
      await namespace.release();
    } finally {
      if (previous === undefined) { delete process.env['CLAUDE_CONFIG_DIR']; } else { process.env['CLAUDE_CONFIG_DIR'] = previous; }
      await fixture.close();
    }
  });
});
