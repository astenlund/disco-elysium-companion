// Opens a synthetic chat on the companion root in argv[2], attaches, exhausts its native helper and lets shutdown fail, then
// reports the shutdown outcome and each provider child's state right after that failure as one JSON line on stdout and
// returns with an exit code, as the CLI does, without forcing an exit, so a test can check whether the process ends and
// what is still running when the failed shutdown returns.
import { runChatClient } from '../../src/cli.ts';
import { testHelperImage } from './native-helper.ts';
import { processRunning } from './process-liveness.ts';
import { exhaustHelper, openSyntheticChat } from './synthetic-chat.ts';

const root = process.argv[2];
if (root === undefined) { throw new Error('Usage: exhaust-and-exit.ts <companion root>'); }
const chat = await openSyntheticChat(root, await testHelperImage());
const helper = chat.backend.supervisor.nativeHelper;
const attached = await chat.host.attachVerified(() => {});
await exhaustHelper(chat);
const providerChildren = async () => (await chat.provider.childStates())
  .map(state => ({ pid: state.identity.pid, brokerClosed: state.brokerClosed, running: processRunning(state.identity.pid) }));
const before = { provider: chat.host.status.provider.state, children: await providerChildren() };
const shutdown = await Promise.allSettled([runChatClient({ host: chat.host, helper }, host => host.shutdown())]);
const outcome = shutdown[0]!;
const providers = await providerChildren();
process.stdout.write(`${JSON.stringify({ attached: attached.result, exhausted: helper.exhausted, before, shutdown: outcome.status,
  code: outcome.status === 'rejected' ? (outcome.reason as { code?: unknown }).code ?? null : null, providers })}${String.fromCharCode(10)}`);
process.exitCode = outcome.status === 'rejected' ? 1 : 0;
