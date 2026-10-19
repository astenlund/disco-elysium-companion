import { fileURLToPath } from 'node:url';

import type { ProcessSupervisor } from '../../src/process.ts';
import { FakeProvider } from '../client/support.ts';

const script = fileURLToPath(new URL('./synthetic-provider-child.mjs', import.meta.url));
const readinessTimeoutMs = 30000;

/** A fake provider whose sessions are backed by a real supervised `provider` child, so ownership and stop proofs run for real. */
export class SyntheticProvider extends FakeProvider {
  private readonly supervisor: ProcessSupervisor;
  private readonly companionRoot: string;

  constructor(supervisor: ProcessSupervisor, companionRoot: string) {
    super();
    this.supervisor = supervisor;
    this.companionRoot = companionRoot;
  }

  override async start(resume: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.supervisor.verifyQuiescent('provider');
    signal?.throwIfAborted();
    const child = this.supervisor.spawn('provider', { command: process.execPath, args: [script], cwd: this.companionRoot,
      env: process.env, signal });
    child.stderr.resume();
    const readyText = new Promise<Buffer>((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.stdout.once('error', reject);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic provider did not become ready.')), readinessTimeoutMs);
      });
      const identity = await Promise.race([child.ready, timeout]);
      const marker = await Promise.race([readyText, timeout]);
      if (marker.toString('utf8').trim() !== 'ready') { throw new Error('Synthetic provider readiness marker is invalid.'); }
      signal?.throwIfAborted();
      const session = await super.start(resume);
      const originalClose = session.close.bind(session);
      const originalIsLive = session.isLive.bind(session);
      let closing: Promise<void> | null = null;
      session.isLive = () => originalIsLive() && !child.brokerClosed && child.terminationState === 'running';
      session.verifyLive = async () => {
        if (!session.isLive()) { throw new Error('Synthetic provider has stopped.'); }
        await this.supervisor.verifyOwnedLive('provider', child, identity);
        if (!session.isLive()) { throw new Error('Synthetic provider stopped during identity proof.'); }
      };
      session.close = () => {
        closing ??= (async () => {
          await originalClose();
          child.stdin.end();
          const exit = await child.terminated;
          if (exit.code !== 0 || exit.failure !== null) { throw new Error('Synthetic provider stop is unverified.'); }
          await this.supervisor.verifyQuiescent('provider');
        })();
        return closing;
      };
      return session;
    } catch (error) {
      child.kill();
      await this.supervisor.stop('provider');
      throw error;
    } finally { clearTimeout(timer); }
  }
}
