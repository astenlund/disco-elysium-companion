import assert from 'node:assert/strict';
import test from 'node:test';

import { privateCombinedBootstrap, privateScopeSourceBatch, privateSelectedImageBootstrap,
  privateStartupMetadataPlacement, privateWarmJobObserver } from '../../src/backend/index.ts';
import { PendingProviderStart, PendingProviderStopError, selectPendingProviderStart } from '../../src/provider-lifecycle.ts';
import { chatBackendOptions, cleanupFailedChatRuntime, finalizeAttachmentSafety, startChatProvider } from '../../src/runtime.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { Provider, ProviderSession } from '../../src/provider.ts';
import { capabilities, deferred, FakeBackend, FakeProvider, FakeSession, generation, instructionHash, timestamp, until } from './support.ts';

function binding(sessionId = 'saved-session') {
  return { agentSessionVersion: 1 as const, providerId: 'fake', providerSessionId: sessionId, createdAt: timestamp, turnsCompleted: 1,
    needsState: false, instructionsSha256: instructionHash, stateGeneration: generation };
}

test('copied-root backend selectors route only through the explicit private flag', () => {
  const ordinary = chatBackendOptions('C:/fixture', () => {}, () => {}, undefined, false);
  const privateFixture = chatBackendOptions('C:/fixture', () => {}, () => {}, undefined, true);
  assert.equal(ordinary.startupMetadata, true);
  assert.equal(Object.getOwnPropertySymbols(ordinary).length, 0);
  assert.equal(privateFixture[privateCombinedBootstrap], true);
  assert.equal(privateFixture[privateScopeSourceBatch], true);
  assert.equal(privateFixture[privateWarmJobObserver], true);
  assert.equal(privateFixture[privateStartupMetadataPlacement], 'postGuard');
  assert.equal(Object.getOwnPropertySymbols(privateFixture).length, 4);
});

test('selected image bootstrap is separate from ordinary and copied-root callers', () => {
  const selection = { token: Symbol('selection'), imageRoot: 'C:/private/install', scratch: 'C:/private/scratch', environment: {},
    markPossibleTransfer: () => {}, onVerifiedPins: (_status: 'ready' | 'absent') => {} };
  const ordinary = chatBackendOptions('C:/fixture', () => {}, () => {}, undefined, false);
  const copied = chatBackendOptions('C:/fixture', () => {}, () => {}, undefined, true);
  const selected = chatBackendOptions('C:/fixture', () => {}, () => {}, undefined, false,
    undefined, undefined, undefined, selection);
  assert.equal(ordinary[privateSelectedImageBootstrap], undefined);
  assert.equal(copied[privateSelectedImageBootstrap], undefined);
  assert.equal(selected[privateSelectedImageBootstrap], selection);
  assert.equal(selected[privateScopeSourceBatch], true);
  assert.equal(selected[privateStartupMetadataPlacement], 'postGuard');
});

test('guarded selector resumes an exact binding without marking it current', async () => {
  const backend = new FakeBackend();
  backend.binding = binding();
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  assert.deepEqual(provider.calls, ['saved-session']);
  const session = await pending.take('fake', 'saved-session', generation, instructionHash);
  assert.ok(session);
  assert.equal(session.providerSessionId, 'saved-session');
  await session.close();
});

test('a known binding mismatch selects one fresh unbound start', async () => {
  const backend = new FakeBackend();
  backend.binding = { ...binding(), instructionsSha256: 'f'.repeat(64) };
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  assert.deepEqual(provider.calls, [null]);
  const session = await pending.take('fake', null, generation, instructionHash);
  assert.ok(session);
  await session.close();
});

test('guarded selector refuses unresolved safety and invalid binding', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  backend.safetyValue = { ...backend.safetyValue, pendingCheck: 'e'.repeat(32) };
  assert.equal(await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash), null);
  backend.safetyValue = { ...backend.safetyValue, pendingCheck: null };
  backend.sessions.readBinding = async () => ({ status: 'invalid', sha256: null });
  assert.equal(await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash), null);
  assert.equal(provider.calls.length, 0);
});

test('guard loss before transfer cancels and stops the unbound candidate', async () => {
  const backend = new FakeBackend();
  let verified = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { verified += 1; } } });
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  backend.held = false;
  assert.equal(await pending.take('fake', null, generation, instructionHash), null);
  assert.equal(provider.current.closed, true);
  assert.ok(verified > 0);
});

test('final lifecycle never starts a second provider after guard loss', async () => {
  const backend = new FakeBackend();
  let verified = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { verified += 1; } } });
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  Object.assign(backend, { providerSafety: async () => { backend.held = false; return backend.safetyValue; } });
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, pendingStart: pending,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), false);
  assert.deepEqual(provider.calls, [null]);
  assert.equal(provider.current.closed, true);
  assert.ok(verified > 0);
});

test('a prestarted candidate that dies before binding is stopped, then the start falls back to a fresh session', async () => {
  const backend = new FakeBackend();
  let verified = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { verified += 1; } } });
  const provider = new FakeProvider();
  provider.configure = session => { if (provider.sessions.length === 0) { session.verifyLive = async () => { throw new Error('Session died.'); }; } };
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, pendingStart: pending,
    delay: async () => {}, providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  assert.deepEqual(provider.calls, [null, null]);
  assert.equal(provider.sessions[0]!.closed, true);
  assert.ok(verified > 0);
  assert.equal(host.status.provider.state, 'ready');
  await host.shutdown();
});

test('a failed candidate stop is reported again without a second stop attempt', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  let closes = 0;
  provider.configure = session => { session.close = async () => { closes += 1; throw new Error('Close failed.'); }; };
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  const first = await pending.cancel().then(() => null, (error: unknown) => error);
  const second = await pending.cancel().then(() => null, (error: unknown) => error);
  assert.ok(first instanceof PendingProviderStopError);
  assert.equal(second, first);
  assert.equal(closes, 1);
});

test('a candidate cancelled while it is being taken reports a failed close as an unproved stop', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const release = deferred<void>();
  const provider: Provider = { providerId: 'fake', capabilities, start: async () => {
    await release.promise;
    const session = new FakeSession(1, 'session-1', capabilities);
    session.close = async () => { throw new Error('Close failed.'); };
    return session;
  } };
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  const taking = pending.take('fake', null, generation, instructionHash);
  pending.abort();
  release.resolve();
  await assert.rejects(taking, PendingProviderStopError);
});

test('invalidation during candidate liveness proof cannot bind or restart in the old generation', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const entered = deferred<void>();
  const release = deferred<void>();
  let starts = 0;
  const provider: Provider = { providerId: 'fake', capabilities, start: async () => {
    starts += 1;
    const session = new FakeSession(starts, `session-${starts}`, capabilities);
    session.verifyLive = async () => { entered.resolve(); await release.promise; if (!session.isLive()) { throw new Error('Session stopped.'); } };
    return session;
  } };
  const pending = new PendingProviderStart(backend.asRuntime(), provider, null, generation, instructionHash);
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, pendingStart: pending, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  const starting = host.start();
  await entered.promise;
  host.invalidate('contextUncertain');
  assert.equal(starts, 1);
  assert.equal(backend.binding, null);
  backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
  release.resolve();
  assert.equal(await starting, false);
  assert.equal(starts, 1);
  assert.equal(backend.binding, null);
  assert.notEqual(host.status.provider.state, 'ready');
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'providerUnavailable');
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.notEqual(attached.snapshot.status.provider.state, 'ready'); }
  await host.shutdown();
});

test('invalidation before initial host start leaves only status authority', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, pendingStart: pending, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  host.invalidate('contextUncertain');
  assert.equal(await host.start(), false);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.current.closed, true);
  assert.equal(backend.binding, null);
  assert.notEqual(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

for (const trigger of ['invalidation', 'safety refusal'] as const) {
  test(`an unproved candidate stop after ${trigger} keeps the guard through host cleanup`, async () => {
    const backend = new FakeBackend();
    Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} }, closeStartupWorkers: async () => { backend.events.push('workers'); } });
    const provider = new FakeProvider();
    provider.configure = session => { session.close = async () => { throw new Error('Close failed.'); }; };
    const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
    assert.ok(pending);
    if (trigger === 'safety refusal') { Object.assign(backend, { providerSafety: async () => { throw new Error('Safety unavailable.'); } }); }
    const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, pendingStart: pending, requireVerifiedAttach: true,
      providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
    if (trigger === 'invalidation') { host.invalidate('contextUncertain'); }
    const startFailure = await host.start().then(() => null, (error: unknown) => error);
    assert.ok(startFailure instanceof PendingProviderStopError);
    await assert.rejects(cleanupFailedChatRuntime(startFailure, backend.asRuntime(), host, null), PendingProviderStopError);
    assert.equal(backend.held, true);
    assert.equal(backend.events.includes('workers'), true);
    assert.equal(backend.events.includes('shutdown'), false);
  });
}

test('later correction waits for a new durable generation before replacing the provider', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  host.invalidate('contextUncertain');
  await until(() => provider.current.closed);
  assert.equal(provider.calls.length, 1);
  backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
  await until(() => provider.calls.length === 2 && host.status.provider.state === 'ready');
  assert.equal(backend.binding?.stateGeneration, 'f'.repeat(32));
  await host.shutdown();
});

for (const controlKind of ['requested', 'namedResume'] as const) {
  test(`correction waits for ${controlKind} provider ownership before replacement`, async () => {
    const backend = new FakeBackend();
    const provider = new FakeProvider();
    const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash,
      providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
    assert.equal(await host.start(), true);
    const oldSessionId = provider.current.providerSessionId;
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalStart = provider.start.bind(provider);
    let heldCandidate: FakeSession | null = null;
    let overlapping = false;
    provider.start = async (resume: string | null) => {
      if (heldCandidate !== null && !heldCandidate.closed) { overlapping = true; throw new Error('Provider namespace occupied.'); }
      const candidate = await originalStart(resume);
      if (provider.calls.length === 2) { heldCandidate = provider.current; entered.resolve(); await release.promise; }
      return candidate;
    };
    const control = controlKind === 'requested' ? host.startNewAgentSession() : host.resumeAgentSession(oldSessionId);
    await entered.promise;
    host.invalidate('contextUncertain');
    backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
    assert.equal(provider.calls.length, 2);
    release.resolve();
    assert.equal(await control, controlKind === 'requested' ? 'providerUnavailable' : 'unknownSession');
    await until(() => provider.calls.length === 3 && backend.binding?.stateGeneration === 'f'.repeat(32) && host.status.provider.state === 'ready');
    assert.equal(overlapping, false);
    assert.equal(provider.sessions[1]?.closed, true);
    assert.equal(host.submitChat({ text: 'next', questionOverride: false }).result, 'admitted');
    await until(() => !host.turnInProgress);
    await host.shutdown();
  });
}

test('changed final instruction identity discards candidate and proves absence', async () => {
  const backend = new FakeBackend();
  let verified = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { verified += 1; } } });
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  assert.equal(await pending.take('fake', null, generation, 'f'.repeat(64)), null);
  assert.equal(provider.current.closed, true);
  assert.ok(verified > 0);
});

test('a different final provider identity cannot inherit the candidate', async () => {
  const backend = new FakeBackend();
  let verified = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { verified += 1; } } });
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  assert.equal(await pending.take('other-provider', null, generation, instructionHash), null);
  assert.equal(provider.current.closed, true);
  assert.ok(verified > 0);
});

test('the pending provider permits only one in-flight claim', async () => {
  const backend = new FakeBackend();
  const entered = deferred<void>();
  const release = deferred<void>();
  const provider = new FakeProvider();
  provider.configure = session => { session.verifyLive = async () => { entered.resolve(); await release.promise; }; };
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  const first = pending.take('fake', null, generation, instructionHash);
  await entered.promise;
  await assert.rejects(pending.take('fake', null, generation, instructionHash), PendingProviderStopError);
  release.resolve();
  const claimed = await first;
  assert.ok(claimed);
  await claimed.close();
  assert.equal(provider.calls.length, 1);
});

test('cancellation closes a late successful start before it can transfer', async () => {
  const backend = new FakeBackend();
  let verified = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { verified += 1; } } });
  const start = deferred<ProviderSession>();
  let aborted = false;
  const provider: Provider = { providerId: 'fake', capabilities, start: (_resume, signal) => {
    signal?.addEventListener('abort', () => { aborted = true; });
    return start.promise;
  } };
  const pending = new PendingProviderStart(backend.asRuntime(), provider, null, generation, instructionHash);
  const cancelling = pending.cancel();
  const session = new FakeSession(1, 'late', capabilities);
  start.resolve(session);
  await cancelling;
  assert.equal(aborted, true);
  assert.equal(session.closed, true);
  assert.ok(verified > 0);
  assert.equal(await pending.take('fake', null, generation, instructionHash), null);
});

test('unproved provider job absence rejects candidate cancellation', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { throw new Error('unknown job state'); } } });
  const provider = new FakeProvider();
  const pending = await selectPendingProviderStart(backend.asRuntime(), provider, instructionHash);
  assert.ok(pending);
  await assert.rejects(pending.cancel(), PendingProviderStopError);
  assert.equal(provider.current.closed, true);
});

test('production attachment requires final safety and live proof', async () => {
  const backend = new FakeBackend();
  Object.assign(backend.status, { watcher: 'running' });
  let workerProofs = 0;
  let workerFailure = false;
  let clock = 0;
  let proofClockAdvance = 0;
  let expireFreshProof = false;
  let safetyCalls = 0;
  let directSafetyCalls = 0;
  const safety = backend.safety.bind(backend);
  Object.assign(backend, { safety: async () => { directSafetyCalls += 1; return safety(); } });
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => {
    safetyCalls += 1;
    if (expireFreshProof) { proofClockAdvance = 3_100; }
    return providerSafety();
  } });
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {
    workerProofs += 1;
    clock += proofClockAdvance;
    proofClockAdvance = 0;
    if (workerFailure) { throw new Error('startup worker remains'); }
  } } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, monotonicNow: () => clock });
  assert.equal(await host.start(), true);
  assert.throws(() => host.attach(() => {}));
  await host.prepareAttachmentWitness();
  const warmSafetyCalls = safetyCalls;
  const warmDirectSafetyCalls = directSafetyCalls;
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  assert.equal(safetyCalls, warmSafetyCalls);
  assert.equal(directSafetyCalls, warmDirectSafetyCalls);
  assert.equal(workerProofs, 3);
  host.detach();
  await host.prepareAttachmentWitness();
  clock = 4_000;
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  assert.equal(safetyCalls, warmSafetyCalls + 2);
  host.detach();
  await host.prepareAttachmentWitness();
  const callsBeforeLateExpiry = safetyCalls;
  const proofsBeforeLateExpiry = workerProofs;
  proofClockAdvance = 3_100;
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  assert.equal(safetyCalls, callsBeforeLateExpiry + 1);
  assert.equal(workerProofs, proofsBeforeLateExpiry + 6);
  host.detach();
  expireFreshProof = true;
  await host.prepareAttachmentWitness();
  const callsBeforeFreshExpiry = safetyCalls;
  const proofsBeforeFreshExpiry = workerProofs;
  await assert.rejects(host.attachVerified(() => {}));
  assert.equal(safetyCalls, callsBeforeFreshExpiry + 1);
  assert.equal(workerProofs, proofsBeforeFreshExpiry + 6);
  expireFreshProof = false;
  await host.prepareAttachmentWitness();
  const healthyStatus = backend.status;
  Object.assign(backend, { status: { ...healthyStatus, journal: { ...healthyStatus.journal, state: 'fault' } } });
  await assert.rejects(host.attachVerified(() => {}));
  Object.assign(backend, { status: healthyStatus });
  await host.prepareAttachmentWitness();
  const callsBeforeChangedGeneration = safetyCalls;
  backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
  Object.assign(backend, { status: { ...healthyStatus } });
  await assert.rejects(host.attachVerified(() => {}));
  assert.equal(safetyCalls, callsBeforeChangedGeneration);
  Object.assign(backend, { status: healthyStatus });
  backend.safetyValue = { ...backend.safetyValue, generation };
  await host.prepareAttachmentWitness();
  workerFailure = true;
  await assert.rejects(host.attachVerified(() => {}));
  workerFailure = false;
  backend.held = false;
  await assert.rejects(host.attachVerified(() => {}));
  backend.held = true;
  provider.current.closed = true;
  await assert.rejects(host.attachVerified(() => {}));
  await host.shutdown();
});

test('attachment reservation refuses overlap and detach cancels pending sink installation', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  await host.prepareAttachmentWitness();
  const entered = deferred<void>();
  const release = deferred<void>();
  const verify = provider.current.verifyLive.bind(provider.current);
  provider.current.verifyLive = async () => { entered.resolve(); await release.promise; await verify(); };
  let delivered = 0;
  const first = host.attachVerified(() => { delivered += 1; });
  await entered.promise;
  assert.throws(() => host.attach(() => {}));
  assert.equal((await host.attachVerified(() => {})).result, 'clientAlreadyAttached');
  host.detach();
  release.resolve();
  assert.equal((await first).result, 'attachCancelled');
  assert.equal(delivered, 0);
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  await host.shutdown();
});

test('shutdown waits for a cancelled attachment proof before guard release', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  await host.prepareAttachmentWitness();
  const entered = deferred<void>();
  const release = deferred<void>();
  const verify = provider.current.verifyLive.bind(provider.current);
  provider.current.verifyLive = async () => { entered.resolve(); await release.promise; await verify(); };
  const attaching = host.attachVerified(() => {});
  await entered.promise;
  const stopping = host.shutdown();
  assert.equal(backend.events.includes('shutdown'), false);
  release.resolve();
  assert.equal((await attaching).result, 'attachCancelled');
  await stopping;
  assert.equal(backend.events.includes('shutdown'), true);
});

test('status-only proof cannot install a provider that becomes ready while workers are checked', async () => {
  const backend = new FakeBackend();
  const workerEntered = deferred<void>();
  const releaseWorker = deferred<void>();
  let safetyCalls = 0;
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => { safetyCalls += 1; return providerSafety(); } });
  Object.assign(backend, { supervisor: { verifyQuiescent: async (role: string) => {
    if (role === 'startupMetadata') { workerEntered.resolve(); await releaseWorker.promise; }
  } } });
  const provider = new FakeProvider();
  let liveCalls = 0;
  provider.configure = session => { session.verifyLive = async () => { liveCalls += 1; if (!session.isLive()) { throw new Error('Provider stopped.'); } }; };
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  try {
    assert.equal(await host.start(), true);
    host.invalidate('contextUncertain');
    let delivered = 0;
    const attaching = host.attachVerified(() => { delivered += 1; });
    await workerEntered.promise;
    backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
    for (let attempt = 0; attempt < 100 && (backend.binding?.stateGeneration !== 'f'.repeat(32) || host.status.provider.state !== 'ready'); attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    assert.equal(backend.binding?.stateGeneration, 'f'.repeat(32));
    assert.equal(host.status.provider.state, 'ready');
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseWorker.resolve();
    assert.equal((await attaching).result, 'attachStateChanged');
    assert.equal(delivered, 0);
    const safetyBeforeReadyAttach = safetyCalls;
    const liveBeforeReadyAttach = liveCalls;
    assert.equal((await host.attachVerified(() => {})).result, 'attached');
    assert.equal(safetyCalls, safetyBeforeReadyAttach + 1);
    assert.equal(liveCalls, liveBeforeReadyAttach + 1);
  } finally { releaseWorker.resolve(); await host.shutdown(); }
});

for (const refusal of ['rejected', 'changedGeneration'] as const) {
  test(`final ${refusal} safety stops the bound provider and attaches status only`, async () => {
    const backend = new FakeBackend();
    let absenceProofs = 0;
    Object.assign(backend, { supervisor: { verifyQuiescent: async (role: string) => { if (role === 'provider') { absenceProofs += 1; } } } });
    let safetyCalls = 0;
    const providerSafety = backend.providerSafety.bind(backend);
    Object.assign(backend, { providerSafety: async () => {
      safetyCalls += 1;
      const safety = await providerSafety();
      if (safetyCalls === 3) {
        if (refusal === 'rejected') { throw new Error('Final safety unavailable.'); }
        return { ...safety, generation: 'f'.repeat(32) };
      }
      return safety;
    } });
    const provider = new FakeProvider();
    const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
      providerTerminated: async () => { assert.equal(provider.current.closed, true); await backend.asRuntime().supervisor.verifyQuiescent('provider'); },
      verifyTools: async () => {}, closeTools: async () => {} });
    assert.equal(await host.start(), true);
    const bound = backend.binding;
    assert.ok(bound);
    await finalizeAttachmentSafety(host, backend.asRuntime());
    assert.equal(backend.binding, bound);
    assert.equal(host.status.provider.state, 'failed');
    assert.equal(provider.current.closed, true);
    assert.equal(absenceProofs, 1);
    assert.notEqual(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
    assert.equal(await host.startNewAgentSession(), 'providerUnavailable');
    const attached = await host.attachVerified(() => {});
    assert.equal(attached.result, 'attached');
    if (attached.result === 'attached') { assert.equal(attached.snapshot.status.provider.state, 'failed'); }
    assert.equal(provider.current.requests.length, 0);
    await host.shutdown();
    assert.ok(backend.events.includes('shutdown'));
  });
}

test('uncertain provider stop after final safety refusal remains fatal', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => { throw new Error('Provider job absence unknown.'); } } });
  let safetyCalls = 0;
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => { safetyCalls += 1; if (safetyCalls === 3) { throw new Error('Final safety unavailable.'); } return providerSafety(); } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: () => backend.asRuntime().supervisor.verifyQuiescent('provider'), verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  await assert.rejects(finalizeAttachmentSafety(host, backend.asRuntime()), /Provider job absence unknown/);
  assert.equal(backend.held, true);
  await assert.rejects(host.shutdown(), /Provider job absence unknown/);
  assert.equal(backend.events.includes('shutdown'), false);
});

test('failed startup freshness attaches the bound provider and keeps chat usable for disclosure-only turns', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  Object.assign(backend.status, { freshness: { ...backend.status.freshness, state: 'failed', class: 'source', reason: 'stale-target' } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  await finalizeAttachmentSafety(host, backend.asRuntime());
  assert.equal(provider.current.closed, false);
  assert.equal(host.status.provider.state, 'ready');
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.equal(attached.snapshot.status.freshness.state, 'failed'); }
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

test('a provider exit before the final attachment check reconnects instead of latching a safety block', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  provider.current.exit('subprocessExited');
  await finalizeAttachmentSafety(host, backend.asRuntime());
  assert.equal(provider.calls.length, 2);
  assert.equal(host.status.provider.state, 'ready');
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.equal(attached.snapshot.status.provider.state, 'ready'); }
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

test('a provider that exits and cannot reconnect attaches status-only after its reconnect attempts', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  provider.failAll = true;
  provider.current.exit('subprocessExited');
  await finalizeAttachmentSafety(host, backend.asRuntime());
  assert.ok(provider.calls.length > 1);
  assert.equal(host.status.provider.state, 'failed');
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.notEqual(attached.snapshot.status.provider.state, 'ready'); }
  await host.shutdown();
});

test('an invalidation while a pre-attachment reconnect settles still latches the final safety block', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  const start = provider.start.bind(provider);
  provider.start = async (resume: string | null) => {
    if (provider.calls.length === 1) {
      host.invalidate('contextUncertain');
      backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
    }
    return start(resume);
  };
  provider.current.exit('subprocessExited');
  await finalizeAttachmentSafety(host, backend.asRuntime());
  assert.notEqual(host.status.provider.state, 'ready');
  assert.notEqual(backend.binding?.stateGeneration, 'f'.repeat(32));
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.notEqual(attached.snapshot.status.provider.state, 'ready'); }
  assert.notEqual(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

test('a provider that keeps exiting during the final check attaches from its settled reconnect', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  const providerSafety = backend.providerSafety.bind(backend);
  let finalizing = true;
  Object.assign(backend, { providerSafety: async () => {
    const safety = await providerSafety();
    if (finalizing && host.status.provider.state === 'ready' && !provider.current.closed) { provider.current.exit('subprocessExited'); }
    return safety;
  } });
  provider.current.exit('subprocessExited');
  await finalizeAttachmentSafety(host, backend.asRuntime());
  finalizing = false;
  assert.notEqual(host.status.provider.state, 'reconnecting');
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  await host.shutdown();
});

test('after a failed startup phase, valid provider safety still starts and attaches the provider', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} }, closeStartupWorkers: async () => { backend.events.push('workers'); } });
  Object.assign(backend.status, { journal: { state: 'fault', fault: 'journalUnavailable', unacknowledgedEvents: 0 },
    freshness: { ...backend.status.freshness, state: 'failed', class: 'journal', reason: 'journalUnavailable' } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  const started = await startChatProvider(host, backend.asRuntime());
  assert.equal(started.result, 'ready');
  assert.equal(provider.calls.length, 1);
  assert.equal(host.status.provider.state, 'ready');
  assert.equal(backend.events.includes('workers'), true);
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  assert.equal(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

test('after a failed startup phase, refused provider safety leaves a status-only client', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} }, closeStartupWorkers: async () => { backend.events.push('workers'); },
    providerSafety: async () => { throw new Error('Context safety authority is unavailable.'); } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  const started = await startChatProvider(host, backend.asRuntime());
  assert.equal(started.result, 'ready');
  assert.equal(provider.calls.length, 0);
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.notEqual(attached.snapshot.status.provider.state, 'ready'); }
  assert.notEqual(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  await host.shutdown();
});

test('a later invalidation after a final safety block keeps status-only attachment available', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  let safetyCalls = 0;
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => { safetyCalls += 1; if (safetyCalls === 3) { throw new Error('Final safety refused.'); } return providerSafety(); } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  await finalizeAttachmentSafety(host, backend.asRuntime());
  host.invalidate('contextUncertain');
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  assert.equal(provider.calls.length, 1);
  await host.shutdown();
});

test('a second invalidation after a startup invalidation keeps status-only attachment available', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
  host.invalidate('contextUncertain');
  assert.equal(await host.start(), false);
  host.invalidate('contextUncertain');
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  assert.equal(provider.calls.length, 0);
  await host.shutdown();
});

test('an incompatible provider exit before the final check attaches status-only', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  provider.current.exit('providerUnavailable');
  await finalizeAttachmentSafety(host, backend.asRuntime());
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.equal(attached.snapshot.status.provider.state, 'failed'); }
  await host.shutdown();
});

test('a requested new session retries after an exhausted reconnect', async () => {
  const backend = new FakeBackend();
  Object.assign(backend, { supervisor: { verifyQuiescent: async () => {} } });
  const provider = new FakeProvider();
  const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {}, delay: async () => {} });
  assert.equal(await host.start(), true);
  await finalizeAttachmentSafety(host, backend.asRuntime());
  assert.equal((await host.attachVerified(() => {})).result, 'attached');
  provider.failAll = true;
  provider.current.exit('subprocessExited');
  await until(() => host.status.provider.state === 'failed');
  const failedStarts = provider.calls.length;
  provider.failAll = false;
  assert.equal(await host.startNewAgentSession(), 'started');
  assert.equal(provider.calls.length, failedStarts + 1);
  assert.equal(host.status.provider.state, 'ready');
  await host.shutdown();
});

test('final safety refusal waits for a queued correction before status-only attachment', async () => {
  const backend = new FakeBackend();
  const provider = new FakeProvider();
  let providerAbsenceProofs = 0;
  Object.assign(backend, { supervisor: { verifyQuiescent: async (role: string) => {
    if (role === 'provider') { assert.equal(provider.current.closed, true); providerAbsenceProofs += 1; }
  } } });
  let host: SessionHost;
  let refuseFinal = false;
  const providerSafety = backend.providerSafety.bind(backend);
  Object.assign(backend, { providerSafety: async () => {
    if (refuseFinal) { refuseFinal = false; host.invalidate('contextUncertain'); throw new Error('Final safety refused.'); }
    return providerSafety();
  } });
  host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
    providerTerminated: () => backend.asRuntime().supervisor.verifyQuiescent('provider'), verifyTools: async () => {}, closeTools: async () => {} });
  assert.equal(await host.start(), true);
  const entered = deferred<void>();
  const release = deferred<void>();
  const maintenance = (host as unknown as { maintenance: { run: (action: () => Promise<void>) => Promise<void> } }).maintenance.run(async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  refuseFinal = true;
  let finalized = false;
  const finishing = finalizeAttachmentSafety(host, backend.asRuntime()).then(() => { finalized = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finalized, false);
  assert.equal(provider.calls.length, 1);
  backend.safetyValue = { ...backend.safetyValue, generation: 'f'.repeat(32) };
  release.resolve();
  await maintenance;
  await finishing;
  assert.equal(provider.calls.length, 1);
  assert.equal(providerAbsenceProofs, 1);
  assert.equal(host.status.provider.state, 'failed');
  assert.notEqual(host.submitChat({ text: 'question', questionOverride: false }).result, 'admitted');
  const attached = await host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
  if (attached.result === 'attached') { assert.equal(attached.snapshot.status.provider.state, 'failed'); }
  await host.shutdown();
});

for (const [enabled, watcher] of [[false, 'disabled'], [true, 'stopped']] as const) {
  test(`healthy attachment admits valid state with watcher ${watcher}`, async () => {
    const backend = new FakeBackend();
    Object.assign(backend, { config: { ...backend.config, watcher: { enabled } },
      supervisor: { verifyQuiescent: async () => {} } });
    Object.assign(backend.status, { watcher });
    const provider = new FakeProvider();
    const host = new SessionHost({ backend: backend.asRuntime(), provider, instructionsSha256: instructionHash, requireVerifiedAttach: true,
      providerTerminated: async () => {}, verifyTools: async () => {}, closeTools: async () => {} });
    assert.equal(await host.start(), true);
    await host.prepareAttachmentWitness();
    const attached = await host.attachVerified(() => {});
    assert.equal(attached.result, 'attached');
    if (attached.result === 'attached') { assert.equal(attached.snapshot.status.watcher, watcher); }
    await host.shutdown();
  });
}
