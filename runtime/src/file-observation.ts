import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import { Deadline } from './deadline.ts';

export interface FileObservation { readonly sha256: string; readonly bytes: number }
export class FileObservationError extends Error { override readonly name = 'FileObservationError'; }

// Diagnostic evidence only. A complete raw hash never admits JSON as authority.
// Fixed memory and a caller-owned deadline also bound oversized corrupt files.
export async function observeFile(file: string, deadline = Deadline.after(30000)): Promise<FileObservation> {
  deadline.check();
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) { throw new FileObservationError('Diagnostic preimage is not an observable ordinary file.'); }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let length = 0;
    for (;;) {
      deadline.check();
      const read = await handle.read(buffer, 0, buffer.length, null);
      deadline.check();
      if (read.bytesRead === 0) { break; }
      length += read.bytesRead;
      if (BigInt(length) > before.size) { throw new FileObservationError('Diagnostic preimage grew during observation.'); }
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await stat(file, { bigint: true });
    deadline.check();
    if (BigInt(length) !== before.size || [after, current].some(value => !value.isFile() || value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs)) {
      throw new FileObservationError('Diagnostic preimage changed during observation.');
    }
    return { sha256: hash.digest('hex'), bytes: length };
  } finally { await handle.close(); }
}
