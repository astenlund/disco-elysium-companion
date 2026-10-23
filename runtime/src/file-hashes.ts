import { createHash } from 'node:crypto';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import { Deadline } from './deadline.ts';
import { hasExactKeys, isLowerHex, jsonBudgets, stringifyJson, type JsonValue } from './json.ts';

const maximumBatchPaths = 512;

// This is read-only physical admission and complete-byte observation, not JSON authority.
export async function readFileHashes(inspector: PathInspector, root: string, targets: readonly string[], deadline: Deadline, scopeSha256?: string): Promise<readonly (string | null)[]> {
  deadline.check();
  if (scopeSha256 !== undefined && !isLowerHex(scopeSha256, 64)) { throw new DataRootUnavailableError('Invalid immutable scope hash.'); }
  const frozen = targets.map(target => path.resolve(root, target));
  const result: (string | null)[] = [];
  for (let offset = 0; offset < frozen.length;) {
    deadline.check();
    const batch: string[] = [];
    let bytes = 2;
    let textBytes = 0;
    while (offset + batch.length < frozen.length && batch.length < maximumBatchPaths) {
      const target = frozen[offset + batch.length]!;
      const encodedBytes = Buffer.byteLength(JSON.stringify(target), 'utf8');
      const decodedBytes = Buffer.byteLength(target, 'utf8');
      const nextBytes = bytes + encodedBytes + (batch.length === 0 ? 0 : 1);
      if (nextBytes > jsonBudgets.config.maxBytes || textBytes + decodedBytes > jsonBudgets.config.maxTextBytes) { break; }
      batch.push(target);
      bytes = nextBytes;
      textBytes += decodedBytes;
    }
    if (batch.length === 0) { throw new DataRootUnavailableError('File observation target exceeds its control budget.'); }
    const input = Buffer.from(stringifyJson(batch), 'utf8');
    const requestSha256 = createHash('sha256').update(input).digest('hex');
    let response: JsonValue;
    try { response = await inspector.native('hash', { root, inputBase64: input.toString('base64'), scopeSha256: scopeSha256 ?? null }, deadline.remaining(30000)); }
    catch (error) { throw new DataRootUnavailableError('File observation is unavailable.', { cause: error }); }
    deadline.check();
    if (!hasExactKeys(response, ['requestSha256', 'sha256']) || response['requestSha256'] !== requestSha256 || !Array.isArray(response['sha256']) || response['sha256'].length !== batch.length || !response['sha256'].every(hash => hash === null || isLowerHex(hash, 64))) {
      throw new DataRootUnavailableError('File observation is incomplete or uncorrelated.');
    }
    result.push(...response['sha256'] as (string | null)[]);
    offset += batch.length;
  }
  deadline.check();
  return result;
}
