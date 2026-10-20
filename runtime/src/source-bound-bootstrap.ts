import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PathInspector } from './admission.ts';
import { parseImagePinReceipt, type ImagePinReceipt, type ImagePinRequest } from './bootstrap-image-receipt.ts';
import { readBoundedPrivateFile } from './compiled-broker.ts';
import { compiledBrokerSha256, compiledImageGeneration, compiledObserverSha256,
  parseCompiledImageRelease } from './compiled-image-release.ts';
import { newIdentity } from './identity.ts';
import { parseStrictJson } from './json.ts';
import { bundleNativeImageSources } from './native-image-source.ts';
import type { ProcessIdentity } from './process.ts';
import { parseCombinedScopeReply, type ScopeCandidate } from './scope.ts';

const installationRoot = path.win32.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const sourceHashes = {
  bootstrap: 'a78f1e990205827350f7fbc75abdf14757b4e02ce49ba3b3ddd4658669f6eb62',
  nativeFiles: 'e7c93e4f5b12a3cfa5ee9ba5f9b99e6f051ae438d5466894ed669e1d400c7b6f',
  nativePins: '06c4e62f3197ebae505cfe23aedf236d0db9f201581eb9cdd62364804f3546e5',
  pinScript: '1ecc3b3c01e2f5fe03e110f4a28fde65628e0d4f3bd16472991b404e3f22c85a',
  packageScript: 'b073b787367b6459f7a8eda94f9466db6535e88cc879b4bf7f49a94750f1014a',
} as const;

export type SourceBoundBootstrapReason = 'invalidInputs' | 'sourceChanged' | 'expressionTooLarge' | 'helperFailed' | 'replyInvalid'
  | 'releaseMismatch';

/**
 * A phase-A scope admission refusal, so it carries the umbrella `dataRootUnavailable` code. The message is the only
 * player-facing text; reason and detail are bounded diagnostics for private fixtures.
 */
export class SourceBoundBootstrapError extends Error {
  override readonly name = 'SourceBoundBootstrapError';
  readonly code = 'dataRootUnavailable';
  readonly reason: SourceBoundBootstrapReason;
  readonly detail: string | null;

  constructor(reason: SourceBoundBootstrapReason, detail: string | null = null, options?: ErrorOptions) {
    super('Source-bound bootstrap is unavailable.', options);
    this.reason = reason;
    this.detail = detail;
  }
}

export interface SourceBoundBootstrapResult {
  readonly candidate: ScopeCandidate;
  readonly imagePins: ImagePinReceipt;
  readonly request: ImagePinRequest;
}

const detailLimit = 240;

// Keeps only printable ASCII, collapsed and bounded to its tail, so diagnostics cannot carry control bytes.
function printableTail(text: string): string {
  const printable = text.replace(/[^ -~]+/g, ' ').replace(/ +/g, ' ').trim();
  return printable.length > detailLimit ? printable.slice(printable.length - detailLimit) : printable;
}

/** Describes a failed helper by its exit code and the printable tail of its stderr. */
export function helperFailureDetail(exitCode: number | null, stderr: Uint8Array): string {
  const tail = printableTail(Buffer.from(stderr).toString('latin1'));
  return `exit=${exitCode ?? 'none'}${tail.length > 0 ? `; ${tail}` : ''}`;
}

function causeDetail(error: unknown): string {
  return printableTail(error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
}

function capturedSource(imageRoot: string, relative: string, expectedHash: string): Buffer {
  let bytes: Buffer;
  try { bytes = readBoundedPrivateFile(path.win32.join(imageRoot, relative), 1_048_576); }
  catch (error) { throw new SourceBoundBootstrapError('sourceChanged', relative, { cause: error }); }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) { throw new SourceBoundBootstrapError('sourceChanged', relative); }
  return bytes;
}

function base64(bytes: Uint8Array): string { return `'${Buffer.from(bytes).toString('base64')}'`; }

/** @internal The token reaches the in-memory transport, which refuses to send the pin-transfer helper without it. */
export async function observeSourceBoundBootstrap(token: unknown, inspector: PathInspector, parent: ProcessIdentity,
  companionRoot: string, game: string, imageRoot: string, environment: NodeJS.ProcessEnv,
  markPossibleTransfer: () => void): Promise<SourceBoundBootstrapResult> {
  const relativeImageRoot = path.win32.relative(installationRoot, imageRoot);
  if (path.win32.resolve(companionRoot) !== companionRoot || path.win32.resolve(imageRoot) !== imageRoot
    || relativeImageRoot === '..'
    || relativeImageRoot.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relativeImageRoot)
    || !Number.isSafeInteger(parent.pid) || parent.pid < 1 || parent.pid > 2147483647
    || !/^[1-9][0-9]{0,18}$/.test(parent.created)) { throw new SourceBoundBootstrapError('invalidInputs'); }
  const bootstrap = capturedSource(imageRoot, 'runtime/scripts/Get-BootstrapScope.ps1', sourceHashes.bootstrap);
  const nativeFiles = capturedSource(imageRoot, 'runtime/scripts/NativeFiles.cs', sourceHashes.nativeFiles);
  const nativePins = capturedSource(imageRoot, 'runtime/scripts/NativeImagePins.cs', sourceHashes.nativePins);
  const pinScript = capturedSource(imageRoot, 'runtime/scripts/BootstrapImagePins.ps1', sourceHashes.pinScript);
  const packageScript = capturedSource(imageRoot, 'runtime/scripts/BootstrapImagePackage.ps1', sourceHashes.packageScript);
  const bundled = Buffer.from(bundleNativeImageSources(nativeFiles, nativePins), 'utf8');
  const request: ImagePinRequest = Object.freeze({ version: 1, nonce: newIdentity(), targetProcessId: parent.pid,
    targetCreated: parent.created, companionRoot, installationRoot: imageRoot, game,
    artifactGeneration: compiledImageGeneration,
    brokerPath: path.win32.join(imageRoot, 'runtime/native/go-broker.exe'),
    observerPath: path.win32.join(imageRoot, 'runtime/native/job-observer.exe'),
    brokerSha256: compiledBrokerSha256, observerSha256: compiledObserverSha256 });
  const decode = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${base64(packageScript)}))`;
  const argumentsBase64 = [bootstrap, bundled, pinScript, Buffer.from(JSON.stringify(request), 'utf8'),
    Buffer.from(companionRoot, 'utf8'), Buffer.from(game, 'utf8')].map(base64);
  const expression = Buffer.from(`& ([ScriptBlock]::Create(${decode})) ${argumentsBase64.join(' ')}${String.fromCharCode(10)}`, 'ascii');
  if (expression.byteLength > 1_048_576) { throw new SourceBoundBootstrapError('expressionTooLarge'); }

  markPossibleTransfer();
  const reply = await inspector.metadataStdinExpression(token, expression, companionRoot, environment);
  if (reply.exitCode !== 0 || reply.stderr.byteLength !== 0) {
    throw new SourceBoundBootstrapError('helperFailed', helperFailureDetail(reply.exitCode, reply.stderr));
  }
  let combined: ReturnType<typeof parseCombinedScopeReply>;
  let imagePins: ImagePinReceipt;
  try {
    combined = parseCombinedScopeReply(parseStrictJson(reply.stdout), companionRoot, game, true);
    imagePins = parseImagePinReceipt(combined.imagePins!, request, combined.candidate.dataRoot);
  } catch (error) { throw new SourceBoundBootstrapError('replyInvalid', causeDetail(error), { cause: error }); }
  // The release parser refuses any generation or image digest other than the pinned constants the request carries.
  if (imagePins.status === 'ready') {
    try { parseCompiledImageRelease(readBoundedPrivateFile(path.win32.join(imageRoot, 'runtime/native/compiled-images.json'), 1_048_576)); }
    catch (error) { throw new SourceBoundBootstrapError('releaseMismatch', causeDetail(error), { cause: error }); }
  }

  return { candidate: combined.candidate, imagePins, request };
}
