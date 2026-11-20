import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { openBackend } from '../../src/backend/index.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { settlePreHostInvalidation } from '../../src/runtime.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import type { StartupPhase } from '../../src/startup-progress.ts';
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
      // The restart must coexist with the binding this first start leaves, so the first start has to have bound one fresh session.
      const firstProvider = first.host.status.provider.state;
      const firstCalls = [...first.provider.calls];
      await first.host.shutdown();
      assert.equal(firstProvider, 'ready');
      assert.deepEqual(firstCalls, [null]);
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
      const phases: StartupPhase[] = [];
      restarted = await openSyntheticChat(fixture.root, image, false, phase => { phases.push(phase); });
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
      assert.deepEqual(restarted.provider.calls, [null], 'The invalidated binding is never resumed.');
      assert.equal(phases.filter(phase => phase === 'providerStart').length, 1, phases.join(','));
      assert.equal(phases.includes('providerRetry'), false, phases.join(','));
      assert.equal(status.stateSafety.correction?.reason, 'contextUncertain');
      assert.equal(restarted.backend.invalidationsPublished(), true);
      assert.equal(attached.result, 'attached');
      assert.deepEqual(events.flatMap(event => event.type === 'notice' && event.code === 'stateContextInvalidated' ? [event.reason] : []), ['contextUncertain']);
    } finally {
      await restarted?.host.shutdown();
      await fixture.close();
    }
  });

  it('keeps the provider unstarted when the startup invalidation could not be written', { timeout: 600000 }, async () => {
    // Arrange: the same armed check, but the safety record cannot be replaced, so the restart's recovery signals its
    // invalidation without publishing it.
    const fixture = await companionFixture('runtime-owned');
    const image = await testHelperImage();
    let restarted: SyntheticChat | null = null;
    let safetyPath: string | null = null;
    try {
      const first = await openSyntheticChat(fixture.root, image);
      safetyPath = path.join(first.backend.scope.dataRoot, 'state-safety.json');
      await first.host.shutdown();
      const backend = await openBackend({ nativeImage: image, companionRoot: fixture.root });
      try {
        assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
        const k = (backend as unknown as { readonly kernel: Kernel }).kernel;
        await k.resources.withTransition('ordinary', async () => { await k.resources.reserve('ordinary'); await k.safetyStore.armCheck(); });
      } finally { await backend.shutdown(true); }
      await fs.chmod(safetyPath, 0o444);

      // Act
      restarted = await openSyntheticChat(fixture.root, image);
      const status = restarted.host.status;
      const lifecycle = (restarted.host as unknown as { readonly lifecycle: { readonly startSafetyRefusal: unknown } }).lifecycle;

      // Assert: the invalidation was signaled but never written, so the host latched it and never asked the provider
      // lifecycle to start, rather than leaving the decision to the provider safety check.
      assert.equal(restarted.backend.guardHeld(), true);
      assert.equal(restarted.backend.invalidationsPublished(), false);
      assert.notEqual(status.provider.state, 'ready');
      assert.equal(status.provider.safetyRefusal, 'restartRequired');
      assert.equal(lifecycle.startSafetyRefusal, null);
      assert.equal(restarted.provider.calls.length, 0);
    } finally {
      if (safetyPath !== null) { await fs.chmod(safetyPath, 0o644).catch(() => undefined); }
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
