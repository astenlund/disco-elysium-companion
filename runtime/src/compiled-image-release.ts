import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBoundedPrivateFile } from './compiled-broker.ts';
import { asInteger, hasExactKeys, isLowerHex, jsonBudgets, parseStrictJson, type JsonValue } from './json.ts';

export const compiledImageGeneration = '2d3013059b9625f967f3263ea2e196ca59d24da999a9e5bcfc3691527408f44d';
export const compiledBrokerSha256 = 'aa52d71f8a2243bdcb83bc394a12fe8193e413eb70b3543130f69df5a99c5d13';
export const compiledObserverSha256 = 'bb3818599c2b5c5c4da98af42daea4300bfdb3103c0d420009021bd8af313fec';
const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.join(installationRoot, 'runtime/native/compiled-images.json');
const brokerSources = ['runtime/prototypes/go-process-broker/go.mod',
  'runtime/prototypes/go-process-broker/control.go', 'runtime/prototypes/go-process-broker/child_windows.go',
  'runtime/prototypes/go-process-broker/job_windows.go', 'runtime/prototypes/go-process-broker/cmd/go-broker/main.go'] as const;
const observerSources = ['runtime/prototypes/job-observer.go'] as const;

export class CompiledImageReleaseError extends Error {
  override readonly name = 'CompiledImageReleaseError';
  readonly code = 'compiledImageReleaseUnavailable';
}
export interface CompiledImageSource { readonly path: string; readonly sha256: string }
export interface CompiledImageEntry { readonly file: string; readonly bytes: number; readonly sha256: string;
  readonly sources: readonly CompiledImageSource[] }
export interface CompiledImageRelease { readonly generation: string; readonly broker: CompiledImageEntry;
  readonly observer: CompiledImageEntry }

function unavailable(): CompiledImageReleaseError {
  return new CompiledImageReleaseError('Compiled image release is unavailable.');
}

function sourceList(value: JsonValue, expected: readonly string[]): readonly CompiledImageSource[] {
  if (!Array.isArray(value) || value.length !== expected.length) { throw unavailable(); }
  return value.map((source, index) => {
    if (!hasExactKeys(source, ['path', 'sha256']) || source['path'] !== expected[index]
      || !isLowerHex(source['sha256'], 64)) { throw unavailable(); }
    return { path: expected[index]!, sha256: source['sha256'] };
  });
}

function imageEntry(value: JsonValue, file: string, sources: readonly string[]): CompiledImageEntry {
  if (!hasExactKeys(value, ['file', 'bytes', 'sha256', 'sources']) || value['file'] !== file
    || !isLowerHex(value['sha256'], 64)) { throw unavailable(); }
  const bytes = asInteger(value['bytes']);
  if (bytes === undefined || bytes < 1 || bytes > 33_554_432) { throw unavailable(); }
  return { file, bytes, sha256: value['sha256'], sources: sourceList(value['sources']!, sources) };
}

/** @internal A fixed reviewed digest is the trust root, even when no manifest exists on disk. */
export function parseCompiledImageRelease(bytes: Uint8Array): CompiledImageRelease {
  const generation = createHash('sha256').update(bytes).digest('hex');
  if (generation !== compiledImageGeneration) { throw unavailable(); }
  let value: JsonValue;
  try { value = parseStrictJson(bytes); }
  catch { throw unavailable(); }
  if (!hasExactKeys(value, ['compiledImagesVersion', 'toolchain', 'broker', 'observer'])
    || asInteger(value['compiledImagesVersion']) !== 1 || !hasExactKeys(value['toolchain'], ['name', 'version', 'target', 'flags'])) {
    throw unavailable();
  }
  const toolchain = value['toolchain'];
  if (toolchain['name'] !== 'go' || toolchain['version'] !== 'go1.26.0' || toolchain['target'] !== 'windows/amd64'
    || !Array.isArray(toolchain['flags']) || toolchain['flags'].length !== 3
    || toolchain['flags'][0] !== '-buildvcs=false' || toolchain['flags'][1] !== '-trimpath'
    || toolchain['flags'][2] !== '-ldflags=-buildid=') { throw unavailable(); }
  const broker = imageEntry(value['broker']!, 'go-broker.exe', brokerSources);
  const observer = imageEntry(value['observer']!, 'job-observer.exe', observerSources);
  if (broker.sha256 !== compiledBrokerSha256 || observer.sha256 !== compiledObserverSha256) { throw unavailable(); }
  return { generation,
    broker, observer };
}

export function readCompiledImageRelease(): CompiledImageRelease {
  try { return parseCompiledImageRelease(readBoundedPrivateFile(manifestPath, jsonBudgets.config.maxBytes)); }
  catch { throw unavailable(); }
}
