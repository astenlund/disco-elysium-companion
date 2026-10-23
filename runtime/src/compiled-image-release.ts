import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { asInteger, hasExactKeys, isLowerHex, jsonBudgets, parseStrictJson, type JsonValue } from './json.ts';
import { NativeHelperUnavailableError } from './native-helper-error.ts';

/** The reviewed pins: the release manifest's digest and the helper image's digest. The pin tool rewrites both together. */
export const compiledImageGeneration = '58fc84b15a6368b49969d0846c3189956138e7340ca0e3834f45bac5108ad65a';
export const nativeHelperSha256 = '76a6f9675abb37888d22a15cb7ecae7ccd6b27f112e5253eba35dcb8683ce703';

export const manifestFile = 'runtime/native/compiled-images.json';
export const helperModule = 'runtime/native/helper';
export const helperImageFile = 'runtime/native/companion-helper.exe';
export const goToolchain = { name: 'go', version: 'go1.26.0', target: 'windows/amd64', amd64: 'v1',
  flags: ['-buildvcs=false', '-trimpath', '-ldflags=-buildid='] } as const;
const maximumImageBytes = 33_554_432;

export interface NativeSource { readonly path: string; readonly sha256: string }
export interface NativeHelperRelease {
  readonly generation: string;
  readonly helper: { readonly file: string; readonly bytes: number; readonly sha256: string; readonly sources: readonly NativeSource[] };
}

function sourceMismatch(): NativeHelperUnavailableError { return new NativeHelperUnavailableError('sourceMismatch'); }

function sourceList(value: JsonValue | undefined): readonly NativeSource[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) { throw sourceMismatch(); }
  return value.map(source => {
    if (!hasExactKeys(source, ['path', 'sha256']) || typeof source['path'] !== 'string' || !source['path'].startsWith(`${helperModule}/`)
      || !isLowerHex(source['sha256'], 64)) { throw sourceMismatch(); }
    return { path: source['path'], sha256: source['sha256'] };
  });
}

/**
 * Parses manifest bytes whose digest must equal the reviewed generation pin. A changed manifest is a checkout that no
 * longer matches its review, so it refuses with the source-digest reason.
 */
export function parseNativeHelperRelease(bytes: Uint8Array, expectedGeneration = compiledImageGeneration,
  expectedImage = nativeHelperSha256): NativeHelperRelease {
  const generation = createHash('sha256').update(bytes).digest('hex');
  if (generation !== expectedGeneration) { throw sourceMismatch(); }
  let value: JsonValue;
  try { value = parseStrictJson(bytes); }
  catch { throw sourceMismatch(); }
  if (!hasExactKeys(value, ['compiledImagesVersion', 'toolchain', 'helper']) || asInteger(value['compiledImagesVersion']) !== 2
    || !hasExactKeys(value['toolchain'], ['name', 'version', 'target', 'flags'])
    || !hasExactKeys(value['helper'], ['file', 'bytes', 'sha256', 'sources'])) { throw sourceMismatch(); }
  const toolchain = value['toolchain'];
  const helper = value['helper'];
  const flags = toolchain['flags'];
  if (toolchain['name'] !== goToolchain.name || toolchain['version'] !== goToolchain.version || toolchain['target'] !== goToolchain.target
    || !Array.isArray(flags) || flags.length !== goToolchain.flags.length || flags.some((flag, index) => flag !== goToolchain.flags[index])
    || helper['file'] !== path.posix.basename(helperImageFile) || helper['sha256'] !== expectedImage) { throw sourceMismatch(); }
  const bytesValue = asInteger(helper['bytes']);
  if (bytesValue === undefined || bytesValue < 1 || bytesValue > maximumImageBytes) { throw sourceMismatch(); }
  return { generation, helper: { file: helper['file'], bytes: bytesValue, sha256: expectedImage, sources: sourceList(helper['sources']) } };
}

export function readNativeHelperRelease(root: string): NativeHelperRelease {
  let bytes: Buffer;
  try { bytes = readFileSync(path.join(root, manifestFile)); }
  catch { throw sourceMismatch(); }
  if (bytes.length > jsonBudgets.config.maxBytes) { throw sourceMismatch(); }
  return parseNativeHelperRelease(bytes);
}
