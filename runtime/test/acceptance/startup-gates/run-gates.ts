// Private acceptance harness for the Coordinator startup gates. It copies the companion's core and adapter into a fresh
// companion root under the repository's .tmp, points that root's adapter at a folder of staged save copies, enables the
// watcher, hands consumption to the runtime, stages the newest supplied save, then runs gate-main.ts through every gate in
// sequence with the synthetic provider and records each run in a report.
//
// Usage: node run-gates.ts <folder of save copies>
//   The folder holds at least three save copies; they are only read, and the run fails if any changes. The live save folder
//   the repository's adapter names is refused, so the game's own saves are never read or touched.
//   GATES_ONLY=<fragment,...> runs only the runs whose labels contain a fragment, plus the baseline new save.
// Prints one JSON line per run start, end and timeout, and finally the report path; watch-log.mjs follows that output and
// summarize.mjs reads the report.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openBackend } from '../../../src/backend/index.ts';
import { testHelperImage } from '../../support/native-helper.ts';

type Event = Record<string, unknown>;
interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly onEvent?: (event: Event, child: ReturnType<typeof spawn>) => Promise<unknown> | unknown;
  readonly onStart?: () => void;
  readonly timeoutMs?: number;
}

const execute = promisify(execFile);
const newline = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const main = path.join(here, 'gate-main.ts');
const targetScript = path.join(here, 'target-process.ps1');
// Every child run has a deadline; on expiry its whole process tree is killed and the run is recorded as timed out.
const runTimeoutMs = 240000;
const longRunTimeoutMs = 420000;
const helperGraceMs = 30000;
const only = (process.env['GATES_ONLY'] ?? '').split(',').map(part => part.trim()).filter(part => part !== '');
const hash = async (location: string): Promise<string> => createHash('sha256').update(await fs.readFile(location)).digest('hex');
const product = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'HOME'));
const within = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };

// Admit the save folder.
const suppliedSaves = process.argv[2];
if (suppliedSaves === undefined || !path.isAbsolute(suppliedSaves)) { throw new Error('Usage: node run-gates.ts <absolute folder of save copies>'); }
const saveSource = await fs.realpath(suppliedSaves);
const liveSaves = (JSON.parse(await fs.readFile(path.join(repository, 'adapters', 'disco_elysium', 'adapter.json'), 'utf8')) as { saveDirectory: string }).saveDirectory;
const liveSavesReal = await fs.realpath(liveSaves).catch(() => path.resolve(liveSaves));
if (within(liveSavesReal.toLowerCase(), saveSource.toLowerCase())) { throw new Error('The live save folder is refused; supply a folder of copies.'); }
const candidates = (await Promise.all((await fs.readdir(saveSource, { withFileTypes: true })).filter(entry => entry.isFile())
  .map(async entry => ({ name: entry.name, info: await fs.stat(path.join(saveSource, entry.name)) }))))
  .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
if (candidates.length < 3) { throw new Error('The save folder needs at least three save copies.'); }
const sourceHashes = await Promise.all(candidates.slice(0, 3).map(async item => hash(path.join(saveSource, item.name))));

// Prepare the copied root.
const output = path.join(repository, '.tmp', `startup-gates-${randomBytes(4).toString('hex')}`);
const root = path.join(output, 'root');
const emptyProviderConfig = path.join(output, 'empty-provider-config');
const reportPath = path.join(output, 'report.json');
const report: Record<string, unknown> = { root, saveSource, startedAt: new Date().toISOString() };
await fs.mkdir(root, { recursive: true });
await fs.mkdir(emptyProviderConfig);
await fs.cp(path.join(repository, 'core'), path.join(root, 'core'), { recursive: true, errorOnExist: true, force: false });
await fs.cp(path.join(repository, 'adapters', 'disco_elysium'), path.join(root, 'adapters', 'disco_elysium'), { recursive: true, errorOnExist: true, force: false });
const saveDirectory = path.join(root, 'copied-saves');
await fs.mkdir(saveDirectory);
const adapterPath = path.join(root, 'adapters', 'disco_elysium', 'adapter.json');
const adapter = JSON.parse(await fs.readFile(adapterPath, 'utf8')) as Record<string, unknown>;
adapter['saveDirectory'] = saveDirectory;
await fs.writeFile(adapterPath, JSON.stringify(adapter) + newline);
await fs.mkdir(path.join(root, 'runtime', 'instructions'), { recursive: true });
const configPath = path.join(root, 'runtime', 'companion.config.json');
const config = JSON.parse(await fs.readFile(path.join(repository, 'runtime', 'companion.config.json'), 'utf8')) as { watcher: { enabled: boolean } };
assert.equal(config.watcher.enabled, true);
await fs.writeFile(configPath, JSON.stringify(config) + newline, { flag: 'wx' });
await fs.copyFile(path.join(repository, 'runtime', 'instructions', 'runtime-mode.md'), path.join(root, 'runtime', 'instructions', 'runtime-mode.md'));
await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Private copied-root acceptance fixture. Use only supplied state.' + newline, { flag: 'wx' });
const switchScript = path.join(root, 'core', 'Set-CompanionConsumer.ps1');
await execute('pwsh', ['-NoProfile', '-File', switchScript, '-CompanionRoot', root, '-Owner', 'runtime'], { cwd: root, env: product(), windowsHide: true });
await execute('pwsh', ['-NoProfile', '-File', switchScript, '-CompanionRoot', root, '-Owner', 'bridge', '-DeliveryConfirmed'], { cwd: root, env: product(), windowsHide: true });
const backend = await openBackend({ companionRoot: root, nativeImage: await testHelperImage() });
const handover = await backend.startup({ kind: 'consumer', owner: 'runtime', abandonUndelivered: false });
assert.equal(handover.consumerResult?.success, true);
await backend.shutdown(true);

const stagedSaves: { name: string; sha256: string; mtimeMs: number }[] = [];
/** Copies the supplied save at `index` (newest first) into the root, keeping its time or stamping it now so it is newest. */
async function stage(index: number, now: boolean): Promise<void> {
  const source = candidates[index]!;
  const target = path.join(saveDirectory, source.name);
  await fs.copyFile(path.join(saveSource, source.name), target, fs.constants.COPYFILE_EXCL);
  const when = now ? new Date() : source.info.mtime;
  await fs.utimes(target, when, when);
  stagedSaves.push({ name: source.name, sha256: await hash(target), mtimeMs: (await fs.stat(target)).mtimeMs });
}
await stage(0, false);

// Run helpers.
const runs: Event[] = [];
async function act(script: string, action: 'kill' | 'suspend', waitMs: number): Promise<Event> {
  const { stdout } = await execute('pwsh', ['-NoProfile', '-File', targetScript, '-Root', root, '-Script', script, '-Action', action, '-WaitMs', String(waitMs)],
    { env: product(), windowsHide: true, timeout: waitMs + helperGraceMs }).catch((error: unknown) => ({ stdout: String((error as { stdout?: string }).stdout ?? '') }));
  return JSON.parse(stdout.trim() || '{"found":null,"helper":"silent"}') as Event;
}

async function run(label: string, args: string[], options: RunOptions = {}): Promise<Event> {
  if (only.length > 0 && label !== 'new-save' && !only.some(part => label.includes(part))) { console.log(JSON.stringify({ label, event: 'skipped' })); return { label, skipped: true }; }
  const started = performance.now();
  const child = spawn(process.execPath, [main, root, ...args], { cwd: root, env: options.env ?? product(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    console.log(JSON.stringify({ label, event: 'timeout', afterMs: performance.now() - started }));
    void execute('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined);
  }, options.timeoutMs ?? runTimeoutMs);
  console.log(JSON.stringify({ label, event: 'start', pid: child.pid }));
  options.onStart?.();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
  const events: Event[] = [];
  const actions: Promise<unknown>[] = [];
  let attachedMs: number | null = null;
  for await (const line of createInterface({ input: child.stdout })) {
    let event: Event;
    try { event = JSON.parse(line) as Event; } catch { continue; }
    event['harnessMs'] = performance.now() - started;
    if (event['event'] === 'attached') { attachedMs = performance.now() - started; }
    events.push(event);
    if (options.onEvent !== undefined) { actions.push(Promise.resolve(options.onEvent(event, child))); }
  }
  const code = child.exitCode ?? await new Promise<number | null>(resolve => { child.once('exit', resolve); });
  clearTimeout(deadline);
  const acted = await Promise.all(actions);
  const record: Event = { label, args, code, timedOut, attachedMs, durationMs: performance.now() - started, result: events.find(event => event['event'] === 'result') ?? null,
    attached: events.find(event => event['event'] === 'attached') ?? null,
    phases: events.filter(event => event['event'] === 'phase').map(event => `${String(event['phase'])}@${(Number(event['processMs']) / 1000).toFixed(1)}`),
    acted: acted.filter(item => item !== undefined), stderr: code === 0 ? '' : stderr };
  runs.push(record);
  console.log(JSON.stringify({ label, event: 'end', code, timedOut, attachedMs, durationMs: record['durationMs'], status: (record['result'] as Event | null)?.['status'] ?? null }));
  await fs.writeFile(reportPath, JSON.stringify({ ...report, runs, stagedSaves }, null, 2) + newline);
  return record;
}

// Every fault case starts from a verified healthy predecessor: a settling run takes one acknowledged turn, which clears any
// outstanding correction, and must end with ready safety. Its label carries the gate's own so a GATES_ONLY filter keeps it.
async function settle(before: string): Promise<void> {
  const record = await run(`settle-before-${before}`, ['chat', '1']);
  const after = ((record['result'] as Event | null)?.['turn'] as Event | null | undefined)?.['after'] as Event | undefined;
  if (record['skipped'] !== true && after?.['safety'] !== 'ready') { console.log(JSON.stringify({ label: `settle-before-${before}`, event: 'unsettled', after })); }
}
const awaitHealthy = { ...product(), GATE_AWAIT_HEALTHY: '1' };

// Gate: baseline new save and acknowledged restart.
await run('new-save', ['chat', '1']);
await run('acknowledged-restart', ['chat', '1']);

// Gate: entry-point exits. Release to the bridge; chat through the CLI function must then exit notOwner before any provider.
const refusingEnv = { ...product(), CLAUDE_CONFIG_DIR: emptyProviderConfig };
await run('cli-consumer-bridge', ['cli', 'consumer', 'bridge']);
await run('cli-chat-not-owner', ['cli', 'chat'], { env: refusingEnv });
await run('cli-consumer-runtime', ['cli', 'consumer', 'runtime']);
await run('restart-after-rehandover', ['chat', '1']);

// Gate: provider-start refusal, then a healthy start.
await run('provider-refusal', ['provider-refusal']);
await run('restart-after-provider-refusal', ['chat', '0']);

// Gate: a real warm core reply worker failure before its first reply, killed as soon as it appears and killed during
// startup acquisition; each restart is a recovery run.
await settle('worker-killed-on-sight');
let earlyKill: Promise<Event> | null = null;
await run('worker-killed-on-sight', ['chat', '0'], { onStart: () => { earlyKill = act('StartupCoreReplyWorker.ps1', 'kill', 30000); } });
if (earlyKill !== null) { runs.at(-1)!['acted'] = [await earlyKill]; }
await run('restart-after-worker-kill-on-sight', ['chat', '0'], { env: awaitHealthy });
await settle('worker-killed-at-acquisition');
let acquisitionKilled = false;
await run('worker-killed-at-acquisition', ['chat', '0'], { onEvent: async event => {
  if (event['event'] === 'phase' && event['phase'] === 'startupAcquisition' && !acquisitionKilled) { acquisitionKilled = true; return act('StartupCoreReplyWorker.ps1', 'kill', 5000); }
  return undefined;
} });
await run('restart-after-worker-kill-at-acquisition', ['chat', '0'], { env: awaitHealthy });

// Gate: the 120-second interaction gate. A complete acknowledged turn over a newly staged save, then one whose settlement
// core child is suspended so the gate must close the turn, then a restart that must recover.
await settle('interaction-success');
const goSuccess = path.join(output, 'go-success');
await run('interaction-success', ['chat', '1', goSuccess], { onEvent: async event => {
  if (event['event'] === 'awaiting-go') { await stage(1, true); await fs.writeFile(goSuccess, ''); }
} });
const goFailure = path.join(output, 'go-failure');
let suspended: Promise<Event> | null = null;
await run('interaction-settlement-suspended', ['chat', '1', goFailure], { timeoutMs: longRunTimeoutMs, onEvent: async event => {
  if (event['event'] === 'awaiting-go') { suspended = act('Set-StateEventSettlement.ps1', 'suspend', 200000); await stage(2, true); await fs.writeFile(goFailure, ''); }
  if (event['event'] === 'turn' && suspended !== null) {
    const found = await suspended;
    if (found['found'] === true) { await execute('taskkill', ['/PID', String(found['pid']), '/F']).catch(() => undefined); }
    return found;
  }
  return undefined;
} });
await run('recovery-after-suspended-settlement', ['chat', '1'], { env: awaitHealthy, timeoutMs: longRunTimeoutMs });

// Gate: enabled-watcher recovery after a kill at attachment, compared with the same recovery with the watcher disabled. A
// disabled watcher never satisfies the healthy predicate, so its runs record timing and state without awaiting health.
async function killAtAttachment(label: string): Promise<void> {
  await run(label, ['chat', '0'], { onEvent: (event, child) => { if (event['event'] === 'attached') { child.kill(); } } });
}
await settle('killed-at-attachment-watcher-enabled');
await killAtAttachment('killed-at-attachment-watcher-enabled');
await run('recovery-watcher-enabled', ['chat', '0'], { env: awaitHealthy });
await settle('clean-start-watcher-disabled');
await fs.writeFile(configPath, JSON.stringify({ ...config, watcher: { ...config.watcher, enabled: false } }) + newline);
await run('clean-start-watcher-disabled', ['chat', '0']);
await killAtAttachment('killed-at-attachment-watcher-disabled');
await run('recovery-watcher-disabled', ['chat', '0']);
await fs.writeFile(configPath, JSON.stringify(config) + newline);
await run('clean-start-watcher-reenabled', ['chat', '1']);

report['stagedUnchanged'] = await Promise.all(stagedSaves.map(async save => {
  const location = path.join(saveDirectory, save.name);
  return (await hash(location)) === save.sha256 && (await fs.stat(location)).mtimeMs === save.mtimeMs;
}));
report['sourcesUnchanged'] = (await Promise.all(candidates.slice(0, 3).map(async (item, index) => (await hash(path.join(saveSource, item.name))) === sourceHashes[index]))).every(Boolean);
report['finishedAt'] = new Date().toISOString();
await fs.writeFile(reportPath, JSON.stringify({ ...report, runs, stagedSaves }, null, 2) + newline);
console.log(JSON.stringify({ report: reportPath, sourcesUnchanged: report['sourcesUnchanged'], stagedUnchanged: report['stagedUnchanged'] }));
