import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndexedDbTelemetryStorage } from './telemetry-storage.ts';

test('native IndexedDB is required and missing persistence never falls back to volatile storage', async () => {
  const storage = createIndexedDbTelemetryStorage({ databaseName: 'test:no-indexeddb' });
  await assert.rejects(storage.transact('owner', () => ({ state: {}, result: true })), /storage-unavailable/);
  storage.close();
});

test('closed IndexedDB adapters reject writes before a storage mutation runs', async () => {
  const storage = createIndexedDbTelemetryStorage({ databaseName: 'test:closed' }); storage.close();
  await assert.rejects(storage.transact('owner', () => { assert.fail('Closed mutation ran'); }), /storage-unavailable/);
  assert.throws(() => createIndexedDbTelemetryStorage({ databaseName: '../other-owner' }), /invalid-storage-name/);
  assert.throws(() => createIndexedDbTelemetryStorage({ databaseName: 'test:timeout', timeoutMs: Infinity }), /invalid-storage-timeout/);
});

test('closing inside an IndexedDB mutation rejects with a fixed error without escaping the read handler', async () => {
  const uncaught: string[] = [];
  let finished = false;
  const read: { result: unknown; onsuccess?: () => void } = { result: undefined };
  const transaction = {
    onabort: undefined as (() => void) | undefined,
    oncomplete: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    abort() {
      // Native abort finishes synchronously; its abort event arrives afterward.
      if (finished) throw new DOMException('The transaction has finished', 'InvalidStateError');
      finished = true; queueMicrotask(() => transaction.onabort?.());
    },
    objectStore() { return {
      get() {
        queueMicrotask(() => { try { read.onsuccess?.(); } catch (error) { uncaught.push((error as Error).name); } });
        return read;
      },
      put() {
        if (finished) throw new DOMException('The transaction has finished', 'InvalidStateError');
        finished = true; queueMicrotask(() => transaction.oncomplete?.());
      },
    }; },
  };
  const database = { objectStoreNames: { length: 1, contains: () => true }, transaction: () => transaction, close() {} };
  const factory = { open() {
    const request: { result: typeof database; onsuccess?: () => void } = { result: database };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } } as unknown as IDBFactory;
  const storage = createIndexedDbTelemetryStorage({ databaseName: 'test:close-in-mutation', indexedDB: factory });
  const rejection = await storage.transact('owner', () => {
    storage.close(); return { state: { test: 1 }, result: 1 };
  }).then(() => assert.fail('Closed mutation committed'), (error: Error) => error);
  assert.deepEqual({ rejection: rejection.message, uncaught }, { rejection: 'storage-unavailable', uncaught: [] });
});
