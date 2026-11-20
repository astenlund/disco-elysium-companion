import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { releaseAfter, releaseAll } from './support/release.ts';
import { releaseExhaustedChat, type SyntheticChat } from './support/synthetic-chat.ts';

describe('test teardown release helpers', () => {
  it('runs every release step after one rejects and then rethrows that failure', async () => {
    // Arrange
    const ran: string[] = [];
    const failure = new Error('guard release failed');

    // Act
    const outcome = await releaseAll(
      () => { ran.push('helper'); },
      async () => { ran.push('guard'); throw failure; },
      async () => { ran.push('fixture'); }).then(() => null, (error: unknown) => error);

    // Assert
    assert.deepEqual(ran, ['helper', 'guard', 'fixture']);
    assert.equal(outcome, failure);
  });

  it('reports every failure together when several release steps reject', async () => {
    // Arrange
    const first = new Error('first');
    const second = new Error('second');

    // Act
    const outcome = await releaseAll(() => { throw first; }, () => Promise.reject(second)).then(() => null, (error: unknown) => error);

    // Assert
    assert.ok(outcome instanceof AggregateError, String(outcome));
    assert.deepEqual(outcome.errors, [first, second]);
  });

  it('keeps the guard held when the helper close rejects, while later steps still run', async () => {
    // Arrange
    const ran: string[] = [];
    const closeFailure = new Error('helper exit unobserved');

    // Act
    const outcome = await releaseAll(
      releaseAfter(async () => { ran.push('helper'); throw closeFailure; }, () => { ran.push('guard'); }),
      () => { ran.push('fixture'); }).then(() => null, (error: unknown) => error);

    // Assert
    assert.deepEqual(ran, ['helper', 'fixture']);
    assert.equal(outcome, closeFailure);
  });

  it('releases the guard only after the helper close has settled', async () => {
    // Arrange
    const ran: string[] = [];
    const close = async (): Promise<void> => { await new Promise<void>(resolve => { setImmediate(resolve); }); ran.push('helper'); };

    // Act
    await releaseAll(releaseAfter(close, () => { ran.push('guard'); }), () => { ran.push('fixture'); });

    // Assert
    assert.deepEqual(ran, ['helper', 'guard', 'fixture']);
  });

  it('closes the native helper before releasing the guard and still closes the fixture when broker cleanup fails', async () => {
    // Arrange: broker cleanup rejects while the helper still runs, and the helper close itself also fails.
    const calls: string[] = [];
    const brokerFailure = new Error('a broker did not exit');
    const chat = {
      provider: { endChildren: async () => { calls.push('brokers'); throw brokerFailure; } },
      backend: {
        supervisor: { nativeHelper: { close: async () => { calls.push('helper'); throw new Error('helper exit unobserved'); } } },
        kernel: { guard: { release: async () => { calls.push('guard'); } } },
      },
    } as unknown as SyntheticChat;
    const fixture = { close: async () => { calls.push('fixture'); } };

    // Act
    const outcome = await releaseExhaustedChat(chat, fixture).then(() => null, (error: unknown) => error);

    // Assert
    assert.deepEqual(calls, ['brokers', 'helper', 'guard', 'fixture']);
    assert.equal(outcome, brokerFailure);
  });
});
