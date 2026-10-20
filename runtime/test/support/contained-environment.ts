import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { withoutHome } from '../../src/compiled-broker.ts';
import { dotnetFirstRunOptOuts } from '../../src/dotnet-environment.ts';

export interface ContainedEnvironment {
  readonly scratch: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly remove: () => Promise<void>;
}

/** Gives a test child a repository-local profile, so pwsh and .NET write no profile, temporary or first-run data outside the repository. */
export async function containedEnvironment(repository: string, prefix: string): Promise<ContainedEnvironment> {
  const scratchParent = path.join(repository, '.tmp');
  const scratch = await fs.mkdtemp(path.join(scratchParent, prefix));
  const environment: NodeJS.ProcessEnv = { ...withoutHome(process.env), ...dotnetFirstRunOptOuts };
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'DOTNET_CLI_HOME']) {
    environment[name] = scratch;
  }
  const remove = async (): Promise<void> => {
    assert.equal(path.dirname(scratch), scratchParent);
    assert.ok((await fs.realpath(scratch)).startsWith((await fs.realpath(repository)) + path.sep));
    await fs.rm(scratch, { recursive: true, force: true });
  };

  return { scratch, environment, remove };
}
