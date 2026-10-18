import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareStartupHelperScratch } from '../src/startup-helper-scratch.ts';

const repository = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));

test('helper profile destinations are distinct admitted directories under repository scratch', async () => {
  const prepared = await prepareStartupHelperScratch();
  const relative = path.win32.relative(repository, prepared.root);
  assert.ok(relative.startsWith(`.tmp${path.win32.sep}runtime-startup-`));
  try {
    const selected = ['TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'NUGET_HTTP_CACHE_PATH', 'NUGET_PLUGINS_CACHE_PATH',
      'NUGET_SCRATCH', 'DOTNET_BUNDLE_EXTRACT_BASE_DIR', 'NODE_COMPILE_CACHE'] as const;
    const destinations = selected.map(name => prepared.environment[name]);
    assert.equal(new Set(destinations).size, selected.length);
    for (const destination of destinations) {
      assert.ok(destination !== undefined && path.win32.relative(prepared.root, destination).length > 0);
      assert.equal((await fs.stat(destination)).isDirectory(), true);
    }
    assert.equal(prepared.environment.HOME, undefined);
  } finally {
    assert.equal(path.win32.isAbsolute(relative), false);
    assert.equal(relative.startsWith(`.tmp${path.win32.sep}runtime-startup-`), true);
    await fs.rm(prepared.root, { recursive: true, force: true });
  }
});

test('helper scratch creates and admits its parent on a fresh installation', async () => {
  const parent = path.win32.join(repository, '.tmp', `fresh-startup-${randomUUID()}`);
  assert.equal(await fs.stat(parent).then(() => true, () => false), false);
  const prepared = await prepareStartupHelperScratch(parent);
  try {
    assert.equal(path.win32.dirname(prepared.root), parent);
    assert.equal((await fs.stat(prepared.environment.TEMP!)).isDirectory(), true);
  } finally {
    const relative = path.win32.relative(repository, parent);
    assert.ok(relative.startsWith(`.tmp${path.win32.sep}fresh-startup-`));
    await fs.rm(parent, { recursive: true, force: true });
  }
});
