import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PathInspector } from '../src/admission.ts';
import { RuntimeCapacityError } from '../src/capacity.ts';
import type { OperationStore } from '../src/operations.ts';
import { ResourceAuthority } from '../src/resource-lifecycle/resources.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { bytesHash } from '../src/storage.ts';
import { createTestNative } from './support/native-helper.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const eventFixture = path.join(repository, 'runtime', 'native', 'helper', 'internal', 'events', 'testdata', 'event-created.json');

/** The committed event with its payload padded past the size given, and its payload binding recomputed to stay valid. */
async function paddedEvent(padding: number): Promise<Buffer> {
  const original = (await fs.readFile(eventFixture, 'utf8')).trimEnd();
  const padded = original.replace('"extra":{', `"extra":{"padding":"${'x'.repeat(padding)}",`);
  const record = /"recordSha256":"([0-9a-f]{64})"/.exec(padded)![1]!;
  const payload = padded.slice(padded.indexOf('"payload":') + '"payload":'.length, -1);
  const binding = createHash('sha256').update(`companion-core-payload-v1\n${record}\n`).update(payload).digest('hex');

  return Buffer.from(padded.replace(/"payloadBindingSha256":"[0-9a-f]{64}"/, `"payloadBindingSha256":"${binding}"`), 'utf8');
}

test('admits a state-event document larger than the request frame through a staged Event-mode input', { timeout: 120000 }, async () => {
  // Arrange: a scope under the repository, a valid event over 2 MiB and a copy whose payload no longer matches its binding.
  const root = path.join(repository, '.tmp', `event-admission-${randomUUID()}`);
  const dataRoot = path.join(root, 'data');
  const events = path.join(dataRoot, 'journal', 'events');
  await fs.mkdir(events, { recursive: true });
  const binding = Buffer.from(JSON.stringify({ runtimeScopeVersion: 1, game: 'game', principal: 'principal' }));
  await fs.writeFile(path.join(dataRoot, 'scope.json'), binding);
  const scope = { dataRoot, companionRoot: root, bindingSha256: bytesHash(binding), game: 'game', principal: 'principal' } as RuntimeScope;
  const native = await createTestNative(root);
  const large = await paddedEvent(2_500_000);
  const damaged = Buffer.from(large.toString('utf8').replace('"padding":"x', '"padding":"y'), 'utf8');
  try {
    const resources = new ResourceAuthority(scope, new PathInspector(native.supervisor), {} as OperationStore);
    resources.inventory = async () => ({ complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 },
      potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0, freeBytes: 4000000000n, uncertainWorkspace: false });

    // Act and assert: the large valid event is admitted, and the damaged one is refused as capacity.
    await resources.withTransition('release', async () => {
      await resources.reserve('release', { uncompactedEvents: 2 });
      await resources.preflight(path.join(events, '0000000000000001.json'), large, 'state-event');
    });
    await resources.withTransition('release', async () => {
      await resources.reserve('release', { uncompactedEvents: 2 });
      await assert.rejects(resources.preflight(path.join(events, '0000000000000002.json'), damaged, 'state-event'), RuntimeCapacityError);
    });

    // Assert: the large document exceeded the frame, and no staging file was left beside the targets.
    assert.ok(large.length > 2_097_152);
    assert.deepEqual(await fs.readdir(events), []);
  } finally {
    await native.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
