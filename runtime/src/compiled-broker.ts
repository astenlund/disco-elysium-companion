import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrokerSpawn, OwnedSpawnOptions } from './process.ts';

const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
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

function within(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative);
}

export function admitPrivateDirectory(directory: string): void {
  if (!path.win32.isAbsolute(directory) || path.win32.resolve(directory) !== directory) { throw unavailable(); }
  const resolved = path.win32.resolve(directory);
  if (!within(installationRoot, resolved) || realpathSync.native(resolved).toLowerCase() !== resolved.toLowerCase()) { throw unavailable(); }
  let current = installationRoot;
  for (const component of path.win32.relative(installationRoot, resolved).split(path.win32.sep)) {
    current = path.win32.join(current, component);
    const item = lstatSync(current);
    if (!item.isDirectory() || item.isSymbolicLink()) { throw unavailable(); }
  }
}

export function pinPrivateFile(location: string, expected: string): PinnedFile {
  if (!/^[a-f0-9]{64}$/.test(expected) || !path.win32.isAbsolute(location)
    || path.win32.resolve(location) !== location || !within(installationRoot, location)) { throw unavailable(); }
  admitPrivateDirectory(path.win32.dirname(location));
  const initial = lstatSync(location, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || initial.ino === 0n
    || initial.size < 1n || initial.size > 33_554_432n || realpathSync.native(location).toLowerCase() !== location.toLowerCase()) { throw unavailable(); }
  const descriptor = openSync(location, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!before.isFile() || before.nlink !== 1n || before.ino === 0n || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || BigInt(bytes.length) !== before.size || initial.dev !== before.dev || initial.ino !== before.ino
      || sha256 !== expected) { throw unavailable(); }
    return { location, descriptor, sha256, identity: { dev: before.dev, ino: before.ino, size: before.size } };
  } catch (error) { closeSync(descriptor); throw error; }
}

export function verifyPinnedPrivateFile(file: PinnedFile): void {
  admitPrivateDirectory(path.win32.dirname(file.location));
  const byHandle = fstatSync(file.descriptor, { bigint: true });
  const byPath = lstatSync(file.location, { bigint: true });
  const identity = file.identity;
  if (!byHandle.isFile() || !byPath.isFile() || byPath.isSymbolicLink() || byHandle.nlink !== 1n || byPath.nlink !== 1n
    || byHandle.dev !== identity.dev || byPath.dev !== identity.dev || byHandle.ino !== identity.ino || byPath.ino !== identity.ino
    || byHandle.size !== identity.size || byPath.size !== identity.size
    || createHash('sha256').update(readFileSync(file.location)).digest('hex') !== file.sha256) { throw unavailable(); }
}

function brokerEnvironment(options: OwnedSpawnOptions, scratch: string): NodeJS.ProcessEnv {
  return { ...(options.env ?? process.env), TEMP: scratch, TMP: scratch, TMPDIR: scratch, NODE_COMPILE_CACHE: scratch,
    HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
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
