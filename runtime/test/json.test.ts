import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { asInt64, asInteger, isCanonicalUtc, jsonBudgets, parseStrictJson, parseStrictJsonText, rawInteger, readBoundedFile, stringifyJson, StrictJsonError, toCanonicalUtc, type JsonBudget } from '../src/json.ts';

const budget: JsonBudget = { maxBytes: 4096, maxTokens: 1000, maxTextBytes: 2048 };

describe('bounded control JSON', () => {
  it('allocates for the observed file instead of retaining the whole admitted profile', async () => {
    const file = fileURLToPath(new URL('../companion.config.json', import.meta.url));
    const expected = await fs.readFile(file);
    const actual = await readBoundedFile(file, jsonBudgets['state-event'].maxBytes);
    assert.deepEqual(actual, expected);
    assert.equal(actual.buffer.byteLength, expected.length + 1);
    await assert.rejects(readBoundedFile(file, expected.length - 1), StrictJsonError);
  });
  it('retains Int64 versions exactly while leaving sequence bounds unchanged', () => {
    for (const value of [-9223372036854775808n, 9223372036854775807n, 9007199254740992n]) {
      const encoded = stringifyJson({ value });
      assert.equal(encoded, `{"value":${value}}`);
      const parsed = parseStrictJsonText(encoded) as Record<string, unknown>;
      assert.equal(asInt64(parsed['value']), value);
      assert.equal(asInteger(parsed['value']), undefined);
    }
    assert.equal(asInt64(parseStrictJsonText('2')), 2);
    assert.equal(asInt64(2n), 2);
    for (const text of ['9223372036854775808', '-9223372036854775809', '1.5', '1e3']) { assert.equal(asInt64(parseStrictJsonText(text)), undefined); }
    assert.equal(asInt64(9007199254740992), undefined);
  });

  it('enforces decoded property uniqueness without prototype mutation', () => {
    const escapedName = String.fromCharCode(92) + 'u0061';
    for (const text of ['{"a":1,"a":2}', `{"outer":{"a":1,"${escapedName}":2}}`]) {
      assert.throws(() => parseStrictJsonText(text, budget), StrictJsonError);
    }
    const value = parseStrictJsonText('{"__proto__":{"polluted":true},"A":1,"a":2}', budget) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), null);
    assert.equal(Object.hasOwn(value, '__proto__'), true);
    assert.equal(asInteger(value['A']), 1);
    assert.equal(asInteger(value['a']), 2);
    assert.equal(Object.hasOwn({}, 'polluted'), false);
  });

  it('rejects malformed syntax at every container boundary', () => {
    for (const text of ['', ' ', '[1,]', '{"a":1,}', '{"a" 1}', '{a:1}', '[}', '[]{}', 'true false', '01', '+1', '1.', '1e', 'NaN', '"bad\ntext"', '/*comment*/{}']) {
      assert.throws(() => parseStrictJsonText(text, budget), StrictJsonError, text);
    }
    assert.equal(stringifyJson(parseStrictJsonText(' \t {"a":[true,false,null,{},[]]} \r\n', budget), budget), '{"a":[true,false,null,{},[]]}');
  });

  it('checks strict UTF-8, BOMs and escaped surrogate validity', () => {
    for (const bytes of [[0xef, 0xbb, 0xbf, 0x7b, 0x7d], [0x22, 0xc0, 0xaf, 0x22], [0x22, 0xed, 0xa0, 0x80, 0x22]]) {
      assert.throws(() => parseStrictJson(Uint8Array.from(bytes), budget), StrictJsonError);
    }
    const escape = String.fromCharCode(92);
    assert.throws(() => parseStrictJsonText(`"${escape}ud800"`, budget), StrictJsonError);
    assert.equal(parseStrictJsonText(`"${escape}ud83d${escape}ude00"`, budget), String.fromCodePoint(0x1f600));
  });

  it('charges token boundaries and decoded UTF-8 text separately from source bytes', () => {
    assert.doesNotThrow(() => parseStrictJsonText('{"a":[]}', { ...budget, maxTokens: 5 }));
    assert.throws(() => parseStrictJsonText('{"a":[]}', { ...budget, maxTokens: 4 }), StrictJsonError);
    const escape = String.fromCharCode(92);
    const text = `{"${escape}u0061":"${escape}ud83d${escape}ude00"}`;
    assert.doesNotThrow(() => parseStrictJsonText(text, { ...budget, maxTextBytes: 5 }));
    assert.throws(() => parseStrictJsonText(text, { ...budget, maxTextBytes: 4 }), StrictJsonError);
    assert.throws(() => parseStrictJsonText('"abcd"', { ...budget, maxBytes: 5 }), StrictJsonError);
    assert.throws(() => stringifyJson({ a: 'abcd' }, { ...budget, maxTextBytes: 4 }), StrictJsonError);
  });

  it('accepts depth 64 and rejects another level before materialization', () => {
    assert.doesNotThrow(() => parseStrictJsonText('['.repeat(64) + '0' + ']'.repeat(64), budget));
    assert.throws(() => parseStrictJsonText('['.repeat(65) + '0' + ']'.repeat(65), budget), StrictJsonError);
  });

  it('preserves control-number lexemes and admits only safe integers to integer fields', () => {
    const text = '[9007199254740993,0.123456789012345678901,-0,1e400]';
    assert.equal(stringifyJson(parseStrictJsonText(text, budget), budget), text);
    assert.equal(asInteger(parseStrictJsonText('9007199254740993', budget)), undefined);
    assert.equal(asInteger(parseStrictJsonText('3.5', budget)), undefined);
    assert.equal(asInteger(parseStrictJsonText('1e0', budget)), undefined);
    assert.equal(asInteger(rawInteger(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    assert.throws(() => rawInteger(Number.MAX_SAFE_INTEGER + 1), StrictJsonError);
  });

  it('rejects impossible canonical timestamps and preserves seven fractional digits', () => {
    for (const value of ['2026-02-30T10:00:00.0000000Z', '2026-01-01T24:00:00.0000000Z', '0000-01-01T00:00:00.0000000Z', '2026-01-01T00:00:00.000Z']) {
      assert.equal(isCanonicalUtc(value), false, value);
    }
    assert.equal(isCanonicalUtc('2024-02-29T10:20:30.1234567Z'), true);
    assert.equal(toCanonicalUtc(new Date('2026-10-07T00:00:00.123Z')), '2026-10-07T00:00:00.1230000Z');
  });
});
