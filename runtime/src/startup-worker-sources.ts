import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from './admission.ts';
import { hasExactKeys, isLowerHex, type JsonValue } from './json.ts';
import type { RuntimeScope } from './scope.ts';

/** The installation root the retained core reply scripts are admitted under; it may differ from the companion root in fixtures. */
export const startupWorkerInstallationRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The scope binding digest and the retained core reply source digest the warm worker's hello must match. */
export interface StartupWorkerEvidence {
  readonly scopeSha256: string;
  readonly coreReplySha256: string;
}

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup worker source evidence is unavailable.'); }

/** Returns null when the companion .tmp directory is absent, the condition under which no warm worker opens. */
export async function observeStartupWorkerSources(inspector: Pick<PathInspector, 'native'>, scope: RuntimeScope): Promise<StartupWorkerEvidence | null> {
  let value: JsonValue;
  try {
    value = await inspector.native('coreReplySource', { companionRoot: scope.companionRoot, dataRoot: scope.dataRoot,
      sourceRoot: startupWorkerInstallationRoot });
  } catch { throw unavailable(); }
  if (hasExactKeys(value, ['status']) && value['status'] === 'absent') { return null; }
  if (!hasExactKeys(value, ['status', 'scopeSha256', 'coreReplySha256']) || value['status'] !== 'present'
    || !isLowerHex(value['scopeSha256'], 64) || value['scopeSha256'] !== scope.bindingSha256 || !isLowerHex(value['coreReplySha256'], 64)) {
    throw unavailable();
  }
  return Object.freeze({ scopeSha256: value['scopeSha256'], coreReplySha256: value['coreReplySha256'] });
}
