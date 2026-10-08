import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openBackend, readBackendStatus } from './backend/index.ts';
import type { BackendCommand, BackendStartup } from './backend/api.ts';
import { createChatRuntime } from './runtime.ts';
import { runTextClient } from './text-client.ts';

export type CliCommand = BackendCommand | { readonly kind: 'status' };
export function parseCommand(args: readonly string[]): CliCommand | null {
  if (args.length === 0) { return { kind: 'chat' }; }
  if (args.length === 1 && (args[0] === 'chat' || args[0] === 'status' || args[0] === 'repair')) { return { kind: args[0] }; }
  if (args[0] === 'consumer' && (args[1] === 'runtime' || args[1] === 'bridge')
    && (args.length === 2 || args.length === 3 && args[1] === 'bridge' && args[2] === '--abandon-undelivered')) {
    return { kind: 'consumer', owner: args[1], abandonUndelivered: args.length === 3 };
  }
  return null;
}

export function operatorExitCode(kind: 'consumer' | 'repair', result: BackendStartup, journalFault: boolean): number {
  if (kind === 'consumer') { return result.consumerResult?.success === true ? 0 : 1; }
  return result.notOwner || journalFault ? 1 : 0;
}

export async function runCli(args: readonly string[], companionRoot = fileURLToPath(new URL('../../', import.meta.url)), write: (text: string) => void = text => { process.stdout.write(`${text}\n`); }): Promise<number> {
  const command = parseCommand(args);
  if (command === null) { write('Usage: chat | status | consumer <runtime|bridge> [--abandon-undelivered] | repair'); return 2; }
  if (command.kind === 'status') {
    write(JSON.stringify(await readBackendStatus(companionRoot)));
    write('Consumer, freshness, operational warnings, watcher, provider and window recovery are available only in the running chat client.');
    return 0;
  }
  if (command.kind === 'chat') {
    const runtime = await createChatRuntime(companionRoot);
    if (runtime.result === 'notOwner') { write('notOwner: Continue in the bridge client, or explicitly run consumer runtime to hand ownership over.'); return 1; }
    if (runtime.result === 'providerUnavailable') { write('providerUnavailable: The provider could not start.'); return 1; }
    await runTextClient(runtime.host);
    return 0;
  }
  const backend = await openBackend({ companionRoot });
  try {
    const result = await backend.startup(command);
    write(JSON.stringify(command.kind === 'consumer' ? result.consumerResult ?? { result: 'consumerUnavailable' } : { result: result.notOwner ? 'notOwner' : 'completed', status: backend.status }));
    return operatorExitCode(command.kind, result, backend.status.journal.state === 'fault');
  } finally { await backend.shutdown(true); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runCli(process.argv.slice(2)); }
  catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'runtimeUnavailable';
    process.stderr.write(`${code}: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
