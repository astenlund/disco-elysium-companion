import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigurationError, parseRuntimeConfig } from '../src/config.ts';
import { isOpaqueToken, newOperationId, operationIdPattern } from '../src/identity.ts';

function configuration(game = 'game'): unknown {
  return { configVersion: 1, adapter: 'adapter', game, provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } };
}

describe('runtime configuration identities', () => {
  it('preserves admitted opaque identities that are unsafe as raw path components', () => {
    for (const game of ['a/b', 'A:B', '..', 'CON', 'trailing.']) {
      assert.equal(parseRuntimeConfig(configuration(game)).game, game);
    }
    assert.equal(parseRuntimeConfig(configuration('Case')).game, 'Case');
  });

  it('rejects invalid scalar sequences, controls and out-of-profile token sizes', () => {
    for (const game of ['', 'a'.repeat(129), String.fromCharCode(0), String.fromCharCode(0x85), String.fromCharCode(0xd800), 'e' + String.fromCharCode(0x301)]) {
      assert.equal(isOpaqueToken(game), false);
      assert.throws(() => parseRuntimeConfig(configuration(game)), ConfigurationError);
    }
    assert.equal(isOpaqueToken(String.fromCodePoint(0x1f600).repeat(128)), true);
  });

  it('keeps null defaults distinct and rejects unknown members and unsupported effort', () => {
    const value = parseRuntimeConfig(configuration());
    assert.deepEqual(value.provider, { model: null, effort: null, questionOverride: null });
    assert.throws(() => parseRuntimeConfig({ ...(configuration() as object), unexpected: true }), ConfigurationError);
    assert.throws(() => parseRuntimeConfig({ ...(configuration() as object), provider: { model: 'x', effort: 'urgent', questionOverride: null } }), ConfigurationError);
  });

  it('gives every supported operation kind its specified namespace', () => {
    for (const [kind, prefix] of [['repair', 'jr-'], ['release', 'rl-'], ['handover', 'ho-']] as const) {
      const id = newOperationId(kind);
      assert.equal(id.startsWith(prefix), true);
      assert.equal(operationIdPattern.test(id), true);
    }
  });
});
