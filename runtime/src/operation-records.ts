import { controlChoice, controlFields, controlHash, controlInt64, controlInteger, controlList, controlNullable, controlObject, controlToken, controlUtc, requireControl } from './control-values.ts';
import { logicalOutboxSequence, parseAcceptance, parseAttemptReference, type Acceptance, type AttemptReference } from './journal-records.ts';
import type { ControlInt64, JsonValue } from './json.ts';
import { outboxRecordSequence } from './outbox-name.ts';
import { carryReleaseResolved, parsePrerequisite, type RecoveryPrerequisite } from './recovery-manifest.ts';
import { parseSkippedRange, type SkippedRange } from './recovery-provenance.ts';
import { parseRecoveryWitness, type RecoveryOwner, type RecoveryWitness } from './safety-records.ts';

export const repairCauses = ['gap', 'outboxInvalid', 'coreRejected', 'settlementUnverified', 'contextUncertain', 'versionChange', 'capacity', 'lostJournal', 'header', 'cursor', 'operationLost'] as const;
export type RepairCause = typeof repairCauses[number];
export type OperationOutcome = 'completed' | 'recordRejected' | 'abandonedByRelease' | 'refused';
export interface JournalReference { readonly journalId: string; readonly eventId: string; readonly sequence: number }
export interface AcceptedRecovery extends JournalReference { readonly generation: string; readonly acceptedAt: string }
export interface SelectedRecord { readonly logicalOutboxId: string; readonly recordSha256: string | null }
export interface RecoveryAttempt { readonly publication: 'due' | 'deferred' | 'observed'; readonly selectedRecord: SelectedRecord | null; readonly journalEvent: JournalReference | null }
export interface RecoveryEpisode {
  readonly activationId: string;
  readonly trigger: 'initial' | 'completedReplay' | 'header' | 'cursor' | 'gap' | 'rewind' | 'recoveryMissing';
  readonly phase: 'preparing' | 'reconstructing' | 'publishing' | 'draining' | 'verifyingHistory' | 'completed' | 'transferred' | 'recordRejected' | 'abandonedByRelease';
  readonly attemptAtStart: number;
  readonly replacementAttempt: number | null;
  readonly prerequisite: RecoveryPrerequisite | null;
  readonly acceptedRecovery: AcceptedRecovery | null;
  readonly successorEpisode: number | null;
  readonly releaseOperationId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
export interface RecoveryProgress { readonly attempts: readonly RecoveryAttempt[]; readonly episodes: readonly RecoveryEpisode[]; readonly activeEpisode: number | null }
export interface RetainedHandoff {
  readonly logicalOutboxId: string;
  readonly recordSha256: string;
  readonly payloadBindingSha256: string | null;
  readonly journalId: string;
  readonly eventId: string;
  readonly acceptance: Acceptance | null;
  readonly presentation: 'replayable' | 'unverified' | 'rejected';
  readonly coreRepairOperationId: string | null;
  readonly attemptRef: AttemptReference | null;
}
export interface OperationSafety { readonly obligationId: string; readonly phase: 'pending' | 'transferred' | 'discharged'; readonly correctionId: string | null }
export interface AffectedEvent { readonly sequence: number; readonly eventId: string | null; readonly fileSha256: string | null }
export interface NamedRecord { readonly name: string; readonly sha256: string }
export interface RetiredRecord { readonly name: string; readonly logicalOutboxId: string; readonly recordSha256: string }
export interface RepairPlan {
  readonly lastGoodSequence: number;
  readonly affected: readonly AffectedEvent[];
  readonly cursorTo: number | null;
  readonly rejectedRecord: NamedRecord | null;
  readonly lostOperations: readonly { readonly name: string; readonly sha256: string; readonly destination: string }[];
  readonly publishedVersions: { readonly schemaVersion: ControlInt64; readonly adapterVersion: ControlInt64 } | null;
  readonly retiredRecords: readonly RetiredRecord[];
  readonly handoffs: readonly RetainedHandoff[];
  readonly correctionId: string | null;
  readonly inheritedRecovery: RecoveryOwner | null;
  readonly skippedRanges: readonly SkippedRange[];
}
export interface ConsumerResult { readonly owner: 'runtime' | 'bridge'; readonly previousOwner: 'absent' | 'bridge' | 'runtime' | 'invalid'; readonly changed: boolean; readonly baselineRemoved: boolean; readonly abandonedCount: number }
export interface ReleasePlan {
  readonly mode: 'confirmed' | 'abandon';
  readonly abandonedSequences: readonly number[];
  readonly journalId: string | null;
  readonly skippedRanges: readonly SkippedRange[];
  readonly unfinishedRepairs: readonly { readonly operationId: string; readonly episodeOrdinal: number | null; readonly activationId: string | null }[];
  readonly witness: RecoveryWitness | null;
  readonly witnessUnavailable: boolean;
  readonly result: ConsumerResult | null;
  readonly completedPhases: readonly ('coreSwitched' | 'cursorAdvanced' | 'repairsAbandoned' | 'dischargesPublished' | 'complete')[];
}
export interface HandoverPlan { readonly owner: 'runtime'; readonly result: ConsumerResult | null; readonly completedPhases: readonly ('coreSwitched' | 'historyPublished' | 'complete')[] }
interface OperationBase {
  readonly operationVersion: 1;
  readonly operationId: string;
  readonly scopeSha256: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: OperationOutcome | null;
}
export interface RepairOperation extends OperationBase { readonly kind: 'repair'; readonly cause: RepairCause; readonly compacted: false; readonly plan: RepairPlan; readonly recovery: RecoveryProgress }
export interface ReleaseOperation extends OperationBase { readonly kind: 'release'; readonly cause: 'release'; readonly compacted: false; readonly plan: ReleasePlan; readonly safety: OperationSafety }
export interface HandoverOperation extends OperationBase { readonly kind: 'handover'; readonly cause: 'handover'; readonly compacted: false; readonly plan: HandoverPlan; readonly safety: OperationSafety }
export interface CompactOperation extends OperationBase { readonly kind: 'repair' | 'release' | 'handover'; readonly cause: RepairCause | 'release' | 'handover'; readonly compacted: true; readonly sourceRecordSha256: string }
export type FullOperation = RepairOperation | ReleaseOperation | HandoverOperation;
export type OperationRecord = FullOperation | CompactOperation;

function operationId(value: unknown, kind?: 'jr' | 'rl' | 'ho'): string {
  const token = controlToken(value);
  const prefix = token.slice(0, 2);
  requireControl(token[2] === '-' && ['jr', 'rl', 'ho'].includes(prefix) && (kind === undefined || prefix === kind));
  controlHash(token.slice(3), 32);
  return token;
}
function recordName(value: unknown): string {
  requireControl(typeof value === 'string' && outboxRecordSequence(value) !== null);
  return value;
}
function reference(value: JsonValue): JournalReference {
  const object = controlFields(value, ['journalId', 'eventId', 'sequence']);
  return Object.freeze({ journalId: controlToken(object['journalId']), eventId: controlHash(object['eventId'], 32), sequence: controlInteger(object['sequence'], 1) });
}
function owner(value: JsonValue): RecoveryOwner {
  const object = controlFields(value, ['operationId', 'episodeOrdinal', 'activationId']);
  return Object.freeze({ operationId: operationId(object['operationId'], 'jr'), episodeOrdinal: controlInteger(object['episodeOrdinal']), activationId: controlHash(object['activationId'], 32) });
}
function selected(value: JsonValue): SelectedRecord {
  const object = controlFields(value, ['logicalOutboxId', 'recordSha256']);
  requireControl(typeof object['logicalOutboxId'] === 'string' && logicalOutboxSequence(object['logicalOutboxId']) !== null);
  return Object.freeze({ logicalOutboxId: object['logicalOutboxId'], recordSha256: controlNullable(object['recordSha256'], controlHash) });
}
function checkpoint(value: JsonValue): AcceptedRecovery {
  const object = controlFields(value, ['journalId', 'eventId', 'sequence', 'generation', 'acceptedAt']);
  return Object.freeze({ journalId: controlToken(object['journalId']), eventId: controlHash(object['eventId'], 32), sequence: controlInteger(object['sequence'], 1), generation: controlHash(object['generation'], 32), acceptedAt: controlUtc(object['acceptedAt']) });
}

export function coreAttemptToken(rootId: string, ordinal: number): string {
  operationId(rootId, 'jr');
  controlInteger(ordinal);
  return ordinal === 0 ? rootId : `${rootId}-r${ordinal}`;
}

export function parseHandoff(value: JsonValue): RetainedHandoff {
  const object = controlFields(value, ['logicalOutboxId', 'recordSha256', 'payloadBindingSha256', 'journalId', 'eventId', 'acceptance', 'presentation', 'coreRepairOperationId', 'attemptRef']);
  requireControl(typeof object['logicalOutboxId'] === 'string' && logicalOutboxSequence(object['logicalOutboxId']) !== null);
  const journalId = controlToken(object['journalId']);
  const eventId = controlToken(object['eventId']);
  const acceptance = parseAcceptance(object['acceptance']);
  requireControl(acceptance === null || acceptance.journalId === journalId && acceptance.eventId === eventId);
  const presentation = controlChoice(object['presentation'], ['replayable', 'unverified', 'rejected']);
  const binding = controlNullable(object['payloadBindingSha256'], controlHash);
  requireControl(presentation !== 'replayable' || binding !== null);
  const coreRepairOperationId = controlNullable(object['coreRepairOperationId'], controlToken);
  const attemptRef = parseAttemptReference(object['attemptRef']);
  requireControl(attemptRef === null || coreRepairOperationId === coreAttemptToken(attemptRef.operationId, attemptRef.attemptOrdinal));
  return Object.freeze({ logicalOutboxId: object['logicalOutboxId'], recordSha256: controlHash(object['recordSha256']), payloadBindingSha256: binding, journalId, eventId, acceptance, presentation, coreRepairOperationId, attemptRef });
}

export function parseOperationSafety(value: JsonValue | undefined): OperationSafety {
  const object = controlFields(value, ['obligationId', 'phase', 'correctionId']);
  const phase = controlChoice(object['phase'], ['pending', 'transferred', 'discharged']);
  const correctionId = controlNullable(object['correctionId'], value => controlHash(value, 32));
  requireControl((phase === 'transferred') === (correctionId !== null));
  return Object.freeze({ obligationId: controlHash(object['obligationId'], 32), phase, correctionId });
}

export function parseRecovery(value: JsonValue | undefined, rootStartedAt: string): RecoveryProgress {
  const object = controlFields(value, ['attempts', 'episodes', 'activeEpisode']);
  const attempts = controlList(object['attempts'], value => {
    const object = controlFields(value, ['publication', 'selectedRecord', 'journalEvent']);
    const selectedRecord = controlNullable(object['selectedRecord'], selected);
    const journalEvent = controlNullable(object['journalEvent'], reference);
    requireControl(journalEvent === null || selectedRecord?.recordSha256 != null);
    const publication = controlChoice(object['publication'], ['due', 'deferred', 'observed']);
    requireControl(publication === 'due' || selectedRecord !== null);
    return Object.freeze({ publication, selectedRecord, journalEvent });
  });
  requireControl(attempts.length > 0);
  const activations = new Set<string>();
  const episodes = controlList(object['episodes'], (value, index) => {
    const object = controlFields(value, ['activationId', 'trigger', 'phase', 'attemptAtStart', 'replacementAttempt', 'prerequisite', 'acceptedRecovery', 'successorEpisode', 'releaseOperationId', 'startedAt', 'endedAt']);
    const activationId = controlHash(object['activationId'], 32);
    requireControl(!activations.has(activationId));
    activations.add(activationId);
    const trigger = controlChoice(object['trigger'], ['initial', 'completedReplay', 'header', 'cursor', 'gap', 'rewind', 'recoveryMissing']);
    const phase = controlChoice(object['phase'], ['preparing', 'reconstructing', 'publishing', 'draining', 'verifyingHistory', 'completed', 'transferred', 'recordRejected', 'abandonedByRelease']);
    const attemptAtStart = controlInteger(object['attemptAtStart'], 0, attempts.length - 1);
    const replacementAttempt = controlNullable(object['replacementAttempt'], value => controlInteger(value, attemptAtStart + 1, attempts.length - 1));
    requireControl(replacementAttempt === null || replacementAttempt === attemptAtStart + 1);
    const successorEpisode = controlNullable(object['successorEpisode'], value => controlInteger(value, index + 1));
    const releaseOperationId = controlNullable(object['releaseOperationId'], value => operationId(value, 'rl'));
    const startedAt = controlUtc(object['startedAt']);
    const endedAt = controlNullable(object['endedAt'], controlUtc);
    const acceptedRecovery = controlNullable(object['acceptedRecovery'], checkpoint);
    requireControl((index === 0 ? trigger === 'initial' && startedAt === rootStartedAt && attemptAtStart === 0 : trigger !== 'initial')
      && (phase === 'transferred') === (successorEpisode !== null) && (phase === 'abandonedByRelease') === (releaseOperationId !== null)
      && (phase !== 'completed' && phase !== 'verifyingHistory' || acceptedRecovery !== null));
    return Object.freeze({ activationId, trigger, phase, attemptAtStart, replacementAttempt, prerequisite: controlNullable(object['prerequisite'], parsePrerequisite), acceptedRecovery, successorEpisode, releaseOperationId, startedAt, endedAt });
  });
  requireControl(episodes.length > 0);
  const activeEpisode = controlNullable(object['activeEpisode'], value => controlInteger(value, 0, episodes.length - 1));
  requireControl(activeEpisode === null || activeEpisode === episodes.length - 1 && (episodes[activeEpisode]!.replacementAttempt ?? episodes[activeEpisode]!.attemptAtStart) === attempts.length - 1);
  for (const [index, episode] of episodes.entries()) {
    requireControl(episode.successorEpisode === null || episode.successorEpisode < episodes.length);
    const terminal = ['completed', 'transferred', 'abandonedByRelease'].includes(episode.phase);
    requireControl(index === activeEpisode ? !terminal && episode.endedAt === null : (terminal || episode.phase === 'recordRejected') && episode.endedAt !== null);
  }
  return Object.freeze({ attempts, episodes, activeEpisode });
}

function repairPlan(value: JsonValue | undefined): RepairPlan {
  const object = controlFields(value, ['lastGoodSequence', 'affected', 'cursorTo', 'rejectedRecord', 'lostOperations', 'publishedVersions', 'retiredRecords', 'handoffs', 'correctionId', 'inheritedRecovery', 'skippedRanges']);
  const affected = controlList(object['affected'], value => {
    const item = controlFields(value, ['sequence', 'eventId', 'fileSha256']);
    return Object.freeze({ sequence: controlInteger(item['sequence'], 1), eventId: controlNullable(item['eventId'], value => controlHash(value, 32)), fileSha256: controlNullable(item['fileSha256'], controlHash) });
  });
  requireControl(new Set(affected.map(item => item.sequence)).size === affected.length);
  const rejectedRecord = controlNullable(object['rejectedRecord'], value => {
    const item = controlFields(value, ['name', 'sha256']);
    return Object.freeze({ name: recordName(item['name']), sha256: controlHash(item['sha256']) });
  });
  const lostOperations = controlList(object['lostOperations'], value => {
    const item = controlFields(value, ['name', 'sha256', 'destination']);
    requireControl(typeof item['name'] === 'string' && item['name'].endsWith('.json'));
    operationId(item['name'].slice(0, -5));
    requireControl(typeof item['destination'] === 'string' && item['destination'].startsWith(`quarantine/${item['name']}.`) && item['destination'].endsWith('.quarantined'));
    controlHash(item['destination'].slice(`quarantine/${item['name']}.`.length, -'.quarantined'.length), 32);
    return Object.freeze({ name: item['name'], sha256: controlHash(item['sha256']), destination: item['destination'] });
  });
  requireControl(new Set(lostOperations.map(item => item.name)).size === lostOperations.length && new Set(lostOperations.map(item => item.destination)).size === lostOperations.length);
  const publishedVersions = controlNullable(object['publishedVersions'], value => {
    const item = controlFields(value, ['schemaVersion', 'adapterVersion']);
    return Object.freeze({ schemaVersion: controlInt64(item['schemaVersion']), adapterVersion: controlInt64(item['adapterVersion']) });
  });
  const retiredRecords = controlList(object['retiredRecords'], value => {
    const item = controlFields(value, ['name', 'logicalOutboxId', 'recordSha256']);
    const name = recordName(item['name']);
    requireControl(typeof item['logicalOutboxId'] === 'string' && logicalOutboxSequence(item['logicalOutboxId']) === Number(name.slice(6, 22)));
    return Object.freeze({ name, logicalOutboxId: item['logicalOutboxId'], recordSha256: controlHash(item['recordSha256']) });
  });
  const handoffs = controlList(object['handoffs'], parseHandoff);
  requireControl(handoffs.length <= 8192 && new Set(handoffs.map(item => `${item.logicalOutboxId}:${item.recordSha256}`)).size === handoffs.length);
  return Object.freeze({ lastGoodSequence: controlInteger(object['lastGoodSequence']), affected, cursorTo: controlNullable(object['cursorTo'], controlInteger), rejectedRecord, lostOperations, publishedVersions, retiredRecords, handoffs,
    correctionId: controlNullable(object['correctionId'], value => controlHash(value, 32)), inheritedRecovery: controlNullable(object['inheritedRecovery'], owner), skippedRanges: controlList(object['skippedRanges'], parseSkippedRange) });
}

function consumerResult(value: JsonValue): ConsumerResult {
  const item = controlFields(value, ['owner', 'previousOwner', 'changed', 'baselineRemoved', 'abandonedCount']);
  requireControl(typeof item['changed'] === 'boolean' && typeof item['baselineRemoved'] === 'boolean');
  return Object.freeze({ owner: controlChoice(item['owner'], ['runtime', 'bridge']), previousOwner: controlChoice(item['previousOwner'], ['absent', 'runtime', 'bridge', 'invalid']), changed: item['changed'], baselineRemoved: item['baselineRemoved'], abandonedCount: controlInteger(item['abandonedCount']) });
}

export function parseOperation(value: JsonValue, scopeSha256: string): OperationRecord {
  controlHash(scopeSha256);
  const object = controlObject(value);
  const baseFields = ['operationVersion', 'operationId', 'scopeSha256', 'kind', 'cause', 'startedAt', 'completedAt', 'outcome', 'compacted'];
  const kind = controlChoice(object['kind'], ['repair', 'release', 'handover']);
  const id = operationId(object['operationId'], kind === 'repair' ? 'jr' : kind === 'release' ? 'rl' : 'ho');
  requireControl(object['scopeSha256'] === scopeSha256 && controlInteger(object['operationVersion']) === 1 && typeof object['compacted'] === 'boolean');
  const cause = kind === 'repair' ? controlChoice(object['cause'], repairCauses) : controlChoice(object['cause'], [kind]);
  const startedAt = controlUtc(object['startedAt']);
  const completedAt = controlNullable(object['completedAt'], controlUtc);
  const outcome = controlNullable(object['outcome'], value => controlChoice(value, ['completed', 'recordRejected', 'abandonedByRelease', 'refused']));
  requireControl((completedAt === null) === (outcome === null));
  requireControl(outcome === null || (kind === 'repair' ? outcome !== 'refused' : kind === 'release' ? outcome === 'completed' || outcome === 'refused' : outcome === 'completed'));
  const base: OperationBase = { operationVersion: 1, operationId: id, scopeSha256, startedAt, completedAt, outcome };
  if (object['compacted']) {
    controlFields(object, [...baseFields, 'sourceRecordSha256']);
    requireControl(completedAt !== null);
    return Object.freeze({ ...base, kind, cause, compacted: true, sourceRecordSha256: controlHash(object['sourceRecordSha256']) });
  }
  if (kind === 'repair') {
    controlFields(object, [...baseFields, 'plan', 'recovery']);
    const plan = repairPlan(object['plan']);
    const recovery = parseRecovery(object['recovery'], startedAt);
    requireControl(completedAt !== null || recovery.activeEpisode !== null);
    for (const handoff of plan.handoffs) { if (handoff.attemptRef?.operationId === id) { requireControl(handoff.attemptRef.attemptOrdinal < recovery.attempts.length); } }
    for (const [index, episode] of recovery.episodes.entries()) {
      const prerequisite = episode.prerequisite;
      if (prerequisite?.carryRelease == null) { continue; }
      const bound = prerequisite.carryRelease.attemptRef;
      requireControl(bound.operationId === id ? bound.attemptOrdinal < recovery.attempts.length : plan.inheritedRecovery?.operationId === bound.operationId);
      const preserved = prerequisite.actions.find(action => action.kind === 'preserveRecovery' && action.target.after === prerequisite.carry?.sha256);
      requireControl(preserved?.kind === 'preserveRecovery');
      requireControl(plan.handoffs.some(handoff => handoff.logicalOutboxId === preserved.metadata.logicalOutboxId
        && handoff.recordSha256 === preserved.metadata.recordSha256 && handoff.payloadBindingSha256 === preserved.source.payloadBindingSha256
        && handoff.journalId === (preserved.metadata.acceptance?.journalId ?? preserved.metadata.journalId)
        && handoff.eventId === (preserved.metadata.acceptance?.eventId ?? preserved.metadata.eventId)
        && handoff.coreRepairOperationId === preserved.metadata.coreRepairOperationId
        && (preserved.metadata.attemptRef === null || handoff.attemptRef?.operationId === preserved.metadata.attemptRef.operationId
          && handoff.attemptRef.attemptOrdinal === preserved.metadata.attemptRef.attemptOrdinal)));
      requireControl(episode.phase !== 'completed' || carryReleaseResolved(prerequisite));
      requireControl(episode.phase !== 'recordRejected' || carryReleaseResolved(prerequisite) || index === recovery.activeEpisode && episode.endedAt === null);
    }
    return Object.freeze({ ...base, kind, cause: cause as RepairCause, compacted: false, plan, recovery });
  }
  controlFields(object, [...baseFields, 'plan', 'safety']);
  const safety = parseOperationSafety(object['safety']);
  if (kind === 'handover') {
    const plan = controlFields(object['plan'], ['owner', 'result', 'completedPhases']);
    requireControl(plan['owner'] === 'runtime');
    const result = controlNullable(plan['result'], consumerResult);
    requireControl(result === null || result.owner === 'runtime');
    const completedPhases = controlList(plan['completedPhases'], value => controlChoice(value, ['coreSwitched', 'historyPublished', 'complete']));
    requireControl(new Set(completedPhases).size === completedPhases.length);
    requireControl(!completedPhases.includes('coreSwitched') || result !== null);
    requireControl(completedAt === null || result !== null && completedPhases.includes('coreSwitched') && completedPhases.includes('complete'));
    return Object.freeze({ ...base, kind, cause: 'handover', compacted: false, safety, plan: Object.freeze({ owner: 'runtime' as const, result, completedPhases }) });
  }
  const plan = controlFields(object['plan'], ['mode', 'abandonedSequences', 'journalId', 'skippedRanges', 'unfinishedRepairs', 'witness', 'witnessUnavailable', 'result', 'completedPhases']);
  const mode = controlChoice(plan['mode'], ['confirmed', 'abandon']);
  const abandonedSequences = controlList(plan['abandonedSequences'], value => controlInteger(value, 1));
  requireControl(new Set(abandonedSequences).size === abandonedSequences.length && typeof plan['witnessUnavailable'] === 'boolean');
  const journalId = controlNullable(plan['journalId'], controlToken);
  requireControl(abandonedSequences.length === 0 || mode === 'abandon');
  const unfinishedRepairs = controlList(plan['unfinishedRepairs'], value => {
    const item = controlFields(value, ['operationId', 'episodeOrdinal', 'activationId']);
    const episodeOrdinal = controlNullable(item['episodeOrdinal'], controlInteger);
    const activationId = controlNullable(item['activationId'], value => controlHash(value, 32));
    requireControl((episodeOrdinal === null) === (activationId === null));
    return Object.freeze({ operationId: operationId(item['operationId'], 'jr'), episodeOrdinal, activationId });
  });
  requireControl(new Set(unfinishedRepairs.map(item => item.operationId)).size === unfinishedRepairs.length);
  const result = controlNullable(plan['result'], consumerResult);
  requireControl(result === null || result.owner === 'bridge');
  const completedPhases = controlList(plan['completedPhases'], value => controlChoice(value, ['coreSwitched', 'cursorAdvanced', 'repairsAbandoned', 'dischargesPublished', 'complete']));
  requireControl(new Set(completedPhases).size === completedPhases.length);
  requireControl(!completedPhases.includes('coreSwitched') || result !== null);
  requireControl(outcome !== 'completed' || result !== null && completedPhases.includes('coreSwitched') && completedPhases.includes('complete'));
  requireControl(outcome !== 'refused' || result === null && !completedPhases.includes('coreSwitched'));
  const witness = parseRecoveryWitness(plan['witness'], scopeSha256);
  return Object.freeze({ ...base, kind, cause: 'release', compacted: false, safety, plan: { mode, abandonedSequences, journalId, skippedRanges: controlList(plan['skippedRanges'], parseSkippedRange), unfinishedRepairs, witness, witnessUnavailable: plan['witnessUnavailable'], result, completedPhases } });
}

export function operationHasUnresolvedCarryRelease(operation: OperationRecord): boolean {
  return !operation.compacted && operation.kind === 'repair' && operation.recovery.episodes.some(episode => episode.phase !== 'transferred'
    && episode.prerequisite !== null && !carryReleaseResolved(episode.prerequisite));
}

export function effectivelyUnfinished(operation: OperationRecord, dependentRecoveryUnavailable = false): boolean {
  return dependentRecoveryUnavailable || operation.completedAt === null || !operation.compacted && operation.kind === 'repair'
    && (operation.recovery.activeEpisode !== null || operation.recovery.episodes.some(episode => episode.phase !== 'transferred' && episode.phase !== 'abandonedByRelease'
      && episode.prerequisite !== null && !carryReleaseResolved(episode.prerequisite)));
}

export function pendingOperationSafety(operation: OperationRecord): boolean {
  return !operation.compacted && operation.kind !== 'repair' && operation.safety.phase === 'pending';
}

export function initialRecovery(startedAt: string, activationId: string): RecoveryProgress {
  controlUtc(startedAt); controlHash(activationId, 32);
  return Object.freeze({ attempts: Object.freeze([{ publication: 'due', selectedRecord: null, journalEvent: null } as const]), episodes: Object.freeze([{ activationId, trigger: 'initial', phase: 'preparing', attemptAtStart: 0, replacementAttempt: null, prerequisite: null, acceptedRecovery: null, successorEpisode: null, releaseOperationId: null, startedAt, endedAt: null } as const]), activeEpisode: 0 });
}

export function emptyRepairPlan(lastGoodSequence = 0): RepairPlan {
  controlInteger(lastGoodSequence);
  return Object.freeze({ lastGoodSequence, affected: Object.freeze([]), cursorTo: null, rejectedRecord: null, lostOperations: Object.freeze([]), publishedVersions: null, retiredRecords: Object.freeze([]),
    handoffs: Object.freeze([]), correctionId: null, inheritedRecovery: null, skippedRanges: Object.freeze([]) });
}
