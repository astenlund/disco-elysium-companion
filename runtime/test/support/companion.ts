import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface CompanionFixture { readonly root: string; close(): Promise<void> }

/**
 * What still stands at a fixture root after removal: a directory, with its entry count (null when unlistable) and a
 * bounded root-relative sample; another kind of entry; or residue the host reported in a form that could not be read.
 */
export interface FixtureResidue { readonly kind: 'directory' | 'not-a-directory' | 'unknown'; readonly remaining: number | null; readonly sample: readonly string[] }

/** The fixture root outlived its removal; distinct from a host failure, and its message names no path. */
export class FixtureResidueError extends Error {
  readonly residue: FixtureResidue;

  constructor(residue: FixtureResidue) {
    super(residue.kind === 'not-a-directory' ? 'Fixture root was not removed: an entry that is not a directory remains at its path.'
      : `Fixture root was not removed: ${residue.remaining ?? 'an unknown number of'} entries remain.`);
    this.name = 'FixtureResidueError';
    this.residue = residue;
  }
}

/** The observation fields a probe records for a failed fixture close, keeping the residue when there is one. */
export function fixtureCloseFailure(error: unknown): Record<string, unknown> {
  const name = error instanceof Error ? error.name : 'unknown';

  return error instanceof FixtureResidueError ? { fixtureCloseFailure: name, fixtureResidue: error.residue } : { fixtureCloseFailure: name };
}

const residueExitCode = 3;
const residueSampleLimit = 16;

function reportedResidue(stderr: string): FixtureResidue {
  const last = stderr.trimEnd().split(/\r?\n/).at(-1) ?? '';
  try {
    const value = (JSON.parse(last) as { fixtureResidue?: { kind?: unknown; remaining?: unknown; sample?: unknown } }).fixtureResidue;
    const sample = Array.isArray(value?.sample) ? value.sample.filter((entry): entry is string => typeof entry === 'string') : [];

    return { kind: value?.kind === 'not-a-directory' ? 'not-a-directory' : 'directory', remaining: typeof value?.remaining === 'number' ? value.remaining : null, sample };
  }
  catch {
    // A residue exit whose report cannot be read is still residue, of unknown extent.
    return { kind: 'unknown', remaining: null, sample: [] };
  }
}

/** @internal Resolves when nothing stands at the root; otherwise rejects with what stands there. */
export async function assertRootRemoved(root: string): Promise<void> {
  let entry;
  try { entry = await fs.lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
    throw new Error('Fixture root removal could not be verified.', { cause: error });
  }
  if (!entry.isDirectory()) { throw new FixtureResidueError({ kind: 'not-a-directory', remaining: null, sample: [] }); }
  let names: string[];
  try { names = (await fs.readdir(root, { recursive: true })).map(name => name.replaceAll(path.sep, '/')).sort(); }
  catch {
    // A directory that cannot be listed is still residue, of unknown extent.
    throw new FixtureResidueError({ kind: 'directory', remaining: null, sample: [] });
  }
  throw new FixtureResidueError({ kind: 'directory', remaining: names.length, sample: names.slice(0, residueSampleLimit) });
}

// The shared PowerShell fixture owns its root until stdin closes, then removes it; close() resolves only once the root is gone.
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
    const root = value.root;
    transferred = true;
    let completion: Promise<void> | null = null;

    return {
      root,
      close(): Promise<void> {
        completion ??= (async () => {
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), 10000);
          let code: number | null;
          try { code = await closed; }
          finally { clearTimeout(timeout); }
          if (code === residueExitCode) { throw new FixtureResidueError(reportedResidue(error)); }
          if (code !== 0) { throw new Error(`Fixture cleanup failed: ${error}`); }
          await assertRootRemoved(root);
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
