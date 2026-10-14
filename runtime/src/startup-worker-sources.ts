import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from './admission.ts';
import { hasExactKeys, isLowerHex, parseStrictJson, type JsonValue } from './json.ts';
import type { RuntimeScope } from './scope.ts';

const script = fileURLToPath(new URL('../scripts/Get-StartupWorkerSource.ps1', import.meta.url));
export const startupWorkerInstallationRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface StartupWorkerEvidence {
  readonly scopeSha256: string;
  readonly metadataSha256: string;
  readonly coreReplySha256: string;
  readonly mutationSha256: string;
}

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup worker source evidence is unavailable.'); }

export async function observeStartupWorkerSources(inspector: Pick<PathInspector, 'metadata'>, scope: RuntimeScope): Promise<StartupWorkerEvidence | null> {
  const reply = await inspector.metadata(script, ['-CompanionRoot', scope.companionRoot, '-DataRoot', scope.dataRoot,
    '-SourceRoot', startupWorkerInstallationRoot], scope.companionRoot);
  if (reply.exitCode !== 0 || reply.stderr.length !== 0 || reply.stdout.length < 1 || reply.stdout.length > 65_536) { throw unavailable(); }
  let value: JsonValue;
  try { value = parseStrictJson(reply.stdout); }
  catch { throw unavailable(); }
  if (hasExactKeys(value, ['status']) && value['status'] === 'absent') { return null; }
  if (!hasExactKeys(value, ['status', 'scopeSha256', 'metadataSha256', 'coreReplySha256', 'mutationSha256']) || value['status'] !== 'present'
    || value['scopeSha256'] !== scope.bindingSha256 || !isLowerHex(value['scopeSha256'], 64)
    || !isLowerHex(value['metadataSha256'], 64) || !isLowerHex(value['coreReplySha256'], 64)
    || !isLowerHex(value['mutationSha256'], 64)) { throw unavailable(); }

  return Object.freeze({ scopeSha256: value['scopeSha256'], metadataSha256: value['metadataSha256'],
    coreReplySha256: value['coreReplySha256'], mutationSha256: value['mutationSha256'] });
}
