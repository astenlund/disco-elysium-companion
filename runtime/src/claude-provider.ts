import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query, type Options, type Query, type SDKMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import { PendingStateCheckError } from './backend/api.ts';
import { RuntimeCapacityError } from './capacity.ts';
import type { RuntimeConfig } from './config.ts';
import { parseDialogQuestions } from './dialogs.ts';
import { isOpaqueToken, newIdentity } from './identity.ts';
import { readJsonFile } from './json.ts';
import type { OwnedExit, OwnedSpawnOptions, ProcessIdentity } from './process.ts';
import { boundedProviderControl, setModelChoice } from './provider-control.ts';
import { assertDefaultProviderProfile, pinnedSdkVersion, PromptQueue, providerCapabilities, providerEnvironment, ProviderSource, ProviderUnavailableError, supportsVerbatim } from './provider-support.ts';
import type { DialogAnswer, Provider, ProviderCapabilities, ProviderExitReason, ProviderFailureCode, ProviderOutcome, ProviderSession, ProviderSignal, ProviderTurn } from './provider.ts';
import { hostedTools, type ToolBoundary } from './tool-boundary.ts';

type QueryPort = Pick<Query, 'initializationResult' | 'setModel' | 'applyFlagSettings' | 'interrupt' | 'close'> & AsyncIterable<SDKMessage>;
export interface ProviderChild extends SpawnedProcess { readonly ready: Promise<ProcessIdentity>; readonly terminated: Promise<OwnedExit>; readonly stderr: NodeJS.ReadableStream }
export interface ProviderProcessOwner {
  spawn(role: 'provider', options: OwnedSpawnOptions): ProviderChild;
  verifyQuiescent(role: 'provider'): Promise<void>;
  verifyOwnedLive(role: 'provider', child: ProviderChild, identity: ProcessIdentity): Promise<void>;
}

export interface ClaudeProviderOptions {
  readonly companionRoot: string;
  readonly config: RuntimeConfig;
  readonly appendText: string;
  readonly supervisor: ProviderProcessOwner;
  readonly boundary: (providerInstanceId: string, sdkSessionId: string) => ToolBoundary;
  readonly onPassiveSignal: (providerInstanceId: string, signal: ProviderSignal) => void;
  readonly isCurrent: (providerInstanceId: string) => boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly queryFactory?: (input: Parameters<typeof query>[0]) => QueryPort;
}

export { ProviderUnavailableError } from './provider-support.ts';
interface ActiveTurn {
  readonly request: ProviderTurn;
  readonly uuid: ReturnType<typeof randomUUID>;
  readonly resolve: (outcome: ProviderOutcome) => void;
  sent: boolean;
  settled: boolean;
  interrupted: boolean;
  error: string | undefined;
  text: string;
}

function failure(code: ProviderFailureCode, retryable = true): ProviderOutcome { return { kind: 'failed', code, retryable }; }
function classify(error: string | undefined): ProviderFailureCode {
  if (error === 'authentication_failed' || error === 'oauth_org_not_allowed' || error === 'cloud_credential_error') { return 'authenticationFailed'; }
  if (error === 'rate_limit' || error === 'overloaded') { return 'rateLimited'; }
  return 'providerError';
}

async function requirePinnedSdk(): Promise<void> {
  const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const manifest = await readJsonFile(path.join(path.dirname(entry), 'package.json'));
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || !('version' in manifest) || manifest.version !== pinnedSdkVersion
    || !('claudeCodeVersion' in manifest) || !supportsVerbatim(manifest.claudeCodeVersion)) {
    throw new ProviderUnavailableError('The installed SDK does not provide the pinned verbatim interface.');
  }
}

class ClaudeSession implements ProviderSession {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly capabilities: ProviderCapabilities;
  private readonly options: ClaudeProviderOptions;
  private readonly source = new ProviderSource();
  private readonly prompts = new PromptQueue();
  private readonly children: ProviderChild[];
  private readonly listeners = new Set<(reason: ProviderExitReason) => void>();
  private readonly dialogCancellations = new Set<() => void>();
  private readonly admissions = new AbortController();
  private readonly query: QueryPort;
  private readonly pump: Promise<void>;
  private readonly startupSignal: AbortSignal | undefined;
  private childIdentity: ProcessIdentity | null = null;
  private active: ActiveTurn | null = null;
  private ended = false;
  private closing = false;
  private exitReason: ProviderExitReason = 'subprocessExited';
  private closingPromise: Promise<void> | null = null;

  constructor(options: ClaudeProviderOptions, resumeSessionId: string | null, children: ProviderChild[], environment: Record<string, string>, startupSignal?: AbortSignal) {
    this.options = options;
    this.startupSignal = startupSignal;
    this.children = children;
    this.providerInstanceId = newIdentity();
    this.providerSessionId = resumeSessionId ?? randomUUID();
    this.capabilities = providerCapabilities(options.config);
    this.source.bind(this.providerInstanceId);
    const boundary = options.boundary(this.providerInstanceId, this.providerSessionId);
    const sdkOptions: Options = {
      cwd: options.companionRoot, env: environment, settingSources: [], strictMcpConfig: true,
      permissionMode: 'default', tools: [...hostedTools], verbatimPrompts: true, includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: options.appendText },
      ...(resumeSessionId === null ? { sessionId: this.providerSessionId } : { resume: resumeSessionId }),
      ...(options.config.provider.model === null ? {} : { model: options.config.provider.model }),
      ...(options.config.provider.effort === null ? {} : { effort: options.config.provider.effort }),
      hooks: {
        PreToolUse: [{ hooks: [(input, id, control) => boundary.pre(input, id, { ...control, signal: AbortSignal.any([control.signal, this.admissions.signal]) })] }],
        PostToolUse: [{ hooks: [boundary.post] }], PostToolUseFailure: [{ hooks: [boundary.post] }],
      },
      canUseTool: async (tool, input, control) => {
        if (tool !== 'AskUserQuestion' || control.mcpServer !== undefined || control.signal.aborted || this.ended || this.closing || !this.options.isCurrent(this.providerInstanceId)) {
          return { behavior: 'deny', message: 'This tool is unavailable for this turn.' };
        }
        const turn = this.active;
        const questions = parseDialogQuestions(input.questions);
        if (turn === null || !turn.sent || turn.settled || turn.interrupted || questions === null) { return { behavior: 'deny', message: 'This question is unavailable for this turn.' }; }
        let abort: () => void = () => {};
        try {
          const cancelled = new Promise<DialogAnswer>(resolve => {
            abort = () => resolve({ cancelled: true });
            this.dialogCancellations.add(abort);
            control.signal.addEventListener('abort', abort, { once: true });
          });
          const answer = await Promise.race([turn.request.askUser(questions), cancelled]);
          if ('cancelled' in answer || this.ended || this.closing || this.active !== turn || turn.settled || turn.interrupted || !this.options.isCurrent(this.providerInstanceId)) { return { behavior: 'deny', message: 'The question was dismissed.' }; }
          return { behavior: 'allow', updatedInput: { questions, answers: answer.answers } };
        } catch { return { behavior: 'deny', message: 'The question is unavailable.' }; }
        finally { control.signal.removeEventListener('abort', abort); this.dialogCancellations.delete(abort); }
      },
      spawnClaudeCodeProcess: supplied => {
        startupSignal?.throwIfAborted();
        if (this.closing || this.ended) { throw new ProviderUnavailableError('Provider startup was cancelled.'); }
        const signal = startupSignal === undefined ? supplied.signal : AbortSignal.any([supplied.signal, startupSignal]);
        const child = options.supervisor.spawn('provider', { command: supplied.command, args: supplied.args, cwd: supplied.cwd ?? options.companionRoot, env: supplied.env, signal });
        child.stderr.resume();
        this.children.push(child);
        child.on('error', () => this.transportFailed());
        void child.terminated.then(exit => { if (exit.failure !== null) { this.transportFailed(); } }, () => this.transportFailed());
        return child;
      },
    };
    this.query = (options.queryFactory ?? query)({ prompt: this.prompts, options: sdkOptions });
    this.pump = this.readMessages();
    void this.pump.catch(() => {});
  }

  get credentialSource(): string | null { return this.source.value; }
  isLive(): boolean { return !this.ended && !this.closing; }

  async verifyLive(): Promise<void> {
    const child = this.children[0];
    const identity = this.childIdentity;
    if (!this.isLive() || this.children.length !== 1 || child === undefined || identity === null) {
      throw new ProviderUnavailableError('Provider process liveness is unavailable.');
    }
    await boundedProviderControl(() => this.options.supervisor.verifyOwnedLive('provider', child, identity), 7500);
    if (!this.isLive() || this.children.length !== 1 || this.children[0] !== child || this.childIdentity !== identity) {
      throw new ProviderUnavailableError('Provider process changed during verification.');
    }
  }

  cancelStartup(): void {
    if (this.closing || this.ended) { return; }
    this.closing = true;
    this.stopAdmissions();
    this.prompts.end();
    this.requestClose();
  }

  private requestClose(): void {
    try { this.query.close(); }
    catch { for (const child of this.children) { child.kill('SIGTERM'); } }
  }

  private stopAdmissions(): void {
    this.admissions.abort();
    for (const cancel of this.dialogCancellations) { cancel(); }
    this.dialogCancellations.clear();
  }

  private transportFailed(): void {
    if (this.closing || this.ended) { return; }
    this.closing = true;
    this.settle(failure('subprocessExited'));
    this.stopAdmissions();
    this.prompts.end();
    // A custom spawn can fail synchronously while the query factory is returning.
    queueMicrotask(() => this.requestClose());
  }

  async initialize(): Promise<void> {
    const initialization = await boundedProviderControl(() => this.query.initializationResult(), 30000);
    if (this.ended || this.closing || initialization.hooks_applied === false || this.children.length !== 1) { throw new ProviderUnavailableError('Provider initialization or process ownership is unavailable.'); }
    this.childIdentity = await boundedProviderControl(() => this.children[0]!.ready, 10000);
    if (this.ended || this.closing || this.startupSignal?.aborted) { throw new ProviderUnavailableError('Provider startup was cancelled.'); }
    this.source.observe(this.providerInstanceId, initialization.account?.apiKeySource, 'initialize');
  }

  private emit(signal: ProviderSignal): void {
    if (this.ended || this.closing || !this.options.isCurrent(this.providerInstanceId)) { return; }
    const turn = this.active;
    if (turn !== null && !turn.settled && !turn.interrupted) { turn.request.onSignal(signal); }
    else if (signal.kind !== 'text') { this.options.onPassiveSignal(this.providerInstanceId, signal); }
  }

  private settle(outcome: ProviderOutcome): void {
    const turn = this.active;
    if (turn === null || turn.settled) { return; }
    turn.settled = true;
    turn.resolve(outcome);
  }

  private dispatch(message: SDKMessage): void {
    if (this.ended || this.closing) { return; }
    if (message.type === 'system' && message.subtype === 'init') {
      if (message.session_id !== this.providerSessionId || !supportsVerbatim(message.claude_code_version)) {
        this.exitReason = 'providerUnavailable';
        this.closing = true;
        this.stopAdmissions();
        this.settle(failure('providerError', false));
        this.requestClose();
        return;
      }
      if (this.source.observe(this.providerInstanceId, message.apiKeySource, 'system')) { this.emit({ kind: 'source', credentialSource: this.source.value }); }
      return;
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') { this.emit({ kind: 'compaction' }); return; }
    const turn = this.active;
    if (turn === null || turn.settled || !turn.sent || message.session_id !== this.providerSessionId) { return; }
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') { this.emit({ kind: 'text', fragment: event.delta.text }); }
    } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      turn.error = message.error ?? turn.error;
      if (!turn.interrupted) { for (const block of message.message.content) { if (block.type === 'text') { turn.text += block.text; } } }
    } else if (message.type === 'result') {
      const uuids = message.user_message_uuids ?? (message.user_message_uuid === undefined ? [] : [message.user_message_uuid]);
      if (!uuids.includes(turn.uuid)) {
        if (uuids.length === 0) { this.settle(failure('providerError')); this.closing = true; this.requestClose(); }
        return;
      }
      if (turn.interrupted) { this.settle(failure('interrupted')); }
      else if (message.terminal_reason === 'prompt_too_long') { this.settle(failure('contextExhausted')); }
      else if (message.subtype === 'success' && !message.is_error) { this.settle({ kind: 'completed', text: message.result ?? turn.text }); }
      else { this.settle(failure(classify(turn.error))); }
    }
  }

  private async readMessages(): Promise<void> {
    try { for await (const message of this.query) { this.dispatch(message); } }
    catch { /* A protocol, callback or transport failure cannot acknowledge a turn. */ }
    finally {
      this.ended = true;
      this.stopAdmissions();
      this.source.bind(null);
      this.settle(failure(this.active?.interrupted ? 'interrupted' : 'subprocessExited'));
      this.requestClose();
      for (const listener of this.listeners) { try { listener(this.exitReason); } catch { /* Exit remains observable through the ended session. */ } }
    }
  }

  async sendTurn(request: ProviderTurn): Promise<ProviderOutcome> {
    if (this.ended || this.closing) { return failure('subprocessExited'); }
    if (this.active !== null) { return failure('providerError', false); }
    let resolve: (outcome: ProviderOutcome) => void = () => {};
    const completion = new Promise<ProviderOutcome>(done => { resolve = done; });
    const turn: ActiveTurn = { request, uuid: randomUUID(), resolve, sent: false, settled: false, interrupted: false, error: undefined, text: '' };
    this.active = turn;
    let overridden = false;
    try {
      if (request.override !== null) {
        if (!this.capabilities.questionOverride) { return failure('providerError', false); }
        try { await setModelChoice(this.query, request.override); overridden = true; }
        catch { this.exitReason = 'overrideReset'; this.closing = true; this.requestClose(); return failure('providerError'); }
      }
      try {
        const contextBlock = await request.beforeSend(request.contextBlock);
        if (turn.interrupted || turn.settled || this.ended || this.closing || !this.options.isCurrent(this.providerInstanceId)) { return failure(turn.interrupted ? 'interrupted' : 'subprocessExited'); }
        if (typeof contextBlock !== 'string' || !contextBlock.isWellFormed() || Buffer.byteLength(contextBlock, 'utf8') > 4194304 || !request.playerText.isWellFormed()) { return failure('providerError', false); }
        request.beforeEnqueue();
        this.prompts.push({ type: 'user', uuid: turn.uuid, session_id: this.providerSessionId, parent_tool_use_id: null, origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: contextBlock }, { type: 'text', text: request.playerText }] } });
        turn.sent = true;
        request.onSent();
      } catch (error) {
        this.closing = true;
        this.requestClose();
        if (error instanceof RuntimeCapacityError || error instanceof PendingStateCheckError) { throw error; }
        return failure('providerError');
      }
      return await completion;
    } finally {
      if (overridden && !this.ended && !this.closing) {
        try { await setModelChoice(this.query, { model: this.options.config.provider.model!, effort: this.options.config.provider.effort! }); }
        catch { this.exitReason = 'overrideReset'; this.closing = true; this.requestClose(); }
      }
      if (this.active === turn) { this.active = null; }
    }
  }

  async interrupt(): Promise<boolean> {
    const turn = this.active;
    if (turn === null || turn.settled || this.ended) { return false; }
    turn.interrupted = true;
    if (!turn.sent) { this.settle(failure('interrupted')); return true; }
    try { await boundedProviderControl(() => this.query.interrupt()); }
    catch { this.closing = true; this.requestClose(); }
    const timer = setTimeout(() => {
      if (this.active === turn && !turn.settled) { this.closing = true; this.settle(failure('interrupted')); this.requestClose(); }
    }, 30000);
    timer.unref();
    return true;
  }

  onExit(listener: (reason: ProviderExitReason) => void): void {
    if (this.ended) { listener(this.exitReason); }
    else { this.listeners.add(listener); }
  }

  close(): Promise<void> {
    this.closingPromise ??= this.closeOwned();
    return this.closingPromise;
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    this.stopAdmissions();
    this.prompts.end();
    if (this.active !== null && !this.active.settled) { this.active.interrupted = true; }
    try { await boundedProviderControl(() => this.pump, 10000); }
    catch { /* The documented grace ends with an explicit process close. */ }
    this.requestClose();
    for (const child of this.children) {
      try { await boundedProviderControl(() => child.terminated, 10000); }
      catch { child.kill('SIGTERM'); await boundedProviderControl(() => child.terminated, 15000); }
    }
    await this.options.supervisor.verifyQuiescent('provider');
  }
}

export class ClaudeProvider implements Provider {
  readonly providerId = 'claude-agent-sdk';
  readonly capabilities: ProviderCapabilities;
  private readonly options: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions) {
    assertDefaultProviderProfile(options.environment ?? process.env);
    this.options = options;
    this.capabilities = providerCapabilities(options.config);
  }

  async start(resumeSessionId: string | null, signal?: AbortSignal): Promise<ProviderSession> {
    const inheritedEnvironment = this.options.environment ?? process.env;
    assertDefaultProviderProfile(inheritedEnvironment);
    if (resumeSessionId !== null && !isOpaqueToken(resumeSessionId)) { throw new ProviderUnavailableError('Provider session identity is invalid.'); }
    signal?.throwIfAborted();
    await requirePinnedSdk();
    signal?.throwIfAborted();
    await this.options.supervisor.verifyQuiescent('provider');
    signal?.throwIfAborted();
    const environment = providerEnvironment(inheritedEnvironment);
    const children: ProviderChild[] = [];
    let session: ClaudeSession | null = null;
    let rejectAborted: ((error: Error) => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = (): void => {
      session?.cancelStartup();
      rejectAborted?.(new ProviderUnavailableError('Provider startup was cancelled.'));
    };
    try {
      signal?.throwIfAborted();
      session = new ClaudeSession(this.options, resumeSessionId, children, environment, signal);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); }
      await Promise.race([session.initialize(), aborted]);
      signal?.throwIfAborted();
      if (!session.isLive()) { throw new ProviderUnavailableError('Provider initialization ended before transfer.'); }
      return session;
    } catch {
      if (session !== null) { await session.close(); }
      else {
        // A factory can throw after spawning. Its children still have an owner and
        // must finish before startup failure can release the runtime's guard.
        for (const child of children) { child.kill('SIGTERM'); await boundedProviderControl(() => child.terminated, 15000); }
        await this.options.supervisor.verifyQuiescent('provider');
      }
      throw new ProviderUnavailableError('Provider initialization failed.');
    } finally { signal?.removeEventListener('abort', onAbort); }
  }
}
