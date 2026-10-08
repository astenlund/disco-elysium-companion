import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeConfig } from './config.ts';
import type { ProviderCapabilities } from './provider.ts';

export const pinnedSdkVersion = '0.3.289';
export const minimumVerbatimCli = [2, 1, 248] as const;

export class ProviderUnavailableError extends Error { override readonly name = 'ProviderUnavailableError'; }

export function assertDefaultProviderProfile(source: NodeJS.ProcessEnv): void {
  if (Object.keys(source).some(key => key.toUpperCase() === 'CLAUDE_CONFIG_DIR' && source[key] !== undefined)) {
    throw new ProviderUnavailableError('Inherited CLAUDE_CONFIG_DIR profile redirection is unsupported; the provider requires its default profile.');
  }
}

export function supportsVerbatim(version: unknown): boolean {
  if (typeof version !== 'string') { return false; }
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (match === null || match[0] !== version) { return false; }
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) { return false; }
  for (let index = 0; index < 3; index++) {
    if (parts[index]! !== minimumVerbatimCli[index]!) { return parts[index]! > minimumVerbatimCli[index]!; }
  }
  return true;
}

export function providerCapabilities(config: RuntimeConfig): ProviderCapabilities {
  return Object.freeze({ streamingText: true, dialogs: true, resume: true, interrupt: true, questionOverride: config.provider.questionOverride !== null && config.provider.model !== null && config.provider.effort !== null, compactionBoundaries: true });
}

// Preserve opaque values after rejecting profile redirection and removing only
// the host-session markers below. Credentials remain provider-resolved.
export function providerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  assertDefaultProviderProfile(source);
  const folded = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(source)) {
    const canonical = key.toUpperCase();
    if (value !== undefined && !folded.has(canonical)) { folded.set(canonical, { key, value }); }
  }
  folded.delete('CLAUDECODE');
  folded.delete('CLAUDE_CODE_ENTRYPOINT');
  // SDK result declarations document automatic interrupted-turn replay under these
  // host flags. Only a fresh player submission can send work in this runtime.
  folded.delete('CLAUDE_CODE_RESUME_INTERRUPTED_TURN');
  folded.delete('CLAUDE_CODE_RESUME_REASON');
  for (const key of ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS']) { folded.set(key, { key, value: '1' }); }
  return Object.fromEntries([...folded.values()].map(({ key, value }) => [key, value]));
}

// Only current SDK observations supply this label. Init metadata outranks its
// earlier initialization reply, even if asynchronous observation arrives later.
export class ProviderSource {
  private instance: string | null = null;
  private reported: string | null = null;
  private systemReported = false;

  get value(): string | null { return this.reported; }

  bind(instance: string | null): void { this.instance = instance; this.reported = null; this.systemReported = false; }

  observe(instance: string, source: unknown, origin: 'initialize' | 'system'): boolean {
    if (this.instance !== instance || typeof source !== 'string' || origin === 'initialize' && this.systemReported) { return false; }
    if (origin === 'system') { this.systemReported = true; }
    const changed = this.reported !== source;
    this.reported = source;
    return changed;
  }
}

export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage | null = null;
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;
  private iterating = false;

  push(message: SDKUserMessage): void {
    if (this.ended || this.pending !== null) { throw new Error('Provider prompt queue is not available for another message.'); }
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: message, done: false });
    } else { this.pending = message; }
  }

  end(): void {
    this.ended = true;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    if (this.iterating) { throw new Error('Provider prompt queue already has its one consumer.'); }
    this.iterating = true;
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.waiter !== null) { return Promise.reject(new Error('Concurrent prompt reads are invalid.')); }
        if (this.pending !== null) {
          const message = this.pending;
          this.pending = null;
          return Promise.resolve({ value: message, done: false });
        }
        if (this.ended) { return Promise.resolve({ value: undefined, done: true }); }
        return new Promise(resolve => { this.waiter = resolve; });
      },
    };
  }
}
