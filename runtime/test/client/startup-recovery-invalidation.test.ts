import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openBackend } from '../../src/backend/index.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { settlePreHostInvalidation } from '../../src/runtime.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { companionFixture } from '../support/companion.ts';
import { testHelperImage } from '../support/native-helper.ts';
import { openSyntheticChat, type SyntheticChat } from '../support/synthetic-chat.ts';

describe('chat start after startup recovery invalidates context', () => {
  it('starts the provider in the same process with the published correction instead of requiring another restart', { timeout: 600000 }, async () => {
    // Arrange: a first start, then a settlement check armed by the production writer that never finished, as a turn the
    // 120-second interaction gate failed leaves it. The next start's recovery invalidates the context before the host exists.
    const fixture = await companionFixture('runtime-owned');
    const image = await testHelperImage();
    let restarted: SyntheticChat | null = null;
    try {
      const first = await openSyntheticChat(fixture.root, image);
      await first.host.shutdown();
      const backend = await openBackend({ nativeImage: image, companionRoot: fixture.root });
      let armedGeneration: string;
      try {
        assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
        // Production arms a check inside the ordinary transition its checked core call reserves.
        const k = (backend as unknown as { readonly kernel: Kernel }).kernel;
        await k.resources.withTransition('ordinary', async () => { await k.resources.reserve('ordinary'); await k.safetyStore.armCheck(); });
        const armed = await backend.safety();
        assert.notEqual(armed.pendingCheck, null);
        armedGeneration = armed.generation;
      } finally { await backend.shutdown(true); }

      // Act
      restarted = await openSyntheticChat(fixture.root, image);
      const status = restarted.host.status;
      const safety = await restarted.backend.safety();
      const events: HostEvent[] = [];
      const attached = await restarted.host.attachVerified(event => { events.push(event); });
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });

      // Assert: this start's recovery reconciled the armed check into a newly published invalidation, the provider still
      // started fresh beside it, and the startup notice disclosed it to the client.
      assert.equal(safety.pendingCheck, null);
      assert.notEqual(safety.generation, armedGeneration);
      assert.equal(safety.correction?.reason, 'contextUncertain');
      assert.equal(status.provider.state, 'ready');
      assert.equal(status.provider.safetyRefusal, null);
      assert.ok(restarted.provider.calls.length > 0 && restarted.provider.calls.every(resume => resume === null), 'The invalidated binding is never resumed.');
      assert.equal(status.stateSafety.correction?.reason, 'contextUncertain');
      assert.equal(restarted.backend.invalidationsPublished(), true);
      assert.equal(attached.result, 'attached');
      assert.deepEqual(events.flatMap(event => event.type === 'notice' && event.code === 'stateContextInvalidated' ? [event.reason] : []), ['contextUncertain']);
    } finally {
      await restarted?.host.shutdown();
      await fixture.close();
    }
  });

  for (const item of [
    { name: 'discloses without latching when the guard is held and every invalidation is published', guardHeld: true, published: true, expected: 'disclosed' },
    { name: 'latches when an invalidation is unpublished', guardHeld: true, published: false, expected: 'latched' },
    { name: 'latches when the guard is lost', guardHeld: false, published: true, expected: 'latched' },
  ] as const) {
    it(item.name, () => {
      // Arrange
      const calls: string[] = [];
      const host = { invalidate: (reason: string) => { calls.push(`latched:${reason}`); }, discloseStartupInvalidation: (reason: string) => { calls.push(`disclosed:${reason}`); } };
      const backend = { guardHeld: () => item.guardHeld, invalidationsPublished: () => item.published };

      // Act
      settlePreHostInvalidation(host, backend, 'contextUncertain');

      // Assert
      assert.deepEqual(calls, [`${item.expected}:contextUncertain`]);
    });
  }
});
