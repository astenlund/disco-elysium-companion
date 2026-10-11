import assert from 'node:assert/strict';
import test from 'node:test';

import { RecoveryCoordinator, handoffFor } from '../../src/backend/recovery.ts';
import { ControlDocumentError } from '../../src/control-values.ts';
import type { EventRead } from '../../src/event-reader.ts';
import { eventRewriteMetadata } from '../../src/journal-records.ts';
import type { RepairOperation } from '../../src/operation-records.ts';
import type { OutboxRead } from '../../src/outbox.ts';
import { validatePrerequisite, type PayloadSource, type RecoveryPrerequisite } from '../../src/recovery-manifest.ts';
import { journalEvent } from '../support/journal-event.ts';
import { authorityModel, owner, repair } from './authority-fixtures.ts';

test('a planned quarantine permits a valid occupant at the recovery restore destination', async () => {
  const model = authorityModel();
  const coordinator = new RecoveryCoordinator(model.kernel);
  const original = journalEvent(2, { type: 'state.resync', coreRepairOperationId: owner.operationId,
    attemptRef: { operationId: owner.operationId, attemptOrdinal: 0 } });
  const occupant = journalEvent(1);
  const destination = 'journal/events/0000000000000001.json';
  const sourcePath = 'journal/events/0000000000000002.json';
  const carryPath = 'journal/recovery-event.json';
  const sourceHash = 'a'.repeat(64);
  const occupantHash = 'b'.repeat(64);
  const carryHash = 'c'.repeat(64);
  const restoredHash = 'd'.repeat(64);
  const source: PayloadSource = { root: 'scope', path: sourcePath, sha256: sourceHash, payloadBindingSha256: original.payloadBindingSha256 };
  const plan = validatePrerequisite({ kind: 'header', nextAction: 0, carry: { path: carryPath, sha256: carryHash }, carryRelease: null, skippedRanges: [],
    actions: [
      { kind: 'preserveRecovery', target: { path: carryPath, before: null, after: carryHash }, source, metadata: eventRewriteMetadata(original) },
      { kind: 'quarantine', source: { path: destination, before: occupantHash, after: null },
        target: { path: `quarantine/0000000000000001.json.${'3'.repeat(32)}.quarantined`, before: null, after: occupantHash } },
      { kind: 'quarantine', source: { path: sourcePath, before: sourceHash, after: null },
        target: { path: `quarantine/0000000000000002.json.${'4'.repeat(32)}.quarantined`, before: null, after: sourceHash } },
      { kind: 'appendRecovery', target: { path: destination, before: null, after: restoredHash },
        source: { root: 'scope', path: carryPath, sha256: carryHash, payloadBindingSha256: original.payloadBindingSha256 },
        metadata: { ...eventRewriteMetadata(original), sequence: 1 } },
    ] });
  const initial = repair();
  const record = repair({ ...initial, plan: { ...initial.plan, handoffs: [handoffFor(original)] } });
  const internals = coordinator as unknown as {
    ordinaryCarryDecision: (record: RepairOperation, plan: RecoveryPrerequisite) => Promise<{ kind: string } | null>;
    stableEvent: (path: string) => Promise<EventRead>;
    stableOutbox: (name: string) => Promise<OutboxRead>;
    deferredRestorationSource: () => Promise<PayloadSource | null>;
  };
  model.kernel.carryHash = async () => null;
  internals.stableEvent = async path => path === destination ? { path, status: 'valid', sha256: occupantHash, metadata: occupant }
    : path === sourcePath ? { path, status: 'valid', sha256: sourceHash, metadata: original } : { path, status: 'absent', sha256: null };
  internals.stableOutbox = async name => ({ status: 'absent', name });
  internals.deferredRestorationSource = async () => source;

  const decision = await internals.ordinaryCarryDecision(record, plan);
  assert.equal(decision?.kind, 'intact');

  internals.stableEvent = async path => path === destination ? { path, status: 'valid', sha256: 'e'.repeat(64), metadata: occupant }
    : path === sourcePath ? { path, status: 'valid', sha256: sourceHash, metadata: original } : { path, status: 'absent', sha256: null };
  await assert.rejects(internals.ordinaryCarryDecision(record, plan), ControlDocumentError);

  internals.stableEvent = async path => path === destination ? { path, status: 'valid', sha256: occupantHash, metadata: occupant }
    : path === sourcePath ? { path, status: 'valid', sha256: sourceHash, metadata: original } : { path, status: 'absent', sha256: null };
  await assert.rejects(internals.ordinaryCarryDecision(record, validatePrerequisite({ ...plan, nextAction: 2 })), ControlDocumentError);
});
