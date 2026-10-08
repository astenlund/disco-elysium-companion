import { jsonBudgets, type JsonProfile } from './json.ts';

export const runtimeLimits = Object.freeze({ uncompactedEvents: 8192, retainedHandoffs: 8192, fullTerminalOperations: 4096, quarantineFiles: 256 });
export interface ResourceCounts { readonly uncompactedEvents: number; readonly retainedHandoffs: number; readonly fullTerminalOperations: number }
export interface DocumentUsage { readonly bytes: number; readonly tokens: number; readonly textBytes: number }
export interface DocumentReservation { readonly name: string; readonly profile: JsonProfile; readonly usage: DocumentUsage | null }
export interface CapacityInventory {
  readonly complete: boolean;
  readonly counts: ResourceCounts;
  readonly freeBytes: bigint | null;
  readonly uncertainWorkspace: boolean;
}
export interface TransitionReservation {
  readonly kind: 'ordinary' | 'repair' | 'release';
  readonly additions: ResourceCounts;
  readonly remainingControlReserve: ResourceCounts;
  readonly documents: readonly DocumentReservation[];
  readonly workspaceBytes: bigint;
}
export type CapacityDecision = { readonly admitted: true; readonly controlOnly: boolean; readonly peakCounts: ResourceCounts; readonly reservedBytes: bigint } | { readonly admitted: false; readonly state: 'unavailable' | 'exhausted'; readonly dimensions: readonly string[] };
const dimensions = ['uncompactedEvents', 'retainedHandoffs', 'fullTerminalOperations'] as const;

function countsValid(counts: ResourceCounts): boolean { return dimensions.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0); }

// Reservations describe a complete bounded transition, including its recovery and
// finalization. Unknown prospective documents reserve their entire admitted profile.
export function assessCapacity(inventory: CapacityInventory, transition: TransitionReservation): CapacityDecision {
  if (!inventory.complete || inventory.uncertainWorkspace || inventory.freeBytes === null || inventory.freeBytes < 0n || !countsValid(inventory.counts)
    || !countsValid(transition.additions) || !countsValid(transition.remainingControlReserve) || transition.workspaceBytes < 0n) {
    return { admitted: false, state: 'unavailable', dimensions: ['inventory'] };
  }
  const exhausted: string[] = [];
  const peak: ResourceCounts = {
    uncompactedEvents: inventory.counts.uncompactedEvents + transition.additions.uncompactedEvents + transition.remainingControlReserve.uncompactedEvents,
    retainedHandoffs: inventory.counts.retainedHandoffs + transition.additions.retainedHandoffs + transition.remainingControlReserve.retainedHandoffs,
    fullTerminalOperations: inventory.counts.fullTerminalOperations + transition.additions.fullTerminalOperations + transition.remainingControlReserve.fullTerminalOperations,
  };
  let controlOnly = false;
  for (const dimension of dimensions) {
    if (!Number.isSafeInteger(peak[dimension])) { exhausted.push(dimension); continue; }
    if (peak[dimension] > runtimeLimits[dimension]) {
      const unchangedControlDimension = transition.kind !== 'ordinary' && transition.additions[dimension] === 0 && transition.remainingControlReserve[dimension] === 0;
      if (unchangedControlDimension) { controlOnly = true; }
      else { exhausted.push(dimension); }
    }
  }
  let reservedBytes = transition.workspaceBytes;
  const names = new Set<string>();
  for (const document of transition.documents) {
    const budget = jsonBudgets[document.profile];
    if (budget === undefined || document.name.length === 0 || names.has(document.name)) { return { admitted: false, state: 'unavailable', dimensions: ['documentInventory'] }; }
    names.add(document.name);
    const usage = document.usage ?? { bytes: budget.maxBytes, tokens: budget.maxTokens, textBytes: budget.maxTextBytes };
    if (![usage.bytes, usage.tokens, usage.textBytes].every(value => Number.isSafeInteger(value) && value >= 0)) { return { admitted: false, state: 'unavailable', dimensions: ['documentInventory'] }; }
    if (usage.bytes > budget.maxBytes) { exhausted.push(`${document.name}:bytes`); }
    if (usage.tokens > budget.maxTokens) { exhausted.push(`${document.name}:tokens`); }
    if (usage.textBytes > budget.maxTextBytes) { exhausted.push(`${document.name}:text`); }
    reservedBytes += BigInt(usage.bytes);
  }
  if (reservedBytes > inventory.freeBytes) { exhausted.push('freeSpace'); }
  return exhausted.length > 0 ? { admitted: false, state: 'exhausted', dimensions: Object.freeze(exhausted) } : { admitted: true, controlOnly, peakCounts: Object.freeze(peak), reservedBytes };
}

export class RuntimeCapacityError extends Error {
  override readonly name = 'RuntimeCapacityError';
  readonly dimensions: readonly string[];
  constructor(decision: Extract<CapacityDecision, { admitted: false }>) { super(`Runtime capacity is ${decision.state}.`); this.dimensions = decision.dimensions; }
}

export function requireCapacity(inventory: CapacityInventory, transition: TransitionReservation): Extract<CapacityDecision, { admitted: true }> {
  const decision = assessCapacity(inventory, transition);
  if (!decision.admitted) { throw new RuntimeCapacityError(decision); }
  return decision;
}
