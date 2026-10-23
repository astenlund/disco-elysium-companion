import { createHash } from 'node:crypto';
import path from 'node:path';

import { PathInspector } from './admission.ts';
import { PayloadCodec } from './codec.ts';
import { requireControl } from './control-values.ts';
import { FilePublisher, PublicationError } from './files.ts';
import { observeFile } from './file-observation.ts';
import { logicalOutboxSequence } from './journal-records.ts';
import { jsonBudgets, parseStrictJson, readBoundedFile, stringifyJson } from './json.ts';
import { SupervisorError } from './process.ts';
import { parseRecoveryAction, recognizeAction, type ManifestObservation, type PayloadSource, type RecoveryAction } from './recovery-manifest.ts';
import type { RuntimeScope } from './scope.ts';

export interface RecoveryExecutorOptions {
  readonly scope: RuntimeScope;
  readonly inspector: PathInspector;
  readonly publisher: FilePublisher;
  readonly codec: PayloadCodec;
  // Verifies the durable witness, owning manifest and complete transition reservation.
  readonly admit: (action: RecoveryAction) => Promise<void>;
  readonly authorizeMutation?: (action: RecoveryAction) => Promise<void>;
  readonly readPayloadSource: (source: PayloadSource) => Promise<Uint8Array>;
}

export class RecoveryDamageError extends Error { override readonly name = 'RecoveryDamageError'; }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// The coordinator holds its mutation queue across execute and the subsequent
// nextAction publication. Completed postimages survive a lost progress write.
export class RecoveryExecutor {
  private readonly options: RecoveryExecutorOptions;
  constructor(options: RecoveryExecutorOptions) { this.options = options; }

  private async observe(action: RecoveryAction): Promise<ReadonlyMap<string, ManifestObservation>> {
    const changes = action.kind === 'quarantine' ? [action.source, action.target] : [action.target];
    const root = this.options.scope.dataRoot;
    const paths = [path.join(root, 'scope.json'), ...changes.map(change => path.resolve(root, change.path))];
    const admitted = await this.options.inspector.inspectMany(root, paths, true);
    if (admitted[0]!.kind !== 'file' || hash(await readBoundedFile(paths[0]!, jsonBudgets.config.maxBytes)) !== this.options.scope.bindingSha256) {
      throw new PublicationError('Recovery scope binding is unavailable.', true);
    }
    const values = new Map<string, ManifestObservation>();
    for (const [index, change] of changes.entries()) {
      const observation = admitted[index + 1]!;
      if (!observation.exists) { values.set(change.path, { status: 'readable', sha256: null }); }
      else {
        if (observation.kind !== 'file') { throw new PublicationError('Recovery target changed object kind.', true); }
        values.set(change.path, { status: 'readable', sha256: (await observeFile(observation.path)).sha256 });
      }
    }
    return values;
  }

  async execute(input: RecoveryAction): Promise<'alreadyApplied' | 'applied'> {
    const action = parseRecoveryAction(parseStrictJson(Buffer.from(stringifyJson(input, 'state-event'), 'utf8'), 'state-event'));
    await this.options.admit(action);
    let condition = recognizeAction(action, await this.observe(action));
    if (condition === 'after') { return 'alreadyApplied'; }
    if (condition === 'damage') { condition = recognizeAction(action, await this.observe(action)); }
    if (condition === 'after') { return 'alreadyApplied'; }
    if (condition !== 'before') { throw new RecoveryDamageError('Recovery target does not match its planned preimage or postimage.'); }
    if (action.kind === 'quarantine' || action.kind === 'removeCarry') {
      await this.fileAction(action);
    } else if (action.kind === 'publishHeader' || action.kind === 'publishCursor' || action.kind === 'raiseHighWater') {
      await this.options.authorizeMutation?.(action);
      const bytes = Buffer.from(stringifyJson(action.value), 'utf8');
      requireControl(hash(bytes) === action.target.after);
      await this.options.publisher.publish(action.target.path, bytes, 'config', action.target.before === null);
    } else {
      await this.options.authorizeMutation?.(action);
      requireControl('metadata' in action);
      const source = Buffer.from(await this.options.readPayloadSource(action.source));
      requireControl(hash(source) === action.source.sha256);
      const sequence = logicalOutboxSequence(action.metadata.logicalOutboxId);
      requireControl(sequence !== null);
      const preview = await this.options.codec.previewEvent(action.target.path, source, action.metadata, action.source.root === 'companion' ? 'outbox' : 'event', action.source.payloadBindingSha256, action.source.root === 'companion' ? sequence : 0);
      requireControl(preview.sha256 === action.target.after && preview.cleanupComplete);
      if (action.source.root === 'companion') {
        await this.options.codec.reconstructEvent(action.target.path, source, action.metadata, sequence, action.source.payloadBindingSha256, action.target.before === null);
      } else {
        await this.options.codec.rewriteEvent(action.target.path, source, action.metadata, false, action.target.before === null);
      }
    }
    try {
      if (recognizeAction(action, await this.observe(action)) !== 'after') { throw new RecoveryDamageError('Recovery action postimage is not verified.'); }
    } catch (error) {
      if (!(error instanceof RecoveryDamageError)) { this.options.publisher.block(); }
      throw error;
    }
    return 'applied';
  }

  private fileAction(action: Extract<RecoveryAction, { kind: 'quarantine' | 'removeCarry' }>): Promise<void> {
    return this.options.publisher.exclusive(async options => {
      if (recognizeAction(action, await this.observe(action)) !== 'before') { throw new RecoveryDamageError('Recovery preimage changed before mutation.'); }
      await this.options.authorizeMutation?.(action);
      const source = action.kind === 'quarantine' ? action.source : action.target;
      const root = this.options.scope.dataRoot;
      const outcome = await this.options.publisher.runNativeMutation('fileAction', { root, action: action.kind === 'quarantine' ? 'Move' : 'Remove',
        source: path.resolve(root, source.path), sha256: source.before!, target: action.kind === 'quarantine' ? path.resolve(root, action.target.path) : null }, 30000);
      if (!outcome.ended) {
        this.options.publisher.block();
        throw new SupervisorError('termination-unverified', 'File action helper termination is unverified.', { cause: outcome.failure });
      }
      // An error reply or a lost one is settled below against both exact path postimages.
      try {
        if (recognizeAction(action, await this.observe(action)) !== 'after') { throw new RecoveryDamageError('Owned file action did not reach its postimage.'); }
      } catch (error) {
        options.invalidate(source.path);
        if (!(error instanceof RecoveryDamageError)) { this.options.publisher.block(); }
        throw error;
      }
    });
  }
}
