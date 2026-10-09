import { jsonBudgets, ProspectiveJsonBudgetError, type JsonProfile } from './json.ts';

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
  readonly state: 'unavailable' | 'exhausted';
  readonly transition: CapacityTransition | null;
  constructor(decision: Extract<CapacityDecision, { admitted: false }>, transition: CapacityTransition | null = null, options?: ErrorOptions) {
    super('Runtime capacity is ' + decision.state + '.', options); this.dimensions = Object.freeze([...decision.dimensions]); this.state = decision.state; this.transition = transition;
  }
}

export function requireCapacity(inventory: CapacityInventory, transition: TransitionReservation): Extract<CapacityDecision, { admitted: true }> {
  const decision = assessCapacity(inventory, transition);
  if (!decision.admitted) { throw new RuntimeCapacityError(decision); }
  return decision;
}

export const capacityTransitions = ['runtimeMarker', 'release', 'repair', 'maintenance', 'ordinary'] as const;
export type CapacityTransition = typeof capacityTransitions[number];
export const capacityReasons = ['inventory', 'documentInventory', 'additions', 'recoveryAuthority', 'stateSafety', 'reservation', 'publicationScope', 'scopeAuthority', 'eventFinalization', 'unreservedAddition', 'workspace', 'codecScope', 'otherAuthority'] as const;
export type CapacityReason = typeof capacityReasons[number];
export const capacityDimensions = ['uncompactedEvents', 'retainedHandoffs', 'fullTerminalOperations', 'quarantineFiles', 'freeSpace', 'documentBytes', 'documentTokens', 'documentText', 'operationFinalizationBytes', 'operationFinalizationTokensOrText', 'operationFinalizationDocument', 'otherResource'] as const;
export type CapacityDimension = typeof capacityDimensions[number];
export interface CapacitySlot { readonly state: 'unchecked' | 'admitted' | 'unavailable' | 'exhausted'; readonly reason: CapacityReason | null; readonly dimensions: readonly CapacityDimension[] }
export interface CapacityOwed {
  readonly unacknowledgedEvents: number | null;
  readonly pendingOutboxRecords: number | null;
  readonly unfinishedOperations: number | null;
  readonly protectedHandoffs: number | null;
  readonly safetyObligation: boolean | null;
  readonly historyDisclosure: boolean | null;
}
export type CapacityStatus = Readonly<Record<CapacityTransition, CapacitySlot>> & { readonly owed: CapacityOwed };
const uncheckedSlot: CapacitySlot = Object.freeze({ state: 'unchecked', reason: null, dimensions: Object.freeze([]) });
const admittedSlot: CapacitySlot = Object.freeze({ state: 'admitted', reason: null, dimensions: Object.freeze([]) });
export function unknownCapacityOwed(): CapacityOwed {
  return Object.freeze({ unacknowledgedEvents: null, pendingOutboxRecords: null, unfinishedOperations: null, protectedHandoffs: null, safetyObligation: null, historyDisclosure: null });
}
export function initialCapacity(): CapacityStatus {
  return Object.freeze({ runtimeMarker: uncheckedSlot, release: uncheckedSlot, repair: uncheckedSlot, maintenance: uncheckedSlot, ordinary: uncheckedSlot, owed: unknownCapacityOwed() });
}
export function isCapacityBlocked(value: CapacityStatus): boolean { return capacityTransitions.some(kind => value[kind].state === 'unavailable' || value[kind].state === 'exhausted'); }
export function capacitySlot(error: RuntimeCapacityError): CapacitySlot {
  if (error.state === 'unavailable') {
    const first = error.dimensions[0];
    const reason = error.dimensions.length === 1 && capacityReasons.some(value => value === first) ? first as CapacityReason : 'otherAuthority';
    return Object.freeze({ state: 'unavailable', reason, dimensions: Object.freeze([]) });
  }
  const values = new Set<CapacityDimension>();
  for (const dimension of error.dimensions) {
    const mapped = dimension === 'operationFinalization:bytes' ? 'operationFinalizationBytes'
      : dimension === 'operationFinalization:tokensOrText' ? 'operationFinalizationTokensOrText'
        : dimension === 'operationFinalization:document' ? 'operationFinalizationDocument'
          : dimension.endsWith(':bytes') ? 'documentBytes' : dimension.endsWith(':tokens') ? 'documentTokens' : dimension.endsWith(':text') ? 'documentText'
            : capacityDimensions.some(value => value === dimension) ? dimension as CapacityDimension : 'otherResource';
    values.add(mapped);
  }
  if (values.size === 0) { values.add('otherResource'); }
  return Object.freeze({ state: 'exhausted', reason: null, dimensions: Object.freeze(capacityDimensions.filter(value => values.has(value))) });
}
export function capacityJournalFault(capacity: CapacityStatus, independent: string | null): string | null {
  return independent ?? (capacityTransitions.some(kind => capacity[kind].state === 'exhausted') ? 'runtimeCapacityExceeded' : null);
}
export function firstCapacityRefusal(capacity: CapacityStatus): RuntimeCapacityError | null {
  const transition = capacityTransitions.find(kind => capacity[kind].state === 'unavailable' || capacity[kind].state === 'exhausted');
  if (transition === undefined) { return null; }
  const slot = capacity[transition];
  return new RuntimeCapacityError({ admitted: false, state: slot.state as 'unavailable' | 'exhausted', dimensions: slot.state === 'unavailable' ? [slot.reason!] : slot.dimensions }, transition);
}
export function capacityError(error: unknown, transition: CapacityTransition | null, dependency: CapacityReason = 'otherAuthority'): RuntimeCapacityError {
  if (error instanceof RuntimeCapacityError) {
    return error.transition !== null || transition === null ? error : new RuntimeCapacityError({ admitted: false, state: error.state, dimensions: error.dimensions }, transition, { cause: error });
  }
  if (error instanceof ProspectiveJsonBudgetError) {
    if (transition === null) { return new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: ['otherAuthority'] }, null, { cause: error }); }
    const dimensions = error.limits.map(item => (error.document ?? 'prospective-document') + ':' + item.dimension);
    return new RuntimeCapacityError({ admitted: false, state: 'exhausted', dimensions }, transition, { cause: error });
  }
  return new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: [dependency] }, transition, { cause: error });
}

// The fixed public map is the entire refusal set. Admission forecasts and exact
// diagnostic errors are separate from this bounded, volatile observation.
export class CapacityObservation {
  private value = initialCapacity();
  private version = 0;
  private listener: (() => void) | null = null;
  get current(): CapacityStatus { return this.value; }
  get epoch(): number { return this.version; }
  subscribe(listener: () => void): void { this.listener = listener; }
  private replace(value: CapacityStatus): void {
    const before = JSON.stringify(this.value); this.value = Object.freeze(value);
    if (JSON.stringify(value) !== before) { this.listener?.(); }
  }
  invalidateOwed(fields: readonly (keyof CapacityOwed)[] = Object.keys(unknownCapacityOwed()) as (keyof CapacityOwed)[]): void {
    if (fields.length === 0) { return; }
    this.version++;
    const owed = { ...this.value.owed };
    for (const field of fields) { owed[field] = null; }
    this.replace({ ...this.value, owed: Object.freeze(owed) });
  }
  invalidate(): void {
    this.version++;
    const slots = Object.fromEntries(capacityTransitions.map(kind => [kind, this.value[kind].state === 'admitted' ? uncheckedSlot : this.value[kind]])) as Record<CapacityTransition, CapacitySlot>;
    this.replace({ ...slots, owed: unknownCapacityOwed() });
  }
  observeOwed(owed: Partial<CapacityOwed>, epoch = this.version): void {
    if (epoch !== this.version) { return; }
    for (const [key, value] of Object.entries(owed)) {
      if (!Object.hasOwn(this.value.owed, key)) { throw new Error('Unknown capacity obligation field.'); }
      if (value !== null && (key === 'safetyObligation' || key === 'historyDisclosure' ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || (value as number) < 0)) {
        throw new Error('Capacity obligation observation is invalid.');
      }
    }
    this.replace({ ...this.value, owed: Object.freeze({ ...this.value.owed, ...owed }) });
  }
  admitted(kind: CapacityTransition): void { this.replace({ ...this.value, [kind]: admittedSlot }); }
  refused(error: RuntimeCapacityError): void {
    if (error.transition === null) {
      const unknown: CapacitySlot = Object.freeze({ state: 'unavailable', reason: 'otherAuthority', dimensions: Object.freeze([]) });
      this.replace({ runtimeMarker: unknown, release: unknown, repair: unknown, maintenance: unknown, ordinary: unknown, owed: unknownCapacityOwed() });
      this.version++;
      return;
    }
    this.replace({ ...this.value, [error.transition]: capacitySlot(error) });
  }
}
