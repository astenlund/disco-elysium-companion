import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directMainToken = Symbol('directMainImagePins');
const directMainUrls: ReadonlySet<string> = new Set([
  new URL('./cli.ts', import.meta.url).href,
  new URL('../test/support/selected-chat-main.ts', import.meta.url).href,
]);

function directMainEntry(): boolean {
  return process.argv[1] !== undefined && directMainUrls.has(pathToFileURL(path.resolve(process.argv[1])).href);
}

/** @internal Issued only to the direct CLI and the private copied-root fixture main, never to exported entry points. */
export function withDirectMainToken<T>(action: (token: symbol) => T): T {
  if (!directMainEntry()) { throw new Error('Compiled image transfer requires direct CLI main.'); }
  return action(directMainToken);
}

/**
 * @internal openBackend checks this before any selected-image work, and the in-memory transport checks it again before it
 * sends the pin-transfer helper, so neither exported options nor a direct call into the bootstrap can transfer pins.
 */
export function requireDirectMainToken(value: unknown): void {
  if (value !== directMainToken || !directMainEntry()) {
    throw new Error('Compiled image transfer requires direct CLI main.');
  }
}

/** @internal Tracks whether remote image handles may exist, so a direct main exits hard instead of closing them. */
export class DirectImagePinObligation {
  private state: 'idle' | 'unknown' | 'absent' | 'ready' = 'idle';

  markPossibleTransfer(): void {
    if (this.state !== 'idle') { throw new Error('Selected image transfer has already started.'); }
    this.state = 'unknown';
  }

  verified(status: 'ready' | 'absent'): void {
    if (this.state !== 'unknown') { throw new Error('Selected image pin state is invalid.'); }
    this.state = status;
  }

  get status(): 'idle' | 'unknown' | 'absent' | 'ready' { return this.state; }

  get requiresHardExit(): boolean { return this.state === 'unknown' || this.state === 'ready'; }
}
