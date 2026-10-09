import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector } from './admission.ts';
import { ControlDocumentError } from './control-values.ts';
import { Deadline } from './deadline.ts';
import { readFileHashes } from './file-hashes.ts';
import { observeFile } from './file-observation.ts';
import { FilePublisher } from './files.ts';
import type { InstanceGuard } from './guard.ts';
import { JournalDocumentError } from './journal-records.ts';
import { isLowerHex, jsonBudgets, parseStrictJson, readBoundedFile, stringifyProspectiveJson, StrictJsonError, type JsonProfile, type JsonValue, type ProspectiveJsonFailure } from './json.ts';
import { SafetyUnavailableError } from './safety-records.ts';
import type { RuntimeScope } from './scope.ts';
import { SerialQueue } from './serial.ts';

export type StoredDocument<T> = { readonly status: 'absent' } | { readonly status: 'invalid'; readonly sha256: string | null } | { readonly status: 'valid'; readonly sha256: string; readonly value: T };
export interface StorageOptions { readonly scope: RuntimeScope; readonly guard: Pick<InstanceGuard, 'held'>; readonly inspector: PathInspector; readonly publisher: FilePublisher; readonly prospectiveFailure?: ProspectiveJsonFailure; readonly bind?: <T>(action: () => Promise<T>) => () => Promise<T>; readonly beforeWrite?: (relative: string, deadline?: Deadline) => Promise<void> }
export const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class StorageConflictError extends Error { override readonly name = 'StorageConflictError'; }

export class ScopeStorage {
  readonly scope: RuntimeScope;
  private readonly options: StorageOptions;
  private readonly queue = new SerialQueue();

  constructor(options: StorageOptions) { this.options = options; this.scope = options.scope; }
  idle(): Promise<void> { return this.queue.idle(); }
  private queued<T>(action: () => Promise<T>): Promise<T> { return this.queue.run(this.options.bind?.(action) ?? action); }

  private owned(): void { if (!this.options.guard.held) { throw new DataRootUnavailableError('Runtime storage has no writer ownership.'); } }

  private async admit(relative: string, allowMissing: boolean, deadline?: Deadline) {
    const target = path.resolve(this.scope.dataRoot, relative);
    const binding = path.join(this.scope.dataRoot, 'scope.json');
    const observed = await this.options.inspector.inspectMany(this.scope.dataRoot, [binding, target], allowMissing, deadline?.remaining());
    if (observed[0]!.kind !== 'file' || bytesHash(await readBoundedFile(binding, jsonBudgets.config.maxBytes)) !== this.scope.bindingSha256) {
      throw new DataRootUnavailableError('Immutable scope authority changed.');
    }
    deadline?.check();
    return observed[1]!;
  }

  ensureDirectory(relative: string, deadline?: Deadline): Promise<void> {
    return this.queued(async () => {
      this.owned();
      deadline?.check();
      const components = relative.replaceAll(path.win32.sep, '/').split('/');
      if (components.some(part => part.length === 0 || part === '.' || part === '..')) { throw new DataRootUnavailableError('Directory path is not an owned relative path.'); }
      let current = '';
      for (const component of components) {
        current = path.join(current, component);
        const observed = await this.admit(current, true, deadline);
        this.owned();
        if (!observed.exists) {
          if (observed.missing.length !== 1) { throw new DataRootUnavailableError('Directory parent is not admitted.'); }
          try { await fs.mkdir(observed.path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
        }
        if ((await this.admit(current, false, deadline)).kind !== 'directory') { throw new DataRootUnavailableError('Owned directory changed kind.'); }
      }
    });
  }

  read<T>(relative: string, profile: JsonProfile, parse: (value: JsonValue) => T, deadline = Deadline.after(30000)): Promise<StoredDocument<T>> {
    return this.queued(async () => {
      deadline.check();
      const target = await this.admit(relative, true, deadline);
      if (!target.exists) { return { status: 'absent' }; }
      if (target.kind !== 'file') { throw new DataRootUnavailableError('Owned document is not an ordinary file.'); }
      let bytes: Buffer | null = null;
      try {
        bytes = await readBoundedFile(target.path, jsonBudgets[profile].maxBytes);
        deadline.check();
        return { status: 'valid', sha256: bytesHash(bytes), value: parse(parseStrictJson(bytes, profile)) };
      } catch (error) {
        if (error instanceof StrictJsonError || error instanceof ControlDocumentError || error instanceof JournalDocumentError || error instanceof SafetyUnavailableError) {
          return { status: 'invalid', sha256: bytes === null ? (await observeFile(target.path, deadline)).sha256 : bytesHash(bytes) };
        }
        throw error;
      }
    });
  }

  readMany<T>(relatives: readonly string[], profile: JsonProfile, parse: (value: JsonValue, index: number) => T, deadline = Deadline.after(30000)): Promise<readonly StoredDocument<T>[]> {
    const targets = relatives.map(relative => path.resolve(this.scope.dataRoot, relative));
    return this.queued(async () => {
      deadline.check();
      const hashes = await readFileHashes(this.options.inspector, this.scope.dataRoot, targets, deadline, this.scope.bindingSha256);
      const results: StoredDocument<T>[] = [];
      for (const [index, target] of targets.entries()) {
        deadline.check();
        const expected = hashes[index]!;
        if (expected === null) { results.push({ status: 'absent' }); continue; }
        let bytes: Buffer | null = null;
        try {
          bytes = await readBoundedFile(target, jsonBudgets[profile].maxBytes);
          deadline.check();
          if (bytesHash(bytes) !== expected) { throw new StorageConflictError('Stored authority changed during batch observation.'); }
          const value = parse(parseStrictJson(bytes, profile), index);
          deadline.check();
          results.push({ status: 'valid', sha256: expected, value });
        } catch (error) {
          if (!(error instanceof StrictJsonError || error instanceof ControlDocumentError || error instanceof JournalDocumentError || error instanceof SafetyUnavailableError)) { throw error; }
          // A bounded-read refusal still preserves complete raw evidence, but never
          // grants an earlier hash to bytes that changed after native admission.
          if (bytes === null && (await observeFile(target, deadline)).sha256 !== expected) { throw new StorageConflictError('Stored invalid authority changed during batch observation.'); }
          deadline.check();
          results.push({ status: 'invalid', sha256: expected });
        }
      }
      if (targets.length > 0 && bytesHash(await readBoundedFile(path.join(this.scope.dataRoot, 'scope.json'), jsonBudgets.config.maxBytes)) !== this.scope.bindingSha256) {
        throw new DataRootUnavailableError('Immutable scope authority changed during batch reading.');
      }
      deadline.check();
      return results;
    });
  }

  async write(relative: string, value: unknown, profile: JsonProfile, expectedSha256: string | null, deadline = Deadline.after(30000)): Promise<string> {
    await this.options.beforeWrite?.(relative, deadline);
    const bytes = Buffer.from(stringifyProspectiveJson(value, profile, relative, this.options.prospectiveFailure), 'utf8');
    return this.queued(async () => {
      this.owned();
      deadline.check();
      const target = await this.admit(relative, true, deadline);
      if (target.exists) {
        if (target.kind !== 'file' || expectedSha256 === null || (await observeFile(target.path, deadline)).sha256 !== expectedSha256) { throw new StorageConflictError('Stored authority changed before publication.'); }
      } else if (expectedSha256 !== null) { throw new StorageConflictError('Stored authority disappeared before publication.'); }
      this.owned();
      deadline.check();
      const result = await this.options.publisher.publish(relative, bytes, profile, expectedSha256 === null, deadline);
      return result.sha256;
    });
  }

  // This derived index alone may be reconstructed from the durable current binding.
  // Safety, scope, journal and operation authority never use this replacement path.
  async replaceSessionIndex(value: unknown, bindingSha256: string, deadline?: Deadline): Promise<string> {
    await this.options.beforeWrite?.('agent-session-index.json', deadline);
    const bytes = Buffer.from(stringifyProspectiveJson(value, 'config', 'agent-session-index.json', this.options.prospectiveFailure), 'utf8');
    return this.queued(async () => {
      this.owned();
      deadline?.check();
      const target = await this.admit('agent-session-index.json', true, deadline);
      if (target.exists && target.kind !== 'file') { throw new DataRootUnavailableError('Session index has an unsupported object kind.'); }
      const binding = await this.admit('agent-session.json', false, deadline);
      if (binding.kind !== 'file' || !isLowerHex(bindingSha256, 64) || bytesHash(await readBoundedFile(binding.path, jsonBudgets.config.maxBytes)) !== bindingSha256) {
        throw new StorageConflictError('Current binding does not authorize index reconstruction.');
      }
      this.owned();
      deadline?.check();
      const result = await this.options.publisher.publish('agent-session-index.json', bytes, 'config', !target.exists, deadline);
      return result.sha256;
    });
  }

  list(relative: string, deadline?: Deadline): Promise<readonly string[]> {
    return this.queued(async () => {
      deadline?.check();
      const directory = await this.admit(relative, true, deadline);
      if (!directory.exists) { return []; }
      if (directory.kind !== 'directory') { throw new DataRootUnavailableError('Owned inventory is not a directory.'); }
      const names: string[] = [];
      for await (const entry of await fs.opendir(directory.path)) {
        deadline?.check();
        if (!entry.isFile()) { throw new DataRootUnavailableError('Inventory contains an unsupported object.'); }
        names.push(entry.name);
      }
      return names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    });
  }
}
