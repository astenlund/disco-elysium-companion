import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NativeHelper, type ServiceSpawn } from '../../src/native-helper.ts';
import { ensureNativeHelperImage, goEnvironment, resolveGo, type HelperImage } from '../../src/native-image.ts';
import { ProcessSupervisor } from '../../src/process.ts';
import type { ProxyLaunch, ProxyScenario } from './helper-proxy.ts';

const proxyScript = fileURLToPath(new URL('./helper-proxy.ts', import.meta.url));

let image: Promise<HelperImage> | null = null;

/** The verified helper image, built once per test process when the checkout has none. */
export function testHelperImage(): Promise<HelperImage> {
  image ??= ensureNativeHelperImage({ build: true });
  return image;
}

/**
 * Compiles one test-support Go program from its source folder into the given scratch folder, with the build step's closed
 * toolchain environment, so no cache, profile or telemetry write lands outside that folder. Returns the executable.
 */
export async function compileTestProgram(source: string, scratch: string, name: string): Promise<string> {
  const work = path.join(scratch, `${name}-build`);
  await fs.mkdir(work, { recursive: true });
  const output = path.join(work, `${name}.exe`);
  const go = resolveGo();
  const code = await new Promise<number | null>(resolve => {
    const child = spawn(go, ['build', '-o', output, 'main.go'], { cwd: source, env: goEnvironment(work, go), shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  if (code !== 0) { throw new Error(`The ${name} test program did not compile.`); }

  return output;
}

/** A started, unbound helper service from the verified image; the caller closes it. */
export async function startTestHelper(): Promise<NativeHelper> {
  return NativeHelper.start(await testHelperImage());
}

export interface ProxyRecord { readonly pid: number; readonly event: 'request' | 'reply' | 'dropped'; readonly op: string; readonly seq: number }

export interface HelperProxies {
  readonly launcher: ServiceSpawn;
  /** The real service pid behind each launch, in launch order, known once its handshake passed through. */
  readonly pids: number[];
  /** How many service launches have started. */
  launches(): number;
  /** Stops the service of one launch and exits its proxy once that service's exit is observed. */
  die(launch: number): void;
  records(): Promise<ProxyRecord[]>;
}

/**
 * A launcher that runs every service launch behind a pass-through proxy applying the given rules, one entry per launch.
 * The runtime sees the real service's pid, so every identity, job and liveness proof concerns the real service.
 */
export async function helperProxies(log: string, launches: readonly ProxyLaunch[]): Promise<HelperProxies> {
  await fs.writeFile(log, '');
  const pids: number[] = [];
  let launched = 0;
  const dieFile = (launch: number): string => `${log}.die-${launch}`;
  const launcher: ServiceSpawn = (image, nonce) => {
    const index = launched;
    launched += 1;
    const scenario: ProxyScenario = { log, dieFile: dieFile(index), launch: launches[index] ?? {} };
    const child = spawn(process.execPath, [proxyScript, image.path, nonce], { env: { ...process.env, PROXY_SCENARIO: JSON.stringify(scenario) }, shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // The proxy forwards the handshake unchanged; this listener runs before the runtime's own, so the runtime compares the
    // handshake against the real service pid.
    let pid: number | undefined;
    let header = Buffer.alloc(0);
    const readHello = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      if (header.length < 4 || header.length < header.readUInt32BE(0) + 4) { return; }
      child.stdout.off('data', readHello);
      pid = (JSON.parse(header.subarray(4, header.readUInt32BE(0) + 4).toString('utf8')) as { pid: number }).pid;
      pids[index] = pid;
    };
    child.stdout.on('data', readHello);
    Object.defineProperty(child, 'pid', { configurable: true, get: () => pid });
    return child;
  };
  return {
    launcher, pids,
    launches: () => launched,
    die: launch => { writeFileSync(dieFile(launch), ''); },
    records: async () => (await fs.readFile(log, 'utf8')).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ProxyRecord),
  };
}

export interface TestNative {
  readonly helper: NativeHelper;
  readonly supervisor: ProcessSupervisor;
  close(): Promise<void>;
}

/**
 * Starts a helper service and a supervisor for one scope root. With a binding, the scope's helper and retired jobs are
 * proven absent and the service is bound, as openBackend does right after its guard, so mutating requests are admitted.
 */
export async function createTestNative(scopeRoot: string, binding?: { readonly companionRoot: string; readonly dataRoot: string }): Promise<TestNative> {
  const helper = await NativeHelper.start(await testHelperImage());
  try {
    const supervisor = await ProcessSupervisor.create(scopeRoot, helper);
    if (binding !== undefined) {
      await supervisor.proveBindable();
      await helper.bind({ token: supervisor.scopeToken, companionRoot: binding.companionRoot, dataRoot: binding.dataRoot });
    }
    return { helper, supervisor, close: () => helper.close() };
  } catch (error) {
    await helper.close().catch(() => undefined);
    throw error;
  }
}
