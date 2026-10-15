import { createBrowserSerialSwitchOutputCaller } from '../../../examples/browser-resources/serial-switch-output.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Connection, DeliveryContext, Observation } from '@101/connect';
import { createBrowserSerialSwitchProvider } from './browser-serial-switch.ts';
import type { BrowserSerialSwitchOptions, BrowserSerialSwitchActivation, NativeSerialSwitchPort, NativeSerialSwitchManager } from './browser-serial-switch.ts';

// Genuine native ReadableStream/EventTarget with declared software Serial ports.
// These tests neither open native UART equipment nor qualify a physical product.
const profile = Object.freeze({ id: 'software:byte-switch/1', revision: 1, usbVendorId: 0x0101, usbProductId: 2 });
const uart = { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 256, flowControl: 'none' };
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function turns() { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); }
class SoftwarePort extends EventTarget implements NativeSerialSwitchPort {
  readable: ReadableStream<Uint8Array> | null = null; writable: WritableStream<Uint8Array> | null = null;
  controller?: ReadableStreamDefaultController<Uint8Array>; opens = 0; closes = 0; cancels = 0; lastOptions?: unknown;
  openWait?: Promise<void>; cancelWait?: Promise<void>; closeWait?: Promise<void>; beforeOpen?: () => void;
  vendor = profile.usbVendorId; product = profile.usbProductId;
  getInfo() { return { usbVendorId: this.vendor, usbProductId: this.product }; }
  async open(options: Parameters<NativeSerialSwitchPort['open']>[0]) {
    this.opens++; this.lastOptions = options; this.beforeOpen?.(); await this.openWait;
    this.readable = new ReadableStream<Uint8Array>({ start: controller => { this.controller = controller; },
      cancel: async () => { this.cancels++; await this.cancelWait; } }, { highWaterMark: 1 });
  }
  async close() { this.closes++; await this.closeWait; assert.equal(this.readable?.locked, false); this.readable = null; }
  bytes(values: number[]) { this.controller!.enqueue(Uint8Array.from(values)); }
}
class SoftwareManager extends EventTarget implements NativeSerialSwitchManager {
  calls = 0; choiceWait?: Promise<NativeSerialSwitchPort>; readonly port: SoftwarePort;
  constructor(port: SoftwarePort) { super(); this.port = port; }
  async requestPort() { this.calls++; return await (this.choiceWait ?? Promise.resolve(this.port)); }
  disconnect() { const event = new Event('disconnect'); Object.defineProperty(event, 'port', { value: this.port }); this.dispatchEvent(event); }
}
function fixture(change: Partial<BrowserSerialSwitchOptions> = {}) {
  let at = 100, activation = true, permitted = true, hidden = false, pressed = false, releases = 0, approvals = 0;
  const owner = new AbortController(), capture = new AbortController(), port = new SoftwarePort(), manager = new SoftwareManager(port), target = new EventTarget(), doc = new EventTarget();
  const scope = { principalId: 'serial-owner', applicationId: 'serial-example', sessionId: 'serial-session' }, observations: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'serial-js-read-receipt', maxPendingDeliveries: 1, authorize(request) {
    if (permitted && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId &&
      request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write')
      return { expiresAt: 1100, maxAgeMs: 100, maxHz: 20 };
  } });
  const provider = createBrowserSerialSwitchProvider({ runtime, ownerSignal: owner.signal, scope, reviewedProfile: profile, now: () => at,
    authorizeCapture(request) { approvals++; return { request, signal: capture.signal, expiresAt: 1100 }; },
    environment: { serial: manager, target, document: doc, secureContext: () => true, userActivation: () => activation, hidden: () => hidden,
      focused: () => true, policy: () => 'allowed' }, ...change });
  function bind(active: BrowserSerialSwitchActivation) {
    const device = parseDeviceDescriptor({ ...active.device, id: active.device.id + ':consumer', capabilities: active.device.capabilities.map(c =>
      ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'switch', apply(observation, context) {
      if (!context.isCurrent() || context.signal.aborted) return; observations.push(observation); pressed = (observation.value as { active: boolean }).active;
    }, release() { pressed = false; releases++; } }); runtime.setReadiness(sink, 'available');
    return runtime.route({ ...scope, from: active.source, to: sink, leaseMs: 1000, queueCapacity: 8 }).start();
  }
  async function start() { const choice = await provider.choose(); assert.ok(choice.ok); const active = await provider.start(choice.value, { purpose: 'software-switch' });
    assert.ok(active.ok); assert.ok(bind(active.value).ok); await turns(); return active.value; }
  async function bytes(values: number[]) { port.bytes(values); await turns(); runtime.flush(); }
  return { owner, capture, port, manager, provider, runtime, target, doc, scope, observations, bind, start, bytes, pressed: () => pressed, releases: () => releases,
    approvals: () => approvals, advance() { at += 50; }, setTime(value: number) { at = value; }, activationOff() { activation = false; }, denyRoutes() { permitted = false; },
    hide() { hidden = true; doc.dispatchEvent(new Event('visibilitychange')); }, async close() { owner.abort(); await provider.close(); runtime.close(); } };
}

test('construction has no chooser/open/read/listener and activation failure stays inert', async () => {
  const f = fixture(); try { assert.equal(f.manager.calls, 0); assert.equal(f.port.opens, 0); assert.equal(f.provider.snapshot().listeners, 0);
    f.activationOff(); const result = await f.provider.choose(); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'activation-required');
    assert.equal(f.manager.calls, 0); assert.equal(f.approvals(), 0);
  } finally { await f.close(); }
});

test('actual stream fragments become existing switch transitions with independent runtime grants', async () => {
  const f = fixture(); try { await f.start(); assert.deepEqual(f.port.lastOptions, uart);
    await f.bytes([1]); assert.equal(f.pressed(), true); f.advance(); await f.bytes([0, 1]); assert.equal(f.pressed(), false);
    // The granted20Hz route dispatches one queued transition per host turn;
    // its next flush retains the original completed-read stamp for the second byte.
    f.advance(); f.runtime.flush(); assert.equal(f.pressed(), true);
    assert.deepEqual(f.observations.map(value => value.value), [{ channel: 'switch-0', active: true }, { channel: 'switch-0', active: false }, { channel: 'switch-0', active: true }]);
    assert.equal(f.observations[0]?.clockDomain, 'serial-js-read-receipt'); assert.equal(f.observations[0]?.timestamp, 100);
    assert.equal(f.observations[0]?.provenance?.captureTimeKnown, false); assert.equal(f.observations[0]?.provenance?.clockMappingEstablished, false);
    f.provider.stop(); assert.equal(f.pressed(), false); assert.ok(f.releases() > 0);
  } finally { await f.close(); }
});

test('capture approval grants no denied sink effect', async () => {
  const f = fixture(); try { const chosen = await f.provider.choose(); assert.ok(chosen.ok);
    const active = await f.provider.start(chosen.value, { purpose: 'denied-runtime' }); assert.ok(active.ok);
    f.denyRoutes(); assert.equal(f.bind(active.value).ok, false); await turns(); await f.bytes([1]);
    assert.equal(f.observations.length, 0); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});

test('invalid entire chunk has no partial release frame and retires held input', async () => {
  for (const bytes of [[0, 2], [], Array(33).fill(0), Array(5).fill(0)] as number[][]) {
    const f = fixture(); try { await f.start(); await f.bytes([1]); assert.equal(f.pressed(), true); f.advance(); await f.bytes(bytes);
      assert.equal(f.observations.length, 1); assert.equal(f.pressed(), false); assert.equal(f.provider.snapshot().activeSources, 0);
    } finally { await f.close(); }
  }
});

test('borrowed port and foreign USB hint reject without own open or close', async () => {
  const borrowed = fixture(); borrowed.port.readable = new ReadableStream(); try {
    assert.equal((await borrowed.provider.choose()).ok, false); assert.equal(borrowed.port.opens, 0); assert.equal(borrowed.port.closes, 0);
  } finally { await borrowed.close(); }
  const foreign = fixture(); foreign.port.vendor++; try { assert.equal((await foreign.provider.choose()).ok, false);
    assert.equal(foreign.port.opens, 0); assert.equal(foreign.port.closes, 0); } finally { await foreign.close(); }
});

test('late chooser and late own open retain issued slots and close only the owned opening', async () => {
  const f = fixture(), choice = held<NativeSerialSwitchPort>(); f.manager.choiceWait = choice.promise;
  try {
  const choosing = f.provider.choose(); f.provider.stop(); assert.equal((await f.provider.choose()).ok, false); assert.equal(f.manager.calls, 1);
  let done = false; const close = f.provider.close().then(() => { done = true; }); await turns(); assert.equal(done, false);
  choice.resolve(f.port); assert.equal((await choosing).ok, false); await close; assert.equal(f.port.closes, 0);
  } finally { choice.resolve(f.port); await f.close(); }
  const opened = fixture(), gate = held<void>(); opened.port.openWait = gate.promise; try { const selected = await opened.provider.choose(); assert.ok(selected.ok);
  const starting = opened.provider.start(selected.value, { purpose: 'late-open' }); await turns(); assert.equal(opened.port.opens, 1);
  opened.provider.stop(); const finishing = opened.provider.close(); gate.resolve(); assert.equal((await starting).ok, false); await finishing;
  assert.equal(opened.port.closes, 1); assert.equal(opened.port.readable, null);
  } finally { gate.resolve(); await opened.close(); }
});

test('actual reader cancel and port close retain their native reservations until settlement', async () => {
  const f = fixture(), cancel = held<void>(), close = held<void>(); f.port.cancelWait = cancel.promise; f.port.closeWait = close.promise;
  try { await f.start(); await f.bytes([1]); f.provider.stop(); let done = false; const closing = f.provider.close(); assert.equal(closing, f.provider.close());
  void closing.then(() => { done = true; }); await turns(); assert.equal(f.pressed(), false); assert.equal(done, false);
  assert.equal(f.provider.snapshot().readerLocks, 1); assert.equal(f.provider.snapshot().cancelPending, 1); assert.equal(f.port.closes, 0);
  assert.equal((await f.provider.choose()).ok, false); cancel.resolve(); await turns(); assert.equal(f.provider.snapshot().readerLocks, 0);
  assert.equal(f.port.closes, 1); assert.equal(f.provider.snapshot().closePending, 1); assert.equal(done, false);
  close.resolve(); await closing; assert.equal(f.provider.snapshot().nativePending, 0); assert.equal(f.provider.snapshot().cleanupFailed, false);
  } finally { cancel.resolve(); close.resolve(); await f.close(); }
});

test('intrinsic revoke, expiry sweep, disconnect, hide and invalid clock release the actual sink', async () => {
  for (const cause of ['revoke', 'expiry', 'disconnect', 'hide', 'clock', 'eof'] as const) {
    const f = fixture(); try { Object.defineProperty(f.capture.signal, 'addEventListener', { value() {} }); Object.defineProperty(f.capture.signal, 'aborted', { value: false });
      await f.start(); await f.bytes([1]); assert.equal(f.pressed(), true);
      if (cause === 'revoke') f.capture.abort(); else if (cause === 'expiry') { f.setTime(1100); f.provider.sweep(); }
      else if (cause === 'disconnect') f.manager.disconnect(); else if (cause === 'hide') f.hide(); else if (cause === 'eof') f.port.controller!.close();
      else { f.setTime(99); f.port.bytes([0]); } await turns(); assert.equal(f.pressed(), false); assert.equal(f.provider.snapshot().activeSources, 0);
    } finally { await f.close(); }
  }
});

test('descriptor Proxy reentry is refused before a second held capture authorizer', async () => {
  type Grant = Exclude<Awaited<ReturnType<BrowserSerialSwitchOptions['authorizeCapture']>>, undefined>;
  const pending: { request: Parameters<BrowserSerialSwitchOptions['authorizeCapture']>[0]; resolve(value: Grant): void }[] = [];
  const f = fixture({ authorizeCapture(request) { return new Promise<Grant>(resolve => pending.push({ request, resolve })); } });
  let nested: ReturnType<typeof f.provider.start> | undefined, outer: ReturnType<typeof f.provider.start> | undefined;
  try { const selected = await f.provider.choose(); assert.ok(selected.ok); const handle = selected.value;
    outer = f.provider.start(handle, new Proxy({ purpose: 'outer' }, { getOwnPropertyDescriptor(target, key) {
      if (!nested) nested = f.provider.start(handle, { purpose: 'nested' }); return Reflect.getOwnPropertyDescriptor(target, key);
    } })); assert.equal(pending.length, 1); assert.ok(nested); const result = await nested; assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'busy');
  } finally { f.provider.stop(); for (const job of pending) job.resolve({ request: job.request, signal: f.capture.signal, expiresAt: 1100 });
    await f.provider.close(); if (outer) await outer; await f.close(); }
});


test('quiet native read timeout retires authority and settles the real stream lock', async () => {
  const f = fixture(); try { await f.start(); await f.bytes([1]); assert.equal(f.pressed(), true);
    // This observes an actual unchanged500ms read timer, not a simulated callback.
    await new Promise<void>(resolve => setTimeout(resolve, 550));
    assert.equal(f.provider.snapshot().reason, 'timeout'); assert.equal(f.pressed(), false);
    assert.equal(f.provider.snapshot().readerLocks, 0); assert.equal(f.port.closes, 1);
  } finally { await f.close(); }
});

// Genuine Streams and the real public reliable event→invoke runtime; software ports only.
function outputFixture(change: Partial<BrowserSerialSwitchOptions> = {}) {
  let at = 1000, end = 31000, routeEnd = end, outputCalls = 0, operation = 0, allowed = true;
  let beforeClock: (() => void) | undefined, beforeWrite: (() => void) | undefined, writeWait: Promise<void> | undefined, rejected = false;
  const owner = new AbortController(), capture = new AbortController(), output = new AbortController();
  const port = new SoftwarePort(), manager = new SoftwareManager(port), target = new EventTarget(), doc = new EventTarget();
  const written: number[][] = [], observed: Observation[] = [], scope = { principalId: 'serial-owner', applicationId: 'serial-example', sessionId: 'serial-session' };
  const originalOpen = port.open.bind(port), originalClose = port.close.bind(port);
  port.open = async options => { await originalOpen(options); port.writable = new WritableStream<Uint8Array>({ async write(bytes) {
    written.push([...bytes]); beforeWrite?.(); await writeWait; if (rejected) throw Error('owned-write-refusal');
  } }, { highWaterMark: 1 }); };
  port.close = async () => { assert.notEqual(port.writable?.locked, true); await originalClose(); port.writable = null; };
  const routes = new Map<string, Connection>(); let connection: Connection | undefined, command: ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']> | undefined;
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'serial-output-host-receipt', maxPendingDeliveries: 2, authorize(request) {
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId) return;
    if (request.sourceOperation === 'subscribe' && request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 100, maxHz: 20 };
    if (allowed && request.sourceOperation === 'subscribe' && request.source.capabilityId === 'switch-setting' && request.sink.capabilityId === 'switch-setting' && request.sinkOperation === 'invoke') return { expiresAt: routeEnd, maxAgeMs: 100, maxHz: 2 };
  } });
  const provider = createBrowserSerialSwitchProvider({ runtime, ownerSignal: owner.signal, scope, now: () => { beforeClock?.(); return at; }, reviewedProfile: { ...profile, writeFormat: 'boolean-byte/1' },
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: end }; },
    authorizeOutput(request) { outputCalls++; return { request, signal: output.signal, expiresAt: end }; },
    outputDeliveryLimits(context) { const route = routes.get(context.routeId), limits = route?.limits(), record = route?.operations().find(row => row.id === context.operationId && row.handlerResult === 'running');
      return route && route === connection && limits && record ? { context, expiresAt: Math.min(limits.expiresAt, record.deadline), maxAgeMs: Math.min(100, limits.maxAgeMs), maxHz: Math.min(2, limits.maxHz) } : undefined; },
    environment: { serial: manager, target, document: doc, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' }, ...change });
  async function start() { const selected = await provider.choose(); assert.ok(selected.ok); const started = await provider.start(selected.value, { purpose: 'owned-software-input' }); assert.ok(started.ok);
    const device = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':display', capabilities: started.value.device.capabilities.map(row => ({ ...row, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'switch', apply(value, context) { if (context.isCurrent()) observed.push(value); }, release() {} }); runtime.setReadiness(sink, 'available');
    const route = runtime.route({ ...scope, from: started.value.source, to: sink, leaseMs: 30000, queueCapacity: 8 }); assert.ok(route.start().ok); routes.set(route.id, route); await turns(); return started.value; }
  function bind(active: BrowserSerialSwitchActivation) { const result = provider.bindOutput(active, { purpose: 'owned-software-setting' }); if (!result.ok) return result;
    const device = parseDeviceDescriptor({ ...result.value.device, id: result.value.device.id + ':commands', capabilities: result.value.device.capabilities.map(row => ({ ...row, kind: 'event', permissions: ['subscribe'] })) });
    command = runtime.registerSource({ device, capability: 'switch-setting' }); runtime.setReadiness(command, 'available');
    connection = runtime.route({ ...scope, from: command, to: result.value.sink, leaseMs: Math.max(1, Math.floor(Math.min(30000, routeEnd - at))), queueCapacity: 1 }); routes.set(connection.id, connection); return { result, started: connection.start() }; }
  function send(value: unknown, deadline = at + 100) { assert.ok(command); const result = runtime.publish(command, value, { timestamp: at, clockDomain: runtime.clockDomain, operationId: String(++operation), deadline }); runtime.flush(); return result; }
  return { provider, runtime, owner, capture, output, port, written, observed, start, bind, send, outputCalls: () => outputCalls,
    setTime(value: number) { at = value; }, advance() { at += 500; }, setEnd(value: number) { end = value; routeEnd = value; }, setRouteEnd(value: number) { routeEnd = value; },
    setClock(callback: () => void) { beforeClock = callback; }, setWrite(callback: () => void) { beforeWrite = callback; }, hold(value: Promise<void>) { writeWait = value; },
    reject() { rejected = true; }, denyRoute() { allowed = false; }, async close() { owner.abort(); await provider.close(); runtime.close(); } };
}
async function outputTurns() { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); }

test('Serial output default denial preserves the independently routed reader', async () => {
  for (const change of [{ reviewedProfile: profile }, { authorizeOutput: undefined }]) { const f = outputFixture(change); try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'declined' }).ok, false);
    assert.equal(f.port.writable?.locked, false); assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.written.length, 0); f.port.bytes([1]); await turns(); f.runtime.flush(); assert.equal(f.observed.length, 1); } finally { await f.close(); } }
});
test('Serial output requires an available genuine unlocked WritableStream', async () => {
  for (const kind of ['missing', 'locked', 'foreign'] as const) { const f = outputFixture(); let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try { const active = await f.start(); if (kind === 'missing') f.port.writable = null; if (kind === 'locked') writer = f.port.writable!.getWriter(); if (kind === 'foreign') f.port.writable = {} as WritableStream<Uint8Array>;
      assert.equal(f.provider.bindOutput(active, { purpose: 'unsupported' }).ok, false); assert.equal(f.outputCalls(), 0); assert.equal(f.written.length, 0); }
    finally { writer?.releaseLock(); if (kind === 'foreign') f.port.writable = null; await f.close(); } }
});
test('Serial output accepts only privately issued current activation identity', async () => {
  const f = outputFixture(), other = outputFixture(); try { const active = await f.start(), foreign = await other.start();
    for (const value of [{}, { ...active }, foreign]) { assert.equal(f.provider.inspectOutput(value as BrowserSerialSwitchActivation).ok, false); assert.equal(f.provider.bindOutput(value as BrowserSerialSwitchActivation, { purpose: 'foreign' }).ok, false); }
    f.provider.stop(); assert.equal(f.provider.bindOutput(active, { purpose: 'retired' }).ok, false); assert.equal(f.outputCalls(), 0); } finally { await f.close(); await other.close(); }
});
test('Serial copied malformed and widened output grants cannot acquire a writer', async () => {
  for (const kind of ['request', 'signal', 'expired', 'widened', 'accessor'] as const) { let getters = 0;
    const f = outputFixture({ authorizeOutput(request) { if (kind === 'request') return { request: { ...request }, signal: f.output.signal, expiresAt: 31000 };
      if (kind === 'signal') return { request, signal: { aborted: false } as AbortSignal, expiresAt: 31000 };
      if (kind === 'expired') return { request, signal: f.output.signal, expiresAt: 1000 }; if (kind === 'widened') return { request, signal: f.output.signal, expiresAt: 31001 };
      return { request, get signal() { getters++; return f.output.signal; }, expiresAt: 31000 }; } });
    try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'exact-review' }).ok, false); assert.equal(f.port.writable?.locked, false); assert.equal(getters, 0); } finally { await f.close(); }
  }
});
test('Serial reliable invoke emits exactly 0 and 1 without inventing readback', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); assert.ok(f.send(false).ok); await outputTurns(); f.advance(); assert.ok(f.send(true).ok); await outputTurns();
    assert.deepEqual(f.written, [[0], [1]]); assert.equal(f.observed.length, 0); assert.ok(f.provider.outputStatus().records.every(row => row.apiReturned && row.physical === 'unverified'));
    f.port.bytes([1]); await turns(); f.runtime.flush(); assert.equal(f.observed.length, 1); } finally { await f.close(); }
});
test('Serial output consent cannot bypass denied invoke or invalid boolean schema', async () => {
  const denied = outputFixture(); try { const active = await denied.start(); denied.denyRoute(); const bound = denied.bind(active); assert.ok('started' in bound && !bound.started.ok); assert.equal(denied.written.length, 0); } finally { await denied.close(); }
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); for (const value of [0, '1', { active: true }]) assert.equal(f.send(value).ok, false); assert.equal(f.written.length, 0); } finally { await f.close(); }
});
test('Serial missing or nonexact delivery snapshots default deny before write', async () => {
  for (const kind of ['absent', 'copy', 'accessor'] as const) { let getters = 0; const f = outputFixture({ outputDeliveryLimits: kind === 'absent' ? undefined : context => {
    const base = { context, expiresAt: 1100, maxAgeMs: 100, maxHz: 2 }; return kind === 'copy' ? { ...base, context: { ...context } } : { ...base, get maxHz() { getters++; return 2; } }; } });
    try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputTurns(); assert.equal(f.written.length, 0); assert.equal(getters, 0); } finally { await f.close(); }
  }
});
test('Serial final clock honors narrower real route and operation deadlines', async () => {
  for (const kind of ['route', 'operation'] as const) { let armed = false; const f = outputFixture({ outputDeliveryLimits(context) { armed = true; return { context, expiresAt: 1025, maxAgeMs: 100, maxHz: 2 }; } });
    try { const active = await f.start(); if (kind === 'route') f.setRouteEnd(1025); const bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.setClock(() => { if (armed) f.setTime(1040); });
      f.send(true, kind === 'operation' ? 1025 : 1100); await outputTurns(); assert.equal(f.written.length, 0); } finally { await f.close(); }
  }
});
test('Serial final current observer cannot expire capture behind the final clock', async () => {
  const f = outputFixture(); f.setEnd(2000); const register = f.runtime.registerSink.bind(f.runtime); let calls = 0;
  f.runtime.registerSink = sink => register({ ...sink, apply(value, context) { if (sink.capability !== 'switch-setting') return sink.apply(value, context);
    const wrapped: DeliveryContext = Object.freeze({ ...context, isCurrent() { const current = context.isCurrent(); if (++calls >= 2) f.setTime(2000); return current; } }); return sink.apply(value, wrapped); } });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputTurns(); assert.equal(f.written.length, 0); assert.ok(calls >= 2); } finally { await f.close(); }
});
test('Serial writable getter Stop and intrinsic shadowed output abort refuse issuance', async () => {
  for (const kind of ['getter', 'signal'] as const) { const f = outputFixture(); try { const active = await f.start();
    if (kind === 'getter') { const stream = f.port.writable; Object.defineProperty(f.port, 'writable', { configurable: true, get() { f.provider.stop(); return stream; }, set() {} }); assert.equal(f.provider.bindOutput(active, { purpose: 'reentrant' }).ok, false); }
    else { const bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); Object.defineProperty(f.output.signal, 'aborted', { value: false }); f.setClock(() => f.output.abort()); f.send(true); await outputTurns(); }
    assert.equal(f.written.length, 0); } finally { await f.close(); }
  }
});
test('Serial output admission reserves before Proxy descriptor reentry', async () => {
  const f = outputFixture(); let nested: unknown; try { const active = await f.start(); const intent = new Proxy({ purpose: 'outer' }, { ownKeys(target) { nested = f.provider.bindOutput(active, { purpose: 'nested' }); return Reflect.ownKeys(target); } });
    assert.equal(f.provider.bindOutput(active, intent).ok, true); assert.deepEqual(nested, { ok: false, reason: 'busy' }); assert.equal(f.outputCalls(), 1); } finally { await f.close(); }
});
test('Serial late command sink cleanup failure quarantines output admission', async () => {
  const f = outputFixture(), register = f.runtime.registerSink.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime); let late: ReturnType<typeof register> | undefined;
  f.runtime.registerSink = sink => { const handle = register(sink); if (sink.capability === 'switch-setting') { late = handle; f.provider.stop(); } return handle; };
  f.runtime.unregister = handle => { if (handle === late) throw Error('owned-unregister-failure'); return unregister(handle); };
  try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'late' }).ok, false); assert.equal(f.provider.outputStatus().cleanupFailed, true); assert.equal(f.provider.inspectOutput(active).ok, false); }
  finally { f.runtime.unregister = unregister; if (late) unregister(late); await f.close(); }
});
test('Serial held write keeps close pending through both locks and port close settlement', async () => {
  const f = outputFixture(), write = held<void>(), closeGate = held<void>(); f.hold(write.promise); f.port.closeWait = closeGate.promise;
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await turns(); assert.equal(f.written.length, 1); f.provider.stop();
    let done = false; const closing = f.provider.close(); assert.equal(closing, f.provider.close()); void closing.then(() => { done = true; }); await turns(); assert.equal(done, false); assert.equal(f.port.closes, 0); assert.equal(f.port.writable?.locked, true);
    write.resolve(); await outputTurns(); assert.equal(f.port.writable?.locked, false); assert.equal(f.port.closes, 1); assert.equal(done, false); closeGate.resolve(); await closing; assert.equal(f.provider.snapshot().nativePending, 0); assert.equal(f.provider.outputStatus().records[0]!.outcome, 'uncertain'); assert.deepEqual(f.written, [[1]]); }
  finally { write.resolve(); closeGate.resolve(); await f.close(); }
});
test('Serial native stream write reentrant close reserves its actual Promise', async () => {
  const f = outputFixture(), write = held<void>(); f.hold(write.promise); let closing: Promise<void> | undefined, done = false; f.setWrite(() => { closing = f.provider.close(); void closing.then(() => { done = true; }); });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await turns(); assert.ok(closing); assert.equal(done, false); assert.equal(f.port.closes, 0); write.resolve(); await closing; assert.equal(f.port.closes, 1); }
  finally { write.resolve(); await f.close(); }
});
test('Serial logical operation timeout retains issued work and never writes a reset', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const f = outputFixture(), write = held<void>(); f.hold(write.promise);
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true, 1025); await turns(); f.setTime(1025); context.mock.timers.tick(25);
    assert.equal(f.provider.outputStatus().records[0]!.outcome, 'uncertain'); assert.equal(f.provider.outputStatus().writePending, 1); assert.deepEqual(f.written, [[1]]); write.resolve(); await f.provider.close(); } finally { write.resolve(); await f.close(); context.mock.timers.reset(); }
});
test('Serial output-only idle expiry releases writer and preserves input capture', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const f = outputFixture({ authorizeOutput(request) { return { request, signal: f.output.signal, expiresAt: 1500 }; } });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.setTime(1499); context.mock.timers.tick(499); f.port.bytes([0]); await turns(); f.runtime.flush(); f.setTime(1500); context.mock.timers.tick(1); await outputTurns();
    assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.port.writable?.locked, false); assert.equal(f.provider.snapshot().activeSources, 1); f.setTime(1550); f.port.bytes([1]); await turns(); f.runtime.flush(); assert.equal(f.observed.length, 2); } finally { await f.close(); context.mock.timers.reset(); }
});
test('Serial output rate attempt and history budgets remain finite', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    for (let row = 0; row < 31; row++) { if (row) f.advance(); f.send(row % 2 === 1); await outputTurns(); }
    assert.equal(f.written.length, 31); assert.equal(f.provider.outputStatus().attempts, 32); assert.equal(f.provider.outputStatus().records.length, 16); f.advance(); f.send(true); await turns(); assert.equal(f.written.length, 31); } finally { await f.close(); }
  const f2 = outputFixture(); try { const active = await f2.start(), bound = f2.bind(active); assert.ok('started' in bound && bound.started.ok); f2.send(true); await outputTurns(); f2.send(false); await outputTurns(); assert.equal(f2.written.length, 1); } finally { await f2.close(); }
});
test('Serial rejected write is an issued API refusal without fabricated state', async () => {
  const f = outputFixture(); f.reject(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputTurns(); assert.equal(f.provider.outputStatus().records[0]!.outcome, 'api-rejected'); assert.equal(f.observed.length, 0); } finally { await f.close(); }
});

// Actual public caller + existing native-shaped software fixture. A user clock
// failure is injected only at the direct caller callback after genuine binding;
// provider/runtime calls remain unchanged and no hardware is accessed.
for (const site of ['connectOutput', 'set'] as const) {
  test(`public serial output caller retires provisional state after clock failure in ${site}`, async context => {
    const owner = new AbortController(), capture = new AbortController(), output = new AbortController();
    const target = new EventTarget(), document = new EventTarget(); let writes = 0, failing = false, witnessed = false;
    const device = new SoftwarePort(), manager = new SoftwareManager(device);
    const open = device.open.bind(device);
    device.open = async options => { await open(options); device.writable = new WritableStream<Uint8Array>({ write() { writes++; } }); };
    const close = device.close.bind(device);
    device.close = async () => { assert.notEqual(device.writable?.locked, true); await close(); device.writable = null; };
    const reviewedProfile = { ...profile, writeFormat: 'boolean-byte/1' as const };
    const caller = createBrowserSerialSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile,
      now() {
        const directCaller = new Error().stack?.split('\n')[2] ?? '';
        if (failing && directCaller.includes(`Object.${site} `)) {
          const state = caller.state(); witnessed = state.provider.activeSources === 1 && state.output.activeSinks === 1;
          context.diagnostic(JSON.stringify({ site, directCaller, captureSources: state.provider.activeSources, outputSinks: state.output.activeSinks, nativeWrites: writes }));
          throw Error('owned-caller-clock-failure');
        } return 1000;
      },
      environment: { serial: manager, target, document, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' },
      authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: 31000 }; },
      authorizeOutput(request) { return { request, signal: output.signal, expiresAt: 31000 }; },
      authorizeRoutes(request) {
        if (request.sourceOperation === 'subscribe' &&
          ((request.source.capabilityId === 'switch' && request.sinkOperation === 'write') ||
          (request.source.capabilityId === 'switch-setting' && request.sinkOperation === 'invoke')))
          return { expiresAt: 31000, maxAgeMs: 100, maxHz: request.sinkOperation === 'invoke' ? 2 : 20 };
      } });
    try {
      assert.ok((await caller.activate('actual-software-clock-recovery')).ok);
      if (site === 'set') assert.ok(caller.connectOutput('actual-software-command-route').ok);
      failing = true; let result: { ok: boolean; reason?: string } | undefined;
      assert.doesNotThrow(() => { result = site === 'connectOutput' ? caller.connectOutput('throwing-clock') : caller.set(true); });
      assert.ok(witnessed, 'failure must follow actual capture and output binding');
      assert.equal(result?.ok, false); assert.equal(result?.reason, 'unavailable');
      assert.equal(writes, 0, 'caller failure must issue no native write');
      assert.equal(caller.state().provider.activeSources, 0); assert.equal(caller.state().output.activeSinks, 0);
      failing = false;
      for (let turn = 0; turn < 256 && caller.state().provider.nativePending; turn++) await Promise.resolve();
      assert.equal(caller.state().provider.nativePending, 0);
      assert.ok((await caller.activate('fresh-software-clock-recovery')).ok);
      assert.ok(caller.connectOutput('fresh-software-output-recovery').ok);
      assert.ok(caller.set(true).ok);
      for (let turn = 0; turn < 256 && caller.state().output.records.at(-1)?.outcome !== 'api-returned'; turn++) await Promise.resolve();
      assert.equal(caller.state().output.records.at(-1)?.outcome, 'api-returned'); assert.equal(writes, 1);
    } finally { failing = false; owner.abort(); await caller.close(); }
  });
}

function switchHostFailure(shape: string): unknown {
  if (shape === 'denied') return new DOMException('Capture blocked', 'NotAllowedError');
  if (shape === 'security-denied') return new DOMException('Capture blocked', 'SecurityError');
  if (shape === 'ordinary-name') { const error = new Error('Host failure'); error.name = 'NotAllowedError'; return error; }
  if (shape === 'structured-lost') return { ok: false, reason: 'lost' };
  const opaque = Proxy.revocable({}, {}); opaque.revoke();
  if (shape === 'revoked') return opaque.proxy;
  if (shape === 'throwing-name') return Object.defineProperty(new DOMException('Unreadable error', 'NotAllowedError'), 'name', { get() { throw opaque.proxy; } });
  let reads = 0;
  return new Proxy({}, { getPrototypeOf() { if (reads++ === 0) return Object.prototype; throw opaque.proxy; } });
}
const switchFailureCases = [
  ['revoked', 'unavailable'], ['throwing-name', 'unavailable'], ['later-prototype', 'unavailable'],
  ['denied', 'denied'], ['security-denied', 'denied'], ['ordinary-name', 'unavailable'], ['structured-lost', 'lost'],
] as const;

for (const [shape, expected] of switchFailureCases) {
  test(shape + ' Serial read failure releases held input and the stream lock', async () => {
    const f = fixture(), error = switchHostFailure(shape);
    try {
      await f.start(); await f.bytes([1]); assert.equal(f.pressed(), true);
      assert.equal(f.provider.snapshot().readPending, 1, 'The actual reader is waiting for its next chunk');
      f.port.controller!.error(error); await turns();
      assert.equal(f.pressed(), false, 'A rejected real stream read must release the actual sink');
      assert.ok(f.releases() > 0); assert.equal(f.provider.snapshot().activeSources, 0);
      assert.equal(f.provider.snapshot().reason, expected);
      await f.provider.close();
      assert.equal(f.provider.snapshot().readPending, 0); assert.equal(f.provider.snapshot().readerLocks, 0);
      assert.equal(f.provider.snapshot().nativePending, 0); assert.equal(f.port.closes, 1);
      assert.equal(f.port.readable, null);
    } finally { await f.close(); }
  });
}
