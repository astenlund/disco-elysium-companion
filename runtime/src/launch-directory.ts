import path from 'node:path';

import { ConfigurationError } from './config.ts';

/**
 * The longest working directory Windows starts a process in. Measured on the Go helper path, where the broker and the
 * owned child both start in the companion root: 258 characters launched and 259 failed, and a plain Node spawn agrees.
 */
export const maxLaunchDirectoryLength = 258;

/** The longest executable path Windows starts, measured on the same host: a 259-character path started and 260 failed. */
export const maxLaunchExecutableLength = 259;

/**
 * Why a launch from `relative` beneath the companion root cannot start, or null when it can. The message gives the root's
 * length against the longest root this launch allows, since moving the root is the remedy, and never names the path.
 */
export function launchDirectoryRefusal(root: string, relative = ''): string | null {
  const rootLength = path.win32.resolve(root).length;
  const allowed = maxLaunchDirectoryLength - (path.win32.resolve(root, relative).length - rootLength);
  if (rootLength <= allowed) { return null; }

  return `The companion root has ${rootLength} characters, but this launch needs one of at most ${allowed}: Windows cannot start a process in a working directory longer than ${maxLaunchDirectoryLength} characters. Move the companion root to a shorter path.`;
}

/** Refuses, as an invalid configuration, a companion root too long for a launch from `relative` beneath it. */
export function admitLaunchRoot(root: string, relative = ''): void {
  const refusal = launchDirectoryRefusal(root, relative);
  if (refusal !== null) { throw new ConfigurationError(refusal); }
}

/** Why the executable at `file` cannot start, or null when it can. The message gives lengths only, never the path. */
export function launchExecutableRefusal(file: string): string | null {
  const length = path.win32.resolve(file).length;
  if (length <= maxLaunchExecutableLength) { return null; }

  return `The executable path has ${length} characters, but Windows cannot start an executable whose path is longer than ${maxLaunchExecutableLength} characters. Move the companion root to a shorter path.`;
}

/** Refuses, as an invalid configuration, an executable whose path is too long to start. */
export function admitLaunchExecutable(file: string): void {
  const refusal = launchExecutableRefusal(file);
  if (refusal !== null) { throw new ConfigurationError(refusal); }
}
