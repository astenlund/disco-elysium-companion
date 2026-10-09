import { open } from 'node:fs/promises';

export interface JsonBudget { readonly maxBytes: number; readonly maxTokens: number; readonly maxTextBytes: number }
export const jsonBudgets = {
  config: { maxBytes: 1_048_576, maxTokens: 65_536, maxTextBytes: 524_288 },
  'state-event': { maxBytes: 33_554_432, maxTokens: 2_000_000, maxTextBytes: 16_777_216 },
} as const satisfies Record<string, JsonBudget>;
export type JsonProfile = keyof typeof jsonBudgets;
export const maxDepth = 64;

export class StrictJsonError extends Error { override readonly name: string = 'StrictJsonError'; }
export type ProspectiveJsonDimension = 'bytes' | 'tokens' | 'text';
export interface ProspectiveJsonLimit { readonly dimension: ProspectiveJsonDimension; readonly actual: number; readonly limit: number }
export class ProspectiveJsonBudgetError extends StrictJsonError {
  override readonly name = 'ProspectiveJsonBudgetError';
  readonly limits: readonly ProspectiveJsonLimit[];
  readonly document: string | null;
  constructor(limits: readonly ProspectiveJsonLimit[], document: string | null = null) {
    super('Prospective JSON document exceeds its resource budget.');
    if (limits.length === 0 || limits.some(item => !['bytes', 'tokens', 'text'].includes(item.dimension)
      || !Number.isSafeInteger(item.actual) || !Number.isSafeInteger(item.limit) || item.limit <= 0 || item.actual <= item.limit)) {
      throw new RangeError('Prospective JSON limit evidence is invalid.');
    }
    this.limits = Object.freeze(limits.map(item => Object.freeze({ ...item }))); this.document = document;
  }
}
export type ProspectiveJsonFailure = (error: ProspectiveJsonBudgetError) => Error;
type BudgetExceeded = (limits: readonly ProspectiveJsonLimit[]) => never;
export interface RawNumber { readonly rawJSON: string }
export type ControlInt64 = number | bigint;
export type JsonValue = null | boolean | string | RawNumber | JsonValue[] | { [key: string]: JsonValue };

declare global {
  interface JSON {
    rawJSON(text: string): RawNumber;
    isRawJSON(value: unknown): boolean;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function resolveBudget(profile: JsonProfile | JsonBudget): JsonBudget {
  const budget = typeof profile === 'string' ? jsonBudgets[profile] : profile;
  if (budget === undefined || ![budget.maxBytes, budget.maxTokens, budget.maxTextBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new StrictJsonError('Invalid JSON budget.');
  }

  return budget;
}

// Control metadata only. Source payloads and context rendering belong to the PowerShell codec.
class JsonReader {
  private offset = 0;
  private tokens = 0;
  private textBytes = 0;
  private readonly text: string;
  private readonly budget: JsonBudget;

  private readonly exceeded: BudgetExceeded | undefined;
  constructor(text: string, budget: JsonBudget, exceeded?: BudgetExceeded) { this.text = text; this.budget = budget; this.exceeded = exceeded; }

  read(): JsonValue {
    const value = this.value(0);
    this.whitespace();
    if (this.offset !== this.text.length) { throw new StrictJsonError('Trailing JSON content.'); }

    return value;
  }

  private whitespace(): void {
    while (' \t\r\n'.includes(this.text[this.offset] ?? '\0')) { this.offset += 1; }
  }

  private charge(value?: string): void {
    this.tokens += 1;
    if (value !== undefined) {
      if (!value.isWellFormed()) { throw new StrictJsonError('Invalid Unicode scalar in JSON string.'); }
      this.textBytes += Buffer.byteLength(value, 'utf8');
    }
    if (this.tokens > this.budget.maxTokens || this.textBytes > this.budget.maxTextBytes) {
      const limits: ProspectiveJsonLimit[] = [];
      if (this.tokens > this.budget.maxTokens) { limits.push({ dimension: 'tokens', actual: this.tokens, limit: this.budget.maxTokens }); }
      if (this.textBytes > this.budget.maxTextBytes) { limits.push({ dimension: 'text', actual: this.textBytes, limit: this.budget.maxTextBytes }); }
      this.exceeded?.(limits);
      throw new StrictJsonError('JSON exceeds its token or decoded-text budget.');
    }
  }

  private string(): string {
    const start = this.offset++;
    while (this.offset < this.text.length) {
      const next = this.text[this.offset++];
      if (next === '\\') { this.offset += 1; }
      else if (next === '"') {
        let value: string;
        try { value = JSON.parse(this.text.slice(start, this.offset)) as string; }
        catch { throw new StrictJsonError('Invalid JSON string.'); }
        this.charge(value);

        return value;
      }
    }
    throw new StrictJsonError('Unterminated JSON string.');
  }

  private value(depth: number): JsonValue {
    this.whitespace();
    const next = this.text[this.offset];
    if (next === '"') { return this.string(); }
    if (next === '{' || next === '[') {
      if (depth >= maxDepth) { throw new StrictJsonError('JSON exceeds its depth budget.'); }

      return next === '{' ? this.object(depth + 1) : this.array(depth + 1);
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(literal, this.offset)) {
        this.offset += literal.length;
        this.charge();

        return value;
      }
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    number.lastIndex = this.offset;
    const match = number.exec(this.text);
    if (match === null) { throw new StrictJsonError('Expected a JSON value.'); }
    this.offset = number.lastIndex;
    this.charge();

    return JSON.rawJSON(match[0]);
  }

  private object(depth: number): { [key: string]: JsonValue } {
    const result: { [key: string]: JsonValue } = Object.create(null);
    this.offset += 1;
    this.charge();
    this.whitespace();
    if (this.text[this.offset] !== '}') {
      for (;;) {
        this.whitespace();
        if (this.text[this.offset] !== '"') { throw new StrictJsonError('Expected a JSON property.'); }
        const key = this.string();
        if (Object.hasOwn(result, key)) { throw new StrictJsonError('Duplicate JSON property.'); }
        this.whitespace();
        if (this.text[this.offset++] !== ':') { throw new StrictJsonError('Expected a JSON colon.'); }
        result[key] = this.value(depth);
        this.whitespace();
        if (this.text[this.offset] !== ',') { break; }
        this.offset += 1;
      }
    }
    if (this.text[this.offset++] !== '}') { throw new StrictJsonError('Expected a JSON object end.'); }
    this.charge();

    return result;
  }

  private array(depth: number): JsonValue[] {
    const result: JsonValue[] = [];
    this.offset += 1;
    this.charge();
    this.whitespace();
    if (this.text[this.offset] !== ']') {
      for (;;) {
        result.push(this.value(depth));
        this.whitespace();
        if (this.text[this.offset] !== ',') { break; }
        this.offset += 1;
      }
    }
    if (this.text[this.offset++] !== ']') { throw new StrictJsonError('Expected a JSON array end.'); }
    this.charge();

    return result;
  }
}

function parseJsonBytes(bytes: Uint8Array, profile: JsonProfile | JsonBudget, exceeded?: BudgetExceeded): JsonValue {
  const budget = resolveBudget(profile);
  if (bytes.byteLength > budget.maxBytes) {
    exceeded?.([{ dimension: 'bytes', actual: bytes.byteLength, limit: budget.maxBytes }]);
    throw new StrictJsonError('JSON exceeds its byte budget.');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { throw new StrictJsonError('JSON carries a byte order mark.'); }
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { throw new StrictJsonError('JSON is not strict UTF-8.'); }

  return new JsonReader(text, budget, exceeded).read();
}

export function parseStrictJson(bytes: Uint8Array, profile: JsonProfile | JsonBudget = 'config'): JsonValue {
  return parseJsonBytes(bytes, profile);
}

export function parseStrictJsonText(text: string, profile: JsonProfile | JsonBudget = 'config'): JsonValue {
  if (!text.isWellFormed()) { throw new StrictJsonError('Invalid Unicode scalar in JSON text.'); }

  return parseStrictJson(Buffer.from(text, 'utf8'), profile);
}

function serializeJson(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item); }
  catch { throw new StrictJsonError('Value cannot be serialized as JSON.'); }
  if (text === undefined) { throw new StrictJsonError('Value has no JSON representation.'); }
  return text;
}

export function stringifyJson(value: unknown, profile: JsonProfile | JsonBudget = 'config'): string {
  const text = serializeJson(value);
  parseStrictJsonText(text, profile);
  return text;
}

// Only callers about to publish a document select this budget signal. Parsing
// existing authority and comparing retained metadata keep their original class.
export function stringifyProspectiveJson(value: unknown, profile: JsonProfile | JsonBudget = 'config', document: string | null = null, failure?: ProspectiveJsonFailure): string {
  const text = serializeJson(value);
  parseJsonBytes(Buffer.from(text, 'utf8'), profile, limits => {
    const error = new ProspectiveJsonBudgetError(limits, document);
    throw failure?.(error) ?? error;
  });
  return text;
}

export class FileReadRaceError extends Error { override readonly name = 'FileReadRaceError'; }

export async function readBoundedFile(file: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > jsonBudgets['state-event'].maxBytes) { throw new StrictJsonError('Invalid file budget.'); }
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) { throw new StrictJsonError('Expected a regular JSON file.'); }
    if (stat.size > BigInt(maxBytes)) { throw new StrictJsonError('JSON file exceeds its byte budget.'); }
    const observedLength = Number(stat.size);
    const bytes = Buffer.alloc(observedLength + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) { break; }
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length !== observedLength || after.size !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      throw new FileReadRaceError('JSON file changed during its bounded read.');
    }

    return bytes.subarray(0, length);
  }
  finally { await handle.close(); }
}

export async function readJsonFile(file: string, profile: JsonProfile = 'config'): Promise<JsonValue> {
  return parseStrictJson(await readBoundedFile(file, resolveBudget(profile).maxBytes), profile);
}

export function isRawNumber(value: unknown): value is RawNumber {
  return typeof value === 'object' && value !== null && JSON.isRawJSON(value);
}

export function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isRawNumber(value);
}

export function hasExactKeys(value: unknown, keys: readonly string[]): value is { [key: string]: JsonValue } {
  if (!isObject(value)) { return false; }

  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function asInteger(value: unknown): number | undefined {
  const text = isRawNumber(value) ? value.rawJSON : typeof value === 'number' ? String(value) : undefined;
  if (text === undefined || !/^-?(0|[1-9][0-9]*)$/.test(text)) { return undefined; }
  const result = Number(text);

  return Number.isSafeInteger(result) ? result : undefined;
}

// Version fields share the core's signed Int64 domain. Counters and sequences keep
// using asInteger so their explicit JavaScript-safe bounds do not change.
export function asInt64(value: unknown): ControlInt64 | undefined {
  if (typeof value === 'number') { return Number.isSafeInteger(value) ? value : undefined; }
  let integer: bigint;
  if (typeof value === 'bigint') { integer = value; }
  else {
    if (!isRawNumber(value) || value.rawJSON.length > 20 || !/^-?(0|[1-9][0-9]*)$/.test(value.rawJSON)) { return undefined; }
    integer = BigInt(value.rawJSON);
  }
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) { return undefined; }
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}

export function rawInteger(value: number): RawNumber {
  if (!Number.isSafeInteger(value)) { throw new StrictJsonError('Expected a safe integer.'); }

  return JSON.rawJSON(String(value));
}

export function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z$/.test(value) || value.startsWith('0000')) { return false; }
  const date = new Date(value);

  return Number.isFinite(date.getTime()) && date.toISOString() === value.slice(0, 23) + 'Z';
}

export function utcNow(): string { return toCanonicalUtc(new Date()); }
export function toCanonicalUtc(date: Date): string { return date.toISOString().replace(/\.([0-9]{3})Z$/, '.$10000Z'); }
export function isLowerHex(value: unknown, length: number): value is string { return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value); }
