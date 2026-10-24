import { goToolchain } from './go-toolchain.ts';

/** Every reason a native helper refusal can carry, each with its own remedy; the toolchain remedies name the pinned version. */
export const nativeHelperReasons = {
  admission: 'The installation folder, its .tmp folder or runtime/native is not an ordinary directory. Run the companion from an ordinary directory.',
  toolchainMissing: `Go is not on PATH. Install Go ${goToolchain.version} and retry.`,
  toolchainVersion: `The Go on PATH is not ${goToolchain.version}. Install Go ${goToolchain.version} and retry.`,
  sourceMismatch: 'The native helper sources do not match the reviewed manifest. Restore a committed checkout and retry.',
  outputMismatch: `The native helper built with Go ${goToolchain.version} does not match the reviewed pin. Report this; the build is not reproducible here.`,
  buildFailed: `The native helper build failed or timed out with Go ${goToolchain.version}. Check the toolchain and retry.`,
  buildGuardHeld: 'Another start is building the native helper. Retry when that build finishes.',
  publicationFailed: 'The built native helper could not be published. Close any running chat and retry.',
  imageInUse: 'Another process, such as a running chat, holds the native helper image. Close it and retry.',
  imageAbsent: 'The native helper image is absent. Run chat once to build it.',
  imagePinMismatch: 'The native helper image does not match its pin. Run chat once to rebuild it.',
  serviceStart: 'The native helper service did not start or verify. Rerun chat, which rebuilds the image when it fails its pin.',
  imageIdentityMismatch: 'The running native helper image differs from the one verified before launch. Rerun chat, which rebuilds the image when it fails its pin.',
  bindFailed: 'The native helper could not bind this scope. End any other runtime of this scope and retry.',
  unavailable: 'The native helper service can no longer serve: its single restart is spent, its replacement failed, or it was closed. Restart the runtime.',
} as const;

export type NativeHelperReason = keyof typeof nativeHelperReasons;

/** The one native helper refusal: code nativeHelperUnavailable with one reason from the closed list. */
export class NativeHelperUnavailableError extends Error {
  override readonly name = 'NativeHelperUnavailableError';
  readonly code = 'nativeHelperUnavailable';
  readonly reason: NativeHelperReason;

  /** A detail, such as the build directory a leftover process holds, follows the reason's remedy in the message. */
  constructor(reason: NativeHelperReason, detail?: string) {
    super(detail === undefined ? nativeHelperReasons[reason] : `${nativeHelperReasons[reason]} ${detail}`);
    this.reason = reason;
  }
}
