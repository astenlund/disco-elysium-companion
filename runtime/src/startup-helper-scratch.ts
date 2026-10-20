import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitPrivateDirectory, withoutHome } from './compiled-broker.ts';
import { dotnetFirstRunOptOuts } from './dotnet-environment.ts';

const installationRoot = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const defaultScratchParent = path.win32.join(installationRoot, '.tmp');
const writableNames = ['temp', 'tmp', 'tmpdir', 'userprofile', 'appdata', 'localappdata', 'dotnet',
  'nuget-packages', 'nuget-http', 'nuget-plugins', 'nuget-scratch', 'bundle', 'node-cache'] as const;

export interface StartupHelperScratch { readonly root: string; readonly environment: NodeJS.ProcessEnv }

/** @internal Prepares distinct helper-only destinations without changing the provider's ambient profile. */
export async function prepareStartupHelperScratch(scratchParent = defaultScratchParent): Promise<StartupHelperScratch> {
  const relative = path.win32.relative(installationRoot, scratchParent);
  if (path.win32.resolve(scratchParent) !== scratchParent || relative === '' || relative === '..'
    || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error('Startup scratch parent is outside the installation root.');
  }
  admitPrivateDirectory(path.win32.dirname(scratchParent));
  try { await fs.mkdir(scratchParent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
  admitPrivateDirectory(scratchParent);
  const root = await fs.mkdtemp(path.win32.join(scratchParent, 'runtime-startup-'));
  admitPrivateDirectory(root);
  const locations = new Map<string, string>();
  for (const name of writableNames) {
    const location = path.win32.join(root, name);
    await fs.mkdir(location);
    admitPrivateDirectory(location);
    locations.set(name, location);
  }
  const location = (name: typeof writableNames[number]): string => locations.get(name)!;
  const environment: NodeJS.ProcessEnv = {
    ...withoutHome(process.env),
    TEMP: location('temp'), TMP: location('tmp'), TMPDIR: location('tmpdir'),
    USERPROFILE: location('userprofile'), APPDATA: location('appdata'), LOCALAPPDATA: location('localappdata'),
    DOTNET_CLI_HOME: location('dotnet'), NUGET_PACKAGES: location('nuget-packages'),
    NUGET_HTTP_CACHE_PATH: location('nuget-http'), NUGET_PLUGINS_CACHE_PATH: location('nuget-plugins'),
    NUGET_SCRATCH: location('nuget-scratch'), DOTNET_BUNDLE_EXTRACT_BASE_DIR: location('bundle'),
    NODE_COMPILE_CACHE: location('node-cache'), GOTELEMETRY: 'off', ...dotnetFirstRunOptOuts,
  };
  return { root, environment: Object.freeze(environment) };
}
