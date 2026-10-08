import { controlUtc, requireControl } from './control-values.ts';
import type { EventDescription } from './journal-records.ts';

export interface RetentionEvidence { readonly state: 'unavailable' | 'protected' | 'resolved'; readonly path: 'acknowledged' | 'skipDischarged' | null; readonly resolvedAt: string | null }
export interface RetainedEvent { readonly event: EventDescription; readonly sha256: string; readonly evidence: RetentionEvidence }
export interface RetentionSelection { readonly compact: readonly RetainedEvent[]; readonly remainingFull: number; readonly overCapacity: boolean }
const ticksPerDay = 864000000000n;

export function utcTicks(value: string): bigint {
  controlUtc(value);
  return BigInt(Date.parse(value.slice(0, 23) + 'Z')) * 10000n + BigInt(value.slice(23, 27));
}

// Eligibility evidence is produced by complete safety/reference reconciliation.
// This selector never stamps an acknowledgement or removes historical evidence.
export function selectJournalRetention(entries: readonly RetainedEvent[], now: string, inventoryComplete: boolean): RetentionSelection {
  requireControl(inventoryComplete);
  const current = utcTicks(now);
  const full = entries.filter(entry => !entry.event.compacted);
  const identities = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.event.journalId, entry.event.eventId]);
    requireControl(!identities.has(key));
    identities.add(key);
    requireControl(entry.evidence.state !== 'unavailable');
  }
  const eligible = full.flatMap(entry => {
    const { event, evidence } = entry;
    if (evidence.state !== 'resolved' || evidence.resolvedAt === null || evidence.path === null || event.settlement === 'unknown' && event.acceptance === null) { return []; }
    if (evidence.path === 'acknowledged' && (event.acknowledgedAt === null || event.acceptance === null || event.settlement === 'pending')) { return []; }
    const resolved = utcTicks(evidence.resolvedAt);
    const occurred = utcTicks(event.occurredAt);
    const acknowledged = event.acknowledgedAt === null ? occurred : utcTicks(event.acknowledgedAt);
    const origin = [resolved, occurred, acknowledged].reduce((left, right) => left > right ? left : right);
    return [{ entry, origin, identity: JSON.stringify([event.journalId, event.eventId]) }];
  }).sort((left, right) => left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  const selected = new Set<RetainedEvent>();
  for (const item of eligible) { if (current >= item.origin + 180n * ticksPerDay) { selected.add(item.entry); } }
  for (const item of eligible) {
    if (full.length - selected.size <= 8192) { break; }
    selected.add(item.entry);
  }
  const remainingFull = full.length - selected.size;
  return Object.freeze({ compact: Object.freeze(eligible.filter(item => selected.has(item.entry)).map(item => item.entry)), remainingFull, overCapacity: remainingFull > 8192 });
}
