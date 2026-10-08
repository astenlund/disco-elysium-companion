import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fileToolRequest } from '../src/file-tool-input.ts';

const root = 'C:/companion';
const separator = String.fromCharCode(92);

describe('pinned file-tool input shapes', () => {
  it('preserves raw path spelling for native admission instead of normalizing away unsafe components', () => {
    assert.equal(fileToolRequest(root, 'Read', { file_path: '../outside.md' })!.target, root + separator + '../outside.md');
    assert.equal(fileToolRequest(root, 'Write', { file_path: 'memory/NUL', content: '' })!.target, root + separator + 'memory/NUL');
    assert.equal(fileToolRequest(root, 'Read', { file_path: 'C:/companion/state/../memory/cache.md' })!.target, 'C:/companion/state/../memory/cache.md');
    for (const file_path of ['C:relative.md', '/rooted.md', separator + separator + 'server/share/file', 'memory/file.md:stream']) {
      assert.equal(fileToolRequest(root, 'Read', { file_path }), null);
    }
  });

  it('keeps search filters within their root while leaving content regex semantics to Grep', () => {
    assert.equal(fileToolRequest(root, 'Glob', { pattern: '**/*.md' })!.target, root);
    for (const pattern of ['../*', '{../secret,safe}/*', 'C:/*.md', '/outside/*', '..' + separator + '*']) { assert.equal(fileToolRequest(root, 'Glob', { pattern }), null); }
    assert.notEqual(fileToolRequest(root, 'Grep', { pattern: '../secret', path: 'knowledge', glob: '*.md', '-i': true }), null);
    assert.equal(fileToolRequest(root, 'Grep', { pattern: '.', glob: '../state/*' }), null);
  });

  it('rejects new or malformed options and retains valid data exactly', () => {
    assert.equal(fileToolRequest(root, 'Read', { file_path: 'knowledge/readme.md', recursive: true }), null);
    assert.equal(fileToolRequest(root, 'Read', { file_path: 'knowledge/readme.md', limit: NaN }), null);
    assert.equal(fileToolRequest(root, 'Grep', { pattern: '.', path: null }), null);
    assert.equal(fileToolRequest(root, 'Grep', { pattern: '.', output_mode: 'shell' }), null);
    const input = { file_path: 'memory/cache.md', old_string: 'old\n', new_string: 'new\n', replace_all: false };
    assert.deepEqual(fileToolRequest(root, 'Edit', input)!.input, input);
    assert.equal(fileToolRequest(root, 'Write', { file_path: 'memory/cache.md', content: '' })!.input['content'], '');
  });
});
