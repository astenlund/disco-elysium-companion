import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handoffFor } from '../../src/backend/recovery.ts';
import type { HandoffIdentity } from '../../src/backend/handoffs.ts';
import { parseStrictJson, stringifyJson } from '../../src/json.ts';
import { coreAttemptToken, parseOperation, type RepairOperation } from '../../src/operation-records.ts';
import { bindRecoveryEvent, checkpointRecovery, completeRecovery, selectRecoveryRecord } from '../../src/recovery-progress.ts';
import { at, generation, repair } from '../backend/authority-fixtures.ts';
import { journalEvent } from './journal-event.ts';

const scriptPath = fileURLToPath(import.meta.url);
const scriptName = path.basename(scriptPath, '.ts');
export interface HandoffDigestVectors {
  readonly empty: { readonly retainedHandoffs: number; readonly sha256: string };
  readonly nonempty: { readonly retainedHandoffs: number; readonly sha256: string };
  readonly identities: readonly HandoffIdentity[];
}

export async function loadHandoffDigestVectors(): Promise<HandoffDigestVectors> {
  return JSON.parse(await fs.readFile(new URL('./handoff-digest-vectors.json', import.meta.url), 'utf8')) as HandoffDigestVectors;
}

// Reuse the admitted control constructors and real recovery transitions. The
// native test reuses its existing private root and supplies its exact scope hash.
export async function handoffDigestOperations(scopeSha256: string): Promise<readonly RepairOperation[]> {
  const vectors = await loadHandoffDigestVectors();
  const handoffs = vectors.identities.map((identity, index) => handoffFor(journalEvent(index + 1, { ...identity, adapter: 'test', principal: 'test',
    occurredAt: at, stateGeneratedAt: at, acceptance: { journalId: 'journal', eventId: (index + 1).toString(16).padStart(32, '0'), generation } })));
  const template = repair();
  return [0, 1].map(index => {
    const operationId = 'jr-' + (index + 1).toString(16).padStart(32, '0');
    const initial = repair({ operationId, cause: 'header', plan: { ...template.plan, handoffs: index === 0 ? handoffs : [...handoffs].reverse(),
      correctionId: null, publishedVersions: { schemaVersion: 2, adapterVersion: 1 } },
      recovery: { ...template.recovery, episodes: template.recovery.episodes.map(episode => ({ ...episode, activationId: String(index + 5).repeat(32) })) } });
    const event = journalEvent(index + 1, { adapter: 'test', principal: 'test', type: 'state.resync', occurredAt: at, stateGeneratedAt: at,
      logicalOutboxId: 'e'.repeat(32) + '-' + (index + 1), coreRepairOperationId: coreAttemptToken(operationId, 0), attemptRef: { operationId, attemptOrdinal: 0 },
      acceptance: { journalId: 'journal', eventId: (index + 1).toString(16).padStart(32, '0'), generation } });
    const selected = selectRecoveryRecord(initial, { logicalOutboxId: event.logicalOutboxId, recordSha256: event.recordSha256 }, 'observed', null);
    const completed = completeRecovery(checkpointRecovery(bindRecoveryEvent(selected, event), event, generation, 1, at), event.journalId, generation, at);
    const parsed = parseOperation(parseStrictJson(Buffer.from(stringifyJson({ ...completed, scopeSha256 }, 'state-event')), 'state-event'), scopeSha256);
    if (parsed.compacted || parsed.kind !== 'repair') { throw new Error(scriptName + ': expected a full repair record'); }
    return parsed;
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  const scopeSha256 = process.argv[2];
  if (scopeSha256 === undefined || process.argv.length !== 3) { throw new Error(scriptName + ': expected the private scope SHA-256'); }
  process.stdout.write(stringifyJson({ operations: await handoffDigestOperations(scopeSha256) }, 'state-event') + '\n');
}
