import { PROCESSOR_EXTENSION_LIMITS } from '@101/device-model';
import type { ProcessorInstallationStorage, ProcessorInstallationWriteGuard } from '@101/device-runtime';

export interface BrowserProcessorInstallationStorageOptions {
  readonly ownerId: string;
  /** Trusted native-equivalent synchronous host port. Final read/write must not
   * invoke authority/clock callbacks or mutate consent. Omit for native Storage. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Trusted native-shaped port. It must return its actual issued request Promise. */
  readonly locks?: Pick<LockManager, 'request'>;
}
export interface BrowserProcessorInstallationStorageSnapshot {
  readonly closed: boolean;
  /** Includes issued requests whose callback returned but whose Promise has not settled. */
  readonly pendingWrites: number;
  /** Synchronous lock callback scope, not a query of browser-internal work. */
  readonly lockHeld: boolean;
}
export interface BrowserProcessorInstallationStorageSession {
  readonly storage: ProcessorInstallationStorage;
  snapshot(): Readonly<BrowserProcessorInstallationStorageSnapshot>;
  /** Retires commits immediately. The same Promise waits for actual issued requests. */
  close(): Promise<void>;
}

type Failure = 'invalid' | 'size' | 'closed' | 'busy' | 'unavailable';
class StorageError extends TypeError {
  constructor(reason: Failure) { super(`browser-processor-storage-${reason}`); }
}
function fail(reason: Failure): never { throw new StorageError(reason); }
const encoder = new TextEncoder();
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
const NativeAbortController = AbortController, nativeAbort = AbortController.prototype.abort;
const nativeThen = Promise.prototype.then;
const nativeGet = typeof Storage === 'function' ? Storage.prototype.getItem : undefined;
const nativeSet = typeof Storage === 'function' ? Storage.prototype.setItem : undefined;
const nativeRequest = typeof LockManager === 'function' ? LockManager.prototype.request : undefined;
function aborted(signal: unknown): boolean {
  const value: unknown = nativeAborted.call(signal);
  if (typeof value !== 'boolean') fail('invalid');
  return value;
}
function isSignal(value: unknown): value is AbortSignal {
  try { aborted(value); return true; } catch { return false; }
}
function own(input: object, name: string, required = false): unknown {
  const value = Object.getOwnPropertyDescriptor(input, name);
  if (!value && !required) return undefined;
  if (!value || !('value' in value)) fail('invalid');
  return value.value;
}
function object(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function document(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('invalid');
  if (value.length > PROCESSOR_EXTENSION_LIMITS.documentBytes ||
    encoder.encode(value).byteLength > PROCESSOR_EXTENSION_LIMITS.documentBytes) fail('size');
}
interface StoragePort { read(): unknown; write(value: string): void }
type RequestPort = (signal: AbortSignal, callback: LockGrantedCallback<boolean>) => Promise<unknown>;
interface PendingWrite {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  settle(): void;
  retired: boolean;
}

/** Cooperative same-origin storage for the existing installation document only.
 * Construction is inert. No unlocked fallback, permission persistence, code
 * loading, eviction recovery or hostile-host rollback protection is supplied. */
export function createBrowserProcessorInstallationStorage(options: BrowserProcessorInstallationStorageOptions): BrowserProcessorInstallationStorageSession {
  let ownerId: unknown, storageInput: unknown, locksInput: unknown;
  try {
    if (!object(options)) fail('invalid');
    ownerId = own(options, 'ownerId', true); storageInput = own(options, 'storage'); locksInput = own(options, 'locks');
  } catch { fail('invalid'); }
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId) ||
    storageInput !== undefined && !object(storageInput) || locksInput !== undefined && !object(locksInput)) fail('invalid');
  const key = `101:processor-installation:${encodeURIComponent(ownerId)}`, lockName = `${key}:storage-lock`;
  let closed = false, lockHeld = false, pending: PendingWrite | undefined, closing: Promise<void> | undefined;
  let storagePort: StoragePort | undefined, requestPort: RequestPort | undefined;
  function exactKey(input: string): void { if (input !== key) fail('invalid'); }
  function selectStorage(): StoragePort {
    if (storagePort) return storagePort;
    try {
      if (object(storageInput)) {
        const get: unknown = Reflect.get(storageInput, 'getItem'), set: unknown = Reflect.get(storageInput, 'setItem');
        if (typeof get !== 'function' || typeof set !== 'function') fail('unavailable');
        storagePort = { read: () => get.call(storageInput, key), write: value => { set.call(storageInput, key, value); } };
      } else {
        if (!nativeGet || !nativeSet) fail('unavailable');
        const storage = globalThis.localStorage;
        if (!storage) fail('unavailable');
        storagePort = { read: () => nativeGet.call(storage, key), write: value => { nativeSet.call(storage, key, value); } };
      }
      return storagePort;
    } catch { return fail('unavailable'); }
  }
  function selectLocks(): RequestPort {
    if (requestPort) return requestPort;
    try {
      if (object(locksInput)) {
        const request: unknown = Reflect.get(locksInput, 'request');
        if (typeof request !== 'function') fail('unavailable');
        requestPort = (signal, callback) => request.call(locksInput, lockName, { mode: 'exclusive', signal }, callback);
      } else {
        if (!nativeRequest) fail('unavailable');
        const locks = globalThis.navigator?.locks;
        if (!locks) fail('unavailable');
        requestPort = (signal, callback) => nativeRequest.call(locks, lockName, { mode: 'exclusive', signal }, callback);
      }
      return requestPort;
    } catch { return fail('unavailable'); }
  }
  function readRaw(): string | undefined {
    if (closed) fail('closed');
    const port = selectStorage();
    if (closed) fail('closed');
    let value: unknown;
    try { value = port.read(); } catch { return fail('unavailable'); }
    if (closed) fail('closed');
    if (value === null) return undefined;
    document(value); return value;
  }
  const storage: ProcessorInstallationStorage = Object.freeze({
    async read(input: string) { exactKey(input); return readRaw(); },
    isCurrent(input: string, expected: string) {
      try { exactKey(input); document(expected); return readRaw() === expected && !closed; } catch { return false; }
    },
    async compareAndSwap(input: string, expected: string | undefined, value: string, guard: ProcessorInstallationWriteGuard) {
      exactKey(input); document(value); if (expected !== undefined) document(expected);
      if (closed) fail('closed'); if (pending) fail('busy');
      const controller = new NativeAbortController();
      let settle!: () => void;
      const operation: PendingWrite = { controller, signal: controller.signal,
        settled: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle(), retired: false };
      // Publish ownership before any guard, port getter or native listener callout.
      pending = operation;
      let owner: AbortSignal | undefined, detach = () => {};
      function cancelled(): boolean {
        try { return closed || operation.retired || aborted(operation.signal) || owner !== undefined && aborted(owner); }
        catch { return true; }
      }
      const eligible = () => pending === operation && !cancelled();
      try {
        if (!object(guard)) fail('invalid');
        const signal = own(guard, 'signal', true), current = own(guard, 'isCurrent', true);
        if (!isSignal(signal) || typeof current !== 'function') fail('invalid');
        owner = signal;
        if (!eligible()) return false;
        const cancel = () => { operation.retired = true; nativeAbort.call(controller); };
        nativeAdd.call(owner, 'abort', cancel, { once: true });
        detach = () => { nativeRemove.call(signal, 'abort', cancel); };
        const approved = () => { try { return current.call(guard) === true; } catch { return false; } };
        if (!eligible() || !approved() || !eligible()) return false;
        const request = selectLocks();
        if (!eligible()) return false;
        const issued = request(operation.signal, lock => {
          if (!lock || lock.name !== lockName || lock.mode !== 'exclusive' || !eligible()) return false;
          lockHeld = true;
          try {
            // Guard callouts may revoke, close or change the original raw document.
            // Its final comparison and intrinsic lifetime fences follow those calls.
            if (!eligible()) return false;
            const port = selectStorage();
            // Initial port/read callouts may retire approval. Check the fresh
            // guard afterwards, then catch any raw mutation by that guard.
            if (!eligible() || readRaw() !== expected || !eligible()) return false;
            if (!approved() || !eligible() || readRaw() !== expected || !eligible()) return false;
            // Captured native Storage methods supply a stable synchronous final
            // read/write segment. Injected ports must supply the same segment,
            // without authority/clock callbacks or consent mutation inside it.
            // No repeated arbitrary host callbacks can make that stronger claim.
            try { port.write(value); } catch { return fail('unavailable'); }
            return true;
          } finally { lockHeld = false; }
        });
        // Intrinsic then observes the actual issued Promise, bypassing an own
        // then property. No logical deadline releases this reservation early.
        return await new Promise<boolean>((resolve, reject) => {
          try { nativeThen.call(issued, result => {
            if (typeof result === 'boolean') resolve(result); else reject(new StorageError('unavailable'));
          }, () => { if (cancelled()) resolve(false); else reject(new StorageError('unavailable')); }); }
          catch { operation.retired = true; nativeAbort.call(controller); reject(new StorageError('unavailable')); }
        });
      } catch (cause) {
        if (cancelled()) return false;
        if (cause instanceof StorageError) throw cause;
        return fail('unavailable');
      } finally {
        operation.retired = true;
        try { detach(); } catch { /* A retained native signal already lost commit authority. */ }
        if (pending === operation) pending = undefined;
        operation.settle();
      }
    },
  });
  return Object.freeze({ storage,
    snapshot: () => Object.freeze({ closed, pendingWrites: pending ? 1 : 0, lockHeld }),
    close(): Promise<void> {
      if (closing) return closing;
      let resolve!: () => void;
      const barrier = new Promise<void>(yes => { resolve = yes; });
      closing = barrier; closed = true;
      const operation = pending;
      if (operation) {
        operation.retired = true;
        void operation.settled.then(resolve, resolve);
        try { nativeAbort.call(operation.controller); } catch { /* Keep the actual request reservation. */ }
      } else resolve();
      return barrier;
    },
  });
}
