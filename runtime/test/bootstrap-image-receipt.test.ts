import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { ImagePinReceiptError, parseImagePinReceipt, type ImagePinRequest } from '../src/bootstrap-image-receipt.ts';
import { parseStrictJson, type JsonValue } from '../src/json.ts';
import { readyImagePinReceipt } from './support/bootstrap-fixtures.ts';

const separator = String.fromCharCode(92);
const installationRoot = 'C:' + separator + ['Git', 'companion'].join(separator);
const companionRoot = installationRoot;
const brokerPath = path.win32.join(installationRoot, 'runtime', 'native', 'go-broker.exe');
const observerPath = path.win32.join(installationRoot, 'runtime', 'native', 'job-observer.exe');
const candidateScopePath = path.win32.join(companionRoot, 'runtime-data', 'g-scope', 'p-principal');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const wire = (value: unknown): JsonValue => parseStrictJson(Buffer.from(JSON.stringify(value)));
const request: ImagePinRequest = { version: 1, nonce: 'a'.repeat(32), targetProcessId: 123,
  targetCreated: '639271753943217620', companionRoot, installationRoot, game: 'disco_elysium',
  artifactGeneration: 'b'.repeat(64), brokerPath, observerPath,
  brokerSha256: 'c'.repeat(64), observerSha256: 'd'.repeat(64) };
const directoryPaths = [
  'C:' + separator,
  'C:' + separator + 'Git',
  installationRoot,
  path.win32.join(installationRoot, 'runtime'),
  path.win32.join(installationRoot, 'runtime', 'native'),
];
const ready = () => readyImagePinReceipt(request, candidateScopePath);

test('selected pin receipt binds exact paths and handles to the frozen request', () => {
  assert.deepEqual(parseImagePinReceipt({ status: 'absent' }, request, candidateScopePath), { status: 'absent' });
  const valid = ready();
  const parsed = parseImagePinReceipt(wire(valid), request, candidateScopePath);
  assert.equal(parsed.status, 'ready');
  if (parsed.status === 'ready') { assert.equal(parsed.handles.length, directoryPaths.length + 2); }
  for (const changed of [
    { ...valid, nonce: 'f'.repeat(32) },
    { ...valid, targetCreated: '639271753943217621' },
    { ...valid, candidateScopePathSha256: sha('different') },
    { ...valid, extra: true },
    { ...valid, handles: valid.handles.slice(1) },
    { ...valid, handles: valid.handles.map((entry, index) => index === 1 ? { ...entry, identity: valid.handles[0]!.identity } : entry) },
    { ...valid, handles: valid.handles.map((entry, index) => index === 1 ? { ...entry, handle: valid.handles[0]!.handle } : entry) },
    { ...valid, handles: valid.handles.map((entry, index) => index === 2 ? { ...entry, path: brokerPath } : entry) },
    { status: 'absent', handles: [] },
  ]) {
    assert.throws(() => parseImagePinReceipt(wire(changed), request, candidateScopePath), ImagePinReceiptError);
  }
});

test('selected pin receipt refuses malformed handles, an oversized chain, swapped images and a non-ready status', () => {
  const valid = ready();
  const changeEntry = (index: number, change: Record<string, string>) =>
    ({ ...valid, handles: valid.handles.map((entry, at) => at === index ? { ...entry, ...change } : entry) });
  const broker = valid.handles.length - 2;
  const swapped = [...valid.handles.slice(0, broker), valid.handles[broker + 1]!, valid.handles[broker]!];
  for (const changed of [
    changeEntry(0, { handle: '0'.repeat(16) }),
    changeEntry(0, { handle: 'B'.repeat(16) }),
    changeEntry(0, { identity: 'A'.repeat(32) }),
    changeEntry(0, { volume: 'F'.repeat(16) }),
    { ...valid, handles: swapped },
    { ...valid, status: 'absent' },
    { ...valid, status: 'failed' },
  ]) {
    assert.throws(() => parseImagePinReceipt(wire(changed), request, candidateScopePath), ImagePinReceiptError);
  }
  const deepRequest = (depth: number): ImagePinRequest => {
    const root = path.win32.join('C:' + separator, ...Array.from({ length: depth }, (_, index) => `d${index}`));
    return { ...request, installationRoot: root, brokerPath: path.win32.join(root, 'runtime', 'native', 'go-broker.exe'),
      observerPath: path.win32.join(root, 'runtime', 'native', 'job-observer.exe') };
  };
  // The volume root, the installation folders and runtime/native count toward the 62-directory bound, so 64 handles at most.
  const atLimit = deepRequest(59);
  assert.equal(parseImagePinReceipt(wire(readyImagePinReceipt(atLimit, candidateScopePath)), atLimit, candidateScopePath).status, 'ready');
  const beyond = deepRequest(60);
  assert.throws(() => parseImagePinReceipt(wire(readyImagePinReceipt(beyond, candidateScopePath)), beyond, candidateScopePath),
    ImagePinReceiptError);
});
