// A scripted stand-in for the native helper service, speaking its framed wire protocol on stdin and stdout. The scenario
// arrives as JSON in FAKE_HELPER_SCENARIO; every received request is appended to the scenario's log file as one JSON line.
import { appendFileSync } from 'node:fs';

export type FakeAction =
  | { readonly kind: 'ok'; readonly result?: unknown; readonly delayMs?: number }
  | { readonly kind: 'error'; readonly code: string; readonly delayMs?: number }
  | { readonly kind: 'hang' }
  | { readonly kind: 'exit'; readonly delayMs?: number }
  | { readonly kind: 'stderr' }
  | { readonly kind: 'oversize' }
  | { readonly kind: 'malformed' };

export interface FakeScenario {
  readonly sha256: string;
  readonly volume: string;
  readonly fileId: string;
  readonly created: string;
  readonly log: string;
  readonly hello?: { readonly nonce?: string; readonly pidOffset?: number; readonly created?: string; readonly fileId?: string; readonly delayMs?: number; readonly stderr?: boolean };
  /** Actions per operation, consumed in order; an operation without a remaining action is answered ok. */
  readonly ops?: Readonly<Record<string, readonly FakeAction[]>>;
}

const scenario = JSON.parse(process.env['FAKE_HELPER_SCENARIO'] ?? '{}') as FakeScenario;
const nonce = process.argv[2] ?? '';
const queues = new Map(Object.entries(scenario.ops ?? {}).map(([op, actions]) => [op, [...actions]]));

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function defaultResult(op: string, request: Record<string, unknown>): unknown {
  if (op === 'jobStates') { return { jobs: (request['names'] as string[]).map(name => ({ name, state: 'absent', processes: [] })) }; }
  if (op === 'bindScope') { return { bound: true }; }
  if (op === 'processIdentity') { return { exists: true, pid: request['pid'], created: scenario.created }; }
  return { done: true };
}

function later(delayMs: number | undefined, action: () => void): void {
  if (delayMs === undefined || delayMs <= 0) { action(); } else { setTimeout(action, delayMs); }
}

function answer(request: Record<string, unknown>): void {
  const op = String(request['op']);
  const seq = request['seq'];
  appendFileSync(scenario.log, JSON.stringify({ pid: process.pid, op, seq, deadlineMs: request['deadlineMs'] }) + '\n');
  const action: FakeAction = queues.get(op)?.shift() ?? { kind: 'ok' };
  switch (action.kind) {
    case 'ok': later(action.delayMs, () => process.stdout.write(frame({ version: 1, seq, op, status: 'ok', result: action.result ?? defaultResult(op, request) }))); break;
    case 'error': later(action.delayMs, () => process.stdout.write(frame({ version: 1, seq, op, status: 'error', code: action.code }))); break;
    case 'hang': break;
    case 'exit': later(action.delayMs, () => process.exit(3)); break;
    case 'stderr': process.stderr.write('x'); break;
    case 'oversize': { const header = Buffer.alloc(4); header.writeUInt32BE(0x7fffffff); process.stdout.write(header); break; }
    case 'malformed': process.stdout.write(frame({ version: 1, seq, op, status: 'ok' })); break;
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) { return; }
    const body = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    answer(JSON.parse(body.toString('utf8')) as Record<string, unknown>);
  }
});
process.stdin.on('end', () => process.exit(0));

const hello = scenario.hello ?? {};
later(hello.delayMs, () => {
  if (hello.stderr === true) { process.stderr.write('x'); return; }
  process.stdout.write(frame({ version: 1, nonce: hello.nonce ?? nonce, pid: process.pid + (hello.pidOffset ?? 0), created: hello.created ?? scenario.created,
    imageSha256: scenario.sha256, imageVolume: scenario.volume, imageFileId: hello.fileId ?? scenario.fileId }));
});
