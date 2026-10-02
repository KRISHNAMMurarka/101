import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssetReference } from '@101/device-model';
import { chunkResource, readVerifiedResource } from './resource.ts';
import type { ResourceChunk } from './resource.ts';

const encoder = new TextEncoder();
const scope = { principalId: 'owner', applicationId: 'editor', sessionId: 'session' };

test('authorized transfer verifies ordered chunks before exposing a document', async () => {
  const bytes = encoder.encode('A'.repeat(40000));
  const reference = await createAssetReference('document:long', 'text', bytes);
  const chunks = chunkResource(bytes, 4096);
  const result = await readVerifiedResource({ reference, chunks, signal: new AbortController().signal,
    now: () => 1000, ...scope, authorize(request) {
      assert.deepEqual(request.reference, reference);
      assert.equal(request.principalId, 'owner');
      return { expiresAt: 2000, maxBytes: 65536 };
    } });
  assert.deepEqual(result, bytes);
  assert.notEqual(result, bytes);
});

test('denial, corruption and truncation never expose partial bytes', async () => {
  const bytes = encoder.encode('test document');
  const reference = await createAssetReference('document:test', 'text', bytes);
  let read = false;
  const source = { async *[Symbol.asyncIterator]() { read = true; yield* chunkResource(bytes, 4); } };
  await assert.rejects(readVerifiedResource({ reference, chunks: source, signal: new AbortController().signal,
    now: () => 1000, ...scope, authorize: () => undefined }));
  assert.equal(read, false);
  const corrupted = { async *[Symbol.asyncIterator]() { yield { index: 0, offset: 0, bytes: encoder.encode('wrong document') }; } };
  await assert.rejects(readVerifiedResource({ reference, chunks: corrupted, signal: new AbortController().signal,
    now: () => 1000, ...scope, authorize: () => ({ expiresAt: 2000, maxBytes: 100 }) }));
  const truncated = { async *[Symbol.asyncIterator]() { yield { index: 0, offset: 0, bytes: bytes.slice(0, 4) }; } };
  await assert.rejects(readVerifiedResource({ reference, chunks: truncated, signal: new AbortController().signal,
    now: () => 1000, ...scope, authorize: () => ({ expiresAt: 2000, maxBytes: 100 }) }));
});

test('abort interrupts a stalled producer without waiting for its next chunk', async () => {
  const bytes = encoder.encode('hello');
  const reference = await createAssetReference('document:stalled', 'text', bytes);
  const controller = new AbortController();
  let entered = false;
  const stalled = { [Symbol.asyncIterator]() { return {
    next() { entered = true; return new Promise<IteratorResult<never>>(() => {}); },
    return() { return Promise.resolve({ done: true as const, value: undefined }); },
  }; } };
  const reading = readVerifiedResource({ reference, chunks: stalled, signal: controller.signal,
    now: () => 1000, ...scope, authorize: () => ({ expiresAt: 2000, maxBytes: 100 }) });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(entered, true);
  controller.abort();
  await assert.rejects(reading, /abort/i);
});

test('an abort during authorization never begins reading', async () => {
  const bytes = encoder.encode('hello');
  const reference = await createAssetReference('document:abort', 'text', bytes);
  const controller = new AbortController();
  let read = false;
  const source = { async *[Symbol.asyncIterator]() { read = true; yield* chunkResource(bytes); } };
  await assert.rejects(readVerifiedResource({ reference, chunks: source, signal: controller.signal,
    now: () => 1000, ...scope, authorize() { controller.abort(); return { expiresAt: 2000, maxBytes: 100 }; } }), /abort/i);
  assert.equal(read, false);
});

test('a large resource cannot be fragmented into an unbounded number of chunks', async () => {
  const bytes = encoder.encode('A'.repeat(600));
  await assert.rejects(async () => { for await (const part of chunkResource(bytes, 1)) assert.ok(part.bytes.byteLength > 0); }, /chunk/i);
});

test('chunk snapshots, order and trailing data are enforced', async () => {
  const bytes = encoder.encode('abcdefgh');
  const reference = await createAssetReference('document:ordered', 'text', bytes);
  const source = chunkResource(bytes, 4);
  bytes[0] = 'z'.charCodeAt(0);
  const chunks: ResourceChunk[] = [];
  for await (const value of source) chunks.push(value);
  assert.equal(new TextDecoder().decode(chunks[0].bytes), 'abcd');
  const options = { reference, signal: new AbortController().signal, now: () => 1000, ...scope,
    authorize: () => ({ expiresAt: 2000, maxBytes: 100 }) };
  await assert.rejects(readVerifiedResource({ ...options, chunks: { async *[Symbol.asyncIterator]() { yield chunks[1]; yield chunks[0]; } } }), /chunk-order/);
  await assert.rejects(readVerifiedResource({ ...options, chunks: { async *[Symbol.asyncIterator]() { yield* chunks; yield chunks[1]; } } }), /chunk-order/);
  await assert.rejects(readVerifiedResource({ ...options, chunks: { async *[Symbol.asyncIterator]() { yield { index: 0, offset: 0, bytes: new Uint8Array(16385) }; } } }), /chunk-size/);
});

test('host grant expiry stops a partially read resource', async () => {
  const bytes = encoder.encode('abcdefgh');
  const reference = await createAssetReference('document:expiring', 'text', bytes);
  let now = 1000;
  const chunks = { async *[Symbol.asyncIterator]() {
    yield { index: 0, offset: 0, bytes: bytes.slice(0, 4) };
    now = 2000;
    yield { index: 1, offset: 4, bytes: bytes.slice(4) };
  } };
  await assert.rejects(readVerifiedResource({ reference, chunks, signal: new AbortController().signal,
    now: () => now, ...scope, authorize: () => ({ expiresAt: 2000, maxBytes: 100 }) }), /expired/);
});

test('chunk snapshots ignore an overridden typed-array iterator', async () => {
  const bytes = new Uint8Array([65]);
  Object.defineProperty(bytes, Symbol.iterator, { value: function* () { yield 66; yield 67; } });
  const chunks: ResourceChunk[] = [];
  for await (const value of chunkResource(bytes)) chunks.push(value);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].bytes, new Uint8Array([65]));
});

test('grant expiry timer uses time remaining after authorization', async () => {
  const bytes = encoder.encode('hello');
  const reference = await createAssetReference('document:delayed', 'text', bytes);
  const controller = new AbortController();
  let now = 1000;
  const stalled = { [Symbol.asyncIterator]() { return {
    next() { return new Promise<IteratorResult<never>>(() => {}); },
    return() { return Promise.resolve({ done: true as const, value: undefined }); },
  }; } };
  const abort = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(readVerifiedResource({ reference, chunks: stalled, signal: controller.signal,
      now: () => now, ...scope, authorize() { now = 1800; return { expiresAt: 2000, maxBytes: 100 }; } }),
    (error: unknown) => (error as { code?: string }).code === 'expired');
  } finally { clearTimeout(abort); }
});
