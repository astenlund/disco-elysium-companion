import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openBackend, readBackendStatus } from './backend/index.ts';
import type { BackendCommand, BackendStartup, CapacityRewindResult } from './backend/api.ts';
import { capacitySlot, RuntimeCapacityError, unknownCapacityOwed, type CapacityOwed } from './capacity.ts';
import { createChatRuntime, privateRuntimeStartup } from './runtime.ts';
import { prepareStartupHelperScratch } from './startup-helper-scratch.ts';
import { formatStartupProgress, StartupProgressReporter, type StartupProgressSink } from './startup-progress.ts';
import { formatCapacity, formatCapacityOwed, runTextClient } from './text-client.ts';

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

function capacityRewindExtentVerified(result: CapacityRewindResult | null): boolean {
  if (result === null) { return true; }
  if (result.affectedEvents === null) { return false; }
  if (result.affectedEvents === 0) { return result.fromSequence === null && result.throughSequence === null; }
  return result.fromSequence !== null && result.throughSequence !== null;
}

export function operatorExitCode(kind: 'consumer' | 'repair', result: BackendStartup): number {
  if (!result.requiredWorkCompleted) { return 1; }
  if (kind === 'consumer') { return result.consumerResult?.success === true ? 0 : 1; }
  return result.notOwner || !capacityRewindExtentVerified(result.capacityRewind) ? 1 : 0;
}

export function formatCapacityError(error: RuntimeCapacityError, owed: CapacityOwed = unknownCapacityOwed()): string {
  const slot = capacitySlot(error);
  const transition = error.transition ?? 'unclassified';
  const diagnosis = slot.state === 'unavailable' ? `capacity unavailable (${transition}: ${slot.reason})` : `capacity exhausted (${transition}: ${slot.dimensions.join(', ')})`;
  return `${diagnosis}; owed: ${formatCapacityOwed(owed)}`;
}

export function formatCliError(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'runtimeUnavailable';
  const capacity = error instanceof RuntimeCapacityError ? error : error instanceof Error && error.cause instanceof RuntimeCapacityError ? error.cause : null;
  return capacity === null ? `${code}: ${error instanceof Error ? error.message : 'Runtime operation failed.'}` : `${code}: ${formatCapacityError(capacity)}`;
}

export function formatCapacityRewind(result: CapacityRewindResult | null): string {
  if (result === null) { return 'capacity rewind: none selected or resumed'; }
  const count = (value: number | null): string => value === null ? 'unknown' : String(value);
  const verified = capacityRewindExtentVerified(result);
  const range = !verified ? 'unknown' : result.affectedEvents === 0 ? 'none' : `${result.fromSequence}..${result.throughSequence}`;
  const certainty = verified ? '' : '; extent unverified; repair incomplete';
  return `capacity rewind: affectedEvents=${verified ? count(result.affectedEvents) : 'unknown'}; inclusiveRange=${range}; retainedHandoffs=${count(result.retainedHandoffs)}; replayableHandoffs=${count(result.replayableHandoffs)}; presentationRetiredHandoffs=${count(result.presentationRetiredHandoffs)}; survivingCoreRecords=${count(result.survivingCoreRecords)}${certainty}`;
}

const directMainToken = Symbol('directMainToken');
const compiledSelectorEnabled = false;
class DirectImagePinObligation {
  private state: 'idle' | 'unknown' | 'absent' | 'ready' = 'idle';

  markPossibleTransfer(): void {
    if (this.state !== 'idle') { throw new Error('Selected image transfer has already started.'); }
    this.state = 'unknown';
  }

  verified(status: 'ready' | 'absent'): void {
    if (this.state !== 'unknown') { throw new Error('Selected image pin state is invalid.'); }
    this.state = status;
  }

  get requiresHardExit(): boolean { return this.state === 'unknown' || this.state === 'ready'; }
}

async function runCliInternal(args: readonly string[], companionRoot: string,
  write: (text: string) => void, progressSink: StartupProgressSink,
  directToken?: symbol, pins?: DirectImagePinObligation): Promise<number> {
  const command = parseCommand(args);
  if (command === null) { write('Usage: chat | status | consumer <runtime|bridge> [--abandon-undelivered] | repair'); return 2; }
  if (command.kind === 'status') {
    write(JSON.stringify(await readBackendStatus(companionRoot)));
    write('Consumer, freshness, operational warnings, watcher, provider, window recovery and capacity are available only in the running chat client.');
    return 0;
  }
  if (command.kind === 'chat') {
    const progress = new StartupProgressReporter(progressSink);
    try {
      if (directToken === directMainToken && pins === undefined) { throw new Error('Direct image pin obligation is unavailable.'); }
      const scratch = directToken === directMainToken && compiledSelectorEnabled ? await prepareStartupHelperScratch() : null;
      let selectionStartedAt: number | null = null;
      const runtime = await createChatRuntime(companionRoot, phase => progress.phase(phase), scratch === null ? {}
        : { [privateRuntimeStartup]: { selectedImageBootstrap: {
          imageRoot: path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url))),
          scratch: scratch.root, environment: scratch.environment,
          markPossibleTransfer: () => { pins!.markPossibleTransfer(); selectionStartedAt = performance.now(); },
          onVerifiedPins: status => {
            pins!.verified(status);
            if (status === 'absent') { progress.imageAbsent(selectionStartedAt === null ? 0 : performance.now() - selectionStartedAt); }
          },
        } } });
      if (runtime.result === 'notOwner') { progress.finish('notOwner'); write('notOwner: Continue in the bridge client, or explicitly run consumer runtime to hand ownership over.'); return 1; }
      if (runtime.result === 'providerUnavailable') { progress.finish('providerUnavailable'); write('providerUnavailable: The provider could not start.'); return 1; }
      await runTextClient(runtime.host, { onAttached: () => progress.finish('ready') });
      return 0;
    } catch (error) { progress.finish('failed'); throw error; }
  }
  if (command.kind === 'repair') { write('Repair may set aside undelivered journal changes if a capacity rewind is admitted, then disclose missing history with a current-state resync. Surviving exact core records remain replayable under their retained bindings. No capacity rewind is yet known.'); }
  const backend = await openBackend({ companionRoot });
  try {
    const result = await backend.startup(command);
    const exitCode = operatorExitCode(command.kind, result);
    write(JSON.stringify(command.kind === 'consumer' ? { consumerResult: result.consumerResult ?? { result: 'consumerUnavailable' }, requiredWorkCompleted: result.requiredWorkCompleted, status: backend.status }
      : { result: result.notOwner ? 'notOwner' : exitCode === 0 ? 'completed' : 'incomplete', capacityRewind: result.capacityRewind, status: backend.status }));
    write(formatCapacity(backend.status.capacity));
    if (command.kind === 'repair') { write(formatCapacityRewind(result.capacityRewind)); }
    return exitCode;
  } catch (error) {
    if (error instanceof RuntimeCapacityError) { write(formatCapacity(backend.status.capacity)); write(formatCapacityError(error, backend.status.capacity.owed)); return 1; }
    throw error;
  } finally { await backend.shutdown(true); }
}

export async function runCli(args: readonly string[], companionRoot = fileURLToPath(new URL('../../', import.meta.url)),
  write: (text: string) => void = text => { process.stdout.write(`${text}\n`); },
  progressSink: StartupProgressSink = event => { console.error(formatStartupProgress(event)); }): Promise<number> {
  return runCliInternal(args, companionRoot, write, progressSink);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const pins = new DirectImagePinObligation();
  const companionRoot = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const write = (value: string): void => { process.stdout.write(`${value}\n`); };
  const progressSink: StartupProgressSink = event => { console.error(formatStartupProgress(event)); };
  try {
    const code = await runCliInternal(process.argv.slice(2), companionRoot, write, progressSink, directMainToken, pins);
    if (pins.requiresHardExit) { process.exit(code); }
    process.exitCode = code;
  }
  catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    if (pins.requiresHardExit) { process.exit(1); }
    process.exitCode = 1;
  }
}
