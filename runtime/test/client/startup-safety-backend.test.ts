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

// A private real coordinator decides the restart branch: a content-invalid safety record refuses the provider start, no /new in
// that process can recover it, and the next chat start reconciles the record.
test('real coordinator content-invalid safety at provider start requires a restart, which reconciles it', { timeout: 600000 }, async () => {
  // Arrange
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  let host: SessionHost | null = null;
  try {
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root, onStatus: () => host?.statusChanged(),
      onInvalidated: reason => host?.invalidate(reason) });
    const opened = backend;
    assert.equal((await opened.startup({ kind: 'chat' })).notOwner, false);
    await fs.writeFile(path.join(opened.scope.dataRoot, 'state-safety.json'), '{');
    const provider = new FakeProvider();
    host = new SessionHost({ backend: opened, provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
      providerTerminated: async () => opened.supervisor.verifyQuiescent('provider'), verifyTools: async () => opened.supervisor.verifyQuiescent('provider'),
      closeTools: async () => {} });
    const events: HostEvent[] = [];

    // Act
    const started = await startChatProvider(host, opened);
    const attached = await host.attachVerified(event => { events.push(event); });
    await until(() => events.some(event => event.type === 'notice' && event.code === 'providerSafetyRefused'));
    const retried = await host.startNewAgentSession();
    await host.shutdown(); host = null; backend = null;
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
    const restarted = await backend.startup({ kind: 'chat' });
    const reconciled = await backend.safety();

    // Assert
    assert.equal(started.result, 'ready');
    assert.equal(attached.result, 'attached');
    assert.deepEqual(events.flatMap(event => event.type === 'notice' && event.code === 'providerSafetyRefused' ? [event.reason] : []), ['restartRequired']);
    assert.equal(retried, 'providerUnavailable');
    assert.equal(provider.calls.length, 0);
    assert.equal(restarted.notOwner, false);
    assert.equal(reconciled.stateSafetyVersion, 1);
  } finally {
    if (host !== null) { await host.shutdown(); backend = null; }
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
