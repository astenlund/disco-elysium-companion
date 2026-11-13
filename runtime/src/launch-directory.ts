import path from 'node:path';

/**
 * The longest working directory Windows starts a process in. Measured on the Go helper path, where the broker and the
 * owned child both start in the companion root: 258 characters launched and 259 failed with an opaque transport error.
 */
export const maxLaunchDirectoryLength = 258;

/** The reason a working directory cannot be launched from, naming lengths but never the path, or null when it fits. */
export function launchDirectoryRefusal(cwd: string): string | null {
  const length = path.win32.resolve(cwd).length;
  if (length <= maxLaunchDirectoryLength) { return null; }

  return `Windows cannot start a process in a working directory longer than ${maxLaunchDirectoryLength} characters; this one has ${length}. Move the companion root to a shorter path.`;
}
