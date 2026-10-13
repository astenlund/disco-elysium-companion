import assert from 'node:assert/strict';
import test from 'node:test';

import { formatStartupProgress, startupHeartbeatMs, StartupProgressReporter, type StartupProgress } from '../../src/startup-progress.ts';

test('startup progress reports timestamped phases, bounded heartbeats and one terminal result', async () => {
  assert.equal(startupHeartbeatMs, 15000);
  const events: StartupProgress[] = [];
  let elapsedMs = 0;
  const reporter = new StartupProgressReporter(event => events.push(event), 10, () => elapsedMs, () => new Date('2026-10-13T13:00:00.000Z'));
  reporter.phase('streamRecovery');
  elapsedMs = 31000;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(events.some(event => event.kind === 'heartbeat' && event.phase === 'streamRecovery'));
  reporter.phase('providerStart');
  reporter.finish('ready');
  reporter.finish('failed');
  const count = events.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(events.length, count);
  assert.deepEqual(events.filter(event => event.kind === 'ready' || event.kind === 'failed').map(event => event.kind), ['ready']);
  assert.equal(formatStartupProgress(events[0]!), '[2026-10-13T13:00:00.000Z] startup: reconciling recovery; elapsed 0s');
  assert.equal(formatStartupProgress(events.find(event => event.kind === 'heartbeat')!), '[2026-10-13T13:00:00.000Z] startup: reconciling recovery; elapsed 31s; still working');
  assert.equal(formatStartupProgress(events.at(-1)!), '[2026-10-13T13:00:00.000Z] startup: chat client ready; elapsed 31s');
});

test('progress sink failure does not change startup outcome', () => {
  const reporter = new StartupProgressReporter(() => { throw new Error('sink failed'); });
  assert.doesNotThrow(() => { reporter.phase('configuration'); reporter.finish('failed'); });
});

test('terminal progress distinguishes ownership and provider refusal from startup failure', () => {
  const at = '2026-10-13T13:00:00.000Z';
  const terminal = (kind: 'notOwner' | 'providerUnavailable' | 'failed'): string => formatStartupProgress({ kind, phase: null, at, elapsedMs: 1250 });
  assert.equal(terminal('notOwner'), `[${at}] startup: stopped: runtime is not the consumer; elapsed 1s`);
  assert.equal(terminal('providerUnavailable'), `[${at}] startup: stopped: provider unavailable; elapsed 1s`);
  assert.equal(terminal('failed'), `[${at}] startup: failed; elapsed 1s`);
});
