import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ImagePinRequest } from '../../src/bootstrap-image-receipt.ts';

/** The installation sources the selected bootstrap captures and hashes before any helper starts. */
export const capturedBootstrapSources = ['runtime/scripts/Get-BootstrapScope.ps1', 'runtime/scripts/NativeFiles.cs', 'runtime/scripts/NativeImagePins.cs',
  'runtime/scripts/BootstrapImagePins.ps1', 'runtime/scripts/BootstrapImagePackage.ps1'] as const;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A ready pin receipt for the request, holding every directory from the volume root down to the images, then both images. */
export function readyImagePinReceipt(request: ImagePinRequest, candidateScopePath: string) {
  const directories: string[] = [];
  for (let location = path.win32.dirname(request.brokerPath); ; location = path.win32.dirname(location)) {
    directories.unshift(location);
    if (path.win32.dirname(location) === location) { break; }
  }
  const paths = [...directories.map(location => ({ kind: 'directory', path: location })),
    { kind: 'broker', path: request.brokerPath }, { kind: 'observer', path: request.observerPath }];

  return { status: 'ready', version: 1, nonce: request.nonce, targetProcessId: request.targetProcessId,
    targetCreated: request.targetCreated, artifactGeneration: request.artifactGeneration,
    installationRootSha256: sha(request.installationRoot), candidateScopePathSha256: sha(candidateScopePath),
    brokerSha256: request.brokerSha256, observerSha256: request.observerSha256,
    handles: paths.map((entry, index) => ({ ...entry, volume: '1'.repeat(16),
      identity: (index + 1).toString(16).padStart(32, '0'),
      handle: (index + 1).toString(16).padStart(16, '0') })) };
}
