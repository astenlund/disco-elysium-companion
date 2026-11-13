import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const holderScript = fileURLToPath(new URL('../fixtures/Exclusive-FileHandle.ps1', import.meta.url));

export interface ExclusiveHold { release(): Promise<void> }

/**
 * Holds an existing file open without sharing in another process until released, so no open, read or delete of it can
 * succeed meanwhile. Rejects, with the holder stopped, when the holder cannot take the file.
 */
export async function holdExclusively(file: string): Promise<ExclusiveHold> {
  const holder = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', holderScript, '-Path', file], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '';
  holder.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString('utf8')).slice(-2000); });
  const exited = new Promise<number | null>((resolve, reject) => { holder.once('close', resolve); holder.once('error', reject); });
  void exited.catch(() => undefined);
  let released: Promise<void> | null = null;
  const release = (): Promise<void> => {
    released ??= (async () => {
      holder.stdin.end();
      const code = await exited;
      if (code !== 0) { throw new Error(`The exclusive holder exited with ${code}: ${error}`); }
    })();

    return released;
  };
  const lines = createInterface({ input: holder.stdout });
  try {
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done || first.value !== 'ready') { throw new Error(`The exclusive holder did not take the file: ${error}`); }
  }
  catch (failure) {
    await release().catch(() => undefined);
    throw failure;
  }
  finally { lines.close(); }

  return { release };
}
