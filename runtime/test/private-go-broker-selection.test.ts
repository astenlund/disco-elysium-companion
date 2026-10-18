import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBackend, privateCompiledProcessBroker, privateGoBrokerSpawn } from '../src/backend/index.ts';
import type { CompiledBrokerArtifact } from '../src/compiled-broker.ts';
import type { BrokerSpawn } from '../src/process.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absent = path.join(root, '.tmp', 'go-selector-preflight-absent');
const goBroker: BrokerSpawn = Object.assign(() => { throw new Error('Private broker must not start.'); },
  { controlVersion: 2 as const });
const unusedCompiled = {} as CompiledBrokerArtifact;

test('conflicting private brokers fail before configuration or instance guard work', async () => {
  const phases: string[] = [];
  await assert.rejects(openBackend({ companionRoot: absent, onStartupPhase: phase => phases.push(phase),
    [privateCompiledProcessBroker]: unusedCompiled, [privateGoBrokerSpawn]: goBroker }),
  /Private broker selectors conflict/);
  assert.deepEqual(phases, []);
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
});

test('a private Go broker without the v2 control frame fails before configuration', async () => {
  const phases: string[] = [];
  const oldProtocol = (() => { throw new Error('Private broker must not start.'); }) as BrokerSpawn;
  await assert.rejects(openBackend({ companionRoot: absent, onStartupPhase: phase => phases.push(phase),
    [privateGoBrokerSpawn]: oldProtocol }), /Private Go broker requires protocol version 2/);
  assert.deepEqual(phases, []);
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
});
