import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { DataRootUnavailableError } from '../src/admission.ts';
import type { ProcessSupervisor } from '../src/process.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { StartupWorkerTransport } from '../src/startup-worker-transport.ts';

const scopeSha256 = 'a'.repeat(64);
const sourceSha256 = 'b'.repeat(64);

function framed(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

/** A worker that greets correctly and answers each request with `result` padded by `padding` bytes. */
async function openWorker(padding: number) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let kills = 0;
  let resolveTermination!: (exit: { code: number; signal: null; failure: null }) => void;
  const terminated = new Promise<{ code: number; signal: null; failure: null }>(resolve => { resolveTermination = resolve; });
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const request = JSON.parse(chunk.subarray(4).toString('utf8')) as { id: string; op: string };
    stdout.write(framed(Buffer.from(JSON.stringify({ version: 1, id: request.id, op: request.op, status: 'ok', result: 'x'.repeat(padding) }), 'utf8')));
    callback();
  } });
  const child = { stdin, stdout, stderr, terminated, ready: Promise.resolve(), brokerClosed: false, kill: () => { kills += 1; return true; } };
  const supervisor = {
    spawn: (_role: string, options: { args: string[] }) => {
      const nonce = options.args[options.args.indexOf('-Nonce') + 1];
      stdout.write(framed(Buffer.from(JSON.stringify({ version: 1, nonce, scopeSha256, sourceSha256 }), 'utf8')));
      return child;
    },
    stop: async () => { stdout.end(); stderr.end(); resolveTermination({ code: 0, signal: null, failure: null }); },
    verifyQuiescent: async () => {},
  } as unknown as ProcessSupervisor;
  const scope = { companionRoot: 'C:/companion', dataRoot: 'C:/companion/runtime-data', bindingSha256: scopeSha256 } as unknown as RuntimeScope;
  const transport = await StartupWorkerTransport.open(supervisor, scope, 'startupCoreReply', 'worker.ps1', sourceSha256);
  assert.ok(transport !== null);
  return { transport, kills: () => kills };
}

test('startup worker transport accepts a reply within the normal frame bound', async () => {
  const { transport } = await openWorker(65_400);
  assert.equal((await transport.request('validateCore', {}, 1000)).status, 'ok');
});

test('startup worker transport refuses a reply larger than the normal frame bound', async () => {
  const { transport, kills } = await openWorker(65_537);
  await assert.rejects(transport.request('validateCore', {}, 1000), DataRootUnavailableError);
  assert.equal(kills(), 1);
});
