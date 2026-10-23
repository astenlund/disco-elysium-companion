import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeProvider } from '../../src/claude-provider.ts';
import { loadRuntimeConfig, type ModelChoice } from '../../src/config.ts';
import { FileOperationGuard } from '../../src/file-operation.ts';
import type { ProviderSession } from '../../src/provider.ts';
import { hostedTools, ToolBoundary } from '../../src/tool-boundary.ts';
import { companionFixture } from '../support/companion.ts';
import { createTestNative } from '../support/native-helper.ts';

const scriptName = path.basename(fileURLToPath(import.meta.url), '.ts');
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const resultsDirectory = path.join(repository, '.tmp', 'nightshift', 'client-impl');

// This executable uses only a repository-private fixture and default-profile
// provider persistence. It never opens game saves, consumes state, or switches
// the real root's consumer. Native file-operation footprints remain unverified.
async function main(): Promise<void> {
  if (process.argv.length !== 2) { throw new Error(`${scriptName}: no arguments are accepted.`); }
  const fixture = await companionFixture();
  const resultPath = path.join(resultsDirectory, `${scriptName}-${randomUUID()}.json`);
  const turns: Record<string, unknown>[] = [];
  const initialization: Record<string, unknown>[] = [];
  const controls: Record<string, unknown>[] = [];
  const observation: Record<string, unknown> = { startedAt: new Date().toISOString(), completed: false, turns, initialization, controls,
    unverified: ['native file-operation footprints', 'default-profile auxiliary-write footprint', 'live compaction boundary', 'live provider-window exhaustion', 'user setting sources', 'built-in plugin hooks and context'] };
  let current: string | null = null;
  let session: ProviderSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phase = 'initial';
  try {
    const hookMarker = path.join(fixture.root, 'hook-executed');
    const hookScript = path.join(fixture.root, 'probe-hook.cjs');
    await fs.mkdir(path.join(fixture.root, '.claude'));
    await fs.writeFile(hookScript, "const fs = require('node:fs');\r\nconst path = require('node:path');\r\nfs.writeFileSync(path.join(__dirname, 'hook-executed'), 'EXECUTED');\r\n");
    await fs.writeFile(path.join(fixture.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${hookScript}"` }] }] } }) + '\r\n');
    const config = await loadRuntimeConfig(path.join(repository, 'runtime', 'companion.config.json'));
    const supervisor = (await createTestNative(fixture.root)).supervisor;
    const provider = new ClaudeProvider({ companionRoot: fixture.root, config, supervisor,
      appendText: 'This is a private provider integration probe. Follow each request and perform no other work or tool call.',
      isCurrent: instance => current === instance, onPassiveSignal: () => {},
      queryFactory: input => {
        const native = query(input);
        return {
          initializationResult: async () => {
            const reply = await native.initializationResult();
            initialization.push({ phase, exchange: 'initialize', hooksApplied: reply.hooks_applied ?? null, apiKeySource: reply.account?.apiKeySource ?? null,
              settingsSourcesEmpty: input.options?.settingSources?.length === 0, strictMcpConfig: input.options?.strictMcpConfig === true,
              autoMemoryDisabled: input.options?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1', bundledSkillsDisabled: input.options?.env?.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS === '1' });
            return reply;
          },
          setModel: async model => { controls.push({ phase, model }); await native.setModel(model); },
          applyFlagSettings: async settings => { controls.push({ phase, effortLevel: settings.effortLevel ?? null }); await native.applyFlagSettings(settings); },
          interrupt: () => native.interrupt(), close: () => native.close(),
          async *[Symbol.asyncIterator]() {
            for await (const message of native) {
              if (message.type === 'system' && message.subtype === 'init') {
                initialization.push({ phase, exchange: 'system/init', sessionId: message.session_id, model: message.model, tools: message.tools,
                  mcpServers: message.mcp_servers.map(server => server.name), skills: message.skills, plugins: message.plugins.map(plugin => plugin.name), apiKeySource: message.apiKeySource });
              }
              yield message;
            }
          },
        };
      },
      boundary: instance => {
        current = instance;
        return new ToolBoundary({ providerInstance: instance, fileOperations: new FileOperationGuard({ held: false }), isActive: () => false,
          dialogsAvailable: () => false, admitFile: async () => null, verifyFileCompletion: async () => false });
      } });
    session = await provider.start(null);
    observation.initialSource = session.credentialSource;
    const send = async (label: string, playerText: string, expected: string, override: ModelChoice | null = null): Promise<void> => {
      phase = label;
      const turn: Record<string, unknown> = { phase, sent: 0, beforeSend: 0, sourceLabels: [] };
      turns.push(turn);
      timer = setTimeout(() => { turn.timedOut = true; void session?.close().catch(() => { observation.terminationUnverified = true; }); }, 60000);
      try {
        const result = await session!.sendTurn({ contextBlock: '<companion-turn-context>{"probe":true}</companion-turn-context>', playerText, override,
          askUser: async () => ({ cancelled: true }), beforeSend: async context => { turn.beforeSend = Number(turn.beforeSend) + 1; return context; },
          beforeEnqueue: () => {}, onSent: () => { turn.sent = Number(turn.sent) + 1; },
          onSignal: signal => { if (signal.kind === 'source') { (turn.sourceLabels as unknown[]).push(signal.credentialSource); } } });
        turn.completed = result.kind === 'completed';
        turn.wordMatched = result.kind === 'completed' && result.text.trim() === expected;
        turn.failureCode = result.kind === 'failed' ? result.code : null;
        if (!turn.completed || !turn.wordMatched || turn.sent !== 1 || turn.beforeSend !== 1) { throw new Error('Provider probe turn did not pass.'); }
      } finally { clearTimeout(timer); timer = null; }
    };
    const nonce = `PROBE_${randomUUID().replaceAll('-', '')}`;
    await send('login', `Remember the private probe token ${nonce}. Reply with exactly OK and nothing else. Do not use tools.`, 'OK');
    const sessionId = session.providerSessionId;
    await session.close(); current = null;
    phase = 'resume';
    session = await provider.start(sessionId);
    observation.resumeIdentityMatched = session.providerSessionId === sessionId;
    await send('resume', 'Reply with exactly the private probe token from the earlier request. Do not use tools.', nonce);
    if (config.provider.questionOverride !== null && provider.capabilities.questionOverride) {
      await send('override', 'Reply with exactly OVERRIDE and nothing else. Do not use tools.', 'OVERRIDE', config.provider.questionOverride);
      await send('ordinary-after-override', 'Reply with exactly ORDINARY and nothing else. Do not use tools.', 'ORDINARY');
    }
    observation.projectHookExecuted = await fs.stat(hookMarker).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
      throw error;
    });
    const nativeInits = initialization.filter(item => item.exchange === 'system/init');
    observation.nativeInventoryObserved = turns.every(turn => nativeInits.some(item => item.phase === turn.phase));
    const expectedTools = JSON.stringify([...hostedTools].sort());
    observation.onlyFixedTools = nativeInits.every(item => Array.isArray(item.tools) && JSON.stringify([...item.tools].sort()) === expectedTools);
    observation.noMcp = nativeInits.every(item => Array.isArray(item.mcpServers) && item.mcpServers.length === 0);
    // SDK 0.3.289's disableBundledSkills declaration explicitly leaves plugins
    // unaffected. Inventory is evidence, not proof that plugin context is absent.
    observation.noSkills = nativeInits.every(item => Array.isArray(item.skills) && item.skills.length === 0);
    observation.completed = true;
    observation.finalSource = session.credentialSource;
  } catch (error) { observation.failureKind = error instanceof Error ? error.name : 'unknown'; }
  finally {
    if (timer !== null) { clearTimeout(timer); }
    try { await session?.close(); }
    catch { observation.terminationUnverified = true; }
    current = null;
    if (observation.terminationUnverified !== true) { await fixture.close(); }
    observation.finishedAt = new Date().toISOString();
    await fs.mkdir(resultsDirectory, { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify(observation, null, 2).replaceAll('\n', '\r\n') + '\r\n');
    process.stdout.write(JSON.stringify({ resultPath, ...observation }) + '\n');
  }
  if (!observation.completed || observation.resumeIdentityMatched !== true || observation.projectHookExecuted !== false || observation.nativeInventoryObserved !== true
    || observation.onlyFixedTools !== true || observation.noMcp !== true || observation.terminationUnverified === true) { process.exitCode = 1; }
}

await main();
