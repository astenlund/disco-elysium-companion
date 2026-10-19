import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import path from 'node:path';

import { admitPrivateDirectory, brokerEnvironment, pinPrivateFile, readBoundedPrivateFile,
  verifyPinnedPrivateFile, type PinnedFile } from './compiled-broker.ts';
import { compiledImageGeneration, parseCompiledImageRelease } from './compiled-image-release.ts';
import { normalizedGoSourceHash } from './go-source.ts';
import type { BrokerSpawn, OwnedSpawnOptions } from './process.ts';

function closePins(pins: readonly PinnedFile[]): boolean {
  let closed = true;
  for (const pin of pins) {
    try { closeSync(pin.descriptor); }
    catch { closed = false; }
  }
  return closed;
}

function launchPinnedBroker(options: OwnedSpawnOptions, scratch: string, binary: string,
  pins: readonly PinnedFile[]): ReturnType<BrokerSpawn> {
  const child = spawn(binary, [], { cwd: options.cwd, env: brokerEnvironment(options, scratch),
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.once('close', () => {
    let valid = true;
    try { for (const pin of pins) { verifyPinnedPrivateFile(pin); } }
    catch { valid = false; }
    if (!closePins(pins)) { valid = false; }
    if (!valid) { child.emit('error', new Error('Go broker release changed during launch.')); }
  });
  return child;
}

/** @internal Pin the packaged broker and its exact source against the fixed release manifest on every launch. */
export function releaseGoBrokerSpawn(imageRoot: string, scratch: string): BrokerSpawn {
  const binary = path.win32.join(imageRoot, 'runtime/native/go-broker.exe');
  const manifestPath = path.win32.join(imageRoot, 'runtime/native/compiled-images.json');
  const launch: BrokerSpawn = options => {
    admitPrivateDirectory(path.win32.dirname(binary));
    admitPrivateDirectory(scratch);
    const pins: PinnedFile[] = [];
    try {
      const manifestBytes = readBoundedPrivateFile(manifestPath, 1_048_576);
      const release = parseCompiledImageRelease(manifestBytes);
      if (release.generation !== compiledImageGeneration) { throw new Error('Go broker release is unavailable.'); }
      pins.push(pinPrivateFile(manifestPath, release.generation));
      pins.push(pinPrivateFile(binary, release.broker.sha256));
      if (pins[1]!.identity.size !== BigInt(release.broker.bytes)) { throw new Error('Go broker image length is invalid.'); }
      for (const source of release.broker.sources) {
        const location = path.win32.join(imageRoot, source.path);
        const bytes = readBoundedPrivateFile(location, 1_048_576);
        if (normalizedGoSourceHash(bytes) !== source.sha256) { throw new Error('Go broker source differs from release.'); }
        pins.push(pinPrivateFile(location, createHash('sha256').update(bytes).digest('hex')));
      }
      return launchPinnedBroker(options, scratch, binary, pins);
    } catch (error) {
      closePins(pins);
      throw error;
    }
  };
  return Object.assign(launch, { controlVersion: 2 as const });
}
