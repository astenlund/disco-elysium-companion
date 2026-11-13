import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A single-segment path of exactly `length` characters inside `parent`, named `prefix` padded with 'r'; nothing is created. */
export function pathOfLength(parent: string, prefix: string, length: number): string {
  const base = path.join(parent, prefix);
  assert.ok(base.length < length, `the parent path is too long to build a ${length}-character path`);

  return base + 'r'.repeat(length - base.length);
}

/**
 * Creates a directory of exactly `length` characters below `base` from segments of at most 100 characters. Each segment
 * costs its name plus one separator, so a step never leaves exactly one character it could not fill.
 */
export async function directoryOfLength(base: string, length: number): Promise<string> {
  assert.ok(length - base.length >= 2, `cannot build a ${length}-character directory below a ${base.length}-character base`);
  let current = base;
  while (current.length < length) {
    const remaining = length - current.length;
    const take = Math.min(remaining - 1, 100);
    current = path.join(current, 'd'.repeat(remaining - take - 1 === 1 ? take - 1 : take));
  }
  assert.equal(current.length, length);
  await fs.mkdir(current, { recursive: true });

  return current;
}
