import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PRIVATE_PASTEBOARD_LIMITS = Object.freeze({ bytes: 128, attempts: 64, nativeCommands: 32, nativePending: 1,
  frameBytes: 1024, inputBytes: 16384, outputBytes: 16384, deadlineMs: 2500, nativeLifetimeMs: 10000, exitGuardMs: 12000 });
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const aborted = signal => nativeAborted.call(signal);
const set = Uint8Array.prototype.set, hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const no = (reason, issuedEffect = false) => Object.freeze({ ok: false, reason, issuedEffect });
function failure(code) { const error = new Error('Private pasteboard unavailable'); error.code = code; throw error; }
function closedFields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) failure('invalid');
  const keys = Reflect.ownKeys(input), result = Object.create(null);
  if (keys.length > required.length + optional.length || required.some(key => !keys.includes(key))) failure('invalid');
  for (const key of keys) { const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || ![...required, ...optional].includes(key) || !field?.enumerable || !('value' in field)) failure('invalid'); result[key] = field.value; }
  return result;
}
function snapshotBytes(value) {
  let length; try { if (!(value instanceof Uint8Array)) failure('invalid'); length = byteLength.call(value); } catch { failure('invalid'); }
  if (length > PRIVATE_PASTEBOARD_LIMITS.bytes) failure('quota'); const bytes = new Uint8Array(length); set.call(bytes, value); return bytes;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixed(error) {
  let code; try { const field = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (field && 'value' in field) code = field.value; } catch { /* Never evaluate thrown-value accessors or expose a raw error. */ }
  return ['invalid', 'denied', 'expired', 'cancelled', 'closed', 'quota', 'conflict', 'unavailable'].includes(code) ? code : 'unavailable';
}
function pinnedExecutable(expected) {
  const path = fileURLToPath(new URL('./macos-pasteboard', import.meta.url));
  if (realpathSync(path) !== path || !digest(expected)) failure('unavailable');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size < 1 || stat.size > 4194304 ||
      (stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0) failure('unavailable');
    const buffer = Buffer.alloc(stat.size + 1); let length = 0;
    for (let turn = 0; turn < 256; turn++) {
      const count = readSync(file, buffer, length, buffer.length - length, length); length += count;
      if (length > stat.size) failure('unavailable'); if (!count) break; if (turn === 255) failure('unavailable');
    }
    const after = lstatSync(path);
    if (length !== stat.size || hash(buffer.subarray(0, length)) !== expected || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) failure('unavailable');
  } finally { closeSync(file); } return path;
}

/** Explicit host provisioning of one native-created private named pasteboard.
 * Import is inert; no general/user board, name or executable selector is input.
 * The fixed adjacent executable is compiled from reviewed AppKit source by the
 * trusted host, pinned before launch. This is not a malicious-host sandbox.
 * Owner grants require a real AbortSignal; callback-only owner currentness is
 * rejected. Delivery observers must propagate revocation through their signal.
 * Logical cancellation fences outputs, and cannot undo an issued native effect.
 * Forced native death reports cleanup-unverified; it never claims data deletion. */
export async function createMacosPrivatePasteboardAdapter(input) {
  if (process.platform !== 'darwin') return undefined;
  const options = closedFields(input, ['scope', 'now', 'authorize', 'executableSha256'], ['deadlineMs', 'onProcess', 'onNative']);
  const scope = Object.freeze({ ...closedFields(options.scope, ['principalId', 'applicationId', 'sessionId']) });
  const deadlineMs = options.deadlineMs ?? PRIVATE_PASTEBOARD_LIMITS.deadlineMs;
  if (!Object.values(scope).every(identity) || typeof options.now !== 'function' || typeof options.authorize !== 'function' ||
    !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PRIVATE_PASTEBOARD_LIMITS.deadlineMs ||
    options.onProcess !== undefined && typeof options.onProcess !== 'function' || options.onNative !== undefined && typeof options.onNative !== 'function') failure('invalid');
  const executable = pinnedExecutable(options.executableSha256), ready = deferred(), exited = deferred(); ready.promise.catch(() => {});
  let closed = false, ended = false, epoch = 1, previous = -1, active, attempts = 0, nativeCommands = 0, inputBytes = 0, outputBytes = 0,
    text = '', boardId, initialRevision, nativeCleanup, nativeExitCode, closePromise, readyTimer, lifetimeTimer;
  const decoder = new TextDecoder('utf8', { fatal: true });
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  function stopNative() { try { child.stdin.end(); } catch { /* Native exit guard owns this exact child. */ } }
  function detach(record) { if (record.timer !== undefined) clearTimeout(record.timer); record.timer = undefined;
    for (const remove of record.listeners) remove(); record.listeners.length = 0; }
  function finish(record, result) { if (record.settled) return; record.settled = true; detach(record); record.logical.resolve(result); }
  function cancel(record, reason) { record.abort.abort(); finish(record, no(reason, record.issuedEffect)); }
  function clock() { let at; try { at = options.now(); } catch { failure('unavailable'); }
    if (!Number.isFinite(at) || at < 0 || at < previous || at > Number.MAX_SAFE_INTEGER - deadlineMs) { closed = true; epoch++; stopNative(); failure('unavailable'); }
    previous = at; return at; }
  function guard(record) {
    if (closed || ended || record.epoch !== epoch) failure('closed'); if (record.abort.signal.aborted || aborted(record.context.signal)) failure('cancelled');
    const at = clock(); let current = false;
    try { current = record.context.isCurrent() === true; } catch { /* Fixed rejection. */ }
    if (closed || ended || record.epoch !== epoch) failure('closed'); if (!current || aborted(record.context.signal) || record.abort.signal.aborted) failure('cancelled');
    if (record.grant) {
      const after = clock(), finalCurrent = record.context.isCurrent() === true, finalAt = clock();
      // Mutable owner consent is a native abort signal. Its intrinsic state is
      // checked after all clock/route callbacks, without another owner callout.
      const finalContext = record.context.isCurrent() === true;
      if (closed || ended || record.epoch !== epoch) failure('closed');
      if (!finalCurrent || !finalContext || aborted(record.grant.signal) || aborted(record.context.signal) || record.abort.signal.aborted) failure('denied');
      if (Math.max(after, finalAt) >= record.grant.expiresAt) failure('expired');
    }
    if (at >= record.expiresAt || performance.now() >= record.wallExpiry) failure('expired');
  }
  function acceptFrame(raw) {
    if (raw?.kind === 'ready') {
      const value = closedFields(raw, ['version', 'kind', 'boardId', 'initialRevision']);
      if (boardId !== undefined || value.version !== 1 || !/^private-pasteboard-[a-f0-9-]{36}$/.test(value.boardId) ||
        !Number.isInteger(value.initialRevision) || value.initialRevision < 0 || value.initialRevision > 0x7fffffff) failure('unavailable');
      boardId = value.boardId; initialRevision = value.initialRevision; clearTimeout(readyTimer); ready.resolve(); return;
    }
    if (raw?.kind === 'closed') {
      const value = closedFields(raw, ['version', 'kind', 'cleared', 'released']);
      if (value.version !== 1 || nativeCleanup || typeof value.cleared !== 'boolean' || value.released !== true) failure('unavailable');
      nativeCleanup = Object.freeze({ cleared: value.cleared, released: true }); return;
    }
    if (!active?.response || active.responseReceived || raw?.version !== 1 || raw?.kind !== 'result' || raw.id !== active.nativeId || raw.action !== active.action) failure('unavailable');
    const required = raw.ok === false ? ['reason'] : raw.action === 'read' ? ['revision', 'hasValue', 'bytes', 'sha256'] :
      raw.action === 'write' ? ['revision', 'sha256', 'byteLength'] : ['revision', 'empty'];
    const value = closedFields(raw, ['version', 'kind', 'id', 'action', 'ok', ...required]);
    if (typeof value.ok !== 'boolean' || !value.ok && !['conflict', 'unavailable'].includes(value.reason)) failure('unavailable');
    if (value.ok) {
      if (!Number.isInteger(value.revision) || value.revision < 0 || value.revision > 0x7fffffff) failure('unavailable');
      if (value.action === 'read') {
        if (typeof value.hasValue !== 'boolean' || typeof value.bytes !== 'string' || value.bytes.length > 256 || value.bytes.length % 2 || !/^[a-f0-9]*$/.test(value.bytes) ||
          (value.hasValue ? !digest(value.sha256) : value.bytes !== '' || value.sha256 !== 'absent')) failure('unavailable');
      } else if (value.action === 'write') {
        if (!digest(value.sha256) || !Number.isInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > 128) failure('unavailable');
      } else if (value.empty !== true) failure('unavailable');
    }
    active.responseReceived = true; active.response.resolve(value);
  }
  function receive(chunk) {
    try { outputBytes += chunk.byteLength; if (outputBytes > PRIVATE_PASTEBOARD_LIMITS.outputBytes) failure('quota'); text += decoder.decode(chunk, { stream: true });
      for (let newline; (newline = text.indexOf('\n')) >= 0;) { const line = text.slice(0, newline); text = text.slice(newline + 1);
        if (!line || Buffer.byteLength(line) >= PRIVATE_PASTEBOARD_LIMITS.frameBytes) failure('quota'); acceptFrame(JSON.parse(line)); }
      if (Buffer.byteLength(text) >= PRIVATE_PASTEBOARD_LIMITS.frameBytes) failure('quota');
    } catch { closed = true; epoch++; ready.reject(new Error('Private pasteboard unavailable')); if (active) cancel(active, 'unavailable'); stopNative(); }
  }
  const unavailable = () => { closed = true; epoch++; ready.reject(new Error('Private pasteboard unavailable')); if (active) cancel(active, 'unavailable'); stopNative(); };
  child.stdout.on('data', receive); child.stderr.on('data', unavailable); child.on('error', unavailable); child.stdin.on('error', unavailable);
  child.once('close', code => {
    ended = true; closed = true; epoch++; nativeExitCode = code; clearTimeout(readyTimer); clearTimeout(lifetimeTimer);
    child.stdout.off('data', receive); child.stderr.off('data', unavailable); child.stdin.off('error', unavailable);
    ready.reject(new Error('Private pasteboard unavailable')); active?.response?.reject(new Error('Private pasteboard unavailable'));
    if (active) cancel(active, 'unavailable'); exited.resolve();
  });
  readyTimer = setTimeout(() => { ready.reject(new Error('Private pasteboard unavailable')); stopNative(); }, 2500);
  lifetimeTimer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, PRIVATE_PASTEBOARD_LIMITS.exitGuardMs);
  try { options.onProcess?.(child); await ready.promise; } catch { stopNative(); await exited.promise; failure('unavailable'); }
  async function run(record, rawArgs, rawContext) {
    const context = closedFields(rawContext, ['signal', 'routeId', 'generation', 'operationId', 'isCurrent'], ['partition', 'reportEvidence']);
    if (!(context.signal instanceof AbortSignal) || !identity(context.routeId) || !Number.isSafeInteger(context.generation) || context.generation < 0 ||
      !identity(context.operationId) || typeof context.isCurrent !== 'function') failure('invalid'); record.context = Object.freeze(context);
    const args = closedFields(rawArgs, record.action === 'write' ? ['bytes', 'expectedRevision', 'expectedSha256'] : record.action === 'clear' ? ['expectedRevision', 'expectedSha256'] : []);
    if (record.action !== 'read' && (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 0 || args.expectedRevision > 0x7fffffff ||
      !(args.expectedSha256 === 'absent' || digest(args.expectedSha256)))) failure('invalid');
    if (record.action === 'write') record.bytes = snapshotBytes(args.bytes);
    const start = clock(); record.expiresAt = start + deadlineMs; record.wallExpiry = performance.now() + deadlineMs; guard(record);
    const request = Object.freeze({ scope, boardId, resource: record.action, maxBytes: 128, expiresAt: record.expiresAt,
      route: Object.freeze({ routeId: context.routeId, generation: context.generation, operationId: context.operationId }),
      ...(record.action !== 'read' ? { expectedRevision: args.expectedRevision, expectedSha256: args.expectedSha256 } : {}),
      ...(record.bytes ? { input: Object.freeze({ sha256: hash(record.bytes), byteLength: record.bytes.byteLength }) } : {}) });
    const decision = options.authorize(request); guard(record); if (decision === undefined) failure('denied');
    let grant;
    try { grant = closedFields(decision, ['request', 'expiresAt', 'signal']);
      if (!(grant.signal instanceof AbortSignal) || aborted(grant.signal)) failure('denied');
    } catch { failure('denied'); }
    if (grant.request !== request || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= clock() || grant.expiresAt > request.expiresAt) failure('denied');
    record.grant = Object.freeze(grant);
    record.expiresAt = Math.min(record.expiresAt, grant.expiresAt); guard(record);
    for (const signal of [context.signal, grant.signal].filter(Boolean)) { const callback = () => cancel(record, 'cancelled');
      signal.addEventListener('abort', callback, { once: true }); record.listeners.push(() => signal.removeEventListener('abort', callback)); }
    guard(record); const remaining = Math.max(1, Math.min(deadlineMs, record.expiresAt - clock())); guard(record);
    const timer = setTimeout(() => cancel(record, 'expired'), remaining);
    if (closed || record.settled || record.epoch !== epoch) { clearTimeout(timer); failure('closed'); } record.timer = timer; guard(record);
    if (nativeCommands >= PRIVATE_PASTEBOARD_LIMITS.nativeCommands) failure('quota'); record.nativeId = nativeCommands + 1;
    const line = String(record.nativeId) + '\t' + record.action.toUpperCase() + (record.action === 'read' ? '' : '\t' + args.expectedRevision + '\t' + args.expectedSha256 +
      (record.action === 'write' ? '\t' + Buffer.from(record.bytes).toString('hex') : '')) + '\n';
    const length = Buffer.byteLength(line); if (length >= PRIVATE_PASTEBOARD_LIMITS.frameBytes || inputBytes + length > PRIVATE_PASTEBOARD_LIMITS.inputBytes) failure('quota');
    record.response = deferred(); record.response.promise.catch(() => {}); guard(record);
    const write = new Promise(resolve => { record.issuedEffect = record.action !== 'read'; nativeCommands++; inputBytes += length;
      child.stdin.write(line, error => { record.writeSettled = true; if (error) stopNative(); resolve(!error); }); });
    const returned = await Promise.allSettled([write, record.response.promise]);
    if (returned[0].status !== 'fulfilled' || !returned[0].value || returned[1].status !== 'fulfilled') failure('unavailable');
    const value = returned[1].value; guard(record);
    const diagnostic = options.onNative?.(Object.freeze({ stage: 'native-result', action: record.action, issuedEffect: record.issuedEffect }));
    if (diagnostic && typeof diagnostic.then === 'function') failure('invalid'); guard(record);
    if (!value.ok) failure(value.reason);
    if (record.action === 'read') {
      const bytes = new Uint8Array(Buffer.from(value.bytes, 'hex')); record.resultBytes = bytes;
      if (value.hasValue && hash(bytes) !== value.sha256) failure('unavailable'); guard(record);
      return Object.freeze({ bytes, byteLength: bytes.byteLength, sha256: value.sha256, revision: value.revision, hasValue: value.hasValue });
    }
    return record.action === 'write' ? Object.freeze({ revision: value.revision, sha256: value.sha256, byteLength: value.byteLength }) : Object.freeze({ revision: value.revision, empty: true });
  }
  function execute(action, args, context) {
    if (closed || ended) return Promise.resolve(no('closed')); if (active) return Promise.resolve(no('busy'));
    if (!['read', 'write', 'clear'].includes(action)) return Promise.resolve(no('invalid')); if (attempts >= 64) return Promise.resolve(no('quota')); attempts++;
    const record = { action, epoch, logical: deferred(), done: deferred(), abort: new AbortController(), listeners: [],
      settled: false, issuedEffect: false, writeSettled: false, responseReceived: false, timer: undefined, expiresAt: Infinity, wallExpiry: Infinity }; active = record;
    void Promise.resolve().then(() => run(record, args, context)).then(value => { record.value = value; }, error => { record.failure = fixed(error); }).finally(() => {
      record.bytes?.fill(0); if (!record.failure && !record.settled) { try { guard(record); } catch (error) { record.failure = fixed(error); } }
      if (record.failure || record.settled) record.resultBytes?.fill(0);
      if (active === record) active = undefined; finish(record, record.failure ? no(record.failure, record.issuedEffect) : Object.freeze({ ok: true, value: record.value, issuedEffect: record.issuedEffect })); record.done.resolve();
    }); return record.logical.promise;
  }
  function drain() { return active?.done.promise ?? Promise.resolve(); }
  function close() { if (closePromise) return closePromise; closed = true; epoch++; if (active) cancel(active, 'closed');
    closePromise = drain().then(async () => { stopNative(); await exited.promise;
      return nativeCleanup?.cleared === true && nativeCleanup.released === true && nativeExitCode !== null ?
        Object.freeze({ closed: true, cleared: true, released: true }) : Object.freeze({ closed: true, cleared: false, released: false, reason: 'cleanup-unverified' }); }); return closePromise; }
  return Object.freeze({ boardId, initialRevision, execute, drain, close, status: () => Object.freeze({ closed, attempts, nativeCommands, rawPending: active ? 1 : 0,
    timerArmed: active?.timer !== undefined, nativeAlive: !ended, nativeExitGuardArmed: !ended, stdinCallbackPending: active?.response !== undefined && !active.writeSettled, inputBytes, outputBytes }) });
}
