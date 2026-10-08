import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

export class RuntimeAlreadyRunningError extends Error {
  override readonly name = 'RuntimeAlreadyRunningError';
  readonly code = 'runtimeAlreadyRunning';
}

export interface InstanceGuard {
  readonly held: boolean;
  release(): Promise<void>;
}

export function guardPipeName(canonicalCandidate: string, scope: 'runtime' | 'file-tools' = 'runtime'): string {
  return ['', '', '.', 'pipe', `game-companion-${scope}-${guardScopeToken(canonicalCandidate)}`].join(path.win32.sep);
}

export function guardScopeToken(canonicalCandidate: string): string {
  if (process.platform !== 'win32' || !path.win32.isAbsolute(canonicalCandidate) || !canonicalCandidate.isWellFormed()) {
    throw new Error('A canonical Windows path is required for the instance guard.');
  }
  return createHash('sha256').update(canonicalCandidate.toLowerCase(), 'utf8').digest('hex').slice(0, 32);
}

// Admission supplies the canonical existing prefix and any safe missing suffix before this call.
export function takeInstanceGuard(canonicalCandidate: string, onLost: (error: Error) => void, scope: 'runtime' | 'file-tools' = 'runtime'): Promise<InstanceGuard> {
  const name = guardPipeName(canonicalCandidate, scope);

  return new Promise((resolve, reject) => {
    let acquired = false;
    let held = false;
    let releasing = false;
    let releasePromise: Promise<void> | null = null;
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
    server.on('error', error => {
      held = false;
      if (!acquired) {
        const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
        reject(busy ? new RuntimeAlreadyRunningError('Another runtime owns this scope.') : error);
      } else if (!releasing) {
        onLost(error);
      }
    });
    server.on('close', () => {
      held = false;
      if (acquired && !releasing) { onLost(new Error('The instance guard closed unexpectedly.')); }
    });
    server.listen(name, () => {
      acquired = true;
      held = true;
      server.unref();
      resolve({
        get held(): boolean { return held; },
        release(): Promise<void> {
          if (releasePromise !== null) { return releasePromise; }
          releasing = true;
          held = false;
          releasePromise = new Promise<void>((done, fail) => {
            server.close(error => {
              if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') { fail(error); }
              else { done(); }
            });
          });

          return releasePromise;
        },
      });
    });
  });
}
