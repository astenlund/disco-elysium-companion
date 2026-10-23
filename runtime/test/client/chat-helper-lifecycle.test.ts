import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../../src/backend/index.ts';
import type { Kernel } from '../../src/backend/kernel.ts';
import { SupervisorError } from '../../src/process.ts';
import { companionFixture } from '../support/companion.ts';
import { helperProxies, testHelperImage } from '../support/native-helper.ts';
import { openSyntheticChat, type SyntheticChat } from '../support/synthetic-chat.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const attachAndWait = fileURLToPath(new URL('../support/attach-and-wait.ts', import.meta.url));
const childScript = fileURLToPath(new URL('../fixtures/process-child.ts', import.meta.url));
const childOptions = { command: process.execPath, args: [childScript, 'arguments', 'refused'], cwd: repository };
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });

async function until(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) { throw new Error('Condition not reached.'); }
    await pause(50);
  }
}

async function attach(chat: SyntheticChat): Promise<void> {
  const attached = await chat.host.attachVerified(() => {});
  assert.equal(attached.result, 'attached');
}

describe('chat lifecycle on the native helper', () => {
  it('stays attached after the restart is spent, refuses later launches without a process and keeps the guard on shutdown', { timeout: 600000 }, async () => {
    // Arrange: a fresh-scope start that reaches attachment.
    const fixture = await companionFixture('runtime-owned');
    const chat = await openSyntheticChat(fixture.root, await testHelperImage());
    try {
      await attach(chat);
      const helper = chat.backend.supervisor.nativeHelper;
      const servicePid = (): number | null => { try { return helper.owner().pid; } catch { return null; } };
      const first = servicePid()!;
      const providerStarts = chat.provider.calls.length;

      // Act: the service is killed, replaced once, and the replacement is killed too.
      process.kill(first);
      await until(() => { const current = servicePid(); return current !== null && current !== first; });
      process.kill(servicePid()!);
      await until(() => { try { helper.brokerImage(); return false; } catch { return servicePid() === null; } });

      // Assert: chat stays attached and refuses turns, while later launches and requests take their helper-unavailable paths.
      assert.ok(['notReady', 'providerUnavailable'].includes(chat.host.submitChat({ text: 'After exhaustion.', questionOverride: false }).result));
      assert.equal(chat.provider.calls.length, providerStarts);
      assert.throws(() => chat.backend.supervisor.spawn('watcher', childOptions), SupervisorError);
      assert.throws(() => chat.backend.supervisor.spawn('provider', childOptions), SupervisorError);
      await assert.rejects(chat.backend.inspector.inspect(chat.backend.scope.dataRoot, path.join(chat.backend.scope.dataRoot, 'runtime.json')));

      // Act and assert: shutdown cannot prove quiescence, so the marker stays unclean and the guard stays held.
      await assert.rejects(chat.host.shutdown());
      const marker = JSON.parse(await fs.readFile(path.join(chat.backend.scope.dataRoot, 'runtime.json'), 'utf8')) as { cleanShutdown: boolean };
      assert.equal(marker.cleanShutdown, false);
      assert.equal((chat.backend as unknown as { readonly kernel: Kernel }).kernel.guard.held, true);
    } finally {
      await (chat.backend as unknown as { readonly kernel: Kernel }).kernel.guard.release().catch(() => undefined);
      await fixture.close();
    }
  });

  it('retries at once after a start that fails once the service is bound, and reaches attachment', { timeout: 600000 }, async () => {
    // Arrange: the first start's service dies on its first publication, after binding.
    const fixture = await companionFixture('runtime-owned');
    const scratch = path.join(repository, '.tmp', `chat-lifecycle-${randomUUID()}`);
    await fs.mkdir(scratch, { recursive: true });
    const proxies = await helperProxies(path.join(scratch, 'proxy.log'), [{ rules: { publish: [{ die: 'beforeForward' }] } }, {}]);
    try {
      await assert.rejects(openBackend({ companionRoot: fixture.root, nativeImage: await testHelperImage(), nativeLauncher: proxies.launcher }));
      assert.ok((await proxies.records()).some(record => record.op === 'bindScope'));

      // Act
      const chat = await openSyntheticChat(fixture.root, await testHelperImage());

      // Assert
      try { await attach(chat); }
      finally { await chat.host.shutdown(); }
    } finally {
      await fixture.close();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('restarts at once after a killed runtime whose service may still be ending, and reaches attachment', { timeout: 600000 }, async () => {
    // Arrange: a chat process killed as soon as it attached, leaving its marker unclean and its service ending.
    const fixture = await companionFixture('runtime-owned');
    try {
      const child = spawn(process.execPath, [attachAndWait, fixture.root], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
      let attached = false;
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.trim() === 'attached') { attached = true; child.kill(); break; }
      }
      await exited;
      assert.equal(attached, true);

      // Act
      const chat = await openSyntheticChat(fixture.root, await testHelperImage());

      // Assert
      try { await attach(chat); }
      finally { await chat.host.shutdown(); }
      const marker = JSON.parse(await fs.readFile(path.join(chat.backend.scope.dataRoot, 'runtime.json'), 'utf8')) as { cleanShutdown: boolean };
      assert.equal(marker.cleanShutdown, true);
    } finally { await fixture.close(); }
  });
});
