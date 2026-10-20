import { SSH_HOST_LIMITS, SSH_FIXTURE_DOCUMENT_SHA256, ownedSshHostPort } from './disposable-host.mjs';

export const SCOPED_SSH_LIMITS = Object.freeze({ ...SSH_HOST_LIMITS, retainedResults: 1, auditRows: 64 });
const fail = reason => Object.freeze({ ok: false, reason });
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const nativeAddListener = EventTarget.prototype.addEventListener, nativeRemoveListener = EventTarget.prototype.removeEventListener;
function isSignal(value) { try { return typeof nativeAborted.call(value) === 'boolean'; } catch { return false; } }
function activeSignal(value) { try { return nativeAborted.call(value) === false; } catch { return false; } }
function own(value, name) { try { const field = Object.getOwnPropertyDescriptor(value, name); return field && 'value' in field ? field.value : undefined; } catch { return undefined; } }
function plain(value, allowed, required = allowed) {
  try { return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length <= allowed.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.writable !== undefined) &&
    required.every(key => Object.hasOwn(value, key)); } catch { return false; }
}
const id = value => typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
function context(input) {
  if (!plain(input, ['signal', 'routeId', 'generation', 'operationId', 'isCurrent', 'partition', 'reportEvidence'], ['signal', 'routeId', 'generation', 'operationId', 'isCurrent'])) return;
  const signal = own(input, 'signal'), routeId = own(input, 'routeId'), generation = own(input, 'generation'), operationId = own(input, 'operationId'), isCurrent = own(input, 'isCurrent');
  if (!isSignal(signal) || !id(routeId) || !Number.isSafeInteger(generation) || generation < 1 || !id(operationId) || typeof isCurrent !== 'function' || own(input, 'partition') !== undefined) return;
  return Object.freeze({ signal, routeId, generation, operationId, isCurrent });
}
function grant(input, request) {
  if (!plain(input, ['request', 'expiresAt', 'signal']) || own(input, 'request') !== request) return;
  const expiresAt = own(input, 'expiresAt'), signal = own(input, 'signal');
  if (!Number.isFinite(expiresAt) || expiresAt > request.expiresAt || !activeSignal(signal)) return;
  return Object.freeze({ expiresAt, signal });
}
function sourceClock(value, clockId) {
  return typeof value.clockId === 'string' && value.clockId.length <= 64 && value.clockId.startsWith(clockId + ':') &&
    /^[1-9][0-9]{0,9}:[0-9a-f]{12}$/.test(value.clockId.slice(clockId.length + 1)) &&
    Number.isFinite(value.sourceTime) && value.sourceTime >= 0 && value.sourceTime <= 60000;
}
function metadata(bytes, clockId) {
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { return; }
  if (!plain(value, ['profile', 'platform', 'arch', 'sourceTime', 'clockId']) || value.profile !== 'loopback-openssh-metadata/1' ||
    value.platform !== 'darwin' || value.arch !== 'arm64' || !sourceClock(value, clockId)) return;
  return Object.freeze(value);
}
function fixtureSummary(bytes, clockId) {
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { return; }
  if (!plain(value, ['profile', 'fixtureId', 'sha256', 'bytes', 'lines', 'sourceTime', 'clockId']) ||
    value.profile !== 'loopback-openssh-fixture-summary/1' || value.fixtureId !== 'reviewed-document' || value.sha256 !== SSH_FIXTURE_DOCUMENT_SHA256 ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > SSH_HOST_LIMITS.stdoutBytes ||
    !Number.isSafeInteger(value.lines) || value.lines < 1 || value.lines > value.bytes || !sourceClock(value, clockId)) return;
  return Object.freeze(value);
}
const metadataOperation = Object.freeze({ profile: 'loopback-openssh-metadata/1', operation: 'metadata', decode: metadata });
const summaryOperation = Object.freeze({ profile: 'loopback-openssh-fixture-summary/1', operation: 'fixture-summary', decode: fixtureSummary });

/** Current exact operation and separate sensitive-result approval. The selected
 * native operations are metadata and one fixed document-summary job. No credentials, executable state or
 * resource grants are stored; host callbacks are cooperative, not sandboxed.
 * Owner grants require a real AbortSignal; callback-only grants are rejected.
 * DeliveryContext.isCurrent observes the route. Mutable route revocation must
 * abort its signal, as the public runtime does; hidden cross-context booleans
 * cannot supply a final atomic authority boundary. */
export function createScopedLoopbackSshConnector(options) {
  if (!plain(options, ['host', 'credential', 'hostKey', 'scope', 'authorize', 'now', 'onNative'], ['host', 'credential', 'hostKey', 'scope', 'authorize'])) throw Error('Scoped SSH input');
  const scopeInput = own(options, 'scope');
  if (!plain(scopeInput, ['principalId', 'applicationId', 'sessionId'])) throw Error('Scoped SSH scope');
  const scope = Object.freeze(Object.fromEntries(['principalId', 'applicationId', 'sessionId'].map(key => [key, own(scopeInput, key)])));
  if (!Object.values(scope).every(id)) throw Error('Scoped SSH scope');
  const port = ownedSshHostPort(own(options, 'host'), own(options, 'credential')), hostKey = own(options, 'hostKey');
  const authorize = own(options, 'authorize'), now = own(options, 'now') ?? (() => performance.now()), onNative = own(options, 'onNative');
  if (typeof authorize !== 'function' || typeof now !== 'function' || onNative !== undefined && typeof onNative !== 'function' ||
    typeof hostKey !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}=?$/.test(hostKey)) throw Error('Scoped SSH input');
  let closed = false, lastTime = -1, attempts = 0, issued = 0, settled = 0, raw, selected, retained, sequence = 0;
  const handles = new WeakMap(), audit = [], pending = new Set();
  function record(work, reason) { audit.push(Object.freeze({ operationId: work.context.operationId, outcome: reason, issued: work.issued, profile: work.operation.profile, operation: work.operation.operation })); if (audit.length > SCOPED_SSH_LIMITS.auditRows) audit.shift(); }
  function removeAuthorityListeners(work) {
    nativeRemoveListener.call(work.context.signal, 'abort', work.aborted);
    if (work.grant && work.ownerAborted) nativeRemoveListener.call(work.grant.signal, 'abort', work.ownerAborted);
  }
  function erase() { if (retained) { removeAuthorityListeners(retained.work); retained.bytes.fill(0); clearTimeout(retained.timer); retained = undefined; } }
  function tick() {
    let value; try { value = now(); } catch { value = NaN; }
    if (!Number.isFinite(value) || value < 0 || value < lastTime) { closed = true; erase(); if (raw) cancel(raw, 'invalid-clock'); return NaN; }
    lastTime = value; return value;
  }
  function fence(work) { return !closed && selected === work && activeSignal(work.context.signal) && (!work.grant || activeSignal(work.grant.signal)) && port.isCurrent() && performance.now() < work.wallDeadline; }
  function current(work) {
    if (!fence(work)) return false;
    const at = tick(); if (!fence(work) || !Number.isFinite(at) || at >= work.deadline || work.grant && at >= work.grant.expiresAt) return false;
    let yes; try { yes = work.context.isCurrent() === true; } catch { return false; }
    if (!yes || !fence(work)) return false;
    const final = tick();
    // Native signal reads make no owner or context callouts after this clock.
    return fence(work) && Number.isFinite(final) && final < work.deadline && (!work.grant || final < work.grant.expiresAt);
  }
  function finish(work, result) {
    if (work.finished) return; work.finished = true; clearTimeout(work.timer); if (!result.ok) removeAuthorityListeners(work);
    record(work, result.ok ? 'returned-private-result' : result.reason); work.resolve(result);
  }
  function cancel(work, reason) {
    clearTimeout(work.timer); removeAuthorityListeners(work);
    if (selected === work) { selected = undefined; erase(); }
    if (work.child) { try { work.child.kill('SIGKILL'); } catch { /* Actual raw close owns reservation release. */ } }
    finish(work, fail(reason));
  }
  function notify(stage, work) {
    if (!onNative) return true;
    try { onNative(Object.freeze({ stage, operationId: work.context.operationId, issued: work.issued })); return true; } catch { cancel(work, 'callback-failed'); return false; }
  }
  function request(work, phase, nextContext = work.context) { return Object.freeze({ profile: work.operation.profile, scope,
    hostId: port.identity.id, hostKey, credentialId: port.credentialId, operation: work.operation.operation, phase,
    operationId: work.context.operationId, resourceId: work.operation.operation + (phase === 'operation' ? '-command' : '-result'),
    route: Object.freeze({ routeId: nextContext.routeId, generation: nextContext.generation }), expiresAt: Math.min(work.deadline, work.grant?.expiresAt ?? work.deadline) }); }
  function permission(work, phase, nextContext = work.context) {
    const selectedRequest = request(work, phase, nextContext);
    let value; try { value = authorize(selectedRequest); } catch { return; }
    if (!current(work)) return;
    return grant(value, selectedRequest);
  }
  function execute(input, operation) {
      const selectedContext = context(input);
      if (!selectedContext) return Promise.resolve(fail('invalid'));
      if (closed) return Promise.resolve(fail('closed'));
      if (raw) return Promise.resolve(fail('busy'));
      if (attempts >= SCOPED_SSH_LIMITS.attempts) return Promise.resolve(fail('quota'));
      attempts++;
      erase();
      let resolve; const promise = new Promise(value => { resolve = value; });
      const work = { context: selectedContext, operation, resolve, finished: false, issued: false, child: undefined, bytes: Buffer.alloc(0), stderrBytes: 0,
        timer: undefined, aborted: undefined, ownerAborted: undefined, grant: undefined, deadline: Infinity, wallDeadline: performance.now() + SCOPED_SSH_LIMITS.commandMs };
      // Reserve before clock, route or consent callbacks; replacements share
      // the host port's separate raw child reservation through actual close.
      raw = work; selected = work;
      const abort = () => cancel(work, 'cancelled'); work.aborted = abort;
      nativeAddListener.call(selectedContext.signal, 'abort', abort, { once: true });
      const at = tick(); work.deadline = at + SCOPED_SSH_LIMITS.commandMs;
      if (!current(work)) { cancel(work, 'revoked'); raw = undefined; return promise; }
      work.grant = permission(work, 'operation');
      if (!work.grant || !current(work)) { cancel(work, work.grant ? 'revoked' : 'denied'); raw = undefined; return promise; }
      work.ownerAborted = () => cancel(work, 'revoked');
      nativeAddListener.call(work.grant.signal, 'abort', work.ownerAborted, { once: true });
      const expiryAt = tick();
      if (!current(work)) { cancel(work, 'expired'); raw = undefined; return promise; }
      work.timer = setTimeout(() => cancel(work, 'expired'), Math.max(0, Math.min(work.grant.expiresAt - expiryAt, work.wallDeadline - performance.now())));
      let child; try { child = port.spawn(hostKey, operation.operation); } catch { cancel(work, 'native-unavailable'); raw = undefined; return promise; }
      work.child = child; work.issued = true; issued++;
      const nativeDone = new Promise(done => child.once('close', code => {
        settled++; raw = raw === work ? undefined : raw;
        pending.delete(nativeDone);
        if (work.finished) { work.bytes.fill(0); done(); return; }
        if (!notify('settled', work) || !current(work)) { cancel(work, 'revoked'); work.bytes.fill(0); done(); return; }
        const value = code === 0 && operation.decode(work.bytes, port.identity.clockId);
        if (!value) { cancel(work, 'native-failed'); work.bytes.fill(0); done(); return; }
        const handle = Object.freeze({ id: String(++sequence) });
        const retentionAt = tick();
        if (!current(work)) { cancel(work, 'expired'); work.bytes.fill(0); done(); return; }
        retained = { work, bytes: work.bytes, handle, timer: undefined }; handles.set(handle, retained);
        retained.timer = setTimeout(() => { if (retained?.handle === handle) { erase(); selected = selected === work ? undefined : selected; } },
          Math.max(0, Math.min(work.grant.expiresAt - retentionAt, work.wallDeadline - performance.now())));
        finish(work, Object.freeze({ ok: true, handle })); done();
      }));
      pending.add(nativeDone);
      child.stdout.on('data', chunk => {
        if (work.finished) return;
        if (!current(work)) { cancel(work, 'revoked'); return; }
        if (work.bytes.byteLength + chunk.byteLength > SCOPED_SSH_LIMITS.stdoutBytes) { cancel(work, 'output-quota'); return; }
        const next = Buffer.concat([work.bytes, chunk]); work.bytes.fill(0); work.bytes = next;
      });
      child.stderr.on('data', chunk => { work.stderrBytes += chunk.byteLength; if (work.stderrBytes > SCOPED_SSH_LIMITS.stderrBytes) cancel(work, 'output-quota'); });
      child.on('error', () => cancel(work, 'native-failed'));
      child.stdout.on('error', () => cancel(work, 'native-failed')); child.stderr.on('error', () => cancel(work, 'native-failed'));
      if (!notify('spawned', work) || !current(work)) cancel(work, 'revoked');
      return promise;
  }
  return Object.freeze({
    registrationId: port.identity.id,
    readMetadata: input => execute(input, metadataOperation),
    readFixtureSummary: input => execute(input, summaryOperation),
    readResult(handle, input) {
      const saved = handles.get(handle), nextContext = context(input);
      if (!saved || saved !== retained || !nextContext || !current(saved.work)) return fail('stale-result');
      let yes; try { yes = activeSignal(nextContext.signal) && nextContext.isCurrent() === true; } catch { yes = false; }
      if (!yes || !current(saved.work) || !activeSignal(nextContext.signal)) return fail('revoked');
      const allowed = permission(saved.work, 'result', nextContext);
      if (!allowed) return fail('denied');
      const value = saved.work.operation.decode(saved.bytes, port.identity.clockId);
      if (!value || !current(saved.work)) return fail('stale-result');
      try { yes = nextContext.isCurrent() === true; } catch { yes = false; }
      const finalAt = tick();
      if (!yes || saved !== retained || !fence(saved.work) || !activeSignal(nextContext.signal) || !activeSignal(allowed.signal) || !Number.isFinite(finalAt) || finalAt >= allowed.expiresAt ||
        finalAt >= saved.work.grant.expiresAt || finalAt >= saved.work.deadline) return fail('revoked');
      erase(); selected = undefined; return Object.freeze({ ok: true, value });
    },
    close() { closed = true; erase(); if (raw) cancel(raw, 'closed'); selected = undefined; return Promise.all(Array.from(pending)).then(() => {}); },
    drain: () => Promise.all(Array.from(pending)).then(() => {}),
    status: () => Object.freeze({ closed, attempts, issued, settled, rawPending: raw?.issued ? 1 : 0, pending: raw ? 1 : 0,
      retainedResults: retained ? 1 : 0, timerArmed: !!raw?.timer && !raw.finished || !!retained?.timer, audit: Object.freeze(audit.slice()) }),
  });
}
