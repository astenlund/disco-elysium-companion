// Runtime identities. Every token here follows the shared opaque-token profile of state
// extraction 7.6 and is compared exactly.
import { randomBytes } from 'node:crypto';

const textEncoder = new TextEncoder();

// The shared opaque-token profile: NFC, no C0 or C1 control characters, 1 to 128 Unicode
// scalars, and at most 512 UTF-8 bytes. A lone surrogate is not a scalar and fails.
export function isOpaqueToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || !value.isWellFormed() || value.normalize('NFC') !== value) { return false; }
  if (textEncoder.encode(value).byteLength > 512) { return false; }
  let scalars = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x80 && code <= 0x9f)) { return false; }
    scalars += 1;
  }

  return scalars >= 1 && scalars <= 128;
}

// 32 lowercase hex from 16 fresh random bytes.
export function newIdentity(): string {
  return randomBytes(16).toString('hex');
}

export type OperationKind = 'repair' | 'release' | 'handover';

export function newOperationId(kind: OperationKind): string {
  return `${kind === 'repair' ? 'jr' : kind === 'release' ? 'rl' : 'ho'}-${newIdentity()}`;
}

export const operationIdPattern = /^(jr|rl|ho)-[0-9a-f]{32}$/;

export interface ProcessIdentities {
  readonly runtimeInstanceId: string;
  readonly runtimeSessionId: string;
  readonly adapterBindingEpoch: string;
}

// Minted once per process start. runtimeInstanceId must differ from the previous start's
// and from runtimeSessionId; a collision is regenerated up to three times.
export function mintProcessIdentities(previousInstanceId: string | null, mint: () => string = newIdentity): ProcessIdentities {
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const runtimeInstanceId = mint();
    const runtimeSessionId = mint();
    const adapterBindingEpoch = mint();
    if (runtimeInstanceId !== previousInstanceId && runtimeInstanceId !== runtimeSessionId) {
      return { runtimeInstanceId, runtimeSessionId, adapterBindingEpoch };
    }
  }
  throw new Error('Runtime identities collided four times.');
}
