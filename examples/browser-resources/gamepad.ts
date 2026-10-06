import { createBrowserGamepadProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserGamepadCaptureGrant, BrowserGamepadCaptureRequest, BrowserGamepadEnvironment, Observation } from '@101/connect';

/** Actual browser default; selected capture and each typed route are separately approved. */
export function createBrowserGamepadPipeline(options: {
  ownerSignal: AbortSignal; authorizeCapture: (request: BrowserGamepadCaptureRequest) => BrowserGamepadCaptureGrant | undefined;
  authorizeRoutes: Authorize; now?: () => number; environment?: BrowserGamepadEnvironment;
}) {
  const now = options.now ?? (() => performance.now()), scope = { principalId: 'gamepad-owner', applicationId: 'gamepad-example', sessionId: 'gamepad-session' };
  const runtime = createDeviceRuntime({ now, clockDomain: 'gamepad-javascript-observation', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserGamepadProvider({ runtime, now, scope, ownerSignal: options.ownerSignal, authorizeCapture: options.authorizeCapture,
    ...(options.environment ? { environment: options.environment } : {}) });
  const sinks: ReturnType<typeof runtime.registerSink>[] = [], routes: ReturnType<typeof runtime.route>[] = [], held = new Set<string>();
  let axes: readonly number[] = [], delivered = 0, releases = 0, last: Observation | undefined;
  function clear() { axes = []; held.clear(); releases++; }
  function stop() { provider.stop(); for (const route of routes.splice(0)) route.stop('gamepad-source-retired'); for (const sink of sinks.splice(0)) runtime.unregister(sink); clear(); }
  return { provider, inspect: () => provider.inspect(),
    activate(index: number, purpose: string) {
      const selection = provider.select(index); if (!selection.ok) return selection;
      const started = provider.start(selection.value, { purpose }); if (!started.ok) return started;
      try {
        const device = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':consumer',
          capabilities: started.value.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
        for (const c of device.capabilities) {
          const sink = runtime.registerSink({ device, capability: c.id, apply(observation, context) {
            if (context.signal.aborted || !context.isCurrent()) return; delivered++; last = observation;
            if (c.id === 'axes') axes = observation.value as readonly number[];
            else { const value = observation.value as { id: string; pressed: boolean }; if (value.pressed) held.add(value.id); else held.delete(value.id); }
          }, release: clear }); sinks.push(sink); runtime.setReadiness(sink, 'available');
          const route = runtime.route({ from: started.value.sources[c.id]!, to: sink, ...scope, leaseMs: 10000, queueCapacity: 32 }); routes.push(route);
          if (!route.start().ok) { stop(); return { ok: false as const, reason: 'denied' as const }; }
        }
        return started;
      } catch { stop(); return { ok: false as const, reason: 'unavailable' as const }; }
    },
    /** Host-owned scheduler; bounded flushing allows axes and reliable button edges to share one slot. */
    tick() { runtime.flush(); runtime.flush(); },
    state() { return Object.freeze({ axes, heldButtons: Object.freeze([...held]), delivered, releases,
      ...(last ? { lastObservation: last } : {}), provider: provider.snapshot() }); },
    stop, close() { stop(); provider.close(); runtime.close(); },
  };
}

/** Native API checks only. No chooser, OS dialog, physical device or fabricated native positive frame. */
export function checkBrowserGamepadWithoutDevice() {
  const owner = new AbortController(); let approvals = 0;
  const pipeline = createBrowserGamepadPipeline({ ownerSignal: owner.signal, authorizeCapture() { approvals++; return undefined; }, authorizeRoutes() { return undefined; } });
  const initial = pipeline.provider.snapshot();
  let native: { available: boolean; outcome: 'empty' | 'denied' | 'unsupported' | 'unexpected-device'; slots: number };
  if (typeof navigator.getGamepads !== 'function') native = { available: false, outcome: 'unsupported', slots: 0 };
  else {
    try { const pads = navigator.getGamepads(); native = { available: true, outcome: pads.some(Boolean) ? 'unexpected-device' : 'empty', slots: pads.length }; }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error; native = { available: true, outcome: 'denied', slots: 0 }; }
  }
  try {
    const inventory = pipeline.inspect(), selected = pipeline.activate(0, 'explicit-no-pad-check'); pipeline.stop();
    const stopped = pipeline.provider.snapshot(), retry = pipeline.activate(0, 'explicit-retry');
    pipeline.close();
    return { kind: 'actual-native-browser-negative', native, observed: { hidden: document.hidden, focused: document.hasFocus() }, initial, inventory, selected, stopped, retry,
      final: pipeline.provider.snapshot(), captureApprovals: approvals, physicalDeviceQualification: false };
  } finally { owner.abort(); pipeline.close(); }
}

/** Native-shaped software fixture through ordinary public SDK; never hardware evidence. */
export function runBrowserGamepadLogicFixture() {
  let at = 100, next = 0; const callbacks = new Map<number, FrameRequestCallback>(), target = new EventTarget(), doc = new EventTarget();
  const owner = new AbortController(), capture = new AbortController();
  const pads: ReturnType<NonNullable<BrowserGamepadEnvironment['getGamepads']>> = [null, { index: 1, id: 'software-fixture-private-id', connected: true, axes: [0.25], buttons: [{ pressed: true, value: 0.75 }], timestamp: 7.5 }];
  const pipeline = createBrowserGamepadPipeline({ ownerSignal: owner.signal, now: () => at,
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: at + 1000 }; },
    authorizeRoutes(request) {
      if (request.principalId === 'gamepad-owner' && request.applicationId === 'gamepad-example' && request.sessionId === 'gamepad-session' &&
        request.source.deviceId.startsWith('browser-gamepad-') && request.source.capabilityId === request.sink.capabilityId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: at + 1000, maxAgeMs: 100, maxHz: 60 };
    }, environment: { getGamepads: () => pads, requestAnimationFrame(callback) { callbacks.set(++next, callback); return next; }, cancelAnimationFrame(id) { callbacks.delete(id); },
      target, document: doc, hidden: () => false, focused: () => true } });
  try {
    const selected = pipeline.activate(1, 'software-fixture-only'); if (!selected.ok) throw new Error('Fixture selection failed');
    const step = () => { at += 20; const frame = [...callbacks.values()]; callbacks.clear(); for (const callback of frame) callback(at); pipeline.tick(); };
    step(); const active = pipeline.state(); capture.abort(); const retired = pipeline.state(); pipeline.close();
    return { kind: 'injected-native-shaped-logic-fixture', positiveHardwareEvidence: false, selectedCapabilities: selected.value.device.capabilities.map(c => c.id),
      active: { axes: active.axes, heldButtons: active.heldButtons, delivered: active.delivered, timestamp: active.lastObservation?.timestamp, provenance: active.lastObservation?.provenance },
      retired: { axes: retired.axes, heldButtons: retired.heldButtons, releases: retired.releases, provider: retired.provider }, cleanup: { callbacks: callbacks.size, ...pipeline.provider.snapshot() } };
  } finally { owner.abort(); pipeline.close(); }
}
