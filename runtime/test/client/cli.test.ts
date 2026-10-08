import assert from 'node:assert/strict';
import test from 'node:test';

import { operatorExitCode, parseCommand, runCli } from '../../src/cli.ts';

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

test('a successful bridge release exits successfully even though runtime is no longer owner', () => {
  assert.equal(operatorExitCode('consumer', { notOwner: true, consumerResult: { success: true, value: { owner: 'bridge', previousOwner: 'runtime', changed: true, baselineRemoved: false, abandonedCount: 0 } } }, false), 0);
  assert.equal(operatorExitCode('consumer', { notOwner: true, consumerResult: null }, false), 1);
  assert.equal(operatorExitCode('repair', { notOwner: true, consumerResult: null }, false), 1);
});
