import type { Deadline } from './deadline.ts';
import { controlHash, requireControl } from './control-values.ts';
import { newIdentity } from './identity.ts';
import { parseStrictJson, stringifyJson } from './json.ts';
import { freshGeneration, invalidatedSafety, isRepairOperationId, parseStateSafety, sameRecoveryOwner, SafetyUnavailableError, type Correction, type CorrectionReason, type RecoveryDisclosure, type RecoveryOwner, type StateSafety } from './safety-records.ts';
import { ScopeStorage, type StoredDocument } from './storage.ts';
import { SerialQueue } from './serial.ts';
import { consumeFreshScope } from './scope.ts';

export interface StoredSafety { readonly value: StateSafety; readonly sha256: string }
export interface SafetyOptions {
  readonly storage: ScopeStorage;
  readonly bindingGenerations: (deadline?: Deadline) => Promise<readonly string[]>;
  readonly suppressProvider: (reason: CorrectionReason) => void;
}
export interface SafetyProof { readonly verify: (current: StateSafety, deadline?: Deadline) => Promise<boolean> }

// Each clearing transition needs its own current durable proof. Missing or damaged
// authority is exposed to recovery; an I/O error is never rewritten as clean state.
export class SafetyStore {
  private readonly options: SafetyOptions;
  private readonly queue = new SerialQueue();
  private invalidationEpoch = 0;

  constructor(options: SafetyOptions) { this.options = options; }

  read(deadline?: Deadline): Promise<StoredDocument<StateSafety>> {
    return this.options.storage.read('state-safety.json', 'config', value => parseStateSafety(value, this.options.storage.scope.bindingSha256), deadline);
  }

  private async current(deadline?: Deadline): Promise<StoredSafety> {
    const current = await this.read(deadline);
    if (current.status !== 'valid') { throw new SafetyUnavailableError('Context safety requires recovery.'); }
    return { value: current.value, sha256: current.sha256 };
  }

  private async publish(value: StateSafety, expectedSha256: string | null, deadline?: Deadline): Promise<StoredSafety> {
    const validated = parseStateSafety(parseStrictJson(Buffer.from(stringifyJson(value), 'utf8')), this.options.storage.scope.bindingSha256);
    const sha256 = await this.options.storage.write('state-safety.json', validated, 'config', expectedSha256, deadline);
    return { value: validated, sha256 };
  }

  initializeNew(deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      requireControl(consumeFreshScope(this.options.storage.scope));
      const contents = await this.options.storage.list('.', deadline);
      requireControl(contents.every(name => name === 'scope.json' || name === 'runtime.json'));
      const current = await this.read(deadline);
      if (current.status === 'valid') { return { value: current.value, sha256: current.sha256 }; }
      requireControl(current.status === 'absent');
      const generations = await this.options.bindingGenerations(deadline);
      requireControl(generations.length === 0);
      return this.publish({ stateSafetyVersion: 1, generation: freshGeneration(null, []), pendingCheck: null, correction: null, recoveryWitness: null }, null, deadline);
    });
  }

  recoverUnknown(owner: RecoveryOwner, knownCorrection: Correction | null, proof: SafetyProof, deadline?: Deadline): Promise<StoredSafety> {
    this.invalidationEpoch++;
    this.options.suppressProvider(knownCorrection?.reason ?? 'contextUncertain');
    return this.queue.run(async () => {
      deadline?.check();
      const existing = await this.read(deadline);
      requireControl(existing.status !== 'valid' && (existing.status === 'absent' || existing.sha256 !== null));
      const correction: Correction = knownCorrection ?? { correctionId: newIdentity(), reason: 'contextUncertain', recoveryOperationId: null };
      const candidate: StateSafety = { stateSafetyVersion: 1, generation: freshGeneration(null, await this.options.bindingGenerations(deadline)), pendingCheck: null, correction,
        recoveryWitness: { scopeSha256: this.options.storage.scope.bindingSha256, owner, phase: 'preparing', successor: null, disclosure: null } };
      requireControl(await proof.verify(candidate, deadline));
      return this.publish(candidate, existing.status === 'absent' ? null : existing.sha256, deadline);
    });
  }

  armCheck(deadline?: Deadline): Promise<StoredSafety & { readonly checkToken: string }> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      if (current.value.pendingCheck !== null) { throw new SafetyUnavailableError('An earlier core observation must be reconciled first.'); }
      const checkToken = newIdentity();
      const written = await this.publish({ ...current.value, pendingCheck: checkToken }, current.sha256, deadline);
      return { ...written, checkToken };
    });
  }

  finishCheck(checkToken: string, proof: SafetyProof, deadline?: Deadline): Promise<boolean> {
    controlHash(checkToken, 32);
    const epoch = this.invalidationEpoch;
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      if (current.value.pendingCheck !== checkToken || !await proof.verify(current.value, deadline) || epoch !== this.invalidationEpoch) { return false; }
      await this.publish({ ...current.value, pendingCheck: null }, current.sha256, deadline);
      return true;
    });
  }

  invalidate(reason: CorrectionReason, deadline?: Deadline, obligationCorrectionId?: string): Promise<StoredSafety> {
    if (obligationCorrectionId !== undefined) { controlHash(obligationCorrectionId, 32); }
    this.invalidationEpoch++;
    this.options.suppressProvider(reason);
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const candidate = invalidatedSafety(current.value, reason, await this.options.bindingGenerations(deadline), newIdentity, obligationCorrectionId);
      return this.publish(candidate, current.sha256, deadline);
    });
  }

  bindCorrection(correctionId: string, operationId: string, proof: SafetyProof, deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const correction = current.value.correction;
      requireControl(correction?.correctionId === correctionId && (correction.recoveryOperationId === null || correction.recoveryOperationId === operationId) && await proof.verify(current.value, deadline));
      return this.publish({ ...current.value, correction: { ...correction, recoveryOperationId: operationId } }, current.sha256, deadline);
    });
  }

  detachAbandonedCorrection(correctionId: string, operationId: string, proof: SafetyProof, deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const correction = current.value.correction;
      requireControl(correction?.correctionId === correctionId && correction.recoveryOperationId === operationId && await proof.verify(current.value, deadline));
      return this.publish({ ...current.value, correction: { ...correction, recoveryOperationId: null } }, current.sha256, deadline);
    });
  }

  transferCorrection(correctionId: string, previousOperationId: string, successorOperationId: string, proof: SafetyProof, deadline?: Deadline): Promise<StoredSafety> {
    controlHash(correctionId, 32);
    requireControl(isRepairOperationId(previousOperationId) && isRepairOperationId(successorOperationId) && previousOperationId !== successorOperationId);
    const epoch = this.invalidationEpoch;
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const correction = current.value.correction;
      const witness = current.value.recoveryWitness;
      requireControl(correction?.correctionId === correctionId && correction.recoveryOperationId === previousOperationId && witness !== null);
      const successorIsWitnessed = witness.phase === 'transferring'
        ? witness.owner.operationId === previousOperationId && witness.successor?.operationId === successorOperationId
        : witness.phase === 'active' && witness.owner.operationId === successorOperationId;
      // The caller verifies the successor plan and surviving predecessor evidence.
      // The witness alone cannot prove that the prior duties survived.
      requireControl(successorIsWitnessed && await proof.verify(current.value, deadline) && epoch === this.invalidationEpoch);
      return this.publish({ ...current.value, correction: { ...correction, recoveryOperationId: successorOperationId } }, current.sha256, deadline);
    });
  }

  prepareWitness(owner: RecoveryOwner, deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const witness = current.value.recoveryWitness;
      if (witness !== null && witness.phase === 'preparing' && sameRecoveryOwner(witness.owner, owner)) { return current; }
      requireControl(witness === null);
      return this.publish({ ...current.value, recoveryWitness: { scopeSha256: this.options.storage.scope.bindingSha256, owner, phase: 'preparing', successor: null, disclosure: null } }, current.sha256, deadline);
    });
  }

  prepareTransfer(successor: RecoveryOwner, deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const witness = current.value.recoveryWitness;
      requireControl(witness !== null && witness.owner.activationId !== successor.activationId);
      if (witness.phase === 'transferring') { requireControl(witness.successor !== null && sameRecoveryOwner(witness.successor, successor)); return current; }
      return this.publish({ ...current.value, recoveryWitness: { ...witness, phase: 'transferring', successor } }, current.sha256, deadline);
    });
  }

  activateWitness(owner: RecoveryOwner, proof: SafetyProof, deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const witness = current.value.recoveryWitness;
      requireControl(witness !== null && (witness.phase === 'transferring' ? witness.successor !== null && sameRecoveryOwner(witness.successor, owner) : sameRecoveryOwner(witness.owner, owner)) && await proof.verify(current.value, deadline));
      requireControl(witness.phase === 'preparing' || witness.phase === 'transferring' || witness.phase === 'active');
      return this.publish({ ...current.value, recoveryWitness: { ...witness, owner, phase: 'active', successor: null, disclosure: null } }, current.sha256, deadline);
    });
  }

  awaitDisclosure(owner: RecoveryOwner, disclosure: RecoveryDisclosure, proof: SafetyProof, deadline?: Deadline): Promise<StoredSafety> {
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const witness = current.value.recoveryWitness;
      requireControl(witness !== null && sameRecoveryOwner(witness.owner, owner) && (witness.phase === 'active' || witness.phase === 'awaitingDisclosure')
        && current.value.generation === disclosure.generation && await proof.verify(current.value, deadline));
      return this.publish({ ...current.value, recoveryWitness: { ...witness, phase: 'awaitingDisclosure', successor: null, disclosure } }, current.sha256, deadline);
    });
  }

  dischargeWitness(owner: RecoveryOwner, kind: 'acknowledged' | 'abandoned', proof: SafetyProof, deadline?: Deadline): Promise<boolean> {
    const epoch = this.invalidationEpoch;
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      const witness = current.value.recoveryWitness;
      if (witness === null || !sameRecoveryOwner(witness.owner, owner) || kind === 'acknowledged' && witness.phase !== 'awaitingDisclosure'
        || !await proof.verify(current.value, deadline) || epoch !== this.invalidationEpoch) { return false; }
      await this.publish({ ...current.value, recoveryWitness: null }, current.sha256, deadline);
      return true;
    });
  }

  dischargeCorrection(generation: string, correctionId: string, proof: SafetyProof, deadline?: Deadline): Promise<boolean> {
    const epoch = this.invalidationEpoch;
    return this.queue.run(async () => {
      deadline?.check();
      const current = await this.current(deadline);
      if (current.value.generation !== generation || current.value.correction?.correctionId !== correctionId || current.value.pendingCheck !== null
        || !await proof.verify(current.value, deadline) || epoch !== this.invalidationEpoch) { return false; }
      await this.publish({ ...current.value, correction: null }, current.sha256, deadline);
      return true;
    });
  }
}
