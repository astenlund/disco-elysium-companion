import type { ModelChoice } from './config.ts';

export class ProviderControlError extends Error { override readonly name = 'ProviderControlError'; }
export interface ModelControls { setModel(model?: string): Promise<void>; applyFlagSettings(settings: { effortLevel: ModelChoice['effort'] }): Promise<void> }

export async function boundedProviderControl<T>(start: () => Promise<T>, timeoutMs = 10000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) { throw new ProviderControlError('Provider control deadline is invalid.'); }
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expiry = new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new ProviderControlError('Provider control did not settle before its deadline.')), timeoutMs); });
    const result = await Promise.race([Promise.resolve().then(start), expiry]);
    if (performance.now() >= deadline) { throw new ProviderControlError('Provider control settled too late.'); }
    return result;
  } finally { if (timer !== undefined) { clearTimeout(timer); } }
}

// A failure can leave the session partly changed. The caller must close it and
// reconnect under the configured defaults; it must not send or infer a rollback.
export async function setModelChoice(controls: ModelControls, choice: ModelChoice): Promise<void> {
  await boundedProviderControl(() => controls.setModel(choice.model));
  await boundedProviderControl(() => controls.applyFlagSettings({ effortLevel: choice.effort }));
}
