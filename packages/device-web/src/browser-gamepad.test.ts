import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserGamepadOptions, BrowserGamepadActivation, BrowserGamepadEnvironment } from './browser-gamepad.ts';

const api = await import('./browser-gamepad.ts').catch(() => undefined);
test('browser Gamepad resource selection needs an explicit typed provider instead of a first-pad action adapter', () => {
  assert.equal(typeof api?.createBrowserGamepadProvider, 'function', 'Missing selected browser Gamepad resource provider');
});

function fixture(change: Partial<BrowserGamepadOptions> = {}) {
  let at = 100, calls = 0, next = 0, focused = true, hidden = false;
  const frames = new Map<number, FrameRequestCallback>(), target = new EventTarget(), document = new EventTarget(), owner = new AbortController(), capture = new AbortController();
  const pads: (ReturnType<typeof pad> | null)[] = [null, pad(1)];
  const events: Observation[] = [], held = new Set<string>(); let releases = 0, allowRoutes = true;
  const scope = { principalId: 'pad-owner', applicationId: 'pad-app', sessionId: 'pad-session' };
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'javascript-poll-clock', maxPendingDeliveries: 1,
    authorize(request) { if (allowRoutes && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: at + 1000, maxAgeMs: 100, maxHz: 60 }; } });
  const provider = api!.createBrowserGamepadProvider({ runtime, ownerSignal: owner.signal, scope, now: () => at,
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: at + 1000 }; },
    environment: { getGamepads() { calls++; return pads; }, requestAnimationFrame(callback) { frames.set(++next, callback); return next; }, cancelAnimationFrame(id) { frames.delete(id); }, target, document, focused: () => focused, hidden: () => hidden }, ...change });
  function bind(activation: BrowserGamepadActivation) {
    const sink = parseDeviceDescriptor({ ...activation.device, id: activation.device.id + ':consumer', capabilities: activation.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    for (const c of activation.device.capabilities) {
      const endpoint = runtime.registerSink({ device: sink, capability: c.id, apply(observation, context) {
        if (!context.isCurrent() || context.signal.aborted) return; events.push(observation);
        if (c.id === 'button') { const value = observation.value as { id: string; pressed: boolean }; if (value.pressed) held.add(value.id); else held.delete(value.id); }
      }, release() { held.clear(); releases++; } });
      runtime.setReadiness(endpoint, 'available'); assert.ok(runtime.route({ from: activation.sources[c.id]!, to: endpoint, ...scope, leaseMs: 1000, queueCapacity: 32 }).start().ok);
    }
  }
  function start() { const selected = provider.select(1); assert.ok(selected.ok); const active = provider.start(selected.value, { purpose: 'explicit-gamepad' }); assert.ok(active.ok); bind(active.value); return active.value; }
  return { provider, runtime, owner, capture, target, document, pads, events, held, frames, scope, start, bind,
    calls: () => calls, releases: () => releases, setAt(value: number) { at = value; }, denyRoutes() { allowRoutes = false; },
    frame() { at += 20; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(at); runtime.flush(); runtime.flush(); },
    blur() { focused = false; target.dispatchEvent(new Event('blur')); }, hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
    close() { provider.close(); runtime.close(); } };
}
function pad(index: number, axes = [0.25, -0.5], pressed = false): NonNullable<ReturnType<NonNullable<BrowserGamepadEnvironment['getGamepads']>>[number]> {
  return { index, id: 'native-shaped-test-pad', connected: true, axes, buttons: [{ pressed, value: pressed ? 0.75 : 0 }], timestamp: 17.5 };
}

test('construction performs no native reads or scheduling and missing selected indices remain unavailable', () => {
  const f = fixture(); try { assert.equal(f.calls(), 0); assert.equal(f.frames.size, 0); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.provider.select(0).ok, false); assert.equal(f.provider.snapshot().phase, 'idle'); }
  finally { f.close(); }
});

test('exact chosen inventory uses axes and button edges without trigger mapping and retains last-update provenance', () => {
  const f = fixture(); try {
    f.pads[0] = pad(0, [1], true); const activation = f.start();
    assert.deepEqual(activation.device.capabilities.map(c => c.id), ['axes', 'button']);
    f.pads[1] = pad(1, [0.5, -1], true); f.frame();
    assert.deepEqual(f.events.find(e => e.source.capabilityId === 'axes')!.value, [0.5, -1]);
    assert.deepEqual([...f.held], ['button-0']);
    assert.equal(f.events[0]!.timestamp, 120); assert.equal(f.events[0]!.clockDomain, 'javascript-poll-clock');
    assert.equal(f.events[0]!.provenance?.gamepadLastUpdateTimestamp, 17.5); assert.equal(f.events[0]!.provenance?.captureTimeKnown, false);
    assert.equal(f.events[0]!.provenance?.selectedIndex, 1); assert.equal(JSON.stringify(f.events).includes('native-shaped-test-pad'), false);
  } finally { f.close(); }
});

for (const cause of ['blur', 'hide', 'disconnect', 'stop', 'owner', 'capture'] as const) test(`${cause} retires source handles and clears held sink through actual runtime release`, () => {
  const f = fixture(); try {
    f.start(); f.pads[1] = pad(1, [0, 0], true); f.frame(); assert.equal(f.held.size, 1);
    if (cause === 'blur') f.blur(); else if (cause === 'hide') f.hide(); else if (cause === 'stop') f.provider.stop(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'capture') f.capture.abort();
    else { const event = new Event('gamepaddisconnected'); Object.defineProperty(event, 'gamepad', { value: pad(1) }); f.target.dispatchEvent(event); }
    assert.equal(f.held.size, 0); assert.ok(f.releases() >= 1); assert.equal(f.frames.size, 0); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { f.close(); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.provider.snapshot().timerArmed, false); }
});

test('same-index replacement and inventory changes retire rather than silently reinterpret controls', () => {
  for (const replacement of [{ ...pad(1), id: 'different-pad' }, pad(1, [0]), { ...pad(1), index: 2 }]) {
    const f = fixture(); try { f.start(); f.pads[1] = replacement; f.frame(); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.provider.snapshot().reason, 'lost'); } finally { f.close(); }
  }
});

test('denied capture, mismatched approval and accessor requests perform no registration or polling', () => {
  let getters = 0;
  for (const authorizeCapture of [() => undefined, (request: unknown) => ({ request: { ...request as object }, signal: new AbortController().signal, expiresAt: 200 })]) {
    const f = fixture({ authorizeCapture: authorizeCapture as BrowserGamepadOptions['authorizeCapture'] }); try {
      const selected = f.provider.select(1); assert.ok(selected.ok); assert.equal(f.provider.start(selected.value, { purpose: 'denied' }).ok, false); assert.equal(f.frames.size, 0); assert.equal(f.provider.snapshot().activeSources, 0);
      assert.equal(f.provider.start(selected.value, { get purpose() { getters++; return 'hidden'; } }).ok, false);
    } finally { f.close(); }
  }
  assert.equal(getters, 0);
});

test('capture authorization and reentrant clocks cannot dispatch after owner cancellation', () => {
  const f = fixture({ authorizeCapture(request) { f.owner.abort(); return { request, signal: new AbortController().signal, expiresAt: 200 }; } });
  try { const selected = f.provider.select(1); assert.ok(selected.ok); assert.equal(f.provider.start(selected.value, { purpose: 'cancel' }).ok, false); assert.equal(f.frames.size, 0); } finally { f.close(); }
  let retire = false; const g = fixture({ now() { if (retire) g.provider.stop(); return 100; } });
  try { g.start(); retire = true; g.frame(); assert.equal(g.events.length, 0); assert.equal(g.provider.snapshot().activeSources, 0); } finally { g.close(); }
});

test('a throwing observation clock fails closed without an uncaught animation callback', () => {
  let fail = false; const f = fixture({ now() { if (fail) throw new Error('Private clock failure'); return 100; } });
  try { f.start(); fail = true; assert.doesNotThrow(() => f.frame()); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.events.length, 0); assert.equal(f.frames.size, 0); }
  finally { f.close(); }
});

test('stale animation callback and forged foreign handles cannot activate a new connection generation', () => {
  const f = fixture(); try {
    const old = f.provider.select(1); assert.ok(old.ok); const activation = f.provider.start(old.value, { purpose: 'first' }); assert.ok(activation.ok); f.bind(activation.value);
    const late = [...f.frames.values()][0]!; f.provider.stop(); const next = f.provider.select(1); assert.ok(next.ok); assert.notEqual(old.value, next.value);
    assert.equal(f.provider.start(old.value, { purpose: 'stale' }).ok, false); assert.equal(f.provider.start(Object.freeze({}), { purpose: 'forged' }).ok, false);
    assert.ok(f.provider.start(next.value, { purpose: 'fresh' }).ok); late(200); assert.equal(f.events.length, 0);
  } finally { f.close(); }
});

test('invalid ranges, timestamp rollback, excessive inventory and absent SDK grants fail closed', () => {
  for (const replacement of [pad(1, [2, 0]), { ...pad(1), timestamp: -1 }, { ...pad(1), timestamp: 17 }, pad(1, Array(17).fill(0))]) {
    const f = fixture(); try { f.start(); f.pads[1] = replacement; f.frame(); assert.equal(f.events.length, 0); assert.equal(f.provider.snapshot().activeSources, 0); } finally { f.close(); }
  }
  const f = fixture(); try { const selected = f.provider.select(1); assert.ok(selected.ok); assert.ok(f.provider.start(selected.value, { purpose: 'no-routes' }).ok); f.frame(); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.events.length, 0); } finally { f.close(); }
});

test('a partial listener installation failure tears down the selected native lifetime', () => {
  const eventTarget = new EventTarget(), listeners = new Set<string>();
  const target = { addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (type === 'gamepadconnected') throw new Error('Trusted environment failed'); listeners.add(type); eventTarget.addEventListener(type, listener);
  }, removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) { listeners.delete(type); eventTarget.removeEventListener(type, listener); } };
  const f = fixture({ environment: { getGamepads: () => [pad(0)], requestAnimationFrame: () => 1, cancelAnimationFrame() {}, target,
    document: new EventTarget(), hidden: () => false, focused: () => true } });
  try { assert.equal(f.provider.select(0).ok, false); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.provider.snapshot().phase, 'idle'); assert.equal(listeners.size, 0); }
  finally { f.close(); }
});

test('native installation then a trusted throw or reentrant Stop removes the exact late listener', () => {
  for (const failure of ['throw', 'stop-before-install', 'stop-after-install-throw'] as const) {
    const eventTarget = new EventTarget(), listeners = new Map<EventListenerOrEventListenerObject | null, string>();
    const target = { addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === 'gamepadconnected' && failure === 'stop-before-install') f.provider.stop();
      eventTarget.addEventListener(type, listener); listeners.set(listener, type);
      if (type === 'gamepadconnected') { if (failure === 'stop-after-install-throw') f.provider.stop(); if (failure !== 'stop-before-install') throw new Error('Trusted throw after native install'); }
    }, removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) { eventTarget.removeEventListener(type, listener); listeners.delete(listener); } };
    const f = fixture({ environment: { getGamepads: () => [pad(0)], requestAnimationFrame: () => 1, cancelAnimationFrame() {}, target,
      document: new EventTarget(), hidden: () => false, focused: () => true } });
    try { assert.equal(f.provider.select(0).ok, false); assert.equal(listeners.size, 0, 'Native effects after early removal must still be retired'); assert.equal(f.provider.snapshot().listeners, 0); f.provider.close(); assert.equal(listeners.size, 0); }
    finally { f.close(); for (const [listener, type] of listeners) eventTarget.removeEventListener(type, listener); }
  }
});

test('the lifetime attempt bound rejects before any additional native read', () => {
  const f = fixture(); try {
    for (let index = 0; index < 64; index++) assert.ok(f.provider.inspect().ok);
    assert.equal(f.calls(), 64); assert.deepEqual(f.provider.inspect(), { ok: false, reason: 'quota' }); assert.equal(f.calls(), 64); assert.equal(f.provider.snapshot().attempts, 64);
  } finally { f.close(); }
});

test('one absolute capture deadline expires even while native frames stay quiet', async () => {
  const f = fixture({ authorizeCapture(request) { return { request, signal: new AbortController().signal, expiresAt: 105 }; } });
  try { f.start(); f.setAt(106); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.frames.size, 0); assert.equal(f.provider.snapshot().reason, 'expired'); assert.equal(f.provider.snapshot().activeSources, 0); }
  finally { f.close(); }
});
