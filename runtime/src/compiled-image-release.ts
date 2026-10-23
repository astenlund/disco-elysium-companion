import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { goToolchain } from './go-toolchain.ts';
import { asInteger, hasExactKeys, isLowerHex, jsonBudgets, parseStrictJson, type JsonValue } from './json.ts';
import { NativeHelperUnavailableError } from './native-helper-error.ts';

/** The reviewed pins: the release manifest's digest and the helper image's digest. The pin tool rewrites both together. */
export const compiledImageGeneration = '0f653206ad59f113566ddadd0a273c224c150ae0a8fdd6852273c74fd9f2586d';
export const nativeHelperSha256 = '0e78c42c350a097c7d1161f795a044fc31269a37fac293ba5b7c9c968e262a99';

export const manifestFile = 'runtime/native/compiled-images.json';
export const helperModule = 'runtime/native/helper';
export const helperImageFile = 'runtime/native/companion-helper.exe';
export { goToolchain };
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
