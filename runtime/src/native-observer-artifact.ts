import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import path from 'node:path';

import { admitPrivateDirectory, pinPrivateFile, readBoundedPrivateFile, verifyPinnedPrivateFile, type PinnedFile } from './compiled-broker.ts';
import { compiledImageGeneration, parseCompiledImageRelease } from './compiled-image-release.ts';
import { normalizedGoSourceHash } from './go-source.ts';
import { jsonBudgets } from './json.ts';
import type { PrivateNativeStartupJobs } from './process.ts';

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
  try { return readBoundedPrivateFile(location, jsonBudgets.config.maxBytes); }
  catch { throw new Error('Private native job observer manifest is unavailable.'); }
}

/** @internal Admit the packaged observer under the same fixed manifest as the selected image pins. */
export function releaseNativeJobObserverArtifact(imageRoot: string, scratch: string): PrivateNativeStartupJobs {
  admitPrivateDirectory(scratch);
  const binary = path.win32.join(imageRoot, 'runtime/native/job-observer.exe');
  const manifest = path.win32.join(imageRoot, 'runtime/native/compiled-images.json');
  const pins: PinnedFile[] = [];
  try {
    const release = parseCompiledImageRelease(readBoundedPrivateManifest(manifest));
    if (release.generation !== compiledImageGeneration) { throw new Error('Compiled observer release is unavailable.'); }
    const source = path.win32.join(imageRoot, release.observer.sources[0]!.path);
    const sourceBytes = readBoundedPrivateFile(source, 1_048_576);
    if (normalizedGoSourceHash(sourceBytes) !== release.observer.sources[0]!.sha256) {
      throw new Error('Compiled observer source differs from release.');
    }
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    pins.push(pinPrivateFile(binary, release.observer.sha256));
    if (pins[0]!.identity.size !== BigInt(release.observer.bytes)) { throw new Error('Compiled observer image length is invalid.'); }
    pins.push(pinPrivateFile(source, sourceSha256));
    pins.push(pinPrivateFile(manifest, release.generation));
    for (const pin of pins) { verifyPinnedPrivateFile(pin); }
    if (!closePins(pins)) { throw new Error('Compiled observer pins could not close.'); }
    return { binary, source, manifest, scratch, binarySha256: release.observer.sha256, sourceSha256,
      manifestSha256: release.generation, releaseGeneration: release.generation };
  } catch (error) {
    closePins(pins);
    throw error;
  }
}
