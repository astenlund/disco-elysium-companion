import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitPrivateDirectory } from './compiled-broker.ts';

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
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'HOME'));
  const environment: NodeJS.ProcessEnv = {
    ...ambient,
    TEMP: location('temp'), TMP: location('tmp'), TMPDIR: location('tmpdir'),
    USERPROFILE: location('userprofile'), APPDATA: location('appdata'), LOCALAPPDATA: location('localappdata'),
    DOTNET_CLI_HOME: location('dotnet'), NUGET_PACKAGES: location('nuget-packages'),
    NUGET_HTTP_CACHE_PATH: location('nuget-http'), NUGET_PLUGINS_CACHE_PATH: location('nuget-plugins'),
    NUGET_SCRATCH: location('nuget-scratch'), DOTNET_BUNDLE_EXTRACT_BASE_DIR: location('bundle'),
    NODE_COMPILE_CACHE: location('node-cache'), DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', GOTELEMETRY: 'off',
  };
  return { root, environment: Object.freeze(environment) };
}
