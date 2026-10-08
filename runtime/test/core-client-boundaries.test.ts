import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import { CoreClient } from '../src/core-client.ts';
import { ProcessSupervisor, SupervisorError } from '../src/process.ts';

describe('core acquisition termination boundary', () => {
  it('admits replayed resync only for its repair request and rejects it as an interaction result', async () => {
    const supervisor = { run: async () => ({ exitCode: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }) } as unknown as ProcessSupervisor;
    const inspector = { metadata: async () => ({ exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({
      coreReplyVersion: 1, success: true, class: null, reason: null, targetIdentitySha256: 'a'.repeat(64),
      data: { outcome: 'replayed', kind: 'resync', logicalOutboxId: `${'b'.repeat(32)}-1`, sequence: 1, schemaVersion: 2, adapterVersion: 1,
        game: 'fixture', target: { generatedAt: '2026-10-08T00:00:00.0000000Z' }, baselineApplied: false, cacheDegraded: false, warnings: [] },
    })) }) } as unknown as PathInspector;
    const client = new CoreClient({ companionRoot: 'C:/private-fixture', adapter: 'fixture', supervisor, inspector, admit: async () => {} });
    const repair = await client.publish('principal', false, 'repair-operation');
    assert.equal(repair.success && repair.value.outcome, 'replayed');
    for (const requireRecord of [false, true]) {
      await assert.rejects(client.publish('principal', requireRecord), error => error instanceof SupervisorError && error.reason === 'result-invalid');
    }
  });

  it('observes verified child termination before receipt validation, including invalid receipts', async () => {
    const order: string[] = [];
    const supervisor = { run: async () => { order.push('child'); return { exitCode: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }; } } as unknown as ProcessSupervisor;
    const inspector = { metadata: async () => { order.push('validate'); return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } } as unknown as PathInspector;
    const client = new CoreClient({ companionRoot: 'C:/private-fixture', adapter: 'fixture', supervisor, inspector, admit: async () => { order.push('admit'); } });
    const start = performance.now();
    let ended: number | null = null;
    await assert.rejects(client.publish('principal', false, null, Infinity, at => { ended = at; order.push('terminated'); }), SupervisorError);
    assert.deepEqual(order, ['admit', 'child', 'terminated', 'validate']);
    assert.ok(ended !== null && ended >= start && ended <= performance.now());
  });

  it('requires verified termination on run failure and never invents a child for rejected admission', async () => {
    for (const fault of ['run', 'termination', 'admission'] as const) {
      const order: string[] = [];
      const supervisor = {
        run: async () => { order.push('child'); throw new SupervisorError('deadline', 'Fixture child deadline.'); },
        verifyQuiescent: async () => { order.push('verify'); if (fault === 'termination') { throw new SupervisorError('termination-unverified', 'Fixture termination unknown.'); } },
      } as unknown as ProcessSupervisor;
      const client = new CoreClient({ companionRoot: 'C:/private-fixture', adapter: 'fixture', supervisor, inspector: {} as PathInspector,
        admit: async () => { if (fault === 'admission') { throw new Error('Fixture admission refused.'); } } });
      await assert.rejects(client.publish('principal', false, null, Infinity, () => { order.push('terminated'); }));
      assert.deepEqual(order, fault === 'admission' ? [] : fault === 'termination' ? ['child', 'verify'] : ['child', 'verify', 'terminated']);
    }
  });
});
