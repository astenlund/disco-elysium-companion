import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const scripts = path.join(repository, 'runtime', 'scripts');
const core = path.join(repository, 'core');
const read = (file: string): string => fs.readFileSync(file, 'utf8');

function capture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  assert.ok(value !== undefined, `Capture ${index} is missing.`);

  return value;
}

/** A dot-source that does not start its line, such as one inside a block, which the whole-line forms below cannot read. */
const embeddedDotSource = /[\s{;(]\.\s+[$(]/;

/** Returns the names in a PowerShell `$name = @('a', 'b')` array literal, which may span lines. */
function arrayNames(text: string, variable: string): string[] {
  const match = new RegExp(`\\$${variable} = @\\(([^)]*)\\)`).exec(text);
  assert.ok(match, `$${variable} is not declared as an array literal.`);

  return [...capture(match, 1).matchAll(/'([^']+)'/g)].map(item => capture(item, 1));
}

/**
 * Lists the installation files a worker script loads, by statement form: a dot-source of `Join-Path $PSScriptRoot '<name>'`
 * (directly or through a variable assigned that way), `Add-Type -Path` over such a name list, and the core module import.
 * Any other dot-source, `Add-Type`, `Import-Module` or `using module` statement is returned as unrecognized, so a new
 * load form fails the test until this analysis covers it.
 */
function workerLoads(text: string): { runtime: string[]; importsCore: boolean; unrecognized: string[] } {
  const runtime: string[] = [];
  const unrecognized: string[] = [];
  let importsCore = false;
  const pathVariables = new Map([...text.matchAll(/\$(\w+) = Join-Path \$PSScriptRoot '([^']+)'/g)].map(item => [capture(item, 1), capture(item, 2)]));
  const coreVariables = new Set([...text.matchAll(/\$(\w+) = Join-Path \$CompanionRoot 'core\/DigestDiff\.psm1'/g)].map(item => capture(item, 1)));
  for (const line of text.split(/\r?\n/)) {
    const statement = line.trim();
    if (!/^\.\s/.test(statement) && embeddedDotSource.test(statement)) { unrecognized.push(statement); continue; }
    const dotSource = /^\.\s+(.*)$/.exec(statement);
    if (dotSource !== null) {
      const target = capture(dotSource, 1);
      const viaVariable = /^\$(\w+)$/.exec(target);
      const direct = /^\(Join-Path \$PSScriptRoot '([^']+)'\)$/.exec(target);
      const name = viaVariable !== null ? pathVariables.get(capture(viaVariable, 1)) : direct === null ? undefined : capture(direct, 1);
      if (name === undefined) { unrecognized.push(statement); } else { runtime.push(name); }
      continue;
    }
    if (/\bAdd-Type\b/.test(statement)) {
      const fromList = /^Add-Type -Path @\(\$(\w+) \| ForEach-Object \{ Join-Path \$PSScriptRoot \$_ \}\)$/.exec(statement);
      if (fromList === null) { unrecognized.push(statement); } else { runtime.push(...arrayNames(text, capture(fromList, 1))); }
      continue;
    }
    if (/\bImport-Module\b|\busing module\b/i.test(statement)) {
      const moduleVariable = /^\$(\w+) = \[Companion\.Runtime\.NativeFiles\]::AdmitWithin\(\$CompanionRoot, \$(\w+), \$false\)$/;
      const imported = /^Import-Module \$(\w+)\.Path -Force -DisableNameChecking$/.exec(statement);
      const admission = imported === null ? undefined
        : text.split(/\r?\n/).map(item => moduleVariable.exec(item.trim())).find(item => item !== null && capture(item, 1) === capture(imported, 1));
      if (admission === undefined || admission === null || !coreVariables.has(capture(admission, 2))) { unrecognized.push(statement); } else { importsCore = true; }
    }
  }

  return { runtime, importsCore, unrecognized };
}

/** Lists the files the core module dot-sources, and any other load statement in it or in those files. */
function coreLoads(moduleText: string, readPrivate: (name: string) => string): { names: string[]; unrecognized: string[] } {
  const names = [...moduleText.matchAll(/^\. \(Join-Path \$PSScriptRoot '([^']+)'\)\s*$/gm)].map(item => capture(item, 1));
  const unrecognized: string[] = [];
  const check = (text: string, owner: string) => {
    for (const line of text.split(/\r?\n/)) {
      const statement = line.trim();
      if (/^\.\s/.test(statement) && owner === 'DigestDiff.psm1' && /^\. \(Join-Path \$PSScriptRoot '[^']+'\)$/.test(statement)) { continue; }
      if (/^\.\s/.test(statement) || embeddedDotSource.test(statement) || /\busing module\b/i.test(statement)) {
        unrecognized.push(`${owner}: ${statement}`);
        continue;
      }
      // Inline type definitions are part of the hashed file itself.
      if (/\bAdd-Type\b/.test(statement) && !/^Add-Type -TypeDefinition @'$/.test(statement)) { unrecognized.push(`${owner}: ${statement}`); continue; }
      // The adapter module is admitted and attested through the adapter release, not the worker source bundle.
      if (/\bImport-Module\b/.test(statement) && !(owner === 'private/AdapterConfig.ps1' && statement.includes('Import-Module -Name $Path -Force -PassThru'))) {
        unrecognized.push(`${owner}: ${statement}`);
      }
    }
  };
  check(moduleText, 'DigestDiff.psm1');
  for (const name of names) { check(readPrivate(name), name); }

  return { names, unrecognized };
}

const evidence = read(path.join(scripts, 'Get-StartupWorkerSource.ps1'));
const workers = [
  { script: 'StartupMetadataWorker.ps1', evidenceList: 'metadataNames', ownList: 'sourceNames' },
  { script: 'StartupCoreReplyWorker.ps1', evidenceList: 'coreReplyNames', ownList: 'runtimeNames' },
  { script: 'StartupMutationWorker.ps1', evidenceList: 'mutationNames', ownList: 'sourceNames' },
] as const;

test('each startup worker hashes every installation file it loads', () => {
  for (const worker of workers) {
    const text = read(path.join(scripts, worker.script));
    const hashed = arrayNames(evidence, worker.evidenceList);
    const loads = workerLoads(text);
    assert.deepEqual(loads.unrecognized, [], `${worker.script} has a load statement the source analysis does not cover.`);
    assert.ok(loads.runtime.includes('StartupWorkerProtocol.ps1') && loads.runtime.includes('NativeFiles.cs'), `${worker.script} loads were not found.`);
    assert.equal(loads.importsCore, worker.script === 'StartupCoreReplyWorker.ps1', `${worker.script} core import was misread.`);
    assert.ok(hashed.includes(worker.script), `${worker.script} does not hash itself.`);
    for (const name of loads.runtime) { assert.ok(hashed.includes(name), `${worker.script} loads ${name} without hashing it.`); }
    assert.deepEqual(arrayNames(text, worker.ownList), hashed, `${worker.script} hashes a different list than the source evidence.`);
    if (loads.importsCore) { assert.deepEqual(arrayNames(text, 'coreNames'), arrayNames(evidence, 'coreNames'), `${worker.script} hashes different core sources.`); }
  }
});

test('every copy of the startup source lists matches the source evidence', () => {
  const metadataWorker = read(path.join(scripts, 'StartupMetadataWorker.ps1'));
  for (const name of ['coreReplyNames', 'mutationNames', 'coreNames']) { assert.deepEqual(arrayNames(metadataWorker, name), arrayNames(evidence, name), name); }
  assert.deepEqual(arrayNames(read(path.join(scripts, 'Get-StartupMetadataSource.ps1')), 'sourceNames'), arrayNames(evidence, 'metadataNames'));
});

test('the core source list is exactly what the core module loads', () => {
  const loads = coreLoads(read(path.join(core, 'DigestDiff.psm1')), name => read(path.join(core, name)));
  assert.deepEqual(loads.unrecognized, []);
  assert.deepEqual(['DigestDiff.psm1', ...loads.names], arrayNames(evidence, 'coreNames'));
});

test('the source analysis catches an unhashed dot-source, type source or core import', () => {
  const coreReply = read(path.join(scripts, 'StartupCoreReplyWorker.ps1'));
  const dotSourced = coreReply.replace('. $validationPath', ". $validationPath\n        . (Join-Path $PSScriptRoot 'Extra.ps1')");
  assert.ok(workerLoads(dotSourced).runtime.includes('Extra.ps1'));
  assert.ok(!arrayNames(evidence, 'coreReplyNames').includes('Extra.ps1'));
  const typed = coreReply.replace("$sources = @('NativeFiles.cs',", "$sources = @('Extra.cs', 'NativeFiles.cs',");
  assert.ok(workerLoads(typed).runtime.includes('Extra.cs'));
  assert.deepEqual(workerLoads(coreReply.replace('. $validationPath', '. $somewhereElse')).unrecognized, ['. $somewhereElse']);
  const embedded = "if ($true) { . (Join-Path $PSScriptRoot 'Extra.ps1') }";
  assert.deepEqual(workerLoads(coreReply.replace('. $validationPath', `. $validationPath\n        ${embedded}`)).unrecognized, [embedded]);
  assert.equal(workerLoads(coreReply.replace("'core/DigestDiff.psm1'", "'core/Other.psm1'")).unrecognized.length, 1);
  const moduleText = read(path.join(core, 'DigestDiff.psm1'));
  const extended = moduleText.replace(". (Join-Path $PSScriptRoot 'private/WalkProtocol.ps1')",
    ". (Join-Path $PSScriptRoot 'private/WalkProtocol.ps1')\n. (Join-Path $PSScriptRoot 'private/Extra.ps1')");
  assert.ok(coreLoads(extended, name => name === 'private/Extra.ps1' ? '' : read(path.join(core, name))).names.includes('private/Extra.ps1'));
});
