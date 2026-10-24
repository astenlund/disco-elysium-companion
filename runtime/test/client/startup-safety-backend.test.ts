import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openBackend } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import { startChatProvider } from '../../src/runtime.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { companionFixture } from '../support/companion.ts';
import { testHelperImage } from '../support/native-helper.ts';
import { FakeProvider, instructionHash, until } from './support.ts';

// A private real coordinator decides the retryable branch: unreadable safety authority refuses the provider start, and /new
// recovers once that authority reads valid again, without a restart.
test('real coordinator safety unavailability at provider start is recovered by /new once readable', { timeout: 600000 }, async () => {
  // Arrange
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  let host: SessionHost | null = null;
  try {
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root, onStatus: () => host?.statusChanged(),
      onInvalidated: reason => host?.invalidate(reason) });
    const opened = backend;
    const startup = await opened.startup({ kind: 'chat' });
    assert.equal(startup.notOwner, false);
    const safetyPath = path.join(opened.scope.dataRoot, 'state-safety.json');
    const safetyBytes = await fs.readFile(safetyPath);
    await fs.writeFile(safetyPath, '{');
    const provider = new FakeProvider();
    host = new SessionHost({ backend: opened, provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
      providerTerminated: async () => opened.supervisor.verifyQuiescent('provider'), verifyTools: async () => opened.supervisor.verifyQuiescent('provider'),
      closeTools: async () => {} });
    const events: HostEvent[] = [];

    // Act
    const started = await startChatProvider(host, opened);
    const attached = await host.attachVerified(event => { events.push(event); });
    await until(() => events.some(event => event.type === 'notice' && event.code === 'providerSafetyRefused'));
    const whileUnreadable = await host.startNewAgentSession();
    await fs.writeFile(safetyPath, safetyBytes);
    const afterRestore = await host.startNewAgentSession();

    // Assert
    assert.equal(started.result, 'ready');
    assert.equal(attached.result, 'attached');
    assert.deepEqual(events.flatMap(event => event.type === 'notice' && event.code === 'providerSafetyRefused' ? [event.reason] : []), ['retryable']);
    assert.equal(whileUnreadable, 'providerUnavailable');
    assert.equal(afterRestore, 'started');
    assert.equal(provider.calls.length, 1);
  } finally {
    if (host !== null) { await host.shutdown(); backend = null; }
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
