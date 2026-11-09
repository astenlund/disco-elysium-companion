import { writeSync } from 'node:fs';

import { openBackend } from '../../../src/backend/index.ts';
import { testHelperImage } from '../../support/native-helper.ts';

// A refused start can keep the instance guard while its process lives, so a test that expects one opens the backend here.
try {
  const backend = await openBackend({ nativeImage: await testHelperImage(), companionRoot: process.argv[2]! });
  await backend.shutdown(true);
  writeSync(1, JSON.stringify({ opened: true, code: null }));
} catch (error) {
  writeSync(1, JSON.stringify({ opened: false, code: (error as { readonly code?: unknown }).code ?? null }));
}
process.exit(0);
