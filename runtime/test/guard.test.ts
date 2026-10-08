import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { guardPipeName, RuntimeAlreadyRunningError, takeInstanceGuard } from '../src/guard.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidate = (): string => path.join(root, '.tmp', `runtime-guard-${randomUUID()}`, 'missing-scope');
const unexpectedLoss = (error: Error): never => { throw error; };

describe('Windows instance ownership', () => {
  it('excludes a second owner before scope directories exist and releases cleanly', async () => {
    const target = candidate();
    const owner = await takeInstanceGuard(target, unexpectedLoss);
    try {
      assert.equal(owner.held, true);
      await assert.rejects(takeInstanceGuard(target, unexpectedLoss), RuntimeAlreadyRunningError);
      assert.equal(owner.held, true);
    } finally { await owner.release(); }
    assert.equal(owner.held, false);
    await owner.release();
    const replacement = await takeInstanceGuard(target, unexpectedLoss);
    await replacement.release();
  });

  it('uses separate scope namespaces and stable case-folded candidate identity', async () => {
    const target = candidate();
    assert.equal(guardPipeName(target), guardPipeName(target.toUpperCase()));
    assert.notEqual(guardPipeName(target), guardPipeName(target, 'file-tools'));
    const runtime = await takeInstanceGuard(target, unexpectedLoss);
    try {
      const fileTools = await takeInstanceGuard(target, unexpectedLoss, 'file-tools');
      await fileTools.release();
    } finally { await runtime.release(); }
  });

  it('releases kernel ownership after its owning fixture process dies', { timeout: 15000 }, async () => {
    const target = candidate();
    const fixture = fileURLToPath(new URL('./fixtures/guard-owner.ts', import.meta.url));
    const child = spawn(process.execPath, [fixture, target], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error('Guard fixture did not start.')), 5000);
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          if (text.includes('held\n')) { clearTimeout(timer); resolve(); }
        });
        child.once('close', () => { clearTimeout(timer); reject(new Error(`Guard fixture exited early: ${stderr}`)); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      await assert.rejects(takeInstanceGuard(target, unexpectedLoss), RuntimeAlreadyRunningError);
      assert.equal(child.kill(), true);
      await closed;
      const replacement = await takeInstanceGuard(target, unexpectedLoss);
      await replacement.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); }
      await closed;
    }
  });
});
