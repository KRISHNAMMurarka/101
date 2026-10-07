import assert from 'node:assert/strict';
import test from 'node:test';
import { createRememberedDeviceStore, REMEMBERED_DEVICE_LIMITS, REMEMBERED_DEVICE_KEY } from './remembered-devices.ts';

// Trusted native-shaped cooperative ports only; no native browser or enrollment claim.
class StorageFixture implements Pick<Storage, 'getItem' | 'setItem'> {
  value: string | null = null; reads = 0; writes = 0; denied = false; quota = false;
  getItem(key: string) { assert.equal(key, REMEMBERED_DEVICE_KEY); this.reads++;
    if (this.denied) throw Error('PRIVATE_STORAGE_VALUE'); return this.value; }
  setItem(key: string, value: string) { assert.equal(key, REMEMBERED_DEVICE_KEY); this.writes++;
    if (this.quota) throw new DOMException('PRIVATE_QUOTA_VALUE', 'QuotaExceededError'); this.value = value; }
}
class LocksFixture implements Pick<LockManager, 'request'> {
  calls = 0; pause = false; hold = false; onRequest?: () => void;
  waiting: (() => void)[] = []; returns: (() => void)[] = [];
  request<T>(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<T>, supplied?: LockGrantedCallback<T>): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : supplied;
    assert.ok(callback); assert.equal(name, `${REMEMBERED_DEVICE_KEY}:lock`); assert.equal(options.mode, 'exclusive'); this.calls++;
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (cause: unknown) => void, ended = false;
    const issued = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const finish = (work: () => void) => { if (ended) return; ended = true;
      options.signal?.removeEventListener('abort', cancel); if (this.hold) this.returns.push(work); else work(); };
    const cancel = () => { const index = this.waiting.indexOf(run); if (index >= 0) this.waiting.splice(index, 1);
      finish(() => reject(new DOMException('Owned queued request', 'AbortError'))); };
    const run = () => { if (ended) return;
      try { const value = callback({ name, mode: 'exclusive' });
        void Promise.resolve(value).then(result => finish(() => resolve(result)), cause => finish(() => reject(cause))); }
      catch (cause) { finish(() => reject(cause)); } };
    this.waiting.push(run); options.signal?.addEventListener('abort', cancel, { once: true }); this.onRequest?.();
    if (options.signal?.aborted) cancel(); else if (!this.pause) this.waiting.shift()?.(); return issued;
  }
  release() { for (const work of this.returns.splice(0)) work(); }
}
const metadata = (letter = 'a') => ({ publicKeyId: letter.repeat(64), label: 'Reported software meter' });
const document = (devices: readonly unknown[], schemaVersion = 1) => JSON.stringify({ schemaVersion, devices });
const guard = () => ({ signal: new AbortController().signal, isCurrent: () => true });

 test('remembered metadata store is inert and a denied save performs no native dispatch', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(), store = createRememberedDeviceStore({ storage, locks });
  try {
    assert.equal(storage.reads, 0); assert.equal(locks.calls, 0); assert.deepEqual(store.snapshot().records, []);
    assert.equal(await store.save(metadata(), { ...guard(), isCurrent: () => false }), false);
    assert.equal(storage.reads, 0); assert.equal(storage.writes, 0); assert.equal(locks.calls, 0);
  } finally { await store.close(); }
});

test('restored remembered metadata is offline and contains only name and past public key', async () => {
  const storage = new StorageFixture(); storage.value = document([metadata()]);
  const store = createRememberedDeviceStore({ storage, locks: new LocksFixture() });
  try {
    assert.equal(await store.load(), true);
    assert.deepEqual(store.snapshot().records, [{ ...metadata(), state: 'offline' }]);
    assert.equal(Object.isFrozen(store.snapshot().records[0]), true);
    assert.equal(storage.writes, 0); assert.equal(store.snapshot().pending, 0);
  } finally { await store.close(); }
});

test('closed metadata rejects secrets and getters before selecting native storage', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(), store = createRememberedDeviceStore({ storage, locks });
  let calls = 0;
  try {
    for (const input of [{ ...metadata(), offer: 'PRIVATE_OFFER' }, { ...metadata(), grant: true },
      { ...metadata(), publicKeyId: 'not-a-key' }, { ...metadata(), label: '\u0000name' },
      { publicKeyId: 'a'.repeat(64), get label() { calls++; return 'PRIVATE_LABEL'; } }]) {
      assert.equal(await store.save(input, guard()), false);
    }
    assert.equal(calls, 0); assert.equal(storage.reads, 0); assert.equal(locks.calls, 0);
  } finally { await store.close(); }
});

test('corrupt and future documents are preserved on load save and explicit removal', async () => {
  for (const value of ['not JSON', document([metadata()], 2), document([{ ...metadata(), credential: 'PRIVATE_CREDENTIAL' }]),
    document([metadata(), metadata()]), ' '.repeat(REMEMBERED_DEVICE_LIMITS.documentBytes + 1)]) {
    const storage = new StorageFixture(); storage.value = value;
    const store = createRememberedDeviceStore({ storage, locks: new LocksFixture() });
    try {
      assert.equal(await store.load(), false); assert.deepEqual(store.snapshot().records, []);
      assert.equal(await store.save(metadata('b'), guard()), false); assert.equal(await store.forget(metadata().publicKeyId), false);
      assert.equal(storage.value, value); assert.equal(storage.writes, 0);
      assert.ok(['corrupt', 'future'].includes(store.snapshot().outcome));
    } finally { await store.close(); }
  }
});

test('eight-record and UTF8 byte bounds are enforced with no eviction or migration', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture();
  const records = Array.from({ length: 8 }, (_, index) => ({ publicKeyId: index.toString(16).repeat(64), label: `Meter ${index}` }));
  storage.value = document(records); const original = storage.value;
  const store = createRememberedDeviceStore({ storage, locks });
  try {
    assert.equal(await store.load(), true); assert.equal(store.snapshot().records.length, 8);
    assert.equal(await store.save(metadata('f'), guard()), false); assert.equal(store.snapshot().outcome, 'capacity'); assert.equal(storage.value, original);
    assert.equal(await store.save({ ...metadata('f'), label: '😀'.repeat(129) }, guard()), false); assert.equal(storage.value, original);
    assert.equal(await store.forget(records[0]!.publicKeyId), true); assert.equal(store.snapshot().records.length, 7);
    assert.equal(await store.save(metadata('f'), guard()), true); assert.equal(store.snapshot().records.length, 8);
    const parsed = JSON.parse(storage.value!); assert.deepEqual(Object.keys(parsed).sort(), ['devices', 'schemaVersion']);
    for (const row of parsed.devices) assert.deepEqual(Object.keys(row).sort(), ['label', 'publicKeyId']);
  } finally { await store.close(); }
});

test('denied and quota storage do not become RAM and expose only fixed recovery outcomes', async () => {
  const storage = new StorageFixture(), store = createRememberedDeviceStore({ storage, locks: new LocksFixture() });
  try {
    storage.denied = true; assert.equal(await store.load(), false); assert.equal(store.snapshot().outcome, 'unavailable');
    storage.denied = false; assert.equal(await store.load(), true); storage.quota = true;
    assert.equal(await store.save(metadata(), guard()), false); assert.equal(storage.value, null); assert.equal(store.snapshot().outcome, 'quota');
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE_/); storage.quota = false;
    assert.equal(await store.save(metadata(), guard()), true); assert.equal(store.snapshot().records.length, 1);
  } finally { await store.close(); }
});

test('fresh final guard and raw revision comparison refuse a changed document', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(), store = createRememberedDeviceStore({ storage, locks });
  let checks = 0;
  try {
    assert.equal(await store.save(metadata(), { signal: new AbortController().signal, isCurrent() {
      checks++; if (checks === 2) storage.value = document([metadata('b')]); return true;
    } }), false);
    assert.equal(storage.writes, 0); assert.equal(store.snapshot().outcome, 'conflict');
    assert.equal(storage.value, document([metadata('b')]));
  } finally { await store.close(); }
});

test('cancel and stable close retain the actual queued native-shaped request return', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); locks.pause = true; locks.hold = true;
  const store = createRememberedDeviceStore({ storage, locks }); const saving = store.save(metadata(), guard());
  try {
    assert.equal(locks.calls, 1); store.cancel(); const closed = store.close(); assert.equal(store.close(), closed);
    let done = false; void closed.then(() => { done = true; }); await Promise.resolve(); await Promise.resolve();
    assert.equal(done, false); assert.equal(store.snapshot().pending, 1); assert.equal(storage.writes, 0);
    locks.hold = false; locks.release(); assert.equal(await saving, false); await closed;
    assert.equal(store.snapshot().pending, 0); assert.equal(store.snapshot().closed, true); assert.equal(storage.value, null);
  } finally { locks.hold = false; locks.release(); await saving; await store.close(); }
});

test('request close reentry observes the reserved operation and cannot publish a late record', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); locks.hold = true;
  let retained: Promise<void> | undefined, done = false;
  const store = createRememberedDeviceStore({ storage, locks });
  locks.onRequest = () => { retained = store.close(); void retained.then(() => { done = true; }); };
  const saving = store.save(metadata(), guard());
  try {
    await Promise.resolve(); await Promise.resolve(); assert.equal(done, false); assert.equal(store.snapshot().pending, 1);
    locks.hold = false; locks.release(); assert.equal(await saving, false); await retained;
    assert.equal(storage.writes, 0); assert.equal(store.snapshot().records.length, 0); assert.equal(store.snapshot().pending, 0);
  } finally { locks.hold = false; locks.release(); await saving; await store.close(); }
});

test('reviewed public backup is absent only after an actual saved metadata prefix', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(), store = createRememberedDeviceStore({ storage, locks, reviewNow: () => 1000 });
  try {
    assert.equal(storage.reads, 0); assert.equal(locks.calls, 0);
    assert.equal(await store.save(metadata(), guard()), true);
    assert.equal(storage.writes, 1); assert.equal(locks.calls, 1); assert.equal(store.snapshot().pending, 0);
    assert.equal(storage.value, document([metadata()]));
    assert.equal(typeof store.reviewExport, 'function', 'missing reviewed public backup after genuine existing store save');
    assert.equal(await store.reviewExport(), true);
    const review = store.snapshot().backupReview!;
    assert.equal(review.action, 'export'); assert.deepEqual(review.records, [{ ...metadata(), state: 'offline' }]);
    assert.equal(store.snapshot().backupText, undefined, 'copy text needs the second explicit approval');
    assert.equal(await store.confirmBackup(review.handle), true);
    assert.equal(store.snapshot().backupText, document([metadata()])); assert.equal(storage.writes, 1);
    assert.equal(await store.confirmBackup(review.handle), false, 'consumed reviews never replay');
  } finally { await store.close(); }
});

test('backup review and restore stay inert until explicit choice and empty-store approval', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(), store = createRememberedDeviceStore({ storage, locks, reviewNow: () => 1000 });
  try {
    assert.equal(storage.reads, 0); assert.equal(locks.calls, 0); assert.equal(store.snapshot().backupReview, undefined);
    assert.equal(await store.reviewImport(document([metadata(), metadata('b')])), true);
    const review = store.snapshot().backupReview!;
    assert.equal(review.action, 'import'); assert.equal(storage.writes, 0); assert.equal(locks.calls, 0);
    assert.equal(Object.isFrozen(review.records), true); assert.equal(Object.isFrozen(review.records[0]), true);
    assert.equal(await store.confirmBackup({ kind: 'remembered-public-backup' }), false);
    assert.equal(storage.writes, 0);
    assert.equal(await store.confirmBackup(review.handle), true);
    assert.equal(locks.calls, 1); assert.equal(storage.value, document([metadata(), metadata('b')]));
    assert.deepEqual(store.snapshot().records, [{ ...metadata(), state: 'offline' }, { ...metadata('b'), state: 'offline' }]);
    assert.equal(store.snapshot().backupReview, undefined); assert.equal(store.snapshot().outcome, 'restored');
  } finally { await store.close(); }
});

test('restore never merges replaces or resets nonempty corrupt or future stored data', async () => {
  for (const existing of [document([metadata('b')]), 'not JSON', document([], 2)]) {
    const storage = new StorageFixture(); storage.value = existing;
    const store = createRememberedDeviceStore({ storage, locks: new LocksFixture(), reviewNow: () => 1000 });
    try {
      assert.equal(await store.reviewImport(document([metadata()])), false);
      assert.equal(store.snapshot().backupReview, undefined); assert.equal(storage.value, existing); assert.equal(storage.writes, 0);
      assert.ok(['not-empty', 'corrupt', 'future'].includes(store.snapshot().outcome));
    } finally { await store.close(); }
  }
});

test('closed backup schema and original bounds are checked before native reads', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(), store = createRememberedDeviceStore({ storage, locks, reviewNow: () => 1000 });
  try {
    const tooMany = Array.from({ length: 9 }, (_, index) => metadata(index.toString(16)));
    for (const raw of ['not JSON', document([metadata()], 2), JSON.stringify({ schemaVersion: 1, devices: [], grants: [] }),
      document([{ ...metadata(), offer: 'PRIVATE_OFFER' }]), document([metadata(), metadata()]), document(tooMany),
      document([{ ...metadata(), label: '😀'.repeat(129) }]), ' '.repeat(8193)]) {
      assert.equal(await store.reviewImport(raw), false); assert.equal(store.snapshot().outcome, 'invalid-backup');
    }
    assert.equal(storage.reads, 0); assert.equal(locks.calls, 0); assert.equal(storage.writes, 0);
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE_/);
  } finally { await store.close(); }
});

test('empty raw identity and final CAS refuse intervening external storage mutations', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); let at = 1000, checks = 0;
  const store = createRememberedDeviceStore({ storage, locks, reviewNow() {
    if (++checks === 4) storage.value = document([metadata('b')]); return at;
  } });
  try {
    assert.equal(await store.reviewImport(document([metadata()])), true);
    const review = store.snapshot().backupReview!; at = 1001;
    assert.equal(await store.confirmBackup(review.handle), false);
    assert.equal(storage.writes, 0); assert.equal(storage.value, document([metadata('b')])); assert.equal(store.snapshot().outcome, 'conflict');
  } finally { await store.close(); }
  const empty = new StorageFixture(), other = createRememberedDeviceStore({ storage: empty, locks: new LocksFixture(), reviewNow: () => 1000 });
  try {
    assert.equal(await other.reviewImport(document([metadata()])), true); const review = other.snapshot().backupReview!;
    empty.value = document([]); // Empty still changed; no overwrite of a new raw revision.
    assert.equal(await other.confirmBackup(review.handle), false); assert.equal(empty.writes, 0); assert.equal(empty.value, document([]));
  } finally { await other.close(); }
});

test('expiry cancellation and fresh storage denial preserve data and retire review text', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); let at = 1000;
  const store = createRememberedDeviceStore({ storage, locks, reviewNow: () => at });
  try {
    assert.equal(await store.reviewImport(document([metadata()])), true); const first = store.snapshot().backupReview!;
    at = 31000; assert.equal(await store.confirmBackup(first.handle), false); assert.equal(store.snapshot().outcome, 'expired');
    assert.equal(storage.writes, 0); assert.equal(storage.value, null);
    at = 32000; assert.equal(await store.reviewImport(document([metadata()])), true); const cancelled = store.snapshot().backupReview!;
    store.cancel(); assert.equal(await store.confirmBackup(cancelled.handle), false); assert.equal(storage.writes, 0);
    assert.equal(await store.reviewImport(document([metadata()])), true); const denied = store.snapshot().backupReview!;
    storage.denied = true; assert.equal(await store.confirmBackup(denied.handle), false); assert.equal(storage.writes, 0);
    storage.denied = false; assert.equal(await store.reviewImport(document([metadata()])), true); storage.quota = true;
    assert.equal(await store.confirmBackup(store.snapshot().backupReview!.handle), false); assert.equal(store.snapshot().outcome, 'quota');
    assert.equal(storage.value, null); storage.quota = false;
    assert.equal(await store.reviewImport(document([metadata()])), true); assert.equal(await store.confirmBackup(store.snapshot().backupReview!.handle), true);
    assert.equal(await store.reviewExport(), true); assert.equal(await store.confirmBackup(store.snapshot().backupReview!.handle), true);
    assert.ok(store.snapshot().backupText); store.cancel(); assert.equal(store.snapshot().backupText, undefined);
  } finally { await store.close(); }
});

test('export confirmation refuses a changed raw source and expired or backward review clock', async () => {
  const storage = new StorageFixture(); storage.value = document([metadata()]); let at = 1000;
  const store = createRememberedDeviceStore({ storage, locks: new LocksFixture(), reviewNow: () => at });
  try {
    assert.equal(await store.reviewExport(), true); const review = store.snapshot().backupReview!;
    storage.value = document([metadata('b')]); assert.equal(await store.confirmBackup(review.handle), false);
    assert.equal(store.snapshot().outcome, 'conflict'); assert.equal(store.snapshot().backupText, undefined); assert.equal(storage.writes, 0);
    assert.equal(await store.reviewExport(), true); at = 999;
    assert.equal(await store.confirmBackup(store.snapshot().backupReview!.handle), false); assert.equal(store.snapshot().outcome, 'expired');
    assert.equal(store.snapshot().backupText, undefined); assert.equal(storage.value, document([metadata('b')]));
  } finally { await store.close(); }
});

test('queued restore retains its real native-shaped return through cancel and stable reentrant close', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); locks.pause = true; locks.hold = true;
  const store = createRememberedDeviceStore({ storage, locks, reviewNow: () => 1000 }); let restoring: Promise<boolean> | undefined;
  try {
    assert.equal(await store.reviewImport(document([metadata()])), true);
    restoring = store.confirmBackup(store.snapshot().backupReview!.handle); assert.equal(locks.calls, 1);
    store.cancel(); const closing = store.close(); assert.equal(store.close(), closing);
    let settled = false; void closing.then(() => { settled = true; }); await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false); assert.equal(store.snapshot().pending, 1); assert.equal(storage.writes, 0);
    locks.hold = false; locks.release(); assert.equal(await restoring, false); await closing;
    assert.equal(store.snapshot().pending, 0); assert.equal(store.snapshot().backupReview, undefined); assert.equal(storage.value, null);
  } finally { locks.hold = false; locks.release(); await restoring; await store.close(); }
});

test('a review expiring while its actual exclusive request is queued cannot write at final approval', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); locks.pause = true; let at = 1000;
  const store = createRememberedDeviceStore({ storage, locks, reviewNow: () => at }); let restoring: Promise<boolean> | undefined;
  try {
    assert.equal(await store.reviewImport(document([metadata()])), true);
    restoring = store.confirmBackup(store.snapshot().backupReview!.handle); assert.equal(locks.calls, 1); assert.equal(store.snapshot().pending, 1);
    at = 31000; locks.waiting.shift()?.();
    assert.equal(await restoring, false); assert.equal(store.snapshot().outcome, 'expired'); assert.equal(storage.writes, 0); assert.equal(storage.value, null);
  } finally { store.cancel(); locks.release(); await restoring; await store.close(); }
});

test('review clock close reentry sees reserved work and prevents any native read or restore', async () => {
  const storage = new StorageFixture(), locks = new LocksFixture(); let closing: Promise<void> | undefined;
  const store = createRememberedDeviceStore({ storage, locks, reviewNow() { closing = store.close(); return 1000; } });
  try {
    const reviewing = store.reviewImport(document([metadata()]));
    assert.equal(store.snapshot().pending, 1); assert.equal(storage.reads, 0); assert.equal(locks.calls, 0);
    assert.equal(store.close(), closing); assert.equal(await reviewing, false); await closing;
    assert.equal(store.snapshot().pending, 0); assert.equal(store.snapshot().backupReview, undefined); assert.equal(storage.writes, 0);
  } finally { await store.close(); }
});
