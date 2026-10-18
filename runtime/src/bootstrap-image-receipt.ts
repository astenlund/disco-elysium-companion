import { createHash } from 'node:crypto';
import path from 'node:path';

import { asInteger, hasExactKeys, isLowerHex, type JsonValue } from './json.ts';

export interface ImagePinRequest {
  readonly version: 1;
  readonly nonce: string;
  readonly targetProcessId: number;
  readonly targetCreated: string;
  readonly companionRoot: string;
  readonly installationRoot: string;
  readonly game: string;
  readonly artifactGeneration: string;
  readonly brokerPath: string;
  readonly observerPath: string;
  readonly brokerSha256: string;
  readonly observerSha256: string;
}
export interface ImagePinHandle { readonly kind: 'directory' | 'broker' | 'observer'; readonly path: string;
  readonly volume: string; readonly identity: string; readonly handle: string }
export type ImagePinReceipt = { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly handles: readonly ImagePinHandle[] };

export class ImagePinReceiptError extends Error {
  override readonly name = 'ImagePinReceiptError';
  readonly code = 'imagePinReceiptInvalid';
}
function unavailable(): ImagePinReceiptError { return new ImagePinReceiptError('Image pin receipt is invalid.'); }
const hashPath = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function directoryChain(location: string): readonly string[] {
  const chain: string[] = [];
  let current = path.win32.dirname(location);
  while (true) {
    chain.unshift(current);
    const parent = path.win32.dirname(current);
    if (parent === current) { return chain; }
    if (chain.length > 64) { throw unavailable(); }
    current = parent;
  }
}

function expectedHandlePaths(request: ImagePinRequest): readonly { kind: ImagePinHandle['kind']; path: string }[] {
  const directories = [...new Set([...directoryChain(request.brokerPath), ...directoryChain(request.observerPath)])];
  if (directories.length < 1 || directories.length > 62) { throw unavailable(); }
  return [...directories.map(location => ({ kind: 'directory' as const, path: location })),
    { kind: 'broker' as const, path: request.brokerPath }, { kind: 'observer' as const, path: request.observerPath }];
}

/** @internal Native handle metadata is checked by the helper; this parser binds its exact receipt to the frozen request. */
export function parseImagePinReceipt(value: JsonValue, request: ImagePinRequest,
  candidateScopePath: string): ImagePinReceipt {
  if (hasExactKeys(value, ['status']) && value['status'] === 'absent') { return { status: 'absent' }; }
  if (!hasExactKeys(value, ['status', 'version', 'nonce', 'targetProcessId', 'targetCreated', 'artifactGeneration',
    'installationRootSha256', 'candidateScopePathSha256', 'brokerSha256', 'observerSha256', 'handles'])
    || value['status'] !== 'ready' || asInteger(value['version']) !== 1
    || value['nonce'] !== request.nonce || asInteger(value['targetProcessId']) !== request.targetProcessId
    || value['targetCreated'] !== request.targetCreated || value['artifactGeneration'] !== request.artifactGeneration
    || value['installationRootSha256'] !== hashPath(request.installationRoot)
    || value['candidateScopePathSha256'] !== hashPath(candidateScopePath)
    || value['brokerSha256'] !== request.brokerSha256 || value['observerSha256'] !== request.observerSha256
    || !Array.isArray(value['handles'])) { throw unavailable(); }
  const expected = expectedHandlePaths(request);
  if (value['handles'].length !== expected.length) { throw unavailable(); }
  const values = new Set<string>();
  const objects = new Set<string>();
  const handles: ImagePinHandle[] = value['handles'].map((entry, index) => {
    if (!hasExactKeys(entry, ['kind', 'path', 'volume', 'identity', 'handle'])
      || entry['kind'] !== expected[index]!.kind || entry['path'] !== expected[index]!.path
      || !isLowerHex(entry['volume'], 16) || !isLowerHex(entry['identity'], 32)
      || !isLowerHex(entry['handle'], 16) || entry['handle'] === '0'.repeat(16)) { throw unavailable(); }
    const object = `${entry['volume']}:${entry['identity']}`;
    if (values.has(entry['handle']) || objects.has(object)) { throw unavailable(); }
    values.add(entry['handle']);
    objects.add(object);
    return { kind: entry['kind'], path: entry['path'], volume: entry['volume'],
      identity: entry['identity'], handle: entry['handle'] };
  });

  return { status: 'ready', handles };
}
