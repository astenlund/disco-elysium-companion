import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DataRootUnavailableError, PathInspector, type PathAdmission } from './admission.ts';
import { FilePublisher } from './files.ts';
import type { InstanceGuard } from './guard.ts';
import { isOpaqueToken } from './identity.ts';
import { asInteger, hasExactKeys, parseStrictJson, readBoundedFile } from './json.ts';

export interface ScopeCandidate { readonly companionRoot: string; readonly dataRoot: string; readonly game: string; readonly principal: string }
export interface RuntimeScope extends ScopeCandidate { readonly bindingSha256: string; readonly createdHere: boolean }

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const freshScopes = new WeakSet<RuntimeScope>();

export function consumeFreshScope(scope: RuntimeScope): boolean { return freshScopes.delete(scope); }

export function scopeComponents(game: string, principal: string): readonly string[] {
  if (!isOpaqueToken(game) || !isOpaqueToken(principal)) { throw new DataRootUnavailableError('Scope identity is invalid.'); }

  return ['runtime-data', 'g-' + hash(game), 'p-' + hash(principal)];
}

function verifyCandidate(candidate: ScopeCandidate): void {
  const expected = path.join(candidate.companionRoot, ...scopeComponents(candidate.game, candidate.principal));
  if (path.win32.relative(expected, candidate.dataRoot) !== '') { throw new DataRootUnavailableError('Scope path does not match its identities.'); }
}

async function directoryEmpty(directory: string): Promise<boolean> {
  const handle = await fs.opendir(directory);
  try { return await handle.read() === null; }
  finally { await handle.close(); }
}

function admittedScope(game: string, principal: string, root: PathAdmission, candidate: PathAdmission): ScopeCandidate {
  const components = scopeComponents(game, principal);
  if (root.kind !== 'directory') { throw new DataRootUnavailableError('Companion root is not a directory.'); }
  if (path.win32.relative(path.join(root.path, ...components), candidate.path) !== '') { throw new DataRootUnavailableError('Scope path changed during admission.'); }
  if (candidate.exists && candidate.kind !== 'directory') { throw new DataRootUnavailableError('Runtime scope is not a directory.'); }

  return { companionRoot: root.path, dataRoot: candidate.path, game, principal };
}

export async function discoverScope(inspector: PathInspector, companionRoot: string, game: string, principal: string): Promise<ScopeCandidate> {
  const requested = path.join(companionRoot, ...scopeComponents(game, principal));
  const [root, candidate] = await inspector.inspectMany(companionRoot, [companionRoot, requested], true);
  if (root === undefined || candidate === undefined) { throw new DataRootUnavailableError('Scope admission is incomplete.'); }

  return admittedScope(game, principal, root, candidate);
}

export async function readScope(inspector: PathInspector, candidate: ScopeCandidate): Promise<RuntimeScope | null> {
  verifyCandidate(candidate);
  const [directory, binding] = await inspector.inspectMany(candidate.companionRoot, [candidate.dataRoot, path.join(candidate.dataRoot, 'scope.json')], true);
  if (directory === undefined || binding === undefined) { throw new DataRootUnavailableError('Scope binding admission is incomplete.'); }
  if (!directory.exists) { return null; }
  if (directory.kind !== 'directory') { throw new DataRootUnavailableError('Scope directory changed kind.'); }
  if (!binding.exists) {
    if (!await directoryEmpty(candidate.dataRoot)) { throw new DataRootUnavailableError('Nonempty scope has no verified ownership binding.'); }

    return null;
  }
  if (binding.kind !== 'file') { throw new DataRootUnavailableError('Scope binding is not a file.'); }
  const bytes = await readBoundedFile(binding.path, 1_048_576);

  return scopeFromAdmittedBinding(candidate, bytes);
}

/** @internal The caller must supply bytes from a fresh physical admission of scope.json. */
export function scopeFromAdmittedBinding(candidate: ScopeCandidate, bytes: Uint8Array): RuntimeScope {
  verifyCandidate(candidate);
  const value = parseStrictJson(bytes, 'config');
  if (!hasExactKeys(value, ['runtimeScopeVersion', 'game', 'principal']) || asInteger(value['runtimeScopeVersion']) !== 1 || value['game'] !== candidate.game || value['principal'] !== candidate.principal) {
    throw new DataRootUnavailableError('Scope ownership binding is invalid or belongs to other identities.');
  }

  return { ...candidate, bindingSha256: hash(bytes), createdHere: false };
}

export async function initializeScope(inspector: PathInspector, candidate: ScopeCandidate, guard: Pick<InstanceGuard, 'held'>, publisher: FilePublisher): Promise<RuntimeScope> {
  verifyCandidate(candidate);
  const requireGuard = (): void => { if (!guard.held) { throw new DataRootUnavailableError('Scope initialization requires instance ownership.'); } };
  requireGuard();
  const existing = await readScope(inspector, candidate);
  if (existing !== null) { return existing; }
  let current = candidate.companionRoot;
  for (const component of scopeComponents(candidate.game, candidate.principal)) {
    current = path.join(current, component);
    const admitted = await inspector.inspect(candidate.companionRoot, current, true);
    requireGuard();
    if (!admitted.exists) {
      if (admitted.missing.length !== 1) { throw new DataRootUnavailableError('Scope parent is not admitted.'); }
      try { await fs.mkdir(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
    }
    const created = await inspector.inspect(candidate.companionRoot, current);
    if (created.kind !== 'directory') { throw new DataRootUnavailableError('Scope component is not an ordinary directory.'); }
  }
  requireGuard();
  const raced = await readScope(inspector, candidate);
  if (raced !== null) { return raced; }
  let createdHere = false;
  try {
    const publication = await publisher.publishJson('scope.json', { runtimeScopeVersion: 1, game: candidate.game, principal: candidate.principal }, true);
    createdHere = publication.cleanupComplete;
  } catch (error) {
    // A supported create collision can be admitted by its exact logical binding,
    // but it never supplies proof that this invocation created a new scope.
    if (publisher.blocked) { throw error; }
    const collision = await readScope(inspector, candidate);
    if (collision !== null) { return collision; }
    throw error;
  }
  if (publisher.blocked) { throw new DataRootUnavailableError('Scope publication awaits verified recovery.'); }
  requireGuard();
  const scope = await readScope(inspector, candidate);
  if (scope === null) { throw new DataRootUnavailableError('Scope binding publication is unavailable.'); }

  const initialized = { ...scope, createdHere };
  if (createdHere) { freshScopes.add(initialized); }
  return initialized;
}
