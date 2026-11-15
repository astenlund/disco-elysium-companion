import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PathInspector } from '../../src/admission.ts';
import type { OperationStore } from '../../src/operations.ts';
import { ResourceAuthority } from '../../src/resource-lifecycle/resources.ts';
import type { RuntimeScope } from '../../src/scope.ts';
import { bytesHash } from '../../src/storage.ts';
import { createTestNative, type TestNative } from './native-helper.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

export interface ResourceScopeFixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly scope: RuntimeScope;
  readonly native: TestNative;
  readonly resources: ResourceAuthority;
  close(): Promise<void>;
}

/** An operation store with no operation records, for cases whose inventory reads the operations folder. */
export const noOperations = { list: async () => ({ records: [], invalid: [], handoffCount: 0, fullTerminalCount: 0 }) } as unknown as OperationStore;

/**
 * A scratch runtime-data scope under the repository's .tmp, holding its scope binding and an empty journal/events folder,
 * with the real native helper and a resource authority over it. `prepare` adds the entries a case needs before the helper
 * starts; `close` stops the helper and removes the scratch root.
 */
export async function resourceScopeFixture(name: string, prepare: (dataRoot: string) => Promise<void> = async () => {},
  operations: OperationStore = {} as OperationStore): Promise<ResourceScopeFixture> {
  const root = path.join(repository, '.tmp', `${name}-${randomUUID()}`);
  const dataRoot = path.join(root, 'data');
  await fs.mkdir(path.join(dataRoot, 'journal', 'events'), { recursive: true });
  const binding = Buffer.from(JSON.stringify({ runtimeScopeVersion: 1, game: 'game', principal: 'principal' }));
  await fs.writeFile(path.join(dataRoot, 'scope.json'), binding);
  const scope: RuntimeScope = { dataRoot, companionRoot: root, bindingSha256: bytesHash(binding), game: 'game', principal: 'principal', createdHere: false };
  const close = (): Promise<void> => fs.rm(root, { recursive: true, force: true });
  let native: TestNative;
  try {
    await prepare(dataRoot);
    native = await createTestNative(root);
  } catch (error) {
    await close();
    throw error;
  }
  const resources = new ResourceAuthority(scope, new PathInspector(native.supervisor), operations);

  return { root, dataRoot, scope, native, resources, close: async () => { try { await native.close(); } finally { await close(); } } };
}
