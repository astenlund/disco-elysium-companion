import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { HostDialog, HostEvent, HostStatus, SessionHostV1 } from './session-host-contract.ts';

export function credentialSourceLabel(source: string | null): string {
  if (source === null) { return 'unavailable'; }
  if (source === 'none') { return 'no API key reported; non-API-key method unspecified'; }
  return source;
}

export function formatStatus(status: HostStatus): string {
  const fault = status.journal.fault === null ? '' : ` (${status.journal.fault})`;
  return `consumer: ${status.consumer}; state: ${status.freshness.state}; journal: ${status.journal.state}${fault}; safety: ${status.stateSafety.state}; provider: ${status.provider.state}; API-key source: ${credentialSourceLabel(status.provider.credentialSource)}; window recovery: ${status.windowRecovery?.state ?? 'unavailable'}`;
}

export interface TextClientOptions { readonly input?: Readable; readonly output?: Writable; readonly terminal?: boolean }

// Rendering and input routing own no provider or state authority. Dialog answers
// remain one correlated host operation, including across a detach and reattach.
export async function runTextClient(host: SessionHostV1, options: TextClientOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const line = (text: string): void => { output.write(`${text}\n`); };
  let dialog: HostDialog | null = null;
  let question = 0;
  let answers: Record<string, string> = {};
  let running = false;
  let streamed = false;
  let quitting = false;
  let status: HostStatus | null = null;
  const rl = createInterface({ input, output, terminal: options.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY) });

  const renderQuestion = (): void => {
    const current = dialog?.questions[question];
    if (current === undefined) { return; }
    line(current.question);
    current.options.forEach((option, index) => {
      line(`${index + 1}. ${option.label}: ${option.description}`);
      if (option.preview !== undefined && !current.multiSelect) { line(option.preview); }
    });
    line(current.multiSelect ? 'Choose numbers separated by commas, or enter your own answer. /cancel dismisses.' : 'Choose a number, or enter your own answer. /cancel dismisses.');
  };
  const receive = (event: HostEvent): void => {
    if (event.type === 'status.changed') { status = event.status; line(`[${formatStatus(event.status)}]`); }
    else if (event.type === 'turn.started') { running = true; streamed = false; }
    else if (event.type === 'turn.delta') { output.write(event.fragment); streamed = true; }
    else if (event.type === 'turn.completed') { running = false; if (streamed) { line(''); } else { line(event.text); } }
    else if (event.type === 'turn.failed') {
      running = false;
      if (streamed) { line(''); }
      line(event.code === 'contextExhausted'
        ? `The attempted combined input exceeded provider capacity. ${event.retryable ? 'Another player submission may attempt a smaller context.' : 'No further attempt is currently admitted for this unchanged input.'} Changing the question, an available model choice, or /new may help; none is guaranteed.`
        : `Turn failed: ${event.code}.`);
    } else if (event.type === 'dialog.requested') { dialog = event; question = 0; answers = {}; renderQuestion(); }
    else if (event.type === 'dialog.closed') { if (dialog?.dialogId === event.dialogId) { dialog = null; answers = {}; } }
    else if (event.type === 'context.compacted') { line('[Provider context compacted; current state is wanted again.]'); }
    else if (event.type === 'notice') {
      if (event.code === 'stateContextInvalidated') { line('[Earlier state-based guidance may be unreliable. A clean session must revalidate it.]'); }
      else { line(`[${event.code}${event.reason === null ? '' : `: ${event.reason}`}]`); }
    }
  };
  const attached = host.attach(receive);
  if (attached.result !== 'attached') { rl.close(); throw new Error('A presentation client is already attached.'); }
  status = attached.snapshot.status;
  line(formatStatus(status));
  line('Enter a question. /think <question>, /new, /status, /quit.');
  if (attached.snapshot.openDialog !== null) { dialog = attached.snapshot.openDialog; running = true; renderQuestion(); }

  let closePromise: Promise<void> | null = null;
  const quit = (): Promise<void> => {
    quitting = true;
    closePromise ??= host.shutdown().finally(() => rl.close());
    return closePromise;
  };
  let command = Promise.resolve();
  const accept = async (text: string): Promise<void> => {
    if (quitting) { return; }
    if (text === '/quit') { await quit(); return; }
    if (text === '/status') { if (status !== null) { line(formatStatus(status)); } return; }
    if (dialog !== null) {
      const current = dialog.questions[question]!;
      if (text === '/cancel') { host.answerDialog({ dialogId: dialog.dialogId, cancelled: true }); return; }
      if (text.trim().length === 0) { line('An answer is required.'); return; }
      const pieces = current.multiSelect ? text.split(',').map(part => part.trim()) : [text];
      const values = pieces.map(part => /^[1-9][0-9]*$/.test(part) ? current.options[Number(part) - 1]?.label ?? part : part);
      answers[current.question] = values.join(', ');
      question += 1;
      if (question < dialog.questions.length) { renderQuestion(); }
      else {
        const result = host.answerDialog({ dialogId: dialog.dialogId, answers });
        if (result !== 'accepted') { line(`Dialog answer: ${result}.`); question = 0; answers = {}; renderQuestion(); }
      }
      return;
    }
    if (text === '/new') { line(`New session: ${await host.startNewAgentSession()}.`); return; }
    const override = text.startsWith('/think ');
    const result = host.submitChat({ text: override ? text.slice(7) : text, questionOverride: override });
    if (result.result !== 'admitted') { line(`Question not sent: ${result.result}.`); }
  };
  rl.on('line', text => { command = command.then(() => accept(text)).catch(error => { line(`Client error: ${(error as Error).message}`); }); });
  rl.on('SIGINT', () => {
    command = command.then(async () => { if (running) { line(`Interrupt: ${await host.interrupt()}.`); } else { await quit(); } })
      .catch(error => line(`Client error: ${(error as Error).message}`));
  });
  try { await new Promise<void>(resolve => rl.once('close', resolve)); await command; await (closePromise ?? host.shutdown()); }
  finally { host.detach(); }
}
