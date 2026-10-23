import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync,
  statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { goToolchain, helperImageFile, helperModule, readNativeHelperRelease, type NativeHelperRelease } from './compiled-image-release.ts';
import { normalizedGoSourceHash } from './go-source.ts';
import { guardScopeToken } from './guard.ts';
import { hasExactKeys, parseStrictJson } from './json.ts';
import { NativeHelperUnavailableError, type NativeHelperReason } from './native-helper-error.ts';

/** The checkout this runtime runs from; the build step canonicalizes it before any use. */
export const defaultInstallationRoot = fileURLToPath(new URL('../../', import.meta.url));

const buildFolder = path.join('.tmp', 'native-build');
const buildName = /^build-[0-9a-f]{32}$/;
const claimName = /^(build-[0-9a-f]{32})\.claim$/;
const maximumSourceBytes = 1_048_576;
const buildDeadlineMs = 600_000;
const ownerRecord = 'owner.json';

/** The verified image: its canonical path, pinned digest and the file identity hashed through one descriptor. */
export interface HelperImage {
  readonly path: string;
  readonly sha256: string;
  readonly volume: string;
  readonly fileId: string;
}

export interface NativeImageOptions {
  /** Whether a missing or pin-failing image may be built; status passes false and never builds. */
  readonly build: boolean;
  /** Called once when a build actually starts, for the nativeBuild progress phase. */
  readonly onBuildStart?: () => void;
  /** Receives entries the build sweep leaves untouched because it cannot prove a build created them. */
  readonly onDiagnostic?: (message: string) => void;
  readonly root?: string;
  /** @internal Tests only: the environment go.exe is resolved from. */
  readonly toolchainEnvironment?: NodeJS.ProcessEnv;
  /** @internal Tests only: the build command's deadline. */
  readonly buildDeadlineMs?: number;
}

function refuse(reason: NativeHelperReason): NativeHelperUnavailableError { return new NativeHelperUnavailableError(reason); }

function lstatOrNull(location: string): BigIntStats | null {
  try { return lstatSync(location, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
    throw refuse('admission');
  }
}

/** An ordinary directory: present, a directory and not a reparse point (Node reports junctions as symbolic links). */
function admitDirectory(location: string): void {
  const item = lstatOrNull(location);
  if (item === null || !item.isDirectory() || item.isSymbolicLink()) { throw refuse('admission'); }
}

/**
 * Canonicalizes the installation root through its native final path, which resolves case, junctions and substituted
 * drives, and admits the root and runtime/native as ordinary directories.
 */
export function canonicalInstallationRoot(root = defaultInstallationRoot): string {
  let canonical: string;
  try { canonical = realpathSync.native(root); }
  catch { throw refuse('admission'); }
  admitDirectory(canonical);
  admitDirectory(path.join(canonical, 'runtime'));
  admitDirectory(path.join(canonical, 'runtime', 'native'));
  return canonical;
}

/** Admits a directory under an admitted parent, creating it with one non-recursive create when positively absent. */
function admitOrCreateDirectory(location: string): void {
  if (lstatOrNull(location) === null) {
    try { mkdirSync(location); }
    catch (error) {
      // A create that lost a race to another process admits the entry that won.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw refuse('admission'); }
    }
  }
  admitDirectory(location);
}

/** Every .go file and go.mod under the helper module, as forward-slash paths in ordinal order. */
export function helperSourcePaths(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    let entries;
    try { entries = readdirSync(path.join(root, relative), { withFileTypes: true }); }
    catch { throw refuse('sourceMismatch'); }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) { throw refuse('sourceMismatch'); }
      if (entry.isDirectory()) { walk(child); }
      else if (entry.isFile() && (entry.name.endsWith('.go') || child === `${helperModule}/go.mod`)) { found.push(child); }
    }
  };
  walk(helperModule);
  return found.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** The LF-normalized digest of one helper source, as the manifest records it. */
export function helperSourceDigest(root: string, relative: string): string {
  let bytes: Buffer;
  try { bytes = readFileSync(path.join(root, relative)); }
  catch { throw refuse('sourceMismatch'); }
  if (bytes.length > maximumSourceBytes) { throw refuse('sourceMismatch'); }
  try { return normalizedGoSourceHash(bytes); }
  catch { throw refuse('sourceMismatch'); }
}

/** Requires the checkout's helper source set and every digest to equal the manifest, before any cached image is accepted. */
export function verifyHelperSources(root: string, release: NativeHelperRelease): void {
  const listed = release.helper.sources.map(source => source.path);
  const actual = helperSourcePaths(root);
  if (listed.length !== actual.length || listed.some((source, index) => source !== actual[index])) { throw refuse('sourceMismatch'); }
  for (const source of release.helper.sources) {
    if (helperSourceDigest(root, source.path) !== source.sha256) { throw refuse('sourceMismatch'); }
  }
}

/** Hashes a file through one descriptor and records that descriptor's identity, or returns null when it is absent. */
export function observeImageFile(location: string): { readonly sha256: string; readonly volume: string; readonly fileId: string; readonly bytes: number } | null {
  let descriptor: number;
  try { descriptor = openSync(location, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
    throw refuse('imagePinMismatch');
  }
  try {
    const identity = fstatSync(descriptor, { bigint: true });
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1 << 16);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, total);
      if (count === 0) { break; }
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    return { sha256: hash.digest('hex'), volume: String(identity.dev), fileId: String(identity.ino), bytes: total };
  } finally { closeSync(descriptor); }
}

function pinnedImage(location: string, release: NativeHelperRelease): HelperImage | null {
  const observed = observeImageFile(location);
  if (observed === null || observed.sha256 !== release.helper.sha256) { return null; }
  return { path: location, sha256: observed.sha256, volume: observed.volume, fileId: observed.fileId };
}

/**
 * Takes the build guard: a named pipe held like the instance guard and released by the operating system when its holder
 * ends, so the only lock state is a guard held by another live build.
 */
function takeBuildGuard(root: string): Promise<() => Promise<void>> {
  const name = ['', '', '.', 'pipe', `game-companion-native-build-${guardScopeToken(root)}`].join(path.win32.sep);
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
    server.once('error', error => { reject(refuse((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'buildGuardHeld' : 'buildFailed')); });
    server.listen(name, () => {
      server.unref();
      resolve(() => new Promise(done => { server.close(() => done()); }));
    });
  });
}

/**
 * Removes the build directories earlier builds provably created and their claims. A claimed directory whose owner record
 * is absent, as a kill before the record's move leaves it, or matches its identity is removed without following reparse
 * points; every other entry is left untouched and reported.
 */
export function sweepBuildDirectories(buildRoot: string, report: (message: string) => void): void {
  const entries = readdirSync(buildRoot, { withFileTypes: true });
  const claims = new Set(entries.filter(entry => entry.isFile()).map(entry => claimName.exec(entry.name)?.[1]).filter(name => name !== undefined));
  for (const entry of entries) {
    if (claimName.test(entry.name) && entry.isFile()) { continue; }
    if (!buildName.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink() || !claims.has(entry.name)) {
      report(`Left ${entry.name} in .tmp/native-build: no build provably created it.`);
      continue;
    }
    const directory = path.join(buildRoot, entry.name);
    const identity = lstatSync(directory, { bigint: true });
    let recorded: { volume: string; fileId: string } | null = null;
    try {
      const value = parseStrictJson(readFileSync(path.join(directory, ownerRecord)));
      if (!hasExactKeys(value, ['volume', 'fileId']) || typeof value['volume'] !== 'string' || typeof value['fileId'] !== 'string') {
        report(`Left ${entry.name} in .tmp/native-build: its owner record is invalid.`);
        continue;
      }
      recorded = { volume: value['volume'], fileId: value['fileId'] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report(`Left ${entry.name} in .tmp/native-build: its owner record is unreadable.`);
        continue;
      }
    }
    if (recorded !== null && (recorded.volume !== String(identity.dev) || recorded.fileId !== String(identity.ino))) {
      report(`Left ${entry.name} in .tmp/native-build: its owner record names another directory.`);
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
    claims.delete(entry.name);
    unlinkSync(path.join(buildRoot, `${entry.name}.claim`));
  }
  for (const name of claims) {
    if (!entries.some(entry => entry.name === name)) { unlinkSync(path.join(buildRoot, `${name}.claim`)); }
  }
}

/** @internal The owner record: the build directory's volume serial and file index. */
export function ownerRecordFor(directory: string): string {
  const identity = lstatSync(directory, { bigint: true });
  return JSON.stringify({ volume: String(identity.dev), fileId: String(identity.ino) });
}

/** Creates a claimed build directory and publishes its owner record create-only, so the record is absent or complete. */
function createBuildDirectory(buildRoot: string): { readonly directory: string; readonly claim: string } {
  const name = `build-${randomBytes(16).toString('hex')}`;
  const claim = path.join(buildRoot, `${name}.claim`);
  const directory = path.join(buildRoot, name);
  writeFileSync(claim, '', { flag: 'wx' });
  mkdirSync(directory);
  const temporary = path.join(directory, `${ownerRecord}.${randomBytes(16).toString('hex')}.tmp`);
  writeFileSync(temporary, ownerRecordFor(directory), { flag: 'wx' });
  linkSync(temporary, path.join(directory, ownerRecord));
  unlinkSync(temporary);
  return { directory, claim };
}

/** Resolves go.exe from the inherited PATH; the build itself sees only that one directory. */
export function resolveGo(source: NodeJS.ProcessEnv = process.env): string {
  for (const entry of (source['PATH'] ?? source['Path'] ?? '').split(path.delimiter)) {
    if (entry === '' || !path.isAbsolute(entry)) { continue; }
    const candidate = path.join(entry, 'go.exe');
    try { if (statSync(candidate).isFile()) { return candidate; } }
    catch { /* Not on this PATH entry. */ }
  }
  throw refuse('toolchainMissing');
}

/**
 * The closed toolchain environment, built from scratch: every profile, temporary and cache location inside one build
 * directory, the target from the manifest, and no other variable.
 */
export function goEnvironment(directory: string, go: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const systemRoot = source['SystemRoot'] ?? source['SYSTEMROOT'];
  if (systemRoot === undefined) { throw refuse('buildFailed'); }
  const folder = (name: string): string => { const value = path.join(directory, name); mkdirSync(value, { recursive: true }); return value; };
  const appData = folder('appdata');
  const [goos, goarch] = goToolchain.target.split('/') as [string, string];
  return { SystemRoot: systemRoot, PATH: path.dirname(go), GOOS: goos, GOARCH: goarch, GOAMD64: goToolchain.amd64,
    CGO_ENABLED: '0', GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '',
    APPDATA: appData, LOCALAPPDATA: folder('localappdata'), USERPROFILE: folder('profile'), HOME: folder('profile'),
    TEMP: folder('temp'), TMP: folder('temp'), GOCACHE: folder('cache'), GOMODCACHE: folder('modcache'), GOPATH: folder('gopath'),
    GOTMPDIR: folder('gotmp') };
}

/** Go reads its telemetry mode from a file under APPDATA, not from the environment. */
function disableTelemetry(environment: NodeJS.ProcessEnv): void {
  const directory = path.join(environment['APPDATA']!, 'go', 'telemetry');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'mode'), 'off');
}

/** Runs one toolchain command; at the deadline the system taskkill ends go and every descendant still in its tree. */
function runToolchain(go: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv,
  deadlineMs: number): Promise<{ readonly code: number | null; readonly stdout: string; readonly expired: boolean }> {
  return new Promise(resolve => {
    const child = spawn(go, args, { cwd, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let size = 0;
    let expired = false;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 65_536) { output.push(chunk); } });
    child.stderr.resume();
    const timer = setTimeout(() => {
      expired = true;
      if (child.pid !== undefined) {
        const taskkill = path.join(environment['SystemRoot']!, 'System32', 'taskkill.exe');
        spawn(taskkill, ['/T', '/F', '/PID', String(child.pid)], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      }
    }, deadlineMs);
    child.once('error', () => { clearTimeout(timer); resolve({ code: null, stdout: '', expired }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(output).toString('utf8'), expired }); });
  });
}

/**
 * Compiles the helper into a build directory with the closed environment and the manifest's toolchain and flags, after
 * checking the toolchain version; returns the output path. The pin tool and the build step share this one recipe.
 */
export async function compileHelper(root: string, directory: string, go = resolveGo(), deadlineMs = buildDeadlineMs): Promise<string> {
  const environment = goEnvironment(directory, go);
  disableTelemetry(environment);
  const moduleDirectory = path.join(root, helperModule);
  const version = await runToolchain(go, ['version'], moduleDirectory, environment, 60_000);
  if (version.code === null && !version.expired) { throw refuse('toolchainMissing'); }
  if (version.code !== 0 || version.stdout.trim() !== `go version ${goToolchain.version} ${goToolchain.target}`) { throw refuse('toolchainVersion'); }
  const output = path.join(directory, path.basename(helperImageFile));
  const compiled = await runToolchain(go, ['build', ...goToolchain.flags, '-o', output, '.'], moduleDirectory, environment, deadlineMs);
  if (compiled.code !== 0) { throw refuse('buildFailed'); }
  return output;
}

/** Removes a present image that failed its pin, only when it is still the file that was hashed. */
function removeFailedImage(location: string, hashed: { readonly volume: string; readonly fileId: string }): void {
  const current = lstatOrNull(location);
  if (current === null) { return; }
  if (String(current.dev) !== hashed.volume || String(current.ino) !== hashed.fileId) { return; }
  try { unlinkSync(location); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') { return; }
    throw refuse(code === 'EBUSY' || code === 'EPERM' ? 'imageInUse' : 'publicationFailed');
  }
}

/**
 * Returns the verified helper image. The source set and digests are checked against the manifest first, so a cached
 * image is never accepted for changed sources; then a present image matching its pin is used as is, and otherwise
 * chat, consumer and repair build it while status refuses.
 */
export async function ensureNativeHelperImage(options: NativeImageOptions): Promise<HelperImage> {
  const root = canonicalInstallationRoot(options.root);
  const release = readNativeHelperRelease(root);
  verifyHelperSources(root, release);
  const image = path.join(root, helperImageFile);
  const ready = pinnedImage(image, release);
  if (ready !== null) { return ready; }
  if (!options.build) { throw refuse(observeImageFile(image) === null ? 'imageAbsent' : 'imagePinMismatch'); }
  const releaseGuard = await takeBuildGuard(root);
  try {
    // Another start may have finished the build while this one waited for the guard.
    const built = pinnedImage(image, release);
    if (built !== null) { return built; }
    admitOrCreateDirectory(path.join(root, '.tmp'));
    const buildRoot = path.join(root, buildFolder);
    admitOrCreateDirectory(buildRoot);
    sweepBuildDirectories(buildRoot, options.onDiagnostic ?? (() => {}));
    const failed = observeImageFile(image);
    if (failed !== null) { removeFailedImage(image, failed); }
    options.onBuildStart?.();
    const go = resolveGo(options.toolchainEnvironment);
    const { directory, claim } = createBuildDirectory(buildRoot);
    try {
      const output = await compileHelper(root, directory, go, options.buildDeadlineMs);
      const observed = observeImageFile(output);
      if (observed === null || observed.sha256 !== release.helper.sha256 || observed.bytes !== release.helper.bytes) { throw refuse('outputMismatch'); }
      // A hard link publishes create-only: it never replaces an image another start published meanwhile.
      try { linkSync(output, image); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw refuse('publicationFailed'); } }
    } finally {
      // A toolchain process ended at the deadline can hold its files briefly. A directory that still cannot be removed
      // keeps its claim, so the next build's sweep removes both instead of this cleanup replacing the build's outcome.
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        rmSync(claim, { force: true });
      } catch { /* Left claimed for the next build's sweep. */ }
    }
    const published = pinnedImage(image, release);
    if (published === null) { throw refuse('publicationFailed'); }
    return published;
  } finally { await releaseGuard(); }
}
