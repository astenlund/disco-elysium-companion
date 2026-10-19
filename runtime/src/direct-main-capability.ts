import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directMainToken = Symbol('directMainImagePins');
const directCliUrl = new URL('./cli.ts', import.meta.url).href;

function directCliIsMain(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === directCliUrl;
}

/** @internal The token is never exported or accepted by the exported runCli entry. */
export function withDirectMainToken<T>(action: (token: symbol) => T): T {
  if (!directCliIsMain()) { throw new Error('Compiled image transfer requires direct CLI main.'); }
  return action(directMainToken);
}

/** @internal openBackend checks this before any selected-image work, so exported fixture options cannot select it. */
export function requireDirectMainToken(value: unknown): void {
  if (value !== directMainToken || !directCliIsMain()) {
    throw new Error('Compiled image transfer requires direct CLI main.');
  }
}
