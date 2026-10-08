import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import type { Deadline } from './deadline.ts';
import { FilePublisher } from './files.ts';
import { newIdentity } from './identity.ts';
import { journalConsumerId } from './journal-records.ts';
import { utcNow } from './json.ts';
import { ScopeStorage } from './storage.ts';

// Only an absent or physically empty journal directory admits initial records.
// Header-only/cursor-only states remain visible to the prescribed repair protocol.
export async function initializeJournal(storage: ScopeStorage, inspector: PathInspector, publisher: FilePublisher, deadline?: Deadline): Promise<boolean> {
  const root = storage.scope.dataRoot;
  const journal = path.join(root, 'journal');
  await storage.ensureDirectory('journal', deadline);
  const admitted = await inspector.inspect(root, journal, true, deadline?.remaining());
  if (admitted.exists && admitted.kind !== 'directory') { throw new DataRootUnavailableError('Journal storage has an unsupported object kind.'); }
  const empty = !admitted.exists || (await fs.readdir(journal)).length === 0;
  if (empty) {
    const journalId = newIdentity();
    const createdAt = utcNow();
    await publisher.publishJson(path.join('journal', 'journal.json'), { journalVersion: 1, journalId, createdAt, highWaterSequence: 0, historyVerified: false }, true, deadline);
    await publisher.publishJson(path.join('journal', 'cursor-agent-session.json'), { cursorVersion: 1, journalId, consumerId: journalConsumerId,
      lastAckedSequence: 0, lastSentSequence: 0, lastAcceptedRevision: null, updatedAt: createdAt }, true, deadline);
  }
  await storage.ensureDirectory(path.join('journal', 'events'), deadline);
  return empty;
}
