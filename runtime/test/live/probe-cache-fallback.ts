import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type HookJSONOutput, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { PathInspector } from '../../src/admission.ts';
import { ClaudeProvider } from '../../src/claude-provider.ts';
import { loadRuntimeConfig } from '../../src/config.ts';
import { FileToolAdapter } from '../../src/file-tool-adapter.ts';
import { assembleInstructions } from '../../src/instructions.ts';
import { ProcessSupervisor } from '../../src/process.ts';
import type { ProviderOutcome, ProviderSession } from '../../src/provider.ts';
import { companionFixture, type CompanionFixture } from '../support/companion.ts';

const scriptName = path.basename(fileURLToPath(import.meta.url), '.ts');
const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const resultsDirectory = path.join(repository, '.tmp', 'nightshift', 'cache-fallback-impl');
const turnDeadlineMs = 120000;
const captureLimit = 2097152;
const cacheRelativePath = 'memory/projects/playthrough-guidance-research.md';
const fileTools = new Set(['Read', 'Write', 'Edit', 'Grep', 'Glob']);
const digestHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface HookEvidence {
  readonly tool: string;
  readonly toolUseId: string;
  readonly input: unknown;
  readonly active: boolean;
  readonly decision: HookJSONOutput;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function denied(decision: HookJSONOutput): boolean {
  return 'hookSpecificOutput' in decision && decision.hookSpecificOutput?.hookEventName === 'PreToolUse' && decision.hookSpecificOutput.permissionDecision === 'deny';
}

function pointsAtCache(input: unknown, fixtureRoot: string): boolean {
  if (!object(input)) { return false; }
  const target = input.file_path ?? input.path;
  return typeof target === 'string' && path.resolve(fixtureRoot, target).toLowerCase() === path.resolve(fixtureRoot, cacheRelativePath).toLowerCase();
}

function syntheticContext(receipt: string): string {
  const timestamp = new Date().toISOString().replace('Z', '0000Z');
  return `<companion-turn-context>${JSON.stringify({
    companionTurnContextVersion: 1, interactionId: randomUUID().replaceAll('-', ''), requestReceivedAt: timestamp, sessionOpening: true,
    freshness: { state: 'fresh', class: null, reason: null, lastGoodGeneratedAt: timestamp },
    operational: { state: 'current', warnings: [] }, correction: null, degraded: null, events: [],
    state: {
      schemaVersion: 2, adapterVersion: 2, game: 'disco_elysium', generatedAt: timestamp,
      source: { domainId: '1'.repeat(64), saveFile: 'synthetic-fixture-only', savedAt: timestamp, byteLength: 1, contentSha256: '2'.repeat(64) },
      session: { day: 1, time: '12:00', location: 'synthetic-fixture-room', playtimeNote: null },
      character: { level: 1, xp: 0, unspentPoints: 0, money: { amount: 37.42, minorUnits: 3742, minorUnitsPerUnit: 100, currency: 'real' },
        vitals: [{ name: 'health', value: 3 }, { name: 'morale', value: 3 }], skills: [] },
      objectives: [], inventory: { owned: [], equipped: [], highlights: [] }, extra: { fixtureReceipt: receipt },
    },
  })}</companion-turn-context>`;
}

function nativeEvidence(message: SDKMessage): Record<string, unknown> | null {
  if (message.type === 'system' && message.subtype === 'init') {
    return { type: message.type, subtype: message.subtype, sessionId: message.session_id, version: message.claude_code_version,
      model: message.model, tools: message.tools, apiKeySource: message.apiKeySource };
  }
  if (message.type === 'assistant' || message.type === 'user') {
    const content = message.message.content;
    return { type: message.type, content: Array.isArray(content) ? content.filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking') : content };
  }
  if (message.type === 'result') {
    return { type: message.type, subtype: message.subtype, isError: message.is_error, terminalReason: message.terminal_reason ?? null,
      userMessageIds: message.user_message_uuids ?? [], result: 'result' in message ? message.result : null };
  }
  if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
    return { type: message.type, eventType: message.event.type, text: message.event.delta.text };
  }
  return null;
}

// Uses real project instructions with synthetic state and a private fake cache.
// This is a provider instruction probe, not a state-admission or isolation test.
async function main(): Promise<void> {
  if (process.argv.length !== 2) { throw new Error(`${scriptName}: no arguments are accepted.`); }
  const probeId = randomUUID();
  const native: Record<string, unknown>[] = [];
  const hooks: HookEvidence[] = [];
  const fragments: string[] = [];
  const hardChecks: Record<string, boolean> = {};
  const receipt = `CONTEXT_${randomUUID().replaceAll('-', '')}`;
  const cacheSentinel = `UNREAD_SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
  const observation: Record<string, unknown> = { probeId, startedAt: new Date().toISOString(), turnDeadlineMs, native, hooks, fragments, hardChecks,
    expected: { amount: 37.42, receipt, cacheSentinel }, sent: 0, beforeSend: 0, completed: false, terminationVerified: false, fixtureClosed: false,
    responseAssessment: 'pending', limitations: ['One synthetic opening turn; no real game state or cache is read.',
      'The context represents admitted state for the instruction probe; this executable does not test core acquisition or admission.',
      'Response wording requires semantic inspection; lexical observations are not proof of disclosure or persistence claims.',
      'SDK streams do not expose every post-tool attachment. No whole-profile, complete-context or file-footprint isolation claim is made.',
      'All native file tools remain refused by production FileToolAdapter.'],
  };
  let fixture: CompanionFixture | null = null;
  let supervisor: ProcessSupervisor | null = null;
  let adapter: FileToolAdapter | null = null;
  let session: ProviderSession | null = null;
  let current: string | null = null;
  let currentSession: string | null = null;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let captureBytes = 0;
  let resultPath: string | null = null;
  try {
    fixture = await companionFixture('empty');
    observation.fixture = fixture.root;
    supervisor = await ProcessSupervisor.create(fixture.root);
    const inspector = new PathInspector(supervisor);
    await inspector.inspect(repository, resultsDirectory, true);
    await fs.mkdir(resultsDirectory, { recursive: true });
    await inspector.inspect(repository, resultsDirectory);
    resultPath = path.join(resultsDirectory, `${scriptName}-${probeId}.json`);
    const instructionSources = [
      { relative: 'AGENTS.md', snapshot: `agents-${probeId}.md` },
      { relative: 'runtime/instructions/runtime-mode.md', snapshot: `runtime-mode-${probeId}.md` },
    ];
    const instructionEvidence: Record<string, unknown>[] = [];
    for (const source of instructionSources) {
      const bytes = await fs.readFile(path.join(repository, source.relative));
      const destination = path.join(fixture.root, source.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx' });
      await fs.writeFile(path.join(resultsDirectory, source.snapshot), bytes, { flag: 'wx' });
      const copied = await fs.readFile(destination);
      if (!copied.equals(bytes)) { throw new Error(`${scriptName}: instruction bytes changed during fixture staging.`); }
      instructionEvidence.push({ relative: source.relative, sha256: digestHash(bytes), bytes: bytes.length, snapshot: source.snapshot });
    }
    observation.instructionSources = instructionEvidence;
    await fs.writeFile(path.join(fixture.root, 'CLAUDE.md'), '@AGENTS.md\r\n', { flag: 'wx' });
    const cachePath = path.join(fixture.root, cacheRelativePath);
    const cacheBytes = Buffer.from(`# Synthetic cache sentinel\r\n\r\n${cacheSentinel}\r\n`);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, cacheBytes, { flag: 'wx' });
    const instructions = await assembleInstructions(inspector, fixture.root);
    observation.appendSha256 = instructions.sha256;
    const config = await loadRuntimeConfig(path.join(repository, 'runtime', 'companion.config.json'));
    adapter = await FileToolAdapter.create({ companionRoot: fixture.root, inspector, supervisor,
      isActive: (instance, sdkSession) => active && current === instance && currentSession === sdkSession, dialogsAvailable: () => false });
    const provider = new ClaudeProvider({ companionRoot: fixture.root, config, supervisor, appendText: instructions.text,
      isCurrent: instance => instance === current, onPassiveSignal: () => {},
      boundary: (instance, sdkSession) => { current = instance; currentSession = sdkSession; return adapter!.boundary(instance); },
      queryFactory: input => {
        const options = input.options!;
        const originalHooks = options.hooks!;
        const source = query({ ...input, options: { ...options, hooks: { ...originalHooks,
          PreToolUse: originalHooks.PreToolUse!.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(callback => async (event, id, control) => {
            const decision = await callback(event, id, control);
            if (event.hook_event_name === 'PreToolUse') {
              hooks.push({ tool: event.tool_name, toolUseId: event.tool_use_id, input: event.tool_input, active, decision });
            }
            return decision;
          }) })),
        } } });
        return { initializationResult: () => source.initializationResult(), setModel: model => source.setModel(model),
          applyFlagSettings: settings => source.applyFlagSettings(settings), interrupt: () => source.interrupt(), close: () => source.close(),
          async *[Symbol.asyncIterator]() {
            for await (const message of source) {
              captureBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
              if (captureBytes > captureLimit) { throw new Error(`${scriptName}: native evidence exceeded its capture bound.`); }
              const evidence = nativeEvidence(message);
              if (evidence !== null) { native.push(evidence); }
              yield message;
            }
          },
        };
      } });
    session = await provider.start(null);
    observation.providerSessionId = session.providerSessionId;
    const contextBlock = syntheticContext(receipt);
    const playerText = 'Give me a brief progress check from this synthetic digest: how much money do I have? Include the exact extra.fixtureReceipt value so I can identify the digest used. No action choice or outside research is needed.';
    observation.contextBlock = contextBlock;
    observation.playerText = playerText;
    active = true;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { observation.timedOut = true; reject(new Error(`${scriptName}: turn deadline expired.`)); }, turnDeadlineMs);
    });
    let outcome: ProviderOutcome;
    try {
      outcome = await Promise.race([session.sendTurn({ contextBlock, playerText, override: null, askUser: async () => ({ cancelled: true }),
        beforeSend: async block => { observation.beforeSend = Number(observation.beforeSend) + 1; return block; },
        onSent: () => { observation.sent = Number(observation.sent) + 1; },
        onSignal: signal => { if (signal.kind === 'text') { fragments.push(signal.fragment); } },
      }), deadline]);
    } finally { active = false; if (timer !== null) { clearTimeout(timer); timer = null; } }
    observation.outcome = outcome;
    const fileCalls = hooks.filter(hook => fileTools.has(hook.tool));
    const cacheCalls = fileCalls.filter(hook => pointsAtCache(hook.input, fixture!.root));
    const refusedCache = cacheCalls[0];
    const nativeDenial = refusedCache !== undefined && native.some(message => message.type === 'user'
      && Array.isArray(message.content) && message.content.some(block => object(block) && block.type === 'tool_result'
        && block.tool_use_id === refusedCache.toolUseId && block.is_error === true));
    hardChecks.oneSubmittedTurn = observation.sent === 1 && observation.beforeSend === 1;
    hardChecks.productionCacheDenial = cacheCalls.length === 1 && refusedCache!.active && denied(refusedCache!.decision) && nativeDenial;
    hardChecks.noFurtherFileAttempt = fileCalls.length === 1;
    hardChecks.allObservedFileCallsDenied = fileCalls.length > 0 && fileCalls.every(hook => denied(hook.decision));
    hardChecks.completedAfterDenial = nativeDenial && outcome.kind === 'completed';
    hardChecks.syntheticCacheUnchanged = (await fs.readFile(cachePath)).equals(cacheBytes);
    hardChecks.noCacheSentinelInObservedExchange = !JSON.stringify(native).includes(cacheSentinel);
    const response = outcome.kind === 'completed' ? outcome.text : '';
    observation.responseObservations = { response, suppliedReceiptPresent: response.includes(receipt), suppliedAmountPresent: /37[.,]42/.test(response),
      cacheMentionPresent: /cache|research notes/i.test(response), unavailableLanguagePresent: /unavailable|could(?:n.t| not)|cannot|can.t|refus|denied|unable/i.test(response),
      semanticChecksForController: ['Does the answer disclose unavailable cache consultation once?', 'Does it answer from the supplied money value?',
        'Does it avoid claiming a cache read/update succeeded or promising queued persistence?'] };
    observation.completed = true;
  } catch (error) {
    observation.failure = error instanceof Error ? { name: error.name, message: error.message } : { name: 'unknown' };
  } finally {
    active = false;
    if (timer !== null) { clearTimeout(timer); }
    try { await session?.close(); }
    catch (error) { observation.closeFailure = error instanceof Error ? error.name : 'unknown'; }
    try {
      if (supervisor !== null) {
        await supervisor.stop('provider');
        await supervisor.verifyQuiescent('provider');
        if (adapter !== null) { if (current !== null) { await adapter.providerTerminated(current); } await adapter.close(); }
        await supervisor.verifyQuiescent('metadata');
      }
      observation.terminationVerified = true;
    } catch (error) { observation.terminationFailure = error instanceof Error ? error.name : 'unknown'; }
    current = null;
    currentSession = null;
    if (fixture !== null && observation.terminationVerified === true) {
      try { await fixture.close(); observation.fixtureClosed = true; }
      catch (error) { observation.fixtureCloseFailure = error instanceof Error ? error.name : 'unknown'; }
    }
    observation.captureBytes = captureBytes;
    observation.finishedAt = new Date().toISOString();
    observation.hardChecksPassed = observation.completed === true && observation.terminationVerified === true && observation.fixtureClosed === true
      && Object.values(hardChecks).every(Boolean);
    if (resultPath !== null) { await fs.writeFile(resultPath, JSON.stringify(observation, null, 2).replaceAll('\n', '\r\n') + '\r\n', { flag: 'wx' }); }
    process.stdout.write(JSON.stringify({ resultPath, hardChecksPassed: observation.hardChecksPassed, hardChecks,
      responseObservations: observation.responseObservations ?? null, terminationVerified: observation.terminationVerified,
      fixtureClosed: observation.fixtureClosed, failure: observation.failure ?? null }) + '\n');
  }
  if (observation.hardChecksPassed !== true) { process.exitCode = 1; }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await main(); }
