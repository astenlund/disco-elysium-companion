/** Every reason a native helper refusal can carry, each with its own remedy. */
export const nativeHelperReasons = {
  admission: 'The installation folder, its .tmp folder or runtime/native is not an ordinary directory. Run the companion from an ordinary directory.',
  toolchainMissing: 'Go is not on PATH. Install Go go1.26.0 and retry.',
  toolchainVersion: 'The Go on PATH is not go1.26.0. Install Go go1.26.0 and retry.',
  sourceMismatch: 'The native helper sources do not match the reviewed manifest. Restore a committed checkout and retry.',
  outputMismatch: 'The native helper built with Go go1.26.0 does not match the reviewed pin. Report this; the build is not reproducible here.',
  buildFailed: 'The native helper build failed or timed out with Go go1.26.0. Check the toolchain and retry.',
  buildGuardHeld: 'Another start is building the native helper. Retry when that build finishes.',
  publicationFailed: 'The built native helper could not be published. Close any running chat and retry.',
  imageInUse: 'A running chat holds the native helper image. Close that chat and retry.',
  imageAbsent: 'The native helper image is absent. Run chat once to build it.',
  imagePinMismatch: 'The native helper image does not match its pin. Run chat once to rebuild it.',
  serviceStart: 'The native helper service did not start or verify. Rerun chat, which rebuilds the image when it fails its pin.',
  imageIdentityMismatch: 'The running native helper image differs from the one verified before launch. Rerun chat, which rebuilds the image when it fails its pin.',
  bindFailed: 'The native helper could not bind this scope. End any other runtime of this scope and retry.',
  unavailable: 'The native helper service is unavailable after its single restart. Restart chat.',
} as const;

export type NativeHelperReason = keyof typeof nativeHelperReasons;

/** The one native helper refusal: code nativeHelperUnavailable with one reason from the closed list. */
export class NativeHelperUnavailableError extends Error {
  override readonly name = 'NativeHelperUnavailableError';
  readonly code = 'nativeHelperUnavailable';
  readonly reason: NativeHelperReason;

  constructor(reason: NativeHelperReason) {
    super(nativeHelperReasons[reason]);
    this.reason = reason;
  }
}
