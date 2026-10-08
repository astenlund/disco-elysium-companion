import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundedProviderControl, ProviderControlError, setModelChoice } from '../src/provider-control.ts';

describe('provider override controls', () => {
  it('sets both explicit values in order and stops on a rejected control', async () => {
    const calls: unknown[] = [];
    const controls = { setModel: async (model?: string) => { calls.push(model); }, applyFlagSettings: async (settings: unknown) => { calls.push(settings); } };
    await setModelChoice(controls, { model: 'configured-model', effort: 'medium' });
    assert.deepEqual(calls, ['configured-model', { effortLevel: 'medium' }]);
    let effortCalled = false;
    await assert.rejects(setModelChoice({ setModel: async () => { throw new Error('rejected'); }, applyFlagSettings: async () => { effortCalled = true; } }, { model: 'override', effort: 'high' }), /rejected/);
    assert.equal(effortCalled, false);
  });

  it('does not convert a never-settled or synchronously failed control into success', async () => {
    await assert.rejects(boundedProviderControl(() => new Promise<void>(() => {}), 5), ProviderControlError);
    await assert.rejects(boundedProviderControl(() => { throw new Error('synchronous rejection'); }, 1000), /synchronous rejection/);
  });
});
