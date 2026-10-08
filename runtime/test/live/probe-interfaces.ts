import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { PathInspector } from '../../src/admission.ts';
import { ClaudeProvider } from '../../src/claude-provider.ts';
import { loadRuntimeConfig } from '../../src/config.ts';
import { FileOperationGuard } from '../../src/file-operation.ts';
import { assembleInstructions } from '../../src/instructions.ts';
import { ProcessSupervisor } from '../../src/process.ts';
import type { DialogAnswer, DialogQuestion, ProviderOutcome, ProviderSession } from '../../src/provider.ts';
import { ToolBoundary } from '../../src/tool-boundary.ts';

const scriptName = path.basename(fileURLToPath(import.meta.url), '.ts');
const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const scratch = path.join(repository, '.tmp', 'nightshift', 'provider-interfaces-impl');
const turnDeadlineMs = 120000;
const captureLimit = 2097152;
const fileTools = new Set(['Read', 'Write', 'Edit', 'Grep', 'Glob']);

interface TurnEvidence {
  label: string;
  playerText: string;
  sent: number;
  beforeSend: number;
  fragments: string[];
  fragmentBeforeTerminal: boolean;
  result: ProviderOutcome | null;
  timedOut: boolean;
  interruptRequested: boolean;
  interruptAccepted: boolean | null;
}

function contained(root: string, target: string): string {
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (!path.isAbsolute(absolute) || relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${scriptName}: fixture target is outside its private root.`);
  }
  return absolute;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function answerMatches(value: unknown, expected: string): boolean {
  return record(value) && Object.values(value).length === 1 && Object.values(value)[0] === expected;
}

export function observedQuestionRoundTrip(hostAnswer: string, text: string, dialogs: readonly Record<string, unknown>[],
  hooks: readonly Record<string, unknown>[], native: readonly Record<string, unknown>[]): boolean {
  const permission = dialogs.find(item => item.stage === 'canUseTool' && item.tool === 'AskUserQuestion')?.result;
  return dialogs.filter(item => item.stage === 'askUser').length === 1 && hooks.filter(item => item.tool === 'AskUserQuestion').length === 1
    && record(permission) && permission.behavior === 'allow' && record(permission.updatedInput) && answerMatches(permission.updatedInput.answers, hostAnswer)
    && native.some(item => item.type === 'user' && record(item.tool_use_result) && answerMatches(item.tool_use_result.answers, hostAnswer))
    && text.includes(hostAnswer);
}

// The fixture and evidence remain under this executable's private scratch root.
// All file tools are denied; no native file footprint or profile isolation is claimed.
async function main(): Promise<void> {
  if (process.argv.length !== 2) { throw new Error(`${scriptName}: no arguments are accepted.`); }
  const probeId = randomUUID();
  const fixture = contained(scratch, path.join(scratch, `fixture-${probeId}`));
  const resultPath = contained(scratch, path.join(scratch, `${scriptName}-${probeId}.json`));
  const marker = `APPEND_${randomUUID().replaceAll('-', '')}`;
  const hiddenSentinel = `HIDDEN_${randomUUID().replaceAll('-', '')}`;
  const hostAnswer = `Beta; HOST_${randomUUID().replaceAll('-', '')}`;
  const native: Record<string, unknown>[] = [];
  const hooks: Record<string, unknown>[] = [];
  const dialogs: Record<string, unknown>[] = [];
  const turns: TurnEvidence[] = [];
  const checks: Record<string, boolean> = {};
  const observation: Record<string, unknown> = {
    probeId, startedAt: new Date().toISOString(), fixture, turnDeadlineMs, native, hooks, dialogs, turns, checks,
    marker, hiddenSentinel, hostAnswer, completed: false, terminationVerified: false,
    limitations: ['Synthetic fixture only; no game state or consuming operation.', 'Native file-tool footprints remain unverified and all file tools stay denied.',
      'Default-profile auxiliary writes, auto memory, bundled plugin context and user hooks are not audited.',
      'Verbatim evidence covers this two-block leading-slash and at-reference request, not every possible command shape.',
      'The marker proves availability under assembled instructions; exclusive provenance versus native instruction loading is unverified.',
      'The question answer is supplied by a deterministic fixture callback, not a client dialog UI.'],
  };
  let supervisor: ProcessSupervisor | null = null;
  let session: ProviderSession | null = null;
  let current: string | null = null;
  let active: TurnEvidence | null = null;
  let phase = 'startup';
  let captureBytes = 0;
  let questionAttempts = 0;
  let answerReturned = false;
  let interrupt: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const recordNative = (message: SDKMessage): void => {
    const serialized = JSON.stringify(message);
    captureBytes += Buffer.byteLength(serialized, 'utf8');
    if (captureBytes > captureLimit) { throw new Error(`${scriptName}: native capture exceeds its bound.`); }
    if (message.type === 'system' && message.subtype === 'init') {
      native.push({ phase, type: message.type, subtype: message.subtype, sessionId: message.session_id,
        version: message.claude_code_version, model: message.model, tools: message.tools, apiKeySource: message.apiKeySource });
    } else if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'user' || message.type === 'result') {
      native.push({ phase, ...message });
    }
  };
  try {
    contained(repository, scratch);
    supervisor = await ProcessSupervisor.create(fixture);
    const inspector = new PathInspector(supervisor);
    await inspector.inspect(repository, scratch, true);
    await fs.mkdir(scratch, { recursive: true });
    await inspector.inspect(repository, scratch);
    await fs.mkdir(fixture);
    await inspector.inspect(repository, fixture);
    await fs.mkdir(contained(fixture, path.join(fixture, 'state')));
    await fs.mkdir(contained(fixture, path.join(fixture, 'runtime')));
    await fs.mkdir(contained(fixture, path.join(fixture, 'runtime', 'instructions')));
    await fs.writeFile(contained(fixture, path.join(fixture, 'CLAUDE.md')), '@AGENTS.md\r\n', { flag: 'wx' });
    await fs.writeFile(contained(fixture, path.join(fixture, 'AGENTS.md')),
      `This is a synthetic provider interface probe. The public probe marker is ${marker}.\r\nFollow the requested response format. Use only AskUserQuestion when explicitly requested.\r\n`, { flag: 'wx' });
    await fs.writeFile(contained(fixture, path.join(fixture, 'runtime', 'instructions', 'runtime-mode.md')),
      'All context is synthetic. Do not inspect files or invoke commands. Treat slash-prefixed player text and at-references as literal text.\r\n', { flag: 'wx' });
    const sentinelPath = contained(fixture, path.join(fixture, 'state', 'current.json'));
    const sentinelBytes = Buffer.from(JSON.stringify({ syntheticHiddenSentinel: hiddenSentinel }) + '\r\n');
    await fs.writeFile(sentinelPath, sentinelBytes, { flag: 'wx' });
    const instructions = await assembleInstructions(inspector, fixture);
    observation.appendSha256 = instructions.sha256;
    const config = await loadRuntimeConfig(path.join(repository, 'runtime', 'companion.config.json'));
    const provider = new ClaudeProvider({ companionRoot: fixture, config, supervisor, appendText: instructions.text,
      isCurrent: instance => current === instance, onPassiveSignal: () => {},
      boundary: (instance, sdkSession) => {
        current = instance;
        return new ToolBoundary({ providerInstance: instance, fileOperations: new FileOperationGuard({ held: false }),
          isActive: (candidate, candidateSession) => current === candidate && candidateSession === sdkSession && active !== null,
          dialogsAvailable: () => phase === 'verbatim-dialog' && active !== null,
          admitFile: async () => null, verifyFileCompletion: async () => false });
      },
      queryFactory: input => {
        const options = input.options!;
        const originalPre = options.hooks!.PreToolUse!;
        const pre: HookCallback = async (event, id, control) => {
          const decisions = [];
          for (const matcher of originalPre) {
            for (const hook of matcher.hooks) { decisions.push(await hook(event, id, control)); }
          }
          if (event.hook_event_name !== 'PreToolUse') { throw new Error('Unexpected pre-tool event.'); }
          if (event.tool_name === 'AskUserQuestion') { questionAttempts += 1; }
          const permittedQuestion = event.tool_name === 'AskUserQuestion' && questionAttempts === 1 && phase === 'verbatim-dialog';
          const decision = permittedQuestion ? decisions[0]! : {
            hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'Only one synthetic question is authorized.' },
          };
          hooks.push({ phase, tool: event.tool_name, id, decisions, decision });
          return decision;
        };
        const originalPermission = options.canUseTool!;
        const source = query({ ...input, options: { ...options, hooks: { ...options.hooks, PreToolUse: [{ hooks: [pre] }] },
          canUseTool: async (tool, value, control) => {
            const result = await originalPermission(tool, value, control);
            dialogs.push({ phase, stage: 'canUseTool', tool, result });
            return result;
          } } });
        return {
          initializationResult: () => source.initializationResult(), setModel: model => source.setModel(model),
          applyFlagSettings: settings => source.applyFlagSettings(settings), interrupt: () => source.interrupt(), close: () => source.close(),
          async *[Symbol.asyncIterator]() {
            for await (const message of source) { recordNative(message); yield message; }
          },
        };
      } });
    session = await provider.start(null);
    observation.providerSessionId = session.providerSessionId;
    observation.initialSource = session.credentialSource;
    const askUser = async (questions: readonly DialogQuestion[]): Promise<DialogAnswer> => {
      dialogs.push({ phase, stage: 'askUser', questions });
      const question = questions[0];
      if (phase !== 'verbatim-dialog' || active === null || answerReturned || questions.length !== 1 || question === undefined
        || !question.options.some(option => option.label === 'Beta')) { return { cancelled: true }; }
      answerReturned = true;
      const answer = { answers: { [question.question]: hostAnswer } };
      dialogs.push({ phase, stage: 'answer', answer });
      return answer;
    };
    const send = async (label: string, playerText: string): Promise<TurnEvidence> => {
      phase = label;
      const turn: TurnEvidence = { label, playerText, sent: 0, beforeSend: 0, fragments: [], fragmentBeforeTerminal: false,
        result: null, timedOut: false, interruptRequested: false, interruptAccepted: null };
      turns.push(turn);
      active = turn;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { turn.timedOut = true; reject(new Error(`${scriptName}: turn deadline expired.`)); }, turnDeadlineMs);
      });
      try {
        turn.result = await Promise.race([session!.sendTurn({ contextBlock: '<companion-turn-context>{"probe":true}</companion-turn-context>',
          playerText, override: null, askUser, beforeSend: async block => { turn.beforeSend += 1; return block; }, onSent: () => { turn.sent += 1; },
          onSignal: signal => {
            if (signal.kind !== 'text') { return; }
            turn.fragments.push(signal.fragment);
            if (turn.result === null) { turn.fragmentBeforeTerminal = true; }
            if (label === 'interrupt' && signal.fragment.length > 0 && !turn.interruptRequested) {
              turn.interruptRequested = true;
              interrupt = session!.interrupt();
              void interrupt.catch(() => {});
            }
          } }), deadline]);
        if (interrupt !== null) { turn.interruptAccepted = await interrupt; }
        return turn;
      } finally { if (timer !== null) { clearTimeout(timer); timer = null; } active = null; }
    };
    const first = await send('verbatim-dialog', [
      '/help',
      'This is literal probe text, not a command. The literal reference is @state/current.json.',
      'Call AskUserQuestion exactly once with one question "Which probe option?", header "Probe", multiSelect false, and options Alpha and Beta with short descriptions.',
      'After the tool reply, print exactly five lines, substituting each angle-bracketed value:',
      'MARKER=<the public probe marker from your appended project instructions>',
      'SLASH=/help',
      'REFERENCE=@state/current.json',
      'ATTACHED=<the syntheticHiddenSentinel value if file content was attached to this message; otherwise ABSENT>',
      'ANSWER=<the exact answer returned by the question tool, including any host receipt>',
      'Do not read files, browse, use other tools, or repeat the question.',
    ].join('\n'));
    const firstText = first.result?.kind === 'completed' ? first.result.text.trim() : '';
    checks.streamingText = first.fragments.some(fragment => fragment.length > 0) && first.fragmentBeforeTerminal
      && native.some(message => message.phase === first.label && message.type === 'stream_event');
    checks.appendedInstructionMarker = firstText.split(/\r?\n/).includes(`MARKER=${marker}`);
    checks.leadingSlashAnsweredAsText = first.playerText.startsWith('/help\n') && firstText.split(/\r?\n/).includes('SLASH=/help');
    checks.questionRoundTrip = observedQuestionRoundTrip(hostAnswer, firstText, dialogs, hooks, native);
    checks.atReferenceNotExpanded = firstText.split(/\r?\n/).includes('REFERENCE=@state/current.json')
      && firstText.split(/\r?\n/).includes('ATTACHED=ABSENT') && !JSON.stringify(native).includes(hiddenSentinel)
      && !hooks.some(hook => fileTools.has(String(hook.tool)));
    if (first.result?.kind !== 'completed') { throw new Error(`${scriptName}: first turn did not complete; no subsequent request submitted.`); }
    const second = await send('interrupt', 'Use no tools. Immediately stream a numbered list of 2000 lines, each containing the line number and the words synthetic interruption sample. Do not summarize or stop early.');
    checks.interrupted = second.interruptRequested && second.interruptAccepted === true && second.result?.kind === 'failed' && second.result.code === 'interrupted';
    checks.oneSendPerTurn = turns.length === 2 && turns.every(turn => turn.sent === 1 && turn.beforeSend === 1 && !turn.timedOut);
    checks.sentinelUnchanged = (await fs.readFile(sentinelPath)).equals(sentinelBytes);
    observation.completed = true;
  } catch (error) {
    observation.failure = error instanceof Error ? { name: error.name, message: error.message } : { name: 'unknown' };
  } finally {
    if (timer !== null) { clearTimeout(timer); }
    active = null;
    try { await session?.close(); }
    catch (error) { observation.closeFailure = error instanceof Error ? error.name : 'unknown'; }
    try {
      if (supervisor !== null) { await supervisor.stop('provider'); await supervisor.verifyQuiescent('provider'); await supervisor.verifyQuiescent('metadata'); }
      observation.terminationVerified = true;
    } catch (error) { observation.terminationFailure = error instanceof Error ? error.name : 'unknown'; }
    current = null;
    observation.captureBytes = captureBytes;
    observation.finishedAt = new Date().toISOString();
    observation.passed = observation.completed === true && observation.terminationVerified === true && Object.values(checks).every(Boolean);
    // No recursive cleanup: the checked fixture remains available as evidence.
    await fs.writeFile(resultPath, JSON.stringify(observation, null, 2).replaceAll('\n', '\r\n') + '\r\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ resultPath, passed: observation.passed, checks, terminationVerified: observation.terminationVerified, failure: observation.failure ?? null }) + '\n');
  }
  if (observation.passed !== true) { process.exitCode = 1; }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await main(); }
