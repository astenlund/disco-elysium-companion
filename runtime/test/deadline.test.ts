import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Deadline, DeadlineExceededError } from '../src/deadline.ts';

describe('anchored operation deadlines', () => {
  it('charges time spent deciding whether a completed acquisition needs another call', () => {
    let now = 150;
    const deadline = Deadline.fromStart(100, 120, () => now);
    assert.equal(deadline.remaining(1000), 70);
    now = 220;
    assert.throws(() => deadline.check(), DeadlineExceededError);
    assert.throws(() => Deadline.fromStart(100, 120, () => now).check(), DeadlineExceededError);
  });

  it('rejects nonfinite anchors and invalid duration while preserving relative deadlines', () => {
    for (const anchor of [NaN, Infinity, -Infinity]) { assert.throws(() => Deadline.fromStart(anchor, 120), RangeError); }
    for (const duration of [0, -1, 0.5, 3_600_001, NaN, Infinity]) { assert.throws(() => Deadline.fromStart(100, duration), RangeError); }
    assert.equal(Deadline.after(120, () => 100).remaining(1000), 120);
  });
});
