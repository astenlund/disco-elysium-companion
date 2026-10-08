import { isOpaqueToken } from './identity.ts';
import { asInt64, asInteger, hasExactKeys, isCanonicalUtc, isLowerHex, isObject, type ControlInt64, type JsonValue } from './json.ts';

export class ControlDocumentError extends Error { override readonly name = 'ControlDocumentError'; }
export function requireControl(condition: unknown): asserts condition { if (!condition) { throw new ControlDocumentError('Persisted control metadata is invalid.'); } }
export function controlObject(value: unknown): { [key: string]: JsonValue } { requireControl(isObject(value)); return value; }
export function controlFields(value: unknown, fields: readonly string[]): { [key: string]: JsonValue } { requireControl(hasExactKeys(value, fields)); return value; }
export function controlInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = asInteger(value);
  requireControl(result !== undefined && result >= minimum && result <= maximum);
  return result;
}
export function controlToken(value: unknown): string { requireControl(isOpaqueToken(value)); return value; }
export function controlInt64(value: unknown): ControlInt64 { const result = asInt64(value); requireControl(result !== undefined); return result; }
export function controlHash(value: unknown, length = 64): string { requireControl(isLowerHex(value, length)); return value; }
export function controlUtc(value: unknown): string { requireControl(isCanonicalUtc(value)); return value; }
export function controlChoice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  requireControl(typeof value === 'string' && choices.includes(value));
  return value;
}
export function controlList<T>(value: unknown, parse: (item: JsonValue, index: number) => T): readonly T[] {
  requireControl(Array.isArray(value));
  return Object.freeze(value.map((item, index) => parse(item as JsonValue, index)));
}
export function controlNullable<T>(value: JsonValue | undefined, parse: (item: JsonValue) => T): T | null {
  requireControl(value !== undefined);
  return value === null ? null : parse(value);
}
