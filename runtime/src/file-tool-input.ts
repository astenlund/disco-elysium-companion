import type { FileTool } from './tool-boundary.ts';

export interface FileToolRequest { readonly target: string; readonly input: Readonly<Record<string, unknown>>; readonly pathField: 'path' | 'file_path' }
const separator = String.fromCharCode(92);
const schemas: Record<FileTool, { required: readonly string[]; optional: readonly string[] }> = {
  Read: { required: ['file_path'], optional: ['offset', 'limit', 'pages'] },
  Edit: { required: ['file_path', 'old_string', 'new_string'], optional: ['replace_all'] },
  Write: { required: ['file_path', 'content'], optional: [] },
  Glob: { required: ['pattern'], optional: ['path'] },
  Grep: { required: ['pattern'], optional: ['path', 'glob', 'output_mode', '-B', '-A', '-C', 'context', '-n', '-i', '-o', 'type', 'head_limit', 'offset', 'multiline'] },
};

function text(value: unknown, empty = false): value is string { return typeof value === 'string' && value.isWellFormed() && (empty || value.length > 0); }
function count(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function pathPattern(value: unknown): value is string {
  return text(value) && !value.startsWith('/') && !value.includes(separator) && !value.includes(':') && !value.includes('..') && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

// Shapes are from pinned SDK 0.3.289 sdk-tools.d.ts. Unknown members cannot
// silently activate a new traversal or mutation feature outside the verified path.
export function fileToolRequest(companionRoot: string, tool: FileTool, input: unknown): FileToolRequest | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) { return null; }
  const value = input as Record<string, unknown>;
  const schema = schemas[tool];
  if (!schema.required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !schema.required.includes(key) && !schema.optional.includes(key))) { return null; }
  const search = tool === 'Glob' || tool === 'Grep';
  const pathField = search ? 'path' : 'file_path';
  const supplied = Object.hasOwn(value, pathField) ? value[pathField] : companionRoot;
  if (!text(supplied)) { return null; }
  let target: string;
  if (supplied.length >= 3 && /^[A-Za-z]$/.test(supplied[0]!) && supplied[1] === ':' && (supplied[2] === '/' || supplied[2] === separator)) { target = supplied; }
  else {
    if (supplied.startsWith('/') || supplied.startsWith(separator) || supplied.includes(':')) { return null; }
    // Preserve raw components so native admission can reject dot/device/ADS spellings.
    target = companionRoot + separator + supplied;
  }
  if (tool === 'Read') {
    if (Object.hasOwn(value, 'offset') && !count(value['offset']) || Object.hasOwn(value, 'limit') && !count(value['limit']) || Object.hasOwn(value, 'pages') && !text(value['pages'])) { return null; }
  } else if (tool === 'Edit') {
    if (!text(value['old_string'], true) || !text(value['new_string'], true) || Object.hasOwn(value, 'replace_all') && typeof value['replace_all'] !== 'boolean') { return null; }
  } else if (tool === 'Write') {
    if (!text(value['content'], true)) { return null; }
  } else if (tool === 'Glob') {
    if (!pathPattern(value['pattern'])) { return null; }
  } else {
    if (!text(value['pattern']) || Object.hasOwn(value, 'glob') && !pathPattern(value['glob'])) { return null; }
    if (Object.hasOwn(value, 'type') && (!text(value['type']) || !/^[A-Za-z0-9_+.-]+$/.test(value['type']) || value['type'].endsWith('\n'))) { return null; }
    if (Object.hasOwn(value, 'output_mode') && !['content', 'files_with_matches', 'count'].includes(value['output_mode'] as string)) { return null; }
    for (const field of ['-B', '-A', '-C', 'context', 'head_limit', 'offset']) { if (Object.hasOwn(value, field) && !count(value[field])) { return null; } }
    for (const field of ['-n', '-i', '-o', 'multiline']) { if (Object.hasOwn(value, field) && typeof value[field] !== 'boolean') { return null; } }
  }
  return { target, pathField, input: Object.freeze({ ...value }) };
}
