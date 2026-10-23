import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NativeHelper } from '../../src/native-helper.ts';
import { readProcessIdentity, type ProcessIdentity } from '../../src/process.ts';
import { testHelperImage } from './native-helper.ts';

const ownerScript = fileURLToPath(new URL('../fixtures/job-owner.ps1', import.meta.url));

/** A process tree running in a watcher job under the helper's broker, as a runtime that died would leave it. */
export interface OrphanWatcher {
  /** The descendant's creation identity, as a runtime marker records its watcher. */
  readonly identity: ProcessIdentity;
  /** Settles when the job owner exits, which it does once the broker in the job has ended. */
  readonly closed: Promise<void>;
  kill(): void;
}

/**
 * Starts owned-descendant.ps1 in the named watcher job through job-owner.ps1 and waits for the descendant to record itself
 * under the fixture root, then confirms its identity through the helper. The caller kills the owner and awaits closed.
 */
export async function startOrphanWatcher(fixtureRoot: string, jobName: string, helper: Pick<NativeHelper, 'request'>): Promise<OrphanWatcher> {
  const owner = spawn('pwsh', ['-NoProfile', '-File', ownerScript, '-JobName', jobName, '-BrokerImage', (await testHelperImage()).path,
    '-FixtureRoot', fixtureRoot], { windowsHide: true, shell: false, cwd: fixtureRoot, stdio: 'ignore' });
  const closed = new Promise<void>((resolve, reject) => { owner.once('close', () => resolve()); owner.once('error', reject); });
  const kill = (): void => { owner.kill(); };
  try {
    let descendant: ProcessIdentity | null = null;
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      try { descendant = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'descendant.json'), 'utf8')) as ProcessIdentity; break; }
      catch (error) { if (!['ENOENT', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; } }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.notEqual(descendant, null, 'The orphan descendant never recorded itself.');
    const identity = await readProcessIdentity(helper, descendant!.pid);
    assert.deepEqual(identity, descendant);

    return { identity: identity!, closed, kill };
  } catch (error) {
    kill();
    await closed;
    throw error;
  }
}
