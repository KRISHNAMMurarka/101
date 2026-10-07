/** Historical display metadata only. This module cannot acquire a connection,
 * identify a physical device, restore an identity or grant a resource operation. */
export const REMEMBERED_DEVICE_KEY = '101:remembered-resource-devices/1';
export const REMEMBERED_DEVICE_LIMITS = Object.freeze({ records: 8, documentBytes: 8192, labelCharacters: 128, labelBytes: 512 });
export const REMEMBERED_BACKUP_REVIEW_MS = 30000;
export interface RememberedDevice { readonly publicKeyId: string; readonly label: string }
export interface RememberedBackupHandle { readonly kind: 'remembered-public-backup' }
export interface RememberedBackupReview {
  readonly handle: RememberedBackupHandle; readonly action: 'export' | 'import';
  readonly records: readonly Readonly<RememberedDevice & { state: 'offline' }>[];
}
export interface RememberedDeviceSnapshot {
  readonly records: readonly Readonly<RememberedDevice & { state: 'offline' }>[];
  readonly pending: number; readonly closed: boolean;
  readonly outcome: 'idle' | 'ready' | 'working' | 'saved' | 'forgotten' | 'stopped' | 'closed' | 'invalid' | 'unavailable' | 'quota' | 'corrupt' | 'future' | 'capacity' | 'conflict' |
    'reviewing' | 'exported' | 'restored' | 'not-empty' | 'invalid-backup' | 'expired';
  readonly backupReview?: RememberedBackupReview; readonly backupText?: string;
}
export interface RememberedDeviceStoreOptions {
  /** Trusted synchronous native-equivalent ports. Their final read/write segment
   * must not mutate authority, invoke clock/consent callbacks or yield. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly locks?: Pick<LockManager, 'request'>;
  /** Trusted review clock only. It never supplies connection or resource authority. */
  readonly reviewNow?: () => number;
  readonly onChange?: () => void;
}
export interface RememberedDeviceStore {
  load(): Promise<boolean>;
  save(metadata: unknown, guard: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): Promise<boolean>;
  forget(publicKeyId: string): Promise<boolean>;
  reviewExport(): Promise<boolean>; reviewImport(text: string): Promise<boolean>;
  confirmBackup(handle: RememberedBackupHandle): Promise<boolean>;
  cancel(): void; snapshot(): RememberedDeviceSnapshot; close(): Promise<void>;
}
type Outcome = RememberedDeviceSnapshot['outcome'];
class MemoryFailure extends Error {
  readonly outcome: Outcome;
  constructor(outcome: Outcome) { super(outcome); this.outcome = outcome; }
}
function fail(outcome: Outcome): never { throw new MemoryFailure(outcome); }
const encoder = new TextEncoder(), nativeThen = Promise.prototype.then, NativeAbortController = AbortController, nativeNow = Date.now;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
const nativeAbort = AbortController.prototype.abort;
const nativeGet = typeof Storage === 'function' ? Storage.prototype.getItem : undefined;
const nativeSet = typeof Storage === 'function' ? Storage.prototype.setItem : undefined;
const nativeRequest = typeof LockManager === 'function' ? LockManager.prototype.request : undefined;
const errorName = typeof DOMException === 'function' ? Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get : undefined;
function aborted(signal: AbortSignal): boolean { return abortedGetter.call(signal) === true; }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail('invalid');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('invalid'); result[key] = descriptor.value;
  }
  return result;
}
function keyId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function metadata(input: unknown): Readonly<RememberedDevice> {
  const value = fields(input, ['publicKeyId', 'label']), label = value.label;
  if (!keyId(value.publicKeyId) || typeof label !== 'string' || !label || label.length > 256 ||
    Array.from(label).length > REMEMBERED_DEVICE_LIMITS.labelCharacters || encoder.encode(label).byteLength > REMEMBERED_DEVICE_LIMITS.labelBytes ||
    Array.from(label).some(character => { const code = character.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159; })) fail('invalid');
  return Object.freeze({ publicKeyId: value.publicKeyId, label });
}
function parsed(raw: string | undefined): readonly Readonly<RememberedDevice>[] {
  if (raw === undefined) return Object.freeze([]);
  if (raw.length > REMEMBERED_DEVICE_LIMITS.documentBytes || encoder.encode(raw).byteLength > REMEMBERED_DEVICE_LIMITS.documentBytes) fail('corrupt');
  let value: Record<string, unknown>;
  try { value = fields(JSON.parse(raw), ['schemaVersion', 'devices']); } catch { return fail('corrupt'); }
  if (value.schemaVersion !== 1) fail(typeof value.schemaVersion === 'number' && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > 1 ? 'future' : 'corrupt');
  if (!Array.isArray(value.devices) || value.devices.length > REMEMBERED_DEVICE_LIMITS.records) fail('corrupt');
  const seen = new Set<string>(), records: Readonly<RememberedDevice>[] = [];
  for (const row of value.devices) {
    let device: Readonly<RememberedDevice>; try { device = metadata(row); } catch { return fail('corrupt'); }
    if (seen.has(device.publicKeyId)) fail('corrupt'); seen.add(device.publicKeyId); records.push(device);
  }
  return Object.freeze(records);
}
interface Operation { readonly owner: AbortController; readonly returned: Promise<boolean>; retired: boolean }
interface Backup {
  readonly handle: RememberedBackupHandle; readonly action: 'export' | 'import'; readonly expectedRaw: string | undefined;
  readonly records: readonly Readonly<RememberedDevice>[]; readonly text: string; readonly expiresAt: number;
}
/** Construction is inert. Reads are explicit; writes always require an exclusive
 * native WebLock. Denial never substitutes RAM or overwrites corrupt/future data. */
export function createRememberedDeviceStore(options: RememberedDeviceStoreOptions = {}): RememberedDeviceStore {
  let closed = false, outcome: Outcome = 'idle', records: readonly Readonly<RememberedDevice>[] = Object.freeze([]);
  let pending: Operation | undefined, closing: Promise<void> | undefined, resolveClose: (() => void) | undefined;
  let backup: Backup | undefined, backupText: string | undefined, previousReviewTime = -Infinity;
  let storagePort: Pick<Storage, 'getItem' | 'setItem'> | undefined, request: ((signal: AbortSignal, callback: LockGrantedCallback<boolean>) => Promise<unknown>) | undefined;
  const lockName = `${REMEMBERED_DEVICE_KEY}:lock`;
  function notify() { try { options.onChange?.(); } catch { /* A view supplies no storage authority. */ } }
  function finishClose() { if (closed && !pending) { records = Object.freeze([]); const done = resolveClose; resolveClose = undefined; done?.(); } }
  function selectStorage() {
    if (storagePort) return storagePort;
    try {
      if (options.storage) { const input = options.storage;
        const get = input.getItem, set = input.setItem;
        if (typeof get !== 'function' || typeof set !== 'function') fail('unavailable');
        storagePort = { getItem: key => get.call(input, key), setItem: (key, value) => set.call(input, key, value) };
      } else {
        if (!nativeGet || !nativeSet) fail('unavailable'); const storage = globalThis.localStorage;
        storagePort = { getItem: key => nativeGet.call(storage, key), setItem: (key, value) => nativeSet.call(storage, key, value) };
      }
      return storagePort;
    } catch { return fail('unavailable'); }
  }
  function readRaw(): string | undefined {
    let value: unknown; try { value = selectStorage().getItem(REMEMBERED_DEVICE_KEY); } catch { return fail('unavailable'); }
    if (value === null) return undefined;
    if (typeof value !== 'string') fail('unavailable'); return value;
  }
  function selectRequest() {
    if (request) return request;
    try {
      if (options.locks) { const input = options.locks, call = input.request;
        if (typeof call !== 'function') fail('unavailable'); request = (signal, callback) => call.call(input, lockName, { mode: 'exclusive', signal }, callback);
      } else {
        if (!nativeRequest) fail('unavailable'); const locks = globalThis.navigator?.locks;
        if (!locks) fail('unavailable'); request = (signal, callback) => nativeRequest.call(locks, lockName, { mode: 'exclusive', signal }, callback);
      }
      return request;
    } catch { return fail('unavailable'); }
  }
  const eligible = (operation: Operation) => !closed && pending === operation && !operation.retired && !aborted(operation.owner.signal);
  function reviewTime(operation: Operation): number {
    let value: number;
    try { value = (options.reviewNow ?? nativeNow)(); } catch { return fail('expired'); }
    if (!eligible(operation)) fail('stopped');
    if (!Number.isFinite(value) || value < 0 || value < previousReviewTime) fail('expired');
    previousReviewTime = value; return value;
  }
  function start(work: (operation: Operation) => boolean | Promise<boolean>): Promise<boolean> {
    if (closed || pending) return Promise.resolve(false);
    let resolve!: (value: boolean) => void;
    const returned = new Promise<boolean>(yes => { resolve = yes; });
    const operation: Operation = { owner: new NativeAbortController(), returned, retired: false };
    pending = operation; backup = undefined; backupText = undefined; outcome = 'working';
    // Ownership precedes every native getter/request or synchronous observer.
    let issued: boolean | Promise<boolean>;
    try { issued = work(operation); } catch (cause) { issued = Promise.reject(cause); }
    void Promise.resolve(issued).then(value => settle(value), cause => {
      outcome = closed ? 'closed' : operation.retired ? 'stopped' : cause instanceof MemoryFailure ? cause.outcome : 'unavailable';
      if (outcome === 'corrupt' || outcome === 'future') records = Object.freeze([]); settle(false);
    });
    function settle(value: boolean) { if (pending === operation) pending = undefined;
      resolve(value); finishClose(); notify(); }
    notify(); return returned;
  }
  function write(operation: Operation, edit: (previous: readonly Readonly<RememberedDevice>[]) => readonly Readonly<RememberedDevice>[],
    signal: AbortSignal, approval: () => boolean, success: Outcome, reviewedRaw?: Readonly<{ value: string | undefined }>): Promise<boolean> {
    let detach = () => {};
    const approved = () => { try { return approval() === true; } catch { return false; } };
    const current = () => eligible(operation) && !aborted(signal);
    try {
      if (!current() || !approved() || !current()) { if (outcome === 'working') outcome = 'stopped'; return Promise.resolve(false); }
      const cancel = () => { operation.retired = true; nativeAbort.call(operation.owner); };
      nativeAdd.call(signal, 'abort', cancel, { once: true }); detach = () => nativeRemove.call(signal, 'abort', cancel);
      const requestPort = selectRequest(); if (!current()) { detach(); outcome = 'stopped'; return Promise.resolve(false); }
      const issued = requestPort(operation.owner.signal, lock => {
        if (!lock || lock.name !== lockName || lock.mode !== 'exclusive' || !current()) return false;
        const expected = readRaw(); if (!current()) return false;
        if (reviewedRaw && expected !== reviewedRaw.value) fail('conflict');
        const next = edit(parsed(expected)), encoded = JSON.stringify({ schemaVersion: 1, devices: next });
        if (encoder.encode(encoded).byteLength > REMEMBERED_DEVICE_LIMITS.documentBytes) fail('capacity');
        if (!approved() || !current()) return false;
        // Captured native methods supply the synchronous final segment. Trusted
        // injected ports must not call authority/clock callbacks within it.
        if (readRaw() !== expected) fail('conflict'); if (!current()) return false;
        try { selectStorage().setItem(REMEMBERED_DEVICE_KEY, encoded); }
        catch (cause) { let name: unknown; try { name = errorName?.call(cause); } catch { /* No raw error output. */ }
          return fail(name === 'QuotaExceededError' ? 'quota' : 'unavailable'); }
        if (current()) { records = next; outcome = success; }
        return true;
      });
      return new Promise<boolean>((resolve, reject) => {
        try { nativeThen.call(issued, value => {
          if (typeof value !== 'boolean') { reject(new MemoryFailure('unavailable')); return; }
          if (!value && outcome === 'working') outcome = closed ? 'closed' : current() ? 'unavailable' : 'stopped';
          resolve(value);
        }, cause => { if (!current()) { outcome = closed ? 'closed' : 'stopped'; resolve(false); } else reject(cause); }); }
        catch { operation.retired = true; nativeAbort.call(operation.owner); reject(new MemoryFailure('unavailable')); }
      }).finally(() => { try { detach(); } catch { /* Already retired signal cannot commit. */ } });
    } catch (cause) { try { detach(); } catch { /* Retired before issue. */ } return Promise.reject(cause); }
  }
  function review(action: 'export' | 'import', imported?: readonly Readonly<RememberedDevice>[]): Promise<boolean> {
    return start(operation => {
      reviewTime(operation);
      const expectedRaw = readRaw(), existing = parsed(expectedRaw);
      if (!eligible(operation)) return false;
      if (action === 'import' && existing.length) fail('not-empty');
      const reviewed = action === 'export' ? existing : imported!;
      const at = reviewTime(operation), expiresAt = at + REMEMBERED_BACKUP_REVIEW_MS;
      if (!Number.isFinite(expiresAt) || expiresAt <= at) fail('expired');
      const text = JSON.stringify({ schemaVersion: 1, devices: reviewed });
      if (encoder.encode(text).byteLength > REMEMBERED_DEVICE_LIMITS.documentBytes) fail('capacity');
      const handle: RememberedBackupHandle = Object.freeze({ kind: 'remembered-public-backup' });
      backup = Object.freeze({ handle, action, expectedRaw, records: reviewed, text, expiresAt });
      records = existing; outcome = 'reviewing'; return true;
    });
  }
  function confirmBackup(handle: RememberedBackupHandle): Promise<boolean> {
    if (closed || pending) return Promise.resolve(false);
    const reviewed = backup;
    if (!reviewed || reviewed.handle !== handle) return Promise.resolve(false);
    return start(operation => {
      const approved = () => {
        try { if (reviewTime(operation) >= reviewed.expiresAt) { outcome = 'expired'; return false; } return eligible(operation); }
        catch (cause) { outcome = closed ? 'closed' : cause instanceof MemoryFailure ? cause.outcome : 'expired'; return false; }
      };
      if (reviewed.action === 'import') {
        return write(operation, previous => { if (previous.length) fail('not-empty'); return reviewed.records; },
          operation.owner.signal, approved, 'restored', { value: reviewed.expectedRaw });
      }
      if (!approved()) return false;
      const expected = readRaw(); parsed(expected);
      if (expected !== reviewed.expectedRaw) fail('conflict');
      if (!approved()) return false;
      if (readRaw() !== expected) fail('conflict');
      if (!eligible(operation)) return false;
      backupText = reviewed.text; records = reviewed.records; outcome = 'exported'; return true;
    });
  }
  return Object.freeze({
    load() { return start(operation => { const value = parsed(readRaw()); if (!eligible(operation)) return false;
      records = value; outcome = 'ready'; return true; }); },
    save(input: unknown, guard: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) {
      let value: Readonly<RememberedDevice>, signal: AbortSignal, approval: () => boolean;
      try { value = metadata(input); const supplied = fields(guard, ['signal', 'isCurrent']);
        signal = supplied.signal as AbortSignal; aborted(signal);
        if (typeof supplied.isCurrent !== 'function') fail('invalid'); approval = supplied.isCurrent as () => boolean;
      } catch { outcome = closed ? 'closed' : 'invalid'; notify(); return Promise.resolve(false); }
      return start(operation => write(operation, previous => {
        const index = previous.findIndex(record => record.publicKeyId === value.publicKeyId), next = [...previous];
        if (index < 0) { if (next.length >= REMEMBERED_DEVICE_LIMITS.records) fail('capacity'); next.push(value); } else next[index] = value;
        return Object.freeze(next);
      }, signal, approval, 'saved'));
    },
    forget(publicKeyId: string) {
      if (!keyId(publicKeyId)) { outcome = closed ? 'closed' : 'invalid'; notify(); return Promise.resolve(false); }
      return start(operation => write(operation, previous => Object.freeze(previous.filter(record => record.publicKeyId !== publicKeyId)),
        operation.owner.signal, () => eligible(operation), 'forgotten'));
    },
    reviewExport: () => review('export'),
    reviewImport(text: string) {
      if (closed || pending) return Promise.resolve(false);
      let imported: readonly Readonly<RememberedDevice>[];
      try { if (typeof text !== 'string') fail('invalid-backup'); imported = parsed(text); }
      catch { backup = undefined; backupText = undefined; outcome = 'invalid-backup'; notify(); return Promise.resolve(false); }
      return review('import', imported);
    },
    confirmBackup,
    cancel() { backup = undefined; backupText = undefined;
      const operation = pending; if (operation) { operation.retired = true; nativeAbort.call(operation.owner); } if (!closed) outcome = 'stopped'; notify(); },
    snapshot: () => Object.freeze({ records: Object.freeze(records.map(record => Object.freeze({ ...record, state: 'offline' as const }))),
      pending: pending ? 1 : 0, closed, outcome,
      ...(backup ? { backupReview: Object.freeze({ handle: backup.handle, action: backup.action,
        records: Object.freeze(backup.records.map(record => Object.freeze({ ...record, state: 'offline' as const }))) }) } : {}),
      ...(backupText !== undefined ? { backupText } : {}) }),
    close() { if (closing) return closing;
      closing = new Promise<void>(yes => { resolveClose = yes; }); closed = true; backup = undefined; backupText = undefined; outcome = 'closed';
      const operation = pending; if (operation) { operation.retired = true; nativeAbort.call(operation.owner); }
      finishClose(); notify(); return closing;
    },
  });
}
