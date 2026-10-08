import type { CoreResult, PublishReceipt } from '../core-client.ts';
import type { JournalEvent, JournalSnapshot } from '../journal.ts';
import { Deadline } from '../deadline.ts';
import { SafetyUnavailableError } from '../safety-records.ts';

export function newestState(snapshot: JournalSnapshot): JournalEvent | null {
  let newest: JournalEvent | null = null;
  for (const event of snapshot.events.values()) {
    if (!event.metadata.compacted && (newest === null || event.metadata.sequence > newest.metadata.sequence)) { newest = event; }
  }
  return newest;
}

export function needsRequiredSnapshot(result: CoreResult<PublishReceipt>, game: string, latest: JournalEvent | null): boolean {
  return result.success && result.value.game === game && result.value.outcome === 'unchanged'
    && result.value.targetIdentitySha256 !== (latest?.metadata.targetIdentitySha256 ?? null);
}

export interface AcquisitionPort {
  readonly game: string;
  readonly fault: () => string | null;
  readonly readJournal: () => Promise<JournalSnapshot>;
  readonly publish: (requireRecord: boolean, acquisitionDeadline: Deadline, afterChild: (result: CoreResult<PublishReceipt> | null, terminatedAt: number | null) => Deadline) => Promise<CoreResult<PublishReceipt>>;
  readonly onGate?: (gate: Deadline) => void;
}
export interface AcquisitionOutcome { readonly receipt: CoreResult<PublishReceipt> | null; readonly gate: Deadline; readonly skippedFault: string | null }

export async function acquireWithPolicy(port: AcquisitionPort): Promise<AcquisitionOutcome> {
  const fault = port.fault();
  if (fault !== null) {
    const gate = Deadline.after(120000); port.onGate?.(gate);
    return { receipt: null, gate, skippedFault: fault };
  }
  const before = await port.readJournal();
  if (before.fault !== null || before.damaged.length > 0) { throw new SafetyUnavailableError('Journal damage forbids acquisition.'); }
  const retained = newestState(before);
  const acquisitionDeadline = Deadline.after(3600000);
  let gate: Deadline | null = null;
  let lastEndedAt: number | null = null;
  let considerSnapshot = false;
  const establishGate = (endedAt: number): Deadline => {
    gate = Deadline.fromStart(endedAt, 120000); port.onGate?.(gate);
    return gate;
  };
  try {
    let receipt = await port.publish(retained === null, acquisitionDeadline, (result, terminatedAt) => {
      if (terminatedAt === null) { return acquisitionDeadline; }
      lastEndedAt = terminatedAt;
      considerSnapshot = result !== null && needsRequiredSnapshot(result, port.game, retained);
      return considerSnapshot ? acquisitionDeadline : establishGate(lastEndedAt);
    });
    if (considerSnapshot) {
      const actual = await port.readJournal();
      if (actual.fault !== null || actual.damaged.length > 0) { throw new SafetyUnavailableError('Journal damage forbids the required snapshot acquisition.'); }
      if (port.fault() === null && needsRequiredSnapshot(receipt, port.game, newestState(actual))) {
        receipt = await port.publish(true, Deadline.after(3600000), (_, terminatedAt) => {
          if (terminatedAt === null) { return acquisitionDeadline; }
          lastEndedAt = terminatedAt;
          return establishGate(lastEndedAt);
        });
      } else {
        if (lastEndedAt === null) { throw new SafetyUnavailableError('Acquisition termination is unavailable.'); }
        establishGate(lastEndedAt);
      }
    }
    if (gate === null) { throw new SafetyUnavailableError('Acquisition did not establish its termination boundary.'); }
    return { receipt, gate, skippedFault: null };
  } catch (error) {
    if (gate === null && lastEndedAt !== null) { establishGate(lastEndedAt); }
    throw error;
  }
}
