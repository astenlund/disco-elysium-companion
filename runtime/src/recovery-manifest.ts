import { controlChoice, controlFields, controlHash, controlInteger, controlList, controlNullable, controlObject, requireControl } from './control-values.ts';
import { eventFileName, parseEventMetadata, parseJournalCursor, parseJournalHeader, type EventMetadata, type JournalCursor, type JournalHeader } from './journal-records.ts';
import { parseStrictJson, stringifyJson, type JsonValue } from './json.ts';
import { outboxRecordSequence } from './outbox-name.ts';
import { parseSkippedRange, type SkippedRange } from './recovery-provenance.ts';

export interface FileTransition { readonly path: string; readonly before: string | null; readonly after: string | null }
export interface PayloadSource { readonly root: 'scope' | 'companion'; readonly path: string; readonly sha256: string; readonly payloadBindingSha256: string }
export type RecoveryAction =
  | { readonly kind: 'preserveRecovery' | 'appendRecovery'; readonly target: FileTransition; readonly source: PayloadSource; readonly metadata: EventMetadata }
  | { readonly kind: 'quarantine'; readonly source: FileTransition; readonly target: FileTransition }
  | { readonly kind: 'publishHeader' | 'raiseHighWater'; readonly target: FileTransition; readonly value: JournalHeader }
  | { readonly kind: 'publishCursor'; readonly target: FileTransition; readonly value: JournalCursor }
  | { readonly kind: 'removeCarry'; readonly target: FileTransition };
export interface RecoveryPrerequisite {
  readonly kind: 'header' | 'cursor' | 'gap' | 'rewind';
  readonly actions: readonly RecoveryAction[];
  readonly nextAction: number;
  readonly carry: { readonly path: 'journal/recovery-event.json'; readonly sha256: string } | null;
  readonly skippedRanges: readonly SkippedRange[];
}

function whole(pattern: RegExp, value: string): boolean { return pattern.exec(value)?.[0] === value; }
function journalEventSequence(value: string): number | null {
  const match = /^journal\/events\/([0-9]{16})\.json$/.exec(value);
  if (match === null) { return null; }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}
export function isJournalMember(value: unknown): value is string {
  return typeof value === 'string' && (value === 'journal/journal.json' || value === 'journal/cursor-agent-session.json' || value === 'journal/recovery-event.json' || journalEventSequence(value) !== null);
}
function quarantinePath(value: unknown): value is string { return typeof value === 'string' && whole(/^quarantine\/[A-Za-z0-9.-]+\.[a-f0-9]{32}\.quarantined$/, value); }

function transition(value: JsonValue | undefined): FileTransition {
  const object = controlFields(value, ['path', 'before', 'after']);
  requireControl(isJournalMember(object['path']) || quarantinePath(object['path']));
  return Object.freeze({ path: object['path'], before: controlNullable(object['before'], controlHash), after: controlNullable(object['after'], controlHash) });
}

function source(value: JsonValue | undefined): PayloadSource {
  const object = controlFields(value, ['root', 'path', 'sha256', 'payloadBindingSha256']);
  const root = controlChoice(object['root'], ['scope', 'companion']);
  const path = object['path'];
  requireControl(typeof path === 'string' && (root === 'scope' ? path === 'journal/recovery-event.json' || journalEventSequence(path) !== null
    : path.startsWith('state/outbox/') && outboxRecordSequence(path.slice('state/outbox/'.length)) !== null));
  return Object.freeze({ root, path, sha256: controlHash(object['sha256']), payloadBindingSha256: controlHash(object['payloadBindingSha256']) });
}

export function parseRecoveryAction(value: JsonValue): RecoveryAction {
  const object = controlObject(value);
  const kind = controlChoice(object['kind'], ['preserveRecovery', 'appendRecovery', 'quarantine', 'publishHeader', 'publishCursor', 'raiseHighWater', 'removeCarry']);
  if (kind === 'quarantine') {
    controlFields(object, ['kind', 'source', 'target']);
    const origin = transition(object['source']);
    const target = transition(object['target']);
    requireControl(isJournalMember(origin.path) && origin.before !== null && origin.after === null && quarantinePath(target.path) && target.before === null && target.after === origin.before);
    return Object.freeze({ kind, source: origin, target });
  }
  if (kind === 'removeCarry') {
    controlFields(object, ['kind', 'target']);
    const target = transition(object['target']);
    requireControl(target.path === 'journal/recovery-event.json' && target.before !== null && target.after === null);
    return Object.freeze({ kind, target });
  }
  if (kind === 'preserveRecovery' || kind === 'appendRecovery') {
    controlFields(object, ['kind', 'target', 'source', 'metadata']);
    const target = transition(object['target']);
    const origin = source(object['source']);
    const metadata = parseEventMetadata(object['metadata']!);
    requireControl(!metadata.compacted && target.after !== null && (kind === 'preserveRecovery' ? target.path === 'journal/recovery-event.json' : target.path === `journal/events/${eventFileName(metadata.sequence)}` && target.before === null));
    requireControl(origin.root !== 'scope' || origin.path !== target.path);
    return Object.freeze({ kind, target, source: origin, metadata });
  }
  controlFields(object, ['kind', 'target', 'value']);
  const target = transition(object['target']);
  requireControl(target.after !== null);
  if (kind === 'publishCursor') {
    requireControl(target.path === 'journal/cursor-agent-session.json');
    return Object.freeze({ kind, target, value: parseJournalCursor(object['value']!) });
  }
  requireControl(target.path === 'journal/journal.json');
  return Object.freeze({ kind, target, value: parseJournalHeader(object['value']!) });
}

export function parsePrerequisite(value: JsonValue): RecoveryPrerequisite {
  const object = controlFields(value, ['kind', 'actions', 'nextAction', 'carry', 'skippedRanges']);
  const kind = controlChoice(object['kind'], ['header', 'cursor', 'gap', 'rewind']);
  const actions = controlList(object['actions'], parseRecoveryAction);
  const nextAction = controlInteger(object['nextAction'], 0, actions.length);
  const carry = controlNullable(object['carry'], value => {
    const slot = controlFields(value, ['path', 'sha256']);
    requireControl(slot['path'] === 'journal/recovery-event.json');
    return Object.freeze({ path: 'journal/recovery-event.json' as const, sha256: controlHash(slot['sha256']) });
  });
  const skippedRanges = controlList(object['skippedRanges'], parseSkippedRange);
  const latest = new Map<string, string | null>();
  for (const entry of actions) {
    const changes = entry.kind === 'quarantine' ? [entry.source, entry.target] : [entry.target];
    for (const change of changes) {
      requireControl(!latest.has(change.path) || latest.get(change.path) === change.before);
      latest.set(change.path, change.after);
    }
    if (entry.kind === 'preserveRecovery') { requireControl(carry !== null && entry.target.after === carry.sha256); }
    if (entry.kind === 'removeCarry') { requireControl(carry !== null && entry.target.before === carry.sha256); }
    if (entry.kind === 'appendRecovery' && entry.source.root === 'scope' && entry.source.path === 'journal/recovery-event.json') { requireControl(carry !== null && entry.source.sha256 === carry.sha256); }
  }
  return Object.freeze({ kind, actions, nextAction, carry, skippedRanges });
}

export type ManifestObservation = { readonly status: 'readable'; readonly sha256: string | null } | { readonly status: 'unavailable' };
export function recognizeAction(action: RecoveryAction, observations: ReadonlyMap<string, ManifestObservation>): 'before' | 'after' | 'damage' | 'unavailable' {
  const changes = action.kind === 'quarantine' ? [action.source, action.target] : [action.target];
  if (changes.some(change => observations.get(change.path)?.status !== 'readable')) { return 'unavailable'; }
  const matches = (image: 'before' | 'after'): boolean => changes.every(change => {
    const observed = observations.get(change.path)!;
    return observed.status === 'readable' && observed.sha256 === change[image];
  });
  if (matches('after')) { return 'after'; }
  return matches('before') ? 'before' : 'damage';
}

export function validatePrerequisite(value: RecoveryPrerequisite): RecoveryPrerequisite {
  return parsePrerequisite(parseStrictJson(Buffer.from(stringifyJson(value, 'state-event'), 'utf8'), 'state-event'));
}
