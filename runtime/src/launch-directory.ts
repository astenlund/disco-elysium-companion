import path from 'node:path';

import { helperImageFile, helperModule } from './compiled-image-release.ts';
import { ConfigurationError } from './config.ts';

/**
 * The longest working directory Windows starts a process in. Measured on the Go helper path, where the broker and the
 * owned child both start in the companion root: 258 characters launched and 259 failed, and a plain Node spawn agrees.
 */
export const maxLaunchDirectoryLength = 258;

/**
 * The longest executable path Node's child_process.spawn starts, measured on the same host: 259 characters started and
 * 260 failed. It bounds the helper image, which the runtime starts through Node spawn. The Go broker's StartProcess,
 * which starts owned children, started 270-character paths on that host, so this does not bound what the broker starts.
 */
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

/** Why Node spawn cannot start the helper image at `file`, or null when it can. The message gives lengths only, never the path. */
export function launchExecutableRefusal(file: string): string | null {
  const length = path.win32.resolve(file).length;
  if (length <= maxLaunchExecutableLength) { return null; }

  return `The helper image path has ${length} characters, but the runtime cannot start the helper image from a path longer than ${maxLaunchExecutableLength} characters. Move the companion root to a shorter path.`;
}

/** Refuses, as an invalid configuration, a helper image whose path is too long for Node spawn to start. */
export function admitLaunchExecutable(file: string): void {
  const refusal = launchExecutableRefusal(file);
  if (refusal !== null) { throw new ConfigurationError(refusal); }
}

/**
 * The longest companion root that these launches below it can start from: owned children in the root, the
 * helper build in its module directory and the core's adapter commands in adapters/<adapter> as working directories, and
 * the helper image as an executable. Adapter tools inside the core-resolved release folder are not covered here.
 */
export function installationRootBound(adapter: string): number {
  const depth = (relative: string): number => path.win32.join('', relative).length + 1;

  return Math.min(maxLaunchDirectoryLength, maxLaunchDirectoryLength - depth(helperModule), maxLaunchDirectoryLength - depth(path.win32.join('adapters', adapter)),
    maxLaunchExecutableLength - depth(helperImageFile));
}

/** Refuses, as an invalid configuration, a companion root longer than `installationRootBound`, naming that one bound. */
export function admitInstallationRoot(root: string, adapter: string): void {
  const rootLength = path.win32.resolve(root).length;
  const bound = installationRootBound(adapter);
  if (rootLength <= bound) { return; }

  throw new ConfigurationError(`The companion root has ${rootLength} characters, but this installation needs one of at most ${bound}: Windows cannot start a process in a working directory longer than ${maxLaunchDirectoryLength} characters, and the runtime cannot start the helper image from a path longer than ${maxLaunchExecutableLength}. Move the companion root to a shorter path.`);
}
