import { DataRootUnavailableError } from './admission.ts';
import { asInteger, hasExactKeys, stringifyJson, type JsonValue } from './json.ts';
import type { OwnedProcess } from './process.ts';

const maximumInputFrame = 2_097_152;
/** Every retained startup worker reply frame stays within this bound. */
export const maximumNormalOutput = 65_536;
const frameBudget = { maxBytes: maximumInputFrame, maxTokens: 65_536, maxTextBytes: maximumInputFrame } as const;

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup worker transport is unavailable.'); }

type WorkerStream = Pick<OwnedProcess, 'stdout' | 'stderr' | 'terminated' | 'kill'>;

/** @internal The framed child stream, without file or startup authority. */
export class FramedReplies {
  private readonly child: WorkerStream;
  private buffer = Buffer.alloc(0);
  private queued: Buffer | null = null;
  private pending: { resolve: (value: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private error: Error | null = null;
  private closing = false;
  private allowQueuedHandshake = true;
  private readonly maximumFrame: number;

  constructor(child: WorkerStream, maximumFrame = maximumNormalOutput) {
    this.child = child;
    this.maximumFrame = maximumFrame;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stdout.on('error', () => this.fail(unavailable()));
    child.stdout.on('end', () => { if (!this.closing || this.buffer.length > 0) { this.fail(unavailable()); } });
    child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.length > 0) { this.fail(unavailable()); }
    });
    child.stderr.on('error', () => this.fail(unavailable()));
    void child.terminated.then(() => { if (!this.closing) { this.fail(unavailable()); } }, () => this.fail(unavailable()));
  }

  private receive(chunk: Buffer): void {
    if (this.error !== null) { return; }
    if (this.closing || this.buffer.length + chunk.length > this.maximumFrame + 4) { this.fail(unavailable()); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length < 4) { return; }
    const length = this.buffer.readUInt32BE(0);
    if (length < 1 || length > this.maximumFrame) { this.fail(unavailable()); return; }
    if (this.buffer.length < length + 4) { return; }
    const frame = this.buffer.subarray(4, length + 4);
    this.buffer = this.buffer.subarray(length + 4);
    if (this.buffer.length > 0 || this.queued !== null) { this.fail(unavailable()); return; }
    const pending = this.pending;
    if (pending === null) {
      if (!this.allowQueuedHandshake) { this.fail(unavailable()); return; }
      this.queued = frame;
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(frame);
  }

  next(timeoutMs: number): Promise<Buffer> {
    if (this.error !== null || this.closing || this.pending !== null) { return Promise.reject(this.error ?? unavailable()); }
    this.allowQueuedHandshake = false;
    if (this.queued !== null) { const frame = this.queued; this.queued = null; return Promise.resolve(frame); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(unavailable()), timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  fail(error: Error): void {
    if (this.error !== null) { return; }
    this.error = error;
    this.queued = null;
    const pending = this.pending;
    if (pending !== null) { clearTimeout(pending.timer); this.pending = null; pending.reject(error); }
    this.child.kill();
  }

  close(): void {
    this.closing = true;
    if (this.buffer.length > 0 || this.queued !== null || this.pending !== null) { this.fail(unavailable()); }
  }

  get fault(): Error | null { return this.error; }
}

/** @internal Encodes the larger base64 control frame without enlarging decoded input. */
export function encodeStartupWorkerFrame(value: unknown): Buffer {
  const body = Buffer.from(stringifyJson(value, frameBudget), 'utf8');
  if (body.length < 1 || body.length > maximumInputFrame) { throw unavailable(); }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function validateStartupHello(value: JsonValue, nonce: string, expected: { scopeSha256: string; sourceSha256: string }): void {
  if (!hasExactKeys(value, ['version', 'nonce', 'scopeSha256', 'sourceSha256']) || asInteger(value['version']) !== 1
    || value['nonce'] !== nonce || value['scopeSha256'] !== expected.scopeSha256 || value['sourceSha256'] !== expected.sourceSha256) {
    throw unavailable();
  }
}
