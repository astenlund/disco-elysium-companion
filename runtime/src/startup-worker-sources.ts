import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, type PathInspector } from './admission.ts';
import { hasExactKeys, isLowerHex, parseStrictJson, type JsonValue } from './json.ts';
import type { RuntimeScope, ScopeCandidate } from './scope.ts';

const script = fileURLToPath(new URL('../scripts/Get-StartupWorkerSource.ps1', import.meta.url));
export const startupWorkerInstallationRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface StartupWorkerEvidence {
  readonly scopeSha256: string;
  readonly metadataSha256: string;
  readonly coreReplySha256: string;
  readonly mutationSha256: string;
}

function unavailable(): DataRootUnavailableError { return new DataRootUnavailableError('Startup worker source evidence is unavailable.'); }

function parseEvidence(value: unknown, expectedScopeSha256?: string): StartupWorkerEvidence {
  if (!hasExactKeys(value, ['status', 'scopeSha256', 'metadataSha256', 'coreReplySha256', 'mutationSha256']) || value['status'] !== 'present'
    || !isLowerHex(value['scopeSha256'], 64) || expectedScopeSha256 !== undefined && value['scopeSha256'] !== expectedScopeSha256
    || !isLowerHex(value['metadataSha256'], 64) || !isLowerHex(value['coreReplySha256'], 64)
    || !isLowerHex(value['mutationSha256'], 64)) { throw unavailable(); }
  return Object.freeze({ scopeSha256: value['scopeSha256'], metadataSha256: value['metadataSha256'],
    coreReplySha256: value['coreReplySha256'], mutationSha256: value['mutationSha256'] });
}

export async function observeStartupWorkerSources(inspector: Pick<PathInspector, 'metadata'>, scope: RuntimeScope): Promise<StartupWorkerEvidence | null> {
  const reply = await inspector.metadata(script, ['-CompanionRoot', scope.companionRoot, '-DataRoot', scope.dataRoot,
    '-SourceRoot', startupWorkerInstallationRoot], scope.companionRoot);
  if (reply.exitCode !== 0 || reply.stderr.length !== 0 || reply.stdout.length < 1 || reply.stdout.length > 65_536) { throw unavailable(); }
  let value: JsonValue;
  try { value = parseStrictJson(reply.stdout); }
  catch { throw unavailable(); }
  if (hasExactKeys(value, ['status']) && value['status'] === 'absent') { return null; }
  return parseEvidence(value, scope.bindingSha256);
}

export type BootstrapWorkerObservation = { readonly status: 'absent' | 'scopeAbsent' }
  | { readonly status: 'present'; readonly evidence: StartupWorkerEvidence; readonly scopeBytes: Buffer | null };

/** @internal Existing-scope bootstrap combines one fresh binding read with source admission. */
export async function observeBootstrapWorkerSources(inspector: Pick<PathInspector, 'metadata'>, candidate: ScopeCandidate): Promise<BootstrapWorkerObservation> {
  const reply = await inspector.metadata(script, ['-CompanionRoot', candidate.companionRoot, '-DataRoot', candidate.dataRoot,
    '-SourceRoot', startupWorkerInstallationRoot, '-IncludeScopeBytes'], candidate.companionRoot);
  if (reply.exitCode !== 0 || reply.stderr.length !== 0 || reply.stdout.length < 1 || reply.stdout.length > 65_536) { throw unavailable(); }
  const value = parseStrictJson(reply.stdout);
  if (hasExactKeys(value, ['status']) && value['status'] === 'absent') { return { status: 'absent' }; }
  if (hasExactKeys(value, ['status']) && value['status'] === 'scopeAbsent') { return { status: 'scopeAbsent' }; }
  if (!hasExactKeys(value, ['status', 'scopeSha256', 'metadataSha256', 'coreReplySha256', 'mutationSha256', 'scopeBytesBase64'])) { throw unavailable(); }
  const base64 = value['scopeBytesBase64'];
  if (base64 !== null && typeof base64 !== 'string') { throw unavailable(); }
  const scopeBytes = base64 === null ? null : Buffer.from(base64, 'base64');
  if (scopeBytes !== null && (scopeBytes.length > 32768 || scopeBytes.toString('base64') !== base64)) { throw unavailable(); }
  const evidence = parseEvidence({ status: value['status'], scopeSha256: value['scopeSha256'], metadataSha256: value['metadataSha256'],
    coreReplySha256: value['coreReplySha256'], mutationSha256: value['mutationSha256'] });
  if (scopeBytes !== null && createHash('sha256').update(scopeBytes).digest('hex') !== evidence.scopeSha256) { throw unavailable(); }
  return { status: 'present', evidence, scopeBytes };
}
