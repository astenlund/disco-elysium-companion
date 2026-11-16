// One gate run of the startup acceptance harness, on a copied companion root that run-gates.ts prepared. Usage:
//   node gate-main.ts <root> chat <0|1> [goFile]   start chat with the synthetic provider; with goFile, wait for it before the turn
//   node gate-main.ts <root> provider-refusal       start chat with a provider whose every start its own child refuses
//   node gate-main.ts <root> cli <args...>          run the product CLI function on the root (consumer and notOwner chat only)
// With GATE_AWAIT_HEALTHY=1, a chat run waits up to 180 s from process start for healthy status: the healthy-recovery gate.
// Emits JSON lines on stdout: live `phase` events, `attached`, `healthy`, `awaiting-go`, `turn`, then one final `result`.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeBackend } from '../../../src/backend/api.ts';
import { runCli } from '../../../src/cli.ts';
import { ensureNativeHelperImage } from '../../../src/native-image.ts';
import type { ProviderSession } from '../../../src/provider.ts';
import { createChatRuntime, privateRuntimeStartup } from '../../../src/runtime.ts';
import type { SessionHost } from '../../../src/session-host.ts';
import { SyntheticProvider } from '../../support/synthetic-provider.ts';

type Snapshot = Record<string, unknown>;

const newline = String.fromCharCode(10);
const refusingChild = fileURLToPath(new URL('./refusing-provider-child.mjs', import.meta.url));
const turnWaitMs = 300000;
const acknowledgementWaitMs = 30000;
const recoveryBoundMs = 180000;
const awaitHealthy = process.env['GATE_AWAIT_HEALTHY'] === '1';
const emit = (value: Record<string, unknown>): void => { process.stdout.write(JSON.stringify({ processMs: performance.now(), ...value }) + newline); };
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });

/** A synthetic provider whose real `provider` child refuses readiness on every start. */
class RefusingProvider extends SyntheticProvider {
  starts = 0;
  override async start(resume: string | null, signal?: AbortSignal): Promise<ProviderSession> {
    this.starts += 1;
    const supervisor = (this as unknown as { supervisor: RuntimeBackend['supervisor'] }).supervisor;
    await supervisor.verifyQuiescent('provider');
    const child = supervisor.spawn('provider', { command: process.execPath, args: [refusingChild], cwd: process.cwd(), env: process.env, ...(signal === undefined ? {} : { signal }) });
    child.stderr.resume();
    const text = await new Promise<string>(resolve => { child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))); });
    await child.terminated.catch(() => undefined);
    await supervisor.stop('provider');
    void resume;
    throw new Error(`Refusing provider child answered ${text.trim()}.`);
  }
}

function snapshot(backend: RuntimeBackend, host: SessionHost): Snapshot {
  const status = backend.status;
  return { consumer: status.consumer, freshness: status.freshness.state, freshnessReason: status.freshness.reason, safety: status.stateSafety.state,
    correction: status.stateSafety.correction?.reason ?? null, journal: status.journal.state, journalFault: status.journal.fault,
    unacknowledged: status.journal.unacknowledgedEvents, watcher: status.watcher, provider: host.status.provider.state };
}

/** The counted healthy attachment of the startup objective: owner, fresh, ready safety, healthy journal, running watcher, ready provider. */
function healthy(observed: Snapshot): boolean {
  return observed['consumer'] === 'owner' && observed['freshness'] === 'fresh' && observed['safety'] === 'ready'
    && observed['journal'] === 'healthy' && observed['watcher'] === 'running' && observed['provider'] === 'ready';
}

async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) { await pause(50); }
}

async function chat(root: string, turns: number, goFile: string | null): Promise<number> {
  const image = await ensureNativeHelperImage({ build: true });
  let host: SessionHost | null = null;
  let backend: RuntimeBackend | null = null;
  let provider: SyntheticProvider | null = null;
  let stage = 'chat-startup';
  try {
    const opened = await createChatRuntime(root, phase => emit({ event: 'phase', phase }), { [privateRuntimeStartup]: { providerFactory: (_text, _tools, current) => {
      backend ??= current; provider ??= new SyntheticProvider(current.supervisor, root); return provider;
    } } }, image);
    if (opened.result !== 'ready') { emit({ event: 'result', status: 'not-ready', result: opened.result }); return 3; }
    const current = opened.host;
    host = current;
    const ready = backend as unknown as RuntimeBackend;
    const synthetic = provider as unknown as SyntheticProvider;
    stage = 'verified-attachment';
    // Every host event except deltas is recorded with its time; a turn ends on turn.completed or turn.failed.
    const hostEvents: Record<string, unknown>[] = [];
    let ended: ((value: string) => void) | undefined;
    const turnEnded = new Promise<string>(resolve => { ended = resolve; });
    const attached = await current.attachVerified(event => {
      if (event.type === 'turn.delta') { return; }
      const detail = event.type === 'status.changed' ? { provider: event.status.provider.state } : 'code' in event ? { code: event.code, reason: 'reason' in event ? event.reason : null } : {};
      hostEvents.push({ type: event.type, processMs: performance.now(), ...detail });
      if (event.type === 'turn.completed') { ended?.('completed'); }
      if (event.type === 'turn.failed') { ended?.(`failed:${event.code}`); }
    });
    if (attached.result !== 'attached') { throw new Error(`Client attachment failed: ${attached.result}.`); }
    const atAttach = snapshot(ready, current);
    emit({ event: 'attached', healthy: healthy(atAttach), ...atAttach });
    // A degraded ready attachment still takes its turn, which is what clears a correction such as contextUncertain.
    let healthyAtMs: number | null = healthy(atAttach) ? performance.now() : null;
    while (awaitHealthy && healthyAtMs === null && performance.now() < recoveryBoundMs) {
      await pause(250);
      if (healthy(snapshot(ready, current))) { healthyAtMs = performance.now(); }
    }
    emit({ event: 'healthy', awaited: awaitHealthy, healthyAtMs, ...snapshot(ready, current) });
    let turn: Record<string, unknown> | null = null;
    if (turns === 1 && current.status.provider.state !== 'ready') { turn = { outcome: 'skipped-provider-not-ready', after: snapshot(ready, current) }; }
    if (turns === 1 && current.status.provider.state === 'ready') {
      stage = 'turn';
      if (goFile !== null) { emit({ event: 'awaiting-go' }); await waitFor(goFile); }
      synthetic.current.action = async request => {
        if (!request.contextBlock.startsWith('<companion-turn-context>')) { throw new Error('Turn context block is missing.'); }
        return { kind: 'completed', text: 'Private copied-root answer.' };
      };
      let acknowledged = false;
      const originalAcknowledge = ready.acknowledge.bind(ready);
      ready.acknowledge = async (...args) => { const result = await originalAcknowledge(...args); acknowledged = true; return result; };
      const submitted = performance.now();
      const admission = current.submitChat({ text: 'Inspect the copied fixture.', questionOverride: false }).result;
      if (admission !== 'admitted') { throw new Error(`The fixture turn was not admitted: ${admission}.`); }
      const samples: Snapshot[] = [];
      const sampler = setInterval(() => { samples.push({ processMs: performance.now(), providerContexts: synthetic.calls.length, ...snapshot(ready, current) }); }, 5000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([turnEnded, new Promise<string>(resolve => { timer = setTimeout(() => resolve('expired'), turnWaitMs); })]);
      clearTimeout(timer);
      const acknowledgementDeadline = performance.now() + acknowledgementWaitMs;
      while (outcome === 'completed' && !acknowledged && performance.now() < acknowledgementDeadline) { await pause(100); }
      clearInterval(sampler);
      turn = { outcome, submittedAtMs: submitted, turnMs: performance.now() - submitted, acknowledged, after: snapshot(ready, current),
        providerContexts: synthetic.calls.length, hostEvents, samples };
      emit({ event: 'turn', ...turn });
    }
    stage = 'shutdown';
    const shutdownStarted = performance.now();
    await current.shutdown();
    host = null;
    emit({ event: 'result', status: 'passed', attachment: atAttach, healthyAtMs, turn, shutdownMs: performance.now() - shutdownStarted });
    return 0;
  } catch (error) {
    if (host !== null) { try { await host.shutdown(); } catch { /* The driver inspects the root afterwards. */ } }
    emit({ event: 'result', status: 'failed', stage, name: error instanceof Error ? error.constructor.name : typeof error,
      message: error instanceof Error ? error.message : String(error), cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : null });
    return 1;
  }
}

async function providerRefusal(root: string): Promise<number> {
  const image = await ensureNativeHelperImage({ build: true });
  let provider: RefusingProvider | null = null;
  const started = performance.now();
  try {
    const opened = await createChatRuntime(root, phase => emit({ event: 'phase', phase }), { [privateRuntimeStartup]: { providerFactory: (_text, _tools, current) => {
      provider ??= new RefusingProvider(current.supervisor, root); return provider;
    } } }, image);
    emit({ event: 'result', status: opened.result === 'providerUnavailable' ? 'passed' : 'unexpected', result: opened.result,
      starts: (provider as RefusingProvider | null)?.starts ?? 0, durationMs: performance.now() - started });
    if (opened.result === 'ready') { await opened.host.shutdown(); }
    return opened.result === 'providerUnavailable' ? 0 : 1;
  } catch (error) {
    emit({ event: 'result', status: 'failed', message: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started });
    return 1;
  }
}

async function cli(root: string, args: string[]): Promise<number> {
  const lines: string[] = [];
  const progress: unknown[] = [];
  const diagnostics: string[] = [];
  const started = performance.now();
  try {
    const code = await runCli(args, root, text => { lines.push(text); }, event => { progress.push(event); }, text => { diagnostics.push(text); });
    emit({ event: 'result', status: 'returned', code, lines: lines.map(line => line.slice(0, 400)), progress, diagnostics, durationMs: performance.now() - started });
    return code;
  } catch (error) {
    emit({ event: 'result', status: 'threw', message: error instanceof Error ? error.message : String(error), lines, progress, durationMs: performance.now() - started });
    return 1;
  }
}

const [root, mode, ...rest] = process.argv.slice(2);
if (root === undefined || !path.win32.isAbsolute(root) || !existsSync(path.join(root, 'runtime', 'companion.config.json'))) {
  emit({ event: 'result', status: 'refused', message: 'A prepared copied root is required.' });
  process.exitCode = 2;
} else if (mode === 'chat') {
  process.exitCode = await chat(root, rest[0] === '1' ? 1 : 0, rest[1] ?? null);
} else if (mode === 'provider-refusal') {
  process.exitCode = await providerRefusal(root);
} else if (mode === 'cli' && (rest[0] === 'consumer' || rest[0] === 'chat')) {
  // A chat that got past notOwner would build the real provider; the driver points CLAUDE_CONFIG_DIR at an empty folder so it refuses.
  process.exitCode = await cli(root, rest);
} else {
  emit({ event: 'result', status: 'refused', message: 'Unknown mode.' });
  process.exitCode = 2;
}
