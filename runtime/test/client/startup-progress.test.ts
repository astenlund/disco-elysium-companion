import assert from 'node:assert/strict';
import test from 'node:test';

import { formatStartupProgress, reportStartupPhase, startupHeartbeatMs, StartupProgressReporter, type StartupProgress } from '../../src/startup-progress.ts';

test('startup progress reports timestamped phases, bounded heartbeats and one terminal result', async () => {
  assert.equal(startupHeartbeatMs, 15000);
  const events: StartupProgress[] = [];
  let elapsedMs = 0;
  const reporter = new StartupProgressReporter(event => events.push(event), 10, () => elapsedMs, () => new Date('2026-10-13T13:00:00.000Z'));
  reporter.phase('providerPrestart');
  reporter.phase('streamRecovery');
  elapsedMs = 31000;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(events.some(event => event.kind === 'heartbeat' && event.phase === 'streamRecovery'));
  reporter.phase('providerSelection');
  reporter.phase('providerStart');
  reporter.phase('providerFallback');
  reporter.phase('providerStart');
  reporter.phase('providerRetry');
  reporter.phase('providerStart');
  reporter.phase('providerBinding');
  reporter.phase('attachmentSafety');
  reporter.phase('startupWorkerClosure');
  reporter.finish('ready');
  reporter.finish('failed');
  const count = events.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(events.length, count);
  assert.deepEqual(events.filter(event => event.kind === 'ready' || event.kind === 'failed').map(event => event.kind), ['ready']);
  assert.deepEqual(events.filter(event => event.kind === 'phase').map(event => event.phase),
    ['providerPrestart', 'streamRecovery', 'providerSelection', 'providerStart', 'providerFallback', 'providerStart', 'providerRetry', 'providerStart', 'providerBinding', 'attachmentSafety', 'startupWorkerClosure']);
  assert.equal(formatStartupProgress(events[0]!), '[2026-10-13T13:00:00.000Z] startup: checking guarded unbound provider startup; elapsed 0s');
  assert.equal(formatStartupProgress(events.find(event => event.kind === 'heartbeat')!), '[2026-10-13T13:00:00.000Z] startup: reconciling recovery; elapsed 31s; still working');
  assert.equal(formatStartupProgress(events.find(event => event.phase === 'providerSelection')!), '[2026-10-13T13:00:00.000Z] startup: checking provider safety and session binding; elapsed 31s');
  assert.equal(formatStartupProgress(events.find(event => event.phase === 'providerFallback')!), '[2026-10-13T13:00:00.000Z] startup: switching to a fresh provider session; elapsed 31s');
  assert.equal(formatStartupProgress(events.find(event => event.phase === 'providerRetry')!), '[2026-10-13T13:00:00.000Z] startup: waiting to retry provider startup; elapsed 31s');
  assert.equal(formatStartupProgress(events.find(event => event.phase === 'providerBinding')!), '[2026-10-13T13:00:00.000Z] startup: binding the provider session durably; elapsed 31s');
  assert.equal(formatStartupProgress(events.find(event => event.phase === 'attachmentSafety')!), '[2026-10-13T13:00:00.000Z] startup: checking final attachment safety; elapsed 31s');
  assert.equal(formatStartupProgress(events.find(event => event.phase === 'startupWorkerClosure')!), '[2026-10-13T13:00:00.000Z] startup: closing startup workers; elapsed 31s');
  assert.equal(formatStartupProgress(events.at(-1)!), '[2026-10-13T13:00:00.000Z] startup: chat client ready; elapsed 31s');
});

test('progress sink failure does not change startup outcome', () => {
  const reporter = new StartupProgressReporter(() => { throw new Error('sink failed'); });
  assert.doesNotThrow(() => { reporter.phase('configuration'); reporter.finish('failed'); });
  assert.doesNotThrow(() => reportStartupPhase(() => { throw new Error('callback failed'); }, 'providerStart'));
});

test('terminal progress distinguishes ownership and provider refusal from startup failure', () => {
  const at = '2026-10-13T13:00:00.000Z';
  const terminal = (kind: 'notOwner' | 'providerUnavailable' | 'failed'): string => formatStartupProgress({ kind, phase: null, at, elapsedMs: 1250 });
  assert.equal(terminal('notOwner'), `[${at}] startup: stopped: runtime is not the consumer; elapsed 1s`);
  assert.equal(terminal('providerUnavailable'), `[${at}] startup: stopped: provider unavailable; elapsed 1s`);
  assert.equal(terminal('failed'), `[${at}] startup: failed; elapsed 1s`);
});

test('absent compiled images disclose the fallback and its separate selection time', () => {
  const events: StartupProgress[] = [];
  let elapsed = 0;
  const reporter = new StartupProgressReporter(event => events.push(event), 15000,
    () => elapsed, () => new Date('2026-10-13T13:00:00.000Z'));
  reporter.phase('scopeAdmission');
  elapsed = 6200;
  reporter.imageAbsent(4100);
  reporter.finish('ready');
  assert.equal(formatStartupProgress(events[1]!),
    '[2026-10-13T13:00:00.000Z] startup: compiled images absent; using PowerShell fallback; image selection 4s; elapsed 6s');
  assert.equal(events[1]!.selectionMs, 4100);
  assert.equal(events[2]!.kind, 'ready');
});
