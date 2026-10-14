import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PathInspector } from '../src/admission.ts';
import { FilePublisher, PublicationError } from '../src/files.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { parseStrictJson } from '../src/json.ts';
import { ProcessSupervisor, SupervisorError } from '../src/process.ts';
import type { StartupMutationSession } from '../src/startup-mutation.ts';
import { companionFixture } from './support/companion.ts';

describe('runtime publication boundary', () => {
  it('publishes exact bytes with a separate Node reader open and preserves create-only collisions', { timeout: 120000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
    const invalidated: string[] = [];
    const publisher = new FilePublisher({ root: fixture.root, guard, inspector, supervisor, preflight: async (_target, bytes, profile) => { parseStrictJson(bytes, profile); }, invalidate: target => invalidated.push(target) });
    try {
      const first = await publisher.publishJson('record.json', { value: 'old' }, true);
      assert.equal(first.cleanupComplete, true);
      const target = path.join(fixture.root, 'record.json');
      const held = await fs.open(target, 'r');
      try {
        const second = await publisher.publishJson('record.json', { value: 'new' });
        assert.equal(second.cleanupComplete, true);
        assert.equal(await fs.readFile(target, 'utf8'), '{"value":"new"}');
        assert.equal(await held.readFile('utf8'), '{"value":"old"}');
      } finally { await held.close(); }
      await assert.rejects(publisher.publishJson('record.json', { value: 'collision' }, true), PublicationError);
      assert.equal(await fs.readFile(target, 'utf8'), '{"value":"new"}');
      assert.equal(invalidated.length, 1);
      assert.deepEqual(await fs.readdir(fixture.root), ['record.json']);
    } finally {
      await publisher.idle();
      await guard.release();
      await fixture.close();
    }
  });

  it('refuses admission or preflight failure before staging any bytes', { timeout: 60000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
    const publisher = new FilePublisher({ root: fixture.root, guard, inspector, supervisor, preflight: async () => { throw new PublicationError('Reserved transition does not fit.'); }, invalidate: () => {} });
    try {
      await assert.rejects(publisher.publishJson('record.json', { value: 1 }), PublicationError);
      assert.deepEqual(await fs.readdir(fixture.root), []);
      await assert.rejects(publisher.publishJson('../outside.json', { value: 1 }));
      assert.deepEqual(await fs.readdir(fixture.root), []);
    } finally {
      await guard.release();
      await fixture.close();
    }
  });

  it('blocks after a startup mutation publishes but loses its reply', { timeout: 120000 }, async () => {
    const fixture = await companionFixture();
    const supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
    const publisher = new FilePublisher({ root: fixture.root, guard, inspector, supervisor,
      preflight: async (_target, bytes, profile) => { parseStrictJson(bytes, profile); }, invalidate: () => {} });
    const run = supervisor.run.bind(supervisor);
    let calls = 0;
    const session = { canFallBack: false, handles: () => true,
      async invoke(options: Parameters<ProcessSupervisor['run']>[1], timeout: number) {
        calls++;
        await run('publication', options, timeout);
        throw new SupervisorError('result-invalid', 'Private fixture discarded a complete mutation reply.');
      }, async close() {} } as unknown as StartupMutationSession;
    publisher.attachStartupMutationSession(session);
    try {
      const result = await publisher.publishJson('record.json', { value: 'complete' }, true);
      assert.equal(result.cleanupComplete, false);
      assert.equal(publisher.blocked, true);
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(path.join(fixture.root, 'record.json'), 'utf8'), '{"value":"complete"}');
      assert.deepEqual(await fs.readdir(fixture.root), ['record.json']);
      await assert.rejects(publisher.publishJson('another.json', { value: 'refused' }), PublicationError);
      assert.equal(calls, 1);
    } finally {
      await publisher.closeStartupMutationSession();
      await guard.release();
      await fixture.close();
    }
  });
});
