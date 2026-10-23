import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../../src/backend/index.ts';
import type { RuntimeBackend } from '../../src/backend/api.ts';
import type { JsonValue } from '../../src/json.ts';
import { parseSessionBinding } from '../../src/session-records.ts';
import { SessionHost } from '../../src/session-host.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { companionFixture } from '../support/companion.ts';
import { FakeProvider, instructionHash } from './support.ts';
import { testHelperImage } from '../support/native-helper.ts';

// This private fixture includes release, hand-over and safety recovery before the turn; the runtime settlement gate stays at 120 seconds.
test('real private coordinator carries accepted state through SessionHost and resumes its acknowledged binding', { timeout: 3000000 }, async () => {
  const fixture = await companionFixture('runtime-owned-empty');
  let backend: RuntimeBackend | null = null;
  let host: SessionHost | null = null;
  const progress = (stage: string): void => { process.stdout.write(`# ${new Date().toISOString()} ${stage}\n`); };
  const diagnostics: Record<string, unknown>[] = [];
  const diagnose = (phase: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (diagnostics.length < 64) { diagnostics.push({ at: new Date().toISOString(), phase, name: error instanceof Error ? error.name : 'unknown', message: message.slice(0, 4096), stack: error instanceof Error ? error.stack?.slice(0, 8192) : null }); }
    progress(`backend diagnostic ${phase}: ${message.slice(0, 4096)}`);
  };
  try {
    progress('releasing the private empty runtime-owned fixture to bridge');
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root, onDiagnostic: diagnose });
    const release = await backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true });
    assert.equal(release.consumerResult?.success, true);
    if (release.consumerResult?.success !== true) { assert.fail('Private bridge release failed.'); }
    assert.equal(release.consumerResult.value.previousOwner, 'runtime');
    assert.equal(release.consumerResult.value.abandonedCount, 0);
    await backend.shutdown(true); backend = null;
    progress('opening private consumer hand-over from bridge');
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root, onDiagnostic: diagnose });
    const ownership = await backend.startup({ kind: 'consumer', owner: 'runtime', abandonUndelivered: false });
    assert.equal(ownership.consumerResult?.success, true);
    if (ownership.consumerResult?.success !== true) { assert.fail('Private runtime hand-over failed.'); }
    assert.equal(ownership.consumerResult.value.previousOwner, 'bridge');
    const header = JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'journal', 'journal.json'), 'utf8')) as { historyVerified?: unknown };
    assert.equal(header.historyVerified, true);
    await backend.shutdown(true); backend = null;
    progress('verified private bridge hand-over completed; opening chat backend');

    const events: HostEvent[] = [];
    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root, onStatus: status => {
      host?.statusChanged();
      progress(`status freshness=${status.freshness.state} reason=${status.freshness.reason ?? 'none'} journal=${status.journal.state} safety=${status.stateSafety.state}`);
    }, onInvalidated: reason => host?.invalidate(reason), onDiagnostic: diagnose });
    const startup = await backend.startup({ kind: 'chat' });
    progress('private chat startup completed');
    assert.equal(startup.notOwner, false);
    assert.equal(backend.status.stateSafety.state === 'unavailable', false, JSON.stringify(backend.status));
    assert.ok(backend.status.journal.unacknowledgedEvents > 0, `Verified bridge hand-over produced no deliverable event: ${JSON.stringify(backend.status)}`);
    const provider = new FakeProvider();
    let delivered: Record<string, unknown> | null = null;
    provider.configure = session => {
      session.action = async request => {
        // The real coordinator supplies this opaque block; the fake provider
        // observes it only after the actual beforeSend authority gate.
        assert.match(request.contextBlock, /^<companion-turn-context>/);
        delivered = JSON.parse(request.contextBlock.slice('<companion-turn-context>'.length, -'</companion-turn-context>'.length)) as Record<string, unknown>;
        assert.equal(delivered.companionTurnContextVersion, 1);
        assert.equal(delivered.sessionOpening, true);
        assert.ok(Array.isArray(delivered.events));
        assert.notEqual(delivered.state, null);
        return { kind: 'completed', text: 'Private fixture answer.' };
      };
    };
    host = new SessionHost({ backend, provider, instructionsSha256: instructionHash, providerTerminated: async () => backend!.supervisor.verifyQuiescent('provider'),
      verifyTools: async () => backend!.supervisor.verifyQuiescent('provider'), closeTools: async () => {}, delay: async () => {} });
    assert.equal(await host.start(), true);
    progress('fake provider bound to durable production authority');
    let finish: ((event: HostEvent) => void) | null = null;
    host.attach(event => { events.push(event); if (event.type === 'turn.completed' || event.type === 'turn.failed') { finish?.(event); } });
    const terminal = new Promise<HostEvent>(resolve => { finish = resolve; });
    assert.equal(host.submitChat({ text: 'Inspect the private fixture.', questionOverride: false }).result, 'admitted');
    const outcome = await terminal;
    progress(`private turn terminal ${outcome.type}`);
    assert.equal(outcome.type, 'turn.completed', JSON.stringify({ outcome, status: host.status }));
    assert.ok(delivered);
    await host.shutdown(); host = null;
    // Shutdown finalizes the acknowledgement and closes the helper service, so the durable binding is read from its file.
    const binding = parseSessionBinding(JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'agent-session.json'), 'utf8')) as JsonValue);
    assert.equal(binding.turnsCompleted, 1);
    const cursor = JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'journal', 'cursor-agent-session.json'), 'utf8')) as Record<string, number>;
    assert.ok(cursor.lastAckedSequence! > 0);
    assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
    const sessionId = binding.providerSessionId;
    backend = null;
    progress('acknowledged runtime closed; reopening for resume');

    backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root, onDiagnostic: diagnose });
    assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
    const resumed = new FakeProvider();
    host = new SessionHost({ backend, provider: resumed, instructionsSha256: instructionHash, providerTerminated: async () => backend!.supervisor.verifyQuiescent('provider'),
      verifyTools: async () => backend!.supervisor.verifyQuiescent('provider'), closeTools: async () => {}, delay: async () => {} });
    assert.equal(await host.start(), true);
    progress('persisted provider session resumed');
    assert.equal(resumed.calls[0], sessionId);
    const restored = await backend.sessions.readBinding();
    assert.equal(restored.status === 'valid' && restored.value.turnsCompleted, 1);
    assert.equal(restored.status === 'valid' && restored.value.needsState, true);
    await host.shutdown(); host = null; backend = null;
  } catch (error) {
    const evidence = fileURLToPath(new URL(`../../../.tmp/nightshift/client-impl/e2e-failure-${randomUUID()}`, import.meta.url));
    try {
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.cp(path.join(fixture.root, 'runtime-data'), evidence, { recursive: true, errorOnExist: true, force: false });
      await fs.writeFile(`${evidence}.json`, JSON.stringify({ diagnosticVersion: 1, diagnostics }, null, 2).replaceAll('\n', '\r\n') + '\r\n');
      progress(`Failure diagnostic copy retained at ${evidence}; it is not replay authority.`);
    } catch { progress('Failure diagnostic copy was unavailable.'); }
    throw error;
  } finally {
    if (host !== null) { await host.shutdown(); backend = null; }
    if (backend !== null) { await backend.shutdown(true); }
    await fixture.close();
  }
});
