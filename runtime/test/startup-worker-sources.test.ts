import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeOperationError, type PathInspector } from '../src/admission.ts';
import type { JsonValue } from '../src/json.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { observeStartupWorkerSources, startupWorkerInstallationRoot } from '../src/startup-worker-sources.ts';

const scope = { companionRoot: 'C:/private-companion', dataRoot: 'C:/private-companion/data', bindingSha256: 'a'.repeat(64) } as RuntimeScope;
const present = { status: 'present', scopeSha256: scope.bindingSha256, coreReplySha256: 'c'.repeat(64) };

function inspector(reply: () => JsonValue | Promise<JsonValue>): Pick<PathInspector, 'native'> {
  return { native: async (op, fields) => {
    assert.equal(op, 'coreReplySource');
    assert.deepEqual(fields, { companionRoot: scope.companionRoot, dataRoot: scope.dataRoot, sourceRoot: startupWorkerInstallationRoot });
    return reply();
  } };
}

test('accepts one complete scoped source observation and an explicit absent temporary root', async () => {
  // Arrange
  let calls = 0;
  const observed = inspector(() => ++calls === 1 ? present : { status: 'absent' });

  // Act
  const first = await observeStartupWorkerSources(observed, scope);
  const second = await observeStartupWorkerSources(observed, scope);

  // Assert
  assert.deepEqual(first, { scopeSha256: present.scopeSha256, coreReplySha256: present.coreReplySha256 });
  assert.equal(second, null);
});

test('rejects partial, foreign and failed source observations without a worker digest', async () => {
  // Arrange
  const replies: (() => JsonValue)[] = [
    () => ({ status: 'present', scopeSha256: scope.bindingSha256 }),
    () => ({ ...present, scopeSha256: '0'.repeat(64) }),
    () => ({ ...present, coreReplySha256: '0'.repeat(63) }),
    () => ({ status: 'absent', coreReplySha256: present.coreReplySha256 }),
    () => ({ ...present, metadataSha256: 'b'.repeat(64) }),
    () => { throw new NativeOperationError('sourceUnavailable'); },
  ];

  // Act and assert
  for (const reply of replies) { await assert.rejects(observeStartupWorkerSources(inspector(reply), scope)); }
});
