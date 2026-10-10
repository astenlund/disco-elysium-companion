import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapacityObservation, capacitySlot, capacityTransitions, initialCapacity, isCapacityBlocked, RuntimeCapacityError } from '../../src/capacity.ts';
import { DataRootUnavailableError } from '../../src/admission.ts';
import { ResourceAuthority, type ResourceObservation } from '../../src/resource-lifecycle/resources.ts';
import { Kernel, type KernelInput } from '../../src/backend/kernel.ts';
import { CoordinatorBackend } from '../../src/backend/index.ts';
import { DeliveryCoordinator } from '../../src/backend/delivery.ts';
import type { BackendStatus } from '../../src/backend/api.ts';
import { jsonBudgets, parseStrictJson, ProspectiveJsonBudgetError, StrictJsonError, stringifyJson, stringifyProspectiveJson } from '../../src/json.ts';
import { FilePublisher } from '../../src/files.ts';
import { ScopeStorage } from '../../src/storage.ts';

function refusal(state: 'unavailable' | 'exhausted', kind: 'ordinary' | 'repair' | 'release' | 'maintenance' | 'runtimeMarker' | null = 'ordinary', dimensions = [state === 'unavailable' ? 'inventory' : 'uncompactedEvents']) {
  return new RuntimeCapacityError({ admitted: false, state, dimensions }, kind);
}
const complete: ResourceObservation = { complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 },
  freeBytes: 100000000000n, uncertainWorkspace: false, potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0 };
function fixture() {
  const scope = { companionRoot: 'C:/Git/disco-elysium-companion/.tmp/capacity-pure-model', dataRoot: 'C:/Git/disco-elysium-companion/.tmp/capacity-pure-model/data',
    game: 'stubgame', principal: 'principal', bindingSha256: 'a'.repeat(64), createdHere: false };
  const resources = new ResourceAuthority(scope, {} as never, {} as never);
  resources.capacity.admitted('runtimeMarker');
  const observations: unknown[] = [];
  const kernel = new Kernel({ scope, resources, storage: {}, inspector: {}, publisher: {}, supervisor: {}, guard: { held: true },
    config: { configVersion: 1, adapter: 'stub', game: 'stubgame', provider: { model: null, effort: null, questionOverride: null }, watcher: { enabled: false } },
    identities: { runtimeInstanceId: 'b'.repeat(32), runtimeSessionId: 'c'.repeat(32), adapterBindingEpoch: 'd'.repeat(32) },
    options: { companionRoot: scope.companionRoot, onStatus: (status: BackendStatus) => observations.push(status.capacity) } } as unknown as KernelInput);
  const backend = new CoordinatorBackend(kernel, { value: { runtimeInstanceId: kernel.identities.runtimeInstanceId, startedAt: '2026-10-09T00:00:00.0000000Z', cleanShutdown: false, watcher: null }, sha256: 'e'.repeat(64) });
  kernel.observeSafety = async () => ({ safety: null, operations: null, stateSafety: { state: 'unavailable', correction: null, carryRelease: 'unavailable' }, providerAllowed: false, failure: null });
  return { kernel, backend, resources, observations };
}
function assess(resources: ResourceAuthority, kind: 'ordinary' | 'release' | 'repair' | 'maintenance') {
  return resources.withTransition(kind, () => kind === 'maintenance' ? resources.reserveMaintenance() : resources.reserve(kind));
}

describe('bounded capacity presentation', () => {
  it('retains five independent refusal slots and clears only a freshly admitted kind', () => {
    const value = new CapacityObservation();
    assert.deepEqual(Object.keys(value.current), [...capacityTransitions, 'owed']);
    value.admitted('runtimeMarker'); value.refused(refusal('exhausted'));
    value.admitted('maintenance');
    assert.equal(value.current.ordinary.state, 'exhausted'); assert.equal(isCapacityBlocked(value.current), true);
    value.refused(refusal('unavailable'));
    assert.deepEqual(value.current.ordinary, { state: 'unavailable', reason: 'inventory', dimensions: [] });
    value.admitted('release'); assert.equal(isCapacityBlocked(value.current), true);
    value.admitted('ordinary'); assert.equal(isCapacityBlocked(value.current), false);
  });

  it('normalizes every exhausted dimension without emitting arbitrary document names', () => {
    const slot = capacitySlot(refusal('exhausted', 'repair', ['private-file:bytes', 'private-file:tokens', 'private-file:text', 'operationFinalization:bytes',
      'operationFinalization:tokensOrText', 'operationFinalization:document', 'unknown', 'freeSpace', 'freeSpace', 'quarantineFiles']));
    assert.deepEqual(slot.dimensions, ['quarantineFiles', 'freeSpace', 'documentBytes', 'documentTokens', 'documentText', 'operationFinalizationBytes',
      'operationFinalizationTokensOrText', 'operationFinalizationDocument', 'otherResource']);
    assert.equal(capacitySlot(refusal('unavailable', 'ordinary', ['private-path'])).reason, 'otherAuthority');
  });

  it('invalidates admitted observations without hiding refusals or carrying stale owed values', () => {
    const value = new CapacityObservation(); value.admitted('runtimeMarker'); value.refused(refusal('exhausted'));
    value.observeOwed({ pendingOutboxRecords: 3, safetyObligation: true }); const epoch = value.epoch;
    value.invalidate(); value.observeOwed({ pendingOutboxRecords: 0 }, epoch);
    assert.equal(value.current.runtimeMarker.state, 'unchecked'); assert.equal(value.current.ordinary.state, 'exhausted');
    assert.deepEqual(value.current.owed, initialCapacity().owed);
    value.refused(refusal('exhausted', null));
    assert.ok(capacityTransitions.every(kind => value.current[kind].state === 'unavailable' && value.current[kind].reason === 'otherAuthority'));
  });

  it('keeps the listed pre-kernel outer code while retaining typed capacity detail as cause', () => {
    const detail = refusal('unavailable', 'runtimeMarker');
    const error = new DataRootUnavailableError('Runtime startup authority is unavailable.', { cause: detail });
    assert.equal(error.code, 'dataRootUnavailable'); assert.equal(error.cause, detail);
    assert.equal(detail.transition, 'runtimeMarker'); assert.equal(detail.state, 'unavailable');
  });

  it('emits unavailable and measured exhaustion distinctly from actual resource assessments', async () => {
    const model = fixture();
    model.resources.inventory = async () => { throw new Error('Inventory could not be read.'); };
    await assert.rejects(assess(model.resources, 'repair'), error => error instanceof RuntimeCapacityError && error.transition === 'repair' && error.state === 'unavailable');
    assert.equal(model.kernel.status.capacity.repair.state, 'unavailable'); assert.equal(model.kernel.status.journal.fault, null);
    model.resources.inventory = async () => ({ ...complete, counts: { ...complete.counts, uncompactedEvents: 8192 } });
    await assert.rejects(assess(model.resources, 'repair'), error => error instanceof RuntimeCapacityError && error.state === 'exhausted');
    assert.equal(model.kernel.status.journal.fault, 'runtimeCapacityExceeded');
    await assess(model.resources, 'maintenance'); assert.equal(model.kernel.status.capacity.repair.state, 'exhausted');
    model.resources.inventory = async () => complete; await assess(model.resources, 'repair');
    assert.equal(model.kernel.status.capacity.repair.state, 'admitted'); assert.equal(model.kernel.status.journal.fault, null);
  });

  it('recomputes the capacity fault without overwriting independent journal evidence', () => {
    const model = fixture();
    model.kernel.emit({ journal: { state: 'fault', fault: 'foreignRecord', unacknowledgedEvents: 2 } });
    model.resources.reportFailure(refusal('exhausted')); assert.equal(model.kernel.status.journal.fault, 'foreignRecord');
    model.resources.reportFailure(refusal('unavailable')); assert.equal(model.kernel.status.journal.fault, 'foreignRecord');
    model.kernel.emit({ journal: { state: 'healthy', fault: null, unacknowledgedEvents: 2 } });
    assert.equal(model.kernel.status.journal.fault, null); assert.equal(model.kernel.status.capacity.ordinary.state, 'unavailable');
  });
});

describe('capacity status before public delivery rejection', () => {
  for (const name of ['acquire', 'preview', 'prepare', 'copyForSend', 'discard', 'markSent', 'acknowledge'] as const) {
    it('records the refused slot before ' + name + ' rejects', async () => {
      const model = fixture(); const error = refusal('unavailable', 'ordinary', ['workspace']);
      const methods = DeliveryCoordinator.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = methods[name]!; methods[name] = async () => { throw error; };
      try {
        const call = model.backend[name] as (...args: unknown[]) => Promise<unknown>;
        await assert.rejects(call.call(model.backend), actual => {
          assert.equal(model.kernel.status.capacity.ordinary.state, 'unavailable');
          assert.ok(model.observations.length > 0);
          assert.equal(model.kernel.status.freshness.reason, 'capacityUnavailable');
          return actual === error;
        });
      } finally { methods[name] = original; }
    });
  }
});

describe('prospective JSON capacity evidence', () => {
  const budget = { maxBytes: 1000, maxTokens: 100, maxTextBytes: 100 };
  function limit(action: () => unknown): ProspectiveJsonBudgetError {
    try { action(); assert.fail('Expected a prospective limit.'); }
    catch (error) { assert.ok(error instanceof ProspectiveJsonBudgetError); return error; }
  }
  function generic(action: () => unknown): void {
    assert.throws(action, error => error instanceof StrictJsonError && !(error instanceof ProspectiveJsonBudgetError));
  }

  it('measures byte, token and text limits without interpreting messages', () => {
    const bytes = limit(() => stringifyProspectiveJson('xx', { ...budget, maxBytes: 3 }, 'candidate.json'));
    assert.deepEqual(bytes.limits, [{ dimension: 'bytes', actual: 4, limit: 3 }]);
    const tokens = limit(() => stringifyProspectiveJson([0, 0], { ...budget, maxTokens: 3 }));
    assert.deepEqual(tokens.limits, [{ dimension: 'tokens', actual: 4, limit: 3 }]);
    const text = limit(() => stringifyProspectiveJson('xxxx', { ...budget, maxTextBytes: 3 }));
    assert.deepEqual(text.limits, [{ dimension: 'text', actual: 4, limit: 3 }]);
    const combined = limit(() => stringifyProspectiveJson({ x: 'xxxx' }, { ...budget, maxTokens: 2, maxTextBytes: 3 }));
    assert.deepEqual(combined.limits, [{ dimension: 'tokens', actual: 3, limit: 2 }, { dimension: 'text', actual: 5, limit: 3 }]);
    assert.equal(stringifyProspectiveJson('xx', { ...budget, maxBytes: 4, maxTokens: 1, maxTextBytes: 2 }), '"xx"');
    assert.equal(bytes instanceof StrictJsonError, true); assert.equal(bytes.document, 'candidate.json');
  });

  it('leaves stored authority, comparison serialization and malformed candidates generic', () => {
    generic(() => parseStrictJson(Buffer.from('"xxxx"'), { ...budget, maxBytes: 3 }));
    generic(() => parseStrictJson(Buffer.from('[0,0]'), { ...budget, maxTokens: 3 }));
    generic(() => stringifyJson('xxxx', { ...budget, maxTextBytes: 3 }));
    generic(() => parseStrictJson(Buffer.from('{"x":1,"x":2}')));
    generic(() => parseStrictJson(Uint8Array.of(0xff)));
    generic(() => stringifyProspectiveJson(String.fromCharCode(0xd800)));
    const circular: { self?: unknown } = {}; circular.self = circular;
    generic(() => stringifyProspectiveJson(circular));
    generic(() => stringifyProspectiveJson(undefined));
    generic(() => stringifyProspectiveJson(0, { ...budget, maxTokens: 0 }));
    let nested: unknown = 0; for (let index = 0; index < 65; index++) { nested = [nested]; }
    generic(() => stringifyProspectiveJson(nested));
  });

  it('attributes measured write refusal only while the reservation owner is known', async () => {
    const model = fixture(); model.resources.inventory = async () => complete;
    const owner = model.resources.createSource('repair');
    await model.resources.withSource(owner, () => model.resources.reserve('repair'));
    const evidence = limit(() => stringifyProspectiveJson('xxxx', { ...budget, maxTextBytes: 3 }, 'operations/example.json'));
    evidence.message = 'Unrelated text without a budget phrase.';
    const measured = await model.resources.withSource(owner, async () => model.resources.prospectiveFailure(evidence));
    assert.ok(measured instanceof RuntimeCapacityError); assert.equal(measured.state, 'exhausted'); assert.equal(measured.transition, 'repair');
    assert.deepEqual(measured.dimensions, ['operations/example.json:text']); assert.equal(measured.cause, evidence);
    assert.deepEqual(model.kernel.status.capacity.repair.dimensions, ['documentText']);
    const unknown = fixture(); unknown.resources.inventory = async () => complete; await assess(unknown.resources, 'release');
    const unavailable = unknown.resources.captureFailure(evidence);
    assert.ok(unavailable instanceof RuntimeCapacityError); assert.equal(unavailable.state, 'unavailable'); assert.equal(unavailable.transition, null);
    assert.ok(capacityTransitions.every(kind => unknown.kernel.status.capacity[kind].reason === 'otherAuthority'));
    assert.equal(unknown.kernel.status.journal.fault, null);
    const malformed = new StrictJsonError('JSON exceeds its byte budget.');
    assert.equal(model.resources.captureFailure(malformed), null);
    assert.equal(model.resources.captureFailure(new Error('Read access was denied.')), null);
  });

  it('rejects write candidates before publication preflight without touching read authority', async () => {
    let preflights = 0;
    const publisher = new FilePublisher({ root: 'C:/Git/disco-elysium-companion/.tmp/capacity-pure-model', guard: { held: true },
      inspector: {} as never, supervisor: {} as never, preflight: async () => { preflights++; }, invalidate: () => assert.fail('No staging occurred.') });
    const excessive = 'x'.repeat(jsonBudgets.config.maxTextBytes + 1);
    await assert.rejects(publisher.publishJson('runtime.json', excessive), error => error instanceof ProspectiveJsonBudgetError && error.document === 'runtime.json');
    const storage = new ScopeStorage({ scope: fixture().kernel.scope, guard: { held: true }, inspector: {} as never, publisher });
    await assert.rejects(storage.write('runtime.json', excessive, 'config', null), error => error instanceof ProspectiveJsonBudgetError && error.document === 'runtime.json');
    await assert.rejects(storage.replaceSessionIndex(excessive, 'a'.repeat(64)), error => error instanceof ProspectiveJsonBudgetError && error.document === 'agent-session-index.json');
    const oversized = new Uint8Array(jsonBudgets.config.maxBytes + 1);
    await assert.rejects(publisher.publish('runtime.json', oversized, 'config'), error => error instanceof ProspectiveJsonBudgetError && error.limits[0]?.dimension === 'bytes');
    assert.equal(preflights, 0);
  });

  it('binds the production serializer refusal before a later reservation can replace its owner', async () => {
    const model = fixture(); model.resources.inventory = async () => complete;
    const owner = model.resources.createSource('repair'); await model.resources.withSource(owner, () => model.resources.reserve('repair'));
    let recorded!: () => void; const classified = new Promise<void>(resolve => { recorded = resolve; });
    const publisher = new FilePublisher({ root: model.kernel.scope.dataRoot, guard: { held: true }, inspector: {} as never, supervisor: {} as never,
      preflight: async () => assert.fail('Oversized candidate reached preflight.'), invalidate: () => assert.fail('No staging occurred.'),
      prospectiveFailure: error => { const failure = model.resources.prospectiveFailure(error); recorded(); return failure; } });
    const pending = model.resources.withSource(owner, () => publisher.publishJson('runtime.json', 'x'.repeat(jsonBudgets.config.maxTextBytes + 1)));
    // Wait for the source-bound classification, then replace a different source's
    // reservation before this caller consumes its earlier rejection.
    const result = pending.then(() => assert.fail('Expected refusal.'), error => error as unknown);
    await classified;
    await assess(model.resources, 'release');
    const error = await result;
    assert.ok(error instanceof RuntimeCapacityError); assert.equal(error.transition, 'repair'); assert.equal(error.state, 'exhausted');
    assert.equal(model.kernel.status.capacity.repair.state, 'exhausted'); assert.equal(model.kernel.status.capacity.release.state, 'admitted');
    assert.equal(model.resources.captureFailure(error), error);
  });
});
