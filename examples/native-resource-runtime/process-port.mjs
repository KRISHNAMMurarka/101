import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const NATIVE_RSS_PROFILE = 'fixed-own-rss-c/1';
const LIMITS = Object.freeze({ generations: 2, reads: 32, lineBytes: 256, outputBytes: 16384,
  registrationMs: 10000, readMs: 1000, stopMs: 500 });
const failure = (reason, issued = false) => Object.freeze({ ok: false, reason, ...(issued ? { issued: true, uncertain: true } : {}) });
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
function aborted(signal) { try { return Reflect.apply(abortedGetter, signal, []); } catch { return undefined; } }
function watch(signal, listener) { Reflect.apply(addListener, signal, ['abort', listener, { once: true }]);
  return () => Reflect.apply(removeListener, signal, ['abort', listener]); }
function fields(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) return;
  const value = Object.create(null);
  for (const key of keys) if (Object.hasOwn(descriptors, key)) {
    if (!('value' in descriptors[key])) return;
    value[key] = descriptors[key].value;
  }
  return value;
}
function pinnedExecutable(executable, sha256) {
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0 ||
      stat.size < 1 || stat.size > 2 * 1024 * 1024 || realpathSync(executable) !== executable)
      throw new Error('Invalid fixed native executable');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    for (let turn = 0; turn < 512; turn++) {
      const count = readSync(fd, bytes, length, bytes.length - length, length); length += count;
      if (length > stat.size) throw new Error('Native executable changed');
      if (count === 0) {
        if (length !== stat.size || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== sha256)
          throw new Error('Native executable pin mismatch');
        const after = fstatSync(fd);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Native executable changed');
        source = bytes.subarray(0, length); break;
      }
    }
    if (!source) throw new Error('Native executable read bound');
  } finally { closeSync(fd); }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-native-rss-launch-'))), path = join(directory, 'agent');
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700)
      throw new Error('Invalid private native directory');
    writeFileSync(path, source, { flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o500);
    const copy = lstatSync(path);
    if (!copy.isFile() || copy.nlink !== 1 || copy.uid !== process.getuid() ||
      (copy.mode & 0o777) !== 0o500 || copy.size !== source.length ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256)
      throw new Error('Invalid private native image');
    return { path, directory };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

/** Trusted same-user host bridge. A handle only selects an issued generation;
 * every start/read needs a fresh exact { request, expiresAt, signal } grant.
 * Revocation must abort that genuine signal; callback-only hidden currentness is
 * unsupported because two side-effecting callbacks cannot form one final gate.
 * No RSS sample grants a runtime route. No hostile same-process memory isolation. */
export function createNativeRssBridge(options) {
  const input = fields(options, ['executable', 'sha256', 'scope', 'authorizeRegistration', 'authorizeRead', 'onRetire', 'onProcess']);
  const scope = fields(input?.scope, ['ownerId', 'applicationId', 'sessionId']);
  if (process.platform !== 'darwin' || !input || !scope || Object.keys(scope).length !== 3 ||
    !Object.values(scope).every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) ||
    typeof input.executable !== 'string' || !isAbsolute(input.executable) ||
    typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256) ||
    typeof input.authorizeRegistration !== 'function' || typeof input.authorizeRead !== 'function' ||
    (input.onRetire !== undefined && typeof input.onRetire !== 'function') ||
    (input.onProcess !== undefined && typeof input.onProcess !== 'function')) throw new TypeError('Invalid fixed native RSS host');
  const executable = resolve(input.executable), issued = new WeakMap();
  let active, retiredDone, rawReservations = 0, nativePending = 0, starts = 0, closed = false, previousEpoch = 0;
  let pendingStart = false, cancellationRevision = 0, cleanupFailed = false;
  /* HELLO is sampled before its host receipt. Both clocks are monotonic on this
   * selected Mac; subtract 5 ms for rate/serialization uncertainty. A long
   * delayed child only makes this deadline earlier, never renews it. */
  function nativeDeadline(record, hostExpiry) {
    if (!record.helloNs || !Number.isFinite(hostExpiry)) return;
    const budget = Math.floor((hostExpiry - record.helloReceivedAt) * 1e6) - 5_000_000;
    if (budget <= 0 || budget > LIMITS.registrationMs * 1e6) return;
    return (record.helloNs + BigInt(budget)).toString();
  }
  function approved(value, request, maxMs) {
    const grant = fields(value, ['request', 'expiresAt', 'signal']);
    const now = performance.now();
    if (!grant || grant.request !== request || typeof grant.expiresAt !== 'number' ||
      !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + maxMs ||
      aborted(grant.signal) !== false) return;
    return grant;
  }
  function current(record) {
    if (closed || active !== record || record.retired || record.childClosed || aborted(record.registration.signal) !== false ||
      performance.now() >= record.registration.expiresAt) return false;
    return active === record && !record.retired && aborted(record.registration.signal) === false &&
      performance.now() < record.registration.expiresAt;
  }
  function settleRead(record, result) {
    if (!record.pending) return;
    const pending = record.pending; record.pending = undefined; nativePending--;
    clearTimeout(pending.timer); pending.detach();
    pending.resolve(result);
  }
  function retire(record) {
    if (record.retired) return record.done;
    record.retired = true;
    retiredDone = record.done;
    if (active === record) active = undefined;
    clearTimeout(record.expiryTimer);
    clearTimeout(record.startTimer);
    record.detachRegistration?.();
    try { input.onRetire?.(Object.freeze({ epoch: record.epoch })); } catch { /* Authority is already retired. */ }
    if (!record.childClosed) {
      try { record.child.stdin.end('STOP 1\n'); } catch { /* Owned kill below. */ }
      record.killTimer = setTimeout(() => { if (!record.childClosed) record.child.kill('SIGKILL'); }, LIMITS.stopMs);
    }
    return record.done;
  }
  function status() { return Object.freeze({ profile: NATIVE_RSS_PROFILE, starts, rawReservations, nativePending,
    childAlive: rawReservations > 0, cleanupVerified: !cleanupFailed && rawReservations === 0,
    phase: closed ? 'closed' : active ? active.handle ? 'ready' : 'starting' : rawReservations ? 'retiring' : 'idle' }); }
  async function start() {
    if (closed) return failure('closed');
    if (pendingStart || active || rawReservations) return failure('busy');
    if (starts >= LIMITS.generations) return failure('limit');
    pendingStart = true; const admission = cancellationRevision;
    let artifact, child, epoch, registration, token;
    try {
      epoch = randomBytes(6).readUIntBE(0, 6); if (!epoch || epoch === previousEpoch) epoch = previousEpoch + 1;
      const request = Object.freeze({ ...scope, profile: NATIVE_RSS_PROFILE, operation: 'register', epoch });
      try { registration = approved(input.authorizeRegistration(request), request, LIMITS.registrationMs); } catch { /* Denied. */ }
      if (!registration || closed || cancellationRevision !== admission || active || rawReservations) return failure('denied');
      try { artifact = pinnedExecutable(executable, input.sha256); } catch { return failure('unavailable'); }
      if (aborted(registration.signal) !== false || closed || cancellationRevision !== admission)
        return failure('denied');
      if (registration.expiresAt - performance.now() <= 5) return failure('denied');
      token = randomBytes(16).toString('hex');
      if (closed || cancellationRevision !== admission || aborted(registration.signal) !== false ||
        performance.now() >= registration.expiresAt) return failure('denied');
      child = spawn(artifact.path, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    } finally {
      pendingStart = false;
      if (!child && artifact) rmSync(artifact.directory, { recursive: true, force: true });
    }
    let resolveDone, resolveStart;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const ready = new Promise(resolve => { resolveStart = resolve; });
    const record = { epoch, token, child, artifact, registration, done, resolveDone, resolveStart, childClosed: false,
      retired: false, buffer: '', outputBytes: 0, sequence: 0, pending: undefined, expiryTimer: undefined, killTimer: undefined };
    starts++; previousEpoch = epoch; active = record; rawReservations++;
    record.revokeRegistration = () => { void retire(record); };
    record.detachRegistration = watch(registration.signal, record.revokeRegistration);
    record.expiryTimer = setTimeout(() => { void retire(record); }, Math.max(1, registration.expiresAt - performance.now()));
    record.startTimer = setTimeout(() => { void retire(record); }, 1500);
    function ingest(line) {
      const hello = /^HELLO 1 ([1-9][0-9]{0,19})$/.exec(line);
      if (hello && !record.helloNs && !record.handle) {
        record.helloNs = BigInt(hello[1]); record.helloReceivedAt = performance.now();
        if (!current(record)) { void retire(record); return; }
        const deadline = nativeDeadline(record, registration.expiresAt);
        if (!deadline || !current(record)) { void retire(record); return; }
        clearTimeout(record.startTimer);
        try { child.stdin.write(`START 1 ${epoch} ${deadline} ${token}\n`); }
        catch { void retire(record); }
        return;
      }
      if (line === `READY 1 ${epoch}` && !record.handle) {
        if (!record.helloNs || !current(record)) { void retire(record); return; }
        record.handle = Object.freeze({ kind: 'native-rss' }); issued.set(record.handle, record);
        resolveStart(Object.freeze({ ok: true, value: record.handle })); return;
      }
      if (line === 'DENIED 1') {
        if (!record.handle) { resolveStart(failure('denied')); void retire(record); }
        else settleRead(record, failure('denied', true));
        return;
      }
      if (line === 'STOPPED 1' && record.retired) return;
      const match = /^SAMPLE 1 ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(line);
      if (!match || !record.pending) { void retire(record); return; }
      const [, rawEpoch, rawSequence, capturedAtNs, rawRss] = match;
      const sequence = Number(rawSequence), rssBytes = Number(rawRss);
      if (rawEpoch !== String(epoch) || !Number.isSafeInteger(sequence) || sequence !== record.sequence + 1 || sequence > LIMITS.reads ||
        !/^[1-9][0-9]{0,19}$/.test(capturedAtNs) || !Number.isSafeInteger(rssBytes) || rssBytes < 1) { void retire(record); return; }
      record.sequence = sequence;
      const pending = record.pending;
      if (!current(record) || aborted(pending.signal) !== false ||
        performance.now() >= pending.grant.expiresAt) {
        settleRead(record, failure('stale', true)); void retire(record); return;
      }
      settleRead(record, Object.freeze({ ok: true, value: Object.freeze({ epoch, sequence, rssBytes,
        sourceTime: Object.freeze({ clockId: `native-c-monotonic:${epoch}`, atNs: capturedAtNs }),
        receiptClockId: 'node-performance', receivedAt: performance.now() }) }));
    }
    child.stdout.on('data', chunk => {
      if (record.childClosed) return;
      record.outputBytes += chunk.byteLength;
      if (record.outputBytes > LIMITS.outputBytes) { void retire(record); return; }
      record.buffer += String(chunk);
      for (let end; (end = record.buffer.indexOf('\n')) >= 0;) {
        const line = record.buffer.slice(0, end); record.buffer = record.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > LIMITS.lineBytes || line.includes('\r')) { void retire(record); return; }
        ingest(line);
      }
      if (Buffer.byteLength(record.buffer) > LIMITS.lineBytes) void retire(record);
    });
    child.stderr.on('data', () => { void retire(record); });
    child.stdin.on('error', () => { void retire(record); });
    child.on('error', () => { void retire(record); });
    child.once('close', () => {
      record.childClosed = true; clearTimeout(record.killTimer); clearTimeout(record.expiryTimer); clearTimeout(record.startTimer);
      if (!record.retired) retire(record);
      settleRead(record, failure('unavailable', true));
      resolveStart(failure('unavailable'));
      try { rmSync(record.artifact.directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
      rawReservations--; resolveDone();
    });
    try { input.onProcess?.(child); } catch { void retire(record); }
    if (!current(record)) void retire(record);
    return ready;
  }
  function read(handle) {
    const record = issued.get(handle);
    if (!record || record !== active || !current(record)) return Promise.resolve(failure('stale'));
    if (record.pending) return Promise.resolve(failure('busy'));
    if (record.sequence >= LIMITS.reads) return Promise.resolve(failure('limit'));
    const request = Object.freeze({ ...scope, profile: NATIVE_RSS_PROFILE, operation: 'read', epoch: record.epoch });
    let grant;
    try { grant = approved(input.authorizeRead(request), request, LIMITS.readMs); } catch { /* Denied. */ }
    if (!grant || !current(record)) return Promise.resolve(failure('denied'));
    const deadline = nativeDeadline(record, grant.expiresAt);
    if (!deadline) return Promise.resolve(failure('denied'));
    return new Promise(resolve => {
      const revoked = () => { void retire(record); };
      const timer = setTimeout(() => { void retire(record); }, Math.max(1, grant.expiresAt - performance.now()));
      record.pending = { resolve, grant, signal: grant.signal, revoked, timer }; nativePending++;
      record.pending.detach = watch(grant.signal, revoked);
      if (!current(record) || aborted(grant.signal) !== false ||
        performance.now() >= grant.expiresAt || active !== record || record.retired) {
        if (!record.retired) settleRead(record, failure('denied'));
        return;
      }
      try { record.child.stdin.write(`READ 1 ${record.epoch} ${deadline} ${record.token}\n`); }
      catch { void retire(record); }
    });
  }
  function stop() { cancellationRevision++; return active ? retire(active) : retiredDone ?? Promise.resolve(); }
  function close() { closed = true; return stop(); }
  return Object.freeze({ start, read, stop, close, status });
}
