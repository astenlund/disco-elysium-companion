import assert from 'node:assert/strict';
import test from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import type { RuntimeScope } from '../src/scope.ts';
import type { StartupCoreReplySession } from '../src/startup-core-reply.ts';
import { StartupWorkerGroup } from '../src/startup-workers.ts';

const scope = { companionRoot: 'C:/private', dataRoot: 'C:/private/data', bindingSha256: 'a'.repeat(64) } as RuntimeScope;
const evidence = { scopeSha256: scope.bindingSha256, coreReplySha256: 'c'.repeat(64) };
const inspector = {} as Pick<PathInspector, 'native'>;
const supervisor = {} as ProcessSupervisor;

test('absent source evidence does not launch the core reply worker', async () => {
  // Arrange
  const openers = { observe: async () => null, coreReply: async () => { throw new Error('Core reply launched after absent evidence.'); } };

  // Act
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope, openers);

  // Assert
  assert.equal(plan, null);
});

test('the opener passes the observed core reply digest and a worker that did not open yields no group', async () => {
  // Arrange
  const digests: string[] = [];
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope,
    { observe: async () => evidence, coreReply: async (_supervisor, _scope, digest) => { digests.push(digest); return null; } });
  assert.ok(plan);

  // Act
  const group = await plan();

  // Assert
  assert.equal(group, null);
  assert.deepEqual(digests, [evidence.coreReplySha256]);
});

test('a successful group closes its worker once and rejects a second launch', async () => {
  // Arrange
  let closed = 0;
  const core = { async close() { closed++; } } as unknown as StartupCoreReplySession;
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope, { observe: async () => evidence, coreReply: async () => core });
  assert.ok(plan);

  // Act
  const group = await plan();
  const second = plan();
  await group?.close();
  await group?.close();

  // Assert
  assert.equal(group?.coreReply, core);
  await assert.rejects(second);
  assert.equal(closed, 1);
});

test('a worker opening failure propagates without a group', async () => {
  // Arrange
  const failure = new Error('Core reply source changed.');
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope, { observe: async () => evidence, coreReply: async () => { throw failure; } });
  assert.ok(plan);

  // Act and assert
  await assert.rejects(plan(), caught => caught === failure);
});
