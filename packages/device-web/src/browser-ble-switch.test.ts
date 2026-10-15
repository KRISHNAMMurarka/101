import { createBrowserBleSwitchOutputCaller } from '../../../examples/browser-resources/ble-switch-output.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation, Connection, DeliveryContext } from '@101/connect';
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

// The output tests use genuine public reliable routes and native-shaped cooperative
// software GATT. They do not certify a peripheral, ATT acknowledgement or state.
function outputFixture(change: Partial<BrowserBleSwitchOptions> = {}) {
  assert.ok(api); let at = 1000, end = 31000, outputCalls = 0, routeAllowed = true, operation = 0;
  let beforeClock: (() => void) | undefined, beforeWrite: (() => void) | undefined, writeWait: Promise<void> | undefined, rejectWrite = false;
  const owner = new AbortController(), capture = new AbortController(), output = new AbortController();
  const device = new Device(), manager = new Manager(device), target = new EventTarget(), document = new EventTarget();
  const characteristic = device.gatt.service.characteristic; characteristic.properties.write = true;
  const written: number[][] = [], observations: Observation[] = [], scope = { principalId: 'ble-output-owner', applicationId: 'ble-output-example', sessionId: 'ble-output-session' };
  const writer = async (value: BufferSource) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    written.push([...bytes]); beforeWrite?.(); await writeWait; if (rejectWrite) throw Error('private-software-write-failure');
  };
  Object.defineProperty(characteristic, 'writeValueWithResponse', { configurable: true, writable: true, value: writer });
  const routes = new Map<string, Connection>(); let connection: Connection | undefined, command: ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']> | undefined;
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'ble-output-host-emission', maxPendingDeliveries: 2,
    authorize(request) {
      if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId) return;
      if (request.sourceOperation === 'subscribe' && request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 100, maxHz: 20 };
      if (routeAllowed && request.sourceOperation === 'subscribe' && request.source.capabilityId === 'switch-setting' && request.sink.capabilityId === 'switch-setting' && request.sinkOperation === 'invoke') return { expiresAt: routeEnd, maxAgeMs: 100, maxHz: 2 };
    } });
  let routeEnd = end;
  const provider = api.createBrowserBleSwitchProvider({ runtime, now: () => { beforeClock?.(); return at; }, ownerSignal: owner.signal, scope,
    reviewedProfile: { ...profile, writeFormat: 'boolean-byte/1' },
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: end }; },
    authorizeOutput(request) { outputCalls++; return { request, signal: output.signal, expiresAt: end }; },
    outputDeliveryLimits(context) {
      const route = routes.get(context.routeId), limits = route?.limits(), record = route?.operations().find(row => row.id === context.operationId && row.handlerResult === 'running');
      if (!route || route !== connection || !limits || !record) return;
      return { context, expiresAt: Math.min(limits.expiresAt, record.deadline), maxAgeMs: Math.min(limits.maxAgeMs, 100), maxHz: Math.min(limits.maxHz, 2) };
    },
    environment: { bluetooth: manager, target, document, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' }, ...change });
  async function start() {
    const selected = await provider.choose(); assert.ok(selected.ok); const started = await provider.start(selected.value, { purpose: 'reviewed-software-switch-capture' }); assert.ok(started.ok);
    const sinkDevice = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':local-display', capabilities: started.value.device.capabilities.map(row => ({ ...row, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'switch', apply(observation, context) { if (context.isCurrent()) observations.push(observation); }, release() {} }); runtime.setReadiness(sink, 'available');
    const route = runtime.route({ ...scope, from: started.value.source, to: sink, leaseMs: 30000, queueCapacity: 8 }); assert.ok(route.start().ok); routes.set(route.id, route);
    return started.value;
  }
  function bind(active: BrowserBleSwitchActivation) {
    const result = provider.bindOutput(active, { purpose: 'reviewed-software-switch-setting' }); if (!result.ok) return result;
    const sourceDevice = parseDeviceDescriptor({ ...result.value.device, id: result.value.device.id + ':commands', capabilities: result.value.device.capabilities.map(row => ({ ...row, kind: 'event', permissions: ['subscribe'] })) });
    command = runtime.registerSource({ device: sourceDevice, capability: 'switch-setting' }); runtime.setReadiness(command, 'available');
    connection = runtime.route({ ...scope, from: command, to: result.value.sink, leaseMs: Math.max(1, Math.floor(Math.min(30000, routeEnd - at))), queueCapacity: 1 }); routes.set(connection.id, connection);
    return { result, started: connection.start() };
  }
  function send(value: unknown, deadline = at + 100) { assert.ok(command); const result = runtime.publish(command, value, { timestamp: at, clockDomain: runtime.clockDomain, operationId: String(++operation), deadline }); runtime.flush(); return result; }
  return { owner, capture, output, device, server: device.gatt, characteristic, manager, provider, runtime, scope, routes, observations, written, writer, start, bind, send,
    outputCalls: () => outputCalls, connection: () => connection, denyRoute() { routeAllowed = false; }, setRouteEnd(value: number) { routeEnd = value; }, setEnd(value: number) { end = value; },
    setTime(value: number) { at = value; }, advance(value = 500) { at += value; }, setClock(callback: () => void) { beforeClock = callback; }, setWrite(callback: () => void) { beforeWrite = callback; },
    holdWrite(value: Promise<void> | undefined) { writeWait = value; }, rejectWrite() { rejectWrite = true; },
    async close() { owner.abort(); await provider.close(); runtime.close(); } };
}

test('BLE output feature defaults deny and preserves a notification-only incumbent', async () => {
  const f = outputFixture({ reviewedProfile: profile }); try {
    assert.equal(f.written.length, 0); const active = await f.start(); const report = f.provider.inspectOutput(active); assert.ok(report.ok); assert.equal(report.value.support, 'unsupported');
    const bound = f.provider.bindOutput(active, { purpose: 'no-reviewed-write' }); assert.equal(bound.ok, false); assert.equal(f.outputCalls(), 0);
    f.characteristic.emit([1]); f.runtime.flush(); assert.equal(f.observations.length, 1); assert.equal(f.provider.snapshot().activeSources, 1);
  } finally { await f.close(); }
  const denied = outputFixture({ authorizeOutput: undefined }); try { const active = await denied.start(); assert.equal(denied.provider.bindOutput(active, { purpose: 'default-deny' }).ok, false); assert.equal(denied.provider.snapshot().activeSources, 1); assert.equal(denied.written.length, 0); }
  finally { await denied.close(); }
});
test('BLE write requires current write property and exact response method without fallback', async () => {
  for (const kind of ['property', 'method'] as const) {
    const f = outputFixture(); try { const active = await f.start(); if (kind === 'property') f.characteristic.properties.write = false; else Object.defineProperty(f.characteristic, 'writeValueWithResponse', { value: undefined });
      const result = f.provider.bindOutput(active, { purpose: 'unsupported-write' }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'unsupported'); assert.equal(f.written.length, 0); assert.equal(f.outputCalls(), 0); assert.equal(f.provider.snapshot().activeSources, 1);
    } finally { await f.close(); }
  }
});
test('only exact current issued BLE activations can inspect or bind output', async () => {
  const f = outputFixture(), other = outputFixture(); try {
    const active = await f.start(), foreign = await other.start();
    for (const invalid of [{}, { ...active }, foreign]) { assert.equal(f.provider.inspectOutput(invalid as BrowserBleSwitchActivation).ok, false); assert.equal(f.provider.bindOutput(invalid as BrowserBleSwitchActivation, { purpose: 'not-issued' }).ok, false); }
    assert.equal(f.outputCalls(), 0); f.provider.stop(); assert.equal(f.provider.bindOutput(active, { purpose: 'stale' }).ok, false); assert.equal(f.written.length, 0);
  } finally { await f.close(); await other.close(); }
});
test('copied, foreign, expired, widened and accessor output grants never register a command sink', async () => {
  for (const kind of ['request', 'signal', 'expired', 'widened', 'extra', 'getter'] as const) {
    let getters = 0; const f: ReturnType<typeof outputFixture> = outputFixture({ authorizeOutput(request) {
      if (kind === 'request') return { request: { ...request }, signal: f.output.signal, expiresAt: 31000 };
      if (kind === 'signal') return { request, signal: { aborted: false } as AbortSignal, expiresAt: 31000 };
      if (kind === 'expired') return { request, signal: f.output.signal, expiresAt: 1000 };
      if (kind === 'widened') return { request, signal: f.output.signal, expiresAt: 31001 };
      if (kind === 'extra') return { request, signal: f.output.signal, expiresAt: 31000, credential: 'not-an-allowed-field' } as ReturnType<NonNullable<BrowserBleSwitchOptions['authorizeOutput']>>;
      return { request, get signal() { getters++; return f.output.signal; }, expiresAt: 31000 };
    } });
    try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'strict-output-review' }).ok, false); assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.written.length, 0); assert.equal(getters, 0); }
    finally { await f.close(); }
  }
});
test('genuine reliable BLE commands emit exactly owned 0/1 bytes with api-returned evidence only', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    assert.ok(f.send(false).ok); await reached(() => f.provider.outputStatus().rawPending === 0); f.advance(); assert.ok(f.send(true).ok); await reached(() => f.provider.outputStatus().rawPending === 0);
    assert.deepEqual(f.written, [[0], [1]]); assert.equal(f.observations.length, 0); const rows = f.provider.outputStatus().records;
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.outcome === 'api-returned' && row.effect === 'dispatched' && row.physical === 'unverified'));
    assert.ok(f.connection()!.operations().every(row => row.effectEvidence !== 'observed' && row.effectEvidence !== 'target-acknowledged'));
    f.characteristic.emit([1]); f.runtime.flush(); assert.equal(f.observations.length, 1); assert.equal(f.observations[0]!.provenance?.captureTimeKnown, false);
    assert.equal(f.provider.outputStatus().records[1]!.outcome, 'api-returned');
  } finally { await f.close(); }
});
test('output capture approval cannot bypass a separately denied invoke route or invalid boolean schema', async () => {
  const denied = outputFixture(); try { const active = await denied.start(); denied.denyRoute(); const bound = denied.bind(active); assert.ok('started' in bound && !bound.started.ok); assert.equal(denied.written.length, 0); }
  finally { await denied.close(); }
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    for (const invalid of [0, 'true', { active: true }, new Uint8Array(2048)]) assert.equal(f.send(invalid).ok, false); assert.equal(f.written.length, 0);
  } finally { await f.close(); }
});
test('BLE output delivery bounds are default deny and exact-context closed snapshots', async () => {
  for (const kind of ['absent', 'copy', 'extra', 'getter'] as const) {
    let getter = 0; const f = outputFixture({ outputDeliveryLimits: kind === 'absent' ? undefined : context => {
      const base = { context, expiresAt: 1100, maxAgeMs: 100, maxHz: 2 };
      if (kind === 'copy') return { ...base, context: { ...context } };
      if (kind === 'extra') return { ...base, arbitrary: true } as typeof base;
      return { ...base, get maxAgeMs() { getter++; return 100; } };
    } });
    try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await reached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0); assert.equal(getter, 0); }
    finally { await f.close(); }
  }
});
test('BLE final issuance honors narrower real route and reliable operation deadlines after clock callouts', async () => {
  for (const scope of ['route', 'operation'] as const) {
    const f = outputFixture(); let arm = false; try { const active = await f.start(); if (scope === 'route') f.setRouteEnd(1025); const bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
      Object.defineProperty(f.characteristic, 'writeValueWithResponse', { configurable: true, get() { arm = true; return f.writer; } }); f.setClock(() => { if (arm) f.setTime(1040); });
      f.send(true, scope === 'operation' ? 1025 : 1100); await reached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0);
    } finally { await f.close(); }
  }
});
test('BLE final current observer cannot move capture expiry behind the issuance clock fence', async () => {
  const f = outputFixture(); f.setEnd(2000); const actual = f.runtime.registerSink.bind(f.runtime); let calls = 0;
  f.runtime.registerSink = provider => actual({ ...provider, apply(observation, context) {
    if (provider.capability !== 'switch-setting') return provider.apply(observation, context);
    const current: DeliveryContext = Object.freeze({ ...context, isCurrent() { const valid = context.isCurrent(); if (++calls >= 2) f.setTime(2000); return valid; } });
    return provider.apply(observation, current);
  } });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await reached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0); assert.ok(calls >= 2); }
  finally { await f.close(); }
});
test('intrinsic output abort and method getter Stop cannot dispatch through shadows or reentry', async () => {
  for (const kind of ['abort', 'method'] as const) {
    const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
      if (kind === 'abort') { Object.defineProperty(f.output.signal, 'aborted', { value: false }); f.setClock(() => f.output.abort()); }
      else Object.defineProperty(f.characteristic, 'writeValueWithResponse', { get() { f.provider.stop(); return f.writer; } });
      f.send(true); await reached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0);
    } finally { await f.close(); }
  }
});
test('output authorizer reentry and late genuine command endpoint return cannot orphan a sink', async () => {
  const author: ReturnType<typeof outputFixture> = outputFixture({ authorizeOutput(request) { author.provider.stop(); return { request, signal: author.output.signal, expiresAt: 31000 }; } });
  try { const active = await author.start(); assert.equal(author.provider.bindOutput(active, { purpose: 'reentrant-review' }).ok, false); assert.equal(author.provider.outputStatus().activeSinks, 0); }
  finally { await author.close(); }
  const f = outputFixture(); const register = f.runtime.registerSink.bind(f.runtime); let returned: ReturnType<typeof register> | undefined;
  f.runtime.registerSink = provider => { const handle = register(provider); if (provider.capability === 'switch-setting') { returned = handle; f.provider.stop(); } return handle; };
  try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'late-registration' }).ok, false); assert.ok(returned); assert.equal(f.runtime.setReadiness(returned, 'available').ok, false); assert.equal(f.provider.outputStatus().activeSinks, 0); }
  finally { await f.close(); }
});
test('held actual BLE write survives Stop and keeps close reserved before owned notification cleanup', async () => {
  const f = outputFixture(), write = held<void>(), disconnect = held<void>(); f.holdWrite(write.promise); f.server.disconnectWait = disconnect.promise;
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await reached(() => f.written.length === 1);
    f.provider.stop(); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.characteristic.stops, 0); assert.equal(f.server.disconnects, 0);
    let done = false; const close = f.provider.close(); assert.equal(close, f.provider.close()); void close.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
    assert.ok(f.provider.snapshot().rawPending > 0 && f.provider.snapshot().rawPending <= 3); assert.equal((await f.provider.choose()).ok, false);
    write.resolve(); await reached(() => f.server.disconnects === 1); assert.equal(done, false); disconnect.resolve(); await close;
    assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.provider.snapshot().nativePending, 0); assert.equal(f.provider.outputStatus().records[0]!.outcome, 'uncertain'); assert.deepEqual(f.written, [[1]]);
  } finally { write.resolve(); disconnect.resolve(); await f.close(); }
});
test('synchronous write factory close waits for its late returned actual promise', async () => {
  const f = outputFixture(), gate = held<void>(); f.holdWrite(gate.promise); let close: Promise<void> | undefined, settled = false;
  f.setWrite(() => { close = f.provider.close(); void close.then(() => { settled = true; }); });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await reached(() => f.written.length === 1); await Promise.resolve(); assert.ok(close); assert.equal(settled, false); assert.equal(f.server.disconnects, 0);
    gate.resolve(); await close; assert.equal(f.server.disconnects, 1); assert.equal(f.provider.snapshot().rawPending, 0);
  } finally { gate.resolve(); await f.close(); }
});
test('logical BLE operation expiry never releases a held write raw slot or permits automatic reset', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const f = outputFixture(), gate = held<void>(); f.holdWrite(gate.promise);
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true, 1025); await reached(() => f.written.length === 1);
    f.setTime(1025); context.mock.timers.tick(25); assert.equal(f.provider.outputStatus().records[0]!.outcome, 'uncertain'); assert.ok(f.provider.snapshot().rawPending > 0); assert.deepEqual(f.written, [[1]]);
    let done = false; const close = f.provider.close(); void close.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false); gate.resolve(); await close; assert.equal(f.provider.snapshot().rawPending, 0);
  } finally { gate.resolve(); await f.close(); context.mock.timers.reset(); }
});
test('output-only expiry retires its idle sink but preserves an independently current notification capture', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const f: ReturnType<typeof outputFixture> = outputFixture({ authorizeOutput(request) { return { request, signal: f.output.signal, expiresAt: 1500 }; } });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.setTime(1500); context.mock.timers.tick(500);
    assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.written.length, 0); f.characteristic.emit([1]); f.runtime.flush(); assert.equal(f.observations.length, 1);
  } finally { await f.close(); context.mock.timers.reset(); }
});
test('write properties changing after binding refuse commands without inferring read-only write support', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.characteristic.properties.write = false; f.send(true); await reached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0); assert.equal(f.provider.outputStatus().activeSinks, 0); }
  finally { await f.close(); }
});
test('rejected response promise records issued failure without a fabricated observed state', async () => {
  const f = outputFixture(); f.rejectWrite(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await reached(() => f.provider.outputStatus().rawPending === 0);
    assert.equal(f.provider.outputStatus().records[0]!.outcome, 'api-rejected'); assert.equal(f.provider.outputStatus().records[0]!.effect, 'dispatched'); assert.equal(f.observations.length, 0);
  } finally { await f.close(); }
});
test('output attempt/rate/history limits stay finite inside the original capture lifetime', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    for (let row = 0; row < 31; row++) { if (row) f.advance(); f.send(row % 2 === 1); await reached(() => f.provider.outputStatus().rawPending === 0); }
    assert.equal(f.written.length, 31); assert.equal(f.provider.outputStatus().attempts, 32); assert.equal(f.provider.outputStatus().records.length, 16); f.advance(); f.send(true); assert.equal(f.written.length, 31);
  } finally { await f.close(); }
  const rate = outputFixture(); try { const active = await rate.start(), bound = rate.bind(active); assert.ok('started' in bound && bound.started.ok); rate.send(true); await reached(() => rate.provider.outputStatus().rawPending === 0); rate.send(false); await reached(() => rate.provider.outputStatus().rawPending === 0); assert.equal(rate.written.length, 1); }
  finally { await rate.close(); }
});

// Actual public caller + existing native-shaped software fixture. A user clock
// failure is injected only at the direct caller callback after genuine binding;
// provider/runtime calls remain unchanged and no hardware is accessed.
for (const site of ['connectOutput', 'set'] as const) {
  test(`public ble output caller retires provisional state after clock failure in ${site}`, async context => {
    const owner = new AbortController(), capture = new AbortController(), output = new AbortController();
    const target = new EventTarget(), document = new EventTarget(); let writes = 0, failing = false, witnessed = false;
    const device = new Device(), manager = new Manager(device), characteristic = device.gatt.service.characteristic;
    characteristic.properties.write = true;
    Object.defineProperty(characteristic, 'writeValueWithResponse', { value: async () => { writes++; } });
    const reviewedProfile = { ...profile, writeFormat: 'boolean-byte/1' as const };
    const caller = createBrowserBleSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile,
      now() {
        const directCaller = new Error().stack?.split('\n')[2] ?? '';
        if (failing && directCaller.includes(`Object.${site} `)) {
          const state = caller.state(); witnessed = state.provider.activeSources === 1 && state.output.activeSinks === 1;
          context.diagnostic(JSON.stringify({ site, directCaller, captureSources: state.provider.activeSources, outputSinks: state.output.activeSinks, nativeWrites: writes }));
          throw Error('owned-caller-clock-failure');
        } return 1000;
      },
      environment: { bluetooth: manager, target, document, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' },
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
      for (let turn = 0; turn < 256 && (caller.state().provider.rawPending || caller.state().provider.cleanupPending); turn++) await Promise.resolve();
      assert.equal(caller.state().provider.nativePending, 0); assert.equal(caller.state().provider.rawPending, 0); assert.equal(caller.state().provider.cleanupPending, 0);
      const retry = await caller.activate('fresh-software-clock-recovery');
      if (!retry.ok) context.diagnostic(JSON.stringify({ retry, state: caller.state(), connected: device.gatt.connected, starts: characteristic.starts, stops: characteristic.stops, disconnects: device.gatt.disconnects }));
      assert.ok(retry.ok);
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
  test(shape + ' BLE callback failure releases held input', async () => {
    const f = fixture(), error = switchHostFailure(shape);
    let guarded: EventListener | undefined, escaped = false;
    try {
      await f.start(); f.characteristic.emit([1]); f.flush(); assert.equal(f.held(), true); f.advance();
      const callbacks = getEventListeners(f.characteristic, 'characteristicvaluechanged') as EventListener[];
      assert.equal(callbacks.length, 1); const callback = callbacks[0]!;
      // Keep real Event.target branding while containing an old callback escape.
      // Only the software boundary is wrapped; the actual provider callback runs.
      f.characteristic.removeEventListener('characteristicvaluechanged', callback);
      guarded = event => { try { callback.call(f.characteristic, event); } catch { escaped = true; } };
      f.characteristic.addEventListener('characteristicvaluechanged', guarded);
      Object.defineProperty(f.characteristic, 'value', { configurable: true, get() { throw error; } });
      f.characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
      assert.equal(f.held(), false, 'An unreadable host error must release the actual sink');
      assert.ok(f.releases() > 0); assert.equal(f.provider.snapshot().activeSources, 0);
      assert.equal(f.provider.snapshot().reason, expected); assert.equal(escaped, false);
      const delivered = f.observations.length;
      f.characteristic.dispatchEvent(new Event('characteristicvaluechanged')); f.flush();
      assert.equal(f.held(), false); assert.equal(f.observations.length, delivered);
    } finally {
      if (guarded) f.characteristic.removeEventListener('characteristicvaluechanged', guarded);
      delete f.characteristic.value; await f.close();
    }
    assert.equal(f.characteristic.stops, 1); assert.equal(f.server.disconnects, 1);
  });
}
