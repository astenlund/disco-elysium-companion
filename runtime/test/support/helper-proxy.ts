// A pass-through proxy in front of the real helper service, for fault injection the real service never produces on its
// own. It starts the service from argv[2] with the nonce in argv[3], forwards its handshake unchanged and applies the
// rules of PROXY_SCENARIO per operation, in request order. Creating the scenario's die file stops the service, observes
// its exit and then exits, so the runtime sees an exit only after the real service ended.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

export interface ProxyRule {
  /** Delays forwarding the reply. */
  readonly delayMs?: number;
  /** Discards the reply. */
  readonly drop?: boolean;
  /** Stops the service and exits: after its reply arrives (which is discarded), or instead of forwarding the request. */
  readonly die?: 'afterReply' | 'beforeForward';
}

export interface ProxyLaunch {
  readonly rules?: Readonly<Record<string, readonly ProxyRule[]>>;
  readonly helloDelayMs?: number;
  /** Delays starting the service, so no process of this launch runs from the image until it passes. */
  readonly spawnDelayMs?: number;
}

export interface ProxyScenario { readonly log: string; readonly dieFile: string; readonly launch: ProxyLaunch }

const [image, nonce, companionRoot] = process.argv.slice(2);
const scenario = JSON.parse(process.env['PROXY_SCENARIO'] ?? '{}') as ProxyScenario;
const queues = new Map(Object.entries(scenario.launch.rules ?? {}).map(([op, rules]) => [op, [...rules]]));
await new Promise(resolve => { setTimeout(resolve, scenario.launch.spawnDelayMs ?? 0); });
const service = spawn(image!, ['service', nonce!, companionRoot!], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map<number, { readonly op: string; readonly rule: ProxyRule }>();
let helloSeen = false;
let dying = false;

function log(event: string, op: string, seq: number): void {
  appendFileSync(scenario.log, JSON.stringify({ pid: service.pid, event, op, seq }) + '\n');
}

function die(): void {
  if (dying) { return; }
  dying = true;
  service.kill();
}

function frames(onFrame: (frame: Buffer) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) { return; }
      const frame = buffer.subarray(0, length + 4);
      buffer = buffer.subarray(length + 4);
      onFrame(frame);
    }
  };
}

service.once('exit', code => { process.exit(dying ? 3 : code ?? 1); });
service.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); });
const watcher = setInterval(() => { if (existsSync(scenario.dieFile)) { clearInterval(watcher); die(); } }, 50);

process.stdin.on('data', frames(frame => {
  const request = JSON.parse(frame.subarray(4).toString('utf8')) as { op: string; seq: number };
  const rule = queues.get(request.op)?.shift() ?? {};
  log('request', request.op, request.seq);
  if (rule.die === 'beforeForward') { die(); return; }
  pending.set(request.seq, { op: request.op, rule });
  service.stdin.write(frame);
}));
process.stdin.on('end', () => { service.stdin.end(); });

service.stdout.on('data', frames(frame => {
  if (!helloSeen) {
    helloSeen = true;
    setTimeout(() => { process.stdout.write(frame); }, scenario.launch.helloDelayMs ?? 0);
    return;
  }
  const reply = JSON.parse(frame.subarray(4).toString('utf8')) as { seq: number };
  const entry = pending.get(reply.seq);
  pending.delete(reply.seq);
  const rule = entry?.rule ?? {};
  if (rule.die === 'afterReply') { log('dropped', entry?.op ?? '', reply.seq); die(); return; }
  if (rule.drop === true) { log('dropped', entry?.op ?? '', reply.seq); return; }
  setTimeout(() => { log('reply', entry?.op ?? '', reply.seq); process.stdout.write(frame); }, rule.delayMs ?? 0);
}));
