import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitPrivateDirectory, brokerEnvironment, pinPrivateFile, readBoundedPrivateFile,
  verifyPinnedPrivateFile, type PinnedFile } from './compiled-broker.ts';
import { compiledImageGeneration, parseCompiledImageRelease } from './compiled-image-release.ts';
import { normalizedGoSourceHash } from './go-source.ts';
import type { BrokerSpawn, OwnedSpawnOptions } from './process.ts';

const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.join(installationRoot, 'runtime/prototypes/go-process-broker');
const brokerSha256 = 'aa52d71f8a2243bdcb83bc394a12fe8193e413eb70b3543130f69df5a99c5d13';
const sourceNames = ['go.mod', 'control.go', 'job_windows.go', 'child_windows.go', 'cmd/go-broker/main.go'] as const;
const sourceVariants = [
  ['d017d97a68191b34b23bb815544f91601f8eadf6161239d9751efc2a95ac1f6f',
    'ae9a33855ec0bed9125598ca97e0c5e0dec805af1f8552c3f92b26bf37eb6e87',
    '738f732b1b9b941b21eb87e94927972f2f0b9dc5408024a65008c40293563951',
    'd2237d82d5050aa454168e2a2ba5bc56c8356e653d8f853a5bb0a0627c8bf9d6',
    '276a347ca8747dba37d7095e659424b5e2abdb9429464c36e13aa9a2f00a1847'],
  ['88baaaade6c330321d774dfd20671bb0dc5748fbb051c6fee4ae1eae455c957a',
    '0bb49ef2da8864fa5919cdcbcf958a4570b0fa6dccca020e4d1c696',
    'f23f76c7c53848fe7b2ef8dbb4b3d75e723a35fc49a407d4a66b674c40817841',
    'c1421211a9cee8564c015920a8c9d14a6b2ff5c840b64c1e9f58d728964f46b2',
    'f21929ae4217ced4a3c35829b1d898ff34e19c0ca1dd72cb530d5c8b0b9e13c5'],
] as const;

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

function pinSources(): PinnedFile[] {
  let lastError: unknown;
  for (const variant of sourceVariants) {
    const pinned: PinnedFile[] = [];
    try {
      for (const [index, name] of sourceNames.entries()) {
        pinned.push(pinPrivateFile(path.join(sourceRoot, name), variant[index]!));
      }
      return pinned;
    } catch (error) {
      if (!closePins(pinned)) { throw new Error('Private Go broker source pin could not close.'); }
      lastError = error;
    }
  }
  throw lastError ?? new Error('Private Go broker sources are unavailable.');
}

export function privateGoBrokerArtifactSpawn(binary: string, scratch: string): BrokerSpawn {
  const launch: BrokerSpawn = options => {
    admitPrivateDirectory(path.dirname(binary));
    admitPrivateDirectory(scratch);
    const pins: PinnedFile[] = [];
    try {
      pins.push(pinPrivateFile(binary, brokerSha256));
      pins.push(...pinSources());
      return launchPinnedBroker(options, scratch, binary, pins);
    } catch (error) {
      closePins(pins);
      throw error;
    }
  };
  return Object.assign(launch, { controlVersion: 2 as const });
}
