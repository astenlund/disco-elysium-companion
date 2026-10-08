import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FileOperationGuard, type FileAdmission } from '../src/file-operation.ts';

const identity = { providerInstance: 'provider-a', toolUseId: 'tool-a' };
const admitted: FileAdmission = { canonicalInput: Object.freeze({ file_path: 'admitted-file' }), evidence: Object.freeze({ identity: 'file-object' }) };
function pending<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('file-operation ownership', () => {
  it('starts unavailable and claims preflight before asynchronous work, rejecting overlap', async () => {
    const guard = new FileOperationGuard({ held: true });
    assert.equal((await guard.request(identity, async () => admitted)).allowed, false);
    assert.equal(guard.admitQuiescentNamespace(), true);
    const scan = pending<FileAdmission | null>();
    const first = guard.request(identity, () => scan.promise);
    assert.equal(guard.state, 'preflight');
    assert.equal((await guard.request({ ...identity, toolUseId: 'other' }, async () => admitted)).allowed, false);
    assert.deepEqual(guard.identity, identity);
    scan.resolve(admitted);
    assert.equal((await first).allowed, true);
    assert.equal(guard.state, 'permitted');
    assert.deepEqual(guard.admission, admitted);
    guard.completed({ ...identity, providerInstance: 'stale' }, true);
    assert.equal(guard.state, 'permitted');
    guard.completed(identity, true);
    assert.equal(guard.state, 'idle');
    assert.equal(guard.admission, null);
  });

  it('preserves uncertain native work until correlated completion or verified termination', async () => {
    const guard = new FileOperationGuard({ held: true });
    guard.admitQuiescentNamespace();
    assert.equal((await guard.request(identity, async () => admitted)).allowed, true);
    guard.cancelled(identity);
    assert.equal(guard.state, 'uncertain');
    assert.equal(guard.admitQuiescentNamespace(), false);
    assert.equal((await guard.request({ providerInstance: 'new', toolUseId: 'new' }, async () => admitted)).allowed, false);
    guard.providerTerminated('new');
    assert.equal(guard.state, 'uncertain');
    guard.providerTerminated(identity.providerInstance);
    assert.equal(guard.state, 'idle');
  });

  it('denies a late preflight result and retains ownership until the scan actually stops', async () => {
    const guard = new FileOperationGuard({ held: true });
    guard.admitQuiescentNamespace();
    const scan = pending<FileAdmission | null>();
    const request = guard.request(identity, () => scan.promise);
    guard.providerTerminated(identity.providerInstance);
    assert.equal(guard.state, 'uncertain');
    assert.equal(guard.admitQuiescentNamespace(), false);
    scan.resolve(admitted);
    assert.equal((await request).allowed, false);
    assert.equal(guard.state, 'idle');
  });

  it('requires native quiescence after a completion that arrived before permission', async () => {
    const guard = new FileOperationGuard({ held: true });
    guard.admitQuiescentNamespace();
    const scan = pending<FileAdmission | null>();
    const request = guard.request(identity, () => scan.promise);
    guard.completed(identity, true);
    scan.resolve(admitted);
    assert.equal((await request).allowed, false);
    assert.equal(guard.state, 'uncertain');
    guard.providerTerminated(identity.providerInstance);
    assert.equal(guard.state, 'idle');
  });

  it('does not let a timed-out scan release ownership or grant permission before ending', { timeout: 10000 }, async () => {
    const guard = new FileOperationGuard({ held: true });
    guard.admitQuiescentNamespace();
    const scan = pending<FileAdmission | null>();
    let signal: AbortSignal | null = null;
    const request = guard.request(identity, supplied => { signal = supplied; return scan.promise; });
    assert.equal((await request).allowed, false);
    assert.equal(guard.state, 'uncertain');
    assert.equal((signal as AbortSignal | null)?.aborted, true);
    scan.resolve(admitted);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(guard.state, 'idle');
  });

  it('checks monotonic elapsed time even before a delayed timeout callback can run', async () => {
    let now = 0;
    const guard = new FileOperationGuard({ held: true }, () => now);
    guard.admitQuiescentNamespace();
    assert.equal((await guard.request(identity, async () => { now = 5000; return admitted; })).allowed, false);
    assert.equal(guard.state, 'idle');
  });

  it('retains namespace loss when a late completion arrives before the pipe flag changes', async () => {
    const guard = new FileOperationGuard({ held: true });
    guard.admitQuiescentNamespace();
    assert.equal((await guard.request(identity, async () => admitted)).allowed, true);
    guard.namespaceLost();
    guard.completed(identity, true);
    assert.equal(guard.state, 'unavailable');
    assert.equal((await guard.request(identity, async () => admitted)).allowed, false);
  });
});
