import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createNec32IrEmitterGateway } from '../../packages/hub-server/src/nec32-ir-emitter-gateway.ts';

export function softwareProvider(options) {
  const receiver = false;
  const producer = realpathSync(fileURLToPath(new URL(receiver ? './software-receiver.mjs' : './software-emitter.mjs', import.meta.url)));
  const observer = realpathSync(fileURLToPath(new URL('../../tools/qa-ir-provider-runtime-observer.mjs', import.meta.url)));
  const executable = realpathSync(process.execPath);
  const cwd = realpathSync(fileURLToPath(new URL('.', pathToFileURL(producer))));
  const startupEnvironment = Object.freeze(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16).toUpperCase()}:0:0` } : {});
  const frozenCopy = value => { const copy = JSON.parse(JSON.stringify(value)); const freeze = item => { if (item && typeof item === 'object') { for (const part of Object.values(item)) freeze(part); Object.freeze(item); } return item; }; return freeze(copy); };
  const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const own = (value, keys) => {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid software provider options');
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid software provider options');
      result[key] = descriptor.value;
    }
    if (!keys.every(key => Object.hasOwn(result, key))) throw new TypeError('Invalid software provider options');
    return result;
  };
  const actualPins = () => ({ executablePath: executable, executableSha256: fileHash(executable), producerSha256: fileHash(producer), observerPath: observer, observerSha256: fileHash(observer) });
  const observedPins = actualPins();
  const supplied = options === undefined ? observedPins : own(own(options, ['runtimePins']).runtimePins, Object.keys(observedPins));
  if (supplied.executablePath !== executable || supplied.observerPath !== observer ||
    !['executableSha256', 'producerSha256', 'observerSha256'].every(key => typeof supplied[key] === 'string' && /^[a-f0-9]{64}$/.test(supplied[key]))) throw new TypeError('Invalid software runtime pins');
  assert.deepEqual({ ...supplied }, observedPins, 'Software runtime pins changed');
  const pins = Object.freeze({ ...supplied });
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; };
  const empty = Promise.resolve(); const messages = [], commandTypes = []; let current, sequence = 0, spawnCount = 0;
  const removeAbortListener = EventTarget.prototype.removeEventListener;
  const aborted = signal => Reflect.apply(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get, signal, []);
  const schedule = (epoch, callback, delay) => {
    const record = { active: true, id: undefined, cancel() { if (!record.active) return; record.active = false; clearTimeout(record.id); epoch.timers.delete(record); } };
    epoch.timers.add(record); record.id = setTimeout(() => { if (!record.active) return; record.cancel(); callback(); }, Math.max(0, Math.ceil(delay))); return record;
  };
  const failure = (epoch, error) => { const value = error instanceof Error ? error : new Error('Software provider failure'); epoch.failures.push(value); return value; };
  const rejectWaiters = (epoch, error, includeCleanup = false) => {
    for (const waiter of [...epoch.waiters]) if (includeCleanup || !waiter.cleanup) { epoch.waiters.delete(waiter); waiter.timer.cancel(); waiter.task.reject(error); }
  };
  const waitFor = (epoch, channel, match, delay, cleanup = false) => {
    const task = deferred(); const waiter = { task, match, channel, cleanup, timer: undefined };
    epoch.waiters.add(waiter); waiter.timer = schedule(epoch, () => {
      epoch.waiters.delete(waiter); const error = new Error('Software provider deadline'); waiter.task.reject(error);
      fail(epoch, error); checkJoined(epoch);
    }, delay);
    return task.promise;
  };
  const deliver = (epoch, channel, value) => {
    for (const waiter of [...epoch.waiters]) if (waiter.channel === channel && waiter.match(value)) {
      epoch.waiters.delete(waiter); waiter.timer.cancel(); waiter.task.resolve(value); break;
    }
  };
  const listen = (epoch, target, event, callback) => {
    epoch.registrations++;
    const wrapped = (...args) => { epoch.callbacks++; try { callback(...args); } catch (error) { fail(epoch, error); } finally { epoch.callbacks--; checkJoined(epoch); } };
    epoch.listeners.push({ target, event, wrapped });
    try { target.on(event, wrapped); } finally { epoch.registrations--; }
  };
  const request = (value, operation) => {
    const context = own(value, operation ? ['generation', 'purpose', 'deadline', 'signal', 'operationId'] : ['generation', 'purpose', 'deadline', 'signal']);
    if (!Number.isSafeInteger(context.generation) || context.generation < 1 || typeof context.purpose !== 'string' || !context.purpose ||
      !Number.isFinite(context.deadline) || context.deadline <= performance.now() || aborted(context.signal) ||
      (operation && (typeof context.operationId !== 'string' || !context.operationId))) throw new TypeError('Invalid software request');
    return context;
  };
  const activity = (epoch, context) => {
    epoch.operations++;
    const abort = () => fail(epoch, new Error('Software request cancelled'));
    let timer, listening = false, finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        timer?.cancel();
        if (listening) context.signal.removeEventListener('abort', abort);
      } catch (error) { fail(epoch, error); throw error; }
      finally {
        // An own removal override may throw before removing the native listener.
        try { if (listening) Reflect.apply(removeAbortListener, context.signal, ['abort', abort]); }
        catch (error) { fail(epoch, error); }
        finally { epoch.operations--; checkJoined(epoch); }
      }
    };
    try {
      timer = schedule(epoch, abort, context.deadline - performance.now());
      epoch.registrations++;
      try { listening = true; context.signal.addEventListener('abort', abort, { once: true }); }
      finally { epoch.registrations--; }
      return finish;
    } catch (error) {
      try { finish(); } catch { /* finish retained the cleanup failure. */ }
      throw error;
    }
  };
  const isCurrent = (epoch, context) => !epoch.fenced && current === epoch && !aborted(context.signal) && performance.now() < context.deadline;
  function fail(epoch, error) { failure(epoch, error); beginClose(epoch); }
  function beginClose(epoch) {
    if (!epoch.fenced) { epoch.fenced = true; epoch.stoppingSession = epoch.session; epoch.session = undefined; rejectWaiters(epoch, new Error('Software provider stopped')); }
    if (epoch.closeStarted || epoch.settled) return epoch.raw.promise;
    epoch.closeStarted = true; epoch.phase = 'closing'; epoch.driverActive = true;
    epoch.escalation = schedule(epoch, () => {
      failure(epoch, new Error('Software cleanup observation deadline'));
      if (epoch.child && !epoch.childClosed && !epoch.killRequested) {
        epoch.killRequested = true; try { epoch.child.kill('SIGKILL'); } catch (error) { failure(epoch, error); }
      }
      checkJoined(epoch);
    }, 1000);
    void Promise.resolve().then(async () => {
      await epoch.adopted.promise;
      if ((epoch.noProcess && !epoch.child) || (epoch.spawnError && !epoch.spawnSeen && epoch.child?.pid === undefined)) return;
      const session = epoch.stoppingSession;
      if (session && !epoch.terminal && epoch.stdin?.writable) {
        try {
          const stopped = waitFor(epoch, 'protocol', value => value.type === 'stopped' && value.generation === session.generation && value.token === session.token, 500, true);
          await Promise.all([stopped, write(epoch, { type: 'stop', ...session }, true)]);
        } catch (error) { failure(epoch, error); }
      }
      if (!epoch.terminal && epoch.stdin?.writable) {
        try {
          const closed = waitFor(epoch, 'protocol', value => value.type === 'closed', 500, true);
          await Promise.all([closed, write(epoch, { type: 'close' }, true)]);
        } catch (error) { failure(epoch, error); }
      }
      try { if (epoch.stdin && !epoch.stdin.destroyed) epoch.stdin.end(); } catch (error) { failure(epoch, error); }
    }).catch(error => failure(epoch, error)).finally(() => { epoch.driverActive = false; checkJoined(epoch); });
    return epoch.raw.promise;
  }
  function write(epoch, message, cleanup = false) {
    const task = deferred(); const record = { task, callbackObserved: false, callIssued: false, type: message.type };
    epoch.writes.add(record);
    try {
      const payload = `${JSON.stringify(message)}\n`;
      if ((!cleanup && epoch.fenced) || !epoch.stdin?.writable) throw new Error('Software provider unavailable');
      Array.prototype.push.call(commandTypes, message.type); record.callIssued = true;
      epoch.stdin.write(payload, error => {
        if (record.callbackObserved) { fail(epoch, new Error('Duplicate software write callback')); return; }
        record.callbackObserved = true; epoch.writes.delete(record);
        if (error) { fail(epoch, error); task.reject(error); } else task.resolve();
        checkJoined(epoch);
      });
    } catch (error) {
      if (!record.callIssued) epoch.writes.delete(record);
      // A throwing issued write remains owned until its actual callback arrives.
      fail(epoch, error); task.reject(error); checkJoined(epoch);
    }
    return task.promise;
  }
  function validateProof(epoch, value) {
    const keys = ['schemaVersion', 'phase', 'nonce', 'epoch', 'pid', 'ppid', 'nodeVersion', 'platform', 'architecture', 'execPath', 'executable', 'executableSha256', 'argv', 'execArgv', 'cwd', 'environment', 'producer', 'producerSha256', 'observer', 'observerSha256', 'clockDomain', 'exitCode'];
    const record = own(value, keys);
    if (record.schemaVersion !== 1 || !['before', 'after'].includes(record.phase) || record.nonce !== epoch.nonce || record.epoch !== epoch.id ||
      record.pid !== epoch.child.pid || record.ppid !== process.pid || record.nodeVersion !== process.version || record.platform !== process.platform || record.architecture !== process.arch ||
      record.execPath !== executable || record.executable !== executable || record.executableSha256 !== pins.executableSha256 ||
      record.producer !== producer || record.producerSha256 !== pins.producerSha256 || record.observer !== observer || record.observerSha256 !== pins.observerSha256 ||
      !record.clockDomain || !Number.isFinite(own(record.clockDomain, ['timeOrigin']).timeOrigin)) throw new Error('Invalid software runtime origin');
    assert.deepEqual(record.argv, [executable, producer]); assert.deepEqual(record.execArgv, ['--import', pathToFileURL(observer).href]);
    assert.deepEqual(record.environment, epoch.environment); assert.equal(record.cwd, cwd);
    if (record.phase === 'before') { if (epoch.before || record.exitCode !== null) throw new Error('Duplicate software origin'); epoch.before = frozenCopy(value); }
    else {
      if (!epoch.before || epoch.after || !Number.isInteger(record.exitCode)) throw new Error('Invalid terminal software origin');
      const normalize = item => { const { phase: ignoredPhase, exitCode: ignoredCode, ...rest } = item; void ignoredPhase; void ignoredCode; return rest; };
      assert.deepEqual(normalize(record), normalize(epoch.before)); epoch.after = frozenCopy(value);
    }
    deliver(epoch, 'proof', value);
  }
  function adopt(epoch, child) {
    // Retain the exact returned handle even if spawn or listener registration fenced admission.
    epoch.child = child; epoch.spawning = false; epoch.registrations++;
    try {
      listen(epoch, child, 'spawn', () => { epoch.spawnSeen = true; });
      listen(epoch, child, 'error', error => { epoch.spawnError = error; fail(epoch, error); rejectWaiters(epoch, error, true); });
      listen(epoch, child, 'exit', (code, signal) => {
        epoch.terminal = { code, signal }; if (code !== 0) failure(epoch, new Error('Software process failed'));
        beginClose(epoch);
        // A successful terminal event can precede delivery of buffered closed stdout.
        rejectWaiters(epoch, new Error('Software process exited'), epoch.streams.some(stream => stream.index === 1 && stream.ended));
      });
      listen(epoch, child, 'close', (code, signal) => { epoch.childClosed = true; epoch.childClose = { code, signal }; });
      const streams = [child.stdin, child.stdout, child.stderr, child.stdio[3]];
      epoch.stdin = streams[0];
      for (const [index, stream] of streams.entries()) {
        const state = { index, stream, created: Boolean(stream), closed: !stream, ended: index === 0 || !stream, buffer: Buffer.alloc(0), bytes: 0 };
        epoch.streams.push(state);
        if (!stream) continue;
        listen(epoch, stream, 'error', error => fail(epoch, error));
        listen(epoch, stream, 'close', () => { state.closed = true; });
        if (index > 0) listen(epoch, stream, 'end', () => {
          state.ended = true;
          if (index === 1 && epoch.terminal) rejectWaiters(epoch, new Error('Software process output ended'), true);
        });
        if (index > 0) listen(epoch, stream, 'data', chunk => {
          state.bytes += chunk.length; if (state.bytes > 16384) throw new Error('Software output too large');
          if (index === 2) return;
          state.buffer = Buffer.concat([state.buffer, chunk]); let newline;
          while ((newline = state.buffer.indexOf(10)) >= 0) {
            const raw = state.buffer.subarray(0, newline); state.buffer = state.buffer.subarray(newline + 1);
            if (raw.length > 8192) throw new Error('Software line too large');
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            if (index === 3) validateProof(epoch, value);
            else { Array.prototype.push.call(messages, Object.freeze(value)); if (value.type === 'closed') epoch.protocolClosed = true; deliver(epoch, 'protocol', value); }
          }
          if (state.buffer.length > 8192) throw new Error('Software line too large');
        });
      }
    } catch (error) { fail(epoch, error); }
    finally { epoch.registrations--; epoch.adopted.resolve(); checkJoined(epoch); }
  }
  function checkJoined(epoch) {
    if (epoch.settled || epoch.joining || epoch.spawning || (!epoch.child && !epoch.noProcess) || epoch.registrations || epoch.callbacks || epoch.operations || epoch.driverActive || epoch.waiters.size || epoch.writes.size || (epoch.child && !epoch.childClosed) || epoch.streams.some(stream => !stream.closed)) return;
    const noProcess = epoch.noProcess || (!epoch.spawnSeen && epoch.child?.pid === undefined && ['ENOENT', 'EACCES'].includes(epoch.spawnError?.code));
    if (!noProcess && !epoch.terminal) return;
    epoch.joining = true;
    for (const timer of [...epoch.timers]) timer.cancel();
    if (!noProcess) {
      if (!epoch.before || !epoch.after || epoch.after.exitCode !== epoch.terminal.code || !epoch.protocolClosed) failure(epoch, new Error('Software closure proof incomplete'));
      for (const stream of epoch.streams) if (stream.index > 0 && (!stream.ended || stream.buffer.length)) failure(epoch, new Error('Software stream drain incomplete'));
    }
    try { assert.deepEqual(actualPins(), pins, 'Software runtime changed after execution'); } catch (error) { failure(epoch, error); }
    for (const item of epoch.listeners) {
      epoch.registrations++; try { item.target.off(item.event, item.wrapped); } catch (error) { failure(epoch, error); } finally { epoch.registrations--; }
    }
    epoch.listeners.length = 0; epoch.noProcess = noProcess; epoch.settled = true; epoch.phase = 'settled'; epoch.child = undefined;
    if (epoch.failures.length) epoch.raw.reject(new AggregateError(epoch.failures, 'Software provider failed after raw settlement')); else epoch.raw.resolve();
  }
  const provider = {
    supported: true,
    ...(receiver ? { mode: 'LIRC_MODE_MODE2', resolutionMicros: 1 } : { carrierRanges: Object.freeze([{ minHz: 38000, maxHz: 38000 }]) }),
    async open(value) {
      const context = request(value, false);
      if (current && !current.settled) throw new Error('Software provider busy');
      const epoch = { id: ++sequence, phase: 'opening', raw: deferred(), adopted: deferred(), child: undefined, spawning: true, spawnIssued: false, fenced: false, closeStarted: false,
        settled: false, joining: false, driverActive: false, registrations: 0, callbacks: 0, operations: 0, writes: new Set(), waiters: new Set(), timers: new Set(), listeners: [], streams: [], failures: [] };
      current = epoch; let finish;
      try {
        finish = activity(epoch, context);
        if (!isCurrent(epoch, context)) throw new Error('Software open retired');
        assert.deepEqual(actualPins(), pins, 'Software runtime changed before execution');
        if (!isCurrent(epoch, context)) throw new Error('Software open retired');
        epoch.nonce = randomBytes(16).toString('hex');
        epoch.environment = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC', ...startupEnvironment, IR_OBSERVER_NONCE: epoch.nonce, IR_OBSERVER_EPOCH: String(epoch.id),
          IR_OBSERVER_EXECUTABLE: executable, IR_OBSERVER_EXECUTABLE_SHA256: pins.executableSha256, IR_OBSERVER_PRODUCER: producer,
          IR_OBSERVER_PRODUCER_SHA256: pins.producerSha256, IR_OBSERVER_OBSERVER: observer, IR_OBSERVER_OBSERVER_SHA256: pins.observerSha256 });
        const hello = waitFor(epoch, 'protocol', item => item.type === 'hello', 1500);
        const before = waitFor(epoch, 'proof', item => item.phase === 'before', 1500);
        if (!isCurrent(epoch, context)) throw new Error('Software open retired');
        spawnCount++; epoch.spawnIssued = true;
        let child;
        try { child = spawn(executable, ['--import', pathToFileURL(observer).href, producer], {
          env: epoch.environment, cwd, shell: false, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        }); } catch (error) { epoch.spawnUnconfirmed = true; fail(epoch, error); throw error; }
        adopt(epoch, child);
        const [greeting] = await Promise.all([hello, before]);
        assert.deepEqual(greeting, receiver ? { type: 'hello', revision: 1, profileId: 'app:nec-inverse-byte-demodulated-nominal/1', mode: 'LIRC_MODE_MODE2', resolutionMicros: 1, carrierMeasurement: false }
          : { type: 'hello', revision: 1, profileId: 'app:nec-inverse-byte-command-one-shot/1', carrierRanges: [{ minHz: 38000, maxHz: 38000 }] });
        if (!isCurrent(epoch, context)) throw new Error('Software open retired');
        const token = randomBytes(16).toString('hex');
        const ready = waitFor(epoch, 'protocol', item => item.type === 'ready' && item.generation === context.generation && item.token === token, 500);
        await Promise.all([ready, write(epoch, { type: 'open', generation: context.generation, token, deadline: context.deadline })]);
        if (!isCurrent(epoch, context)) throw new Error('Software open retired');
        epoch.session = Object.freeze({ generation: context.generation, token }); epoch.phase = 'ready'; return 'ready';
      } catch (error) { if (!epoch.spawnIssued) { epoch.spawning = false; epoch.noProcess = true; rejectWaiters(epoch, error, true); epoch.adopted.resolve(); } fail(epoch, error); throw error; } finally { finish?.(); }
    },
    stop() { if (current) beginClose(current); },
    close() { return current ? beginClose(current) : empty; },
    whenSettled() { return current?.raw.promise ?? empty; },
  };
  if (receiver) provider.capture = async value => {
    const context = request(value, true), epoch = current;
    if (!epoch?.session || epoch.session.generation !== context.generation || !isCurrent(epoch, context)) throw new Error('Software capture unavailable');
    let finish;
    try {
      finish = activity(epoch, context);
      if (!isCurrent(epoch, context)) throw new Error('Software capture retired');
      const result = waitFor(epoch, 'protocol', item => ['capture', 'cancelled', 'rejected'].includes(item.type) && item.operationId === context.operationId, Math.max(1, context.deadline - performance.now()));
      const [reply] = await Promise.all([result, write(epoch, { type: 'capture', ...epoch.session, operationId: context.operationId, deadline: context.deadline })]);
      if (!isCurrent(epoch, context) || reply.type !== 'capture') throw new Error('Software capture rejected'); return reply.packets;
    } catch (error) { fail(epoch, error); throw error; } finally { finish?.(); }
  };
  else provider.transmit = async (envelope, value) => {
    const context = request(value, true), epoch = current;
    if (!epoch?.session || epoch.session.generation !== context.generation || !isCurrent(epoch, context)) return 'rejected';
    let finish;
    try {
      finish = activity(epoch, context);
      if (!isCurrent(epoch, context)) throw new Error('Software transmit retired');
      const bytes = Buffer.from(envelope), sha256 = createHash('sha256').update(bytes).digest('hex');
      const result = waitFor(epoch, 'protocol', item => ['completed', 'cancelled', 'rejected'].includes(item.type) && item.operationId === context.operationId, Math.max(1, context.deadline - performance.now()));
      const [reply] = await Promise.all([result, write(epoch, { type: 'emit', ...epoch.session, operationId: context.operationId, deadline: context.deadline, envelope: bytes.toString('base64'), sha256 })]);
      return isCurrent(epoch, context) && reply.type === 'completed' && reply.sha256 === sha256 ? 'completed' : 'rejected';
    } catch (error) { fail(epoch, error); throw error; } finally { finish?.(); }
  };
  const status = () => Object.freeze({ waiters: current?.waiters.size ?? 0, timers: current?.timers.size ?? 0, childRunning: Boolean(current && !current.settled) });
  const lifecycleStatus = () => Object.freeze({ phase: current?.phase ?? 'idle', epoch: current?.id ?? 0, fenced: current?.fenced ?? false,
    spawnCount, spawnUnconfirmed: current?.spawnUnconfirmed ?? false, spawnObserved: current?.spawnSeen ?? false, noProcessConfirmed: current?.noProcess ?? false,
    terminal: current?.terminal ? Object.freeze({ ...current.terminal }) : null, childClose: current?.childClose ? Object.freeze({ ...current.childClose }) : null,
    streams: Object.freeze((current?.streams ?? []).map(item => Object.freeze({ index: item.index, created: item.created, closed: item.closed, ended: item.ended }))),
    pendingWrites: current?.writes.size ?? 0, operations: current?.operations ?? 0, ...status(), rawPending: current && !current.settled ? 1 : 0,
    outcome: current?.settled ? (current.failures.length ? 'failed' : 'settled') : 'pending', failures: Object.freeze((current?.failures ?? []).map(error => error.message)) });
  const runtimeProof = () => Object.freeze({ before: current?.before ? frozenCopy(current.before) : null, after: current?.after ? frozenCopy(current.after) : null,
    pins, epoch: current?.id ?? 0, settled: current?.settled ?? true });
  return { provider, messages, ...(receiver ? { commands: commandTypes } : { sentTypes: commandTypes }), spawnCount: () => spawnCount, status, lifecycleStatus, runtimeProof };
}

export async function runIrEmitterConsumer() {
  const software = softwareProvider(); const owner = new AbortController(), controlGrant = new AbortController(), emissionGrant = new AbortController();
  const scope = { principalId: 'owned-operator', applicationId: 'ir-emitter-example', sessionId: 'loopback-ir-session' };
  let controlAllowed = false, emissionAllowed = false, epoch; const results = [], deadlines = new Map(), grantedRoutes = new Set();
  const gateway = createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope,
    selectedEmitter: { id: 'software-emitter-a', profileId: 'app:nec-inverse-byte-command-one-shot/1',
      codebook: [{ codeId: 'fixture-34-a2', address: 0x34, command: 0xa2 }] }, selectedProvider: software.provider,
    authorizeEmitter(request) { return controlAllowed ? { request, signal: controlGrant.signal, expiresAt: performance.now() + 5000 } : undefined; },
    authorizeEmission(request) { return emissionAllowed ? { request, signal: emissionGrant.signal, expiresAt: performance.now() + 5000 } : undefined; } });
  const runtime = createDeviceRuntime({ authorize: request => grantedRoutes.has(JSON.stringify([request.principalId, request.applicationId,
    request.sessionId, request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]))
    ? { expiresAt: performance.now() + 5000, maxAgeMs: 400 } : undefined });
  const capability = (id, kind, permissions) => ({ id, semantic: 'example:selected-nec32-code/1', schemaVersion: 1, kind,
    value: { type: 'enum', values: ['fixture-34-a2'] }, delivery: { mode: 'reliable', maxAgeMs: 400 }, permissions,
    ...(kind === 'command' ? { ownership: { mode: 'exclusive' } } : {}) });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-nec32-emitter', label: 'Software NEC32 emitter', revision: 1,
    adapter: { id: 'example:nec32-loopback', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: [capability('selected-code', 'event', ['subscribe']), capability('emit', 'command', ['invoke'])] });
  const source = runtime.registerSource({ device, capability: 'selected-code' });
  const sink = runtime.registerSink({ device, capability: 'emit', async apply(observation, context) {
    const deadline = deadlines.get(context.operationId); deadlines.delete(context.operationId);
    if (!epoch || !context.isCurrent() || context.signal.aborted || typeof deadline !== 'number') return;
    const result = await gateway.emit(epoch, { operationId: context.operationId, codeId: observation.value, purpose: 'approved selected code', signal: context.signal, deadline });
    results.push(result); if (result.ok && context.isCurrent() && !context.signal.aborted) context.reportEvidence('dispatched');
  }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = allow => { if (allow) grantedRoutes.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId,
    source.id, sink.id, 'subscribe', 'invoke'])); return runtime.route({ from: source, to: sink, ...scope, queueCapacity: 1 }); };
  const settle = async connection => { for (let turn = 0; turn < 200 && connection.status().pending; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(connection.status().pending, 0); };
  let connection;
  try {
    assert.deepEqual(await gateway.start({ purpose: 'selected emitter', deadline: performance.now() + 400 }), { ok: false, reason: 'denied' });
    assert.equal(software.spawnCount(), 0); controlAllowed = true;
    const started = await gateway.start({ purpose: 'selected emitter', deadline: performance.now() + 400 }); assert.ok(started.ok, JSON.stringify(started)); epoch = started.value;
    assert.equal(route(false).start().ok, false); assert.equal(results.length, 0);
    connection = route(true); assert.ok(connection.start().ok); let deadline = performance.now() + 400; deadlines.set('1', deadline);
    const published = runtime.publish(source, 'fixture-34-a2', { operationId: '1', deadline }); assert.ok(published.ok, JSON.stringify(published)); runtime.flush(); await settle(connection);
    assert.deepEqual(results, [{ ok: false, reason: 'denied' }]); assert.equal(software.sentTypes.includes('emit'), false);
    emissionAllowed = true; deadline = performance.now() + 400; deadlines.set('2', deadline);
    assert.ok(runtime.publish(source, 'fixture-34-a2', { operationId: '2', deadline }).ok); runtime.flush(); await settle(connection);
    assert.equal(results.length, 2); assert.ok(results[1].ok, JSON.stringify(results[1]));
    const accepted = connection.operations().find(item => item.id === '2'); assert.equal(accepted?.effectEvidence, 'dispatched');
    assert.notEqual(accepted?.effectEvidence, 'observed');
    runtime.revoke(connection); assert.equal(runtime.publish(source, 'fixture-34-a2', { operationId: '3', deadline: performance.now() + 400 }).ok, false);
    await gateway.stop(); assert.deepEqual(software.status(), { waiters: 0, timers: 0, childRunning: false });
    const restarted = await gateway.start({ purpose: 'fresh selected emitter session', deadline: performance.now() + 400 });
    assert.ok(restarted.ok, JSON.stringify(restarted)); epoch = restarted.value; assert.equal(software.spawnCount(), 2);
  } finally { runtime.close(); await gateway.close(); }
  const lifecycle = software.status(); assert.deepEqual(lifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.equal(software.messages.at(-1)?.type, 'closed'); assert.equal(gateway.status().rawPending, 0);
  const readyTokens = software.messages.filter(value => value.type === 'ready').map(value => value.token);
  assert.equal(new Set(readyTokens).size, 2);
  return { status: 'pass', kind: 'separate-process-loopback-nec32-emitter', checks: { deniedControlNoChild: true,
    deniedRouteNoEmission: true, approvedRoutePrivateDeniedNoChildEmit: true, approvedExactCode: true, routeRevocation: true,
    closeSettled: true, restartUsesFreshOwnedChild: true, zeroWaitersAndTimersAfterChildExit: true, providerCompletionOnly: true, physicalCarrierUnverified: true,
    targetAcknowledgementFalse: true, observedStateFalse: true },
    limitations: { providerIdentity: 'exact-in-process-provider-object', hardware: 'unverified', applianceMeaning: 'opaque-codebook-only',
      targetAcknowledgement: false, independentlyObservedState: false }, childMessages: software.messages.map(value => value.type),
    childCommands: [...software.sentTypes], lifecycle };
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await runIrEmitterConsumer()));
