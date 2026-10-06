import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
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
