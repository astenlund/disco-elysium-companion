import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError, PathInspector, type PathAdmission } from '../src/admission.ts';
import { PayloadCodec } from '../src/codec.ts';
import { Deadline } from '../src/deadline.ts';
import { admitStagingPaths, FilePublisher, PublicationError, type AdmitPublicationScope } from '../src/files.ts';
import { firstCapacityRefusal, RuntimeCapacityError } from '../src/capacity.ts';
import { takeInstanceGuard } from '../src/guard.ts';
import { eventRewriteMetadata } from '../src/journal-records.ts';
import type { OperationStore } from '../src/operations.ts';
import { ProcessSupervisor, SupervisorError } from '../src/process.ts';
import { ResourceAuthority } from '../src/resource-lifecycle/resources.ts';
import type { RuntimeScope } from '../src/scope.ts';
import { bytesHash } from '../src/storage.ts';
import { companionFixture } from './support/companion.ts';
import { journalEvent } from './support/journal-event.ts';

const root = 'C:/unopened-admission-fixture';
const scopePath = path.resolve(root, 'scope.json');
const targets = [path.resolve(root, 'runtime.json'), path.resolve(root, 'runtime.json.input.tmp')];
function absent(target: string): PathAdmission {
  return { path: target, exists: false, kind: null, links: null, volume: null, identity: null, missing: [path.basename(target)] };
}
function model(transform: (values: PathAdmission[]) => readonly PathAdmission[] = values => values) {
  let calls = 0;
  const inspector = { inspectMany: async (_root: string, paths: readonly string[]) => { calls++; return transform(paths.map(absent)); } } as unknown as PathInspector;
  return { inspector, calls: () => calls };
}
function capacityModel(scope: RuntimeScope, inspector: PathInspector): ResourceAuthority {
  const resources = new ResourceAuthority(scope, inspector, {} as OperationStore);
  resources.inventory = async () => ({ complete: true, counts: { uncompactedEvents: 0, retainedHandoffs: 0, fullTerminalOperations: 0 },
    potentialHandoffs: 0, unfinishedOperations: 0, invalidEvents: 0, pendingOutbox: 0, freeBytes: 4000000000n, uncertainWorkspace: false });
  return resources;
}

test('combined admission rejects missing, partial, reordered, foreign and unusable staging observations', async () => {
  const transforms = [
    (values: PathAdmission[]) => values.slice(1),
    (values: PathAdmission[]) => values.reverse(),
    (values: PathAdmission[]) => values.map((value, index) => index === 1 ? { ...value, path: path.resolve(root, 'other.json') } : value),
    (values: PathAdmission[]) => values.map((value, index) => index === 1 ? { ...value, exists: true, kind: 'directory' as const, missing: [] } : value),
    (values: PathAdmission[]) => values.map((value, index) => index === 1 ? { ...value, missing: ['parent', 'runtime.json'] } : value),
    (values: PathAdmission[]) => values.map((value, index) => index === 2 ? { ...value, exists: true, kind: 'file' as const, missing: [] } : value),
  ];
  for (const transform of transforms) {
    const fixture = model(transform);
    await assert.rejects(admitStagingPaths(fixture.inspector, root, targets, async admit => { await admit(scopePath); }, () => 30000), DataRootUnavailableError);
    assert.ok(fixture.calls() === 1 || fixture.calls() === 2);
  }
  const missing = model();
  await assert.rejects(admitStagingPaths(missing.inspector, root, targets, async () => {}, () => 30000), DataRootUnavailableError);
  assert.equal(missing.calls(), 0);
});

test('combined admission belongs to one awaited attempt and cannot be replaced by callback metadata', async () => {
  const fixture = model();
  let retained: AdmitPublicationScope | undefined;
  const result = await admitStagingPaths(fixture.inspector, root, targets, async admit => {
    retained = admit;
    const values = await admit(scopePath);
    (values[1] as { path: string }).path = path.resolve(root, 'substituted.json');
    return [] as unknown as void;
  }, () => 30000);
  assert.equal(result[0]!.path, targets[0]);
  await assert.rejects(retained!(scopePath), DataRootUnavailableError);
  assert.equal(fixture.calls(), 1);
  await assert.rejects(admitStagingPaths(fixture.inspector, root, targets, async admit => {
    await admit(scopePath);
    await assert.rejects(admit(scopePath), DataRootUnavailableError);
  }, () => 30000), DataRootUnavailableError);
  const rejected = model(() => { throw new Error('native refusal'); });
  await assert.rejects(admitStagingPaths(rejected.inspector, root, targets, async admit => {
    await assert.rejects(admit(scopePath), /native refusal/);
  }, () => 30000), DataRootUnavailableError);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const delayed = { inspectMany: async () => { await pending; return [scopePath, ...targets].map(absent); } } as unknown as PathInspector;
  const attempt = admitStagingPaths(delayed, root, targets, async admit => { void admit(scopePath); }, () => 30000);
  const refused = assert.rejects(attempt, DataRootUnavailableError);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await refused;
});

test('combined admission checks ownership and deadline again before any staging', async () => {
  for (const failure of ['ownership', 'deadline']) {
    const fixture = model();
    let held = true;
    let now = 0;
    let nativeCalls = 0;
    const publisher = new FilePublisher({ root, guard: { get held() { return held; } }, inspector: fixture.inspector,
      supervisor: { run: async () => { nativeCalls++; throw new Error('Unexpected publication'); } } as unknown as ProcessSupervisor,
      preflight: async () => { throw new Error('Unexpected legacy callback'); },
      preflightWithAdmission: async (_target, _bytes, _profile, admit) => { await admit(scopePath); if (failure === 'ownership') { held = false; } else { now = 1000; } }, invalidate: () => {} });
    await assert.rejects(publisher.publishJson('runtime.json', {}, false, Deadline.after(1000, () => now)));
    assert.equal(nativeCalls, 0);
    assert.equal(fixture.calls(), 1);
  }
});

test('codec rejects destination and staging failures before resource addition accounting', async () => {
  for (const mode of ['missing-parent', 'directory', 'create-only', 'occupied-staging']) {
    let accounted = 0;
    const fixture = model(values => values.map((value, index) => {
      if (index === 1 && mode === 'missing-parent') { return { ...value, missing: ['events', 'event.json'] }; }
      if (index === 1 && mode === 'directory') { return { ...value, exists: true, kind: 'directory' as const, missing: [] }; }
      if (index === (mode === 'occupied-staging' ? 2 : 1) && (mode === 'occupied-staging' || mode === 'create-only')) { return { ...value, exists: true, kind: 'file' as const, missing: [] }; }
      return value;
    }));
    const publisher = new FilePublisher({ root, guard: { held: true }, inspector: fixture.inspector,
      supervisor: { run: async () => { throw new Error('Unexpected publication'); } } as unknown as ProcessSupervisor, preflight: async () => {}, invalidate: () => {} });
    const codec = new PayloadCodec(publisher, async () => { throw new Error('Unexpected legacy reservation'); }, async (_reservation, admit) => {
      await admit(scopePath);
      accounted++;
    });
    await assert.rejects(codec.createEvent('event.json', Buffer.from('{}'), {}, 1));
    assert.equal(accounted, 0, mode);
    assert.equal(fixture.calls(), 1, mode);
  }
});

test('failed combined admission preserves sent-mark I/O classification only with a completed target refusal', async () => {
  for (const mode of ['target', 'scope', 'expired', 'ownership', 'unverified', 'probe-deadline', 'probe-unverified']) {
    const failure = new DataRootUnavailableError('Fixture physical admission failed.');
    let calls = 0;
    let now = 0;
    let held = true;
    let publications = 0;
    const inspector = { inspectMany: async (_root: string, paths: readonly string[]) => {
      calls++;
      if (calls === 1) {
        if (mode === 'expired') { now = 1000; }
        if (mode === 'ownership') { held = false; }
        if (mode === 'unverified') { throw new SupervisorError('termination-unverified', 'Fixture termination unverified.'); }
        throw failure;
      }
      if (mode === 'target') { throw failure; }
      if (mode === 'probe-deadline') { throw new SupervisorError('deadline', 'Fixture probe expired.'); }
      if (mode === 'probe-unverified') { throw new SupervisorError('termination-unverified', 'Fixture probe termination unverified.'); }
      return paths.map(absent);
    } } as unknown as PathInspector;
    const resources = capacityModel({ dataRoot: root, bindingSha256: 'a'.repeat(64) } as RuntimeScope, inspector);
    const publisher = new FilePublisher({ root, guard: { get held() { return held; } }, inspector,
      supervisor: { run: async () => { publications++; throw new Error('Unexpected publication'); } } as unknown as ProcessSupervisor,
      preflight: async () => { throw new Error('Unexpected legacy callback'); },
      preflightWithAdmission: (target, bytes, profile, admit, deadline) => resources.preflight(target, bytes, profile, deadline, admit), invalidate: () => {} });
    await resources.withTransition('release', async () => {
      await resources.reserve('release');
      await assert.rejects(publisher.publishJson('journal/cursor-agent-session.json', {}, false, Deadline.after(1000, () => now)), error => mode === 'target' ? error === failure : error instanceof RuntimeCapacityError);
      if (mode === 'target') {
        assert.equal(firstCapacityRefusal(resources.capacity.current), null);
        assert.equal(resources.assertReservation(), 'release');
      } else {
        assert.notEqual(firstCapacityRefusal(resources.capacity.current), null);
        assert.throws(() => resources.assertReservation(), RuntimeCapacityError);
      }
    });
    assert.equal(calls, ['expired', 'ownership', 'unverified'].includes(mode) ? 1 : 2, mode);
    assert.equal(publications, 0, mode);
  }
});

test('production resource callbacks share native staging admission and retain scope verification', { timeout: 180000 }, async () => {
  const fixture = await companionFixture('state-event');
  const dataRoot = path.join(fixture.root, 'runtime-data');
  await fs.mkdir(dataRoot);
  const binding = path.join(dataRoot, 'scope.json');
  const bindingBytes = Buffer.from('{}');
  await fs.writeFile(binding, bindingBytes);
  const supervisor = await ProcessSupervisor.create(fixture.root);
  const inspector = new PathInspector(supervisor);
  const guard = await takeInstanceGuard(dataRoot, error => { throw error; });
  const scope = { dataRoot, companionRoot: fixture.root, bindingSha256: bytesHash(bindingBytes) } as RuntimeScope;
  // Capacity inventory is modeled; scope admission, byte reads and publications are native.
  const resources = capacityModel(scope, inspector);
  const calls: string[][] = [];
  const inspectMany = inspector.inspectMany.bind(inspector);
  let changeScope: 'changed' | 'disappeared' | null = null;
  inspector.inspectMany = async (...args) => {
    calls.push([...args[1]]);
    const values = await inspectMany(...args);
    if (changeScope === 'changed') { await fs.writeFile(binding, '{"changed":true}'); }
    if (changeScope === 'disappeared') { await fs.unlink(binding); }
    return values;
  };
  const publisher = new FilePublisher({ root: dataRoot, guard, inspector, supervisor,
    preflight: (target, bytes, profile, deadline) => resources.preflight(target, bytes, profile, deadline),
    preflightWithAdmission: (target, bytes, profile, admit, deadline) => resources.preflight(target, bytes, profile, deadline, admit), invalidate: () => {} });
  const codec = new PayloadCodec(publisher, (reservation, deadline) => resources.codec(reservation, deadline), (reservation, admit, deadline) => resources.codec(reservation, deadline, admit));
  try {
    await resources.withTransition('release', async () => {
      await resources.reserve('release');
      await publisher.publishJson('runtime.json', { value: 1 }, true);
      assert.deepEqual(calls.map(paths => paths.length), [3, 2]);
      assert.equal(calls[0]![0], binding);
      assert.equal(await fs.readFile(path.join(dataRoot, 'runtime.json'), 'utf8'), '{"value":1}');
      calls.length = 0;
      const source = await fs.readFile(path.join(fixture.root, 'state/outbox/event-0000000000000001.json'));
      const inspected = await codec.inspectSource(source, 1);
      assert.equal(inspected.sha256, bytesHash(source));
      assert.deepEqual(calls.map(paths => paths.length), [4, 2]);
      assert.equal(calls[0]![0], binding);
      assert.deepEqual((await fs.readdir(dataRoot)).sort(), ['runtime.json', 'scope.json']);
      await fs.mkdir(path.join(dataRoot, 'journal/events'), { recursive: true });
      await resources.reserve('release', { uncompactedEvents: 1 });
      const metadata = eventRewriteMetadata(journalEvent(1, { adapter: inspected.metadata['game'], principal: inspected.metadata['principal'],
        type: `state.${inspected.metadata['kind']}`, logicalOutboxId: inspected.metadata['logicalOutboxId'], recordSha256: inspected.sha256,
        coreRepairOperationId: inspected.metadata['repairOperationId'], schemaVersion: inspected.metadata['schemaVersion'], adapterVersion: inspected.metadata['adapterVersion'], settlement: 'pending', acceptance: null }));
      const eventPath = 'journal/events/0000000000000001.json';
      calls.length = 0;
      const created = await codec.createEvent(eventPath, source, metadata, 1);
      assert.deepEqual(calls.map(paths => paths.length), [4, 1, 2]);
      assert.equal(bytesHash(await fs.readFile(path.join(dataRoot, eventPath))), created.sha256);
      await assert.rejects(codec.createEvent(eventPath, source, metadata, 1), PublicationError);
      assert.equal(firstCapacityRefusal(resources.capacity.current), null);
      assert.equal(resources.assertReservation(), 'release');
      for (const failure of ['changed', 'disappeared', 'absent', 'directory'] as const) {
        await fs.writeFile(binding, bindingBytes);
        await resources.reserve('release');
        changeScope = failure === 'changed' || failure === 'disappeared' ? failure : null;
        if (failure === 'absent' || failure === 'directory') { await fs.unlink(binding); }
        if (failure === 'directory') { await fs.mkdir(binding); }
        calls.length = 0;
        await assert.rejects(publisher.publishJson('runtime.json', { value: 2 }));
        assert.equal(calls.length, 1, failure);
        assert.equal(await fs.readFile(path.join(dataRoot, 'runtime.json'), 'utf8'), '{"value":1}');
        assert.ok((await fs.readdir(dataRoot)).every(name => name === 'runtime.json' || name === 'scope.json' || name === 'journal'));
        if (failure === 'directory') { await fs.rmdir(binding); }
      }
    });
  } finally {
    await publisher.idle();
    await guard.release();
    await fixture.close();
  }
});
