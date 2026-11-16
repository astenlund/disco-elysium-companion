import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError } from '../../src/admission.ts';
import { openBackend } from '../../src/backend/index.ts';
import { ReleaseJournalForeignEntryError, ReleaseRefusedError } from '../../src/backend/consumer.ts';
import { finishOperatorRun, formatCapacityError, formatCapacityRewind, formatCliError, operatorExitCode, parseCommand, runChatClient, runCli } from '../../src/cli.ts';
import { RuntimeCapacityError } from '../../src/capacity.ts';
import { NativeHelperUnavailableError } from '../../src/native-helper-error.ts';
import type { StartupProgress } from '../../src/startup-progress.ts';
import { JournalForeignEntryError, JournalUnavailableError } from '../../src/journal.ts';
import { capacityRemedy, journalEventsForeignEntryRemedy } from '../../src/text-client.ts';
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
  const output: string[] = [];
  try {
    await fs.symlink(fixture.root, junction, 'junction');
    try {
      // Act
      const code = await runCli(['status'], junction, text => output.push(text));

      // Assert
      assert.equal(code, 0);
      assert.equal(typeof (JSON.parse(output[0]!) as { initialized?: unknown }).initialized, 'boolean');
    } finally {
      await fs.rm(junction, { force: true });
    }
  } finally {
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

test('a startup capacity refusal names its inventory failure cause with the remedy and no path', () => {
  const cases = [
    ['workspaceResidue', /guarded cleanup runs\. Residue that cleanup does not recognize stays; move it out by hand/],
    ['helperUnavailable', /native helper could not answer; run status outside chat to check the helper/],
    ['foreignEntryQuarantine', /sits in quarantine; move it out by hand, since the runtime never deletes it/],
    ['inventoryUnreadable', /could not be read; restore its readability/],
  ] as const;
  for (const [reason, remedy] of cases) {
    // Arrange
    const refusal = new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: [reason] }, 'runtimeMarker');
    const wrapped = new DataRootUnavailableError('internal path must not appear', { cause: refusal });

    // Act
    const rendered = formatCliError(wrapped);

    // Assert
    assert.match(rendered, new RegExp(`^dataRootUnavailable: capacity unavailable \\(runtimeMarker: ${reason}\\); owed: `));
    assert.match(rendered, remedy);
    assert.equal(rendered.split(capacityRemedy(reason)).length, 2, 'the remedy appears exactly once');
    assert.doesNotMatch(rendered, /exit chat/, 'this line is printed after chat has ended');
    assert.doesNotMatch(formatCapacityError(refusal), remedy, 'the operator readout already carries the remedy beside this line');
    assert.doesNotMatch(rendered, /internal path/);
  }
});

test('a refused bridge release names its known reasons while other errors keep their format', () => {
  // Arrange
  const refusal = new ReleaseRefusedError(['2 outbox records', '3 unacknowledged events', 'repair-0123456789abcdef0123456789abcdef', 'recoveryDisclosureOwed']);
  const coded = Object.assign(new Error('Another runtime holds the root.'), { code: 'runtimeAlreadyRunning' });

  // Act
  const rendered = formatCliError(refusal);

  // Assert
  assert.equal(rendered, 'undelivered: Explicit abandonment is required before releasing undelivered state. '
    + 'Reasons: 2 outbox records, 3 unacknowledged events, repair-0123456789abcdef0123456789abcdef, recoveryDisclosureOwed.');
  assert.equal(formatCliError(new ReleaseRefusedError([])), 'undelivered: Explicit abandonment is required before releasing undelivered state.');
  assert.equal(formatCliError(coded), 'runtimeAlreadyRunning: Another runtime holds the root.');
  assert.equal(formatCliError(new Error('plain failure')), 'runtimeUnavailable: plain failure');
  assert.equal(formatCliError('not an error'), 'runtimeUnavailable: Runtime operation failed.');
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

test('an operator run settles through the shared cleanup rule, mapping its exit code and classifying a failed shutdown', async () => {
  // Arrange: the cleanup rule's full case matrix is tested on finishAfterCleanup itself; this pins the operator wiring.
  const startupFailure = new Error('Native process metadata is unavailable.');
  const failingShutdown = async (): Promise<void> => { throw new Error('Shutdown could not prove quiescence.'); };

  // Act
  const [failed, clean] = await Promise.allSettled([
    finishOperatorRun({ failure: startupFailure }, failingShutdown, { exhausted: true }),
    finishOperatorRun({ exitCode: 1 }, async () => {}, { exhausted: true })]);

  // Assert
  assert.equal(failed.status, 'rejected');
  const refusal = (failed as PromiseRejectedResult).reason;
  assert.ok(refusal instanceof NativeHelperUnavailableError && refusal.reason === 'unavailable' && refusal.cause === startupFailure);
  assert.deepEqual(clean, { status: 'fulfilled', value: 1 });
});

/** Opens and closes a backend so the fixture's scope exists, then writes a file the runtime does not own into its journal/events. */
async function strayJournalEvent(root: string): Promise<void> {
  const backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: root });
  const events = path.join(backend.scope.dataRoot, 'journal', 'events');
  await backend.shutdown(true);
  await fs.mkdir(events, { recursive: true });
  await fs.writeFile(path.join(events, 'notes.txt'), 'stray');
}

for (const args of [['repair'], ['consumer', 'bridge'], ['consumer', 'bridge', '--abandon-undelivered']]) {
  test(`${args.join(' ')} over a stray journal/events file names the foreign entry and its remedy once`, { timeout: 600000 }, async () => {
    // Arrange
    await testHelperImage();
    const fixture = await companionFixture('runtime-owned-empty');
    const output: string[] = [];
    try {
      await strayJournalEvent(fixture.root);

      // Act
      let failure: unknown = null;
      try { await runCli(args, fixture.root, text => output.push(text), () => {}, () => {}); } catch (error) { failure = error; }

      // Assert: the bridge refuses with the named reason before listing journal/events; repair reports it beside its readout.
      const rendered = [...output, ...failure === null ? [] : [formatCliError(failure)]].join('\n');
      if (args[0] === 'consumer') {
        assert.ok(failure instanceof ReleaseJournalForeignEntryError, String(failure));
        assert.match(formatCliError(failure), /^journalForeignEntry: /);
      } else {
        assert.equal(failure, null, String(failure));
        assert.ok(output.includes(`The journal is unavailable. ${journalEventsForeignEntryRemedy}`), rendered);
      }
      assert.equal(rendered.split(journalEventsForeignEntryRemedy).length - 1, 1, rendered);
      assert.doesNotMatch(rendered, /Persisted control metadata is invalid/);
      assert.doesNotMatch(rendered, /notes\.txt/);
    } finally { await fixture.close(); }
  });
}

test('a hand-over from the bridge over a stray journal/events file names the foreign entry and its remedy', { timeout: 600000 }, async () => {
  // Arrange: release the fixture to the bridge, so consumer runtime hands over and then reads the journal.
  const fixture = await companionFixture('runtime-owned-empty');
  try {
    const backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
    try { assert.equal((await backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true })).consumerResult?.success, true); }
    finally { await backend.shutdown(true); }
    await strayJournalEvent(fixture.root);

    // Act
    const failure = await runCli(['consumer', 'runtime'], fixture.root, () => {}, () => {}, () => {}).then(() => null, (error: unknown) => error);

    // Assert
    assert.ok(failure instanceof Error, String(failure));
    const rendered = formatCliError(failure);
    assert.match(rendered, /^journalForeignEntry: /);
    assert.equal(rendered.split(journalEventsForeignEntryRemedy).length - 1, 1, rendered);
    assert.doesNotMatch(rendered, /notes\.txt/);
  } finally { await fixture.close(); }
});

test('chat on a bridge-owned root exits notOwner before any provider phase', { timeout: 600000 }, async () => {
  // Arrange: release the fixture to the bridge. A chat that got past notOwner would build the real provider, so the provider
  // configuration folder points at an empty folder for the duration as a safety net.
  const fixture = await companionFixture('runtime-owned-empty');
  const emptyConfig = path.join(fixture.root, 'empty-provider-config');
  const previousConfig = process.env['CLAUDE_CONFIG_DIR'];
  const output: string[] = [];
  const progress: StartupProgress[] = [];
  try {
    const backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: fixture.root });
    try { assert.equal((await backend.startup({ kind: 'consumer', owner: 'bridge', abandonUndelivered: true })).consumerResult?.success, true); }
    finally { await backend.shutdown(true); }
    await fs.mkdir(emptyConfig);
    process.env['CLAUDE_CONFIG_DIR'] = emptyConfig;

    // Act
    const code = await runCli(['chat'], fixture.root, text => output.push(text), event => progress.push(event), () => {});

    // Assert
    assert.equal(code, 1);
    assert.deepEqual(output, ['notOwner: Continue in the bridge client, or explicitly run consumer runtime to hand ownership over.']);
    assert.equal(progress.at(-1)?.kind, 'notOwner');
    const phases = progress.flatMap(event => event.kind === 'phase' && event.phase !== null ? [event.phase] : []);
    assert.equal(phases.some(phase => phase.startsWith('provider')), false, phases.join(', '));
  } finally {
    if (previousConfig === undefined) { delete process.env['CLAUDE_CONFIG_DIR']; } else { process.env['CLAUDE_CONFIG_DIR'] = previousConfig; }
    await fixture.close();
  }
});

test('a foreign journal/events failure names its reason and remedy however it is wrapped', () => {
  // Arrange
  const foreign = new JournalForeignEntryError('Journal inventory contains an entry it does not own.');
  const wrapped = new Error('Startup failed.', { cause: foreign });
  const generic = new JournalUnavailableError('Journal inventory is unavailable.');

  // Act
  const rendered = [foreign, wrapped].map(formatCliError);

  // Assert
  for (const line of rendered) {
    assert.match(line, /^journalForeignEntry: /);
    assert.equal(line.split(journalEventsForeignEntryRemedy).length - 1, 1, line);
  }
  assert.equal(formatCliError(generic).includes(journalEventsForeignEntryRemedy), false);
});

test('the chat client exit takes the exhausted-helper classification only while the helper is exhausted', async () => {
  // Arrange
  const clientFailure = new Error('Shutdown could not prove quiescence.');
  const failingClient = async (): Promise<void> => { throw clientFailure; };

  // Act
  const [exhausted, serving, clean] = await Promise.allSettled([
    runChatClient({ host: null, helper: { exhausted: true } }, failingClient),
    runChatClient({ host: null, helper: { exhausted: false } }, failingClient),
    runChatClient({ host: null, helper: { exhausted: true } }, async () => {})]);

  // Assert
  assert.equal(exhausted.status, 'rejected');
  const refusal = (exhausted as PromiseRejectedResult).reason;
  assert.ok(refusal instanceof NativeHelperUnavailableError && refusal.reason === 'unavailable' && refusal.cause === clientFailure);
  assert.deepEqual(serving, { status: 'rejected', reason: clientFailure });
  assert.deepEqual(clean, { status: 'fulfilled', value: undefined });
});
