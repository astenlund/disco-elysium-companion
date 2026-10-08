import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseStrictJson, stringifyJson } from '../src/json.ts';
import { freshGeneration, invalidatedSafety, parseStateSafety, SafetyUnavailableError } from '../src/safety-records.ts';

const scope = 'a'.repeat(64);
const owner = { operationId: `jr-${'b'.repeat(32)}`, episodeOrdinal: 0, activationId: 'c'.repeat(32) };
const witness = { scopeSha256: scope, owner, phase: 'active', successor: null, disclosure: null };
const safety = { stateSafetyVersion: 1, generation: 'd'.repeat(32), pendingCheck: null, correction: null, recoveryWitness: witness };
const parse = (value: unknown) => parseStateSafety(parseStrictJson(Buffer.from(stringifyJson(value), 'utf8')), scope);

describe('independent context safety authority', () => {
  it('rejects missing, foreign or contradictory witness shapes without initializing clean history', () => {
    assert.throws(() => parse({ ...safety, recoveryWitness: undefined }), SafetyUnavailableError);
    assert.throws(() => parse({ ...safety, recoveryWitness: { ...witness, scopeSha256: 'f'.repeat(64) } }), SafetyUnavailableError);
    assert.throws(() => parse({ ...safety, recoveryWitness: { ...witness, phase: 'awaitingDisclosure' } }), SafetyUnavailableError);
    assert.throws(() => parse({ ...safety, recoveryWitness: { ...witness, phase: 'transferring' } }), SafetyUnavailableError);
    assert.throws(() => parse({ ...safety, recoveryWitness: { ...witness, successor: owner } }), SafetyUnavailableError);
    assert.throws(() => parse({ ...safety, recoveryWitness: { ...witness, phase: 'transferring', successor: owner } }), SafetyUnavailableError);
    assert.throws(() => parse({ ...safety, generation: 'd'.repeat(32) + '\n' }), SafetyUnavailableError);
  });

  it('retains both owners through a transfer and keeps expired disclosure as historical evidence', () => {
    const successor = { operationId: `jr-${'1'.repeat(32)}`, episodeOrdinal: 2, activationId: '2'.repeat(32) };
    const transferring = parse({ ...safety, recoveryWitness: { ...witness, phase: 'transferring', successor } });
    assert.deepEqual(transferring.recoveryWitness!.owner, owner);
    assert.deepEqual(transferring.recoveryWitness!.successor, successor);
    const disclosure = { journalId: 'journal', eventId: '3'.repeat(32), sequence: 1, generation: '4'.repeat(32) };
    const pending = parse({ ...safety, recoveryWitness: { ...witness, phase: 'awaitingDisclosure', disclosure } });
    assert.notEqual(pending.generation, pending.recoveryWitness!.disclosure!.generation);
    assert.throws(() => parse({ ...safety, recoveryWitness: { ...witness, phase: 'awaitingDisclosure', disclosure: { ...disclosure, sequence: 0 } } }), SafetyUnavailableError);
  });

  it('carries the pending check, witness, correction identity and stronger rejection across invalidation', () => {
    const check = '5'.repeat(32);
    const correction = { correctionId: '6'.repeat(32), reason: 'coreRejected', recoveryOperationId: owner.operationId };
    const current = parse({ ...safety, pendingCheck: check, correction });
    const next = invalidatedSafety(current, 'contextUncertain', [], () => '7'.repeat(32));
    assert.equal(next.generation, '7'.repeat(32));
    assert.equal(next.pendingCheck, check);
    assert.deepEqual(next.correction, correction);
    assert.deepEqual(next.recoveryWitness, current.recoveryWitness);
    assert.equal(current.generation, safety.generation);
  });

  it('rejects all four generation collisions and malformed binding evidence', () => {
    let attempts = 0;
    assert.throws(() => freshGeneration(safety.generation, [], () => { attempts++; return safety.generation; }), SafetyUnavailableError);
    assert.equal(attempts, 4);
    const candidates = [safety.generation, '8'.repeat(32), '9'.repeat(32)];
    assert.equal(freshGeneration(safety.generation, ['8'.repeat(32)], () => candidates.shift()!), '9'.repeat(32));
    assert.throws(() => freshGeneration(safety.generation, ['corrupt']), SafetyUnavailableError);
  });

  it('adopts the oldest protected consumer obligation only when no correction already exists', () => {
    const token = '8'.repeat(32);
    const candidate = invalidatedSafety(parse(safety), 'contextUncertain', [], () => '7'.repeat(32), token);
    assert.equal(candidate.correction?.correctionId, token);
    assert.equal(candidate.correction?.reason, 'contextUncertain');
    assert.deepEqual(candidate.recoveryWitness, parse(safety).recoveryWitness);
    const correction = { correctionId: '6'.repeat(32), reason: 'coreRejected', recoveryOperationId: owner.operationId };
    const retained = invalidatedSafety(parse({ ...safety, correction }), 'contextUncertain', [], () => '7'.repeat(32), token);
    assert.deepEqual(retained.correction, correction);
    assert.throws(() => invalidatedSafety(parse(safety), 'contextUncertain', [], () => '7'.repeat(32), 'invalid'), SafetyUnavailableError);
  });
});
