import type { PathInspector } from '../../src/admission.ts';
import type { PayloadCodec } from '../../src/codec.ts';
import type { FilePublisher } from '../../src/files.ts';
import { Journal } from '../../src/journal.ts';

/** A journal over a data root that may only be read: every mutation hook throws. */
export function readOnlyJournal(root: string, inspector: PathInspector): Journal {
  return new Journal({ root, game: 'game', principal: 'principal', identities: { runtimeInstanceId: '1'.repeat(32), runtimeSessionId: '2'.repeat(32), adapterBindingEpoch: '3'.repeat(32) },
    inspector, publisher: {} as FilePublisher, codec: {} as PayloadCodec, admitMutation: async () => { throw new Error('unexpected mutation'); }, eventIdAvailable: async () => { throw new Error('unexpected mutation'); } });
}
