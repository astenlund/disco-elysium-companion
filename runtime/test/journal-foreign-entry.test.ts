import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PathAdmission, PathInspector } from '../src/admission.ts';
import { RuntimeCapacityError } from '../src/capacity.ts';
import { type Journal, JournalForeignEntryError, journalFailureReason, JournalUnavailableError } from '../src/journal.ts';
import { readOnlyJournal } from './support/journal.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A journal over a scratch data root whose events folder holds one extra entry; the header and cursor are absent. */
async function journalWith(entry: string, directory: boolean): Promise<{ journal: Journal; scratch: string }> {
  const scratch = await fs.mkdtemp(path.join(repository, '.tmp', 'journal-foreign-entry-'));
  const events = path.join(scratch, 'journal', 'events');
  await fs.mkdir(events, { recursive: true });
  if (directory) { await fs.mkdir(path.join(events, entry)); } else { await fs.writeFile(path.join(events, entry), '{}'); }
  const admission = (target: string): PathAdmission => target === events
    ? { path: target, exists: true, kind: 'directory', links: 1, volume: 'v', identity: 'i', missing: [] }
    : { path: target, exists: false, kind: null, links: null, volume: null, identity: null, missing: [target] };
  const inspector = { inspectMany: async (_root: string, targets: readonly string[]) => targets.map(admission) };

  return { journal: readOnlyJournal(scratch, inspector as unknown as PathInspector), scratch };
}

describe('foreign journal events entries', () => {
  for (const [name, entry, directory] of [['a file that is not an event', 'notes.txt', false], ['a folder with an event name', '0000000000000001.json', true]] as const) {
    it(`reports ${name} as a foreign entry that keeps the journal unavailable`, async () => {
      // Arrange
      const { journal, scratch } = await journalWith(entry, directory);
      try {
        // Act
        const failure = await journal.read().then(() => null, (error: unknown) => error);

        // Assert
        assert.ok(failure instanceof JournalForeignEntryError, String(failure));
        assert.ok(failure instanceof JournalUnavailableError);
        assert.equal(failure.message.includes(entry), false);
        assert.equal(journalFailureReason(failure), 'journalForeignEntry');
      } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    });
  }

  it('keeps a publication sibling of an event as generic unavailability, since the runtime owns that residue', async () => {
    // Arrange
    const { journal, scratch } = await journalWith(`0000000000000001.json.${'a'.repeat(32)}.tmp`, false);
    try {
      // Act
      const failure = await journal.read().then(() => null, (error: unknown) => error);

      // Assert
      assert.ok(failure instanceof JournalUnavailableError, String(failure));
      assert.equal(failure instanceof JournalForeignEntryError, false);
      assert.equal(journalFailureReason(failure), 'journalUnavailable');
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  });

  it('finds a foreign entry through the causes a capacity refusal wraps, and nothing else', () => {
    const foreign = new JournalForeignEntryError('fixture');
    const wrapped = new RuntimeCapacityError({ admitted: false, state: 'unavailable', dimensions: ['otherAuthority'] }, 'ordinary', { cause: new Error('outer', { cause: foreign }) });
    assert.equal(journalFailureReason(wrapped), 'journalForeignEntry');
    assert.equal(journalFailureReason(new JournalUnavailableError('fixture')), 'journalUnavailable');
    assert.equal(journalFailureReason('not an error'), 'journalUnavailable');
  });
});
