import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';

import { PathInspector } from '../src/admission.ts';
import type { PayloadCodec } from '../src/codec.ts';
import { FilePublisher } from '../src/files.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { ProcessSupervisor } from '../src/process.ts';
import { RecoveryExecutor } from '../src/recovery-executor.ts';
import type { RecoveryAction } from '../src/recovery-manifest.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { bytesHash } from '../src/storage.ts';
import { companionFixture } from './support/companion.ts';

it('gates native carry deletion and recognizes its postimage after lost progress', { timeout: 120000 }, async () => {
  const fixture = await companionFixture();
  const supervisor = await ProcessSupervisor.create(fixture.root);
  const inspector = new PathInspector(supervisor);
  const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
  const publisher = new FilePublisher({ root: fixture.root, guard, inspector, supervisor, preflight: async () => {}, invalidate: () => {} });
  const binding = Buffer.from('{"privateRecoveryFixture":true}');
  const bytes = Buffer.from('hash-bound private carry');
  const target = path.join(fixture.root, 'journal', 'recovery-event.json');
  const scope: RuntimeScope = { companionRoot: fixture.root, dataRoot: fixture.root, game: 'stubgame', principal: 'principal', bindingSha256: bytesHash(binding), createdHere: false };
  let accepted = false;
  let owner = true;
  let mutations = 0;
  const executor = () => new RecoveryExecutor({ scope, inspector, publisher, codec: {} as PayloadCodec,
    admit: async () => { assert.equal(owner, true, 'A durable matching owner is always required.'); },
    authorizeMutation: async () => { mutations++; assert.equal(accepted, true, 'Current acceptance must authorize actual removal.'); },
    readPayloadSource: async () => { throw new Error('Removal never needs another payload.'); } });
  const action: RecoveryAction = { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: bytesHash(bytes), after: null } };
  try {
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(path.join(fixture.root, 'scope.json'), binding);
    await fs.writeFile(target, bytes);
    await assert.rejects(executor().execute(action), /Current acceptance/);
    assert.deepEqual(await fs.readFile(target), bytes);
    accepted = true;
    assert.equal(await executor().execute(action), 'applied');
    await assert.rejects(fs.readFile(target), { code: 'ENOENT' });
    accepted = false;
    const beforeRestart = mutations;
    assert.equal(await executor().execute(action), 'alreadyApplied');
    assert.equal(mutations, beforeRestart, 'Recognizing absence performs no new deletion.');
    owner = false;
    await assert.rejects(executor().execute(action), /durable matching owner/);
  } finally {
    await publisher.idle();
    await supervisor.verifyQuiescent('publication');
    await guard.release();
    await fixture.close();
  }
});
