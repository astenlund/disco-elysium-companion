import assert from 'node:assert/strict';
import test from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import type { RuntimeScope } from '../src/scope.ts';
import type { StartupCoreReplySession } from '../src/startup-core-reply.ts';
import { StartupMetadataSession } from '../src/startup-metadata.ts';
import type { StartupMutationSession } from '../src/startup-mutation.ts';
import { StartupWorkerGroup } from '../src/startup-workers.ts';

const scope = { companionRoot: 'C:/private', dataRoot: 'C:/private/data', bindingSha256: 'a'.repeat(64) } as RuntimeScope;
const evidence = { scopeSha256: scope.bindingSha256, metadataSha256: 'b'.repeat(64),
  coreReplySha256: 'c'.repeat(64), mutationSha256: 'd'.repeat(64) };
const inspector = {} as PathInspector;
const supervisor = {} as ProcessSupervisor;

test('detached metadata opener retains its verified launch fallback', async () => {
  let verified = false;
  const owned = { spawn: () => { throw new Error('Broker launch unavailable.'); },
    verifyQuiescent: async () => { verified = true; } } as unknown as ProcessSupervisor;
  const prepare = StartupMetadataSession.prepareWithEvidence;
  const launch = prepare(owned, scope, evidence);
  assert.equal(await launch(), null);
  assert.equal(verified, true);
});

test('absent source evidence does not launch any startup worker', async () => {
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope, {
    observe: async () => null,
    metadata: () => { throw new Error('Metadata launched after absent evidence.'); },
    coreReply: async () => { throw new Error('Core reply launched after absent evidence.'); },
    mutation: async () => { throw new Error('Mutation launched after absent evidence.'); },
  });
  assert.equal(plan, null);
});

test('partial launch failure closes every worker that opened', async () => {
  const closed: string[] = [];
  const failure = new Error('Core reply source changed.');
  const metadata = { async close() { closed.push('metadata'); } } as unknown as StartupMetadataSession;
  const mutation = { async close() { closed.push('mutation'); } } as unknown as StartupMutationSession;
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope, {
    observe: async () => evidence,
    metadata: () => async () => metadata,
    coreReply: async () => { throw failure; },
    mutation: async () => mutation,
  });
  assert.ok(plan);
  await assert.rejects(plan(), caught => caught === failure);
  assert.deepEqual(closed.sort(), ['metadata', 'mutation']);
});

test('successful group closes its three roles once and rejects a second launch', async () => {
  const closed: string[] = [];
  const metadata = { async close() { closed.push('metadata'); } } as unknown as StartupMetadataSession;
  const core = { async close() { closed.push('core'); } } as unknown as StartupCoreReplySession;
  const mutation = { async close() { closed.push('mutation'); } } as unknown as StartupMutationSession;
  const plan = await StartupWorkerGroup.prepare(inspector, supervisor, scope, {
    observe: async () => evidence,
    metadata: () => async () => metadata,
    coreReply: async () => core,
    mutation: async () => mutation,
  });
  assert.ok(plan);
  const group = await plan();
  assert.ok(group);
  assert.equal(group.metadata, metadata);
  assert.equal(group.coreReply, core);
  assert.equal(group.mutation, mutation);
  await assert.rejects(plan());
  await group.close();
  await group.close();
  assert.deepEqual(closed.sort(), ['core', 'metadata', 'mutation']);
});
