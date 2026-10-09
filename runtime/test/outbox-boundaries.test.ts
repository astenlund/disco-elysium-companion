import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DataRootUnavailableError, type PathInspector } from '../src/admission.ts';
import type { PayloadCodec } from '../src/codec.ts';
import { OutboxReader } from '../src/outbox.ts';
import { companionFixture } from './support/companion.ts';

test('outbox admission leaves unknown sequence names untouched and selects both legal endpoints', { timeout: 30000 }, async () => {
  const fixture = await companionFixture();
  try {
    const directory = path.join(fixture.root, 'state', 'outbox');
    await fs.mkdir(directory, { recursive: true });
    const names = ['event-0000000000000000.json', 'event-0000000000000001.json', 'event-9007199254740991.json', 'event-9007199254740992.json'];
    for (const name of names) { await fs.writeFile(path.join(directory, name), '{}'); }
    let admissions = 0;
    const inspector = { async inspect() { admissions++; return { path: directory, exists: true, kind: 'directory' }; } } as unknown as PathInspector;
    const outbox = new OutboxReader(fixture.root, inspector, {} as PayloadCodec);

    assert.deepEqual(await outbox.list(), [names[1], names[2]]);
    await assert.rejects(outbox.read(names[0]!), DataRootUnavailableError);
    await assert.rejects(outbox.read(names[3]!), DataRootUnavailableError);
    assert.equal(admissions, 1);
    for (const name of names) { assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), '{}'); }
  } finally {
    await fixture.close();
  }
});
