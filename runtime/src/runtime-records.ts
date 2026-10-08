import { controlFields, controlHash, controlInteger, controlNullable, controlUtc, requireControl } from './control-values.ts';
import type { JsonValue } from './json.ts';
import type { ProcessIdentity } from './process.ts';

export interface RuntimeRecord {
  readonly runtimeInstanceId: string;
  readonly startedAt: string;
  readonly cleanShutdown: boolean;
  readonly watcher: ProcessIdentity | null;
}

export function parseWatcherIdentity(value: JsonValue): ProcessIdentity {
  const item = controlFields(value, ['pid', 'created']);
  requireControl(typeof item['created'] === 'string' && /^[1-9][0-9]{0,18}$/.test(item['created']) && BigInt(item['created']) <= 9223372036854775807n);
  return Object.freeze({ pid: controlInteger(item['pid'], 1, 2147483647), created: item['created'] });
}

export function parseRuntimeRecord(value: JsonValue): RuntimeRecord {
  const item = controlFields(value, ['runtimeInstanceId', 'startedAt', 'cleanShutdown', 'watcher']);
  requireControl(typeof item['cleanShutdown'] === 'boolean');
  return Object.freeze({ runtimeInstanceId: controlHash(item['runtimeInstanceId'], 32), startedAt: controlUtc(item['startedAt']), cleanShutdown: item['cleanShutdown'], watcher: controlNullable(item['watcher'], parseWatcherIdentity) });
}
