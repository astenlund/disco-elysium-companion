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
import { formatCliError, runChatClient } from '../../src/cli.ts';
import { NativeHelperUnavailableError } from '../../src/native-helper-error.ts';
import { SupervisorError } from '../../src/process.ts';
import type { HostEvent } from '../../src/session-host-contract.ts';
import { companionFixture } from '../support/companion.ts';
import { helperProxies, testHelperImage } from '../support/native-helper.ts';
import { exhaustHelper, openSyntheticChat, type SyntheticChat } from '../support/synthetic-chat.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const attachAndWait = fileURLToPath(new URL('../support/attach-and-wait.ts', import.meta.url));
const exhaustAndExit = fileURLToPath(new URL('../support/exhaust-and-exit.ts', import.meta.url));
const childScript = fileURLToPath(new URL('../fixtures/process-child.ts', import.meta.url));
const childOptions = { command: process.execPath, args: [childScript, 'arguments', 'refused'], cwd: repository };
async function attach(chat: SyntheticChat, sink: (event: HostEvent) => void = () => {}): Promise<void> {
  const attached = await chat.host.attachVerified(sink);
  assert.equal(attached.result, 'attached');
}

/**
 * Ends any provider broker a test left running, as one that fails before its shutdown can, and then releases the guard
 * that a shutdown failed on the exhausted helper keeps held, before the fixture is closed. A chat that never opened leaves
 * only the fixture to close.
 */
async function releaseExhaustedChat(chat: SyntheticChat | null, fixture: { close(): Promise<void> }): Promise<void> {
  try {
    if (chat !== null) {
      try { await chat.provider.endChildren(); }
      finally { await (chat.backend as unknown as { readonly kernel: Kernel }).kernel.guard.release().catch(() => undefined); }
    }
  } finally { await fixture.close(); }
}

describe('chat lifecycle on the native helper', () => {
  it('stays attached after the restart is spent, refuses later launches without a process and keeps the guard on shutdown', { timeout: 600000 }, async () => {
    // Arrange: a fresh-scope start that reaches attachment.
    const fixture = await companionFixture('runtime-owned');
    let opened: SyntheticChat | null = null;
    try {
      const chat = await openSyntheticChat(fixture.root, await testHelperImage());
      opened = chat;
      await attach(chat);
      const helper = chat.backend.supervisor.nativeHelper;
      const providerStarts = chat.provider.calls.length;

      // Act: the service is killed, replaced once, and the replacement is killed too.
      await exhaustHelper(chat);

      // Assert: chat stays attached with no new provider start, while later launches and requests take their helper-unavailable paths.
      assert.equal(chat.provider.calls.length, providerStarts);
      assert.throws(() => chat.backend.supervisor.spawn('watcher', childOptions), SupervisorError);
      assert.throws(() => chat.backend.supervisor.spawn('provider', childOptions), SupervisorError);
      await assert.rejects(chat.backend.inspector.inspect(chat.backend.scope.dataRoot, path.join(chat.backend.scope.dataRoot, 'runtime.json')));

      // Act and assert: shutdown cannot prove quiescence, so the marker stays unclean and the guard stays held, and the chat
      // exit the CLI reports through its client wrapper carries the helper refusal with its restart remedy.
      const shutdown = await Promise.allSettled([runChatClient({ host: chat.host, helper }, host => host.shutdown())]);
      assert.equal(shutdown[0]!.status, 'rejected');
      assert.equal(helper.exhausted, true);
      const reported = (shutdown[0] as PromiseRejectedResult).reason;
      assert.ok(reported instanceof NativeHelperUnavailableError && reported.reason === 'unavailable', String(reported));
      assert.match(formatCliError(reported), /^nativeHelperUnavailable \(unavailable\): .*Restart the runtime\.$/);
      const marker = JSON.parse(await fs.readFile(path.join(chat.backend.scope.dataRoot, 'runtime.json'), 'utf8')) as { cleanShutdown: boolean };
      assert.equal(marker.cleanShutdown, false);
      assert.equal((chat.backend as unknown as { readonly kernel: Kernel }).kernel.guard.held, true);
    } finally { await releaseExhaustedChat(opened, fixture); }
  });

  it('fails a turn submitted after the restart is spent with the helper refusal before any provider send, and refuses later turns at submission', { timeout: 600000 }, async () => {
    // Arrange: an attached chat with a ready provider whose helper is then exhausted.
    const fixture = await companionFixture('runtime-owned');
    let opened: SyntheticChat | null = null;
    try {
      const chat = await openSyntheticChat(fixture.root, await testHelperImage());
      opened = chat;
      const events: HostEvent[] = [];
      let terminal: ((event: HostEvent) => void) | null = null;
      await attach(chat, event => { events.push(event); if (event.type === 'turn.completed' || event.type === 'turn.failed') { terminal?.(event); } });
      await exhaustHelper(chat);
      const sendCount = (): number => chat.provider.sessions.reduce((total, session) => total + session.requests.length, 0);
      const sends = sendCount();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const ended = new Promise<HostEvent | 'timeout'>(resolve => { terminal = resolve; deadline = setTimeout(() => resolve('timeout'), 120_000); });

      // Act: one turn awaited to its terminal event, then a second submission.
      const first = chat.host.submitChat({ text: 'First question after exhaustion.', questionOverride: false }).result;
      const outcome = await ended;
      clearTimeout(deadline);
      const second = chat.host.submitChat({ text: 'Second question after exhaustion.', questionOverride: false }).result;

      // Assert: the admitted turn failed with the non-retryable helper refusal and reached no provider, and the capacity
      // slot its failure marked unavailable refuses the next submission.
      assert.equal(first, 'admitted');
      assert.ok(outcome !== 'timeout' && outcome.type === 'turn.failed' && outcome.code === 'nativeHelperUnavailable' && !outcome.retryable, JSON.stringify(outcome));
      assert.equal(sendCount(), sends);
      assert.equal(second, 'notReady');
      assert.deepEqual(chat.host.status.capacity.ordinary, { state: 'unavailable', reason: 'helperUnavailable', dimensions: [] });
    } finally { await releaseExhaustedChat(opened, fixture); }
  });

  it('fails a turn whose acquisition the helper exhaustion interrupts with the helper refusal, not a retryable invalidation', { timeout: 600000 }, async () => {
    // Arrange: an attached chat whose helper is exhausted by real kills once the admitted turn's acquisition reaches its
    // settlement drain, so the safety observation after it reads unavailable because the helper cannot serve.
    const fixture = await companionFixture('runtime-owned');
    let opened: SyntheticChat | null = null;
    try {
      const chat = await openSyntheticChat(fixture.root, await testHelperImage());
      opened = chat;
      let terminal: ((event: HostEvent) => void) | null = null;
      await attach(chat, event => { if (event.type === 'turn.completed' || event.type === 'turn.failed') { terminal?.(event); } });
      const kernel = (chat.backend as unknown as { readonly kernel: Kernel }).kernel;
      const drain = kernel.drain.bind(kernel);
      let exhausted = false;
      kernel.drain = async (...args: Parameters<Kernel['drain']>) => {
        if (!exhausted) { exhausted = true; await exhaustHelper(chat); }
        return drain(...args);
      };
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const ended = new Promise<HostEvent | 'timeout'>(resolve => { terminal = resolve; deadline = setTimeout(() => resolve('timeout'), 180_000); });

      // Act
      const admitted = chat.host.submitChat({ text: 'Question whose acquisition loses the helper.', questionOverride: false }).result;
      const outcome = await ended;
      clearTimeout(deadline);

      // Assert: the acquisition published unavailable safety, and the turn still ended with the non-retryable helper refusal.
      assert.equal(admitted, 'admitted');
      assert.equal(exhausted, true);
      assert.equal(chat.host.status.stateSafety.state, 'unavailable');
      assert.ok(outcome !== 'timeout' && outcome.type === 'turn.failed' && outcome.code === 'nativeHelperUnavailable' && !outcome.retryable, JSON.stringify(outcome));
    } finally { await releaseExhaustedChat(opened, fixture); }
  });

  it('has ended the provider when a shutdown the exhausted helper failed returns, and the chat process then exits on its own', { timeout: 600000 }, async () => {
    // Arrange: a chat process that exhausts its helper, lets shutdown fail, reports its provider children and then returns as the CLI does.
    const fixture = await companionFixture('runtime-owned');
    const child = spawn(process.execPath, [exhaustAndExit, fixture.root], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>(resolve => { child.once('exit', code => resolve(code)); });
    // One deadline bounds every wait on the chat process, so a stalled start or shutdown still reaches the cleanup below.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>(resolve => { deadline = setTimeout(() => resolve('timeout'), 300_000); });
    try {
      const first = await Promise.race([createInterface({ input: child.stdout })[Symbol.asyncIterator]().next(), expired]);
      assert.ok(first !== 'timeout', 'the chat process sent no report within the deadline');
      assert.equal(first.done, false, 'the chat process ended before reporting');
      type Child = { pid: number; brokerClosed: boolean; running: boolean };
      const report = JSON.parse(first.value as string) as { attached: string; exhausted: boolean; before: { provider: string; children: Child[] };
        shutdown: string; code: unknown; providers: Child[] };

      // Act: wait for the chat process to end on its own.
      const code = await Promise.race([exited, expired]);

      // Assert: a provider was live when shutdown began, the shutdown failed with the helper refusal only after it had closed
      // each live provider's broker and its child had exited, and the chat process then ended with the failed shutdown's exit code.
      assert.ok(report.attached === 'attached' && report.exhausted && report.shutdown === 'rejected', JSON.stringify(report));
      assert.equal(report.code, 'nativeHelperUnavailable');
      const live = report.before.children.filter(child => !child.brokerClosed && child.running);
      assert.ok(report.before.provider === 'ready' && live.length > 0, `no provider was live when shutdown began: ${JSON.stringify(report.before)}`);
      assert.ok(live.every(child => report.providers.some(after => after.pid === child.pid && after.brokerClosed && !after.running)), JSON.stringify(report.providers));
      assert.equal(code, 1, 'the chat process did not end on its own after its failed shutdown');
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill(); await exited; }
      await fixture.close();
    }
  });

  it('reports the binding refusal, not dataRootUnavailable, when binding spends the restart, and keeps the guard', { timeout: 600000 }, async () => {
    // Arrange: both the first service and its replacement die on bindScope, so binding exhausts the helper.
    const fixture = await companionFixture('runtime-owned');
    const scratch = path.join(repository, '.tmp', `chat-lifecycle-${randomUUID()}`);
    await fs.mkdir(scratch, { recursive: true });
    const proxies = await helperProxies(path.join(scratch, 'proxy.log'), [{ rules: { bindScope: [{ die: 'beforeForward' }] } }, { rules: { bindScope: [{ die: 'beforeForward' }] } }]);
    try {
      // Act
      const opened = await Promise.allSettled([openBackend({ companionRoot: fixture.root, nativeImage: await testHelperImage(), nativeLauncher: proxies.launcher })]);
      const again = await Promise.allSettled([openBackend({ companionRoot: fixture.root, nativeImage: await testHelperImage() })]);

      // Assert: the start reports the helper refusal with its restart remedy, and the failed cleanup kept the guard held.
      assert.equal(opened[0]!.status, 'rejected');
      const refusal = (opened[0] as PromiseRejectedResult).reason;
      assert.ok(refusal instanceof NativeHelperUnavailableError && refusal.reason === 'unavailable', String(refusal));
      assert.match(formatCliError(refusal), /^nativeHelperUnavailable \(unavailable\): .*Restart the runtime\.$/);
      assert.equal(again[0]!.status, 'rejected');
      assert.equal(((again[0] as PromiseRejectedResult).reason as { code?: unknown }).code, 'runtimeAlreadyRunning');
    } finally {
      await fixture.close();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('keeps identityUnavailable with the helper fault as its cause for a principal failure while the helper can still serve', { timeout: 600000 }, async () => {
    // Arrange: only the first service dies on the principal request, so its replacement serves and the helper is not exhausted.
    const fixture = await companionFixture('runtime-owned');
    const scratch = path.join(repository, '.tmp', `chat-lifecycle-${randomUUID()}`);
    await fs.mkdir(scratch, { recursive: true });
    const proxies = await helperProxies(path.join(scratch, 'proxy.log'), [{ rules: { principal: [{ die: 'beforeForward' }] } }, {}]);
    try {
      // Act
      const opened = await Promise.allSettled([openBackend({ companionRoot: fixture.root, nativeImage: await testHelperImage(), nativeLauncher: proxies.launcher })]);

      // Assert: the start keeps its fatal code, and the cause chain reaches the helper's own fault.
      assert.equal(opened[0]!.status, 'rejected');
      const failure = (opened[0] as PromiseRejectedResult).reason as Error & { code?: unknown };
      assert.equal(failure.code, 'identityUnavailable', String(failure));
      assert.match(formatCliError(failure), /^identityUnavailable: /);
      const principal = failure.cause;
      assert.ok(principal instanceof Error && principal.message === 'identityUnavailable', String(principal));
      assert.ok(principal.cause instanceof Error, 'the helper fault survives as the principal failure cause');
    } finally {
      await fixture.close();
      await fs.rm(scratch, { recursive: true, force: true });
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
