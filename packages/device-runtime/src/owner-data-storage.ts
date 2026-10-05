import { OWNER_DATA_LIMITS, snapshotOwnerDataState } from './owner-data.ts';
import type { OwnerDataStorage } from './owner-data.ts';

export interface IndexedDbOwnerDataStorage extends OwnerDataStorage { close(): void }
/** Every producer envelope, barrier, local recipient copy and audit share this owner transaction. */
export function createIndexedDbOwnerDataStorage(options: { databaseName: string; indexedDB?: IDBFactory; timeoutMs?: number }): IndexedDbOwnerDataStorage {
  const factory = options.indexedDB ?? globalThis.indexedDB, timeout = options.timeoutMs ?? 5000;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.databaseName) || !factory || typeof factory.open !== 'function' ||
    !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 10000) throw new TypeError('Invalid managed storage configuration');
  let closed = false, database: IDBDatabase | undefined, opening: Promise<IDBDatabase> | undefined, reserved = 0;
  const pending = new Set<IDBTransaction>();
  function open() {
    if (closed) return Promise.reject(new Error('managed-storage-unavailable'));
    if (database) return Promise.resolve(database); if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = factory.open(options.databaseName, 1), timer = setTimeout(() => finish(), timeout);
      function finish() { if (settled) return; settled = true; clearTimeout(timer); reject(new Error('managed-storage-unavailable')); }
      request.onupgradeneeded = event => {
        if (closed || event.oldVersion !== 0) { request.transaction?.abort(); return; }
        request.result.createObjectStore('owners');
      };
      request.onerror = finish; request.onblocked = finish;
      request.onsuccess = () => {
        const db = request.result;
        if (settled || closed || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('owners')) { db.close(); finish(); return; }
        settled = true; clearTimeout(timer); database = db;
        db.onversionchange = () => { closed = true; for (const transaction of pending) { try { transaction.abort(); } catch { /* Settled. */ } } db.close(); };
        resolve(db);
      };
    }).catch(error => { opening = undefined; throw error; });
    return opening;
  }
  return Object.freeze({
    async transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T },
      guard?: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): Promise<T> {
      if (typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId) || typeof mutation !== 'function') throw new TypeError('Invalid managed storage owner');
      if (closed || reserved >= OWNER_DATA_LIMITS.storageOperations) throw new Error('managed-storage-unavailable');
      reserved++;
      try {
      const db = await open(); if (closed) throw new Error('managed-storage-unavailable');
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction('owners', 'readwrite'), store = transaction.objectStore('owners');
        pending.add(transaction); let result: T, ready = false, failure: unknown;
        const timer = setTimeout(abort, timeout);
        function abort() { try { transaction.abort(); } catch { finish(); reject(failure ?? new Error('managed-storage-unavailable')); } }
        function finish() { clearTimeout(timer); pending.delete(transaction); guard?.signal.removeEventListener('abort', abort); }
        function current() { if (closed || guard?.signal.aborted || guard && !guard.isCurrent() || guard?.signal.aborted || closed) throw new Error('managed-storage-unavailable'); }
        transaction.oncomplete = () => { finish(); if (ready) resolve(result); else reject(new Error('managed-storage-unavailable')); };
        transaction.onerror = () => { /* Abort is the single rejection path. */ };
        transaction.onabort = () => { finish(); reject(failure ?? new Error('managed-storage-unavailable')); };
        if (guard?.signal.aborted) { abort(); return; } guard?.signal.addEventListener('abort', abort, { once: true });
        const read = store.get(ownerId);
        read.onsuccess = () => {
          try {
            current(); const next = mutation(read.result);
            const state = Object.getOwnPropertyDescriptor(next, 'state'), value = Object.getOwnPropertyDescriptor(next, 'result');
            if (!state?.enumerable || !('value' in state) || !value?.enumerable || !('value' in value) ||
              Reflect.ownKeys(next).length !== 2) throw new Error('managed-storage-invalid');
            const copied = snapshotOwnerDataState(state.value); current();
            store.put(copied, ownerId); result = value.value as T; ready = true;
            // Reentrant code from the trusted guard cannot close or revoke and still commit.
            current();
          } catch (error) { failure = error; abort(); }
        };
      });
      } finally { reserved--; }
    },
    close() { if (closed) return; closed = true;
      for (const transaction of pending) { try { transaction.abort(); } catch { /* Settled. */ } }
      database?.close(); database = undefined;
    },
  });
}
