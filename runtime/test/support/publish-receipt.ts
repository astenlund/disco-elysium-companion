import type { CoreResult, PublishReceipt } from '../../src/core-client.ts';

/** A successful core Publish result for the stub game; an 'unchanged' outcome with no warnings unless overridden. */
export function publishReceipt(overrides: Partial<PublishReceipt> = {}): CoreResult<PublishReceipt> {
  return { success: true, value: { outcome: 'unchanged', kind: null, logicalOutboxId: null, sequence: null, schemaVersion: 2, adapterVersion: 1, game: 'stubgame',
    targetIdentitySha256: null, targetGeneratedAt: null, baselineApplied: null, cacheDegraded: false, warnings: [], ...overrides } };
}
