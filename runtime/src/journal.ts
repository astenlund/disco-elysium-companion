import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { PathInspector, type PathAdmission } from './admission.ts';
import { Deadline } from './deadline.ts';
import { PayloadCodec, type SourceInspectionReceipt } from './codec.ts';
import { EventReader, type EventRead } from './event-reader.ts';
import { FilePublisher } from './files.ts';
import { isOpaqueToken, newIdentity, type ProcessIdentities } from './identity.ts';
import { acknowledgementPrefix, eventFileName, eventFileSequence, eventRewriteMetadata, JournalDocumentError, logicalOutboxSequence, parseEventDescription, parseJournalCursor, parseJournalHeader, type EventDescription, type EventMetadata, type JournalCursor, type JournalHeader } from './journal-records.ts';
import { asInt64, asInteger, isLowerHex, jsonBudgets, parseStrictJson, readBoundedFile, StrictJsonError, utcNow } from './json.ts';
import { SerialQueue } from './serial.ts';

type ControlRead<T> = { readonly status: 'absent' | 'invalid' } | { readonly status: 'valid'; readonly value: T; readonly sha256: string };
export interface JournalEvent { readonly metadata: EventDescription; readonly sha256: string }
export interface SequenceRange { readonly from: number; readonly to: number }
export interface JournalSnapshot {
  readonly header: ControlRead<JournalHeader>;
  readonly cursor: ControlRead<JournalCursor>;
  readonly events: ReadonlyMap<number, JournalEvent>;
  readonly damaged: readonly EventRead[];
  readonly historicalGaps: readonly SequenceRange[];
  readonly fault: 'header' | 'cursor' | 'gap' | null;
  readonly firstBadSequence: number | null;
  readonly unrecordedEvent: JournalEvent | null;
}

export interface JournalOptions {
  readonly root: string;
  readonly game: string;
  readonly principal: string;
  readonly identities: ProcessIdentities;
  readonly inspector: PathInspector;
  readonly publisher: FilePublisher;
  readonly codec: PayloadCodec;
  // The coordinator checks scope, safety, recovery and complete-transition capacity.
  readonly admitMutation: (kind: 'append' | 'highWater' | 'event' | 'acknowledge' | 'sent', snapshot: JournalSnapshot, deadline?: Deadline) => Promise<void>;
  // Includes operation handoffs and compact evidence, not just current event files.
  readonly eventIdAvailable: (eventId: string, snapshot: JournalSnapshot, deadline?: Deadline) => Promise<boolean>;
}

export interface JournalTransaction {
  snapshot(): JournalSnapshot;
  recoverHighWater(): Promise<JournalSnapshot>;
  append(source: Uint8Array, coreSequence: number, mint?: () => string, receipt?: SourceInspectionReceipt): Promise<JournalEvent>;
  rewrite(expected: JournalEvent, update: (current: EventDescription) => EventMetadata): Promise<JournalEvent>;
  acknowledge(sent: readonly EventDescription[], generation: string): Promise<readonly EventDescription[]>;
  markSent(sent: readonly EventDescription[], generation: string): Promise<void>;
}

const headerPath = path.join('journal', 'journal.json');
const cursorPath = path.join('journal', 'cursor-agent-session.json');
const eventsPath = path.join('journal', 'events');
const eventPath = (sequence: number): string => path.join(eventsPath, eventFileName(sequence));
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class JournalUnavailableError extends Error { override readonly name = 'JournalUnavailableError'; }
export class SentMarkPublicationError extends Error {
  override readonly name = 'SentMarkPublicationError';
  constructor(cause: unknown) { super('The best-effort sent mark could not be published.', { cause }); }
}

// Queue ownership spans each read/decision/write transition. Publication and native
// metadata have their own non-recursive queues; no cached view grants authority.
export class Journal {
  private readonly options: JournalOptions;
  private readonly reader: EventReader;
  private readonly queue = new SerialQueue();
  private epoch = 0;

  constructor(options: JournalOptions) {
    this.options = options;
    this.reader = new EventReader(options.root, options.inspector);
  }

  idle(): Promise<void> { return this.queue.idle(); }

  invalidate(): void { this.epoch++; this.reader.invalidate(); }

  read(deadline = Deadline.after(120000)): Promise<JournalSnapshot> { return this.queue.run(() => this.readStable(deadline)); }

  // The coordinator keeps its writer ownership for this complete unit of work.
  // Every mutation replaces the verified snapshot; a partial failure ends its use.
  // The view expires before the journal queue is released and cannot escape as authority.
  transact<T>(operation: (journal: JournalTransaction) => Promise<T>, deadline = Deadline.after(120000)): Promise<T> {
    return this.queue.run(async () => {
      const epoch = this.epoch;
      let snapshot = await this.readStable(deadline);
      const mutations = new SerialQueue();
      let accepting = true;
      let failed = false;
      let failure: unknown;
      const run = <R>(action: () => Promise<R>): Promise<R> => {
        if (!accepting) { return Promise.reject(new JournalUnavailableError('Journal transaction has ended.')); }
        const pending = mutations.run(async () => {
          if (failed || epoch !== this.epoch) { throw new JournalUnavailableError('Journal transaction has lost its verified snapshot.'); }
          try {
            deadline.check();
            const value = await action();
            if (epoch !== this.epoch) { throw new JournalUnavailableError('Journal transaction changed during mutation.'); }
            return value;
          }
          catch (error) { failed = true; failure = error; throw error; }
        });
        void pending.catch(() => {});
        return pending;
      };
      const view: JournalTransaction = Object.freeze({
        snapshot: () => {
          if (!accepting || failed || mutations.busy || epoch !== this.epoch) { throw new JournalUnavailableError('Journal snapshot is unavailable during or after mutation.'); }
          deadline?.check();
          return structuredClone(snapshot);
        },
        recoverHighWater: () => run(async () => { snapshot = await this.recoverFrom(snapshot, deadline); return structuredClone(snapshot); }),
        append: (source: Uint8Array, sequence: number, mint = newIdentity, receipt?: SourceInspectionReceipt) => {
          const frozen = Buffer.from(source);
          return run(async () => { const result = await this.appendFrom(snapshot, frozen, sequence, mint, deadline, receipt); snapshot = result.snapshot; return structuredClone(result.event); });
        },
        rewrite: (expected: JournalEvent, update: (current: EventDescription) => EventMetadata) => run(async () => {
          const event = await this.rewriteFrom(snapshot, expected, update, deadline);
          snapshot = { ...snapshot, events: new Map(snapshot.events).set(event.metadata.sequence, event) };
          return structuredClone(event);
        }),
        acknowledge: (sent: readonly EventDescription[], generation: string) => {
          const frozen = [...sent];
          return run(async () => { const result = await this.acknowledgeFrom(snapshot, frozen, generation, deadline); snapshot = result.snapshot; return structuredClone(result.prefix); });
        },
        markSent: (sent: readonly EventDescription[], generation: string) => {
          const frozen = structuredClone(sent);
          return run(async () => { snapshot = await this.markSentFrom(snapshot, frozen, generation, deadline); });
        },
      });
      let result: T | undefined;
      try { result = await operation(view); }
      catch (error) { failed = true; failure = error; }
      finally { accepting = false; await mutations.idle(); }
      if (failed) { this.invalidate(); throw failure; }
      if (epoch !== this.epoch) { throw new JournalUnavailableError('Journal transaction was invalidated before completion.'); }
      deadline?.check();
      return result as T;
    });
  }

  private async control<T>(relative: string, observed: PathAdmission, parse: (value: ReturnType<typeof parseStrictJson>) => T, deadline?: Deadline): Promise<ControlRead<T>> {
    const target = path.resolve(this.options.root, relative);
    if (!observed.exists) { return { status: 'absent' }; }
    if (observed.kind !== 'file') { throw new JournalUnavailableError('Journal control path is not a file.'); }
    try {
      const bytes = await readBoundedFile(target, jsonBudgets.config.maxBytes);
      deadline?.check();
      return { status: 'valid', value: parse(parseStrictJson(bytes)), sha256: digest(bytes) };
    }
    catch (error) {
      if (error instanceof StrictJsonError || error instanceof JournalDocumentError) { return { status: 'invalid' }; }
      throw error;
    }
  }

  private async inventory(observed: PathAdmission, deadline?: Deadline): Promise<readonly { path: string; sequence: number }[]> {
    const directory = path.resolve(this.options.root, eventsPath);
    if (!observed.exists) { return []; }
    if (observed.kind !== 'directory') { throw new JournalUnavailableError('Journal event directory is unavailable.'); }
    const entries: { path: string; sequence: number }[] = [];
    const stream = await fs.opendir(directory);
    for await (const entry of stream) {
      deadline?.check();
      const sequence = eventFileSequence(entry.name);
      if (sequence === null || !entry.isFile()) { throw new JournalUnavailableError('Journal inventory contains unresolved storage entries.'); }
      entries.push({ path: path.join(directory, entry.name), sequence });
    }
    entries.sort((left, right) => left.sequence - right.sequence);
    return entries;
  }

  private async readOnce(deadline?: Deadline): Promise<JournalSnapshot> {
    deadline?.check();
    const paths = [headerPath, cursorPath, eventsPath].map(relative => path.resolve(this.options.root, relative));
    const admitted = await this.options.inspector.inspectMany(this.options.root, paths, true, deadline?.remaining());
    const header = await this.control(headerPath, admitted[0]!, parseJournalHeader, deadline);
    const cursor = await this.control(cursorPath, admitted[1]!, parseJournalCursor, deadline);
    const inventory = await this.inventory(admitted[2]!, deadline);
    const events = new Map<number, JournalEvent>();
    const damaged: EventRead[] = [];
    const identities = new Set<string>();
    const outbox = new Set<string>();
    const results = await this.reader.readInventory(inventory, deadline);
    deadline?.check();
    for (const result of results) {
      if (result.status !== 'valid') { damaged.push(result); continue; }
      const event = result.metadata;
      if (header.status === 'valid' && event.journalId !== header.value.journalId || event.adapter !== this.options.game || event.principal !== this.options.principal
        || identities.has(event.eventId) || outbox.has(event.logicalOutboxId)) {
        damaged.push(result);
        continue;
      }
      identities.add(event.eventId);
      outbox.add(event.logicalOutboxId);
      events.set(event.sequence, { metadata: event, sha256: result.sha256 });
    }
    let fault: JournalSnapshot['fault'] = header.status !== 'valid' ? 'header' : cursor.status !== 'valid' || cursor.value.journalId !== header.value.journalId ? 'cursor' : null;
    let firstBadSequence: number | null = null;
    let unrecordedEvent: JournalEvent | null = null;
    const historicalGaps: SequenceRange[] = [];
    if (header.status === 'valid') {
      const highWater = header.value.highWaterSequence;
      const beyond = [...events.values()].filter(event => event.metadata.sequence > highWater);
      if (beyond.length === 1 && beyond[0]!.metadata.sequence === highWater + 1) { unrecordedEvent = beyond[0]!; }
      else if (beyond.length > 0 && fault === null) { fault = 'gap'; firstBadSequence = highWater + 1; }
      if (cursor.status === 'valid' && cursor.value.journalId === header.value.journalId) {
        const acked = cursor.value.lastAckedSequence;
        if (acked > highWater || cursor.value.lastSentSequence > highWater) { fault = 'cursor'; }
        let previous = 0;
        for (const sequence of events.keys()) {
          if (sequence > acked) { break; }
          if (sequence > previous + 1) { historicalGaps.push({ from: previous + 1, to: sequence - 1 }); }
          previous = sequence;
        }
        if (previous < acked) { historicalGaps.push({ from: previous + 1, to: acked }); }
        let expected = acked + 1;
        for (const [sequence, event] of events) {
          if (sequence <= acked || sequence > highWater) { continue; }
          if (sequence !== expected || event.metadata.compacted) { break; }
          expected++;
        }
        if (expected <= highWater && fault === null) { fault = 'gap'; firstBadSequence = expected; }
      }
    }
    return { header, cursor, events, damaged: Object.freeze(damaged), historicalGaps: Object.freeze(historicalGaps), fault, firstBadSequence, unrecordedEvent };
  }

  private async readStable(deadline?: Deadline): Promise<JournalSnapshot> {
    try {
      const first = await this.readOnce(deadline);
      // Readable damage gets one reread. Infrastructure failures propagate directly.
      return first.fault !== null || first.damaged.length > 0 || first.historicalGaps.length > 0 ? await this.readOnce(deadline) : first;
    } catch (error) { this.invalidate(); throw error; }
  }

  private requireHealthy(snapshot: JournalSnapshot): { header: JournalHeader; cursor: JournalCursor } {
    if (snapshot.fault !== null || snapshot.header.status !== 'valid' || snapshot.cursor.status !== 'valid' || snapshot.damaged.length > 0) {
      throw new JournalUnavailableError('Journal requires recovery before mutation.');
    }
    return { header: snapshot.header.value, cursor: snapshot.cursor.value };
  }

  recoverHighWater(deadline?: Deadline): Promise<JournalSnapshot> {
    return this.transact(journal => journal.recoverHighWater(), deadline);
  }

  private async recoverFrom(snapshot: JournalSnapshot, deadline?: Deadline): Promise<JournalSnapshot> {
    const { header } = this.requireHealthy(snapshot);
    if (snapshot.unrecordedEvent === null) { return snapshot; }
    await this.options.admitMutation('highWater', structuredClone(snapshot), deadline);
    const expected = snapshot.unrecordedEvent;
    const [reread] = await this.reader.read([{ path: eventPath(expected.metadata.sequence), sequence: expected.metadata.sequence }], deadline?.remaining());
    if (reread?.status !== 'valid' || reread.sha256 !== expected.sha256) { throw new JournalUnavailableError('Unrecorded event changed before high-water recovery.'); }
    const value = { ...header, highWaterSequence: expected.metadata.sequence };
    const publication = await this.options.publisher.publishJson(headerPath, value, false, deadline);
    return { ...snapshot, header: { status: 'valid', value, sha256: publication.sha256 }, unrecordedEvent: null };
  }

  append(sourceBytes: Uint8Array, expectedCoreSequence: number, mint = newIdentity, deadline?: Deadline): Promise<JournalEvent> {
    const frozen = Buffer.from(sourceBytes);
    return this.transact(journal => journal.append(frozen, expectedCoreSequence, mint), deadline);
  }

  private async appendFrom(snapshot: JournalSnapshot, frozen: Buffer, expectedCoreSequence: number, mint: () => string, deadline?: Deadline, receipt?: SourceInspectionReceipt): Promise<{ snapshot: JournalSnapshot; event: JournalEvent }> {
    const { header } = this.requireHealthy(snapshot);
    if (snapshot.unrecordedEvent !== null || header.highWaterSequence === Number.MAX_SAFE_INTEGER) { throw new JournalUnavailableError('Journal position is not available for append.'); }
    const source = receipt === undefined
      ? await this.options.codec.inspectSource(frozen, expectedCoreSequence, deadline)
      : this.options.codec.consumeSourceInspection(receipt, frozen, expectedCoreSequence, deadline);
    const control = source.metadata;
    if (control['game'] !== this.options.game || control['principal'] !== this.options.principal || !isOpaqueToken(control['logicalOutboxId']) || logicalOutboxSequence(control['logicalOutboxId']) !== expectedCoreSequence) {
      throw new JournalDocumentError('Source record is foreign or misidentified.');
    }
    const duplicate = [...snapshot.events.values()].find(event => event.metadata.logicalOutboxId === control['logicalOutboxId']);
    if (duplicate !== undefined) {
      // A new event gets fresh workspace and capacity admission in createEvent.
      // A duplicate has no create, so preserve the full inspection admission here.
      if (receipt !== undefined) { await this.options.codec.inspectSource(frozen, expectedCoreSequence, deadline); }
      if (duplicate.metadata.recordSha256 !== source.sha256) { throw new JournalDocumentError('Source record conflicts with its existing journal identity.'); }
      return { snapshot, event: duplicate };
    }
    await this.options.admitMutation('append', structuredClone(snapshot), deadline);
    let eventId: string | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = mint();
      if (!isLowerHex(candidate, 32)) { throw new JournalDocumentError('Event identity generator returned an invalid token.'); }
      if (![...snapshot.events.values()].some(event => event.metadata.eventId === candidate) && await this.options.eventIdAvailable(candidate, snapshot, deadline)) { eventId = candidate; break; }
    }
    if (eventId === null) { throw new JournalUnavailableError('Event identity retries exhausted without appending.'); }
    const schemaVersion = asInt64(control['schemaVersion']);
    const adapterVersion = asInt64(control['adapterVersion']);
    const kind = control['kind'];
    if (schemaVersion === undefined || adapterVersion === undefined || kind !== 'consumed' && kind !== 'snapshot' && kind !== 'resync') { throw new JournalDocumentError('Source control metadata is invalid.'); }
    const sequence = header.highWaterSequence + 1;
    const metadata: EventMetadata = {
      eventVersion: 1, journalId: header.journalId, sequence, eventId, type: `state.${kind}`, occurredAt: utcNow(),
      runtimeInstanceId: this.options.identities.runtimeInstanceId, adapter: this.options.game, adapterBindingEpoch: this.options.identities.adapterBindingEpoch,
      principal: this.options.principal, logicalOutboxId: control['logicalOutboxId'], recordSha256: source.sha256,
      coreRepairOperationId: kind === 'resync' ? control['repairOperationId'] as string : null, attemptRef: null,
      schemaVersion, adapterVersion, settlement: 'pending', acceptance: null, acknowledgedAt: null, compacted: false,
    };
    const appended = await this.options.codec.createEvent(eventPath(sequence), frozen, metadata, expectedCoreSequence, deadline);
    // A failure here leaves a complete bound event that recoverHighWater must verify.
    const headerValue = { ...header, highWaterSequence: sequence };
    const publication = await this.options.publisher.publishJson(headerPath, headerValue, false, deadline);
    const event = { sha256: appended.sha256, metadata: parseEventDescription(appended.metadata) };
    return { event, snapshot: { ...snapshot, header: { status: 'valid', value: headerValue, sha256: publication.sha256 }, events: new Map(snapshot.events).set(sequence, event) } };
  }

  rewrite(expected: JournalEvent, update: (current: EventDescription) => EventMetadata, deadline?: Deadline): Promise<JournalEvent> {
    return this.transact(journal => journal.rewrite(expected, update), deadline);
  }

  private async rewriteFrom(snapshot: JournalSnapshot, expected: JournalEvent, update: (current: EventDescription) => EventMetadata, deadline?: Deadline): Promise<JournalEvent> {
    this.requireHealthy(snapshot);
    await this.options.admitMutation('event', structuredClone(snapshot), deadline);
    const current = snapshot.events.get(expected.metadata.sequence);
    if (current === undefined || current.sha256 !== expected.sha256) { throw new JournalUnavailableError('Event changed before its update.'); }
    return this.rewriteCurrent(current, update(structuredClone(current.metadata)), deadline);
  }

  private async rewriteCurrent(current: JournalEvent, metadata: EventMetadata, deadline?: Deadline): Promise<JournalEvent> {
    const relative = eventPath(current.metadata.sequence);
    const target = path.resolve(this.options.root, relative);
    await this.options.inspector.inspect(this.options.root, target, false, deadline?.remaining());
    const bytes = await readBoundedFile(target, jsonBudgets['state-event'].maxBytes);
    if (digest(bytes) !== current.sha256) { throw new JournalUnavailableError('Event changed before its frozen read.'); }
    const result = await this.options.codec.rewriteEvent(relative, bytes, metadata, metadata.compacted, false, deadline);
    return { sha256: result.sha256, metadata: parseEventDescription(result.metadata) };
  }

  acknowledge(sent: readonly EventDescription[], generation: string, deadline?: Deadline): Promise<readonly EventDescription[]> {
    const frozen = [...sent];
    return this.transact(journal => journal.acknowledge(frozen, generation), deadline);
  }

  markSent(sent: readonly EventDescription[], generation: string, deadline?: Deadline): Promise<void> {
    const frozen = structuredClone(sent);
    return this.transact(journal => journal.markSent(frozen, generation), deadline);
  }

  private async markSentFrom(snapshot: JournalSnapshot, sent: readonly EventDescription[], generation: string, deadline?: Deadline): Promise<JournalSnapshot> {
    const { cursor } = this.requireHealthy(snapshot);
    const prefix = acknowledgementPrefix(cursor, sent, new Map([...snapshot.events].map(([sequence, entry]) => [sequence, entry.metadata])), generation);
    if (prefix.length !== sent.length) { throw new JournalUnavailableError('Sent events are not the current accepted prefix.'); }
    const highest = prefix.at(-1)?.sequence ?? cursor.lastSentSequence;
    if (highest <= cursor.lastSentSequence) { return snapshot; }
    await this.options.admitMutation('sent', structuredClone(snapshot), deadline);
    const value = { ...cursor, lastSentSequence: highest };
    const publication = await this.options.publisher.publishJson(cursorPath, value, false, deadline).catch((cause: unknown) => { throw new SentMarkPublicationError(cause); });
    return { ...snapshot, cursor: { status: 'valid', value, sha256: publication.sha256 } };
  }

  private async acknowledgeFrom(snapshot: JournalSnapshot, frozen: readonly EventDescription[], generation: string, deadline?: Deadline): Promise<{ snapshot: JournalSnapshot; prefix: readonly EventDescription[] }> {
    const { cursor } = this.requireHealthy(snapshot);
    await this.options.admitMutation('acknowledge', structuredClone(snapshot), deadline);
    const prefix = acknowledgementPrefix(cursor, frozen, new Map([...snapshot.events].map(([sequence, entry]) => [sequence, entry.metadata])), generation);
    if (prefix.length === 0) { return { snapshot, prefix }; }
    const updatedAt = utcNow();
    const cursorValue = { ...cursor, lastAckedSequence: prefix.at(-1)!.sequence, updatedAt };
    const publication = await this.options.publisher.publishJson(cursorPath, cursorValue, false, deadline);
    const events = new Map(snapshot.events);
    for (const event of prefix) {
      if (event.acknowledgedAt === null) {
        events.set(event.sequence, await this.rewriteCurrent(snapshot.events.get(event.sequence)!, { ...eventRewriteMetadata(event), acknowledgedAt: updatedAt }, deadline));
      }
    }
    return { prefix, snapshot: { ...snapshot, events, cursor: { status: 'valid', value: cursorValue, sha256: publication.sha256 } } };
  }
}
