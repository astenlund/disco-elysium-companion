// runtime/companion.config.json: the checked-in runtime configuration. A missing file, an
// unknown member, or an invalid value is configurationInvalid.
import { isOpaqueToken } from './identity.ts';

import { asInteger, hasExactKeys, readJsonFile, StrictJsonError } from './json.ts';

export const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof effortLevels[number];

export interface ModelChoice { readonly model: string; readonly effort: Effort }

export interface RuntimeConfig {
  readonly configVersion: 1;
  readonly adapter: string;
  readonly game: string;
  readonly provider: { readonly model: string | null; readonly effort: Effort | null; readonly questionOverride: ModelChoice | null };
  readonly watcher: { readonly enabled: boolean };
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  readonly code = 'configurationInvalid';
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isEffort = (value: unknown): value is Effort => typeof value === 'string' && (effortLevels as readonly string[]).includes(value);

// One directory name: no separator, no drive or stream colon, and not a relative step.
export function isPathSegment(value: unknown): value is string {
  return nonEmpty(value) && !/[\\/:*?"<>|\u0000-\u001f]/.test(value) && value !== '.' && value !== '..' && value.trim() === value;
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const fail = (what: string): never => { throw new ConfigurationError(`companion.config.json: ${what}`); };
  if (!hasExactKeys(value, ['configVersion', 'adapter', 'game', 'provider', 'watcher'])) { fail('the root members must be exactly configVersion, adapter, game, provider, and watcher'); }
  const root = value as Record<string, unknown>;
  if (asInteger(root['configVersion']) !== 1) { fail('configVersion must be 1'); }
  if (!isPathSegment(root['adapter'])) { fail('adapter must be one adapter directory name'); }
  if (!isOpaqueToken(root['game'])) { fail('game must follow the shared opaque-token profile'); }
  const provider = root['provider'];
  if (!hasExactKeys(provider, ['model', 'effort', 'questionOverride'])) { fail('provider must have exactly model, effort, and questionOverride'); }
  const providerRecord = provider as Record<string, unknown>;
  const model = providerRecord['model'];
  if (model !== null && !nonEmpty(model)) { fail('provider.model must be a non-empty string or null'); }
  const effort = providerRecord['effort'];
  if (effort !== null && !isEffort(effort)) { fail(`provider.effort must be one of ${effortLevels.join(', ')} or null`); }
  const override = providerRecord['questionOverride'];
  let questionOverride: ModelChoice | null = null;
  if (override !== null) {
    if (!hasExactKeys(override, ['model', 'effort'])) { fail('provider.questionOverride must have exactly model and effort, or be null'); }
    const overrideRecord = override as Record<string, unknown>;
    if (!nonEmpty(overrideRecord['model']) || !isEffort(overrideRecord['effort'])) { fail('provider.questionOverride needs a model string and an effort level'); }
    questionOverride = { model: overrideRecord['model'] as string, effort: overrideRecord['effort'] as Effort };
  }
  const watcher = root['watcher'];
  if (!hasExactKeys(watcher, ['enabled']) || typeof (watcher as Record<string, unknown>)['enabled'] !== 'boolean') { fail('watcher must be exactly { "enabled": <boolean> }'); }

  return {
    configVersion: 1,
    adapter: root['adapter'] as string,
    game: root['game'] as string,
    provider: { model: model as string | null, effort: effort as Effort | null, questionOverride },
    watcher: { enabled: (watcher as Record<string, boolean>)['enabled'] === true },
  };
}

export async function loadRuntimeConfig(file: string): Promise<RuntimeConfig> {
  try { return parseRuntimeConfig(await readJsonFile(file, 'config')); }
  catch (error) {
    if (error instanceof ConfigurationError) { throw error; }
    if (error instanceof StrictJsonError) { throw new ConfigurationError(`companion.config.json is not strict JSON: ${error.message}`); }
    throw new ConfigurationError(`companion.config.json cannot be read: ${(error as Error).message}`);
  }
}
