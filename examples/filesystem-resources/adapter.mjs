import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OWNED_FILESYSTEM_LIMITS = Object.freeze({ destinations: 4, fileBytes: 512, rootBytes: 2048, attempts: 64, nativePending: 1, nativeCalls: 64, deadlineMs: 2500 });
const intrinsicBytes = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const nativeSet = Uint8Array.prototype.set, hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const no = (reason, issuedMutation = false) => Object.freeze({ ok: false, reason, issuedMutation });
function fail(reason) { const error = new Error('Owned filesystem unavailable'); error.code = reason; throw error; }
function fields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid');
  const keys = Reflect.ownKeys(input), result = Object.create(null);
  if (keys.length > required.length + optional.length || required.some(key => !keys.includes(key))) fail('invalid');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || ![...required, ...optional].includes(key) || !property?.enumerable || !('value' in property)) fail('invalid');
    result[key] = property.value;
  }
  return result;
}
function snapshotBytes(input) {
  let length; try { if (!(input instanceof Uint8Array)) fail('invalid'); length = intrinsicBytes.call(input); } catch { fail('invalid'); }
  if (length > OWNED_FILESYSTEM_LIMITS.fileBytes) fail('quota');
  const copy = new Uint8Array(length); try { nativeSet.call(copy, input); } catch { fail('invalid'); } return copy;
}
function reason(error) {
  if (['invalid', 'denied', 'quota', 'expired', 'cancelled', 'closed', 'conflict', 'unsafe-path', 'missing', 'unavailable'].includes(error?.code)) return error.code;
  if (error?.code === 'ENOENT') return 'missing'; return 'unavailable';
}

/** A cooperative Node host adapter, not an openat sandbox. This call explicitly
 * creates a new private disposable root; it never accepts an existing host path.
 * Same-user malicious path/root substitution and uninterruptible native IO are
 * outside this contract. Logical cancellation fences results, not issued syscalls.
 * onRoot/onNative are trusted fixture diagnostics, not device qualification. */
export async function createOwnedFilesystemAdapter(input) {
  const options = fields(input, ['scope', 'destinations', 'now', 'authorize'], ['deadlineMs', 'onRoot', 'onNative']);
  const scopeFields = fields(options.scope, ['principalId', 'applicationId', 'sessionId']);
  if (!Object.values(scopeFields).every(identity) || typeof options.now !== 'function' || typeof options.authorize !== 'function' ||
    options.onRoot !== undefined && typeof options.onRoot !== 'function' || options.onNative !== undefined && typeof options.onNative !== 'function') fail('invalid');
  const deadlineMs = options.deadlineMs ?? OWNED_FILESYSTEM_LIMITS.deadlineMs;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > OWNED_FILESYSTEM_LIMITS.deadlineMs ||
    !Array.isArray(options.destinations) || !options.destinations.length || options.destinations.length > OWNED_FILESYSTEM_LIMITS.destinations) fail('invalid');
  const destinations = new Map(), leaves = new Set();
  if (Reflect.ownKeys(options.destinations).some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail('invalid');
  for (let index = 0; index < options.destinations.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(options.destinations, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail('invalid'); const raw = descriptor.value;
    const item = fields(raw, ['id', 'leaf']);
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) || typeof item.leaf !== 'string' || item.leaf.length > 48 ||
      !/^[a-z][a-z0-9_-]{0,31}\.(?:txt|json)$/.test(item.leaf) || destinations.has(item.id) || leaves.has(item.leaf)) fail('invalid');
    destinations.set(item.id, Object.freeze({ ...item })); leaves.add(item.leaf);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), '101-owned-files-'))); await chmod(root, 0o700);
  const rootStat = await lstat(root), rootId = 'owned-files-' + randomUUID(), scope = Object.freeze({ ...scopeFields });
  const resources = Object.freeze([Object.freeze({ resourceId: 'list', action: 'list', destinationId: 'owned-root' }),
    ...[...destinations.values()].flatMap(item => ['read', 'write', 'delete'].map(action => Object.freeze({ resourceId: item.id + '-' + action, action, destinationId: item.id }))) ]);
  const selected = new Map(resources.map(item => [item.resourceId, item]));
  let closed = false, epoch = 1, attempts = 0, active, nativeReadBytes = 0, issuedMutations = 0, closePromise, previousAt = -1;
  const now = options.now, authorize = options.authorize, onNative = options.onNative;
  function clock() {
    let at; try { at = now(); } catch { fail('unavailable'); }
    if (!Number.isFinite(at) || at < 0 || at < previousAt || at > Number.MAX_SAFE_INTEGER - deadlineMs) { closed = true; epoch++; fail('unavailable'); }
    previousAt = at; return at;
  }
  function detach(record) { if (record.timer !== undefined) clearTimeout(record.timer); record.timer = undefined;
    for (const remove of record.listeners) remove(); record.listeners.length = 0; }
  function finish(record, result) { if (record.settled) return; record.settled = true; detach(record); record.resolve(result); }
  function cancel(record, cause) { record.abort.abort(); finish(record, no(cause, record.issuedMutation)); }
  function guard(record) {
    if (closed || record.epoch !== epoch) fail('closed'); if (record.abort.signal.aborted || record.context.signal.aborted) fail('cancelled');
    const at = clock(); if (closed || record.epoch !== epoch) fail('closed');
    let current = false; try { current = record.context.isCurrent() === true; } catch { /* Fixed rejection. */ }
    if (closed || record.epoch !== epoch) fail('closed'); if (!current || record.context.signal.aborted || record.abort.signal.aborted) fail('cancelled');
    if (record.grant) {
      let allowed = false; try { allowed = record.grant.isCurrent() === true; } catch { /* Fixed rejection. */ }
      const after = clock(); if (closed || record.epoch !== epoch) fail('closed');
      const contextCurrent = record.context.isCurrent() === true; const finalAt = clock();
      if (closed || record.epoch !== epoch) fail('closed');
      if (!allowed || !contextCurrent || record.grant.signal?.aborted || record.context.signal.aborted || record.abort.signal.aborted) fail('denied');
      if (Math.max(after, finalAt) >= record.grant.expiresAt) fail('expired');
    }
    if (at >= record.expiresAt || performance.now() >= record.wallExpiry) fail('expired');
  }
  async function native(record, operation, returned) { guard(record); if (++record.nativeCalls > OWNED_FILESYSTEM_LIMITS.nativeCalls) fail('quota');
    const value = await operation(); returned?.(value); guard(record); return value; }
  async function checkpoint(record, stage) { if (onNative) await onNative(Object.freeze({ stage, root })); guard(record); }
  async function rootCurrent(record) {
    const stat = await native(record, () => lstat(root));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev || stat.ino !== rootStat.ino || (stat.mode & 0o777) !== 0o700 ||
      await native(record, () => realpath(root)) !== root) fail('unsafe-path');
  }
  function fileCurrent(stat) { if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== rootStat.dev || (stat.mode & 0o777) !== 0o600) fail('unsafe-path');
    if (stat.size > OWNED_FILESYSTEM_LIMITS.fileBytes) fail('quota'); }
  async function readSelected(record, leaf) {
    await rootCurrent(record); const file = await native(record, () => open(join(root, leaf), constants.O_RDONLY | constants.O_NOFOLLOW), file => record.handles.add(file));
    const stat = await native(record, () => file.stat()); fileCurrent(stat); await checkpoint(record, 'read-stat');
    const buffer = Buffer.alloc(OWNED_FILESYSTEM_LIMITS.fileBytes + 1); record.scratch.add(buffer); let length = 0;
    for (let turn = 0; turn < 16; turn++) {
      const next = await native(record, () => file.read(buffer, length, buffer.length - length, length)); nativeReadBytes += next.bytesRead; length += next.bytesRead;
      if (length > OWNED_FILESYSTEM_LIMITS.fileBytes) fail('quota'); if (!next.bytesRead) break; if (turn === 15) fail('quota');
    }
    const after = await native(record, () => file.stat()); fileCurrent(after);
    const path = await native(record, () => lstat(join(root, leaf)));
    if (path.isSymbolicLink() || path.dev !== stat.dev || path.ino !== stat.ino || after.size !== length) fail('unsafe-path');
    const bytes = new Uint8Array(length); record.scratch.add(bytes); nativeSet.call(bytes, buffer.subarray(0, length)); buffer.fill(0); record.scratch.delete(buffer);
    await file.close(); record.handles.delete(file); guard(record); record.scratch.delete(bytes); return { bytes, sha256: hash(bytes), byteLength: length };
  }
  async function catalog(record) {
    await rootCurrent(record); const names = await native(record, () => readdir(root));
    if (names.length > destinations.size || names.some(name => !leaves.has(name))) fail('unsafe-path');
    const entries = []; let total = 0;
    for (const destination of destinations.values()) if (names.includes(destination.leaf)) {
      const stat = await native(record, () => lstat(join(root, destination.leaf))); fileCurrent(stat);
      total += stat.size; if (total > OWNED_FILESYSTEM_LIMITS.rootBytes) fail('quota');
      entries.push(Object.freeze({ destinationId: destination.id, byteLength: stat.size }));
    }
    return Object.freeze(entries);
  }
  async function inspect(record, destination) { try { return await readSelected(record, destination.leaf); } catch (error) { if (error.code === 'ENOENT' || error.code === 'missing') return; throw error; } }
  async function run(record, resource, rawArgs, rawContext) {
    const context = fields(rawContext, ['signal', 'routeId', 'generation', 'operationId', 'isCurrent'], ['partition', 'reportEvidence']);
    if (!(context.signal instanceof AbortSignal) || !identity(context.routeId) || !Number.isSafeInteger(context.generation) || context.generation < 0 ||
      !identity(context.operationId) || typeof context.isCurrent !== 'function') fail('invalid'); record.context = Object.freeze(context);
    const argumentsFields = fields(rawArgs, resource.action === 'write' ? ['bytes', 'expectedSha256'] : resource.action === 'delete' ? ['expectedSha256'] : []);
    const bytes = resource.action === 'write' ? snapshotBytes(argumentsFields.bytes) : undefined, expected = argumentsFields.expectedSha256;
    record.inputBytes = bytes;
    if (expected !== undefined && !(digest(expected) || resource.action === 'write' && expected === 'absent')) fail('invalid');
    const start = clock(); record.expiresAt = start + deadlineMs; record.wallExpiry = performance.now() + deadlineMs; guard(record);
    const destination = destinations.get(resource.destinationId), request = Object.freeze({ scope, rootId, resource,
      ...(destination ? { relativePath: destination.leaf } : {}), maxBytes: OWNED_FILESYSTEM_LIMITS.fileBytes, expiresAt: record.expiresAt,
      route: Object.freeze({ routeId: context.routeId, generation: context.generation, operationId: context.operationId }),
      ...(expected !== undefined ? { expectedSha256: expected } : {}), ...(bytes ? { input: Object.freeze({ sha256: hash(bytes), byteLength: bytes.byteLength }) } : {}) });
    const decision = authorize(request); guard(record); if (decision === undefined) fail('denied');
    const grant = fields(decision, ['request', 'expiresAt', 'isCurrent'], ['signal']);
    if (grant.request !== request || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= clock() ||
      grant.expiresAt > request.expiresAt || typeof grant.isCurrent !== 'function' || grant.signal !== undefined && !(grant.signal instanceof AbortSignal)) fail('denied');
    record.grant = Object.freeze(grant); record.expiresAt = Math.min(record.expiresAt, grant.expiresAt); guard(record);
    for (const signal of [context.signal, grant.signal].filter(Boolean)) { const callback = () => cancel(record, 'cancelled'); signal.addEventListener('abort', callback, { once: true }); record.listeners.push(() => signal.removeEventListener('abort', callback)); }
    guard(record); const remaining = Math.max(1, Math.min(deadlineMs, record.expiresAt - clock())); guard(record);
    const timer = setTimeout(() => cancel(record, 'expired'), remaining);
    if (closed || record.settled || record.epoch !== epoch) { clearTimeout(timer); fail('closed'); } record.timer = timer; guard(record);
    if (resource.action === 'list') return Object.freeze({ entries: await catalog(record) });
    if (resource.action === 'read') return Object.freeze(await readSelected(record, destination.leaf));
    await rootCurrent(record); const before = await inspect(record, destination);
    if (expected === 'absent' ? before !== undefined : before?.sha256 !== expected) { before?.bytes.fill(0); fail('conflict'); } before?.bytes.fill(0);
    if (resource.action === 'delete') {
      await native(record, () => { record.issuedMutation = true; issuedMutations++; return unlink(join(root, destination.leaf)); });
      await checkpoint(record, 'delete-issued'); return Object.freeze({ deleted: true });
    }
    const existing = await catalog(record);
    // Atomic replacement retains the old destination while the new file stages.
    // Reserve both sets of native bytes within the declared root ceiling.
    if (existing.reduce((total, entry) => total + entry.byteLength, 0) + bytes.byteLength > OWNED_FILESYSTEM_LIMITS.rootBytes) fail('quota');
    const temporary = '.101-stage-' + randomUUID(); record.temporary = temporary;
    const file = await native(record, () => open(join(root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), file => { record.handles.add(file); record.temporaryHandle = file; });
    const stageStat = await native(record, () => file.stat()); record.temporaryIdentity = { dev: stageStat.dev, ino: stageStat.ino };
    let offset = 0;
    for (let turn = 0; offset < bytes.byteLength; turn++) { if (turn >= 16) fail('quota');
      const written = await native(record, () => file.write(bytes, offset, bytes.byteLength - offset, offset)); if (!written.bytesWritten) fail('unavailable'); offset += written.bytesWritten; }
    await native(record, () => file.sync()); await file.close(); record.handles.delete(file); await checkpoint(record, 'write-staged');
    await rootCurrent(record); const current = await inspect(record, destination);
    if (expected === 'absent' ? current !== undefined : current?.sha256 !== expected) { current?.bytes.fill(0); fail('conflict'); } current?.bytes.fill(0);
    await native(record, () => { record.issuedMutation = true; issuedMutations++; return rename(join(root, temporary), join(root, destination.leaf)); }); record.temporary = undefined;
    await checkpoint(record, 'write-issued'); const verified = await readSelected(record, destination.leaf);
    if (verified.sha256 !== hash(bytes)) { verified.bytes.fill(0); fail('unavailable'); } verified.bytes.fill(0);
    return Object.freeze({ sha256: hash(bytes), byteLength: bytes.byteLength });
  }
  async function cleanupRecord(record) {
    record.inputBytes?.fill(0); for (const bytes of record.scratch) bytes.fill(0); record.scratch.clear();
    if (record.temporary && !record.temporaryIdentity && record.temporaryHandle) { try {
      const stat = await record.temporaryHandle.stat(); record.temporaryIdentity = { dev: stat.dev, ino: stat.ino };
    } catch { /* Preserve an unknown staging path. */ } }
    for (const file of record.handles) { try { await file.close(); } catch { /* Owned descriptor close attempted; never expose raw error. */ } } record.handles.clear();
    if (record.temporary && record.temporaryIdentity) { try {
      const stat = await lstat(join(root, record.temporary)); if (stat.dev === record.temporaryIdentity.dev && stat.ino === record.temporaryIdentity.ino) await unlink(join(root, record.temporary));
    } catch { /* Do not steal an unknown replacement path. */ } }
  }
  function execute(resourceId, args, context) {
    if (closed) return Promise.resolve(no('closed')); if (active) return Promise.resolve(no('busy'));
    const resource = selected.get(resourceId); if (!resource) return Promise.resolve(no('invalid'));
    if (attempts >= OWNED_FILESYSTEM_LIMITS.attempts) return Promise.resolve(no('quota')); attempts++;
    let resolveResult, resolveDone; const result = new Promise(resolve => { resolveResult = resolve; });
    const record = { epoch, abort: new AbortController(), settled: false, resolve: resolveResult, listeners: [], handles: new Set(), scratch: new Set(), nativeCalls: 0,
      issuedMutation: false, timer: undefined, expiresAt: Infinity, wallExpiry: Infinity, done: new Promise(resolve => { resolveDone = resolve; }) }; active = record;
    void Promise.resolve().then(() => run(record, resource, args, context)).then(value => { record.value = value; }, error => { record.failure = reason(error); }).finally(async () => {
      await cleanupRecord(record);
      if (!record.failure && !record.settled) { try { guard(record); } catch (error) { record.failure = reason(error); } }
      if (record.failure || record.settled) record.value?.bytes?.fill(0);
      const final = record.failure ? no(record.failure, record.issuedMutation) : Object.freeze({ ok: true, value: record.value, issuedMutation: record.issuedMutation });
      if (active === record) active = undefined; finish(record, final); resolveDone();
    }); return result;
  }
  function drain() { return active?.done ?? Promise.resolve(); }
  async function cleanupRoot() {
    try {
      const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev || stat.ino !== rootStat.ino || await realpath(root) !== root) return Object.freeze({ removed: false, reason: 'unsafe-path' });
      const names = await readdir(root); if (names.some(name => !leaves.has(name))) return Object.freeze({ removed: false, reason: 'unselected-entries' });
      for (const name of names) await unlink(join(root, name)); await rmdir(root); return Object.freeze({ removed: true });
    } catch { return Object.freeze({ removed: false, reason: 'unavailable' }); }
  }
  function close() { if (closePromise) return closePromise; closed = true; epoch++; if (active) cancel(active, 'closed'); closePromise = drain().then(cleanupRoot); return closePromise; }
  const adapter = Object.freeze({ rootId, resources, execute, drain, close,
    status: () => Object.freeze({ closed, attempts, rawPending: active ? 1 : 0, timerArmed: active?.timer !== undefined, nativeReadBytes, issuedMutations }) });
  try { options.onRoot?.(root); } catch { await close(); fail('unavailable'); } return adapter;
}
