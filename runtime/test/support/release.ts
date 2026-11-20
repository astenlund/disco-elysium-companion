/**
 * Runs every release step in order, even after one rejects, so a failing release never skips the ones after it.
 * Once all steps have run, rethrows the single failure, or an AggregateError when several steps failed.
 */
export async function releaseAll(...steps: (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) { throw failures[0]; }
  if (failures.length > 1) { throw new AggregateError(failures, 'Several release steps failed.'); }
}

/**
 * One release step that runs `release` only after `close` resolves, for a guard that must stay held while a native
 * helper's exit is unverified (NativeHelper.close); a rejected close skips the release and fails the step.
 */
export function releaseAfter(close: () => unknown, release: () => unknown): () => Promise<void> {
  return async () => {
    await close();
    await release();
  };
}
