import { createHash } from 'node:crypto';

import { isLowerHex } from './json.ts';

export type WindowVariant = 'ordinary' | 'override';
export type DeliveryShape = 1 | 2 | 3 | 4;
export interface WindowCandidate {
  readonly shape: DeliveryShape;
  readonly fingerprint: string;
  readonly bytes: number;
  readonly stateIncluded: boolean;
}
export interface WindowSummary {
  readonly variant: WindowVariant;
  readonly state: 'ready' | 'exhausted' | 'unavailable';
  readonly descendingFailures: number;
  readonly revalidationAvailable: boolean;
}
export interface WindowAttempt {
  readonly candidate: WindowCandidate;
  readonly revalidation: boolean;
  readonly disclosureOnly: boolean;
}
export class WindowRecoveryError extends Error {
  override readonly name = 'WindowRecoveryError';
  readonly code = 'providerError';
}

interface Episode {
  readonly text: string;
  nextShape: number;
  failures: number;
  failedCandidates: string[];
  failedBytes: number | null;
  failedRelevance: string | null;
  failedCompaction: number;
  revalidationAvailable: boolean;
  failedRevalidationCandidate: string | null;
  exhausted: boolean;
}
interface Variant { readonly configuration: string; episode: Episode | null }
interface ActiveAttempt {
  readonly ticket: WindowAttempt;
  readonly episode: Episode;
  readonly relevance: string;
  compaction: number;
  sent: boolean;
}

export function recoveryFingerprint(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    if (!part.isWellFormed()) { throw new WindowRecoveryError('Recovery identity is not valid Unicode.'); }
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }

  return hash.digest('hex');
}

// Advisory state only: no event, cursor, acceptance, correction or transcript writes.
export class WindowRecovery {
  private logicalSession: string;
  private providerInstance: string | null = null;
  private ordinary: Variant;
  private override: Variant | null;
  private selected: WindowVariant | null = null;
  private active: ActiveAttempt | null = null;
  private compaction = 0;
  private unavailable = false;

  constructor(logicalSession: string, ordinaryConfiguration: string, overrideConfiguration: string | null) {
    this.logicalSession = logicalSession;
    this.ordinary = { configuration: ordinaryConfiguration, episode: null };
    this.override = overrideConfiguration === null ? null : overrideConfiguration === ordinaryConfiguration ? this.ordinary : { configuration: overrideConfiguration, episode: null };
    this.requireFingerprint(ordinaryConfiguration);
    if (overrideConfiguration !== null) { this.requireFingerprint(overrideConfiguration); }
  }

  private fail(message: string): never {
    this.unavailable = true;
    throw new WindowRecoveryError(message);
  }

  private requireFingerprint(value: string): void {
    if (!isLowerHex(value, 64)) { this.fail('Invalid recovery fingerprint.'); }
  }

  private variant(name: WindowVariant): Variant {
    if (name === 'ordinary') { return this.ordinary; }
    if (this.override === null) { return this.fail('Question override is unavailable.'); }

    return this.override;
  }

  private episode(): Episode {
    if (this.unavailable) { throw new WindowRecoveryError('Window recovery is unavailable.'); }
    if (this.selected === null) { return this.fail('No recovery episode is selected.'); }
    const episode = this.variant(this.selected).episode;
    if (episode === null || episode.failures < 0 || episode.failures > 4 || episode.failedCandidates.length !== episode.failures || episode.nextShape < 1 || episode.nextShape > 5) {
      return this.fail('Inconsistent window recovery metadata.');
    }

    return episode;
  }

  configure(ordinaryConfiguration: string, overrideConfiguration: string | null): void {
    if (this.unavailable) { throw new WindowRecoveryError('Window recovery is unavailable.'); }
    if (this.active !== null) { this.fail('Cannot change configuration during an attempt.'); }
    this.requireFingerprint(ordinaryConfiguration);
    if (overrideConfiguration !== null) { this.requireFingerprint(overrideConfiguration); }
    if (this.ordinary.configuration !== ordinaryConfiguration) { this.ordinary = { configuration: ordinaryConfiguration, episode: null }; }
    this.override = overrideConfiguration === null ? null : overrideConfiguration === ordinaryConfiguration ? this.ordinary : this.override?.configuration === overrideConfiguration ? this.override : { configuration: overrideConfiguration, episode: null };
    this.selected = null;
  }

  bind(logicalSession: string, providerInstance: string): void {
    if (logicalSession !== this.logicalSession) {
      this.active = null;
      this.logicalSession = logicalSession;
      this.ordinary.episode = null;
      if (this.override !== null) { this.override.episode = null; }
      this.selected = null;
      this.compaction = 0;
      this.unavailable = false;
    }
    if (providerInstance !== this.providerInstance) { this.active = null; }
    this.providerInstance = providerInstance;
  }

  select(variant: WindowVariant, text: string): void {
    if (this.unavailable) { throw new WindowRecoveryError('Window recovery is unavailable.'); }
    if (this.active !== null) { this.fail('An attempt is already active.'); }
    const slot = this.variant(variant);
    const fingerprint = recoveryFingerprint(text);
    if (slot.episode?.text !== fingerprint) {
      slot.episode = { text: fingerprint, nextShape: 1, failures: 0, failedCandidates: [], failedBytes: null, failedRelevance: null, failedCompaction: this.compaction, revalidationAvailable: true, failedRevalidationCandidate: null, exhausted: false };
    }
    this.selected = variant;
  }

  compacted(providerInstance: string): void {
    if (providerInstance !== this.providerInstance) { return; }
    if (this.compaction === Number.MAX_SAFE_INTEGER) { this.fail('Compaction observation counter exhausted.'); }
    this.compaction += 1;
  }

  get halfPrefixBytes(): number | null {
    const bytes = this.episode().failedBytes;

    return bytes === null ? null : Math.floor(bytes / 2);
  }

  prepare(candidates: readonly WindowCandidate[], relevance: string, disclosureOnly = false): WindowAttempt | null {
    const episode = this.episode();
    this.requireFingerprint(relevance);
    if (this.active !== null || this.providerInstance === null) { this.fail('Provider is unavailable or an attempt is active.'); }
    if (typeof disclosureOnly !== 'boolean') { this.fail('Invalid disclosure classification.'); }
    let previousShape = 0;
    for (const candidate of candidates) {
      this.requireFingerprint(candidate.fingerprint);
      if (!Number.isInteger(candidate.shape) || candidate.shape <= previousShape || candidate.shape > 4 || !Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0 || candidate.bytes > 4_194_304 || typeof candidate.stateIncluded !== 'boolean') {
        this.fail('Invalid candidate selection.');
      }
      previousShape = candidate.shape;
    }
    let candidate: WindowCandidate | undefined;
    let revalidation = false;
    if (disclosureOnly) {
      if (candidates.length !== 1 || candidates[0]!.stateIncluded) { return this.fail('Invalid disclosure candidate.'); }
      const disclosure = candidates[0]!;
      if (episode.exhausted || episode.failures >= 4 || episode.failedCandidates.includes(disclosure.fingerprint) || disclosure.fingerprint === episode.failedRevalidationCandidate) { return null; }
      candidate = disclosure;
    } else {
      const changedHistory = this.compaction > episode.failedCompaction;
      const changedContent = relevance !== episode.failedRelevance;
      const stateCandidate = candidates.find(item => item.stateIncluded && (changedHistory || item.fingerprint !== episode.failedCandidates.at(-1)));
      revalidation = episode.failures > 0 && episode.revalidationAvailable && (changedHistory || changedContent) && stateCandidate !== undefined;
      candidate = revalidation ? stateCandidate : undefined;
      if (candidate === undefined && !episode.exhausted && episode.failures < 4) {
        candidate = candidates.find(item => item.shape >= episode.nextShape && !episode.failedCandidates.includes(item.fingerprint) && item.fingerprint !== episode.failedRevalidationCandidate && (episode.failedBytes === null || item.bytes < episode.failedBytes));
        if (candidate !== undefined) { episode.nextShape = candidate.shape; }
      }
      if (candidate === undefined) {
        if (episode.failures === 0) { return this.fail('No admissible initial context candidate.'); }
        episode.exhausted = true;
        episode.nextShape = 5;

        return null;
      }
    }
    const ticket = Object.freeze({ candidate: Object.freeze({ ...candidate }), revalidation, disclosureOnly });
    this.active = { ticket, episode, relevance, compaction: this.compaction, sent: false };

    return ticket;
  }

  sent(ticket: WindowAttempt, providerInstance: string): void {
    if (this.active?.ticket !== ticket || this.active.sent || providerInstance !== this.providerInstance || this.unavailable) {
      this.fail('Stale or duplicate provider send.');
    }
    this.active.sent = true;
    this.active.compaction = this.compaction;
    if (ticket.revalidation) { this.active.episode.revalidationAvailable = false; }
  }

  cancelBeforeSend(ticket: WindowAttempt): void {
    if (this.active?.ticket !== ticket) { return; }
    if (this.active.sent) { this.fail('A sent attempt cannot be cancelled as unsent.'); }
    this.active = null;
  }

  finished(ticket: WindowAttempt, providerInstance: string, outcome: 'contextExhausted' | 'success' | 'otherFailure'): boolean {
    if (this.active?.ticket !== ticket || providerInstance !== this.providerInstance) { return false; }
    if (!this.active.sent || this.unavailable) { this.fail('Terminal result has no admitted send.'); }
    const attempt = this.active;
    this.active = null;
    if (outcome === 'contextExhausted' && ticket.revalidation) { attempt.episode.failedRevalidationCandidate = ticket.candidate.fingerprint; }
    if (outcome === 'contextExhausted' && !ticket.revalidation) {
      const episode = attempt.episode;
      episode.failures += 1;
      episode.failedCandidates.push(ticket.candidate.fingerprint);
      if (!ticket.disclosureOnly) {
        episode.failedBytes = ticket.candidate.bytes;
        episode.failedRelevance = attempt.relevance;
        episode.failedCompaction = attempt.compaction;
        episode.nextShape = ticket.candidate.shape + 1;
      }
      episode.exhausted = episode.nextShape > 4 || episode.failures >= 4;
    }

    return true;
  }

  summary(): WindowSummary | null {
    if (this.selected === null) { return null; }
    const episode = this.variant(this.selected).episode;
    if (episode === null) { return null; }

    return { variant: this.selected, state: this.unavailable ? 'unavailable' : episode.exhausted ? 'exhausted' : 'ready', descendingFailures: episode.failures, revalidationAvailable: episode.revalidationAvailable };
  }
}
