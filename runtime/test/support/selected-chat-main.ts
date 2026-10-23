import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeBackend } from '../../src/backend/api.ts';
import { NativeHelperUnavailableError } from '../../src/native-helper-error.ts';
import { ensureNativeHelperImage, type HelperImage } from '../../src/native-image.ts';
import type { SessionHost } from '../../src/session-host.ts';
import { openSyntheticChat } from './synthetic-chat.ts';
import type { SyntheticProvider } from './synthetic-provider.ts';

// Private copied-root process-to-attachment timing main on the helper path. Usage:
//   node runtime/test/support/selected-chat-main.ts <copiedCompanionRoot> <acknowledgedTurns: 0|1> <prestart|no-prestart>
// The product CLI does not prestart the provider, so `no-prestart` measures its path and `prestart` the private opt-in.
// Emits JSON lines on stdout: `image`, `attached`, then one final `result`.

const installationRoot = path.win32.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const wholeTurnWaitMs = 480000;
const newline = String.fromCharCode(10);

class FixtureRefusal extends Error {}

function emit(value: Record<string, unknown>): void { process.stdout.write(JSON.stringify(value) + newline); }

/** Finds a native helper refusal reason anywhere in a short cause chain, so each negative case can prove its own check. */
function helperDiagnostic(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1, current = current.cause) {
    if (current instanceof NativeHelperUnavailableError) { return current.reason; }
  }
  return null;
}

function strictlyInside(parent: string, candidate: string): boolean {
  const relative = path.win32.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative);
}

function absoluteArgument(value: string | undefined, name: string): string {
  if (value === undefined || !path.win32.isAbsolute(value) || path.win32.resolve(value) !== value) {
    throw new FixtureRefusal(`${name} must be an absolute normalized path.`);
  }
  return value;
}

/** The repository holding this installation: the nearest ancestor whose `.git` is a directory, since a worktree's `.git` is a file. */
async function repositoryRoot(): Promise<string> {
  for (let current = installationRoot; ; current = path.win32.dirname(current)) {
    try { if ((await fs.lstat(path.win32.join(current, '.git'))).isDirectory()) { return current; } }
    catch { /* No repository marker at this level. */ }
    if (path.win32.dirname(current) === current) { throw new FixtureRefusal('The installation is not inside a repository.'); }
  }
}

/** Refuses any root outside the repository, the installation itself, or a root whose adapter would read saves outside it. */
async function admitCopiedRoot(companionRoot: string): Promise<void> {
  if (!strictlyInside(await repositoryRoot(), companionRoot)) { throw new FixtureRefusal('The companion root must be inside the repository.'); }
  if (path.win32.relative(installationRoot, companionRoot) === '') { throw new FixtureRefusal('The companion root must be a copied root.'); }
  const readJson = async (...segments: string[]): Promise<Record<string, unknown>> => {
    try { return JSON.parse(await fs.readFile(path.win32.join(companionRoot, ...segments), 'utf8')) as Record<string, unknown>; }
    catch { throw new FixtureRefusal(`The copied ${segments.join('/')} is unreadable.`); }
  };
  const config = await readJson('runtime', 'companion.config.json');
  if (typeof config.adapter !== 'string' || !/^[a-z0-9_]+$/.test(config.adapter)) { throw new FixtureRefusal('The copied adapter name is invalid.'); }
  const adapter = await readJson('adapters', config.adapter, 'adapter.json');
  if (typeof adapter.saveDirectory !== 'string' || !strictlyInside(companionRoot, path.win32.resolve(adapter.saveDirectory))) {
    throw new FixtureRefusal('The copied adapter must read saves from inside the copied root.');
  }
}

interface AttachmentObservation {
  readonly healthy: boolean;
  readonly consumer: string;
  readonly freshness: string;
  readonly safety: string;
  readonly journal: string;
  readonly watcher: string;
  readonly provider: string;
}

function observeAttachment(backend: RuntimeBackend, host: SessionHost): AttachmentObservation {
  const observed = { consumer: backend.status.consumer, freshness: backend.status.freshness.state, safety: backend.status.stateSafety.state,
    journal: backend.status.journal.state, watcher: backend.status.watcher, provider: host.status.provider.state };
  const healthy = observed.consumer === 'owner' && observed.freshness === 'fresh' && observed.safety === 'ready'
    && observed.journal === 'healthy' && observed.watcher === 'running' && observed.provider === 'ready';
  return { healthy, ...observed };
}

async function completeOneTurn(backend: RuntimeBackend, host: SessionHost, provider: SyntheticProvider,
  turnCompleted: Promise<unknown>): Promise<void> {
  provider.current.action = async request => {
    if (!request.contextBlock.startsWith('<companion-turn-context>')) { throw new Error('Turn context block is missing.'); }
    return { kind: 'completed', text: 'Private copied-root answer.' };
  };
  let acknowledge: ((value: unknown) => void) | undefined;
  const acknowledged = new Promise<unknown>(resolve => { acknowledge = resolve; });
  const originalAcknowledge = backend.acknowledge.bind(backend);
  backend.acknowledge = async (...args) => {
    const result = await originalAcknowledge(...args);
    acknowledge?.(result);
    return result;
  };
  if (host.submitChat({ text: 'Inspect the copied fixture.', questionOverride: false }).result !== 'admitted') {
    throw new Error('The fixture turn was not admitted.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture turn expired.')), wholeTurnWaitMs); });
  try { await Promise.race([Promise.all([turnCompleted, acknowledged]), timeout]); }
  finally { clearTimeout(timer); }
}

/** Opens the helper image for write without writing; while the service holds it, Windows sharing must refuse. */
async function probeArtifactWrite(image: HelperImage): Promise<string> {
  try {
    const handle = await fs.open(image.path, 'r+');
    await handle.close();
    return 'opened';
  } catch (error) { return (error as NodeJS.ErrnoException).code ?? 'failed'; }
}

async function run(companionRoot: string, turns: 0 | 1, prestart: boolean): Promise<number> {
  const phases: Array<{ phase: string; processMs: number }> = [];
  const durations: { turnMs: number | null; shutdownMs: number | null } = { turnMs: null, shutdownMs: null };
  let stage = 'native-image';
  let host: SessionHost | null = null;
  let attachment: AttachmentObservation | null = null;
  let artifactWrite: string | null = null;
  try {
    const imageStarted = performance.now();
    let built = false;
    const image = await ensureNativeHelperImage({ build: true, onBuildStart: () => { built = true; } });
    emit({ event: 'image', built, imageMs: performance.now() - imageStarted, processMs: performance.now() });
    stage = 'chat-startup';
    const chat = await openSyntheticChat(companionRoot, image, prestart, phase => { phases.push({ phase, processMs: performance.now() }); });
    host = chat.host;
    const readyBackend: RuntimeBackend = chat.backend;
    const readyProvider: SyntheticProvider = chat.provider;
    stage = 'verified-attachment';
    let completed: ((value: unknown) => void) | undefined;
    const turnCompleted = new Promise<unknown>(resolve => { completed = resolve; });
    const attached = await host.attachVerified(event => { if (event.type === 'turn.completed') { completed?.(event); } });
    if (attached.result !== 'attached') { throw new Error(`Client attachment failed: ${attached.result}.`); }
    await readyProvider.current.verifyLive();
    attachment = observeAttachment(readyBackend, host);
    emit({ event: 'attached', processMs: performance.now(), attachedAtUnixMs: Date.now(), ...attachment });
    if (!attachment.healthy) { throw new Error('Attachment was not healthy.'); }
    if (turns === 1) {
      stage = 'acknowledged-turn';
      const turnStarted = performance.now();
      await completeOneTurn(readyBackend, host, readyProvider, turnCompleted);
      durations.turnMs = performance.now() - turnStarted;
    }
    stage = 'held-image-probe';
    artifactWrite = await probeArtifactWrite(image);
    stage = 'shutdown';
    const shutdownStarted = performance.now();
    await host.shutdown();
    durations.shutdownMs = performance.now() - shutdownStarted;
    host = null;
    emit({ event: 'result', status: 'passed', prestart, attachment, acknowledgedTurns: turns, artifactWrite,
      providerStarts: readyProvider.calls.length, providerResumed: readyProvider.calls[0] ?? null, ...durations, phases });
    return 0;
  } catch (error) {
    if (host !== null) {
      try { await host.shutdown(); }
      catch { /* The caller proves every role stopped after this process exits. */ }
    }
    emit({ event: 'result', status: 'failed', stage, prestart, attachment, artifactWrite, ...durations, phases,
      helper: helperDiagnostic(error), message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

let code: number;
try {
  const [rootArgument, turnsArgument, prestartArgument] = process.argv.slice(2);
  const companionRoot = absoluteArgument(rootArgument, 'The companion root');
  if (turnsArgument !== '0' && turnsArgument !== '1') { throw new FixtureRefusal('Acknowledged turns must be 0 or 1.'); }
  if (prestartArgument !== 'prestart' && prestartArgument !== 'no-prestart') { throw new FixtureRefusal('Choose prestart or no-prestart.'); }
  await admitCopiedRoot(companionRoot);
  code = await run(companionRoot, turnsArgument === '1' ? 1 : 0, prestartArgument === 'prestart');
} catch (error) {
  emit({ event: 'result', status: error instanceof FixtureRefusal ? 'refused' : 'failed', message: error instanceof Error ? error.message : String(error) });
  code = error instanceof FixtureRefusal ? 2 : 1;
}
process.exitCode = code;
