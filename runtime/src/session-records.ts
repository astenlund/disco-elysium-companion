import { controlFields, controlHash, controlInteger, controlList, controlToken, controlUtc, requireControl } from './control-values.ts';
import type { JsonValue } from './json.ts';

export const sessionIndexLimit = 32;
export interface AgentSessionBinding {
  readonly agentSessionVersion: 1;
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly createdAt: string;
  readonly turnsCompleted: number;
  readonly needsState: boolean;
  readonly instructionsSha256: string;
  readonly stateGeneration: string;
}
export interface SessionIndexEntry extends AgentSessionBinding { readonly lastBoundAt: string }
export interface AgentSessionIndex { readonly agentSessionIndexVersion: 1; readonly sessions: readonly SessionIndexEntry[] }
export type NamedSessionAdmission = { readonly result: 'admitted'; readonly binding: AgentSessionBinding } | { readonly result: 'unknownSession' | 'stateInvalidated' | 'instructionsChanged' };

const bindingFields = ['agentSessionVersion', 'providerId', 'providerSessionId', 'createdAt', 'turnsCompleted', 'needsState', 'instructionsSha256', 'stateGeneration'] as const;

export function parseSessionBinding(value: JsonValue): AgentSessionBinding {
  const item = controlFields(value, bindingFields);
  requireControl(controlInteger(item['agentSessionVersion']) === 1 && typeof item['needsState'] === 'boolean');
  return Object.freeze({ agentSessionVersion: 1, providerId: controlToken(item['providerId']), providerSessionId: controlToken(item['providerSessionId']),
    createdAt: controlUtc(item['createdAt']), turnsCompleted: controlInteger(item['turnsCompleted']), needsState: item['needsState'],
    instructionsSha256: controlHash(item['instructionsSha256']), stateGeneration: controlHash(item['stateGeneration'], 32) });
}

export function parseSessionIndex(value: JsonValue): AgentSessionIndex {
  const item = controlFields(value, ['agentSessionIndexVersion', 'sessions']);
  requireControl(controlInteger(item['agentSessionIndexVersion']) === 1);
  const identities = new Set<string>();
  const sessions = controlList(item['sessions'], value => {
    const entry = controlFields(value, [...bindingFields, 'lastBoundAt']);
    const { lastBoundAt, ...rest } = entry;
    const binding = parseSessionBinding(rest);
    const identity = JSON.stringify([binding.providerId, binding.providerSessionId]);
    requireControl(!identities.has(identity));
    identities.add(identity);
    return Object.freeze({ ...binding, lastBoundAt: controlUtc(lastBoundAt) });
  });
  requireControl(sessions.length <= sessionIndexLimit);
  return Object.freeze({ agentSessionIndexVersion: 1, sessions });
}

export function indexCurrentBinding(index: AgentSessionIndex | null, binding: AgentSessionBinding, lastBoundAt: string): AgentSessionIndex {
  controlUtc(lastBoundAt);
  const others = (index?.sessions ?? []).filter(entry => entry.providerId !== binding.providerId || entry.providerSessionId !== binding.providerSessionId);
  others.sort((left, right) => left.lastBoundAt < right.lastBoundAt ? -1 : left.lastBoundAt > right.lastBoundAt ? 1 : 0);
  // The current binding must survive even if wall-clock time moved backwards.
  const sessions = [...others.slice(-(sessionIndexLimit - 1)), Object.freeze({ ...binding, lastBoundAt })];
  return Object.freeze({ agentSessionIndexVersion: 1, sessions: Object.freeze(sessions) });
}

export function admitNamedSession(index: AgentSessionIndex | null, providerId: string, sessionId: string, generation: string, instructionsSha256: string): NamedSessionAdmission {
  controlHash(generation, 32);
  controlHash(instructionsSha256);
  const entry = index?.sessions.find(entry => entry.providerId === providerId && entry.providerSessionId === sessionId);
  if (entry === undefined) { return { result: 'unknownSession' }; }
  if (entry.stateGeneration !== generation) { return { result: 'stateInvalidated' }; }
  if (entry.instructionsSha256 !== instructionsSha256) { return { result: 'instructionsChanged' }; }
  const { lastBoundAt: _, ...binding } = entry;
  return { result: 'admitted', binding: Object.freeze(binding) };
}
