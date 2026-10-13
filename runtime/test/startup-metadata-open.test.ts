import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from '../src/admission.ts';
import { SupervisorError, type ProcessSupervisor } from '../src/process.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { StartupMetadataSession } from '../src/startup-metadata.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));

async function privateScope(): Promise<{ scope: RuntimeScope; inspector: PathInspector; close(): Promise<void> }> {
  const dataRoot = path.join(repository, '.tmp', `startup-worker-${randomUUID()}`);
  await fs.mkdir(dataRoot);
  const scopePath = path.join(dataRoot, 'scope.json');
  const bytes = Buffer.from('{}');
  await fs.writeFile(scopePath, bytes);
  const inspector = {
    inspect: async () => ({ exists: true, kind: 'directory' }),
    inspectMany: async (_root: string, targets: readonly string[]) => targets.map(target => ({ path: target, exists: true,
      kind: 'file', links: 1, volume: 'private', identity: target, missing: [] })),
  } as unknown as PathInspector;
  return {
    scope: { companionRoot: repository, dataRoot, bindingSha256: createHash('sha256').update(bytes).digest('hex') } as RuntimeScope,
    inspector,
    async close() {
      if (path.dirname(dataRoot) !== path.join(repository, '.tmp')) { throw new Error('Private worker scope escaped the repository.'); }
      await fs.unlink(scopePath);
      await fs.rmdir(dataRoot);
    },
  };
}

function ownedChild(ready: Promise<unknown>) {
  void ready.catch(() => undefined);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  return { stdout, stderr, ready, terminated: new Promise(() => {}), brokerClosed: false, stdin: new PassThrough(),
    kill: () => { killed = true; return true; }, killed: () => killed };
}

test('verified broker launch absence falls back before a worker identity exists', async () => {
  const fixture = await privateScope();
  let stops = 0;
  const child = ownedChild(Promise.reject(new SupervisorError('abnormal-exit', 'Broker did not launch.')));
  const supervisor = {
    spawn: () => child,
    stop: async () => { stops += 1; },
  } as unknown as ProcessSupervisor;
  try {
    assert.equal(await StartupMetadataSession.open(fixture.inspector, supervisor, fixture.scope), null);
    assert.equal(stops, 1);
    assert.equal(child.killed(), true);
  } finally { await fixture.close(); }
});

test('a mismatched startup handshake refuses the worker after verified stop', async () => {
  const fixture = await privateScope();
  let stops = 0;
  const child = ownedChild(Promise.resolve({ pid: 1, created: '1' }));
  const supervisor = {
    spawn: () => {
      queueMicrotask(() => {
        const body = Buffer.from(JSON.stringify({ version: 1, nonce: '0'.repeat(32), scopeSha256: '0'.repeat(64), sourceSha256: '0'.repeat(64) }));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        child.stdout.write(Buffer.concat([header, body]));
      });
      return child;
    },
    stop: async () => { stops += 1; },
  } as unknown as ProcessSupervisor;
  try {
    await assert.rejects(StartupMetadataSession.open(fixture.inspector, supervisor, fixture.scope), DataRootUnavailableError);
    assert.equal(stops, 1);
    assert.equal(child.killed(), true);
  } finally { await fixture.close(); }
});

test('unverified launch termination never selects one-shot fallback', async () => {
  const fixture = await privateScope();
  const child = ownedChild(Promise.reject(new SupervisorError('abnormal-exit', 'Broker did not launch.')));
  const supervisor = {
    spawn: () => child,
    stop: async () => { throw new SupervisorError('termination-unverified', 'Process termination is unknown.'); },
  } as unknown as ProcessSupervisor;
  try {
    await assert.rejects(StartupMetadataSession.open(fixture.inspector, supervisor, fixture.scope),
      (error: unknown) => error instanceof SupervisorError && error.reason === 'termination-unverified');
  } finally { await fixture.close(); }
});

test('a broker that never reports identity is stopped within the handshake deadline', async () => {
  const fixture = await privateScope();
  let stops = 0;
  const child = ownedChild(new Promise(() => {}));
  const supervisor = {
    spawn: () => child,
    stop: async () => { stops += 1; },
  } as unknown as ProcessSupervisor;
  try {
    await assert.rejects(StartupMetadataSession.open(fixture.inspector, supervisor, fixture.scope, 10), DataRootUnavailableError);
    assert.equal(stops, 1);
    assert.equal(child.killed(), true);
  } finally { await fixture.close(); }
});
