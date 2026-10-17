import { createHash } from 'node:crypto';
import path from 'node:path';

import { PathInspector } from './admission.ts';
import type { Deadline } from './deadline.ts';
import { readBoundedFile } from './json.ts';

export interface RuntimeInstructions { readonly text: string; readonly sha256: string }
export class InstructionsUnavailableError extends Error { override readonly name = 'InstructionsUnavailableError'; }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const importLine = /^@([^\s@]+)[ \t]*$/;
const maximumInstructionSourceBytes = 1_048_576;

// Only complete, physically admitted project files can become system instructions.
// Imports expand once; imported bytes and all existing line endings are preserved.
export async function assembleInstructions(inspector: PathInspector, companionRoot: string, deadline?: Deadline): Promise<RuntimeInstructions> {
  const read = async (file: string): Promise<Buffer> => {
    const admitted = await inspector.inspect(companionRoot, file, false, deadline?.remaining());
    if (admitted.kind !== 'file' || admitted.links !== 1 || admitted.volume === null || admitted.identity === null) {
      throw new InstructionsUnavailableError('An instruction source is not an ordinary project file.');
    }
    let bytes: Buffer;
    let repeated: Buffer;
    try { bytes = await readBoundedFile(admitted.path, maximumInstructionSourceBytes); }
    catch { throw new InstructionsUnavailableError('An instruction source could not be read completely.'); }
    deadline?.check();
    const confirmed = await inspector.inspect(companionRoot, file, false, deadline?.remaining());
    if (confirmed.kind !== 'file' || confirmed.links !== 1 || confirmed.volume !== admitted.volume || confirmed.identity !== admitted.identity) {
      throw new InstructionsUnavailableError('An instruction source changed during admission.');
    }
    try { repeated = await readBoundedFile(confirmed.path, maximumInstructionSourceBytes); }
    catch { throw new InstructionsUnavailableError('An instruction source could not be read completely.'); }
    deadline?.check();
    if (!bytes.equals(repeated)) { throw new InstructionsUnavailableError('An instruction source changed during its read.'); }
    try { decoder.decode(bytes); }
    catch { throw new InstructionsUnavailableError('An instruction source is not valid UTF-8.'); }
    return bytes;
  };
  const project = decoder.decode(await read(path.join(companionRoot, 'CLAUDE.md')));
  const parts: Buffer[] = [];
  for (const line of project.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
    if (line.length === 0) { continue; }
    const body = line.replace(/[\r\n]+$/, '');
    const match = importLine.exec(body);
    if (match === null) { parts.push(Buffer.from(line, 'utf8')); }
    else {
      parts.push(await read(path.resolve(companionRoot, match[1]!)));
      parts.push(Buffer.from(line.slice(body.length), 'utf8'));
    }
  }
  parts.push(Buffer.from('\r\n\r\n'));
  parts.push(await read(path.join(companionRoot, 'runtime', 'instructions', 'runtime-mode.md')));
  const bytes = Buffer.concat(parts);
  deadline?.check();
  return Object.freeze({ text: decoder.decode(bytes), sha256: createHash('sha256').update(bytes).digest('hex') });
}
