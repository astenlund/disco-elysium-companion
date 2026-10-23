import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PathInspector } from '../src/admission.ts';
import { EventReader } from '../src/event-reader.ts';
import { eventFileName } from '../src/journal-records.ts';
import type { PayloadCodec } from '../src/codec.ts';
import { FilePublisher } from '../src/files.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { HelperRequestFailedError, NativeHelper } from '../src/native-helper.ts';
import { observeImageFile, type HelperImage } from '../src/native-image.ts';
import { ProcessSupervisor, SupervisorError } from '../src/process.ts';
import { RecoveryExecutor } from '../src/recovery-executor.ts';
import type { RecoveryAction } from '../src/recovery-manifest.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { bytesHash } from '../src/storage.ts';
import type { ProxyLaunch } from './support/helper-proxy.ts';
import { companionFixture } from './support/companion.ts';
import { createTestNative, helperProxies, testHelperImage, type HelperProxies } from './support/native-helper.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const childScript = fileURLToPath(new URL('./fixtures/process-child.ts', import.meta.url));
const childOptions = (mode: string, ...args: string[]) => ({ command: process.execPath, args: [childScript, mode, ...args], cwd: repository });
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });

/** A bound helper whose service launches run behind proxies, with a supervisor, guard and publisher for one fixture scope. */
async function faultHarness(launches: readonly ProxyLaunch[], image?: HelperImage) {
  const fixture = await companionFixture();
  const scratch = path.join(repository, '.tmp', `native-faults-${randomUUID()}`);
  await fs.mkdir(scratch, { recursive: true });
  const proxies: HelperProxies = await helperProxies(path.join(scratch, 'proxy.log'), launches);
  const helper = await NativeHelper.start(image ?? await testHelperImage(), fixture.root, undefined, proxies.launcher);
  const supervisor = await ProcessSupervisor.create(fixture.root, helper);
  await supervisor.proveBindable();
  await helper.bind({ token: supervisor.scopeToken, companionRoot: fixture.root, dataRoot: fixture.root });
  const inspector = new PathInspector(supervisor);
  const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
  const publisher = new FilePublisher({ root: fixture.root, guard, inspector, supervisor, preflight: async () => {}, invalidate: () => {} });
  return {
    fixture, scratch, proxies, helper, supervisor, inspector, guard, publisher,
    /** Records of one launch, by the real service pid behind it. */
    recordsOf: async (launch: number) => (await proxies.records()).filter(record => record.pid === proxies.pids[launch]),
    close: async () => {
      await publisher.idle();
      await helper.close().catch(() => undefined);
      await guard.release();
      await fixture.close();
      await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!await condition()) {
    if (performance.now() > deadline) { throw new Error('Condition not reached.'); }
    await pause(20);
  }
}

/** Retries a file operation that a scanner or a just-ended process can briefly block. */
async function retrying(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await operation(); return; }
    catch (error) { if (attempt >= 50 || !['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; } }
    await pause(100);
  }
}

describe('native helper service faults against the real service', () => {
  it('settles a fileAction whose reply is lost on the replacement, with the publisher still available', { timeout: 120000 }, async () => {
    // Arrange: the service performs the removal, then dies before its reply reaches the runtime.
    const harness = await faultHarness([{ rules: { fileAction: [{ die: 'afterReply' }] } }, {}]);
    const { fixture, inspector, publisher, proxies } = harness;
    try {
      const binding = Buffer.from('{"privateRecoveryFixture":true}');
      const bytes = Buffer.from('hash-bound private carry');
      const target = path.join(fixture.root, 'journal', 'recovery-event.json');
      await fs.mkdir(path.dirname(target));
      await fs.writeFile(path.join(fixture.root, 'scope.json'), binding);
      await fs.writeFile(target, bytes);
      const scope: RuntimeScope = { companionRoot: fixture.root, dataRoot: fixture.root, game: 'stubgame', principal: 'principal', bindingSha256: bytesHash(binding), createdHere: false };
      const executor = new RecoveryExecutor({ scope, inspector, publisher, codec: {} as PayloadCodec, admit: async () => {}, authorizeMutation: async () => {},
        readPayloadSource: async () => { throw new Error('Removal never needs another payload.'); } });
      const action: RecoveryAction = { kind: 'removeCarry', target: { path: 'journal/recovery-event.json', before: bytesHash(bytes), after: null } };

      // Act
      const outcome = await executor.execute(action);

      // Assert
      assert.equal(outcome, 'applied');
      await assert.rejects(fs.readFile(target), { code: 'ENOENT' });
      assert.equal(publisher.blocked, false);
      assert.equal(proxies.pids.length, 2);
      assert.ok((await harness.recordsOf(0)).some(record => record.op === 'fileAction' && record.event === 'dropped'));
      assert.ok((await harness.recordsOf(1)).some(record => record.op === 'admit' && record.event === 'reply'));
      assert.equal((await publisher.publishJson('after.json', { value: 'available' }, true)).cleanupComplete, true);
    } finally { await harness.close(); }
  });

  it('takes the lost-reply path for a publish in flight when the service exits', { timeout: 120000 }, async () => {
    // Arrange
    const harness = await faultHarness([{ rules: { publish: [{ die: 'afterReply' }] } }, {}]);
    const { fixture, publisher } = harness;
    try {
      // Act
      const result = await publisher.publishJson('record.json', { value: 'complete' }, true);

      // Assert: the target is reconciled through the replacement, and the unconfirmed cleanup blocks the publisher.
      assert.equal(JSON.parse(await fs.readFile(path.join(fixture.root, 'record.json'), 'utf8')).value, 'complete');
      assert.equal(result.cleanupComplete, false);
      assert.equal(publisher.blocked, true);
      assert.equal(harness.proxies.pids.length, 2);
    } finally { await harness.close(); }
  });

  it('accepts the replies of in-flight publish, codec and context preparation requests while a missed read drains the service', { timeout: 120000 }, async () => {
    // Arrange: the read misses its deadline plus grace, and its late reply arrives before the slow peers' valid replies.
    const harness = await faultHarness([{ rules: { principal: [{ delayMs: 6000 }], publish: [{ delayMs: 7000 }], codec: [{ delayMs: 7000 }], contextPreparation: [{ delayMs: 7000 }] } }, {}]);
    const { fixture, helper, publisher } = harness;
    try {
      const missing = path.join(fixture.root, `absent-${randomUUID()}`);
      const publishing = publisher.publishJson('record.json', { value: 'during drain' }, true);
      await until(async () => (await harness.recordsOf(0)).some(record => record.op === 'publish'));
      const codec = helper.request('codec', { root: fixture.root, target: path.join(fixture.root, 'codec.json'), inputFile: missing, inputSha256: '0'.repeat(64),
        controlFile: missing, controlSha256: '0'.repeat(64), verifyOnly: true, preview: true }, 30000);
      const context = helper.request('contextPreparation', { root: fixture.root, inputFile: missing, inputSha256: '0'.repeat(64), mode: 'Preview' }, 30000);

      // Act
      const missed = helper.request('principal', {}, 300);

      // Assert
      await assert.rejects(missed, error => error instanceof HelperRequestFailedError && error.kind === 'missed');
      assert.equal((await publishing).cleanupComplete, true);
      assert.equal((await codec).status, 'error');
      assert.equal((await context).status, 'error');
      assert.equal(publisher.blocked, false);
      assert.ok((await harness.recordsOf(0)).some(record => record.op === 'principal' && record.event === 'reply'));
      assert.equal((await publisher.publishJson('after.json', { value: 'available' }, true)).cleanupComplete, true);
      assert.equal(harness.proxies.pids.length, 2);
    } finally { await harness.close(); }
  });

  it('verifies a core child that closes while an inventory request hangs past five seconds, then launches the role again', { timeout: 120000 }, async () => {
    // Arrange
    const harness = await faultHarness([{ rules: { inventory: [{ delayMs: 8000 }] } }]);
    const { fixture, helper, supervisor } = harness;
    try {
      let settled = false;
      const inventory = helper.request('inventory', { root: fixture.root, scopeSha256: '0'.repeat(64), companionRoot: fixture.root, mode: 'Inventory', inputBase64: '' }, 30000)
        .finally(() => { settled = true; });
      await until(async () => (await harness.recordsOf(0)).some(record => record.op === 'inventory'));
      await pause(5200);

      // Act
      const first = await supervisor.run('core', childOptions('arguments', 'while-hung'), 15000);

      // Assert
      assert.equal(first.stdout.toString('utf8'), '["while-hung"]');
      assert.equal(settled, false);
      await supervisor.verifyQuiescent('core');
      const again = await supervisor.run('core', childOptions('arguments', 'again'), 15000);
      assert.equal(again.stdout.toString('utf8'), '["again"]');
      await inventory;
    } finally { await harness.close(); }
  });

  it('completes the proof of a broker that closes during a drain on the draining service', { timeout: 120000 }, async () => {
    // Arrange: a missed read drains the service while a slow peer holds it open.
    const harness = await faultHarness([{ rules: { principal: [{ delayMs: 6000 }], inventory: [{ delayMs: 9000 }] } }, {}]);
    const { fixture, helper, supervisor } = harness;
    try {
      const child = supervisor.spawn('core', childOptions('echo'));
      child.stdout.resume();
      child.stderr.resume();
      await child.ready;
      const slow = helper.request('inventory', { root: fixture.root, scopeSha256: '0'.repeat(64), companionRoot: fixture.root, mode: 'Inventory', inputBase64: '' }, 30000);
      await assert.rejects(helper.request('principal', {}, 300), error => error instanceof HelperRequestFailedError && error.kind === 'missed');
      const drainStarted = (await harness.recordsOf(0)).length;

      // Act: the broker closes while the service drains.
      child.stdin.end();
      await child.terminated;

      // Assert
      assert.equal(child.terminationState, 'verified');
      assert.equal(harness.proxies.pids.length, 1);
      assert.ok((await harness.recordsOf(0)).slice(drainStarted).some(record => record.op === 'jobStates' && record.event === 'reply'));
      // The slow peer's reply, whatever its status, was accepted after the drain began rather than failing with the service.
      assert.ok(['ok', 'error'].includes((await slow).status));
    } finally { await harness.close(); }
  });

  it('serves eventBatch reads from a second service while the bound service replaces the same event file', { timeout: 180000 }, async () => {
    // Arrange: chat's bound service publishes, and a second, unbound service reads through its own inspector.
    const fixture = await companionFixture('context-event');
    const chat = await createTestNative(fixture.root, { companionRoot: fixture.root, dataRoot: fixture.root });
    const reader = await createTestNative(fixture.root);
    const guard = await takeInstanceGuard(fixture.root, error => { throw error; });
    const inspector = new PathInspector(chat.supervisor);
    const publisher = new FilePublisher({ root: fixture.root, guard, inspector, supervisor: chat.supervisor, preflight: async () => {}, invalidate: () => {} });
    const relative = `journal/events/${eventFileName(1)}`;
    const bytes = await fs.readFile(path.join(fixture.root, relative));
    try {
      // Act: every round replaces the event file while reads of it run on the other service.
      for (let round = 0; round < 12; round++) {
        const reads = Array.from({ length: 4 }, () => new EventReader(fixture.root, new PathInspector(reader.supervisor)).read([{ path: relative, sequence: 1 }]));
        const [published, ...results] = await Promise.all([publisher.publish(relative, bytes, 'state-event'), ...reads]);

        // Assert: the replacement completes cleanly and every concurrent read sees a valid document.
        assert.equal(published.cleanupComplete, true);
        assert.ok(results.every(result => result.length === 1 && result[0]!.status === 'valid'));
      }
      assert.deepEqual(await fs.readFile(path.join(fixture.root, relative)), bytes);
    } finally {
      await publisher.idle();
      await reader.close();
      await chat.close();
      await guard.release();
      await fixture.close();
    }
  });

  it('verifies a broker that closes inside the restart window and attests broker launches there only for an unchanged image', { timeout: 120000 }, async () => {
    // Arrange: a private copy of the image, and a replacement whose service starts late, so the restart window stays open
    // with no process running from the image once the test's brokers have closed.
    const copy = path.join(repository, '.tmp', `native-faults-image-${randomUUID()}`);
    await fs.mkdir(copy);
    const location = path.join(copy, 'companion-helper.exe');
    await fs.copyFile((await testHelperImage()).path, location);
    const observed = observeImageFile(location)!;
    // The window stays shorter than the five-second termination proof budget, which is never extended.
    const harness = await faultHarness([{}, { spawnDelayMs: 3000 }], { path: location, sha256: observed.sha256, volume: observed.volume, fileId: observed.fileId });
    const { supervisor, proxies } = harness;
    try {
      const child = supervisor.spawn('core', childOptions('echo'));
      child.stdout.resume();
      child.stderr.resume();
      await child.ready;

      // Act: the service dies and the restart window opens; inside it the core broker closes and a watcher launches.
      proxies.die(0);
      await until(() => proxies.launches() === 2);
      child.stdin.end();
      const watcher = supervisor.spawn('watcher', childOptions('arguments', 'in-window'));
      let output = '';
      watcher.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      watcher.stderr.resume();
      watcher.stdin.end();
      await until(() => child.brokerClosed && watcher.brokerClosed);

      // Act: the unheld image changes, and a launch inside the same window is refused before any process starts.
      const moved = `${location}.moved`;
      await retrying(() => fs.rename(location, moved));
      await fs.writeFile(location, 'changed image');
      let created = true;
      try { supervisor.spawn('provider', childOptions('arguments', 'refused')); }
      catch (error) { created = false; assert.ok(error instanceof SupervisorError); }
      await retrying(() => fs.rm(location));
      await retrying(() => fs.rename(moved, location));
      assert.equal(proxies.pids.length, 1, 'The window must still be open when the image changes.');

      // Assert: both closed brokers are verified by the replacement, and the refused launch left no process behind.
      await child.terminated;
      await watcher.terminated;
      assert.equal(child.terminationState, 'verified');
      assert.equal(watcher.terminationState, 'verified');
      assert.equal(output, '["in-window"]');
      assert.equal(created, false);
      await supervisor.verifyQuiescent('provider');
    } finally {
      await harness.close();
      await fs.rm(copy, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
