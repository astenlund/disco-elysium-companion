import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { PathInspector } from '../src/admission.ts';
import { assembleInstructions, InstructionsUnavailableError } from '../src/instructions.ts';
import { companionFixture } from './support/companion.ts';

describe('runtime system instruction assembly', () => {
  it('preserves imported bytes once and hashes the exact system-prompt append', async () => {
    const fixture = await companionFixture();
    const inspected: string[] = [];
    const inspector = { inspect: async (root: string, target: string) => {
      const relative = path.relative(root, target);
      assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
      inspected.push(relative);
      return { exists: true, kind: 'file', path: target, links: 1, volume: '0123456789abcdef',
        identity: '0123456789abcdef0123456789abcdef', missing: [] };
    } } as unknown as PathInspector;
    try {
      await fs.mkdir(path.join(fixture.root, 'runtime', 'instructions'), { recursive: true });
      const project = 'Project\r\n@AGENTS.md\r\nTail\n';
      const imported = 'Standing rules\n@not-expanded.md\n';
      const mode = 'Runtime-only instructions\r\n';
      await fs.writeFile(path.join(fixture.root, 'CLAUDE.md'), project);
      await fs.writeFile(path.join(fixture.root, 'AGENTS.md'), imported);
      await fs.writeFile(path.join(fixture.root, 'runtime', 'instructions', 'runtime-mode.md'), mode);
      const result = await assembleInstructions(inspector, fixture.root);
      const expected = 'Project\r\n' + imported + '\r\nTail\n\r\n\r\n' + mode;
      assert.equal(result.text, expected);
      assert.equal(result.sha256, createHash('sha256').update(Buffer.from(expected)).digest('hex'));
      assert.deepEqual(inspected, ['CLAUDE.md', 'CLAUDE.md', 'AGENTS.md', 'AGENTS.md',
        path.join('runtime', 'instructions', 'runtime-mode.md'), path.join('runtime', 'instructions', 'runtime-mode.md')]);
      await fs.writeFile(path.join(fixture.root, 'AGENTS.md'), Buffer.from([0xff]));
      await assert.rejects(assembleInstructions(inspector, fixture.root), InstructionsUnavailableError);
      await fs.unlink(path.join(fixture.root, 'AGENTS.md'));
      await assert.rejects(assembleInstructions(inspector, fixture.root), InstructionsUnavailableError);
    } finally { await fixture.close(); }
  });

  it('refuses instruction bytes changed between admission and the repeated read', async () => {
    const fixture = await companionFixture();
    const imported = path.join(fixture.root, 'AGENTS.md');
    let importedAdmissions = 0;
    const inspector = { inspect: async (_root: string, target: string) => {
      if (target === imported && ++importedAdmissions === 2) { await fs.writeFile(imported, 'changed'); }
      return { exists: true, kind: 'file', path: target, links: 1, volume: '0123456789abcdef',
        identity: '0123456789abcdef0123456789abcdef', missing: [] };
    } } as unknown as PathInspector;
    try {
      await fs.mkdir(path.join(fixture.root, 'runtime', 'instructions'), { recursive: true });
      await fs.writeFile(path.join(fixture.root, 'CLAUDE.md'), '@AGENTS.md');
      await fs.writeFile(imported, 'original');
      await fs.writeFile(path.join(fixture.root, 'runtime', 'instructions', 'runtime-mode.md'), 'mode');
      await assert.rejects(assembleInstructions(inspector, fixture.root), InstructionsUnavailableError);
      assert.equal(importedAdmissions, 2);
    } finally { await fixture.close(); }
  });
});
