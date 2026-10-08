import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type { Options, SDKControlInitializeResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { PendingStateCheckError } from '../src/backend/api.ts';
import { RuntimeCapacityError } from '../src/capacity.ts';
import { ClaudeProvider, ProviderUnavailableError, type ClaudeProviderOptions, type ProviderChild } from '../src/claude-provider.ts';
import type { RuntimeConfig } from '../src/config.ts';
import { FileOperationGuard } from '../src/file-operation.ts';
import type { OwnedExit } from '../src/process.ts';
import type { ProviderTurn } from '../src/provider.ts';
import { ToolBoundary } from '../src/tool-boundary.ts';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeChild extends EventEmitter implements ProviderChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly ready = Promise.resolve({ pid: 1, created: '1' });
  private readonly stopped = deferred<OwnedExit>();
  readonly terminated = this.stopped.promise;
  killed = false;
  exitCode: number | null = null;
  readonly signalCode = null;
  kill(): boolean { this.killed = true; this.finish(); return true; }
  finish(): void {
    if (this.exitCode !== null) { return; }
    this.exitCode = 0;
    this.stdin.end(); this.stdout.end(); this.stderr.end();
    this.stopped.resolve({ code: 0, signal: null, failure: null });
    this.emit('exit', 0, null);
  }
}

class FakeQuery implements AsyncIterable<SDKMessage> {
  readonly options: Options;
  readonly inputs: SDKUserMessage[] = [];
  readonly controls: unknown[] = [];
  private readonly child: FakeChild;
  private readonly output: SDKMessage[] = [];
  private outputWaiter: ((result: IteratorResult<SDKMessage>) => void) | null = null;
  private inputWaiter: ((message: SDKUserMessage) => void) | null = null;
  closed = false;
  rejectEffort: string | null = null;
  interrupted = 0;

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options, child: FakeChild) {
    this.options = options;
    this.child = child;
    options.spawnClaudeCodeProcess!({ command: 'fake', args: [], cwd: 'C:/fixture', env: options.env ?? {}, signal: new AbortController().signal });
    void (async () => {
      for await (const input of prompt) {
        this.inputs.push(input);
        this.inputWaiter?.(input);
        this.inputWaiter = null;
      }
      this.close();
    })();
  }

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return { commands: [], agents: [], models: [], output_style: 'default', available_output_styles: [], account: {}, hooks_applied: true };
  }

  async setModel(model?: string): Promise<void> { this.controls.push({ model }); }
  async applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
    this.controls.push(settings);
    if (settings.effortLevel === this.rejectEffort) { throw new Error('fixture control rejection'); }
  }
  async interrupt(): Promise<undefined> { this.interrupted++; return undefined; }

  waitInput(): Promise<SDKUserMessage> {
    if (this.inputs.length > 0) { return Promise.resolve(this.inputs.at(-1)!); }
    return new Promise(resolve => { this.inputWaiter = resolve; });
  }

  emitMessage(value: unknown): void {
    const message = value as SDKMessage;
    if (this.outputWaiter !== null) {
      const waiter = this.outputWaiter;
      this.outputWaiter = null;
      waiter({ value: message, done: false });
    } else { this.output.push(message); }
  }

  result(input: SDKUserMessage, values: Record<string, unknown> = {}): void {
    this.emitMessage({ type: 'result', subtype: 'success', is_error: false, session_id: this.options.sessionId ?? this.options.resume, user_message_uuid: input.uuid, result: 'answer', terminal_reason: 'completed', ...values });
  }

  close(): void {
    if (this.closed) { return; }
    this.closed = true;
    this.child.finish();
    this.outputWaiter?.({ value: undefined, done: true });
    this.outputWaiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return { next: () => {
      const next = this.output.shift();
      if (next !== undefined) { return Promise.resolve({ value: next, done: false }); }
      if (this.closed) { return Promise.resolve({ value: undefined, done: true }); }
      return new Promise(resolve => { this.outputWaiter = resolve; });
    } };
  }
}

const config: RuntimeConfig = { configVersion: 1, adapter: 'game', game: 'game', watcher: { enabled: false }, provider: { model: 'base', effort: 'medium', questionOverride: { model: 'override', effort: 'high' } } };
function setup(queryFactory?: ClaudeProviderOptions['queryFactory'], environment: NodeJS.ProcessEnv = {}) {
  const child = new FakeChild();
  const calls = { query: 0, spawn: 0, quiescence: 0, boundary: 0 };
  let query!: FakeQuery;
  let current: string | null = null;
  let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
  const options: ClaudeProviderOptions = {
    companionRoot: 'C:/fixture', config, appendText: 'runtime instructions', environment, onPassiveSignal: () => {}, isCurrent: instance => current === instance,
    supervisor: { spawn: (_role, launch) => { calls.spawn++; spawnedEnvironment = launch.env; return child; }, verifyQuiescent: async () => { calls.quiescence++; } },
    boundary: (instance, sessionId) => {
      calls.boundary++;
      current = instance;
      return new ToolBoundary({ providerInstance: instance, fileOperations: new FileOperationGuard({ held: false }), isActive: (active, sdk) => active === current && sdk === sessionId,
        dialogsAvailable: () => true, admitFile: async () => null, verifyFileCompletion: async () => false });
    },
    queryFactory: input => {
      calls.query++;
      if (queryFactory !== undefined) { return queryFactory(input); }
      query = new FakeQuery(input.prompt as AsyncIterable<SDKUserMessage>, input.options!, child);
      return query;
    },
  };
  return { provider: new ClaudeProvider(options), options, calls, get query() { return query; }, get spawnedEnvironment() { return spawnedEnvironment; }, child, invalidate: () => { current = null; } };
}

function turn(overrides: Partial<ProviderTurn> = {}): ProviderTurn {
  return { contextBlock: '<prepared>', playerText: '/literal @literal\n', override: null, askUser: async () => ({ cancelled: true }), onSignal: () => {}, beforeSend: async context => context, onSent: () => {}, ...overrides };
}

describe('Claude provider state machine', () => {
  it('refuses inherited profile redirection at construction before any provider work', () => {
    const fixture = setup();
    for (const key of ['CLAUDE_CONFIG_DIR', 'claude_config_dir', 'ClAuDe_CoNfIg_DiR']) {
      for (const value of ['', 'C:/synthetic-private-profile']) {
        assert.throws(() => new ClaudeProvider({ ...fixture.options, environment: { [key]: value } }), error => error instanceof ProviderUnavailableError
          && error.message === 'Inherited CLAUDE_CONFIG_DIR profile redirection is unsupported; the provider requires its default profile.');
      }
    }
    assert.deepEqual(fixture.calls, { query: 0, spawn: 0, quiescence: 0, boundary: 0 });
  });

  it('rechecks inherited profile presence for new and resumed starts before metadata or query work', async () => {
    for (const sessionId of [null, 'existing-session']) {
      for (const [key, value] of [['CLAUDE_CONFIG_DIR', 'C:/synthetic-private-profile'], ['claude_config_dir', '']] as const) {
        const environment: NodeJS.ProcessEnv = {};
        const fixture = setup(undefined, environment);
        environment[key] = value;
        await assert.rejects(fixture.provider.start(sessionId), error => error instanceof ProviderUnavailableError
          && error.message === 'Inherited CLAUDE_CONFIG_DIR profile redirection is unsupported; the provider requires its default profile.');
        assert.deepEqual(fixture.calls, { query: 0, spawn: 0, quiescence: 0, boundary: 0 });
      }
    }
  });

  it('rejects redirection introduced during startup preflight before constructing a query', async () => {
    const environment: NodeJS.ProcessEnv = {};
    const fixture = setup(undefined, environment);
    const quiescent = fixture.options.supervisor.verifyQuiescent;
    fixture.options.supervisor.verifyQuiescent = async role => { await quiescent(role); environment['ClAuDe_CoNfIg_DiR'] = ''; };
    await assert.rejects(fixture.provider.start(null), error => error instanceof ProviderUnavailableError && error.message.includes('profile redirection is unsupported'));
    assert.deepEqual(fixture.calls, { query: 0, spawn: 0, quiescence: 1, boundary: 0 });
  });

  it('passes synthetic credentials unchanged through admitted new and resumed SDK environments', async () => {
    for (const sessionId of [null, 'existing-session']) {
      const environment = Object.freeze({ CLAUDE_CONFIG_DIR: undefined, Path: 'synthetic-path', PATH: 'ignored-alias', ordinary: '',
        ANTHROPIC_API_KEY: 'synthetic-api-value', CLAUDE_CODE_OAUTH_TOKEN: ' synthetic-oauth-value ', ANTHROPIC_AUTH_TOKEN: '',
        ClaudeCode: 'outer', claude_code_entrypoint: 'outer', CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1', claude_code_resume_reason: 'outer' });
      const fixture = setup(undefined, environment);
      const session = await fixture.provider.start(sessionId);
      try {
        const expected = { Path: 'synthetic-path', ordinary: '', ANTHROPIC_API_KEY: 'synthetic-api-value', CLAUDE_CODE_OAUTH_TOKEN: ' synthetic-oauth-value ', ANTHROPIC_AUTH_TOKEN: '',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };
        assert.deepEqual(fixture.query.options.env, expected);
        assert.deepEqual(fixture.spawnedEnvironment, expected);
        assert.notEqual(fixture.query.options.env, environment);
        assert.equal(fixture.query.options.resume ?? null, sessionId);
        assert.equal(fixture.calls.query, 1);
        assert.equal(fixture.calls.spawn, 1);
      } finally { await session.close(); }
    }
  });

  it('refuses a later redirected resume without starting another query or child', async () => {
    const environment: NodeJS.ProcessEnv = {};
    const fixture = setup(undefined, environment);
    const session = await fixture.provider.start(null);
    await session.close();
    const prior = { ...fixture.calls };
    environment['CLAUDE_CONFIG_DIR'] = '';
    await assert.rejects(fixture.provider.start(session.providerSessionId), ProviderUnavailableError);
    assert.deepEqual(fixture.calls, prior);
  });

  it('closes incompatible or uncorrelated initialization as permanently unavailable', async () => {
    for (const mismatch of ['version', 'session'] as const) {
      const fixture = setup();
      const session = await fixture.provider.start(null);
      const exits: string[] = [];
      session.onExit(reason => exits.push(reason));
      const pending = session.sendTurn(turn());
      const input = await fixture.query.waitInput();
      fixture.query.emitMessage({ type: 'system', subtype: 'init', session_id: mismatch === 'session' ? 'another-session' : session.providerSessionId,
        claude_code_version: mismatch === 'version' ? '2.1.247' : '2.1.289', apiKeySource: 'none' });
      assert.deepEqual(await pending, { kind: 'failed', code: 'providerError', retryable: false });
      fixture.query.result(input);
      await session.close();
      assert.equal(fixture.query.closed, true);
      assert.deepEqual(exits, ['providerUnavailable']);
      assert.equal((await session.sendTurn(turn())).kind, 'failed');
      assert.equal(fixture.query.inputs.length, 1);
    }
  });

  it('fails transport loss once, dismisses a pending dialog and ignores a late success', async () => {
    const fixture = setup();
    const session = await fixture.provider.start(null);
    const dialog = deferred<never>();
    let questions = 0;
    const pending = session.sendTurn(turn({ askUser: () => { questions++; return dialog.promise; } }));
    const input = await fixture.query.waitInput();
    const answer = fixture.query.options.canUseTool!('AskUserQuestion', { questions: [{ question: 'Proceed?', header: 'Choice', options: [{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Stop' }], multiSelect: false }] }, { signal: new AbortController().signal, toolUseID: 'question', requestId: 'request' });
    assert.equal(questions, 1);
    fixture.child.emit('error', new Error('transport failure'));
    fixture.child.emit('error', new Error('repeated failure'));
    fixture.query.result(input);
    assert.deepEqual(await pending, { kind: 'failed', code: 'subprocessExited', retryable: true });
    const permission = await answer;
    assert.ok(permission !== null);
    assert.equal(permission.behavior, 'deny');
    assert.equal((await session.sendTurn(turn())).kind, 'failed');
    assert.equal(fixture.query.inputs.length, 1);
    await session.close();
  });

  it('retains a completed outcome when transport fails after its terminal result', async () => {
    const fixture = setup();
    const session = await fixture.provider.start(null);
    const pending = session.sendTurn(turn());
    const input = await fixture.query.waitInput();
    fixture.query.result(input);
    const result = await pending;
    fixture.child.emit('error', new Error('transport failed after completion'));
    assert.deepEqual(result, { kind: 'completed', text: 'answer' });
    assert.equal((await session.sendTurn(turn())).kind, 'failed');
    await session.close();
  });

  it('retains and terminates a child when query construction fails after spawning', async () => {
    const fixture = setup(input => {
      input.options!.spawnClaudeCodeProcess!({ command: 'fake', args: [], cwd: 'C:/fixture', env: {}, signal: new AbortController().signal });
      throw new Error('construction failed after spawn');
    });
    await assert.rejects(fixture.provider.start(null), ProviderUnavailableError);
    assert.equal(fixture.child.killed, true);
    assert.equal((await fixture.child.terminated).code, 0);
  });

  it('preserves typed host gate failures without sending SDK input', async () => {
    const failures = [new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions: ['freeSpace'] }, 'runtimeMarker'),
      new PendingStateCheckError()];
    for (const failure of failures) {
      const fixture = setup();
      const session = await fixture.provider.start(null);
      let sent = 0;
      try {
        await assert.rejects(session.sendTurn(turn({ beforeSend: async () => { throw failure; }, onSent: () => { sent++; } })), error => error === failure);
        assert.equal(fixture.query.inputs.length, 0);
        assert.equal(sent, 0);
        assert.equal(fixture.query.closed, true);
      } finally { await session.close(); }
    }
    const generic = setup();
    const session = await generic.provider.start(null);
    try {
      assert.deepEqual(await session.sendTurn(turn({ beforeSend: async () => { throw new Error('Generic host failure.'); } })),
        { kind: 'failed', code: 'providerError', retryable: true });
      assert.equal(generic.query.inputs.length, 0);
    } finally { await session.close(); }
  });

  it('sends the rechecked context and player text once and requires matching result identity', async () => {
    const fixture = setup();
    const session = await fixture.provider.start(null);
    let sent = 0;
    try {
      const result = session.sendTurn(turn({ beforeSend: async () => '<disclosure>', onSent: () => { sent++; } }));
      const input = await fixture.query.waitInput();
      assert.deepEqual(input.message.content, [{ type: 'text', text: '<disclosure>' }, { type: 'text', text: '/literal @literal\n' }]);
      assert.deepEqual(input.origin, { kind: 'human' });
      assert.equal(fixture.query.options.verbatimPrompts, true);
      assert.deepEqual(fixture.query.options.settingSources, []);
      assert.equal(fixture.query.options.strictMcpConfig, true);
      fixture.query.result(input, { user_message_uuid: 'old-message', result: 'stale' });
      fixture.query.result(input, { result: 'current' });
      assert.deepEqual(await result, { kind: 'completed', text: 'current' });
      assert.equal(sent, 1);
      assert.equal(fixture.query.inputs.length, 1);
    } finally { await session.close(); }
  });

  it('fails an uncorrelated result without acknowledging or accepting another message on that process', async () => {
    const fixture = setup();
    const session = await fixture.provider.start(null);
    try {
      const result = session.sendTurn(turn());
      const input = await fixture.query.waitInput();
      fixture.query.result(input, { user_message_uuid: undefined });
      assert.equal((await result).kind, 'failed');
      assert.equal((await session.sendTurn(turn())).kind, 'failed');
      assert.equal(fixture.query.inputs.length, 1);
    } finally { await session.close(); }
  });

  it('closes a partly configured override before sending and preserves success when revert fails', async () => {
    const first = setup();
    const firstSession = await first.provider.start(null);
    first.query.rejectEffort = 'high';
    try {
      const result = await firstSession.sendTurn(turn({ override: { model: 'override', effort: 'high' } }));
      assert.deepEqual(result, { kind: 'failed', code: 'providerError', retryable: true });
      assert.equal(first.query.inputs.length, 0);
      assert.equal(first.query.closed, true);
    } finally { await firstSession.close(); }
    const second = setup();
    const secondSession = await second.provider.start(null);
    const exits: string[] = [];
    secondSession.onExit(reason => exits.push(reason));
    second.query.rejectEffort = 'medium';
    try {
      const result = secondSession.sendTurn(turn({ override: { model: 'override', effort: 'high' } }));
      const input = await second.query.waitInput();
      second.query.result(input);
      assert.deepEqual(await result, { kind: 'completed', text: 'answer' });
      assert.deepEqual(second.query.controls, [{ model: 'override' }, { effortLevel: 'high' }, { model: 'base' }, { effortLevel: 'medium' }]);
      await secondSession.close();
      assert.deepEqual(exits, ['overrideReset']);
    } finally { await secondSession.close(); }
  });

  it('does not send a stale or interrupted preparation and never replenishes it by resubmitting', async () => {
    const fixture = setup();
    const session = await fixture.provider.start(null);
    const gate = deferred<string>();
    let sent = 0;
    try {
      const result = session.sendTurn(turn({ beforeSend: () => gate.promise, onSent: () => { sent++; } }));
      assert.equal(await session.interrupt(), true);
      gate.resolve('<late>');
      assert.deepEqual(await result, { kind: 'failed', code: 'interrupted', retryable: true });
      assert.equal(sent, 0);
      assert.equal(fixture.query.inputs.length, 0);
    } finally { await session.close(); }
  });

  it('classifies a matching prompt-too-long result separately and treats interruption as failure', async () => {
    const fixture = setup();
    const session = await fixture.provider.start(null);
    try {
      const result = session.sendTurn(turn());
      const input = await fixture.query.waitInput();
      fixture.query.result(input, { is_error: true, terminal_reason: 'prompt_too_long' });
      assert.deepEqual(await result, { kind: 'failed', code: 'contextExhausted', retryable: true });
      const next = session.sendTurn(turn());
      while (fixture.query.inputs.length < 2) { await new Promise(resolve => setImmediate(resolve)); }
      const second = fixture.query.inputs[1]!;
      assert.equal(await session.interrupt(), true);
      fixture.query.result(second);
      assert.deepEqual(await next, { kind: 'failed', code: 'interrupted', retryable: true });
      assert.equal(fixture.query.interrupted, 1);
    } finally { await session.close(); }
  });
});
