import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCliError } from '../../src/cli.ts';
import { NativeHelperUnavailableError } from '../../src/native-helper-error.ts';
import { settleStatusRead, StatusIdentityError } from '../../src/platform/status.ts';

const exhausted = { exhausted: true };
const serving = { exhausted: false };

function reason(settled: PromiseSettledResult<unknown>): unknown {
  return settled.status === 'rejected' ? settled.reason : assert.fail('The status read did not fail.');
}

test('a status cleanup that fails while the helper is exhausted keeps the read failure and reports it as the helper refusal', async () => {
  // Arrange
  const principalFailure = new StatusIdentityError('Windows principal is unavailable.');
  const bindRefusal = new NativeHelperUnavailableError('serviceStart');
  const closeFailure = new Error('The helper service exit could not be observed.');
  const failingClose = async (): Promise<void> => { throw closeFailure; };

  // Act
  const [afterFailure, afterRefusal, afterSuccess] = await Promise.allSettled([
    settleStatusRead(async () => { throw principalFailure; }, failingClose, exhausted),
    settleStatusRead(async () => { throw bindRefusal; }, failingClose, exhausted),
    settleStatusRead(async () => 'status', failingClose, exhausted)]);

  // Assert
  const refusal = reason(afterFailure);
  assert.ok(refusal instanceof NativeHelperUnavailableError && refusal.reason === 'unavailable' && refusal.cause === principalFailure);
  assert.match(formatCliError(refusal), /^nativeHelperUnavailable \(unavailable\): .*Restart the runtime\.$/);
  assert.equal(reason(afterRefusal), bindRefusal);
  const closeRefusal = reason(afterSuccess);
  assert.ok(closeRefusal instanceof NativeHelperUnavailableError && closeRefusal.reason === 'unavailable' && closeRefusal.cause === closeFailure);
});

test('a status cleanup that fails while the helper can still serve replaces the outcome unclassified', async () => {
  // Arrange
  const principalFailure = new StatusIdentityError('Windows principal is unavailable.');
  const closeFailure = new Error('The helper service exit could not be observed.');

  // Act
  const [failedRead, failedClose, clean] = await Promise.allSettled([
    settleStatusRead(async () => { throw principalFailure; }, async () => {}, serving),
    settleStatusRead(async () => { throw principalFailure; }, async () => { throw closeFailure; }, serving),
    settleStatusRead(async () => 'status', async () => {}, exhausted)]);

  // Assert
  assert.equal(reason(failedRead), principalFailure);
  assert.equal(reason(failedClose), closeFailure);
  assert.deepEqual(clean, { status: 'fulfilled', value: 'status' });
});
