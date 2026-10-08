import { requireControl } from '../control-values.ts';
import { newIdentity } from '../identity.ts';
import { isLowerHex } from '../json.ts';

export function allocateUniqueToken(forbidden: ReadonlySet<string>, mint: () => string = newIdentity): string {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = mint();
    requireControl(isLowerHex(token, 32));
    if (!forbidden.has(token)) { return token; }
  }
  throw new Error('Runtime identity collision retries exhausted.');
}
