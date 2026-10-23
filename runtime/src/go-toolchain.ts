/**
 * The pinned Go toolchain the helper image is built with. It imports nothing, so both the release manifest checks and the
 * refusal remedies that name the required version can depend on it.
 */
export const goToolchain = { name: 'go', version: 'go1.26.0', target: 'windows/amd64', amd64: 'v1',
  flags: ['-buildvcs=false', '-trimpath', '-ldflags=-buildid='] } as const;
