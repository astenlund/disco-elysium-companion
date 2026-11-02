import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeHelperUnavailableError } from '../../src/native-helper-error.ts';
import { settleStatusRead, StatusIdentityError } from '../../src/platform/status.ts';

test('a status read settles through the shared cleanup rule, keeping its failure when the cleanup fails while the helper is exhausted', async () => {
  // Arrange: the cleanup rule's full case matrix is tested on finishAfterCleanup itself; this pins the status wiring.
  const principalFailure = new StatusIdentityError('Windows principal is unavailable.');
  const failingClose = async (): Promise<void> => { throw new Error('The helper service exit could not be observed.'); };

  // Act
  const [settled] = await Promise.allSettled([settleStatusRead(async () => { throw principalFailure; }, failingClose, { exhausted: true })]);

  // Assert
  assert.equal(settled!.status, 'rejected');
  const refusal = (settled as PromiseRejectedResult).reason;
  assert.ok(refusal instanceof NativeHelperUnavailableError && refusal.reason === 'unavailable' && refusal.cause === principalFailure);
});
