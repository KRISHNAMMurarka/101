import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserBleSwitchOptions, BrowserBleSwitchActivation, NativeBleSwitchDevice, NativeBleSwitchServer,
  NativeBleSwitchService, NativeBleSwitchCharacteristic, NativeBleSwitchManager } from './browser-ble-switch.ts';

// Actual EventTarget/DataView + public runtime; native-shaped software GATT
// ports do not qualify a vendor UUID, radio, chooser or physical BLE delivery.
const api = await import('./browser-ble-switch.ts').catch(() => undefined);
const profile = Object.freeze({ id: 'software:ble-one-byte-switch/1', revision: 1,
  serviceUUID: '5f5a0101-0000-4000-8000-010100000001', characteristicUUID: '5f5a0101-0000-4000-8000-010100000002' });
const properties = { authenticatedSignedWrites: false, broadcast: false, indicate: false, notify: true, read: false,
  reliableWrite: false, writableAuxiliaries: false, write: false, writeWithoutResponse: false };
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function reached(condition: () => boolean) { for (let turn = 0; turn < 32 && !condition(); turn++) await Promise.resolve(); assert.ok(condition()); }
class Characteristic extends EventTarget implements NativeBleSwitchCharacteristic {
  readonly service: Service; uuid: string = profile.characteristicUUID; properties = { ...properties }; value?: DataView;
  starts = 0; stops = 0; notifying = false; startWait?: Promise<void>; stopWait?: Promise<void>; stopFailure = false;
  beforeStart?: () => void;
  constructor(service: Service) { super(); this.service = service; }
  async startNotifications() { this.starts++; this.beforeStart?.(); await this.startWait; this.notifying = true; return this; }
  async stopNotifications() { this.stops++; await this.stopWait; if (this.stopFailure) throw Error('software-stop-failure'); this.notifying = false; return this; }
  emit(values: number[]) { this.value = new DataView(Uint8Array.from(values).buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); }
}
class Service implements NativeBleSwitchService {
  readonly device: Device; uuid: string = profile.serviceUUID; isPrimary = true; calls = 0; wait?: Promise<void>;
  readonly characteristic: Characteristic;
  constructor(device: Device) { this.device = device; this.characteristic = new Characteristic(this); }
  async getCharacteristic(uuid: string) { assert.equal(uuid, profile.characteristicUUID); this.calls++; await this.wait; return this.characteristic; }
}
class Server implements NativeBleSwitchServer {
  readonly device: Device; connected = false; connects = 0; disconnects = 0; services = 0;
  connectWait?: Promise<void>; serviceWait?: Promise<void>; disconnectWait?: Promise<void>; beforeConnect?: () => void; other?: NativeBleSwitchServer;
  readonly service: Service;
  constructor(device: Device) { this.device = device; this.service = new Service(device); }
  async connect() { this.connects++; this.beforeConnect?.(); await this.connectWait; this.connected = true; return this.other ?? this; }
  async disconnect() { this.disconnects++; await this.disconnectWait; this.connected = false; this.device.dispatchEvent(new Event('gattserverdisconnected')); }
  async getPrimaryService(uuid: string) { assert.equal(uuid, profile.serviceUUID); this.services++; await this.serviceWait; return this.service; }
}
class Device extends EventTarget implements NativeBleSwitchDevice { readonly gatt: Server; constructor() { super(); this.gatt = new Server(this); } }
class Manager implements NativeBleSwitchManager {
  calls = 0; options?: Parameters<NativeBleSwitchManager['requestDevice']>[0]; wait?: Promise<NativeBleSwitchDevice>; readonly device: Device;
  constructor(device: Device) { this.device = device; }
  async requestDevice(options: Parameters<NativeBleSwitchManager['requestDevice']>[0]) { this.calls++; this.options = options; return await (this.wait ?? Promise.resolve(this.device)); }
}
function fixture(change: Partial<BrowserBleSwitchOptions> = {}) {
  assert.ok(api, 'The reviewed read-only BLE switch provider must exist');
  let at = 100, activation = true, routes = true, captureCalls = 0, heldValue = false, releases = 0, until = 1100;
  let capture = new AbortController(), beforeClock: (() => void) | undefined, beforeRelease: (() => void) | undefined;
  const device = new Device(), manager = new Manager(device), target = new EventTarget(), document = new EventTarget();
  const owner = new AbortController(), observations: Observation[] = [], scope = { principalId: 'ble-owner', applicationId: 'ble-example', sessionId: 'ble-session' };
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'ble-javascript-receipt', maxPendingDeliveries: 1,
    authorize(request) { if (routes && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId &&
      request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write')
      return { expiresAt: until, maxAgeMs: 100, maxHz: 20 }; } });
  const provider = api.createBrowserBleSwitchProvider({ runtime, ownerSignal: owner.signal, scope, reviewedProfile: profile, now: () => { beforeClock?.(); return at; },
    authorizeCapture(request) { captureCalls++; return { request, signal: capture.signal, expiresAt: until }; },
    environment: { bluetooth: manager, target, document, secureContext: () => true, userActivation: () => activation, hidden: () => false, focused: () => true, policy: () => 'allowed' }, ...change });
  function bind(value: BrowserBleSwitchActivation) {
    const device = parseDeviceDescriptor({ ...value.device, id: value.device.id + ':consumer', capabilities: value.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'switch', apply(observation, context) {
      if (!context.isCurrent() || context.signal.aborted) return; observations.push(observation); heldValue = (observation.value as { active: boolean }).active;
    }, release() { heldValue = false; releases++; beforeRelease?.(); } }); runtime.setReadiness(sink, 'available');
    return runtime.route({ ...scope, from: value.source, to: sink, leaseMs: 30000, queueCapacity: 8 }).start();
  }
  async function start() { const choice = await provider.choose(); assert.ok(choice.ok); const active = await provider.start(choice.value, { purpose: 'software-switch' }); assert.ok(active.ok); assert.ok(bind(active.value).ok); return active.value; }
  return { device, server: device.gatt, characteristic: device.gatt.service.characteristic, manager, target, document, owner, runtime, provider, scope, observations, bind, start,
    capture: () => capture, freshCapture() { capture = new AbortController(); }, denyRoutes() { routes = false; }, noActivation() { activation = false; },
    setClockCallback(callback: () => void) { beforeClock = callback; }, setReleaseCallback(callback: () => void) { beforeRelease = callback; }, captureCalls: () => captureCalls, setTime(value: number) { at = value; }, time: () => at,
    setUntil(value: number) { until = value; }, advance(value = 50) { at += value; }, held: () => heldValue, releases: () => releases, flush() { runtime.flush(); },
    async close() { owner.abort(); await provider.close(); runtime.close(); } };
}

test('BLE provider feature is inert and requires activation before the fixed native selection', async () => {
  const f = fixture(); try {
    assert.equal(f.manager.calls, 0); assert.equal(f.server.connects, 0); assert.equal(f.captureCalls(), 0); assert.equal(f.provider.snapshot().listeners, 0);
    f.noActivation(); const chosen = await f.provider.choose(); assert.equal(chosen.ok, false); if (!chosen.ok) assert.equal(chosen.reason, 'activation-required');
    assert.equal(f.manager.calls, 0);
  } finally { await f.close(); }
});
test('genuine software GATT notifications use fixed service filtering, switch schema and separate route grants', async () => {
  const f = fixture(); try {
    await f.start(); assert.deepEqual(f.manager.options, { filters: [{ services: [profile.serviceUUID] }] });
    f.characteristic.emit([1]); f.flush(); assert.equal(f.held(), true); f.advance(); f.characteristic.emit([0]); f.flush(); assert.equal(f.held(), false);
    assert.deepEqual(f.observations.map(row => row.value), [{ channel: 'switch-0', active: true }, { channel: 'switch-0', active: false }]);
    assert.equal(f.observations[0]?.timestamp, 100); assert.equal(f.observations[0]?.clockDomain, 'ble-javascript-receipt');
    assert.equal(f.observations[0]?.provenance?.captureTimeKnown, false); assert.equal(f.observations[0]?.provenance?.clockMappingEstablished, false);
    f.provider.stop(); assert.ok(f.releases() > 0);
  } finally { await f.close(); assert.equal(f.characteristic.stops, 1); assert.equal(f.server.disconnects, 1); assert.equal(f.server.connected, false); }
});
test('capture refusal occurs before any native connect and cannot establish a route grant', async () => {
  const f = fixture({ authorizeCapture: () => undefined }); try {
    const chosen = await f.provider.choose(); assert.ok(chosen.ok); const active = await f.provider.start(chosen.value, { purpose: 'denied' });
    assert.equal(active.ok, false); if (!active.ok) assert.equal(active.reason, 'denied'); assert.equal(f.server.connects, 0);
  } finally { await f.close(); }
});
test('capture consent never creates a separately denied runtime output effect', async () => {
  const f = fixture(); try {
    const chosen = await f.provider.choose(); assert.ok(chosen.ok); const active = await f.provider.start(chosen.value, { purpose: 'no-route' }); assert.ok(active.ok);
    f.denyRoutes(); assert.equal(f.bind(active.value).ok, false); f.characteristic.emit([1]); f.flush(); assert.equal(f.observations.length, 0); assert.equal(f.held(), false);
  } finally { await f.close(); }
});
test('forged/stale choices and a foreign already-connected GATT server are refused without disconnect', async () => {
  const f = fixture(); try {
    assert.equal((await f.provider.start({}, { purpose: 'forged' })).ok, false);
    const chosen = await f.provider.choose(); assert.ok(chosen.ok); f.provider.stop(); assert.equal((await f.provider.start(chosen.value, { purpose: 'stale' })).ok, false);
    f.server.connected = true; const foreign = await f.provider.choose(); assert.equal(foreign.ok, false); assert.equal(f.server.connects, 0); assert.equal(f.server.disconnects, 0);
  } finally { f.server.connected = false; await f.close(); }
});
test('wrong native returned server is rejected and only the exact issued original server is cleaned', async () => {
  const f = fixture(), other = new Device(); f.server.other = other.gatt; other.gatt.connected = true;
  try { const chosen = await f.provider.choose(); assert.ok(chosen.ok); assert.equal((await f.provider.start(chosen.value, { purpose: 'wrong-server' })).ok, false); }
  finally { await f.close(); assert.equal(f.server.disconnects, 1); assert.equal(other.gatt.disconnects, 0); assert.equal(other.gatt.connected, true); }
});
test('wrong service/characteristic UUID, device relationship and notify properties fail closed', async () => {
  for (const kind of ['service', 'characteristic', 'device', 'primary', 'notify', 'properties'] as const) {
    const f = fixture(); try {
      if (kind === 'service') f.server.service.uuid = profile.characteristicUUID;
      if (kind === 'characteristic') f.characteristic.uuid = profile.serviceUUID;
      if (kind === 'device') Object.defineProperty(f.server.service, 'device', { value: new Device() });
      if (kind === 'primary') f.server.service.isPrimary = false;
      if (kind === 'notify') f.characteristic.properties.notify = false;
      if (kind === 'properties') Object.defineProperty(f.characteristic.properties, 'write', { value: 1 });
      const chosen = await f.provider.choose(); assert.ok(chosen.ok); assert.equal((await f.provider.start(chosen.value, { purpose: 'bad-native-shape' })).ok, false);
      assert.equal(f.characteristic.starts, 0);
    } finally { await f.close(); }
  }
});
test('malformed native DataView byte count/value and shadowed length retire held output without copying', async () => {
  for (const invalid of [[], [2], [1, 0], 'shadow'] as const) {
    const f = fixture(); try {
      await f.start(); f.characteristic.emit([1]); f.flush(); assert.equal(f.held(), true); f.advance();
      if (invalid === 'shadow') { const view = new DataView(new ArrayBuffer(4096)); Object.defineProperty(view, 'byteLength', { value: 1 });
        f.characteristic.value = view; f.characteristic.dispatchEvent(new Event('characteristicvaluechanged')); }
      else f.characteristic.emit([...invalid]);
      assert.equal(f.held(), false); assert.equal(f.provider.snapshot().activeSources, 0);
    } finally { await f.close(); }
  }
});
test('late selection retains its true Promise and close is prepublished/idempotent', async () => {
  const f = fixture(), gate = held<NativeBleSwitchDevice>(); f.manager.wait = gate.promise;
  try {
    const chosen = f.provider.choose(); f.provider.stop(); const closed = f.provider.close(); assert.equal(closed, f.provider.close());
    let settled = false; void closed.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
    assert.equal((await f.provider.choose()).ok, false); gate.resolve(f.device); assert.equal((await chosen).ok, false); await closed;
    assert.equal(f.server.connects, 0); assert.equal(f.server.disconnects, 0);
  } finally { gate.resolve(f.device); await f.close(); }
});
test('late owned connect then disconnect Promise keep close reserved until both settle', async () => {
  const f = fixture(), open = held<void>(), close = held<void>(); f.server.connectWait = open.promise; f.server.disconnectWait = close.promise;
  try {
    const chosen = await f.provider.choose(); assert.ok(chosen.ok); const start = f.provider.start(chosen.value, { purpose: 'late-connect' }); await reached(() => f.server.connects === 1);
    f.provider.stop(); let settled = false; const closing = f.provider.close(); void closing.then(() => { settled = true; });
    open.resolve(); assert.equal((await start).ok, false); await reached(() => f.server.disconnects === 1); assert.equal(settled, false);
    assert.equal(f.characteristic.starts, 0); close.resolve(); await closing; assert.equal(f.server.connected, false);
  } finally { open.resolve(); close.resolve(); await f.close(); }
});
test('late service and characteristic discovery cannot notify and retain owned cleanup', async () => {
  for (const phase of ['service', 'characteristic'] as const) {
    const f = fixture(), gate = held<void>(); if (phase === 'service') f.server.serviceWait = gate.promise; else f.server.service.wait = gate.promise;
    try {
      const chosen = await f.provider.choose(); assert.ok(chosen.ok); const start = f.provider.start(chosen.value, { purpose: 'late-discovery' });
      await reached(() => phase === 'service' ? f.server.services === 1 : f.server.service.calls === 1); f.provider.stop();
      let settled = false; const closing = f.provider.close(); void closing.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
      gate.resolve(); assert.equal((await start).ok, false); await closing; assert.equal(f.characteristic.starts, 0); assert.equal(f.server.disconnects, 1);
    } finally { gate.resolve(); await f.close(); }
  }
});
test('late startNotifications requires its settlement before owned stopNotifications and disconnect', async () => {
  const f = fixture(), startGate = held<void>(), stopGate = held<void>(); f.characteristic.startWait = startGate.promise; f.characteristic.stopWait = stopGate.promise;
  try {
    const chosen = await f.provider.choose(); assert.ok(chosen.ok); const start = f.provider.start(chosen.value, { purpose: 'late-notify' }); await reached(() => f.characteristic.starts === 1);
    f.provider.stop(); const closing = f.provider.close(); let settled = false; void closing.then(() => { settled = true; });
    assert.equal(f.characteristic.stops, 0); startGate.resolve(); await reached(() => f.characteristic.stops === 1); assert.equal(settled, false); assert.equal(f.server.disconnects, 0);
    stopGate.resolve(); assert.equal((await start).ok, false); await closing; assert.equal(f.server.disconnects, 1); assert.equal(f.characteristic.notifying, false);
  } finally { startGate.resolve(); stopGate.resolve(); await f.close(); }
});
test('a reentrant capture observer cannot issue connect after Stop', async () => {
  const f: ReturnType<typeof fixture> = fixture({ authorizeCapture(request) { f.provider.stop(); return { request, signal: f.capture().signal, expiresAt: 1100 }; } });
  try { const chosen = await f.provider.choose(); assert.ok(chosen.ok); assert.equal((await f.provider.start(chosen.value, { purpose: 'reentry' })).ok, false); assert.equal(f.server.connects, 0); }
  finally { await f.close(); }
});
test('a synchronous native connect reentry closes only its late owned connection', async () => {
  const f = fixture(); f.server.beforeConnect = () => { void f.provider.close(); };
  try { const chosen = await f.provider.choose(); assert.ok(chosen.ok); assert.equal((await f.provider.start(chosen.value, { purpose: 'native-reentry' })).ok, false); }
  finally { await f.close(); assert.equal(f.server.connects, 1); assert.equal(f.server.disconnects, 1); assert.equal(f.characteristic.starts, 0); }
});
test('intrinsic signal revocation from the final clock and shadowed aborted getters cannot publish', async () => {
  const f = fixture(); try {
    await f.start(); Object.defineProperty(f.capture().signal, 'aborted', { value: false }); f.setClockCallback(() => f.capture().abort());
    f.characteristic.emit([1]); f.flush(); assert.equal(f.observations.length, 0); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});
test('native notification getter Stop releases current state and cannot publish its late byte', async () => {
  const f = fixture(); try {
    await f.start(); f.characteristic.emit([1]); f.flush(); f.advance(); const value = new DataView(Uint8Array.of(0).buffer);
    Object.defineProperty(f.characteristic, 'value', { get() { f.provider.stop(); return value; } });
    f.characteristic.dispatchEvent(new Event('characteristicvaluechanged')); f.flush(); assert.equal(f.observations.length, 1); assert.equal(f.held(), false);
  } finally { await f.close(); }
});
test('failed owned stopNotifications still disconnects and permanently quarantines the provider', async () => {
  const f = fixture(); try { await f.start(); f.characteristic.stopFailure = true; f.provider.stop(); await f.provider.close();
    assert.equal(f.server.disconnects, 1); assert.equal(f.server.connected, false); assert.equal(f.provider.snapshot().cleanupFailed, true); assert.equal((await f.provider.choose()).ok, false);
  } finally { await f.close(); }
});
test('20Hz burst and malformed monotonic clocks retire bounded source work', async () => {
  const f = fixture(); try { await f.start(); for (let frame = 0; frame < 5; frame++) f.characteristic.emit([frame % 2]);
    assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.provider.snapshot().reason, 'quota');
  } finally { await f.close(); }
  const invalid = fixture(); try { await invalid.start(); invalid.setTime(NaN); invalid.provider.sweep(); assert.equal(invalid.provider.snapshot().activeSources, 0); }
  finally { await invalid.close(); }
});
test('capture expiry and genuine disconnect require fresh explicit choice, generation and consent', async () => {
  const f = fixture(); try {
    const first = await f.start(); f.characteristic.emit([1]); f.flush(); f.server.connected = false; f.device.dispatchEvent(new Event('gattserverdisconnected'));
    assert.equal(f.held(), false); assert.equal(f.manager.calls, 1); await reached(() => f.provider.snapshot().rawPending === 0);
    f.freshCapture(); const second = await f.start(); assert.ok(second.connectionGeneration > first.connectionGeneration); assert.notEqual(second.source.id, first.source.id);
    f.setTime(1100); f.provider.sweep(); assert.equal(f.held(), false); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});
test('closed canonical profile fields and accessor-free options refuse malformed metadata before callouts', async () => {
  assert.ok(api); let getters = 0;
  const f = fixture(); try {
    assert.throws(() => api.createBrowserBleSwitchProvider({ runtime: f.runtime, ownerSignal: f.owner.signal, scope: f.scope,
      reviewedProfile: { ...profile, serviceUUID: '180f' }, now: () => 100, authorizeCapture: () => undefined }), TypeError);
    assert.throws(() => api.createBrowserBleSwitchProvider({ runtime: f.runtime, ownerSignal: f.owner.signal, scope: f.scope,
      reviewedProfile: profile, now: () => 100, get authorizeCapture() { getters++; return () => undefined; } }), TypeError);
    assert.equal(getters, 0); assert.equal(f.manager.calls, 0);
  } finally { await f.close(); }
});
test('copied capture requests and callback-only or spoofed signals cannot connect', async () => {
  for (const kind of ['copy', 'missing', 'spoofed'] as const) {
    const f: ReturnType<typeof fixture> = fixture({ authorizeCapture(request) {
      if (kind === 'copy') return { request: { ...request }, expiresAt: 1100, signal: f.capture().signal };
      const candidate = { request, expiresAt: 1100, ...(kind === 'spoofed' ? { signal: { aborted: false } } : {}) };
      return candidate as unknown as ReturnType<BrowserBleSwitchOptions['authorizeCapture']>;
    } });
    try { const selected = await f.provider.choose(); assert.ok(selected.ok); assert.equal((await f.provider.start(selected.value, { purpose: 'invalid-authority' })).ok, false); assert.equal(f.server.connects, 0); }
    finally { await f.close(); }
  }
});
test('listener registration notification reentry retains cleanup before native selection', async () => {
  const f = fixture(); let attached = 0, removed = 0;
  const nativeAdd = f.target.addEventListener.bind(f.target), nativeRemove = f.target.removeEventListener.bind(f.target);
  f.target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => { nativeAdd(...args); attached++; void f.provider.close(); };
  f.target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => { nativeRemove(...args); removed++; };
  try { assert.equal((await f.provider.choose()).ok, false); await f.provider.close(); assert.ok(removed >= attached); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.manager.calls, 0); }
  finally { await f.close(); }
});

test('reentrant real route release close waits for subsequently issued owned disconnect', async () => {
  const f = fixture(), gate = held<void>(); let closed: Promise<void> | undefined, settled = false;
  f.server.disconnectWait = gate.promise;
  try {
    await f.start(); f.characteristic.emit([1]); f.flush();
    f.setReleaseCallback(() => { closed = f.provider.close(); void closed.then(() => { settled = true; }); });
    f.provider.stop(); await reached(() => f.server.disconnects === 1); await Promise.resolve();
    assert.ok(closed); assert.equal(settled, false); assert.equal(f.held(), false);
    gate.resolve(); await closed; assert.equal(f.server.connected, false);
  } finally { gate.resolve(); await f.close(); }
});
test('held discovery plus owned cleanup stays inside three raw tokens and two actual native calls', async () => {
  const f = fixture(), discovery = held<void>(), disconnect = held<void>(); f.server.serviceWait = discovery.promise; f.server.disconnectWait = disconnect.promise;
  try {
    const selected = await f.provider.choose(); assert.ok(selected.ok); const starting = f.provider.start(selected.value, { purpose: 'bounded-cleanup' });
    await reached(() => f.server.services === 1); f.provider.stop(); await reached(() => f.server.disconnects === 1);
    assert.ok(f.provider.snapshot().rawPending <= 3); assert.equal(f.provider.snapshot().nativePending, 2);
    discovery.resolve(); assert.equal((await starting).ok, false); disconnect.resolve(); await f.provider.close();
    assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.provider.snapshot().nativePending, 0);
  } finally { discovery.resolve(); disconnect.resolve(); await f.close(); }
});

test('native-shaped IDL/prototype GATT and property getters remain usable', async () => {
  const f = fixture();
  const prototype = Object.create(null);
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(prototype, key, { get: () => value });
  const actual = Object.create(prototype);
  Object.defineProperties(f.characteristic, { properties: { get: () => actual }, service: { get: () => f.server.service }, uuid: { get: () => profile.characteristicUUID } });
  Object.defineProperties(f.server.service, { device: { get: () => f.device }, uuid: { get: () => profile.serviceUUID }, isPrimary: { get: () => true } });
  Object.defineProperty(f.device, 'gatt', { get: () => f.server });
  try { await f.start(); f.characteristic.emit([1]); f.flush(); assert.equal(f.held(), true); }
  finally { await f.close(); }
});
test('the 600-notification capture ceiling retires the next byte within the original 30s grant', async () => {
  const f = fixture(); f.setUntil(30100);
  try {
    await f.start(); for (let row = 0; row < 600; row++) { if (row) f.advance(); f.characteristic.emit([row % 2]); f.flush(); }
    assert.equal(f.observations.length, 600); assert.equal(f.provider.snapshot().frames, 600);
    f.characteristic.emit([0]); f.flush(); assert.equal(f.provider.snapshot().reason, 'quota'); assert.equal(f.held(), false);
  } finally { await f.close(); }
});
test('64 lifetime selection attempts remain finite and never dispatch a 65th chooser', async () => {
  const f = fixture(); try {
    for (let attempt = 0; attempt < 64; attempt++) { const choice = await f.provider.choose(); assert.ok(choice.ok); f.provider.stop(); }
    const next = await f.provider.choose(); assert.equal(next.ok, false); if (!next.ok) assert.equal(next.reason, 'quota');
    assert.equal(f.manager.calls, 64); assert.equal(f.server.connects, 0);
  } finally { await f.close(); }
});
test('virtual logical timeout retains actual connect and late cleanup until their promises settle', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), opening = held<void>(), closing = held<void>(); f.server.connectWait = opening.promise; f.server.disconnectWait = closing.promise;
  try {
    const selected = await f.provider.choose(); assert.ok(selected.ok); const start = f.provider.start(selected.value, { purpose: 'logical-timeout' });
    await reached(() => f.server.connects === 1); context.mock.timers.tick(5000);
    const result = await start; assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'timeout');
    assert.equal(f.provider.snapshot().nativePending, 1); let done = false; const close = f.provider.close(); void close.then(() => { done = true; });
    opening.resolve(); await reached(() => f.server.disconnects === 1); assert.equal(done, false); closing.resolve(); await close;
    assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.server.connected, false);
  } finally { opening.resolve(); closing.resolve(); await f.close(); context.mock.timers.reset(); }
});
