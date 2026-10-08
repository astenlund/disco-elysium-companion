import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProcessSupervisor } from '../../src/process.ts';
import { bytesHash } from '../../src/storage.ts';
import { companionFixture, type CompanionFixture } from '../support/companion.ts';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
// The native supervisor admits only zero and one. Abrupt zero exits still skip
// production shutdown; exact proof-boundary matching distinguishes every cut.
export const crashExit = 0;
export const publicationExit = 0;
export const childTimeout = 600000;
export const preparationTimeout = 1200000;
export const releaseCuts = ['intent', 'safetyTransferred', 'coreSwitched', 'rangesDischarged', 'cursorAdvanced', 'historyVerified', 'repairAbandoned', 'correctionDetached', 'dischargesPublished', 'complete', 'witnessCleared'] as const;
export const recoveryCuts = ['witnessReserved', 'successorRecorded', 'witnessActivated', 'correctionTransferred'] as const;
export type ReleaseCut = typeof releaseCuts[number];
export type RecoveryCut = typeof recoveryCuts[number];
export interface ChildProof { readonly boundary: string; readonly dataRoot: string; readonly relative?: string; readonly sha256?: string; readonly repairId?: string; readonly correctionId?: string; readonly sourceManifest: Record<string, string> }

export function selectedCases<T extends string>(cases: readonly T[]): readonly T[] {
  const filter = process.env['COMPANION_CRASH_CASES'];
  if (filter === undefined) { return cases; }
  const selected = filter.split(',');
  assert.ok(selected.length > 0 && new Set(selected).size === selected.length && selected.every(value => cases.includes(value as T)), 'COMPANION_CRASH_CASES must contain distinct exact case names.');
  return cases.filter(value => selected.includes(value));
}

export function privateFixture(root: string): string {
  const resolved = path.resolve(root);
  assert.equal(path.relative(path.join(repository, '.tmp'), path.dirname(resolved)), '');
  assert.match(path.basename(resolved), /^runtime-fixture-[0-9]+-[a-f0-9]{32}$/);
  return resolved;
}

export function inside(root: string, target: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(root), resolved);
  assert.ok(relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  return resolved;
}

async function tree(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = inside(root, path.join(directory, entry.name));
      assert.equal(entry.isSymbolicLink(), false, absolute);
      if (entry.isDirectory()) { await visit(absolute); }
      else {
        assert.equal(entry.isFile(), true, absolute);
        result.set(path.relative(root, absolute).replaceAll(path.sep, '/'), await fs.readFile(absolute));
      }
    }
  }
  await visit(root);
  return result;
}

export async function sourceManifest(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relative of ['runtime/src', 'runtime/scripts', 'runtime/test/backend-crash', 'runtime/test/support', 'runtime/test/fixtures', 'core']) {
    for (const [name, bytes] of await tree(path.join(repository, relative))) {
      if (/\.(?:ts|ps1|psm1|cs)$/.test(name)) { result[relative + '/' + name] = bytesHash(bytes); }
    }
  }
  return result;
}

export async function readDocument<T>(target: string): Promise<T> { return JSON.parse(await fs.readFile(target, 'utf8')) as T; }

export class CrashFixture {
  readonly fixture: CompanionFixture;
  readonly supervisor: ProcessSupervisor;
  readonly manifest: Record<string, string>;
  readonly evidence: string;
  private baseline: Map<string, Map<string, Buffer>> | null = null;
  private childQuiescent = true;
  private childSequence = 0;

  private constructor(fixture: CompanionFixture, supervisor: ProcessSupervisor, manifest: Record<string, string>, evidence: string) {
    this.fixture = fixture; this.supervisor = supervisor; this.manifest = manifest; this.evidence = evidence;
  }

  static async create(label: string, selected: readonly string[], allCases: readonly string[]): Promise<CrashFixture> {
    const manifest = await sourceManifest();
    const fixture = await companionFixture('runtime-owned');
    const root = privateFixture(fixture.root);
    const evidence = path.join(repository, '.tmp/nightshift/backend-crash-impl', `${label}-${path.basename(root)}`);
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.writeFile(path.join(evidence, 'run-context.json'), JSON.stringify({ node: process.version, argv: process.argv, filter: process.env['COMPANION_CRASH_CASES'] ?? null,
      selectedCases: selected, skippedCases: allCases.filter(value => !selected.includes(value)) }, null, 2) + '\n');
    try {
      const supervisor = await ProcessSupervisor.create(inside(root, path.join(root, 'crash-driver')));
      return new CrashFixture(fixture, supervisor, manifest, evidence);
    } catch (error) { await fixture.close(); throw error; }
  }

  async child(mode: string, boundary = '', expectedExit = 0): Promise<ChildProof> {
    assert.equal(this.childQuiescent, true);
    this.childQuiescent = false;
    const script = fileURLToPath(new URL('./worker.ts', import.meta.url));
    let result: Awaited<ReturnType<ProcessSupervisor['run']>>;
    try {
      result = await this.supervisor.run('core', { command: process.execPath, args: [script, this.fixture.root, mode, boundary], cwd: this.fixture.root }, mode === 'prepare' ? preparationTimeout : childTimeout);
      this.childQuiescent = true;
    } catch (error) {
      await this.supervisor.verifyQuiescent('core');
      this.childQuiescent = true;
      throw error;
    }
    const label = `${String(++this.childSequence).padStart(2, '0')}-${mode}-${boundary || 'none'}`;
    await fs.writeFile(path.join(this.evidence, label + '.stdout.txt'), result.stdout);
    await fs.writeFile(path.join(this.evidence, label + '.stderr.txt'), result.stderr);
    if (result.exitCode !== expectedExit) { await this.preserve('failed-' + label); }
    assert.equal(result.exitCode, expectedExit, `${label}: ${result.stderr.toString('utf8')} ${result.stdout.toString('utf8')}`);
    const proof = JSON.parse(result.stdout.toString('utf8')) as ChildProof;
    inside(this.fixture.root, proof.dataRoot);
    assert.deepEqual(proof.sourceManifest, this.manifest, 'A source change during this integration run invalidates its snapshot.');
    return proof;
  }

  async capture(): Promise<void> {
    assert.equal(this.childQuiescent, true);
    this.baseline = new Map();
    for (const relative of ['state', 'runtime-data']) { this.baseline.set(relative, await tree(inside(this.fixture.root, path.join(this.fixture.root, relative)))); }
    const hashes = Object.fromEntries([...this.baseline].map(([relative, files]) => [relative, Object.fromEntries([...files].map(([name, bytes]) => [name, bytesHash(bytes)]))]));
    await fs.writeFile(path.join(this.evidence, 'prepared-manifest.json'), JSON.stringify(hashes, null, 2) + '\n');
  }

  async restore(): Promise<void> {
    assert.equal(this.childQuiescent, true);
    assert.ok(this.baseline);
    privateFixture(this.fixture.root);
    for (const [relative, files] of this.baseline) {
      const target = inside(this.fixture.root, path.join(this.fixture.root, relative));
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target);
      for (const [name, bytes] of files) {
        const destination = inside(target, path.join(target, name));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
      }
      assert.deepEqual(await tree(target), files, 'The private fixture must be restored byte for byte.');
    }
  }

  async preserve(label: string): Promise<void> {
    assert.equal(this.childQuiescent, true);
    assert.match(label, /^[a-zA-Z0-9-]+$/);
    for (const relative of ['state', 'runtime-data']) {
      const files = await tree(inside(this.fixture.root, path.join(this.fixture.root, relative)));
      for (const [name, bytes] of files) {
        const target = inside(this.evidence, path.join(this.evidence, label, relative, name));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.childQuiescent) { await this.supervisor.verifyQuiescent('core'); this.childQuiescent = true; }
    await this.fixture.close();
    assert.deepEqual(await sourceManifest(), this.manifest, 'Source changed during crash integration verification.');
  }
}
