import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NativeHelperUnavailableError } from '../src/native-helper-error.ts';
import { boundServiceOwner, HelperRequestFailedError, NativeHelper, type ServiceSpawn } from '../src/native-helper.ts';
import { observeImageFile, type HelperImage } from '../src/native-image.ts';
import type { FakeAction, FakeScenario } from './support/fake-helper-service.ts';
import { testHelperImage } from './support/native-helper.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fakeService = fileURLToPath(new URL('./support/fake-helper-service.ts', import.meta.url));
const binding = { token: '1'.repeat(32), companionRoot: 'C:\\companion', dataRoot: 'C:\\companion\\data' };

type Launch = Partial<Pick<FakeScenario, 'hello' | 'maxSeq'>> & { readonly ops?: Readonly<Record<string, readonly FakeAction[]>> };
interface LoggedRequest { readonly pid: number; readonly op: string; readonly seq: number; readonly deadlineMs: number; readonly owner: { readonly pid: number } | null }

/** A fake image file and a launcher that starts one scripted service per launch, in the order given. */
async function fakeHelper(launches: readonly Launch[]) {
  const scratch = path.join(repository, '.tmp', `native-helper-${randomUUID()}`);
  await fs.mkdir(scratch, { recursive: true });
  const imagePath = path.join(scratch, 'companion-helper.exe');
  await fs.writeFile(imagePath, 'fake helper image');
  const observed = observeImageFile(imagePath)!;
  const image: HelperImage = { path: imagePath, sha256: observed.sha256, volume: observed.volume, fileId: observed.fileId };
  const log = path.join(scratch, 'requests.log');
  await fs.writeFile(log, '');
  const children: ChildProcessWithoutNullStreams[] = [];
  const launcher: ServiceSpawn = (_image, nonce, _companionRoot) => {
    const launch = launches[children.length] ?? {};
    const scenario: FakeScenario = { sha256: observed.sha256, volume: observed.volume, fileId: observed.fileId, created: '1234567', log, ...launch };
    const child = spawn(process.execPath, [fakeService, nonce], { env: { ...process.env, FAKE_HELPER_SCENARIO: JSON.stringify(scenario) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  };
  return {
    image, launcher, children,
    start: (sequenceLimit?: number) => NativeHelper.start(image, repository, sequenceLimit, launcher),
    requests: async (): Promise<LoggedRequest[]> => (await fs.readFile(log, 'utf8')).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as LoggedRequest),
    close: async () => {
      for (const child of children) { if (child.exitCode === null && child.signalCode === null) { child.kill(); } }
      await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}

const exited = (child: ChildProcessWithoutNullStreams): boolean => child.exitCode !== null || child.signalCode !== null;
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!await condition()) {
    if (performance.now() > deadline) { throw new Error('Condition not reached.'); }
    await pause(20);
  }
}

async function rejectsUnavailable(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, error => error instanceof NativeHelperUnavailableError);
}

describe('native helper service client', () => {
  it('renews a bound service at the sequence bound, rebinds before a mutation and keeps the single failure restart', { timeout: 60000 }, async () => {
    // Arrange: the second service fails its first read after renewal; the third fails its second read.
    const fake = await fakeHelper([{}, { ops: { hash: [{ kind: 'exit' }] } }, { ops: { hash: [{ kind: 'ok' }, { kind: 'exit' }] } }]);
    try {
      const helper = await fake.start(4);
      await helper.bind(binding);
      for (let index = 0; index < 3; index++) { assert.equal((await helper.request('hash', {}, 5000)).status, 'ok'); }

      // Act: the fifth request exceeds the bound, renews the service and publishes on the renewed one.
      const published = await helper.request('publish', {}, 5000);

      // Assert: renewal stopped the first service, rebound the scope on the second and served the mutation there.
      assert.equal(published.status, 'ok');
      assert.equal(fake.children.length, 2);
      assert.ok(exited(fake.children[0]!));
      const renewed = (await fake.requests()).filter(request => request.pid === fake.children[1]!.pid).map(request => request.op);
      assert.deepEqual(renewed, ['jobStates', 'bindScope', 'publish']);

      // Act and assert: a crash after renewal still has its one restart, and the replacement serves the next request.
      await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
      assert.equal((await helper.request('hash', {}, 5000)).status, 'ok');
      assert.equal(fake.children.length, 3);

      // Act and assert: a second failure exhausts the helper; later requests and broker launches are refused.
      await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
      await rejectsUnavailable(helper.request('hash', {}, 5000));
      assert.throws(() => helper.brokerImage(), NativeHelperUnavailableError);
      assert.equal(fake.children.length, 3);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('holds proofs that overlap a request in flight at the sequence bound and renews without spending the restart', { timeout: 60000 }, async () => {
    // Arrange: each service fails closed past sequence 4, as the real service does past its bound, and the first answers
    // its fourth request slowly, so proofs and an ordinary request arrive while that request is in flight at the bound.
    const fake = await fakeHelper([
      { maxSeq: 4, ops: { hash: [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }, { kind: 'ok', delayMs: 500 }] } },
      { maxSeq: 4, ops: { eventBatch: [{ kind: 'exit' }] } },
      {},
    ]);
    try {
      const helper = await fake.start(4);
      for (let index = 0; index < 3; index++) { assert.equal((await helper.request('hash', {}, 5000)).status, 'ok'); }
      const slow = helper.request('hash', {}, 5000);
      await until(async () => (await fake.requests()).length === 4);

      // Act
      const replies = await Promise.all([slow, helper.request('processIdentity', { pid: process.pid }, 5000),
        helper.request('jobStates', { names: ['proof'], owner: null }, 5000), helper.request('hash', {}, 5000)]);

      // Assert: every request succeeded, the first service never saw a sequence past the bound and exited cleanly on
      // renewal, and the overlapping requests ran on the renewed service.
      assert.ok(replies.every(reply => reply.status === 'ok'));
      const logged = await fake.requests();
      assert.ok(logged.filter(request => request.pid === fake.children[0]!.pid).every(request => request.seq <= 4));
      assert.equal(fake.children[0]!.exitCode, 0);
      assert.equal(fake.children.length, 2);
      assert.equal(logged.filter(request => request.pid === fake.children[1]!.pid).length, 3);

      // Act and assert: the renewal left the single failure restart, so a crash of the renewed service is replaced once.
      await assert.rejects(helper.request('eventBatch', {}, 5000), HelperRequestFailedError);
      assert.equal((await helper.request('hash', {}, 5000)).status, 'ok');
      assert.equal(fake.children.length, 3);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('binds the replacement of a service that fails just before binding, after proving its helper job absent', { timeout: 60000 }, async () => {
    // Arrange: the first service crashes on its first read, which the start sends just before it binds.
    const fake = await fakeHelper([{ ops: { hash: [{ kind: 'exit' }] } }, {}]);
    try {
      const helper = await fake.start();
      const failed = helper.request('hash', {}, 5000);

      // Act: bind while the crashed service is being replaced.
      await assert.rejects(failed, HelperRequestFailedError);
      await helper.bind(binding);

      // Assert: the replacement proved the helper job absent and was bound, and it serves a mutation.
      assert.equal(helper.bound, true);
      assert.equal(fake.children.length, 2);
      assert.equal((await helper.request('publish', {}, 5000)).status, 'ok');
      const replacement = (await fake.requests()).filter(request => request.pid === fake.children[1]!.pid).map(request => request.op);
      assert.deepEqual(replacement, ['jobStates', 'bindScope', 'publish']);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('binds the replacement of a service that fails while binding, and refuses as unavailable once the restart is spent', { timeout: 60000 }, async () => {
    // Arrange: the first service crashes on bindScope; in the second fixture both services do.
    const recovering = await fakeHelper([{ ops: { bindScope: [{ kind: 'exit' }] } }, {}]);
    const exhausting = await fakeHelper([{ ops: { bindScope: [{ kind: 'exit' }] } }, { ops: { bindScope: [{ kind: 'exit' }] } }]);
    try {
      const helper = await recovering.start();
      const exhausted = await exhausting.start();

      // Act
      await helper.bind(binding);
      const refused = exhausted.bind(binding);

      // Assert
      assert.equal(helper.bound, true);
      assert.deepEqual((await recovering.requests()).filter(request => request.pid === recovering.children[1]!.pid).map(request => request.op), ['jobStates', 'bindScope']);
      await assert.rejects(refused, error => error instanceof NativeHelperUnavailableError && error.reason === 'unavailable');
      assert.equal(exhausted.bound, false);
      await helper.close();
      await exhausted.close();
    } finally {
      await recovering.close();
      await exhausting.close();
    }
  });

  it('drives one real service through more than 8,192 requests, whose sequence it checks, without renewal', { timeout: 300000 }, async () => {
    // Arrange
    const helper = await NativeHelper.start(await testHelperImage(), repository);
    try {
      await helper.verifyLive();

      // Act
      for (let batch = 0; batch < 82; batch++) {
        const replies = await Promise.all(Array.from({ length: 100 }, () => helper.request('processIdentity', { pid: process.pid }, 30000)));
        assert.ok(replies.every(reply => reply.status === 'ok'));
      }

      // Assert: the service that answered the first request still answers its liveness check, so it was never replaced.
      await helper.verifyLive();
    } finally { await helper.close(); }
  });

  for (const fault of ['oversize', 'malformed', 'badStatus', 'stderr'] as const) {
    it(`stops the service on a ${fault} reply, uses the restart and exhausts on the next fault`, { timeout: 60000 }, async () => {
      // Arrange
      const fake = await fakeHelper([{ ops: { hash: [{ kind: fault }] } }, { ops: { hash: [{ kind: 'ok' }, { kind: fault }] } }]);
      try {
        const helper = await fake.start();

        // Act
        const failed = helper.request('hash', {}, 5000);

        // Assert
        await assert.rejects(failed, error => error instanceof HelperRequestFailedError && error.kind === 'fault');
        assert.equal((await helper.request('hash', {}, 5000)).status, 'ok');
        assert.equal(fake.children.length, 2);
        await until(() => exited(fake.children[0]!));
        await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
        await rejectsUnavailable(helper.request('hash', {}, 5000));
        await helper.close();
      } finally { await fake.close(); }
    });
  }

  for (const [name, hello, reason] of [
    ['a wrong nonce', { nonce: 'f'.repeat(32) }, 'serviceStart'],
    ['a wrong pid', { pidOffset: 1 }, 'serviceStart'],
    ['a malformed created value', { created: 'soon' }, 'serviceStart'],
    ['a stderr byte', { stderr: true }, 'serviceStart'],
    ['a held-image identity that differs from the prelaunch observation', { fileId: '1' }, 'imageIdentityMismatch'],
  ] as const) {
    it(`refuses a handshake with ${name}, at start and as the replacement that spends the restart`, { timeout: 60000 }, async () => {
      // Arrange
      const atStart = await fakeHelper([{ hello }]);
      const atRestart = await fakeHelper([{ ops: { hash: [{ kind: 'exit' }] } }, { hello }]);
      try {
        // Act and assert: a failed first handshake refuses the start and stops the process.
        await assert.rejects(atStart.start(), error => error instanceof NativeHelperUnavailableError && error.reason === reason);
        await until(() => exited(atStart.children[0]!));

        // Act and assert: a failed replacement handshake leaves the helper exhausted.
        const helper = await atRestart.start();
        await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
        await rejectsUnavailable(helper.request('hash', {}, 5000));
        assert.equal(atRestart.children.length, 2);
        await until(() => exited(atRestart.children[1]!));
        await helper.close();
      } finally { await atStart.close(); await atRestart.close(); }
    });
  }

  it('answers a proof failed by its service on the replacement and reports a failed mutation only after the exit', { timeout: 60000 }, async () => {
    // Arrange
    const fake = await fakeHelper([{ ops: { jobStates: [{ kind: 'exit', delayMs: 100 }] } }, { ops: { publish: [{ kind: 'exit', delayMs: 100 }] } }]);
    try {
      const helper = await fake.start();

      // Act
      const proof = await helper.request('jobStates', { names: ['job'], owner: null }, 10000);

      // Assert: the proof was sent once more, to the replacement, which answered it.
      assert.equal(proof.status, 'ok');
      const proofs = (await fake.requests()).filter(request => request.op === 'jobStates');
      assert.deepEqual(proofs.map(request => request.pid), [fake.children[0]!.pid, fake.children[1]!.pid]);

      // Act and assert: the mutation's failure carries the observed exit of its service.
      await assert.rejects(helper.request('publish', {}, 10000), error => error instanceof HelperRequestFailedError && error.exitObserved === true);
      assert.ok(exited(fake.children[1]!));
      await helper.close();
    } finally { await fake.close(); }
  });

  it('fails a missed request alone, accepts slow peers and proofs during the drain, discards the late reply and then replaces the service', { timeout: 60000 }, async () => {
    // Arrange: the read misses its deadline plus grace, its reply arrives during the drain, and a slow publish answers after it.
    const fake = await fakeHelper([{ ops: { hash: [{ kind: 'ok', delayMs: 6000 }], publish: [{ kind: 'ok', delayMs: 7500 }] } }, { ops: { codec: [{ kind: 'exit' }] } }]);
    try {
      const helper = await fake.start();
      const publishing = helper.request('publish', {}, 30000);
      const missed = helper.request('hash', {}, 300);

      // Act
      await assert.rejects(missed, error => error instanceof HelperRequestFailedError && error.kind === 'missed');
      const proof = await helper.request('processIdentity', { pid: 1 }, 2000);
      const queued = helper.request('codec', {}, 30000);
      const published = await publishing;

      // Assert: the proof ran on the draining service, the publish completed, and the queued request waited for the replacement.
      assert.equal(proof.status, 'ok');
      assert.equal(published.status, 'ok');
      await assert.rejects(queued, HelperRequestFailedError);
      const byOp = new Map((await fake.requests()).map(request => [request.op, request.pid]));
      assert.equal(byOp.get('processIdentity'), fake.children[0]!.pid);
      assert.equal(byOp.get('codec'), fake.children[1]!.pid);
      assert.ok(exited(fake.children[0]!));

      // Assert: the drain spent the single restart, so the replacement's failure exhausts the helper.
      await rejectsUnavailable(helper.request('hash', {}, 5000));
      await helper.close();
    } finally { await fake.close(); }
  });

  it('refuses near-expiry requests locally or by reply without stopping the service or spending the restart', { timeout: 60000 }, async () => {
    // Arrange
    const fake = await fakeHelper([{ ops: { publish: [{ kind: 'error', code: 'deadlineExceeded' }], hash: [{ kind: 'exit' }] } }]);
    try {
      const helper = await fake.start();

      // Act
      const local = await helper.request('hash', {}, 200);
      const remote = await helper.request('publish', {}, 400);

      // Assert: the first was never sent; the second was refused by the service, which keeps running.
      assert.deepEqual(local, { status: 'error', code: 'deadlineExceeded' });
      assert.deepEqual(remote, { status: 'error', code: 'deadlineExceeded' });
      assert.deepEqual((await fake.requests()).map(request => request.op), ['publish']);
      assert.equal(fake.children.length, 1);
      assert.ok(!exited(fake.children[0]!));

      // Act and assert: the restart is still available.
      await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
      assert.equal((await helper.request('hash', {}, 5000)).status, 'ok');
      assert.equal(fake.children.length, 2);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('keeps four slots for proofs while twelve ordinary requests are in flight', { timeout: 60000 }, async () => {
    // Arrange
    const fake = await fakeHelper([{ ops: { hash: Array.from({ length: 12 }, () => ({ kind: 'ok', delayMs: 2000 }) as const) } }]);
    try {
      const helper = await fake.start();
      const ordinary = Array.from({ length: 12 }, () => helper.request('hash', {}, 10000));
      await until(async () => (await fake.requests()).length === 12);

      // Act
      const thirteenth = await helper.request('codec', {}, 600);
      const proofs = await Promise.all(Array.from({ length: 4 }, () => helper.request('processIdentity', { pid: 1 }, 1500)));

      // Assert
      assert.deepEqual(thirteenth, { status: 'error', code: 'deadlineExceeded' });
      assert.ok(proofs.every(reply => reply.status === 'ok'));
      assert.ok((await Promise.all(ordinary)).every(reply => reply.status === 'ok'));
      assert.ok(!(await fake.requests()).some(request => request.op === 'codec'));
      await helper.close();
    } finally { await fake.close(); }
  });

  it('attests the broker image inside the restart window only after re-verifying it', { timeout: 60000 }, async () => {
    // Arrange: the replacement handshake is delayed, holding the restart window open.
    const fake = await fakeHelper([{ ops: { hash: [{ kind: 'exit' }] } }, { hello: { delayMs: 2000 } }]);
    try {
      const helper = await fake.start();
      assert.equal(helper.brokerImage(), fake.image.path);
      await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
      await until(() => fake.children.length === 2);

      // Act and assert: an unchanged image is attested; a changed one is refused.
      assert.equal(helper.brokerImage(), fake.image.path);
      await fs.writeFile(fake.image.path, 'changed helper image');
      assert.throws(() => helper.brokerImage(), NativeHelperUnavailableError);

      // Act and assert: the verified replacement holds its image again.
      assert.equal((await helper.request('hash', {}, 10000)).status, 'ok');
      assert.equal(helper.brokerImage(), fake.image.path);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('retires a live service after a mutation misses its deadline, reporting the failure only after the observed exit', { timeout: 60000 }, async () => {
    // Arrange: the publish reply comes after its deadline plus grace while the service stays alive.
    const fake = await fakeHelper([{ ops: { publish: [{ kind: 'ok', delayMs: 6000 }] } }, {}]);
    try {
      const helper = await fake.start();

      // Act
      const missed = helper.request('publish', {}, 300);

      // Assert: the request fails alone, the drain completes, the exit is observed and the replacement serves.
      await assert.rejects(missed, error => error instanceof HelperRequestFailedError && error.kind === 'missed' && error.exitObserved === true);
      assert.ok(exited(fake.children[0]!));
      assert.equal((await helper.request('publish', {}, 5000)).status, 'ok');
      assert.equal(fake.children.length, 2);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('keeps a missed request in the service slot count while proofs use the draining service', { timeout: 60000 }, async () => {
    // Arrange: a slow peer holds the drain open, a read that never replies holds one service slot, and proofs answer slowly.
    const fake = await fakeHelper([{ ops: { codec: [{ kind: 'ok', delayMs: 9000 }], hash: [{ kind: 'hang' }], processIdentity: Array.from({ length: 16 }, () => ({ kind: 'ok', delayMs: 2500 }) as const) } }, {}]);
    try {
      const helper = await fake.start();
      const peer = helper.request('codec', {}, 30000);
      await assert.rejects(helper.request('hash', {}, 300), error => error instanceof HelperRequestFailedError && error.kind === 'missed');

      // Act: sixteen proofs arrive at the draining service.
      const proofs = Array.from({ length: 16 }, () => helper.request('processIdentity', { pid: 1 }, 4000));
      await pause(800);

      // Assert: only fourteen were sent while the peer and the missed request held their slots.
      const firstService = fake.children[0]!.pid;
      assert.equal((await fake.requests()).filter(request => request.op === 'processIdentity' && request.pid === firstService).length, 14);
      const replies = await Promise.all(proofs);
      assert.equal(replies.filter(reply => reply.status === 'ok').length + replies.filter(reply => reply.status === 'error').length, 16);
      assert.equal((await peer).status, 'ok');
      await helper.close();
    } finally { await fake.close(); }
  });

  it('stops a replacement that finishes launching after close began, before close resolves', { timeout: 60000 }, async () => {
    // Arrange: the replacement handshake is delayed so close lands inside the restart window.
    const fake = await fakeHelper([{ ops: { hash: [{ kind: 'exit' }] } }, { hello: { delayMs: 1500 } }]);
    try {
      const helper = await fake.start();
      await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
      await until(() => fake.children.length === 2);

      // Act
      await helper.close();

      // Assert: no service this helper started is still running.
      assert.ok(fake.children.every(child => exited(child)));
    } finally { await fake.close(); }
  });

  it('refuses a prelaunch image that is absent or fails its pin with the image reasons', { timeout: 60000 }, async () => {
    // Arrange
    const fake = await fakeHelper([{}]);
    try {
      // Act and assert
      await assert.rejects(NativeHelper.start({ ...fake.image, sha256: '0'.repeat(64) }, repository, undefined, fake.launcher),
        error => error instanceof NativeHelperUnavailableError && error.reason === 'imagePinMismatch');
      await assert.rejects(NativeHelper.start({ ...fake.image, path: `${fake.image.path}.absent` }, repository, undefined, fake.launcher),
        error => error instanceof NativeHelperUnavailableError && error.reason === 'imageAbsent');
      assert.equal(fake.children.length, 0);
    } finally { await fake.close(); }
  });

  it('serves an owned job observation during the restart window, naming the replacement that serves it', { timeout: 60000 }, async () => {
    // Arrange: a bound service fails, and its replacement's handshake is delayed so the observation arrives in the window.
    const fake = await fakeHelper([{ ops: { hash: [{ kind: 'exit' }] } }, { hello: { delayMs: 1500 } }]);
    try {
      const helper = await fake.start();
      await helper.bind(binding);
      await assert.rejects(helper.request('hash', {}, 5000), HelperRequestFailedError);
      await until(() => fake.children.length === 2);

      // Act
      const observed = await helper.request('jobStates', { names: ['job'], owner: boundServiceOwner }, 10000);

      // Assert: the observation waited for the rebound replacement and named it as the owner.
      assert.equal(observed.status, 'ok');
      const owned = (await fake.requests()).filter(request => request.op === 'jobStates' && request.owner !== null);
      assert.equal(owned.length, 1);
      assert.equal(owned[0]!.pid, fake.children[1]!.pid);
      assert.equal(owned[0]!.owner!.pid, fake.children[1]!.pid);
      await helper.close();
    } finally { await fake.close(); }
  });

  it('faults the service on a malformed late reply, failing a peer still in flight', { timeout: 60000 }, async () => {
    // Arrange: a read misses its deadline, its late reply carries an invalid status, and a slow peer is still in flight.
    const fake = await fakeHelper([{ ops: { hash: [{ kind: 'badStatus', delayMs: 6000 }], codec: [{ kind: 'ok', delayMs: 9000 }] } }, {}]);
    try {
      const helper = await fake.start();
      const peer = helper.request('codec', {}, 30000);
      await assert.rejects(helper.request('hash', {}, 300), error => error instanceof HelperRequestFailedError && error.kind === 'missed');

      // Act and assert: the invalid late reply is validated, not discarded, so the service faults and the peer fails.
      await assert.rejects(peer, error => error instanceof HelperRequestFailedError && error.kind === 'fault' && error.exitObserved === true);
      assert.ok(exited(fake.children[0]!));
      await helper.close();
    } finally { await fake.close(); }
  });

  it('checks liveness against the handshake identity and observes the exit on close', { timeout: 60000 }, async () => {
    // Arrange
    const fake = await fakeHelper([{ ops: { processIdentity: [{ kind: 'ok' }, { kind: 'ok', result: { exists: true, pid: 1, created: '7654321' } }] } }]);
    try {
      const helper = await fake.start();

      // Act and assert
      await helper.verifyLive();
      await rejectsUnavailable(helper.verifyLive());
      await helper.close();
      assert.ok(exited(fake.children[0]!));
      await rejectsUnavailable(helper.request('hash', {}, 5000));
    } finally { await fake.close(); }
  });
});
