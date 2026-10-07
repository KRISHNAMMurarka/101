import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProcessorInstallationStorage, ProcessorInstallationWriteGuard } from '@101/device-runtime';

interface BrowserSession {
  readonly storage: ProcessorInstallationStorage;
  snapshot(): Readonly<{ closed: boolean; pendingWrites: number; lockHeld: boolean }>;
  close(): Promise<void>;
}
type Factory = (options: { ownerId: string; storage?: Pick<Storage, 'getItem' | 'setItem'>; locks?: Pick<LockManager, 'request'> }) => BrowserSession;
const api = await import('./processor-installation-storage.ts').catch(() => undefined);
function factory(): Factory {
  assert.ok(api && typeof api.createBrowserProcessorInstallationStorage === 'function', 'missing durable browser processor storage factory');
  return api.createBrowserProcessorInstallationStorage;
}
const ownerId = 'fixture-owner', key = `101:processor-installation:${ownerId}`;
function document(revision: number) { return JSON.stringify({ version: 1, ownerId, revision, packages: [], revokedPublishers: [] }); }
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nativeGuard(controller = new AbortController(), current = () => true): ProcessorInstallationWriteGuard {
  return Object.freeze({ signal: controller.signal, isCurrent: current });
}
class StorageFixture implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>();
  reads = 0; writes = 0; failReads = false; failWrites = false;
  getItem(name: string) {
    this.reads++;
    if (this.failReads) throw new Error('PRIVATE_STORAGE_SECRET');
    return this.values.get(name) ?? null;
  }
  setItem(name: string, value: string) {
    this.writes++;
    if (this.failWrites) throw new Error('PRIVATE_QUOTA_SECRET');
    this.values.set(name, value);
  }
}
interface WaitingLock { readonly name: string; readonly options: LockOptions; run(): void; abort(): void }
/** Faithful trusted port: exclusive callbacks serialize; issued request promises
 * can be held separately to test returned-work ownership. Native QA is separate. */
class LocksFixture implements Pick<LockManager, 'request'> {
  requests = 0; held = false; pause = false; holdReturns = false;
  readonly waiting: WaitingLock[] = [];
  readonly returns: (() => void)[] = [];
  request<T>(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<T>, supplied?: LockGrantedCallback<T>): Promise<T> {
    this.requests++;
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : supplied;
    assert.ok(callback); assert.equal(options.mode ?? 'exclusive', 'exclusive'); assert.notEqual(options.steal, true);
    const result = deferred<T>(); let started = false, settled = false;
    const finish = (call: () => void) => { if (settled) return; settled = true;
      options.signal?.removeEventListener('abort', entry.abort); if (this.holdReturns) this.returns.push(call); else call(); };
    const entry: WaitingLock = { name, options, abort: () => {
      if (started) return;
      const at = this.waiting.indexOf(entry); if (at >= 0) this.waiting.splice(at, 1);
      finish(() => result.reject(new DOMException('Request aborted', 'AbortError')));
    }, run: () => {
      started = true; this.held = true;
      let value: T | PromiseLike<T>;
      try { value = callback({ name, mode: 'exclusive' }); }
      catch (cause) { this.held = false; finish(() => result.reject(cause)); this.pump(); return; }
      void Promise.resolve(value).then(value => { this.held = false; finish(() => result.resolve(value)); this.pump(); },
        cause => { this.held = false; finish(() => result.reject(cause)); this.pump(); });
    } };
    this.waiting.push(entry);
    options.signal?.addEventListener('abort', entry.abort, { once: true });
    if (options.signal?.aborted) entry.abort(); else this.pump();
    return result.promise;
  }
  pump() { if (!this.pause && !this.held) this.waiting.shift()?.run(); }
  releaseReturns() { for (const finish of this.returns.splice(0)) finish(); }
}
function setup() {
  const storage = new StorageFixture(), locks = new LocksFixture();
  const session = factory()({ ownerId, storage, locks });
  return { storage, locks, session };
}

test('durable storage arrival is inert and close has one terminal barrier', async () => {
  const s = setup();
  assert.deepEqual(s.session.snapshot(), { closed: false, pendingWrites: 0, lockHeld: false });
  assert.equal(s.storage.reads, 0); assert.equal(s.storage.writes, 0); assert.equal(s.locks.requests, 0);
  const closing = s.session.close(); assert.equal(s.session.close(), closing); await closing;
  assert.equal(s.session.snapshot().closed, true); assert.equal(s.session.storage.isCurrent(key, document(0)), false);
});

test('only exact owner key can read or mutate durable installation state', async () => {
  const s = setup();
  try {
    assert.equal(await s.session.storage.read(key), undefined);
    await assert.rejects(s.session.storage.read('101:processor-installation:other-owner'));
    await assert.rejects(s.session.storage.compareAndSwap('other', undefined, document(0), nativeGuard()));
    assert.equal(s.storage.writes, 0); assert.equal(s.locks.requests, 0);
    assert.throws(() => factory()({ ownerId: '', storage: s.storage, locks: s.locks }));
  } finally { await s.session.close(); }
});

test('guarded CAS persists exact bytes and stale comparison cannot overwrite', async () => {
  const s = setup(); const first = document(1), second = document(2);
  try {
    assert.equal(await s.session.storage.compareAndSwap(key, undefined, first, nativeGuard()), true);
    assert.equal(await s.session.storage.read(key), first); assert.equal(s.session.storage.isCurrent(key, first), true);
    assert.equal(await s.session.storage.compareAndSwap(key, undefined, second, nativeGuard()), false);
    assert.equal(s.storage.values.get(key), first);
    assert.equal(await s.session.storage.compareAndSwap(key, first, second, nativeGuard()), true);
    assert.equal(s.session.storage.isCurrent(key, first), false); assert.equal(s.session.storage.isCurrent(key, second), true);
  } finally { await s.session.close(); }
});

test('two cooperative adapters serialize competing original revisions', async () => {
  const backing = new StorageFixture(), locks = new LocksFixture(); locks.pause = true;
  const first = factory()({ ownerId, storage: backing, locks }), second = factory()({ ownerId, storage: backing, locks });
  try {
    const a = first.storage.compareAndSwap(key, undefined, document(1), nativeGuard());
    const b = second.storage.compareAndSwap(key, undefined, document(2), nativeGuard());
    await Promise.resolve(); locks.pause = false; locks.pump();
    assert.deepEqual(await Promise.all([a, b]), [true, false]);
    assert.equal(backing.values.get(key), document(1)); assert.equal(second.storage.isCurrent(key, document(1)), true);
  } finally { locks.pause = false; locks.pump(); await Promise.all([first.close(), second.close()]); }
});

test('native already-aborted guard cannot be shadowed into a commit', async () => {
  const s = setup(), owner = new AbortController(); owner.abort();
  Object.defineProperty(owner.signal, 'aborted', { value: false });
  Object.defineProperty(owner.signal, 'addEventListener', { value() { throw new Error('PRIVATE_LISTENER'); } });
  try {
    assert.equal(await s.session.storage.compareAndSwap(key, undefined, document(1), nativeGuard(owner)), false);
    assert.equal(s.storage.writes, 0);
  } finally { await s.session.close(); }
});

test('guard callback reentry and changed raw state are fenced before commit', async () => {
  const s = setup(); let calls = 0;
  try {
    const guard = nativeGuard(new AbortController(), () => { calls++; s.storage.values.set(key, document(9)); return true; });
    assert.equal(await s.session.storage.compareAndSwap(key, undefined, document(1), guard), false);
    assert.ok(calls >= 1); assert.equal(s.storage.writes, 0); assert.equal(s.storage.values.get(key), document(9));
    const guardClose = nativeGuard(new AbortController(), () => { void s.session.close(); return true; });
    assert.equal(await s.session.storage.compareAndSwap(key, document(9), document(2), guardClose), false);
    assert.equal(s.storage.writes, 0);
  } finally { await s.session.close(); }
});

test('storage read revocation cannot commit under a no-longer-current guard', async () => {
  const backing = new StorageFixture(), locks = new LocksFixture(); let approved = true;
  const storage = { getItem(name: string) { const raw = backing.getItem(name); approved = false; return raw; },
    setItem(name: string, raw: string) { backing.setItem(name, raw); } };
  const session = factory()({ ownerId, storage, locks });
  try {
    assert.equal(await session.storage.compareAndSwap(key, undefined, document(1), nativeGuard(new AbortController(), () => approved)), false);
    assert.equal(backing.writes, 0); assert.equal(backing.values.get(key), undefined);
  } finally { await session.close(); }
});

test('queued abort retains actual returned request until settlement', async () => {
  const s = setup(), owner = new AbortController(); s.locks.pause = true; s.locks.holdReturns = true;
  let operationSettled = false, closeSettled = false;
  const write = s.session.storage.compareAndSwap(key, undefined, document(1), nativeGuard(owner));
  void write.then(() => { operationSettled = true; }, () => { operationSettled = true; });
  try {
    await Promise.resolve(); assert.equal(s.session.snapshot().pendingWrites, 1);
    owner.abort(); const closing = s.session.close(); void closing.then(() => { closeSettled = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(operationSettled, false); assert.equal(closeSettled, false); assert.equal(s.session.snapshot().pendingWrites, 1);
    assert.equal(s.storage.writes, 0);
    s.locks.holdReturns = false; s.locks.releaseReturns();
    await write.catch(() => undefined); await closing;
    assert.equal(s.session.snapshot().pendingWrites, 0); assert.equal(s.storage.writes, 0);
  } finally { s.locks.holdReturns = false; s.locks.pause = false; s.locks.releaseReturns(); s.locks.pump();
    await write.catch(() => undefined); await s.session.close(); }
});

test('one pending write bounds a hanging trusted native port', async () => {
  const s = setup(); s.locks.pause = true;
  const first = s.session.storage.compareAndSwap(key, undefined, document(1), nativeGuard());
  try {
    await Promise.resolve(); await assert.rejects(s.session.storage.compareAndSwap(key, undefined, document(2), nativeGuard()));
    assert.equal(s.session.snapshot().pendingWrites, 1); assert.equal(s.locks.requests, 1);
  } finally { s.locks.pause = false; s.locks.pump(); await first.catch(() => undefined); await s.session.close(); }
});

test('byte limit and quota refusal preserve prior document without private errors', async () => {
  const s = setup(); s.storage.values.set(key, document(0));
  try {
    const large = 'é'.repeat(2 * 1024 * 1024 + 1);
    await assert.rejects(s.session.storage.compareAndSwap(key, document(0), large, nativeGuard()));
    assert.equal(s.locks.requests, 0);
    s.storage.failWrites = true;
    await assert.rejects(s.session.storage.compareAndSwap(key, document(0), document(1), nativeGuard()), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE_QUOTA_SECRET/); return true;
    });
    assert.equal(s.storage.values.get(key), document(0));
    s.storage.failReads = true; assert.equal(s.session.storage.isCurrent(key, document(0)), false);
    await assert.rejects(s.session.storage.read(key), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE_STORAGE_SECRET/); return true;
    });
  } finally { await s.session.close(); }
});

test('unavailable locks never fall back to an unlocked write', async () => {
  const storage = new StorageFixture();
  const locks = { request() { throw new Error('PRIVATE_LOCK_SECRET'); } };
  const session = factory()({ ownerId, storage, locks });
  try {
    await assert.rejects(session.storage.compareAndSwap(key, undefined, document(1), nativeGuard()), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE_LOCK_SECRET/); return true;
    });
    assert.equal(storage.writes, 0); assert.equal(session.snapshot().pendingWrites, 0);
  } finally { await session.close(); }
});
