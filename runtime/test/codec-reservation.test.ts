import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { type PathAdmission, type PathInspector } from '../src/admission.ts';
import { PayloadCodec, type CodecReservation } from '../src/codec.ts';
import { RuntimeCapacityError } from '../src/capacity.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { FilePublisher, type AdmitPublicationScope } from '../src/files.ts';
import { eventRewriteMetadata } from '../src/journal-records.ts';
import type { OperationStore } from '../src/operations.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import { ResourceAuthority } from '../src/resource-lifecycle/resources.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { bytesHash } from '../src/storage.ts';
import { companionFixture } from './support/companion.ts';
import { journalEvent } from './support/journal-event.ts';

test('codec failures after reservation retire the old lease before another event', { timeout: 120000 }, async () => {
  const fixture = await companionFixture('state-event');
  try {
    const outbox = path.join(fixture.root, 'state', 'outbox');
    const names = (await fs.readdir(outbox)).filter(name => name.startsWith('event-') && name.endsWith('.json'));
    assert.equal(names.length, 1);
    const source = await fs.readFile(path.join(outbox, names[0]!));
    const record = JSON.parse(source.toString('utf8'));
    const metadata = (sequence: number) => eventRewriteMetadata(journalEvent(sequence, {
      adapter: record.game, principal: record.principal, logicalOutboxId: record.logicalOutboxId,
      recordSha256: bytesHash(source), coreRepairOperationId: record.repairOperationId,
      schemaVersion: record.state.schemaVersion, adapterVersion: record.adapterVersion,
      occurredAt: record.createdAt, type: `state.${record.kind}`, settlement: 'pending', acceptance: null,
    }));
    for (const mode of ['combined-deadline', 'fallback-deadline', 'staging-collision'] as const) {
      const dataRoot = path.join(fixture.root, mode);
      const events = path.join(dataRoot, 'journal', 'events');
      await fs.mkdir(events, { recursive: true });
      const binding = Buffer.from(JSON.stringify({ runtimeScopeVersion: 1, game: record.game, principal: record.principal }));
      await fs.writeFile(path.join(dataRoot, 'scope.json'), binding);
      const scope = { dataRoot, companionRoot: fixture.root, bindingSha256: bytesHash(binding), game: record.game, principal: record.principal } as RuntimeScope;
      let collide = mode === 'staging-collision';
      const inspector = { inspectMany: async (_root: string, targets: readonly string[]) => {
        const observed = await Promise.all(targets.map(async target => {
          try {
            const stat = await fs.lstat(target);
            const value: PathAdmission = { path: target, exists: true, kind: stat.isDirectory() ? 'directory' : 'file', links: 1,
              volume: '1'.repeat(16), identity: '1'.repeat(32), missing: [] };
            return value;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            return { path: target, exists: false, kind: null, links: null, volume: null, identity: null, missing: [path.basename(target)] } as PathAdmission;
          }
        }));
        if (collide && targets.length === 4) {
          collide = false;
          await fs.writeFile(targets[2]!, 'foreign staging file');
        }
        return observed;
      } } as unknown as PathInspector;
      const resources = new ResourceAuthority(scope, inspector, {} as OperationStore);
      resources.inventory = async () => ({ complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 },
        potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0, freeBytes: 4000000000n, uncertainWorkspace: false });
      let nativeCalls = 0;
      let invalidations = 0;
      let now = 0;
      let firstPhase = true;
      let nextReservationReached = false;
      const stop = new Error('Stopped after reservation and before staging.');
      const publisher = new FilePublisher({ root: dataRoot, guard: { held: true }, inspector,
        supervisor: { run: async () => { nativeCalls++; throw new Error('Unexpected native publication.'); } } as unknown as ProcessSupervisor,
        beforeWrite: (relative, deadline) => resources.beforeWrite(relative, deadline), bind: action => resources.bind(action),
        preflight: (target, bytes, profile, deadline) => resources.preflight(target, bytes, profile, deadline),
        preflightWithAdmission: (target, bytes, profile, admit, deadline) => resources.preflight(target, bytes, profile, deadline, admit),
        invalidate: () => { invalidations++; resources.invalidate(); } });
      const reserve = async (request: CodecReservation, deadline?: Deadline, admit?: AdmitPublicationScope) => {
        await resources.codec(request, deadline, admit);
        if (firstPhase && mode !== 'staging-collision') { now = 1000; }
        else if (!firstPhase) { nextReservationReached = true; throw stop; }
      };
      const codec = new PayloadCodec(publisher,
        (request, deadline) => reserve(request, deadline),
        mode === 'fallback-deadline' ? undefined : (request, admit, deadline) => reserve(request, deadline, admit));
      await resources.withTransition('release', async () => {
        await resources.reserve('release', { uncompactedEvents: 1 });
        const oldWork = resources.bind(async () => resources.assertReservation());
        const first = codec.createEvent('journal/events/0000000000000001.json', source, metadata(1), record.sequence,
          mode === 'staging-collision' ? undefined : Deadline.after(1000, () => now));
        if (mode === 'staging-collision') { await assert.rejects(first, { code: 'EEXIST' }); }
        else { await assert.rejects(first, DeadlineExceededError); }
        assert.equal(invalidations, 1, mode);
        assert.throws(() => resources.assertReservation(), RuntimeCapacityError);
        await resources.reserve('release', { uncompactedEvents: 1 });
        await assert.rejects(oldWork(), RuntimeCapacityError);
        await resources.reserve('release', { uncompactedEvents: 1 });
        firstPhase = false;
        await assert.rejects(codec.createEvent('journal/events/0000000000000002.json', source, metadata(2), record.sequence), error => error === stop);
        assert.equal(nextReservationReached, true);
      });
      assert.equal(nativeCalls, 0);
      assert.deepEqual((await fs.readdir(events)).filter(name => name.endsWith('.json')), []);
    }
  } finally { await fixture.close(); }
});
