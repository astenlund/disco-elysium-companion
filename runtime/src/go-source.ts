import { createHash } from 'node:crypto';

/** @internal Go source accepts only uniform LF or CRLF worktree bytes for the fixed LF release digest. */
export function normalizedGoSourceHash(bytes: Uint8Array): string {
  const normalized: number[] = [];
  let style: 'lf' | 'crlf' | null = null;
  for (let index = 0; index < bytes.byteLength; index++) {
    const byte = bytes[index]!;
    if (byte === 13) {
      if (bytes[index + 1] !== 10 || style === 'lf') { throw new Error('Go source line endings are invalid.'); }
      style = 'crlf';
      normalized.push(10);
      index++;
    } else {
      if (byte === 10) {
        if (style === 'crlf') { throw new Error('Go source line endings are mixed.'); }
        style = 'lf';
      }
      normalized.push(byte);
    }
  }
  if (normalized.at(-1) !== 10) { throw new Error('Go source lacks a final newline.'); }
  return createHash('sha256').update(Buffer.from(normalized)).digest('hex');
}
