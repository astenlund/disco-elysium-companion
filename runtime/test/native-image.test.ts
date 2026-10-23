import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareNativeImage } from '../src/cli.ts';
import { helperImageFile, helperModule, manifestFile, nativeHelperSha256 } from '../src/compiled-image-release.ts';
import { NativeHelperUnavailableError, type NativeHelperReason } from '../src/native-helper-error.ts';
import { ensureNativeHelperImage, type NativeImageOptions } from '../src/native-image.ts';
import type { StartupProgress } from '../src/startup-progress.ts';
import { compileTestProgram, testHelperImage } from './support/native-helper.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fakeGoSource = fileURLToPath(new URL('./support/fake-go/', import.meta.url));
const buildChild = fileURLToPath(new URL('./support/native-build-child.ts', import.meta.url));
const scratch = path.join(repository, '.tmp', `native-image-${randomUUID()}`);
const goVersion = 'go version go1.26.0 windows/amd64';

interface FakeGo { readonly version?: string; readonly build: 'fail' | 'junk' | 'sleep' | 'copy'; readonly copyFrom?: string; readonly junkAt?: string; readonly marker?: string }

let fakeGoBinary = '';

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code));
  });
}

/** A copied installation holding only the manifest and the helper sources, with no .tmp. */
async function installation(): Promise<string> {
  const root = path.join(scratch, `root-${randomUUID()}`);
  await fs.mkdir(path.join(root, path.dirname(manifestFile)), { recursive: true });
  await fs.copyFile(path.join(repository, manifestFile), path.join(root, manifestFile));
  await fs.cp(path.join(repository, helperModule), path.join(root, helperModule), { recursive: true });
  return root;
}

/** A toolchain directory whose go.exe is the fake, scripted by the given settings. */
async function fakeToolchain(settings: FakeGo): Promise<string> {
  const directory = path.join(scratch, `toolchain-${randomUUID()}`);
  await fs.mkdir(directory);
  await fs.copyFile(fakeGoBinary, path.join(directory, 'go.exe'));
  await fs.writeFile(path.join(directory, 'fake-go.json'), JSON.stringify({ version: goVersion, ...settings }));
  return directory;
}

const withToolchain = (directory: string): Pick<NativeImageOptions, 'toolchainEnvironment'> => ({ toolchainEnvironment: { ...process.env, PATH: directory } });

async function refuses(promise: Promise<unknown>, reason: NativeHelperReason): Promise<void> {
  await assert.rejects(promise, error => error instanceof NativeHelperUnavailableError && error.reason === reason);
}

/** Every file outside .tmp with its size and modification time, to show a build wrote nothing else. */
async function outsideTmp(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, full);
    if (relative === '.tmp' || relative.startsWith(`.tmp${path.sep}`)) { continue; }
    const stats = await fs.stat(full);
    result.push(`${relative}|${entry.isDirectory() ? 'dir' : stats.size}|${entry.isDirectory() ? '' : stats.mtimeMs}`);
  }
  return result.sort();
}

/** The user's own Go telemetry and default build cache state, which a contained build must leave unchanged. */
async function userGoState(): Promise<string[]> {
  const result: string[] = [];
  for (const location of [path.join(process.env['APPDATA'] ?? '', 'go', 'telemetry'), path.join(process.env['LOCALAPPDATA'] ?? '', 'go-build')]) {
    if (!existsSync(location)) { result.push(`${location}|absent`); continue; }
    const entries = await fs.readdir(location, { recursive: location.endsWith('telemetry'), withFileTypes: true });
    for (const entry of entries) {
      const stats = await fs.stat(path.join(entry.parentPath, entry.name));
      result.push(`${path.join(entry.parentPath, entry.name)}|${stats.mtimeMs}`);
    }
  }
  return result.sort();
}

async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch { return true; }
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
  return false;
}

async function waitFor(location: string, timeoutMs = 60_000): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(location)) {
    if (performance.now() > deadline) { throw new Error('The fake toolchain never started its build.'); }
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
  return fs.readFile(location, 'utf8');
}

const buildRoot = (root: string): string => path.join(root, '.tmp', 'native-build');

describe('native helper first-launch build', () => {
  before(async () => {
    // Arrange: compile the fake toolchain once, in a closed environment of its own under this run's scratch folder.
    await fs.mkdir(scratch, { recursive: true });
    fakeGoBinary = await compileTestProgram(fakeGoSource, scratch, 'fake-go');
  });

  after(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  it('builds on first launch from an installation with no .tmp and writes nothing outside it but the image, Go telemetry included', { timeout: 600000 }, async () => {
    // Arrange
    const root = await installation();
    const before = await outsideTmp(root);
    const goState = await userGoState();

    // Act
    const image = await ensureNativeHelperImage({ build: true, root });

    // Assert
    assert.equal(image.sha256, nativeHelperSha256);
    assert.equal(image.path, path.join(root, helperImageFile));
    const imageEntry = path.normalize(helperImageFile);
    assert.deepEqual((await outsideTmp(root)).filter(entry => !entry.startsWith(`${imageEntry}|`)), before);
    assert.deepEqual(await fs.readdir(buildRoot(root)), []);
    assert.deepEqual(await userGoState(), goState);
  });

  it('kills a build at its deadline, leaving no build directory, image or write outside .tmp', { timeout: 600000 }, async () => {
    // Arrange
    const root = await installation();
    const before = await outsideTmp(root);
    const goState = await userGoState();

    // Act and assert: the real toolchain is stopped by its deadline.
    await refuses(ensureNativeHelperImage({ build: true, root, buildDeadlineMs: 1500 }), 'buildFailed');

    // Assert
    assert.deepEqual(await outsideTmp(root), before);
    assert.deepEqual(await fs.readdir(buildRoot(root)), []);
    assert.deepEqual(await userGoState(), goState);
  });

  it('shares the build guard with a junction and a differently cased spelling of the installation', { timeout: 120000 }, async () => {
    // Arrange: a build that sleeps until its deadline holds the guard.
    const root = await installation();
    const marker = path.join(scratch, `marker-${randomUUID()}`);
    const toolchain = await fakeToolchain({ build: 'sleep', marker });
    const junction = path.join(scratch, `junction-${randomUUID()}`);
    await fs.symlink(root, junction, 'junction');
    const holding = ensureNativeHelperImage({ build: true, root, buildDeadlineMs: 8000, ...withToolchain(toolchain) });
    const pid = Number(await waitFor(marker));

    // Act and assert
    await refuses(ensureNativeHelperImage({ build: true, root: junction, ...withToolchain(toolchain) }), 'buildGuardHeld');
    await refuses(ensureNativeHelperImage({ build: true, root: root.toUpperCase(), ...withToolchain(toolchain) }), 'buildGuardHeld');
    await refuses(holding, 'buildFailed');
    assert.ok(await processGone(pid));
    assert.deepEqual(await fs.readdir(buildRoot(root)), []);
    await fs.rm(junction);
  });

  for (const [reason, settings] of [
    ['toolchainVersion', { version: 'go version go1.25.9 windows/amd64', build: 'fail' }],
    ['buildFailed', { build: 'fail' }],
    ['outputMismatch', { build: 'junk' }],
  ] as const) {
    it(`refuses with ${reason} and removes its build directory`, { timeout: 120000 }, async () => {
      // Arrange
      const root = await installation();
      const toolchain = await fakeToolchain(settings);

      // Act and assert
      await refuses(ensureNativeHelperImage({ build: true, root, ...withToolchain(toolchain) }), reason);
      assert.deepEqual(await fs.readdir(buildRoot(root)), []);
      assert.ok(!existsSync(path.join(root, helperImageFile)));
    });
  }

  it('refuses with admission when the installation or its native folder is not an ordinary directory', { timeout: 120000 }, async () => {
    // Arrange
    const missing = path.join(scratch, `missing-${randomUUID()}`);
    const linked = await installation();
    const native = path.join(linked, 'runtime', 'native');
    const moved = path.join(scratch, `native-${randomUUID()}`);
    await fs.rename(native, moved);
    await fs.symlink(moved, native, 'junction');

    // Act and assert
    await refuses(ensureNativeHelperImage({ build: true, root: missing }), 'admission');
    await refuses(ensureNativeHelperImage({ build: true, root: linked }), 'admission');
    await fs.rm(native);
  });

  it('refuses with buildFailed naming a claimed build directory that a leftover process still holds', { timeout: 120000 }, async () => {
    // Arrange: a claimed build directory whose leftover toolchain process is still running from inside it.
    const real = await testHelperImage();
    const root = await installation();
    const name = `build-${'e'.repeat(32)}`;
    await fs.mkdir(path.join(buildRoot(root), name), { recursive: true });
    await fs.writeFile(path.join(buildRoot(root), `${name}.claim`), '');
    const leftover = path.join(buildRoot(root), name, 'go.exe');
    await fs.copyFile(fakeGoBinary, leftover);
    const running = spawn(leftover, [], { shell: false, windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => { running.once('spawn', resolve); });
    try {
      // Act and assert
      await assert.rejects(ensureNativeHelperImage({ build: true, root, ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path })) }),
        error => error instanceof NativeHelperUnavailableError && error.reason === 'buildFailed' && error.message.includes(name));
      assert.ok(existsSync(path.join(buildRoot(root), `${name}.claim`)));
    } finally {
      running.kill();
      await new Promise(resolve => { running.once('exit', resolve); });
    }

    // Act and assert: once the process has ended, the next build sweeps the directory and succeeds.
    const image = await ensureNativeHelperImage({ build: true, root, ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path })) });
    assert.equal(image.sha256, nativeHelperSha256);
    assert.ok(!existsSync(path.join(buildRoot(root), name)));
  });

  it('refuses with toolchainMissing when go.exe is not on the PATH', { timeout: 120000 }, async () => {
    // Arrange
    const root = await installation();
    const empty = path.join(scratch, `empty-${randomUUID()}`);
    await fs.mkdir(empty);

    // Act and assert
    await refuses(ensureNativeHelperImage({ build: true, root, ...withToolchain(empty) }), 'toolchainMissing');
  });

  it('refuses with publicationFailed when another image was published meanwhile, and with imageInUse for a running failed image', { timeout: 120000 }, async () => {
    // Arrange
    const real = await testHelperImage();
    const root = await installation();
    const image = path.join(root, helperImageFile);

    // Act and assert: the build's own output is pinned, but the image published meanwhile is not.
    await refuses(ensureNativeHelperImage({ build: true, root, ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path, junkAt: image })) }), 'publicationFailed');
    assert.equal(await fs.readFile(image, 'utf8'), 'published meanwhile');

    // Arrange: the failed image is a running program, which Windows will not delete.
    await fs.rm(image);
    await fs.copyFile(fakeGoBinary, image);
    const running = spawn(image, [], { shell: false, windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => { running.once('spawn', resolve); });
    try {
      // Act and assert
      await refuses(ensureNativeHelperImage({ build: true, root, ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path })) }), 'imageInUse');
    } finally {
      running.kill();
      await new Promise(resolve => { running.once('exit', resolve); });
    }
  });

  it('refuses status with an absent image and with one that fails its pin, and replaces a failed image on the next build', { timeout: 120000 }, async () => {
    // Arrange
    const real = await testHelperImage();
    const root = await installation();
    const image = path.join(root, helperImageFile);

    // Act and assert: status never builds.
    await refuses(ensureNativeHelperImage({ build: false, root }), 'imageAbsent');
    await fs.writeFile(image, 'not the pinned image');
    await refuses(ensureNativeHelperImage({ build: false, root }), 'imagePinMismatch');
    assert.ok(!existsSync(path.join(root, '.tmp')));

    // Act and assert: a build removes the failed image and publishes the pinned one.
    const built = await ensureNativeHelperImage({ build: true, root, ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path })) });
    assert.equal(built.sha256, nativeHelperSha256);
  });

  it('refuses changed sources beside a still-valid cached image for both chat and status', { timeout: 120000 }, async () => {
    // Arrange
    const real = await testHelperImage();
    const root = await installation();
    await fs.copyFile(real.path, path.join(root, helperImageFile));
    assert.equal((await ensureNativeHelperImage({ build: false, root })).sha256, nativeHelperSha256);
    const source = path.join(root, helperModule, 'main.go');
    await fs.appendFile(source, '\n// changed\n');

    // Act and assert
    await refuses(ensureNativeHelperImage({ build: true, root }), 'sourceMismatch');
    await refuses(ensureNativeHelperImage({ build: false, root }), 'sourceMismatch');
    assert.ok(!existsSync(path.join(root, '.tmp')));
  });

  it('sweeps interrupted builds it provably created and leaves foreign entries untouched', { timeout: 300000 }, async () => {
    // Arrange: a build process killed while its toolchain runs leaves a claimed directory with its owner record.
    const real = await testHelperImage();
    const root = await installation();
    const untouched = await outsideTmp(root);
    const marker = path.join(scratch, `marker-${randomUUID()}`);
    const sleeping = await fakeToolchain({ build: 'sleep', marker });
    const child = spawn(process.execPath, [buildChild, root, sleeping], { shell: false, windowsHide: true, stdio: 'ignore' });
    const toolchainPid = Number(await waitFor(marker));
    const taskkill = path.join(process.env['SystemRoot']!, 'System32', 'taskkill.exe');
    assert.equal(await run(taskkill, ['/T', '/F', '/PID', String(child.pid)], scratch, process.env), 0);
    assert.ok(await processGone(toolchainPid));
    const interrupted = (await fs.readdir(buildRoot(root))).filter(name => /^build-[0-9a-f]{32}$/.test(name));
    assert.equal(interrupted.length, 1);
    assert.ok(existsSync(path.join(buildRoot(root), interrupted[0]!, 'owner.json')));
    assert.deepEqual(await outsideTmp(root), untouched);

    // Arrange: one killed right after its directory create, one killed while writing its owner record, and foreign entries.
    const created = `build-${'a'.repeat(32)}`;
    await fs.writeFile(path.join(buildRoot(root), `${created}.claim`), '');
    await fs.mkdir(path.join(buildRoot(root), created));
    const writing = `build-${'b'.repeat(32)}`;
    await fs.writeFile(path.join(buildRoot(root), `${writing}.claim`), '');
    await fs.mkdir(path.join(buildRoot(root), writing));
    await fs.writeFile(path.join(buildRoot(root), writing, `owner.json.${'c'.repeat(32)}.tmp`), '{"vol');
    const foreign = `build-${'d'.repeat(32)}`;
    await fs.mkdir(path.join(buildRoot(root), foreign));
    await fs.writeFile(path.join(buildRoot(root), foreign, 'keep.txt'), 'foreign');
    await fs.writeFile(path.join(buildRoot(root), 'notes.txt'), 'foreign');
    const diagnostics: string[] = [];

    // Act
    const image = await ensureNativeHelperImage({ build: true, root, onDiagnostic: message => diagnostics.push(message),
      ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path })) });

    // Assert
    assert.equal(image.sha256, nativeHelperSha256);
    assert.deepEqual((await fs.readdir(buildRoot(root))).sort(), [foreign, 'notes.txt'].sort());
    assert.equal(await fs.readFile(path.join(buildRoot(root), foreign, 'keep.txt'), 'utf8'), 'foreign');
    assert.equal(diagnostics.length, 2);
  });

  it('reports a consumer build through the nativeBuild phase and its build terminal', { timeout: 120000 }, async () => {
    // Arrange
    const real = await testHelperImage();
    const built: StartupProgress[] = [];
    const failed: StartupProgress[] = [];
    const cached: StartupProgress[] = [];
    const root = await installation();

    // Act
    await prepareNativeImage(event => built.push(event), () => {}, { root, ...withToolchain(await fakeToolchain({ build: 'copy', copyFrom: real.path })) });
    await prepareNativeImage(event => cached.push(event), () => {}, { root });
    await refuses(prepareNativeImage(event => failed.push(event), () => {}, { root: await installation(), ...withToolchain(await fakeToolchain({ build: 'fail' })) }), 'buildFailed');

    // Assert
    assert.deepEqual(built.map(event => [event.kind, event.phase]), [['phase', 'nativeBuild'], ['nativeHelperBuilt', null]]);
    assert.deepEqual(failed.map(event => [event.kind, event.phase]), [['phase', 'nativeBuild'], ['failed', null]]);
    assert.deepEqual(cached, []);
  });
});
