import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import type { PayloadCodec } from '../src/codec.ts';
import { Deadline, DeadlineExceededError } from '../src/deadline.ts';
import { FilePublisher } from '../src/files.ts';
import type { ProcessIdentities } from '../src/identity.ts';
import { Journal } from '../src/journal.ts';
import type { ProcessSupervisor } from '../src/process.ts';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('deadline admission across queues', () => {
  it('does not stage or launch a publication after its queue consumed the allowance', async () => {
    const gate = barrier();
    let inspected = 0;
    let started = 0;
    const publisher = new FilePublisher({ root: 'C:/unopened-fixture', guard: { held: true },
      inspector: { inspectMany: async () => { inspected++; throw new Error('Unexpected inspection'); } } as unknown as PathInspector,
      supervisor: { run: async () => { started++; throw new Error('Unexpected child'); } } as unknown as ProcessSupervisor,
      preflight: async () => { throw new Error('Unexpected staging preflight'); }, invalidate: () => {} });
    const predecessor = publisher.exclusive(() => gate.promise);
    let now = 0;
    const pending = publisher.publishJson('pending.json', { pending: true }, false, Deadline.after(1000, () => now));
    const rejected = assert.rejects(pending, DeadlineExceededError);
    now = 1000;
    gate.release();
    await predecessor;
    await rejected;
    assert.equal(inspected, 0);
    assert.equal(started, 0);
    assert.equal(publisher.blocked, false);
  });

  it('does not begin journal inspection after waiting behind another read', async () => {
    const gate = barrier();
    let inspected = 0;
    const inspector = { inspectMany: async () => { inspected++; await gate.promise; throw new Error('Fixture observation unavailable'); } } as unknown as PathInspector;
    const journal = new Journal({ root: 'C:/unopened-fixture', game: 'game', principal: 'principal', inspector,
      identities: {} as ProcessIdentities, publisher: {} as FilePublisher, codec: {} as PayloadCodec,
      admitMutation: async () => {}, eventIdAvailable: async () => true });
    const predecessor = assert.rejects(journal.read(), /Fixture observation unavailable/);
    let now = 0;
    const pending = assert.rejects(journal.read(Deadline.after(1000, () => now)), DeadlineExceededError);
    now = 1000;
    gate.release();
    await predecessor;
    await pending;
    assert.equal(inspected, 1);
  });
});
