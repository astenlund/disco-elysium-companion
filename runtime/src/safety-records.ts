import { isOpaqueToken, newIdentity } from './identity.ts';
import { asInteger, hasExactKeys, isLowerHex, type JsonValue } from './json.ts';

export type CorrectionReason = 'coreRejected' | 'contextUncertain';
export interface Correction { readonly correctionId: string; readonly reason: CorrectionReason; readonly recoveryOperationId: string | null }
export interface RecoveryOwner { readonly operationId: string; readonly episodeOrdinal: number; readonly activationId: string }
export interface RecoveryDisclosure { readonly journalId: string; readonly eventId: string; readonly sequence: number; readonly generation: string }
export interface RecoveryWitness {
  readonly scopeSha256: string;
  readonly owner: RecoveryOwner;
  readonly phase: 'preparing' | 'active' | 'awaitingDisclosure' | 'transferring';
  readonly successor: RecoveryOwner | null;
  readonly disclosure: RecoveryDisclosure | null;
}
export interface StateSafety {
  readonly stateSafetyVersion: 1;
  readonly generation: string;
  readonly pendingCheck: string | null;
  readonly correction: Correction | null;
  readonly recoveryWitness: RecoveryWitness | null;
}

export class SafetyUnavailableError extends Error { override readonly name = 'SafetyUnavailableError'; }
function requireValue(condition: unknown): asserts condition { if (!condition) { throw new SafetyUnavailableError('Context safety authority is invalid.'); } }

export function isRepairOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('jr-') && isLowerHex(value.slice(3), 32);
}

function parseOwner(value: JsonValue | undefined): RecoveryOwner {
  requireValue(hasExactKeys(value, ['operationId', 'episodeOrdinal', 'activationId']));
  const ordinal = asInteger(value['episodeOrdinal']);
  requireValue(isRepairOperationId(value['operationId']) && ordinal !== undefined && ordinal >= 0 && isLowerHex(value['activationId'], 32));
  return Object.freeze({ operationId: value['operationId'], episodeOrdinal: ordinal, activationId: value['activationId'] });
}

export function sameRecoveryOwner(left: RecoveryOwner, right: RecoveryOwner): boolean {
  return left.operationId === right.operationId && left.episodeOrdinal === right.episodeOrdinal && left.activationId === right.activationId;
}

export function parseRecoveryWitness(value: JsonValue | undefined, scopeSha256: string): RecoveryWitness | null {
  requireValue(isLowerHex(scopeSha256, 64));
  if (value === null) { return null; }
  requireValue(hasExactKeys(value, ['scopeSha256', 'owner', 'phase', 'successor', 'disclosure']) && value['scopeSha256'] === scopeSha256);
  const owner = parseOwner(value['owner']);
  const phase = value['phase'];
  requireValue(phase === 'preparing' || phase === 'active' || phase === 'awaitingDisclosure' || phase === 'transferring');
  const successor = value['successor'] === null ? null : parseOwner(value['successor']);
  requireValue(phase === 'transferring' ? successor !== null && successor.activationId !== owner.activationId : successor === null);
  let disclosure: RecoveryDisclosure | null = null;
  const proof = value['disclosure'];
  if (proof !== null) {
    requireValue(hasExactKeys(proof, ['journalId', 'eventId', 'sequence', 'generation']));
    const sequence = asInteger(proof['sequence']);
    requireValue(isOpaqueToken(proof['journalId']) && isLowerHex(proof['eventId'], 32) && sequence !== undefined && sequence > 0 && isLowerHex(proof['generation'], 32));
    disclosure = Object.freeze({ journalId: proof['journalId'], eventId: proof['eventId'], sequence, generation: proof['generation'] });
  }
  requireValue(phase !== 'awaitingDisclosure' || disclosure !== null);
  return Object.freeze({ scopeSha256, owner, phase, successor, disclosure });
}

export function parseStateSafety(value: JsonValue, scopeSha256: string): StateSafety {
  requireValue(hasExactKeys(value, ['stateSafetyVersion', 'generation', 'pendingCheck', 'correction', 'recoveryWitness']) && asInteger(value['stateSafetyVersion']) === 1
    && isLowerHex(value['generation'], 32) && (value['pendingCheck'] === null || isLowerHex(value['pendingCheck'], 32)));
  let correction: Correction | null = null;
  const raw = value['correction'];
  if (raw !== null) {
    requireValue(hasExactKeys(raw, ['correctionId', 'reason', 'recoveryOperationId']) && isLowerHex(raw['correctionId'], 32)
      && (raw['reason'] === 'coreRejected' || raw['reason'] === 'contextUncertain') && (raw['recoveryOperationId'] === null || isRepairOperationId(raw['recoveryOperationId'])));
    correction = Object.freeze({ correctionId: raw['correctionId'], reason: raw['reason'], recoveryOperationId: raw['recoveryOperationId'] });
  }
  return Object.freeze({ stateSafetyVersion: 1, generation: value['generation'], pendingCheck: value['pendingCheck'], correction, recoveryWitness: parseRecoveryWitness(value['recoveryWitness'], scopeSha256) });
}

export function freshGeneration(current: string | null, bindingGenerations: readonly string[], mint = newIdentity): string {
  requireValue(current === null || isLowerHex(current, 32));
  requireValue(bindingGenerations.every(token => isLowerHex(token, 32)));
  const forbidden = new Set(bindingGenerations);
  if (current !== null) { forbidden.add(current); }
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = mint();
    requireValue(isLowerHex(candidate, 32));
    if (!forbidden.has(candidate)) { return candidate; }
  }
  throw new SafetyUnavailableError('A distinct safety generation could not be allocated.');
}

// This returns a publication candidate. It grants no authority until the coordinator
// has persisted it, planned recovery and discharged the exact interrupted check.
export function invalidatedSafety(current: StateSafety, reason: CorrectionReason, bindingGenerations: readonly string[], mint = newIdentity, obligationCorrectionId?: string): StateSafety {
  requireValue(obligationCorrectionId === undefined || isLowerHex(obligationCorrectionId, 32));
  const generation = freshGeneration(current.generation, bindingGenerations, mint);
  const correctionId = current.correction?.correctionId ?? obligationCorrectionId ?? mint();
  requireValue(isLowerHex(correctionId, 32));
  return Object.freeze({
    ...current,
    generation,
    correction: Object.freeze({ correctionId, reason: current.correction?.reason === 'coreRejected' ? 'coreRejected' : reason, recoveryOperationId: current.correction?.recoveryOperationId ?? null }),
    // Pending check and independent witness carry forward through every invalidation.
  });
}
