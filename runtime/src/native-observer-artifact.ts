import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitPrivateDirectory, pinPrivateFile, verifyPinnedPrivateFile, type PinnedFile } from './compiled-broker.ts';
import { hasExactKeys, jsonBudgets, parseStrictJson } from './json.ts';
import type { PrivateNativeStartupJobs } from './process.ts';

const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(installationRoot, 'runtime/prototypes/job-observer.go');
const sourceVariants = [
  '444e29895441e4a3ddd1029d1e0877a92270c49aefdd2b4089996cb8fbb992aa',
  '41506467461594bb00aab61047371d546e9c1047a0d47c2f3db15e16c2940d26',
] as const;
const binarySha256 = 'bb3818599c2b5c5c4da98af42daea4300bfdb3103c0d420009021bd8af313fec';

function closePins(pins: readonly PinnedFile[]): boolean {
  let closed = true;
  for (const pin of pins) {
    try { closeSync(pin.descriptor); }
    catch { closed = false; }
  }
  return closed;
}

/** @internal Reads no more than the config JSON budget from an admitted private path. */
export function readBoundedPrivateManifest(location: string): Buffer {
  admitPrivateDirectory(path.dirname(location));
  const limit = jsonBudgets.config.maxBytes;
  const initial = lstatSync(location, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n
    || initial.size < 1n || initial.size > BigInt(limit)) {
    throw new Error('Private native job observer manifest is unavailable.');
  }
  const descriptor = openSync(location, 'r');
  try {
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (read === 0) { break; }
      length += read;
    }
    if (length === 0 || length > limit) { throw new Error('Private native job observer manifest is unavailable.'); }
    return bytes.subarray(0, length);
  } finally { closeSync(descriptor); }
}

export function privateNativeJobObserverArtifact(binary: string, manifest: string, scratch: string): PrivateNativeStartupJobs {
  admitPrivateDirectory(scratch);
  const pins: PinnedFile[] = [];
  try {
    pins.push(pinPrivateFile(binary, binarySha256));
    let sourcePin: PinnedFile | null = null;
    for (const expected of sourceVariants) {
      try { sourcePin = pinPrivateFile(source, expected); break; }
      catch { /* The other measured line-ending variant may match. */ }
    }
    if (sourcePin === null) { throw new Error('Private native job observer source is unavailable.'); }
    pins.push(sourcePin);
    const manifestBytes = readBoundedPrivateManifest(manifest);
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    pins.push(pinPrivateFile(manifest, manifestSha256));
    const record = parseStrictJson(manifestBytes);
    if (!hasExactKeys(record, ['sourceSha256', 'binarySha256', 'toolchain', 'output', 'provenance'])
      || record['sourceSha256'] !== sourcePin.sha256 || record['binarySha256'] !== binarySha256
      || record['toolchain'] !== 'go version go1.26.0 windows/amd64'
      || record['output'] !== 'job-observer.exe' || record['provenance'] !== 'private no-id build') {
      throw new Error('Private native job observer manifest is unavailable.');
    }
    for (const pin of pins) { verifyPinnedPrivateFile(pin); }
    if (!closePins(pins)) { throw new Error('Private native job observer pins could not close.'); }
    return { binary, source, manifest, scratch, sourceSha256: sourcePin.sha256, binarySha256, manifestSha256 };
  } catch (error) {
    closePins(pins);
    throw error;
  }
}
