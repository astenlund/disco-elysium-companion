import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../../../src/backend/index.ts';
import type { Kernel } from '../../../src/backend/kernel.ts';
import { assembleInstructions } from '../../../src/instructions.ts';
import { newIdentity } from '../../../src/identity.ts';
import { utcNow } from '../../../src/json.ts';
import type { ProviderSession } from '../../../src/provider.ts';
import { ProcessSupervisor, type OwnedProcess } from '../../../src/process.ts';
import { bytesHash } from '../../../src/storage.ts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const root = path.resolve(process.argv[2] ?? '');
assert.equal(path.relative(path.join(repository, '.tmp'), path.dirname(root)), '');
assert.match(path.basename(root), /^runtime-fixture-[0-9]+-[a-f0-9]{32}$/);
const backend = await openBackend({ companionRoot: root });
assert.equal((await backend.startup({ kind: 'chat' })).notOwner, false);
assert.ok(backend.status.journal.unacknowledgedEvents > 0);
const instructions = await assembleInstructions(backend.inspector, root);
const safety = await backend.providerSafety();
let active = true;
let delivered: string | null = null;
let sent = false;
const providerId = 'fixture-provider';
const providerSessionId = 'fixture-' + newIdentity();
const identity = { providerId, providerSessionId, isCurrent: () => active };
const session: ProviderSession = {
  providerInstanceId: newIdentity(), providerSessionId, credentialSource: null,
  capabilities: { streamingText: true, dialogs: false, resume: false, interrupt: false, questionOverride: false, compactionBoundaries: false },
  async sendTurn(request) {
    assert.equal(active, true);
    delivered = await request.beforeSend(request.contextBlock);
    await fs.writeFile(path.join(root, 'fixture-provider-transcript.txt'), delivered, 'utf8');
    request.onSent();
    return { kind: 'completed', text: 'Fixture provider retained the context.' };
  },
  async interrupt() { return false; },
  async close() { active = false; },
  onExit() {},
};
const bound = await backend.sessions.bind({ agentSessionVersion: 1, providerId, providerSessionId, createdAt: utcNow(), turnsCompleted: 0,
  needsState: true, instructionsSha256: instructions.sha256, stateGeneration: safety.generation }, backend.sessionProof(identity));
const snapshot = await backend.acquire({ interactionId: newIdentity(), requestReceivedAt: utcNow() });
assert.equal(snapshot.disclosureOnly, false);
const preview = await backend.preview(snapshot, bound.binding, null);
const candidate = preview.preview.candidates.find(item => item.eventCount > 0 && item.stateIncluded && item.degraded === null);
assert.ok(candidate);
const handle = await backend.prepare(snapshot, preview, candidate);
const decode = (text: string): { events: { redelivery: boolean }[]; state: unknown } => JSON.parse(text.slice('<companion-turn-context>'.length, -'</companion-turn-context>'.length));
assert.ok(decode(handle.contextBlock).events.some(event => !event.redelivery));
const internal = backend as unknown as { readonly kernel: Kernel };
const cursorPath = path.join(backend.scope.dataRoot, 'journal', 'cursor-agent-session.json');
const cursorBefore = await fs.readFile(cursorPath);
const bindingPath = path.join(backend.scope.dataRoot, 'agent-session.json');
const indexPath = path.join(backend.scope.dataRoot, 'agent-session-index.json');
const bindingBefore = await fs.readFile(bindingPath);
const indexBefore = await fs.readFile(indexPath);
const before = (await fs.readdir(backend.scope.dataRoot, { recursive: true })).sort();
let publicationCalls = 0;
let failedPublicationExit: number | null = null;
let stagedInput: string | null = null;
let stagedHash: string | null = null;
let lockChild: OwnedProcess | null = null;
const lockSupervisor = await ProcessSupervisor.create(path.join(root, 'test-sent-lock-' + newIdentity()));
const lockScript = fileURLToPath(new URL('./hold-sent-files.ps1', import.meta.url));
const nativeRun = backend.supervisor.run.bind(backend.supervisor);
backend.supervisor.run = async (role, options, timeout, input) => {
  if (role !== 'publication') { return nativeRun(role, options, timeout, input); }
  publicationCalls++;
  assert.equal(publicationCalls, 1, 'No further publication is permitted after the injected refusal.');
  const target = options.args[options.args.indexOf('-Target') + 1]!;
  assert.equal(path.relative(cursorPath, target), '');
  stagedInput = options.args[options.args.indexOf('-InputFile') + 1]!;
  stagedHash = options.args[options.args.indexOf('-Sha256') + 1]!;
  lockChild = lockSupervisor.spawn('provider', { command: 'pwsh', args: ['-NoProfile', '-File', lockScript, '-FixtureRoot', root, '-Target', target, '-InputFile', stagedInput], cwd: root });
  const child = lockChild;
  let readyTimer: NodeJS.Timeout;
  const locked = new Promise<void>((resolve, reject) => {
    let output = '';
    readyTimer = setTimeout(() => reject(new Error('Sharing-lock helper did not become ready.')), 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 32) { reject(new Error('Unexpected sharing-lock output.')); }
      else if (output.trim() === 'locked') { resolve(); }
    });
    child.terminated.then(result => { if (output.trim() !== 'locked') { reject(new Error(`Sharing-lock helper ended before readiness: ${result.code}`)); } }, reject);
  });
  child.stderr.resume();
  try { await Promise.all([child.ready, locked]); }
  finally { clearTimeout(readyTimer!); }
  const result = await nativeRun(role, options, timeout, input);
  failedPublicationExit = result.exitCode;
  assert.equal(result.exitCode, 1, 'The real native replacement must fail under the sharing lock.');
  return result;
};
try { assert.equal(await backend.markSent(handle), false); }
finally {
  const child = lockChild as OwnedProcess | null;
  if (child !== null) {
    child.stdin.end();
    const ended = await child.terminated;
    assert.equal(ended.code, 0);
    assert.equal(ended.failure, null);
    await lockSupervisor.verifyQuiescent('provider');
  }
}
assert.equal(internal.kernel.publisher.blocked, true);
assert.equal(failedPublicationExit, 1);
assert.equal(publicationCalls, 1);
assert.ok(stagedInput !== null && stagedHash !== null);
assert.equal(bytesHash(await fs.readFile(stagedInput)), stagedHash);
const afterFailure = (await fs.readdir(backend.scope.dataRoot, { recursive: true })).sort();
assert.deepEqual(afterFailure.filter(name => !before.includes(name)), [path.relative(backend.scope.dataRoot, stagedInput)]);
let actualHash: string | null = null;
const outcome = await session.sendTurn({ contextBlock: handle.contextBlock, playerText: 'Verify retained context.', override: null,
  askUser: async () => ({ cancelled: true }), onSignal: () => {},
  beforeSend: async () => {
    const context = await backend.copyForSend(handle, bound.binding, identity);
    assert.equal(context.redelivery, true);
    assert.equal(context.candidate.fingerprint, candidate.fingerprint);
    actualHash = context.candidate.sha256;
    return context.text;
  }, beforeEnqueue: () => {}, onSent: () => { sent = true; },
});
assert.equal(outcome.kind, 'completed');
assert.equal(sent, true);
assert.equal(typeof delivered, 'string');
assert.equal(bytesHash(Buffer.from(delivered!)), actualHash);
const context = decode(delivered!);
assert.equal(context.events.length, candidate.eventCount);
assert.ok(context.events.every(event => event.redelivery));
assert.notEqual(context.state, null);
assert.equal(publicationCalls, 1);
assert.deepEqual((await fs.readdir(backend.scope.dataRoot, { recursive: true })).sort(), afterFailure);
await assert.rejects(backend.acknowledge(handle, bound.binding, identity, { compactedDuringTurn: false, compactionCapability: false }));
assert.deepEqual(await fs.readFile(cursorPath), cursorBefore);
assert.deepEqual(await fs.readFile(bindingPath), bindingBefore);
assert.deepEqual(await fs.readFile(indexPath), indexBefore);
assert.equal(publicationCalls, 1);
await session.close();
await backend.inspector.idle();
for (const role of ['core', 'publication', 'provider', 'watcher', 'metadata'] as const) { await backend.supervisor.verifyQuiescent(role); }
assert.equal(JSON.parse(await fs.readFile(path.join(backend.scope.dataRoot, 'runtime.json'), 'utf8')).cleanShutdown, false);
assert.equal(internal.kernel.guard.held, true);
process.stdout.write(JSON.stringify({ proof: 'sent-mark-fallback', dataRoot: backend.scope.dataRoot, events: candidate.eventCount, failedPublicationExit,
  additionalPublications: publicationCalls - 1, retainedInput: path.basename(stagedInput), cleanShutdown: false }) + '\n');
// Natural process exit owns guard release. Production shutdown and every durable
// authority retain their failure state, including the unacknowledged cursor.
