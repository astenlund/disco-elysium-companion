import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, type PathAdmission, type PathInspector } from '../admission.ts';
import { Deadline } from '../deadline.ts';
import type { InstanceGuard } from '../guard.ts';
import { eventFileSequence } from '../journal-records.ts';
import { jsonBudgets, readBoundedFile } from '../json.ts';
import { SupervisorError, type ProcessSupervisor } from '../process.ts';
import type { RuntimeScope } from '../scope.ts';
import { bytesHash } from '../storage.ts';

const fixedFiles = new Set(['scope.json', 'runtime.json', 'agent-session.json', 'agent-session-index.json', 'state-safety.json', 'prepared-context.txt', 'codec.json']);
const journalFiles = new Set(['journal.json', 'cursor-agent-session.json', 'recovery-event.json']);
const directories = ['', 'journal', 'journal/events', 'operations', 'quarantine'] as const;
const operationName = /^(jr|rl|ho)-[0-9a-f]{32}\.json$/;
const siblingSuffix = /^(.+)\.[0-9a-f]{32}\.(tmp|bak)$/;

// A suffix alone never grants deletion authority over an unrelated file.
export function isPublicationResidue(relative: string): boolean {
  const normalized = relative.replaceAll(path.win32.sep, '/');
  const split = normalized.lastIndexOf('/');
  const directory = split < 0 ? '' : normalized.slice(0, split);
  const file = normalized.slice(split + 1);
  const matched = siblingSuffix.exec(file);
  if (matched === null) { return false; }
  const target = matched[1]!;
  if (directory === '') { return fixedFiles.has(target); }
  if (directory === 'journal') { return journalFiles.has(target); }
  if (directory === 'journal/events') { return eventFileSequence(target) !== null; }
  if (directory === 'operations') { return operationName.test(target); }
  if (directory === 'quarantine') { return /^(jr|rl|ho)-[0-9a-f]{32}\.json\.[0-9a-f]{32}\.quarantined$/.test(target); }
  return false;
}

function sameObject(left: PathAdmission, right: PathAdmission): boolean {
  return left.kind === right.kind && left.volume === right.volume && left.identity === right.identity && left.links === right.links;
}

export async function cleanupPublicationResidue(scope: RuntimeScope, guard: Pick<InstanceGuard, 'held'>, inspector: PathInspector,
  supervisor: Pick<ProcessSupervisor, 'verifyQuiescent'>, deadline = Deadline.after(120000)): Promise<{ readonly removed: readonly string[] }> {
  const owned = (): void => {
    deadline.check();
    if (!guard.held) { throw new DataRootUnavailableError('Publication cleanup requires the instance guard.'); }
  };
  const binding = path.join(scope.dataRoot, 'scope.json');
  const verifyBinding = async (): Promise<void> => {
    owned();
    const admitted = await inspector.inspect(scope.dataRoot, binding, false, deadline.remaining());
    if (admitted.kind !== 'file' || bytesHash(await readBoundedFile(binding, jsonBudgets.config.maxBytes)) !== scope.bindingSha256) {
      throw new DataRootUnavailableError('Publication cleanup lost its immutable scope binding.');
    }
    owned();
  };
  owned();
  await supervisor.verifyQuiescent('publication');
  await verifyBinding();
  const candidates: { relative: string; admitted: PathAdmission }[] = [];
  let entries = 0;
  for (const relative of directories) {
    const directory = path.join(scope.dataRoot, relative);
    const admitted = await inspector.inspect(scope.dataRoot, directory, true, deadline.remaining());
    if (!admitted.exists) { continue; }
    if (admitted.kind !== 'directory') { throw new DataRootUnavailableError('Publication cleanup inventory changed kind.'); }
    const names: string[] = [];
    for await (const entry of await fs.opendir(directory)) {
      owned();
      entries++;
      if (entries > 65536) { throw new DataRootUnavailableError('Publication cleanup inventory exceeds its discovery bound.'); }
      const candidate = path.join(relative, entry.name);
      if (isPublicationResidue(candidate) || candidate === 'prepared-context.txt') { names.push(candidate); }
    }
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = names.slice(offset, offset + 32);
      const paths = batch.flatMap(name => {
        const candidate = path.join(scope.dataRoot, name);
        const target = name === 'prepared-context.txt' ? candidate : candidate.replace(/\.[0-9a-f]{32}\.(tmp|bak)$/, '');
        return [candidate, target];
      });
      const observations = await inspector.inspectMany(scope.dataRoot, paths, true, deadline.remaining());
      batch.forEach((name, index) => {
        const item = observations[index * 2]!;
        const target = observations[index * 2 + 1]!;
        if (item.kind !== 'file') { throw new DataRootUnavailableError('Publication residue is not an ordinary owned file.'); }
        if (target.exists && target.kind !== 'file') { throw new DataRootUnavailableError('Publication target is not an ordinary owned file.'); }
        candidates.push({ relative: name, admitted: item });
      });
    }
  }
  // No partial inventory authorizes a delete. Recheck each object immediately before
  // removal, including the scope binding that grants authority to this command.
  const removed: string[] = [];
  for (const candidate of candidates) {
    await verifyBinding();
    const current = await inspector.inspect(scope.dataRoot, candidate.admitted.path, true, deadline.remaining());
    if (!current.exists) { continue; }
    if (!sameObject(candidate.admitted, current)) { throw new DataRootUnavailableError('Publication residue changed before removal.'); }
    owned();
    await fs.unlink(current.path);
    removed.push(candidate.relative);
  }
  return { removed: Object.freeze(removed) };
}
export interface MarkerResidueIO {
  entries(directory: string): AsyncIterable<string>;
  read(file: string, maximumBytes: number): Promise<Uint8Array>;
  unlink(file: string): Promise<void>;
}

const markerResidueIO: MarkerResidueIO = {
  async *entries(directory) { for await (const entry of await fs.opendir(directory)) { yield entry.name; } },
  read: readBoundedFile,
  unlink: file => fs.unlink(file),
};
const markerSibling = /^runtime\.json\.[0-9a-f]{32}\.(tmp|bak)$/;
interface MarkerSnapshot { readonly admitted: PathAdmission; readonly sha256: string | null }

function sameMarkerObject(left: PathAdmission, right: PathAdmission): boolean {
  return left.path === right.path && left.exists === right.exists && sameObject(left, right);
}

// This pre-marker pass has a narrower authority than the full phase-D cleanup:
// retain the exact target and reject any changed selected object, including loss.
export async function cleanupRuntimeMarkerResidue(scope: RuntimeScope, guard: Pick<InstanceGuard, 'held'>,
  inspector: Pick<PathInspector, 'inspectMany'>, supervisor: Pick<ProcessSupervisor, 'verifyQuiescent'>,
  deadline = Deadline.after(120000), io: MarkerResidueIO = markerResidueIO): Promise<{ readonly removed: readonly string[] }> {
  const owned = (): void => {
    deadline.check();
    if (!guard.held) { throw new DataRootUnavailableError('Runtime marker cleanup requires the instance guard.'); }
  };
  const inspect = async (targets: readonly string[]): Promise<readonly PathAdmission[]> => {
    owned();
    const result = await inspector.inspectMany(scope.dataRoot, targets, true, deadline.remaining());
    owned();
    return result;
  };
  const digest = async (file: string): Promise<string> => {
    owned();
    const bytes = await io.read(file, jsonBudgets.config.maxBytes);
    owned();
    if (bytes.byteLength > jsonBudgets.config.maxBytes) { throw new DataRootUnavailableError('Runtime marker residue exceeds its byte bound.'); }
    return bytesHash(bytes);
  };
  const snapshot = async (admitted: PathAdmission, required: boolean): Promise<MarkerSnapshot> => {
    if ((!admitted.exists && required) || (admitted.exists && (admitted.kind !== 'file' || admitted.links !== 1))) {
      throw new DataRootUnavailableError('Runtime marker residue or target is not an ordinary admitted file.');
    }
    return { admitted, sha256: admitted.exists ? await digest(admitted.path) : null };
  };
  try {
    owned();
    await supervisor.verifyQuiescent('publication');
    const bindingPath = path.join(scope.dataRoot, 'scope.json');
    const targetPath = path.join(scope.dataRoot, 'runtime.json');
    const [root, binding, target] = await inspect([scope.dataRoot, bindingPath, targetPath]);
    if (root?.kind !== 'directory' || binding?.kind !== 'file' || binding.links !== 1 || target === undefined || await digest(bindingPath) !== scope.bindingSha256) {
      throw new DataRootUnavailableError('Runtime marker cleanup lost its immutable scope binding.');
    }
    const targetSnapshot = await snapshot(target, false);
    const names: string[] = [];
    let entries = 0;
    for await (const name of io.entries(scope.dataRoot)) {
      owned();
      if (++entries > 65536) { throw new DataRootUnavailableError('Runtime marker cleanup inventory exceeds its discovery bound.'); }
      if (markerSibling.test(name)) { names.push(name); }
    }
    const candidates: { readonly name: string; readonly snapshot: MarkerSnapshot }[] = [];
    for (let offset = 0; offset < names.length; offset += 64) {
      const batch = names.slice(offset, offset + 64);
      const admitted = await inspect(batch.map(name => path.join(scope.dataRoot, name)));
      for (const [index, name] of batch.entries()) {
        if (admitted[index] === undefined) { throw new DataRootUnavailableError('Runtime marker residue inventory is incomplete.'); }
        candidates.push({ name, snapshot: await snapshot(admitted[index]!, true) });
      }
    }
    const removed: string[] = [];
    for (const candidate of candidates) {
      owned();
      await supervisor.verifyQuiescent('publication');
      const [currentRoot, currentBinding, currentTarget, currentSibling] = await inspect([scope.dataRoot, bindingPath, targetPath, candidate.snapshot.admitted.path]);
      if (currentRoot === undefined || currentBinding === undefined || currentTarget === undefined || currentSibling === undefined
        || !sameMarkerObject(root, currentRoot) || !sameMarkerObject(binding, currentBinding) || await digest(bindingPath) !== scope.bindingSha256
        || !sameMarkerObject(targetSnapshot.admitted, currentTarget) || !sameMarkerObject(candidate.snapshot.admitted, currentSibling)) {
        throw new DataRootUnavailableError('Runtime marker cleanup authority changed before removal.');
      }
      if ((currentTarget.exists && await digest(currentTarget.path) !== targetSnapshot.sha256)
        || await digest(currentSibling.path) !== candidate.snapshot.sha256) {
        throw new DataRootUnavailableError('Runtime marker residue or target bytes changed before removal.');
      }
      const checked = [currentRoot, currentBinding, currentTarget, currentSibling];
      const afterRead = await inspect(checked.map(item => item.path));
      if (afterRead.length !== checked.length || checked.some((item, index) => !sameMarkerObject(item, afterRead[index]!))) {
        throw new DataRootUnavailableError('Runtime marker object changed during its byte verification.');
      }
      owned();
      await io.unlink(currentSibling.path);
      owned();
      removed.push(candidate.name);
    }
    owned();
    return { removed: Object.freeze(removed) };
  } catch (error) {
    if (error instanceof DataRootUnavailableError || error instanceof SupervisorError && error.reason === 'termination-unverified') { throw error; }
    throw new DataRootUnavailableError('Runtime marker residue cleanup is unavailable.', { cause: error });
  }
}
