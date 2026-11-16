import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DataRootUnavailableError } from '../src/admission.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { StartupWorkerTransport } from '../src/startup-worker-transport.ts';
import { createTestNative } from './support/native-helper.ts';

// Real supervised startup workers that fail after their owned identity is reported but before their hello. The transport
// must fail closed rather than fall back, prove the worker's stop, and leave the role launchable again.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const processChild = fixture('process-child.ts');

for (const item of [
  { name: 'exits before its hello', script: 'startup-worker-exit.ps1', handshakeTimeoutMs: 30000 },
  { name: 'stays silent past its handshake deadline', script: 'startup-worker-silent.ps1', handshakeTimeoutMs: 3000 },
] as const) {
  test(`a real startup worker that ${item.name} fails closed with a verified stop`, { timeout: 60000 }, async () => {
    // Arrange
    const scratch = path.join(root, '.tmp', `startup-worker-failure-${randomUUID()}`);
    await fs.mkdir(path.join(scratch, '.tmp'), { recursive: true });
    const native = await createTestNative(path.join(scratch, 'scope'));
    const scope = { companionRoot: scratch, dataRoot: path.join(scratch, 'runtime-data'), bindingSha256: 'a'.repeat(64) } as unknown as RuntimeScope;
    try {
      // Act
      const failure = await StartupWorkerTransport.open(native.supervisor, scope, 'startupCoreReply', fixture(item.script), 'b'.repeat(64),
        item.handshakeTimeoutMs).then(() => null, (error: unknown) => error);

      // Assert
      assert.ok(failure instanceof DataRootUnavailableError, `Expected the transport refusal, got ${String(failure)}.`);
      assert.equal(failure.message, 'Startup worker transport is unavailable.');
      await native.supervisor.verifyQuiescent('startupCoreReply');
      const next = await native.supervisor.run('startupCoreReply', { command: process.execPath, args: [processChild, 'arguments', 'after-failure'], cwd: root }, 15000);
      assert.equal(next.stdout.toString('utf8'), '["after-failure"]');
    } finally {
      await native.close();
      assert.equal(path.relative(root, scratch).startsWith('..'), false);
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
}
