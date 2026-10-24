import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { formatCapacityError, formatCapacityRewind, formatCliError, operatorExitCode, parseCommand, runCli } from '../../src/cli.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import type { StartupProgress } from '../../src/startup-progress.ts';
import { companionFixture } from '../support/companion.ts';
import { testHelperImage } from '../support/native-helper.ts';

test('CLI admits exactly the four command grammars without touching state on invalid input', async () => {
  assert.deepEqual(parseCommand([]), { kind: 'chat' });
  for (const kind of ['chat', 'status', 'repair'] as const) { assert.deepEqual(parseCommand([kind]), { kind }); }
  assert.deepEqual(parseCommand(['consumer', 'runtime']), { kind: 'consumer', owner: 'runtime', abandonUndelivered: false });
  assert.deepEqual(parseCommand(['consumer', 'bridge', '--abandon-undelivered']), { kind: 'consumer', owner: 'bridge', abandonUndelivered: true });
  for (const args of [['other'], ['status', 'extra'], ['consumer'], ['consumer', 'Runtime'], ['consumer', 'runtime', '--abandon-undelivered'], ['consumer', 'bridge', '--force']]) {
    assert.equal(parseCommand(args), null);
    const output: string[] = [];
    assert.equal(await runCli(args, 'C:/intentionally-nonexistent-fixture', text => output.push(text)), 2);
    assert.equal(output.length, 1);
    assert.match(output[0]!, /^Usage:/);
  }
});

test('failed chat startup reports a terminal progress event without exposing its root', async () => {
  // Arrange: the shared pinned test image, so the chat build step finds the image ready and its own reporter emits nothing.
  await testHelperImage();
  const output: string[] = [];
  const progress: StartupProgress[] = [];

  // Act
  await assert.rejects(runCli(['chat'], 'C:/intentionally-nonexistent-fixture', text => output.push(text), event => progress.push(event)));

  // Assert
  assert.deepEqual(progress.map(event => event.kind), ['phase', 'failed']);
  assert.equal(progress[0]?.phase, 'configuration');
  assert.equal(progress.at(-1)?.phase, null);
  assert.ok(progress.every(event => !JSON.stringify(event).includes('intentionally-nonexistent-fixture')));
  assert.deepEqual(output, []);
});

test('status through a junction spelling of the companion root starts the helper service on its canonical root', { timeout: 240000 }, async () => {
  // Arrange: a runtime fixture reached through a junction, the kind of spelling the helper service refuses to admit.
  await testHelperImage();
  const fixture = await companionFixture('runtime');
  const junction = path.join(path.dirname(fixture.root), `junction-${randomUUID()}`);
  await fs.symlink(fixture.root, junction, 'junction');
  const output: string[] = [];
  try {
    // Act
    const code = await runCli(['status'], junction, text => output.push(text));

    // Assert
    assert.equal(code, 0);
    assert.equal(typeof (JSON.parse(output[0]!) as { initialized?: unknown }).initialized, 'boolean');
  } finally {
    await fs.rm(junction);
    await fixture.close();
  }
});

test('a successful bridge release exits successfully even though runtime is no longer owner', () => {
  assert.equal(operatorExitCode('consumer', { notOwner: true, consumerResult: { success: true, value: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: false, abandonedCount: 0 } }, requiredWorkCompleted: true, capacityRewind: null }), 0);
  assert.equal(operatorExitCode('consumer', { notOwner: true, consumerResult: null, requiredWorkCompleted: true, capacityRewind: null }), 1);
  assert.equal(operatorExitCode('repair', { notOwner: true, consumerResult: null, requiredWorkCompleted: true, capacityRewind: null }), 1);
  assert.equal(operatorExitCode('repair', { notOwner: false, consumerResult: null, requiredWorkCompleted: false, capacityRewind: null }), 1);
  assert.equal(operatorExitCode('repair', { notOwner: false, consumerResult: null, requiredWorkCompleted: true, capacityRewind: null }), 0);
});

test('startup capacity errors retain the outer fatal code and unknown owed values', () => {
  const unavailable = new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: ['scopeAuthority'] }, 'runtimeMarker');
  assert.match(formatCapacityError(unavailable), /^capacity unavailable \(runtimeMarker: scopeAuthority\); owed: unacknowledgedEvents=unknown/);
  const exhausted = new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['journal/events:bytes', 'freeSpace'] }, 'release');
  assert.match(formatCapacityError(exhausted), /^capacity exhausted \(release: freeSpace, documentBytes\); owed: unacknowledgedEvents=unknown/);
  assert.match(formatCapacityError(exhausted), /historyDisclosure=unknown$/);
  const wrapped = new DataRootUnavailableError('internal path must not appear', { cause: unavailable });
  assert.match(formatCliError(wrapped), /^dataRootUnavailable: capacity unavailable \(runtimeMarker: scopeAuthority\)/);
  assert.doesNotMatch(formatCliError(wrapped), /internal path/);
});

test('repair prints a generic caution before opening backend and stops on synchronous writer failure', async () => {
  const writerFailure = new Error('writer unavailable');
  let calls = 0;
  await assert.rejects(runCli(['repair'], 'C:/intentionally-nonexistent-fixture', text => {
    calls += 1;
    assert.match(text, /if a capacity rewind is admitted/);
    assert.match(text, /Surviving exact core records remain replayable/);
    assert.doesNotMatch(text, /sequence|range|selected/);
    throw writerFailure;
  }), error => error === writerFailure);
  assert.equal(calls, 1);
});

test('repair extent renders only the typed plan result, preserving unknown and empty cases', () => {
  assert.equal(formatCapacityRewind(null), 'capacity rewind: none selected or resumed');
  const unknown = { affectedEvents: null, fromSequence: null, throughSequence: null, retainedHandoffs: null, replayableHandoffs: null, presentationRetiredHandoffs: null, survivingCoreRecords: null };
  assert.match(formatCapacityRewind(unknown), /affectedEvents=unknown; inclusiveRange=unknown/);
  assert.match(formatCapacityRewind(unknown), /survivingCoreRecords=unknown; extent unverified; repair incomplete$/);
  assert.equal(operatorExitCode('repair', { notOwner: false, consumerResult: null, requiredWorkCompleted: true, capacityRewind: unknown }), 1);
  assert.match(formatCapacityRewind({ ...unknown, affectedEvents: 0 }), /affectedEvents=0; inclusiveRange=none/);
  const incomplete = { ...unknown, affectedEvents: 3 };
  assert.match(formatCapacityRewind(incomplete), /affectedEvents=unknown; inclusiveRange=unknown/);
  assert.equal(operatorExitCode('repair', { notOwner: false, consumerResult: null, requiredWorkCompleted: true, capacityRewind: incomplete }), 1);
  const known = { affectedEvents: 3, fromSequence: 2, throughSequence: 4, retainedHandoffs: 2, replayableHandoffs: 1, presentationRetiredHandoffs: 1, survivingCoreRecords: null };
  const rendered = formatCapacityRewind(known);
  assert.match(rendered, /affectedEvents=3; inclusiveRange=2\.\.4/);
  assert.match(rendered, /retainedHandoffs=2; replayableHandoffs=1; presentationRetiredHandoffs=1; survivingCoreRecords=unknown/);
});
