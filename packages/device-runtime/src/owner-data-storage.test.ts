import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./owner-data-storage.ts').catch(() => undefined);

test('managed storage requires a real engine and never falls back to simulated persistence', () => {
  assert.ok(api, 'same-transaction owner storage fencing requires the IndexedDB adapter');
  assert.throws(() => api.createIndexedDbOwnerDataStorage({ databaseName: 'owner-test', indexedDB: undefined }), /storage/i);
});

test('invalid database names and bounded timeout configurations reject before opening an engine', () => {
  assert.ok(api, 'managed IndexedDB adapter is absent');
  let opened = false;
  const factory = { open() { opened = true; throw new Error('not an engine'); } } as unknown as IDBFactory;
  for (const options of [{ databaseName: '../private', indexedDB: factory },
    { databaseName: 'owned', indexedDB: factory, timeoutMs: 0 }, { databaseName: 'owned', indexedDB: factory, timeoutMs: 10001 }])
    assert.throws(() => api.createIndexedDbOwnerDataStorage(options));
  assert.equal(opened, false);
});
