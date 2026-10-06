import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
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
