// Runs one first-launch build of the installation in argv[2] with the toolchain directory in argv[3], so a test can kill
// this process in the middle of the build.
import { ensureNativeHelperImage } from '../../src/native-image.ts';

const [root, toolchain] = process.argv.slice(2);
if (root === undefined || toolchain === undefined) { throw new Error('Usage: native-build-child.ts <root> <toolchain directory>'); }
await ensureNativeHelperImage({ build: true, root, toolchainEnvironment: { ...process.env, PATH: toolchain } });
