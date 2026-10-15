import { createBrowserHidSwitchOutputCaller } from '../../../examples/browser-resources/hid-switch-output.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation, Connection, DeliveryContext } from '@101/connect';
import { createBrowserHidSwitchProvider } from './browser-hid-switch.ts';
import type { BrowserHidSwitchOptions, BrowserHidSwitchActivation, NativeHidSwitchDevice, NativeHidSwitchManager } from './browser-hid-switch.ts';

// Genuine EventTarget/DataView and actual public runtime, with explicitly
// software HID ports. This is neither native HID delivery nor hardware proof.
const profile = Object.freeze({ id: 'software:hid-switch-fixture/1', revision: 1,
  vendorId: 0x0101, productId: 1, usagePage: 0xff00, usage: 1, reportId: 1 });
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class SoftwareDevice extends EventTarget implements NativeHidSwitchDevice {
  readonly vendorId = profile.vendorId; readonly productId = profile.productId;
  opened = false; opens = 0; closes = 0; openWait?: Promise<void>; closeWait?: Promise<void>; beforeOpen?: () => void;
  collections: unknown = [{ usagePage: profile.usagePage, usage: profile.usage, children: [], inputReports: [{ reportId: 1, items: [{
    reportSize: 8, reportCount: 1, logicalMinimum: 0, logicalMaximum: 1,
    isAbsolute: true, isArray: false, isBufferedBytes: false, isConstant: false, isLinear: true,
    hasNull: false, wrap: false, unitExponent: 0, unitSystem: 'none', usages: [0xff000001],
  }] }], outputReports: [], featureReports: [] }];
  async open() { this.opens++; this.beforeOpen?.(); await this.openWait; this.opened = true; }
  async close() { this.closes++; await this.closeWait; this.opened = false; }
  report(bytes: number[], reportId = 1, device: object = this) {
    const event = new Event('inputreport'); Object.defineProperties(event, { device: { value: device }, reportId: { value: reportId },
      data: { value: new DataView(Uint8Array.from(bytes).buffer) } }); this.dispatchEvent(event);
  }
}
class SoftwareManager extends EventTarget implements NativeHidSwitchManager {
  calls = 0; devices: NativeHidSwitchDevice[]; choiceWait?: Promise<readonly NativeHidSwitchDevice[]>;
  constructor(device: SoftwareDevice) { super(); this.devices = [device]; }
  async requestDevice() { this.calls++; return await (this.choiceWait ?? Promise.resolve(this.devices)); }
  disconnect(device: object) { const event = new Event('disconnect'); Object.defineProperty(event, 'device', { value: device }); this.dispatchEvent(event); }
}
function fixture(change: Partial<BrowserHidSwitchOptions> = {}) {
  let at = 100, activation = true, allowRoutes = true, captureCalls = 0, heldValue = false, releases = 0;
  const device = new SoftwareDevice(), manager = new SoftwareManager(device), target = new EventTarget(), document = new EventTarget();
  const owner = new AbortController(), capture = new AbortController(), observations: Observation[] = [];
  const scope = { principalId: 'hid-owner', applicationId: 'hid-example', sessionId: 'hid-session' };
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'hid-javascript-receipt', maxPendingDeliveries: 1,
    authorize(request) {
      if (allowRoutes && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId &&
        request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write')
        return { expiresAt: 1100, maxAgeMs: 100, maxHz: 20 };
    } });
  const provider = createBrowserHidSwitchProvider({ runtime, ownerSignal: owner.signal, scope, reviewedProfile: profile, now: () => at,
    authorizeCapture(request) { captureCalls++; return { request, signal: capture.signal, expiresAt: 1100 }; },
    environment: { hid: manager, target, document, secureContext: () => true, userActivation: () => activation,
      hidden: () => false, focused: () => true, policy: () => 'allowed' }, ...change });
  function bind(active: BrowserHidSwitchActivation) {
    const sinkDevice = parseDeviceDescriptor({ ...active.device, id: active.device.id + ':consumer',
      capabilities: active.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'switch', apply(observation, context) {
      if (!context.isCurrent() || context.signal.aborted) return; observations.push(observation);
      heldValue = (observation.value as { active: boolean }).active;
    }, release() { heldValue = false; releases++; } }); runtime.setReadiness(sink, 'available');
    return runtime.route({ ...scope, from: active.source, to: sink, leaseMs: 1000, queueCapacity: 8 }).start();
  }
  async function start() { const chosen = await provider.choose(); assert.ok(chosen.ok); const active = await provider.start(chosen.value, { purpose: 'software-switch' });
    assert.ok(active.ok); assert.ok(bind(active.value).ok); return active.value; }
  return { device, manager, provider, runtime, target, document, owner, capture, observations, start, bind, scope,
    advance(value = 50) { at += value; }, time: () => at, setTime(value: number) { at = value; }, captureCalls: () => captureCalls,
    denyRoutes() { allowRoutes = false; }, noActivation() { activation = false; }, held: () => heldValue, releases: () => releases,
    flush() { runtime.flush(); }, async close() { owner.abort(); await provider.close(); runtime.close(); } };
}

test('construction is inert and selection requires actual explicit activation', async () => {
  const f = fixture(); try {
    assert.equal(f.manager.calls, 0); assert.equal(f.device.opens, 0); assert.equal(f.captureCalls(), 0); assert.equal(f.provider.snapshot().listeners, 0);
    f.noActivation(); const choice = await f.provider.choose(); assert.equal(choice.ok, false);
    if (!choice.ok) assert.equal(choice.reason, 'activation-required'); assert.equal(f.manager.calls, 0);
  } finally { await f.close(); }
});

test('selected software bytes use existing switch schema and independent real route grants', async () => {
  const f = fixture(); try {
    await f.start(); f.device.report([1]); f.flush(); assert.equal(f.held(), true);
    f.advance(); f.device.report([0]); f.flush(); assert.equal(f.held(), false);
    assert.deepEqual(f.observations.map(value => value.value), [{ channel: 'switch-0', active: true }, { channel: 'switch-0', active: false }]);
    assert.equal(f.observations[0]?.timestamp, 100); assert.equal(f.observations[0]?.clockDomain, 'hid-javascript-receipt');
    assert.equal(f.observations[0]?.provenance?.captureTimeKnown, false); assert.equal(f.observations[0]?.provenance?.clockMappingEstablished, false);
    f.provider.stop(); assert.ok(f.releases() > 0); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});

test('capture approval cannot create a denied resource route or sink effect', async () => {
  const f = fixture(); try {
    const choice = await f.provider.choose(); assert.ok(choice.ok); const active = await f.provider.start(choice.value, { purpose: 'no-route' }); assert.ok(active.ok);
    f.denyRoutes(); assert.equal(f.bind(active.value).ok, false); f.device.report([1]); f.flush();
    assert.equal(f.observations.length, 0); assert.equal(f.held(), false); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});

test('stale, forged and borrowed already-open selections cannot activate', async () => {
  const f = fixture(); try {
    assert.equal((await f.provider.start({}, { purpose: 'forged' })).ok, false);
    const first = await f.provider.choose(); assert.ok(first.ok); f.provider.stop();
    assert.equal((await f.provider.start(first.value, { purpose: 'stale' })).ok, false);
    f.device.opened = true; const borrowed = await f.provider.choose(); assert.equal(borrowed.ok, false);
    assert.equal(f.device.opens, 0); assert.equal(f.device.closes, 0);
  } finally { f.device.opened = false; await f.close(); }
});

test('invalid report identity, id, byte length and value retire real held state', async () => {
  for (const invalid of [[2], [], [1, 0], 'id', 'foreign'] as const) {
    const f = fixture(); try {
      await f.start(); f.device.report([1]); f.flush(); assert.equal(f.held(), true); f.advance();
      if (invalid === 'id') f.device.report([0], 2); else if (invalid === 'foreign') f.device.report([0], 1, {}); else f.device.report([...invalid]);
      assert.equal(f.held(), false); assert.equal(f.provider.snapshot().activeSources, 0);
    } finally { await f.close(); }
  }
});

test('Stop during chooser retains its issued reservation and discards the late native object', async () => {
  const f = fixture(), gate = held<readonly NativeHidSwitchDevice[]>(); f.manager.choiceWait = gate.promise;
  const choosing = f.provider.choose(); await Promise.resolve(); f.provider.stop();
  assert.equal((await f.provider.choose()).ok, false); assert.equal(f.manager.calls, 1);
  let closed = false; const close = f.provider.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  gate.resolve([f.device]); assert.equal((await choosing).ok, false); await close;
  assert.equal(f.device.opens, 0); assert.equal(f.device.closes, 0); await f.close();
});

test('late owned open is closed and its real close Promise retains the slot', async () => {
  const f = fixture(), opening = held<void>(), closing = held<void>(); f.device.openWait = opening.promise; f.device.closeWait = closing.promise;
  const choice = await f.provider.choose(); assert.ok(choice.ok); const start = f.provider.start(choice.value, { purpose: 'held-open' });
  for (let turn = 0; turn < 8 && f.device.opens === 0; turn++) await Promise.resolve(); assert.equal(f.device.opens, 1);
  f.provider.stop(); let finished = false; const close = f.provider.close(); assert.equal(close, f.provider.close()); void close.then(() => { finished = true; });
  opening.resolve(); await start; await Promise.resolve(); assert.equal(finished, false); assert.equal(f.device.closes, 1);
  closing.resolve(); await close; assert.equal(f.device.opened, false); assert.equal(f.provider.snapshot().nativePending, 0); await f.close();
});

test('reentrant capture approval Stop prevents the native open', async () => {
  const f: ReturnType<typeof fixture> = fixture({ authorizeCapture(request) { f.provider.stop(); return { request, signal: f.capture.signal, expiresAt: 1100 }; } });
  try { const choice = await f.provider.choose(); assert.ok(choice.ok); assert.equal((await f.provider.start(choice.value, { purpose: 'reentry' })).ok, false);
    assert.equal(f.device.opens, 0); assert.equal(f.provider.snapshot().activeSources, 0); } finally { await f.close(); }
});

test('intrinsic signal revocation, expiry, disconnect and invalid clock retire held state', async () => {
  for (const cause of ['capture', 'owner', 'expiry', 'disconnect', 'clock'] as const) {
    const f = fixture(); try {
      Object.defineProperty(f.capture.signal, 'addEventListener', { value() {} });
      Object.defineProperty(f.capture.signal, 'aborted', { value: false });
      await f.start(); f.device.report([1]); f.flush(); assert.equal(f.held(), true);
      if (cause === 'capture') f.capture.abort(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'expiry') { f.setTime(1100); f.provider.sweep(); }
      else if (cause === 'disconnect') f.manager.disconnect(f.device); else { f.setTime(99); f.device.report([0]); }
      assert.equal(f.held(), false); assert.equal(f.provider.snapshot().activeSources, 0);
    } finally { await f.close(); }
  }
});

test('changed native layout, excess reports and accessor review pins fail closed', async () => {
  const f = fixture(); try {
    await f.start(); f.device.collections = []; f.device.report([1]); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
  const invalid = fixture(); try { assert.throws(() => createBrowserHidSwitchProvider({ runtime: invalid.runtime, ownerSignal: invalid.owner.signal, scope: invalid.scope, now: invalid.time, authorizeCapture: () => undefined,
    reviewedProfile: Object.defineProperty({ ...profile }, 'reportId', { enumerable: true, get: () => 1 }) })); } finally { await invalid.close(); }
  const overflow = fixture(); try { await overflow.start(); for (let index = 0; index < 5; index++) overflow.device.report([index % 2]);
    assert.equal(overflow.provider.snapshot().activeSources, 0); assert.equal(overflow.observations.length, 0); } finally { await overflow.close(); }
});

test('an issued source returned after reentrant Stop is unregistered exactly once', async () => {
  let unregisters = 0;
  const base = fixture();
  const f: ReturnType<typeof fixture> = fixture({ runtime: { ...base.runtime,
    registerSource(value) { f.provider.stop(); return base.runtime.registerSource(value); },
    unregister(value) { unregisters++; return base.runtime.unregister(value); },
  } });
  try { const selected = await f.provider.choose(); assert.ok(selected.ok);
    assert.equal((await f.provider.start(selected.value, { purpose: 'late-returned-handle' })).ok, false);
    assert.equal(unregisters, 1); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); await base.close(); }
});

test('partial listener install after reentrant Stop is removed and cannot retain an owner', async () => {
  let installed = 0, removed = 0;
  const native = new EventTarget();
  const target = { addEventListener(name: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    f.provider.stop(); native.addEventListener(name, callback, options); installed++; throw new Error('trusted wrapper throws after installation');
  }, removeEventListener(name: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    removed++; native.removeEventListener(name, callback, options);
  } };
  const manager = new SoftwareManager(new SoftwareDevice());
  const f: ReturnType<typeof fixture> = fixture({ environment: { hid: manager, target, document: new EventTarget(), secureContext: () => true,
    userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' } });
  try { assert.equal((await f.provider.choose()).ok, false); assert.equal(installed, 1); assert.ok(removed >= 1);
    assert.equal(manager.calls, 0); assert.equal(f.provider.snapshot().listeners, 0);
    native.dispatchEvent(new Event('blur')); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});

test('request descriptor reentry cannot admit two held capture approvals for one selection', async context => {
  type Grant = Exclude<Awaited<ReturnType<BrowserHidSwitchOptions['authorizeCapture']>>, undefined>;
  const approvals: { request: Parameters<BrowserHidSwitchOptions['authorizeCapture']>[0]; resolve(value: Grant): void }[] = [];
  // Delegate unchanged native timers and retain their handles solely for failed
  // old-source cleanup: the overwritten logical timer must not outlive this test.
  const nativeSetTimeout = globalThis.setTimeout, timers = new Set<ReturnType<typeof setTimeout>>();
  context.mock.method(globalThis, 'setTimeout', (callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer = Reflect.apply(nativeSetTimeout, globalThis, [callback, delay]) as ReturnType<typeof setTimeout>; timers.add(timer); return timer;
  });
  const f = fixture({ authorizeCapture(request) { return new Promise<Grant>(resolve => { approvals.push({ request, resolve }); }); } });
  let nested: ReturnType<typeof f.provider.start> | undefined, outer: ReturnType<typeof f.provider.start> | undefined;
  try {
    const selected = await f.provider.choose(); assert.ok(selected.ok); const handle = selected.value;
    const request = new Proxy({ purpose: 'outer-descriptor-request' }, { getOwnPropertyDescriptor(target, key) {
      if (key === 'purpose' && !nested) nested = f.provider.start(handle, { purpose: 'nested-descriptor-request' });
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    outer = f.provider.start(handle, request);
    assert.equal(approvals.length, 1, 'descriptor reentry issued a second actual held authorizer job');
    assert.equal(f.provider.snapshot().nativePending, 1, 'the same selection must retain just one actual admission slot');
    assert.ok(nested); const refused = await nested; assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'busy');
  } finally {
    f.provider.stop();
    for (const approval of approvals) approval.resolve({ request: approval.request, signal: f.capture.signal, expiresAt: 1100 });
    await f.provider.close(); if (outer) await outer;
    // The old implementation can orphan the nested logical-result Promise, but
    // all issued held authorizers settle and true raw close completes here.
    for (const timer of timers) clearTimeout(timer); context.mock.restoreAll(); await f.close();
  }
});

// The output profile is a native-shaped SOFTWARE HID contract. The actual public
// runtime is responsible for routing; no HID packet or physical device is proved.
async function outputReached(predicate: () => boolean) { for (let turn = 0; turn < 256 && !predicate(); turn++) await Promise.resolve(); assert.ok(predicate(), 'issued cooperative work did not settle'); }
function outputFixture(change: Partial<BrowserHidSwitchOptions> = {}) {
  let at = 1000, end = 31000, routeEnd = 31000, outputCalls = 0, routeAllowed = true, operation = 0;
  let beforeClock: (() => void) | undefined, beforeWrite: (() => void) | undefined, writeWait: Promise<void> | undefined, rejectWrite = false;
  const owner = new AbortController(), capture = new AbortController(), output = new AbortController();
  const device = new SoftwareDevice(), manager = new SoftwareManager(device), target = new EventTarget(), document = new EventTarget();
  const declaration = { ...profile, output: { reportId: 2, format: 'boolean-byte/1' as const } };
  const selected = change.reviewedProfile ?? declaration;
  if (selected.output) {
    const rows = device.collections as { outputReports: unknown[]; inputReports: { items: object[] }[] }[];
    rows[0]!.outputReports = [{ reportId: selected.output.reportId, items: [{ ...rows[0]!.inputReports[0]!.items[0] }] }];
  }
  const written: { reportId: number; bytes: number[] }[] = [], observations: Observation[] = [];
  const scope = { principalId: 'hid-output-owner', applicationId: 'hid-output-example', sessionId: 'hid-output-session' };
  const writer = async (reportId: number, value: BufferSource) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    written.push({ reportId, bytes: [...bytes] }); beforeWrite?.(); await writeWait; if (rejectWrite) throw Error('private-software-report-failure');
  };
  Object.defineProperty(device, 'sendReport', { configurable: true, writable: true, value: writer });
  const routes = new Map<string, Connection>(); let connection: Connection | undefined, command: ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']> | undefined;
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'hid-output-host-emission', maxPendingDeliveries: 2,
    authorize(request) {
      if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId) return;
      if (request.sourceOperation === 'subscribe' && request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 100, maxHz: 20 };
      if (routeAllowed && request.sourceOperation === 'subscribe' && request.source.capabilityId === 'switch-setting' && request.sink.capabilityId === 'switch-setting' && request.sinkOperation === 'invoke') return { expiresAt: routeEnd, maxAgeMs: 100, maxHz: 2 };
    } });
  const provider = createBrowserHidSwitchProvider({ runtime, now: () => { beforeClock?.(); return at; }, ownerSignal: owner.signal, scope,
    reviewedProfile: selected, authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: end }; },
    authorizeOutput(request) { outputCalls++; return { request, signal: output.signal, expiresAt: end }; },
    outputDeliveryLimits(context) {
      const route = routes.get(context.routeId), limits = route?.limits(), record = route?.operations().find(row => row.id === context.operationId && row.handlerResult === 'running');
      if (!route || route !== connection || !limits || !record) return;
      return { context, expiresAt: Math.min(limits.expiresAt, record.deadline), maxAgeMs: Math.min(limits.maxAgeMs, 100), maxHz: Math.min(limits.maxHz, 2) };
    }, environment: { hid: manager, target, document, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' }, ...change });
  async function start() {
    const selected = await provider.choose(); assert.ok(selected.ok); const started = await provider.start(selected.value, { purpose: 'reviewed-software-hid-capture' }); assert.ok(started.ok);
    const sinkDevice = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':local-display', capabilities: started.value.device.capabilities.map(row => ({ ...row, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'switch', apply(observation, context) { if (context.isCurrent()) observations.push(observation); }, release() {} }); runtime.setReadiness(sink, 'available');
    const route = runtime.route({ ...scope, from: started.value.source, to: sink, leaseMs: 30000, queueCapacity: 8 }); assert.ok(route.start().ok); routes.set(route.id, route);
    return started.value;
  }
  function bind(active: BrowserHidSwitchActivation) {
    const result = provider.bindOutput(active, { purpose: 'reviewed-software-hid-setting' }); if (!result.ok) return result;
    const sourceDevice = parseDeviceDescriptor({ ...result.value.device, id: result.value.device.id + ':commands', capabilities: result.value.device.capabilities.map(row => ({ ...row, kind: 'event', permissions: ['subscribe'] })) });
    command = runtime.registerSource({ device: sourceDevice, capability: 'switch-setting' }); runtime.setReadiness(command, 'available');
    connection = runtime.route({ ...scope, from: command, to: result.value.sink, leaseMs: Math.max(1, Math.floor(Math.min(30000, routeEnd - at))), queueCapacity: 1 }); routes.set(connection.id, connection);
    return { result, started: connection.start() };
  }
  function send(value: unknown, deadline = at + 100) { assert.ok(command); const result = runtime.publish(command, value, { timestamp: at, clockDomain: runtime.clockDomain, operationId: String(++operation), deadline }); runtime.flush(); return result; }
  return { owner, capture, output, device, manager, provider, runtime, scope, routes, observations, written, writer, start, bind, send,
    outputCalls: () => outputCalls, connection: () => connection, denyRoute() { routeAllowed = false; }, setRouteEnd(value: number) { routeEnd = value; }, setEnd(value: number) { end = value; },
    setTime(value: number) { at = value; }, advance(value = 500) { at += value; }, setClock(callback: () => void) { beforeClock = callback; }, setWrite(callback: () => void) { beforeWrite = callback; },
    holdWrite(value: Promise<void> | undefined) { writeWait = value; }, rejectWrite() { rejectWrite = true; }, async close() { owner.abort(); await provider.close(); runtime.close(); } };
}
test('HID output feature defaults deny and preserves a input report-only incumbent', async () => {
  const f = outputFixture({ reviewedProfile: profile }); try {
    assert.equal(f.written.length, 0); const active = await f.start(); const report = f.provider.inspectOutput(active); assert.ok(report.ok); assert.equal(report.value.support, 'unsupported');
    const bound = f.provider.bindOutput(active, { purpose: 'no-reviewed-write' }); assert.equal(bound.ok, false); assert.equal(f.outputCalls(), 0);
    f.device.report([1]); f.runtime.flush(); assert.equal(f.observations.length, 1); assert.equal(f.provider.snapshot().activeSources, 1);
  } finally { await f.close(); }
  const denied = outputFixture({ authorizeOutput: undefined }); try { const active = await denied.start(); assert.equal(denied.provider.bindOutput(active, { purpose: 'default-deny' }).ok, false); assert.equal(denied.provider.snapshot().activeSources, 1); assert.equal(denied.written.length, 0); }
  finally { await denied.close(); }
});
test('a declared HID output requires its exact report layout and native method', async () => {
  const f = outputFixture(); try { const active = await f.start(); Object.defineProperty(f.device, 'sendReport', { value: undefined });
    const result = f.provider.bindOutput(active, { purpose: 'unsupported-write' }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'unsupported');
    assert.equal(f.written.length, 0); assert.equal(f.outputCalls(), 0); assert.equal(f.provider.snapshot().activeSources, 1);
  } finally { await f.close(); }
  for (const change of ['id', 'range', 'extra'] as const) {
    const wrong = outputFixture(); try { const rows = wrong.device.collections as { outputReports: { reportId: number; items: { logicalMaximum: number }[] }[] }[];
      if (change === 'id') rows[0]!.outputReports[0]!.reportId = 3;
      else if (change === 'range') rows[0]!.outputReports[0]!.items[0]!.logicalMaximum = 255;
      else rows[0]!.outputReports.push({ ...rows[0]!.outputReports[0]! });
      const selected = await wrong.provider.choose(); assert.equal(selected.ok, false); assert.equal(wrong.device.opens, 0); assert.equal(wrong.written.length, 0);
    } finally { await wrong.close(); }
  }
});
test('only exact current issued HID activations can inspect or bind output', async () => {
  const f = outputFixture(), other = outputFixture(); try {
    const active = await f.start(), foreign = await other.start();
    for (const invalid of [{}, { ...active }, foreign]) { assert.equal(f.provider.inspectOutput(invalid as BrowserHidSwitchActivation).ok, false); assert.equal(f.provider.bindOutput(invalid as BrowserHidSwitchActivation, { purpose: 'not-issued' }).ok, false); }
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
      if (kind === 'extra') return { request, signal: f.output.signal, expiresAt: 31000, credential: 'not-an-allowed-field' } as ReturnType<NonNullable<BrowserHidSwitchOptions['authorizeOutput']>>;
      return { request, get signal() { getters++; return f.output.signal; }, expiresAt: 31000 };
    } });
    try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'strict-output-review' }).ok, false); assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.written.length, 0); assert.equal(getters, 0); }
    finally { await f.close(); }
  }
});
test('genuine reliable HID commands emit exactly owned 0/1 bytes with api-returned evidence only', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    assert.ok(f.send(false).ok); await outputReached(() => f.provider.outputStatus().rawPending === 0); f.advance(); assert.ok(f.send(true).ok); await outputReached(() => f.provider.outputStatus().rawPending === 0);
    assert.deepEqual(f.written, [{ reportId: 2, bytes: [0] }, { reportId: 2, bytes: [1] }]); assert.equal(f.observations.length, 0); const rows = f.provider.outputStatus().records;
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.outcome === 'api-returned' && row.effect === 'dispatched' && row.physical === 'unverified'));
    assert.ok(f.connection()!.operations().every(row => row.effectEvidence !== 'observed' && row.effectEvidence !== 'target-acknowledged'));
    f.device.report([1]); f.runtime.flush(); assert.equal(f.observations.length, 1); assert.equal(f.observations[0]!.provenance?.captureTimeKnown, false);
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
test('HID output delivery bounds are default deny and exact-context closed snapshots', async () => {
  for (const kind of ['absent', 'copy', 'extra', 'getter'] as const) {
    let getter = 0; const f = outputFixture({ outputDeliveryLimits: kind === 'absent' ? undefined : context => {
      const base = { context, expiresAt: 1100, maxAgeMs: 100, maxHz: 2 };
      if (kind === 'copy') return { ...base, context: { ...context } };
      if (kind === 'extra') return { ...base, arbitrary: true } as typeof base;
      return { ...base, get maxAgeMs() { getter++; return 100; } };
    } });
    try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputReached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0); assert.equal(getter, 0); }
    finally { await f.close(); }
  }
});
test('HID final issuance honors narrower real route and reliable operation deadlines after clock callouts', async () => {
  for (const scope of ['route', 'operation'] as const) {
    const f = outputFixture(); let arm = false; try { const active = await f.start(); if (scope === 'route') f.setRouteEnd(1025); const bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
      Object.defineProperty(f.device, 'sendReport', { configurable: true, get() { arm = true; return f.writer; } }); f.setClock(() => { if (arm) f.setTime(1040); });
      f.send(true, scope === 'operation' ? 1025 : 1100); await outputReached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0);
    } finally { await f.close(); }
  }
});
test('HID final current observer cannot move capture expiry behind the issuance clock fence', async () => {
  const f = outputFixture(); f.setEnd(2000); const actual = f.runtime.registerSink.bind(f.runtime); let calls = 0;
  f.runtime.registerSink = provider => actual({ ...provider, apply(observation, context) {
    if (provider.capability !== 'switch-setting') return provider.apply(observation, context);
    const current: DeliveryContext = Object.freeze({ ...context, isCurrent() { const valid = context.isCurrent(); if (++calls >= 2) f.setTime(2000); return valid; } });
    return provider.apply(observation, current);
  } });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputReached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0); assert.ok(calls >= 2); }
  finally { await f.close(); }
});
test('intrinsic output abort and method getter Stop cannot dispatch through shadows or reentry', async () => {
  for (const kind of ['abort', 'method'] as const) {
    const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
      if (kind === 'abort') { Object.defineProperty(f.output.signal, 'aborted', { value: false }); f.setClock(() => f.output.abort()); }
      else Object.defineProperty(f.device, 'sendReport', { get() { f.provider.stop(); return f.writer; } });
      f.send(true); await outputReached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0);
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
test('held actual HID write survives Stop and keeps close reserved before owned input report cleanup', async () => {
  const f = outputFixture(), write = held<void>(), disconnect = held<void>(); f.holdWrite(write.promise); f.device.closeWait = disconnect.promise;
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputReached(() => f.written.length === 1);
    f.provider.stop(); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.device.closes, 0); assert.equal(f.device.closes, 0);
    let done = false; const close = f.provider.close(); assert.equal(close, f.provider.close()); void close.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
    assert.ok(f.provider.snapshot().nativePending > 0 && f.provider.snapshot().nativePending <= 3); assert.equal((await f.provider.choose()).ok, false);
    write.resolve(); await outputReached(() => f.device.closes === 1); assert.equal(done, false); disconnect.resolve(); await close;
    assert.equal(f.provider.snapshot().nativePending, 0); assert.equal(f.provider.snapshot().nativePending, 0); assert.equal(f.provider.outputStatus().records[0]!.outcome, 'uncertain'); assert.deepEqual(f.written, [{ reportId: 2, bytes: [1] }]);
  } finally { write.resolve(); disconnect.resolve(); await f.close(); }
});
test('synchronous write factory close waits for its late returned actual promise', async () => {
  const f = outputFixture(), gate = held<void>(); f.holdWrite(gate.promise); let close: Promise<void> | undefined, settled = false;
  f.setWrite(() => { close = f.provider.close(); void close.then(() => { settled = true; }); });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputReached(() => f.written.length === 1); await Promise.resolve(); assert.ok(close); assert.equal(settled, false); assert.equal(f.device.closes, 0);
    gate.resolve(); await close; assert.equal(f.device.closes, 1); assert.equal(f.provider.snapshot().nativePending, 0);
  } finally { gate.resolve(); await f.close(); }
});
test('logical HID operation expiry never releases a held write raw slot or permits automatic reset', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const f = outputFixture(), gate = held<void>(); f.holdWrite(gate.promise);
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true, 1025); await outputReached(() => f.written.length === 1);
    f.setTime(1025); context.mock.timers.tick(25); assert.equal(f.provider.outputStatus().records[0]!.outcome, 'uncertain'); assert.ok(f.provider.snapshot().nativePending > 0); assert.deepEqual(f.written, [{ reportId: 2, bytes: [1] }]);
    let done = false; const close = f.provider.close(); void close.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false); gate.resolve(); await close; assert.equal(f.provider.snapshot().nativePending, 0);
  } finally { gate.resolve(); await f.close(); context.mock.timers.reset(); }
});
test('output-only expiry retires its idle sink but preserves an independently current input report capture', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); const f: ReturnType<typeof outputFixture> = outputFixture({ authorizeOutput(request) { return { request, signal: f.output.signal, expiresAt: 1500 }; } });
  try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.setTime(1500); context.mock.timers.tick(500);
    assert.equal(f.provider.outputStatus().activeSinks, 0); assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.written.length, 0); f.device.report([1]); f.runtime.flush(); assert.equal(f.observations.length, 1);
  } finally { await f.close(); context.mock.timers.reset(); }
});
test('changing the selected output layout retires commands without report fallback', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    const rows = f.device.collections as { outputReports: unknown[] }[]; rows[0]!.outputReports = []; f.send(true);
    await outputReached(() => f.provider.outputStatus().rawPending === 0); assert.equal(f.written.length, 0); assert.equal(f.provider.outputStatus().activeSinks, 0);
  } finally { await f.close(); }
});
test('rejected response promise records issued failure without a fabricated observed state', async () => {
  const f = outputFixture(); f.rejectWrite(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true); await outputReached(() => f.provider.outputStatus().rawPending === 0);
    assert.equal(f.provider.outputStatus().records[0]!.outcome, 'api-rejected'); assert.equal(f.provider.outputStatus().records[0]!.effect, 'dispatched'); assert.equal(f.observations.length, 0);
  } finally { await f.close(); }
});
test('output attempt/rate/history limits stay finite inside the original capture lifetime', async () => {
  const f = outputFixture(); try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok);
    for (let row = 0; row < 31; row++) { if (row) f.advance(); f.send(row % 2 === 1); await outputReached(() => f.provider.outputStatus().rawPending === 0); }
    assert.equal(f.written.length, 31); assert.equal(f.provider.outputStatus().attempts, 32); assert.equal(f.provider.outputStatus().records.length, 16); f.advance(); f.send(true); assert.equal(f.written.length, 31);
  } finally { await f.close(); }
  const rate = outputFixture(); try { const active = await rate.start(), bound = rate.bind(active); assert.ok('started' in bound && bound.started.ok); rate.send(true); await outputReached(() => rate.provider.outputStatus().rawPending === 0); rate.send(false); await outputReached(() => rate.provider.outputStatus().rawPending === 0); assert.equal(rate.written.length, 1); }
  finally { await rate.close(); }
});

test('late genuine HID output sink removal false or throw truthfully quarantines admission', async () => {
  for (const kind of ['false', 'throw'] as const) {
    const f = outputFixture(), register = f.runtime.registerSink.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime); let late: ReturnType<typeof register> | undefined;
    f.runtime.registerSink = provider => { const handle = register(provider); if (provider.capability === 'switch-setting') { late = handle; f.provider.stop(); } return handle; };
    f.runtime.unregister = handle => { if (handle === late) { if (kind === 'throw') throw Error('trusted remove failed'); return { ok: false, reason: 'unavailable' }; } return unregister(handle); };
    try { const active = await f.start(); assert.equal(f.provider.bindOutput(active, { purpose: 'late-remove-failure' }).ok, false);
      assert.ok(late); assert.equal(f.provider.snapshot().cleanupFailed, true); assert.equal(f.provider.outputStatus().unconfirmedCleanup, true); assert.equal((await f.provider.choose()).ok, false); assert.equal(f.written.length, 0);
    } finally { f.runtime.unregister = unregister; await f.close(); }
  }
});
test('closed output declarations reject accessors, extras and invalid report identifiers', async () => {
  for (const output of [{ reportId: 256, format: 'boolean-byte/1' }, { reportId: 2, format: 'raw' }, { reportId: 2, format: 'boolean-byte/1', fallback: true },
    Object.defineProperty({ format: 'boolean-byte/1' }, 'reportId', { enumerable: true, get() { throw Error('must not read'); } })]) {
    const f = fixture(); try { assert.throws(() => createBrowserHidSwitchProvider({ runtime: f.runtime, ownerSignal: f.owner.signal, scope: f.scope, now: f.time,
      authorizeCapture: () => undefined, reviewedProfile: { ...profile, output } as BrowserHidSwitchOptions['reviewedProfile'] })); }
    finally { await f.close(); }
  }
});

test('output report type distinguishes explicitly reviewed zero and shared input identifiers', async () => {
  for (const reportId of [0, 1]) {
    const f = outputFixture({ reviewedProfile: { ...profile, output: { reportId, format: 'boolean-byte/1' } } });
    try { const active = await f.start(), bound = f.bind(active); assert.ok('started' in bound && bound.started.ok); f.send(true);
      await outputReached(() => f.provider.outputStatus().rawPending === 0); assert.deepEqual(f.written, [{ reportId, bytes: [1] }]);
      f.device.report([1]); f.runtime.flush(); assert.equal(f.observations.length, 1);
    } finally { await f.close(); }
  }
});
test('output request Proxy cannot reenter one selected owner into a second approval', async () => {
  const f = outputFixture(); let nested: ReturnType<typeof f.provider.bindOutput> | undefined;
  try { const active = await f.start(); const request = new Proxy({ purpose: 'outer-output' }, { getOwnPropertyDescriptor(target, key) {
    if (key === 'purpose' && !nested) nested = f.provider.bindOutput(active, { purpose: 'nested-output' }); return Reflect.getOwnPropertyDescriptor(target, key);
  } }); const outer = f.provider.bindOutput(active, request); assert.ok(outer.ok); assert.ok(nested); assert.equal(nested.ok, false);
    if (!nested.ok) assert.equal(nested.reason, 'busy'); assert.equal(f.outputCalls(), 1); assert.equal(f.written.length, 0);
  } finally { await f.close(); }
});

// Actual public caller + existing native-shaped software fixture. A user clock
// failure is injected only at the direct caller callback after genuine binding;
// provider/runtime calls remain unchanged and no hardware is accessed.
for (const site of ['connectOutput', 'set'] as const) {
  test(`public hid output caller retires provisional state after clock failure in ${site}`, async context => {
    const owner = new AbortController(), capture = new AbortController(), output = new AbortController();
    const target = new EventTarget(), document = new EventTarget(); let writes = 0, failing = false, witnessed = false;
    const device = new SoftwareDevice(), manager = new SoftwareManager(device);
    const rows = device.collections as { outputReports: unknown[]; inputReports: { items: object[] }[] }[];
    rows[0]!.outputReports = [{ reportId: 2, items: [{ ...rows[0]!.inputReports[0]!.items[0] }] }];
    Object.defineProperty(device, 'sendReport', { value: async () => { writes++; } });
    const reviewedProfile = { ...profile, output: { reportId: 2, format: 'boolean-byte/1' as const } };
    const caller = createBrowserHidSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile,
      now() {
        const directCaller = new Error().stack?.split('\n')[2] ?? '';
        if (failing && directCaller.includes(`Object.${site} `)) {
          const state = caller.state(); witnessed = state.provider.activeSources === 1 && state.output.activeSinks === 1;
          context.diagnostic(JSON.stringify({ site, directCaller, captureSources: state.provider.activeSources, outputSinks: state.output.activeSinks, nativeWrites: writes }));
          throw Error('owned-caller-clock-failure');
        } return 1000;
      },
      environment: { hid: manager, target, document, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' },
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
  test(shape + ' HID callback failure releases held input', async () => {
    const f = fixture(), error = switchHostFailure(shape);
    let guarded: EventListener | undefined, escaped = false;
    try {
      await f.start(); f.device.report([1]); f.flush(); assert.equal(f.held(), true); f.advance();
      const callbacks = getEventListeners(f.device, 'inputreport') as EventListener[];
      assert.equal(callbacks.length, 1); const callback = callbacks[0]!;
      // Keep real Event.target branding while containing an old callback escape.
      // Only the software boundary is wrapped; the actual provider callback runs.
      f.device.removeEventListener('inputreport', callback);
      guarded = event => { try { callback.call(f.device, event); } catch { escaped = true; } };
      f.device.addEventListener('inputreport', guarded);
      const event = new Event('inputreport');
      Object.defineProperties(event, { device: { value: f.device }, reportId: { value: 1 }, data: { get() { throw error; } } });
      f.device.dispatchEvent(event);
      assert.equal(f.held(), false, 'An unreadable host error must release the actual sink');
      assert.ok(f.releases() > 0); assert.equal(f.provider.snapshot().activeSources, 0);
      assert.equal(f.provider.snapshot().reason, expected); assert.equal(escaped, false);
      const delivered = f.observations.length;
      f.device.dispatchEvent(new Event('inputreport')); f.flush();
      assert.equal(f.held(), false); assert.equal(f.observations.length, delivered);
    } finally {
      if (guarded) f.device.removeEventListener('inputreport', guarded);
      await f.close();
    }
    assert.equal(f.device.closes, 1);
  });
}
