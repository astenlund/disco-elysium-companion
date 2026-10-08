import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface CompanionFixture { readonly root: string; close(): Promise<void> }

// The shared PowerShell fixture owns its root until stdin closes, preserving its existing cleanup.
export async function companionFixture(mode: 'empty' | 'core' | 'state-event' | 'context' | 'context-event' | 'runtime' | 'runtime-owned' | 'runtime-owned-empty' = 'empty'): Promise<CompanionFixture> {
  const script = fileURLToPath(new URL('../fixtures/companion-root.ps1', import.meta.url));
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const modes = { empty: [], core: ['-Core'], 'state-event': ['-StateEvent'], context: ['-Context'], 'context-event': ['-ContextEvent'], runtime: ['-Runtime'], 'runtime-owned': ['-RuntimeOwned'], 'runtime-owned-empty': ['-RuntimeOwnedEmpty'] };
  const child = spawn('pwsh', ['-NoProfile', '-File', script, ...modes[mode]], { cwd: repository, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString('utf8')).slice(-4096); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  void closed.catch(() => undefined);
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill(), 30000);
  let transferred = false;
  try {
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done) { throw new Error(`Fixture host exited before initialization: ${error}`); }
    const value = JSON.parse(first.value) as { root?: unknown };
    const tmp = path.join(repository, '.tmp');
    if (typeof value.root !== 'string' || path.dirname(path.resolve(value.root)).toLowerCase() !== tmp.toLowerCase() || !/^runtime-fixture-[0-9]+-[a-f0-9]{32}$/.test(path.basename(value.root))) {
      throw new Error('Fixture host returned an invalid root.');
    }
    transferred = true;
    let completion: Promise<void> | null = null;

    return {
      root: value.root,
      close(): Promise<void> {
        completion ??= (async () => {
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), 10000);
          try {
            if (await closed !== 0) { throw new Error(`Fixture cleanup failed: ${error}`); }
          } finally { clearTimeout(timeout); }
        })();

        return completion;
      },
    };
  } finally {
    clearTimeout(timer);
    lines.close();
    if (!transferred) { child.stdin.end(); child.kill(); await closed; }
  }
}
