import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataRootUnavailableError, PathInspector, type PathAdmission } from './admission.ts';
import type { Deadline } from './deadline.ts';
import type { InstanceGuard } from './guard.ts';
import { hasExactKeys, jsonBudgets, parseStrictJson, readBoundedFile, stringifyJson, type JsonProfile } from './json.ts';
import { ProcessSupervisor, SupervisorError } from './process.ts';
import { SerialQueue } from './serial.ts';

export class PublicationError extends Error {
  override readonly name = 'PublicationError';
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export interface PublicationResult { readonly sha256: string; readonly cleanupComplete: boolean }
export interface PublicationOptions {
  readonly root: string;
  readonly guard: Pick<InstanceGuard, 'held'>;
  readonly inspector: PathInspector;
  readonly supervisor: ProcessSupervisor;
  readonly preflight: (target: string, bytes: Readonly<Uint8Array>, profile: JsonProfile, deadline?: Deadline) => Promise<void>;
  readonly invalidate: (target: string) => void;
}

const script = fileURLToPath(new URL('../scripts/Write-RuntimeFile.ps1', import.meta.url));
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// Callers reserve their complete transition; this queue checks its exact publication before staging.
export class FilePublisher {
  private readonly options: PublicationOptions;
  private readonly queue = new SerialQueue();
  private unavailable = false;

  constructor(options: PublicationOptions) { this.options = options; }

  get blocked(): boolean { return this.unavailable; }
  idle(): Promise<void> { return this.queue.idle(); }

  // Codec and ordinary publication share this owner and queue, including cleanup failure.
  exclusive<T>(operation: (options: PublicationOptions) => Promise<T>, deadline?: Deadline): Promise<T> {
    return this.queue.run(async () => {
      deadline?.check();
      this.requireOwnership();
      return operation(this.options);
    });
  }

  block(): void { this.unavailable = true; }
  assertAvailable(): void { this.requireOwnership(); }

  private requireOwnership(): void {
    if (!this.options.guard.held || this.unavailable) { throw new PublicationError('Publication ownership or workspace is unavailable.', true); }
  }

  publishJson(relative: string, value: unknown, createOnly = false, deadline?: Deadline): Promise<PublicationResult> {
    return this.publish(relative, Buffer.from(stringifyJson(value, 'config'), 'utf8'), 'config', createOnly, deadline);
  }

  publish(relative: string, data: Uint8Array, profile: JsonProfile, createOnly = false, deadline?: Deadline): Promise<PublicationResult> {
    if (data.byteLength > jsonBudgets[profile].maxBytes) { return Promise.reject(new PublicationError('Publication exceeds its byte budget.')); }
    const bytes = Buffer.from(data);

    return this.exclusive(async () => {
      this.requireOwnership();
      const target = path.resolve(this.options.root, relative);
      const input = `${target}.${randomBytes(16).toString('hex')}.tmp`;
      await this.options.inspector.inspectMany(this.options.root, [target, input], true, deadline?.remaining());
      await this.options.preflight(target, bytes, profile, deadline);
      this.requireOwnership();
      deadline?.check();
      const hash = digest(bytes);
      let inputCreated = false;
      let helperEnded = true;
      let completed = false;
      let cleanupComplete = false;
      let failure: unknown = null;
      let inputAdmission: PathAdmission | undefined;
      try {
        this.requireOwnership();
        deadline?.check();
        const handle = await fs.open(input, 'wx');
        inputCreated = true;
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        const args = ['-NoProfile', '-File', script, '-Root', this.options.root, '-Target', target, '-InputFile', input, '-Sha256', hash, '-Profile', profile, ...(createOnly ? ['-CreateOnly'] : [])];
        let reply: ReturnType<typeof parseStrictJson> | null = null;
        try {
          this.requireOwnership();
          const result = await this.options.supervisor.run('publication', { command: 'pwsh', args, cwd: this.options.root }, deadline?.remaining() ?? 30000);
          if (result.exitCode === 0) {
            try { reply = parseStrictJson(result.stdout); } catch { /* Exact target bytes decide a lost or malformed reply. */ }
          }
        } catch (error) {
          failure = error;
          if (error instanceof SupervisorError && error.reason === 'termination-unverified') { helperEnded = false; }
        }
        if (!helperEnded || !this.options.guard.held) {
          this.unavailable = true;
          throw new PublicationError('Publication cannot be reconciled while ownership is uncertain.', true);
        }
        try {
          // Exact-target reconciliation and cleanup remain mandatory after expiry.
          // Their result never grants a fresh settlement allowance to this caller.
          const observations = await this.options.inspector.inspectMany(this.options.root, [target, input], true);
          const observed = observations[0]!;
          inputAdmission = observations[1]!;
          if (observed.exists && observed.kind === 'file') {
            const actual = await readBoundedFile(observed.path, jsonBudgets[profile].maxBytes);
            completed = actual.length === bytes.length && digest(actual) === hash;
          }
        } catch {
          this.unavailable = true;
          throw new PublicationError('Published target cannot be read back.', true);
        }
        if (!completed) { throw new PublicationError(`Target does not contain the staged publication${failure instanceof Error ? ': ' + failure.message : '.'}`); }
        cleanupComplete = hasExactKeys(reply, ['published', 'sha256', 'cleanupComplete', 'retainedSiblings']) && reply['published'] === true && reply['sha256'] === hash && reply['cleanupComplete'] === true && Array.isArray(reply['retainedSiblings']) && reply['retainedSiblings'].length === 0;
        if (!cleanupComplete) { this.unavailable = true; }
      } catch (error) {
        this.options.invalidate(target);
        throw error;
      } finally {
        if (inputCreated && helperEnded && this.options.guard.held) {
          try {
            const observed = inputAdmission ?? await this.options.inspector.inspect(this.options.root, input, true);
            if (observed.exists) {
              if (observed.kind !== 'file' || digest(await readBoundedFile(input, jsonBudgets[profile].maxBytes)) !== hash) { throw new DataRootUnavailableError('Owned publication input changed.'); }
              await fs.unlink(input);
            }
          } catch {
            this.unavailable = true;
            cleanupComplete = false;
          }
        } else if (inputCreated) {
          this.unavailable = true;
          cleanupComplete = false;
        }
      }

      try { deadline?.check(); }
      catch (error) { this.options.invalidate(target); throw error; }
      return { sha256: hash, cleanupComplete };
    }, deadline);
  }
}
