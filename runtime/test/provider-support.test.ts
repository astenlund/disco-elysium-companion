import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { RuntimeConfig } from '../src/config.ts';
import { PromptQueue, ProviderSource, ProviderUnavailableError, providerCapabilities, providerEnvironment, supportsVerbatim } from '../src/provider-support.ts';

describe('provider setup and source observations', () => {
  it('requires the supported exact CLI version and a configured reversible override', () => {
    for (const version of ['2.1.248', '2.1.289', '3.0.0']) { assert.equal(supportsVerbatim(version), true); }
    for (const version of [null, '2.1.247', '2.1.289\n', '2.1.289unknown', '9007199254740992.1.1']) { assert.equal(supportsVerbatim(version), false); }
    const config: RuntimeConfig = { configVersion: 1, adapter: 'game', game: 'game', watcher: { enabled: false }, provider: { model: 'default', effort: 'medium', questionOverride: { model: 'override', effort: 'high' } } };
    assert.equal(providerCapabilities(config).questionOverride, true);
    for (const provider of [{ ...config.provider, model: null }, { ...config.provider, effort: null }, { ...config.provider, questionOverride: null }]) {
      assert.equal(providerCapabilities({ ...config, provider }).questionOverride, false);
    }
  });

  it('deduplicates environment keys before applying isolation flags without reintroducing aliases', () => {
    const environment = providerEnvironment({ Path: 'first', PATH: 'second', claude_code_disable_auto_memory: '0', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '0', ClaudeCode: 'outer', claude_code_entrypoint: 'outer', claude_code_resume_interrupted_turn: '1', CLAUDE_CODE_RESUME_REASON: 'outer', ordinary: 'preserved', missing: undefined });
    assert.equal(environment['Path'], 'first');
    assert.equal(environment['PATH'], undefined);
    assert.equal(environment['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '1');
    assert.equal(environment['claude_code_disable_auto_memory'], undefined);
    assert.equal(environment['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'], '1');
    assert.equal(environment['ClaudeCode'], undefined);
    assert.equal(environment['claude_code_entrypoint'], undefined);
    assert.equal(environment['claude_code_resume_interrupted_turn'], undefined);
    assert.equal(environment['CLAUDE_CODE_RESUME_REASON'], undefined);
    assert.equal(environment['ordinary'], 'preserved');
    assert.equal(environment['missing'], undefined);
  });

  it('rejects profile redirection by key presence without exposing its value', () => {
    for (const key of ['CLAUDE_CONFIG_DIR', 'claude_config_dir', 'ClAuDe_CoNfIg_DiR']) {
      for (const value of ['', 'C:/synthetic-private-profile']) {
        assert.throws(() => providerEnvironment({ [key]: value }), error => error instanceof ProviderUnavailableError
          && error.message === 'Inherited CLAUDE_CONFIG_DIR profile redirection is unsupported; the provider requires its default profile.');
      }
    }
    assert.throws(() => providerEnvironment({ CLAUDE_CONFIG_DIR: undefined, claude_config_dir: '' }), ProviderUnavailableError);
  });

  it('admits absent and undefined redirection keys without forwarding undefined aliases', () => {
    const expected = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };
    assert.deepEqual(providerEnvironment({}), expected);
    assert.deepEqual(providerEnvironment({ CLAUDE_CONFIG_DIR: undefined, claude_config_dir: undefined }), expected);
  });

  it('copies ordinary and supported credential values opaquely without changing the source', () => {
    const source = Object.freeze({ ordinary: '  unchanged  ', empty: '', ANTHROPIC_API_KEY: 'synthetic-api-value',
      CLAUDE_CODE_OAUTH_TOKEN: ' synthetic-oauth-value ', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CONFIG_DIR: undefined });
    const result = providerEnvironment(source);
    assert.deepEqual(result, { ordinary: '  unchanged  ', empty: '', ANTHROPIC_API_KEY: 'synthetic-api-value',
      CLAUDE_CODE_OAUTH_TOKEN: ' synthetic-oauth-value ', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' });
    assert.notEqual(result, source);
    assert.equal(Object.keys(source).length, 6);
    assert.equal(Object.hasOwn(source, 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'), false);
  });

  it('reports only current SDK source labels and ignores late replaced-instance metadata', () => {
    const source = new ProviderSource();
    source.bind('first');
    assert.equal(source.value, null);
    assert.equal(source.observe('first', undefined, 'initialize'), false);
    source.observe('first', 'none', 'initialize');
    assert.equal(source.value, 'none');
    source.observe('first', 'legacy-source', 'system');
    source.observe('first', 'initial-reply-arrived-late', 'initialize');
    assert.equal(source.value, 'legacy-source');
    source.bind('second');
    assert.equal(source.value, null);
    assert.equal(source.observe('first', 'api_key', 'system'), false);
    source.observe('second', 'api_key', 'system');
    assert.equal(source.value, 'api_key');
    source.bind(null);
    assert.equal(source.value, null);
    assert.equal(source.observe('second', 'none', 'system'), false);
  });

  it('keeps one prompt consumer, preserves accepted text and refuses enqueue after closing', async () => {
    const queue = new PromptQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const message: SDKUserMessage = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '<context>' }, { type: 'text', text: '/literal @literal\n' }] } };
    const waiting = iterator.next();
    await assert.rejects(iterator.next(), /Concurrent/);
    queue.push(message);
    assert.equal((await waiting).value, message);
    queue.push(message);
    assert.throws(() => queue.push(message), /not available/);
    queue.end();
    assert.equal((await iterator.next()).value, message);
    assert.equal((await iterator.next()).done, true);
    assert.throws(() => queue.push(message), /not available/);
    assert.throws(() => queue[Symbol.asyncIterator](), /one consumer/);
  });
});
