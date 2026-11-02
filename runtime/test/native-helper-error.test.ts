import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCliError } from '../src/cli.ts';
import { finishAfterCleanup, NativeHelperUnavailableError } from '../src/native-helper-error.ts';

const exhausted = { exhausted: true };
const serving = { exhausted: false };

function reason(settled: PromiseSettledResult<unknown>): unknown {
  return settled.status === 'rejected' ? settled.reason : assert.fail('The step did not fail.');
}

test('a cleanup that fails while the helper is exhausted keeps the earlier outcome and reports it as the helper refusal', async () => {
  // Arrange
  const stepFailure = new Error('Native process metadata is unavailable.');
  const refusal = new NativeHelperUnavailableError('bindFailed');
  const cleanupFailure = new Error('Cleanup could not prove quiescence.');
  const failingCleanup = async (): Promise<void> => { throw cleanupFailure; };

  // Act
  const [afterFailure, afterRefusal, afterSuccess] = await Promise.allSettled([
    finishAfterCleanup({ failure: stepFailure }, failingCleanup, exhausted),
    finishAfterCleanup({ failure: refusal }, failingCleanup, exhausted),
    finishAfterCleanup({ value: 'done' }, failingCleanup, exhausted)]);

  // Assert
  const classified = reason(afterFailure);
  assert.ok(classified instanceof NativeHelperUnavailableError && classified.reason === 'unavailable' && classified.cause === stepFailure);
  assert.match(formatCliError(classified), /^nativeHelperUnavailable \(unavailable\): .*Restart the runtime\.$/);
  assert.equal(reason(afterRefusal), refusal);
  const afterSuccessRefusal = reason(afterSuccess);
  assert.ok(afterSuccessRefusal instanceof NativeHelperUnavailableError && afterSuccessRefusal.reason === 'unavailable' && afterSuccessRefusal.cause === cleanupFailure);
});

test('a cleanup that fails while the helper can still serve replaces the outcome unclassified', async () => {
  // Arrange
  const stepFailure = new Error('Native process metadata is unavailable.');
  const cleanupFailure = new Error('Cleanup could not prove quiescence.');

  // Act
  const [failedStep, failedCleanup, clean] = await Promise.allSettled([
    finishAfterCleanup({ failure: stepFailure }, async () => {}, serving),
    finishAfterCleanup({ failure: stepFailure }, async () => { throw cleanupFailure; }, serving),
    finishAfterCleanup({ value: 'done' }, async () => {}, exhausted)]);

  // Assert
  assert.equal(reason(failedStep), stepFailure);
  assert.equal(reason(failedCleanup), cleanupFailure);
  assert.deepEqual(clean, { status: 'fulfilled', value: 'done' });
});
