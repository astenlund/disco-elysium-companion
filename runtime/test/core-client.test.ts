import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PathInspector } from '../src/admission.ts';
import { CoreClient, resolvePrincipal, type CoreRequest } from '../src/core-client.ts';
import { isOpaqueToken } from '../src/identity.ts';
import { isObject } from '../src/json.ts';
import { SupervisorError } from '../src/process.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative } from './support/native-helper.ts';

describe('validated core command boundary', () => {
  it('correlates ownership, publication and settlement against real private-core replies', { timeout: 240000 }, async () => {
    const fixture = await companionFixture('core');
    const supervisor = (await createTestNative(fixture.root)).supervisor;
    const inspector = new PathInspector(supervisor);
    const admitted: CoreRequest[] = [];
    // This transport fixture records admission. Durable safety/reservations belong
    // to the coordinator and are not exercised by this transport-only fixture.
    const client = new CoreClient({ companionRoot: fixture.root, adapter: 'stub', supervisor, inspector, admit: async request => { admitted.push(request); } });
    try {
      const principal = await resolvePrincipal(inspector);
      assert.equal(isOpaqueToken(principal), true);
      const refused = await client.publish(principal);
      assert.equal(refused.success, false);
      if (refused.success) { throw new Error('Fixture publication unexpectedly owned consumption.'); }
      assert.equal(refused.class, 'config');
      assert.equal(refused.reason, 'consumer-not-owner');
      assert.equal(refused.consumptionState, 'none');
      const switched = await client.consumer({ kind: 'consumer', owner: 'runtime' });
      assert.equal(switched.success, true);
      const published = await client.publish(principal, true);
      assert.equal(published.success, true);
      if (!published.success) { throw new Error('Fixture publication failed.'); }
      assert.equal(published.value.kind, 'consumed');
      assert.equal(published.value.sequence, 1);
      assert.equal(published.value.game, 'stubgame');
      const record = path.join(fixture.root, 'state', 'outbox', 'event-0000000000000001.json');
      const observed = await inspector.native('eventMetadata', { root: fixture.root, requestsJson: JSON.stringify([{ path: record, sequence: 1 }]), source: true });
      assert.ok(isObject(observed) && Array.isArray(observed['documents']));
      const document = observed['documents'][0]!;
      assert.ok(isObject(document) && isObject(document['metadata']));
      assert.equal(document['metadata']['targetIdentitySha256'], published.value.targetIdentitySha256);
      const binding = { logicalOutboxId: published.value.logicalOutboxId!, recordSha256: document['sha256'] as string, journalId: 'journal', eventId: 'event' };
      const settled = await client.settle(binding);
      assert.deepEqual(settled, { success: true, value: 'settled' });
      await assert.rejects(fs.readFile(record), { code: 'ENOENT' });
      assert.deepEqual(await client.settle(binding), { success: true, value: 'already-settled' });
      const unchanged = await client.publish(principal);
      assert.equal(unchanged.success && unchanged.value.outcome, 'unchanged');
      const snapshot = await client.publish(principal, true);
      assert.equal(snapshot.success && snapshot.value.kind, 'snapshot');
      const count = admitted.length;
      await assert.rejects(client.settle(binding, performance.now() - 1), error => error instanceof SupervisorError && error.reason === 'deadline');
      assert.equal(admitted.length, count);
      const release = await client.consumer({ kind: 'consumer', owner: 'bridge', mode: 'abandon' });
      assert.equal(release.success && release.value.owner, 'bridge');
      assert.equal(admitted[0]!.kind, 'publish');
      assert.equal(admitted[1]!.kind, 'consumer');
    } finally { await client.idle(); await fixture.close(); }
  });

  it('refuses mutation before child launch when durable admission is unavailable', { timeout: 60000 }, async () => {
    const fixture = await companionFixture('core');
    const supervisor = (await createTestNative(fixture.root)).supervisor;
    const client = new CoreClient({ companionRoot: fixture.root, adapter: 'stub', supervisor, inspector: new PathInspector(supervisor), admit: async () => { throw new Error('intent unavailable'); } });
    try {
      await assert.rejects(client.consumer({ kind: 'consumer', owner: 'runtime' }), /intent unavailable/);
      await assert.rejects(fs.readFile(path.join(fixture.root, 'state', 'consumer.json')), { code: 'ENOENT' });
      await supervisor.verifyQuiescent('core');
    } finally { await fixture.close(); }
  });

  it('maps malformed terminal framing to supervisor failure without inventing a consumption state', { timeout: 90000 }, async () => {
    const fixture = await companionFixture('core');
    const supervisor = (await createTestNative(fixture.root)).supervisor;
    const run = supervisor.run.bind(supervisor);
    supervisor.run = async (role, options, timeout, input) => {
      const result = await run(role, options, timeout, input);
      return role === 'core' ? { ...result, stderr: Buffer.concat([Buffer.from('unexpected\n'), result.stderr]) } : result;
    };
    const client = new CoreClient({ companionRoot: fixture.root, adapter: 'stub', supervisor, inspector: new PathInspector(supervisor), admit: async () => {} });
    try {
      await assert.rejects(client.publish('fixture-principal'), error => error instanceof SupervisorError && error.reason === 'result-invalid');
    } finally { await client.idle(); await fixture.close(); }
  });
});
