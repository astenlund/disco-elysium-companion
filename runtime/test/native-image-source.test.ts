import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dotnetFirstRunOptOuts } from '../src/dotnet-environment.ts';
import { bundleNativeImageSources } from '../src/native-image-source.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativeFiles = path.join(repository, 'runtime/scripts/NativeFiles.cs');
const imagePins = path.join(repository, 'runtime/scripts/NativeImagePins.cs');
const lineFeed = String.fromCharCode(10);

test('captured native image sources form one compilable in-memory unit', { timeout: 30000 }, async () => {
  const source = bundleNativeImageSources(await fs.readFile(nativeFiles), await fs.readFile(imagePins));
  assert.equal(source.split('namespace Companion.Runtime;').length, 2);
  assert.equal(source.split('public static class NativeFiles').length, 2);
  assert.equal(source.split('public static class NativeImagePins').length, 2);
  const scratchParent = path.join(repository, '.tmp');
  const scratch = await fs.mkdtemp(path.join(scratchParent, 'native-image-source-test-'));
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'HOME'));
    for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'DOTNET_CLI_HOME']) {
      environment[name] = scratch;
    }
    Object.assign(environment, dotnetFirstRunOptOuts);
    const encoded = Buffer.from(source).toString('base64');
    const expression = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"
      + encoded + "'))); [Console]::Out.Write('compiled')";
    const child = spawnSync('pwsh', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'],
      { cwd: repository, env: environment, input: Buffer.from(expression + lineFeed),
        windowsHide: true, timeout: 20000, maxBuffer: 65536 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr.toString('utf8'));
    assert.equal(child.stdout.toString('utf8'), 'compiled');
    assert.equal(child.stderr.length, 0);
  } finally {
    assert.equal(path.dirname(scratch), scratchParent);
    assert.ok((await fs.realpath(scratch)).startsWith((await fs.realpath(repository)) + path.sep));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('source bundling rejects mixed line endings and incomplete headers', async () => {
  const native = await fs.readFile(nativeFiles);
  const pins = await fs.readFile(imagePins);
  const marker = native.indexOf(Buffer.from([13, 10]));
  assert.ok(marker >= 0);
  const mixed = Buffer.concat([native.subarray(0, marker), Buffer.from([10]), native.subarray(marker + 2)]);
  assert.throws(() => bundleNativeImageSources(mixed, pins), /line endings/);
  assert.throws(() => bundleNativeImageSources(Buffer.from('namespace Companion.Runtime;' + lineFeed), pins), /nullable contract/);
});
