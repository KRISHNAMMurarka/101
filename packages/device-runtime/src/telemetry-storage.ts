/** A mutation must finish synchronously inside the storage engine's transaction. */
export interface TelemetryStorage {
  transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T }): Promise<T>;
}
export interface IndexedDbTelemetryStorage extends TelemetryStorage { close(): void }

/**
 * One bounded envelope per owner makes expiry, eviction, append and epoch changes atomic
 * across tabs. No authority, upload credentials or network work belongs in this adapter.
 */
export function createIndexedDbTelemetryStorage(options: {
  databaseName: string; indexedDB?: IDBFactory; timeoutMs?: number;
}): IndexedDbTelemetryStorage {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.databaseName)) throw new TypeError('invalid-storage-name');
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) throw new TypeError('invalid-storage-timeout');
  const factory = options.indexedDB ?? globalThis.indexedDB;
  let closed = false, database: IDBDatabase | undefined, opening: Promise<IDBDatabase> | undefined;
  const transactions = new Set<IDBTransaction>();
  function open(): Promise<IDBDatabase> {
    if (closed || !factory) return Promise.reject(new Error('storage-unavailable'));
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = factory.open(options.databaseName, 1);
      const timer = setTimeout(() => fail(), timeoutMs);
      function fail(reason = 'storage-unavailable') {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(new Error(reason));
      }
      request.onupgradeneeded = event => {
        if (closed || event.oldVersion !== 0) { request.transaction?.abort(); return; }
        request.result.createObjectStore('owners');
      };
      request.onerror = () => fail(request.error?.name === 'VersionError' ? 'storage-invalid' : 'storage-unavailable');
      request.onblocked = () => fail();
      request.onsuccess = () => {
        if (closed || settled) { request.result.close(); fail(); return; }
        const db = request.result;
        if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('owners')) { db.close(); fail('storage-invalid'); return; }
        database = db;
        db.onversionchange = () => { db.close(); database = undefined; opening = undefined; };
        settled = true; clearTimeout(timer); resolve(db);
      };
    }).catch(error => { opening = undefined; throw error; });
    return opening;
  }
  return {
    async transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T }): Promise<T> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId) || typeof mutation !== 'function')
        throw new TypeError('invalid-storage-owner');
      const db = await open();
      if (closed) throw new Error('storage-unavailable');
      return new Promise<T>((resolve, reject) => {
        let result: T, completed = false, mutationError: unknown;
        const transaction = db.transaction('owners', 'readwrite');
        transactions.add(transaction);
        const timer = setTimeout(abort, timeoutMs);
        function finish() { clearTimeout(timer); transactions.delete(transaction); }
        function abort() {
          try { transaction.abort(); }
          catch { finish(); reject(mutationError ?? new Error('storage-unavailable')); }
        }
        transaction.onabort = () => { finish(); reject(mutationError ?? new Error('storage-unavailable')); };
        transaction.onerror = () => { /* The abort event reports a fixed public failure. */ };
        transaction.oncomplete = () => { finish(); if (completed) resolve(result); else reject(new Error('storage-unavailable')); };
        const store = transaction.objectStore('owners'), read = store.get(ownerId);
        read.onsuccess = () => {
          try {
            if (closed) { abort(); return; }
            let next: ReturnType<typeof mutation>;
            try { next = mutation(read.result); }
            catch (error) { mutationError = error; abort(); return; }
            if (closed) { abort(); return; }
            // Thenables cannot keep an IndexedDB transaction alive and are never accepted.
            const state = Object.getOwnPropertyDescriptor(next, 'state');
            const value = Object.getOwnPropertyDescriptor(next, 'result');
            if (!state || !Object.hasOwn(state, 'value') || !value || !Object.hasOwn(value, 'value') ||
                Object.getOwnPropertyDescriptor(next, 'then')) {
              mutationError = new Error('storage-invalid'); abort(); return;
            }
            store.put(state.value, ownerId); result = value.value as T; completed = true;
          } catch { abort(); }
        };
      });
    },
    close() {
      closed = true;
      for (const transaction of transactions) { try { transaction.abort(); } catch { /* Already completed. */ } }
      database?.close(); database = undefined;
    },
  };
}
