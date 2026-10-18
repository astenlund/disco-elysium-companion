import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrokerSpawn, OwnedSpawnOptions } from './process.ts';

const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const maxPrivateFileBytes = 33_554_432;
const artifactNames = ['Invoke-OwnedProcess.exe', 'Invoke-OwnedProcess.dll',
  'Invoke-OwnedProcess.deps.json', 'Invoke-OwnedProcess.runtimeconfig.json'] as const;
const sourceNames = ['runtime/native/process-broker/Program.cs', 'runtime/native/process-broker/Invoke-OwnedProcess.csproj',
  'runtime/native/process-broker/NuGet.Config', 'runtime/scripts/ProcessBroker.cs',
  'runtime/scripts/NativeJobs.cs', 'runtime/scripts/JsonDocuments.cs'] as const;
type ArtifactName = typeof artifactNames[number];
type SourceName = typeof sourceNames[number];

/** @internal A private build snapshot, not a source-to-binary proof. */
export interface CompiledBrokerArtifact {
  readonly directory: string;
  readonly scratch: string;
  readonly hashes: Readonly<Record<ArtifactName, string>>;
  readonly sources: Readonly<Record<SourceName, string>>;
}

export interface PinnedFile { readonly location: string; readonly descriptor: number; readonly sha256: string;
  readonly identity: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint } }

function unavailable(): Error { return new Error('Private compiled broker artifact is unavailable.'); }

function readStablePrivateBytes(descriptor: number, limit: number): Buffer {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(limit)) { throw unavailable(); }
  const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
  let length = 0;
  while (length < bytes.length) {
    const read = readSync(descriptor, bytes, length, bytes.length - length, length);
    if (read === 0) { break; }
    length += read;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw unavailable();
  }
  return bytes.subarray(0, length);
}

function within(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative);
}

export function admitPrivateDirectory(directory: string): void {
  if (!path.win32.isAbsolute(directory) || path.win32.resolve(directory) !== directory) { throw unavailable(); }
  const resolved = path.win32.resolve(directory);
  if (resolved !== path.win32.resolve(installationRoot) && !within(installationRoot, resolved)
    || realpathSync.native(resolved).toLowerCase() !== resolved.toLowerCase()) { throw unavailable(); }
  const root = lstatSync(installationRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) { throw unavailable(); }
  if (resolved === path.win32.resolve(installationRoot)) { return; }
  let current = installationRoot;
  for (const component of path.win32.relative(installationRoot, resolved).split(path.win32.sep)) {
    current = path.win32.join(current, component);
    const item = lstatSync(current);
    if (!item.isDirectory() || item.isSymbolicLink()) { throw unavailable(); }
  }
}

export function readBoundedPrivateFile(location: string, limit: number): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPrivateFileBytes || !path.win32.isAbsolute(location)
    || path.win32.resolve(location) !== location || !within(installationRoot, location)) { throw unavailable(); }
  admitPrivateDirectory(path.win32.dirname(location));
  const initial = lstatSync(location, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || initial.ino === 0n
    || initial.size < 1n || initial.size > BigInt(limit) || realpathSync.native(location).toLowerCase() !== location.toLowerCase()) {
    throw unavailable();
  }
  const descriptor = openSync(location, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readStablePrivateBytes(descriptor, limit);
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== initial.dev || before.ino !== initial.ino || before.size !== initial.size
      || after.dev !== initial.dev || after.ino !== initial.ino || after.size !== initial.size) { throw unavailable(); }
    return bytes;
  } finally { closeSync(descriptor); }
}

export function pinPrivateFile(location: string, expected: string): PinnedFile {
  if (!/^[a-f0-9]{64}$/.test(expected) || !path.win32.isAbsolute(location)
    || path.win32.resolve(location) !== location || !within(installationRoot, location)) { throw unavailable(); }
  admitPrivateDirectory(path.win32.dirname(location));
  const initial = lstatSync(location, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || initial.ino === 0n
    || initial.size < 1n || initial.size > BigInt(maxPrivateFileBytes) || realpathSync.native(location).toLowerCase() !== location.toLowerCase()) { throw unavailable(); }
  const descriptor = openSync(location, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readStablePrivateBytes(descriptor, maxPrivateFileBytes);
    const after = fstatSync(descriptor, { bigint: true });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!before.isFile() || before.nlink !== 1n || before.ino === 0n || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || BigInt(bytes.length) !== before.size || initial.dev !== before.dev || initial.ino !== before.ino
      || sha256 !== expected) { throw unavailable(); }
    return { location, descriptor, sha256, identity: { dev: before.dev, ino: before.ino, size: before.size } };
  } catch (error) { closeSync(descriptor); throw error; }
}

export function readPinnedPrivateFile(file: PinnedFile, limit: number): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPrivateFileBytes || file.identity.size > BigInt(limit)) { throw unavailable(); }
  const before = fstatSync(file.descriptor, { bigint: true });
  if (!before.isFile() || before.dev !== file.identity.dev || before.ino !== file.identity.ino || before.size !== file.identity.size) { throw unavailable(); }
  const bytes = readStablePrivateBytes(file.descriptor, limit);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) { throw unavailable(); }
  return bytes;
}

export function verifyPinnedPrivateFile(file: PinnedFile): void {
  admitPrivateDirectory(path.win32.dirname(file.location));
  const byHandle = fstatSync(file.descriptor, { bigint: true });
  const byPath = lstatSync(file.location, { bigint: true });
  const identity = file.identity;
  if (!byHandle.isFile() || !byPath.isFile() || byPath.isSymbolicLink() || byHandle.nlink !== 1n || byPath.nlink !== 1n
    || byHandle.dev !== identity.dev || byPath.dev !== identity.dev || byHandle.ino !== identity.ino || byPath.ino !== identity.ino
    || byHandle.size !== identity.size || byPath.size !== identity.size) { throw unavailable(); }
  const descriptor = openSync(file.location, 'r');
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== identity.dev || opened.ino !== identity.ino || opened.size !== identity.size
      || createHash('sha256').update(readStablePrivateBytes(descriptor, Number(identity.size))).digest('hex') !== file.sha256) {
      throw unavailable();
    }
  } finally { closeSync(descriptor); }
}

/** @internal Private helper processes omit HOME while the control frame retains the child snapshot. */
export function withoutHome(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name.toUpperCase() !== 'HOME'));
}

/** @internal Redirect known writable helper locations to the selected scratch directory. */
export function brokerEnvironment(options: OwnedSpawnOptions, scratch: string): NodeJS.ProcessEnv {
  return { ...withoutHome(options.env ?? process.env), TEMP: scratch, TMP: scratch, TMPDIR: scratch, NODE_COMPILE_CACHE: scratch,
    USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
    DOTNET_CLI_HOME: scratch, NUGET_PACKAGES: scratch, NUGET_HTTP_CACHE_PATH: scratch, NUGET_PLUGINS_CACHE_PATH: scratch,
    NUGET_SCRATCH: scratch, DOTNET_BUNDLE_EXTRACT_BASE_DIR: scratch, DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true' };
}

/** @internal Private guarded broker launch; production continues to use the PowerShell broker. */
export function compiledBrokerSpawn(artifact: CompiledBrokerArtifact): BrokerSpawn {
  const launch: BrokerSpawn = options => {
    admitPrivateDirectory(artifact.directory);
    admitPrivateDirectory(artifact.scratch);
    const pinned: PinnedFile[] = [];
    try {
      for (const name of artifactNames) { pinned.push(pinPrivateFile(path.win32.join(artifact.directory, name), artifact.hashes[name])); }
      for (const name of sourceNames) { pinned.push(pinPrivateFile(path.win32.join(installationRoot, name), artifact.sources[name])); }
      const executable = pinned[0]!;
      const child = spawn(executable.location, [], { cwd: options.cwd, env: brokerEnvironment(options, artifact.scratch),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('close', () => {
        let changed = false;
        try { for (const file of pinned) { verifyPinnedPrivateFile(file); } }
        catch { changed = true; }
        finally { for (const file of pinned) { try { closeSync(file.descriptor); } catch { changed = true; } } }
        if (changed) { child.emit('error', unavailable()); }
      });
      return child;
    } catch (error) {
      for (const file of pinned) { try { closeSync(file.descriptor); } catch { /* The original launch error remains a refusal. */ } }
      throw error;
    }
  };
  return Object.assign(launch, { controlVersion: 2 as const });
}
