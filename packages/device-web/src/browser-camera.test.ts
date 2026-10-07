import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserCameraEnvironment, BrowserCameraActivation, BrowserCameraOptions, BrowserCameraControlActivation, BrowserCameraControlDeliveryLimits } from './browser-camera.ts';

const api = await import('./browser-camera.ts').catch(() => undefined);
test('an exact selected camera exposes a typed frame source instead of selection metadata', () => {
  assert.equal(typeof api?.createBrowserCameraProvider, 'function', 'Missing exact selected typed camera provider');
});

class Track extends EventTarget {
  kind = 'video'; readyState = 'live'; muted = false; id = 'native-track'; stops = 0; deviceId: string | undefined = 'selected-id';
  zoom: number | undefined; range: { min: number; max: number; step: number } | undefined; constraints: MediaTrackConstraints[] = [];
  applyGate?: Promise<void>; onCapabilities?: () => void; onSettings?: () => void; onApply?: () => void;
  stop() { this.stops++; this.readyState = 'ended'; }
  getCapabilities() { this.onCapabilities?.(); return this.range ? { zoom: this.range } : {}; }
  getSettings() { this.onSettings?.(); return { deviceId: this.deviceId, width: 64, height: 48, ...(this.zoom === undefined ? {} : { zoom: this.zoom }) }; }
  applyConstraints(value: MediaTrackConstraints) {
    this.constraints.push(value); this.onApply?.();
    const zoom = (value.advanced?.[0] as { zoom?: number } | undefined)?.zoom;
    assert.deepEqual(value, { advanced: [{ zoom }] });
    return (this.applyGate ?? Promise.resolve()).then(() => { this.zoom = zoom; });
  }
}
class Stream { track = new Track(); getTracks() { return [this.track]; } }
class Video extends EventTarget {
  srcObject: unknown; muted = false; playsInline = false; videoWidth = 64; videoHeight = 48; readyState = 2; currentTime = 0;
  pending = new Map<number, VideoFrameRequestCallback>(); next = 0; pauses = 0; removed = 0; frames = 0; playGate?: Promise<void>; onRequest?: () => void;
  play() { return this.playGate ?? Promise.resolve(); } pause() { this.pauses++; } remove() { this.removed++; }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.onRequest?.(); const id = ++this.next; this.pending.set(id, callback); return id; }
  cancelVideoFrameCallback(id: number) { this.pending.delete(id); }
  emit(at = 100) { const entry = this.pending.entries().next().value as [number, VideoFrameRequestCallback] | undefined; if (!entry) return; this.pending.delete(entry[0]); this.currentTime += 0.1;
    entry[1](at, { mediaTime: this.currentTime, width: this.videoWidth, height: this.videoHeight, presentedFrames: ++this.frames, expectedDisplayTime: at, presentationTime: at, processingDuration: 0 }); }
}
class Pixels { width = 8; height = 8; data = new Uint8ClampedArray(256); constructor(level: number) { this.data.fill(level); } }
class Canvas {
  width = 0; height = 0; reads = 0; draws = 0; level = 255; onRead?: () => void; removed = 0;
  getContext() { return { drawImage: () => { this.draws++; }, getImageData: () => { this.reads++; this.onRead?.(); return new Pixels(this.level); } }; }
  remove() { this.removed++; }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(change: Partial<BrowserCameraOptions> = {}) {
  let at = 100, opens = 0, inspections = 0, hidden = false, focused = true, allowed = true, zoomRoutes = false, routeExpiry: number | undefined, routeAge = 250, released = 0, held: unknown;
  const owner = new AbortController(), capture = new AbortController(), video = new Video(), canvas = new Canvas(), stream = new Stream();
  const target = new EventTarget(), document = new EventTarget(), mediaDevicesTarget = new EventTarget();
  const devices = [{ kind: 'videoinput', deviceId: 'default' }, { kind: 'videoinput', deviceId: 'communications' }, { kind: 'videoinput', deviceId: '' }, { kind: 'videoinput', deviceId: 'selected-id' }];
  let openGate: Promise<MediaStream> | undefined;
  const scope = { principalId: 'camera-owner', applicationId: 'camera-app', sessionId: 'camera-session' }, observations: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'camera-js-retrieval', authorize(request) { if (allowed && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId && request.sourceOperation === 'subscribe' && (request.sinkOperation === 'write' || zoomRoutes && request.sinkOperation === 'invoke')) return { expiresAt: routeExpiry ?? at + 1000, maxAgeMs: routeAge, maxHz: request.sinkOperation === 'invoke' ? 2 : 10 }; } });
  const environment: BrowserCameraEnvironment = { fixtureKind: 'software-fixture', enumerateDevices() { inspections++; return Promise.resolve(devices as MediaDeviceInfo[]); },
    getUserMedia(constraints) { opens++; assert.deepEqual(constraints, { video: { deviceId: { exact: 'selected-id' }, width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 10, max: 15 } }, audio: false }); return openGate ?? Promise.resolve(stream as unknown as MediaStream); },
    createVideo: () => video as unknown as HTMLVideoElement, createCanvas: () => canvas as unknown as HTMLCanvasElement,
    MediaStream: Stream as unknown as typeof MediaStream, HTMLVideoElement: Video as unknown as typeof HTMLVideoElement, HTMLCanvasElement: Canvas as unknown as typeof HTMLCanvasElement, ImageData: Pixels as unknown as typeof ImageData,
    target, document, mediaDevicesTarget, hidden: () => hidden, focused: () => focused, secureContext: () => true };
  const provider = api!.createBrowserCameraProvider({ runtime, ownerSignal: owner.signal, scope, now: () => at, authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: at + 1000 }; }, environment, ...change });
  async function selection() { const inspected = await provider.inspect(); assert.ok(inspected.ok); assert.equal(inspected.value.length, 1); return inspected.value[0]!.selection; }
  async function start() { const starting = provider.start(await selection(), { purpose: 'selected-camera-frame' }); await turn(); video.emit(at); const result = await starting; assert.ok(result.ok); return result.value; }
  function bind(active: BrowserCameraActivation) { const device = parseDeviceDescriptor({ ...active.device, id: active.device.id + ':consumer', capabilities: active.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'camera-frame', apply(observation, context) { if (context.isCurrent() && !context.signal.aborted) { observations.push(observation); held = observation.value; } }, release() { held = undefined; released++; } }); runtime.setReadiness(sink, 'available'); const route = runtime.route({ from: active.source, to: sink, ...scope, leaseMs: 1000 }); return route; }
  return { provider, runtime, owner, capture, video, canvas, stream, environment, target, document, mediaDevicesTarget, devices, observations, selection, start, bind,
    opens: () => opens, inspections: () => inspections, held: () => held, released: () => released, setAt(value: number) { at = value; }, at: () => at, narrowRoutes(expiresAt: number, maxAgeMs = 250) { routeExpiry = expiresAt; routeAge = maxAgeMs; }, denyRoutes() { allowed = false; }, enableZoomRoutes() { zoomRoutes = true; }, holdOpen(promise: Promise<MediaStream>) { openGate = promise; },
    sample() { at += 100; video.emit(at); runtime.flush(); }, hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }, blur() { focused = false; target.dispatchEvent(new Event('blur')); }, async close() { await provider.close(); runtime.close(); } };
}

test('construction and exact inventory remain inert and forged choices open no camera', async () => {
  const f = fixture(); try { assert.equal(f.opens(), 0); assert.equal(f.inspections(), 0); assert.equal(f.provider.snapshot().listeners, 0); const selected = await f.selection();
    assert.equal(JSON.stringify(selected).includes('selected-id'), false); assert.equal((await f.provider.start({}, { purpose: 'forged' })).ok, false); assert.equal(f.opens(), 0);
  } finally { await f.close(); }
});
test('actual SDK routes the worst RGBA8 frame within its existing envelope and preserves unmapped decoded provenance', async () => {
  const f = fixture(); try { const active = await f.start(), route = f.bind(active); assert.ok(route.start().ok); f.sample(); const observed = f.observations.at(-1)!;
    assert.ok(observed, 'Worst-case255 bytes must fit the actual SDK payload ceiling'); assert.equal(observed.timestamp, 200); assert.equal(observed.clockDomain, 'camera-js-retrieval');
    const frame = observed.value as { format: string; width: number; height: number; rows: number[][] }; assert.equal(frame.format, 'rgba8'); assert.equal(frame.width, 8); assert.equal(frame.height, 8); assert.equal(frame.rows.length, 8); for (const row of frame.rows) assert.deepEqual(row, new Array(32).fill(255));
    assert.equal(observed.provenance?.captureTimeKnown, false); assert.equal(observed.provenance?.clockMappingEstablished, false); assert.equal(observed.provenance?.factoryKind, 'software-fixture'); assert.equal(observed.provenance?.nativeWidthPx, 64); assert.equal(observed.provenance?.nativeHeightPx, 48); assert.equal(observed.provenance?.mediaTimeSeconds, 0.2);
    assert.equal(JSON.stringify(observed).includes('selected-id'), false); f.canvas.level = 0; f.sample(); assert.equal((f.observations.at(-1)!.value as { rows: number[][] }).rows[0]![0], 0);
  } finally { await f.close(); }
});
test('camera capture approval cannot substitute for independently denied resource grants', async () => { const f = fixture(); try { const active = await f.start(); f.denyRoutes(); assert.equal(f.bind(active).start().ok, false); f.sample(); assert.equal(f.observations.length, 0); } finally { await f.close(); } });
for (const cause of ['stop', 'owner', 'capture', 'hide', 'blur', 'ended', 'mute', 'devicechange'] as const) test(cause + ' retires actual held SDK input and owned track/frame/backing store', async () => {
  const f = fixture(); try { const active = await f.start(); assert.ok(f.bind(active).start().ok); f.sample(); assert.ok(f.held());
    if (cause === 'stop') f.provider.stop(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'capture') f.capture.abort(); else if (cause === 'hide') f.hide(); else if (cause === 'blur') f.blur(); else if (cause === 'devicechange') f.mediaDevicesTarget.dispatchEvent(new Event('devicechange')); else { if (cause === 'ended') f.stream.track.readyState = 'ended'; else f.stream.track.muted = true; f.stream.track.dispatchEvent(new Event(cause)); }
    assert.equal(f.held(), undefined); assert.ok(f.released() > 0); assert.ok(f.stream.track.stops > 0); assert.equal(f.video.pending.size, 0); assert.equal(f.video.srcObject, null); assert.equal(f.canvas.width, 1); assert.equal(f.provider.snapshot().listeners, 0);
  } finally { await f.close(); }
});
test('denied copied/accessor/foreign capture grants never issue native getUserMedia', async () => {
  for (const authorizeCapture of [() => undefined, (request: Parameters<BrowserCameraOptions['authorizeCapture']>[0]) => ({ request: { ...request }, signal: new AbortController().signal, expiresAt: 1100 }), (request: Parameters<BrowserCameraOptions['authorizeCapture']>[0]) => ({ request, signal: {} as AbortSignal, expiresAt: 1100 }), (request: Parameters<BrowserCameraOptions['authorizeCapture']>[0]) => Object.defineProperty({ request, expiresAt: 1100 }, 'signal', { enumerable: true, get() { throw Error('Must not execute'); } }) as ReturnType<BrowserCameraOptions['authorizeCapture']>]) {
    const f = fixture({ authorizeCapture }); try { assert.equal((await f.provider.start(await f.selection(), { purpose: 'denied' })).ok, false); assert.equal(f.opens(), 0); } finally { await f.close(); }
  }
});
test('cancelled late getUserMedia owns its slot until true settlement and stops returned tracks', async () => {
  const f = fixture(), late = gate<MediaStream>(); try { f.holdOpen(late.promise); const starting = f.provider.start(await f.selection(), { purpose: 'late' }); await turn(); f.provider.stop(); assert.equal((await starting).ok, false); assert.equal(f.provider.snapshot().rawPending, 1); assert.equal((await f.provider.inspect()).ok, false);
    late.resolve(f.stream as unknown as MediaStream); await turn(); assert.ok(f.stream.track.stops > 0); assert.equal(f.provider.snapshot().rawPending, 0);
  } finally { late.resolve(f.stream as unknown as MediaStream); await f.close(); }
});
test('cancelled play remains reserved until native play settles', async () => {
  const f = fixture(), play = gate<void>(); try { f.video.playGate = play.promise; const starting = f.provider.start(await f.selection(), { purpose: 'pending-play' }); await turn(); f.provider.stop(); assert.equal((await starting).ok, false); assert.equal(f.provider.snapshot().rawPending, 1); play.resolve(); await turn(); assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.video.pending.size, 0); }
  finally { play.resolve(); await f.close(); }
});
test('owner revocation during native pixel retrieval prevents late SDK delivery', async () => { const f = fixture(); try { const active = await f.start(); assert.ok(f.bind(active).start().ok); f.canvas.onRead = () => f.capture.abort(); f.sample(); assert.equal(f.observations.length, 0); assert.equal(f.provider.snapshot().activeSources, 0); } finally { await f.close(); } });
test('quiet expiry and backwards clocks unregister without another native pixel read', async () => {
  for (const at of [1101, 99]) { const f = fixture(); try { await f.start(); f.setAt(at); f.provider.sweep(); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.canvas.reads, 0); assert.equal(f.video.pending.size, 0); } finally { await f.close(); } }
});
test('exact settings mismatch and rejected native play leave a recoverable retired selection', async () => {
  for (const why of ['settings', 'play']) { const f = fixture(); try { if (why === 'settings') f.stream.track.deviceId = 'another-id'; else f.video.playGate = Promise.reject(new DOMException('', 'NotSupportedError'));
      assert.equal((await f.provider.start(await f.selection(), { purpose: 'failure' })).ok, false); assert.ok(f.stream.track.stops > 0); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.provider.snapshot().rawPending, 0);
    } finally { await f.close(); } }
});
test('state callback cancellation during actual SDK readiness retires the newly registered source', async () => {
  const f = fixture(), original = f.runtime.setReadiness.bind(f.runtime); let issued: Parameters<typeof original>[0] | undefined;
  f.runtime.setReadiness = (source, readiness, expiry) => { issued = source; const result = original(source, readiness, expiry); f.provider.stop(); return result; };
  try { const starting = f.provider.start(await f.selection(), { purpose: 'readiness-cancel' }); await turn(); f.video.emit(); assert.equal((await starting).ok, false); assert.ok(issued); assert.equal(original(issued, 'available').ok, false); }
  finally { f.runtime.setReadiness = original; await f.close(); }
});
test('stop during frame registration cancels its exact late returned native token', async () => {
  const f = fixture(); try { f.video.onRequest = () => f.provider.stop(); const starting = f.provider.start(await f.selection(), { purpose: 'frame-install-cancel' }); assert.equal((await starting).ok, false); await turn(); assert.equal(f.video.pending.size, 0); assert.equal(f.provider.snapshot().rawPending, 0); }
  finally { await f.close(); }
});
test('a native EventTarget install followed by throw cannot leave a partial lifecycle for retry', async () => {
  const f = fixture(), add = f.target.addEventListener.bind(f.target);
  f.target.addEventListener = (type, callback, options) => { add(type, callback, options); if (type === 'blur') throw Error('Installed before trusted wrapper threw'); };
  try { assert.equal((await f.provider.inspect()).ok, false); assert.equal(getEventListeners(f.target, 'blur').length, 0); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.opens(), 0); }
  finally { await f.close(); }
});
test('a retired frame callback cannot replay into the current epoch after its native token settled', async () => {
  const f = fixture(); try { const active = await f.start(); assert.ok(f.bind(active).start().ok); const old = f.video.pending.values().next().value!; f.sample(); assert.equal(f.observations.length, 1);
    f.setAt(300); old(300, { mediaTime: 0.2, width: 64, height: 48, presentedFrames: 2, expectedDisplayTime: 300, presentationTime: 300, processingDuration: 0 }); f.runtime.flush();
    assert.equal(f.observations.length, 1); assert.equal(f.canvas.reads, 1); assert.equal(f.video.pending.size, 1);
  } finally { await f.close(); }
});
test('stream track replacement retires the originally selected source before reading replacement pixels', async () => {
  const f = fixture(); try { const active = await f.start(); assert.ok(f.bind(active).start().ok); const replacement = new Track(); replacement.id = 'replacement-track'; f.stream.getTracks = () => [replacement]; f.sample();
    assert.equal(f.observations.length, 0); assert.equal(f.canvas.reads, 0); assert.equal(f.provider.snapshot().activeSources, 0); assert.ok(f.stream.track.stops > 0);
  } finally { await f.close(); }
});
test('software fixtures cannot bypass the exact native deviceID check reserved for owned canvas producers', async () => {
  const f = fixture(); try { f.stream.track.deviceId = undefined; const starting = f.provider.start(await f.selection(), { purpose: 'missing-native-id' }); await turn(); assert.equal(f.video.pending.size, 0); const result = await starting; assert.deepEqual(result, { ok: false, reason: 'lost' }); }
  finally { f.provider.stop(); await f.close(); }
});
test('an unreturned native frame token keeps uncertain cleanup reserved until its actual callback settles', async () => {
  const f = fixture(), nativeRequest = f.video.requestVideoFrameCallback.bind(f.video);
  f.video.requestVideoFrameCallback = callback => { nativeRequest(callback); throw Error('Native callback was installed but token was not returned'); };
  try { const starting = f.provider.start(await f.selection(), { purpose: 'unreturned-frame-token' }); assert.equal((await starting).ok, false); await turn();
    assert.equal(f.provider.snapshot().rawPending, 1); assert.ok(f.provider.snapshot().cleanupFailures > 0); assert.equal(f.provider.snapshot().expiryArmed, false, 'Retired authority cannot own a deadline polling loop'); assert.equal((await f.provider.inspect()).ok, false); assert.equal(f.video.pending.size, 1);
    f.video.emit(); await turn(); assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.observations.length, 0);
  } finally { f.video.emit(); await f.close(); }
});
test('stop before a trusted EventTarget wrapper installs removes the exact effect after native return', async () => {
  const f = fixture(), add = f.target.addEventListener.bind(f.target);
  f.target.addEventListener = (type, callback, options) => { if (type === 'blur') f.provider.stop(); add(type, callback, options); };
  try { assert.equal((await f.provider.inspect()).ok, false); assert.equal(getEventListeners(f.target, 'blur').length, 0); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.opens(), 0); }
  finally { await f.close(); }
});
test('the lifetime native-attempt budget cannot be reset by denied requests or stop', async () => {
  const f = fixture(); try { for (let index = 0; index < 64; index++) { assert.equal((await f.provider.start({}, { purpose: 'denied' })).ok, false); f.provider.stop(); }
    assert.deepEqual(await f.provider.inspect(), { ok: false, reason: 'quota' }); assert.equal(f.opens(), 0); assert.equal(f.provider.snapshot().attempts, 64);
  } finally { await f.close(); }
});
test('actual Node has no camera API and is unsupported without a native acquisition', async () => {
  const runtime = createDeviceRuntime({ now: () => 100, authorize: () => undefined });
  const provider = api!.createBrowserCameraProvider({ runtime, now: () => 100, ownerSignal: new AbortController().signal,
    scope: { principalId: 'node', applicationId: 'negative', sessionId: 'local' }, authorizeCapture: () => undefined });
  try { assert.deepEqual(await provider.inspect(), { ok: false, reason: 'unsupported' }); assert.equal(provider.snapshot().rawPending, 0); assert.equal(provider.snapshot().activeSources, 0); }
  finally { await provider.close(); runtime.close(); }
});
test('a trusted factory effect without a returned handle cannot be reported as verified cleanup', async () => {
  const f = fixture();
  const environment: BrowserCameraEnvironment = { ...f.environment, createCanvas() { f.canvas.width = 8; throw Error('Owned native object was created but not returned'); } };
  const runtime = createDeviceRuntime({ now: () => 100, authorize: () => undefined }), capture = new AbortController();
  const provider = api!.createBrowserCameraProvider({ runtime, environment, now: () => 100, ownerSignal: new AbortController().signal,
    scope: { principalId: 'owner', applicationId: 'factory', sessionId: 'local' }, authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: 1100 }; } });
  try { const inspected = await provider.inspect(); assert.ok(inspected.ok); assert.equal((await provider.start(inspected.value[0]!.selection, { purpose: 'factory-failure' })).ok, false);
    assert.ok(provider.snapshot().cleanupFailures > 0); assert.equal(provider.snapshot().rawPending, 1); assert.equal(f.opens(), 0);
  } finally { await provider.close(); runtime.close(); f.canvas.width = 1; await f.close(); }
});


// These cooperative camera ports describe API-setting behavior, not optical/native-camera evidence.
test('camera zoom methods exist without creating capture or control effects', async () => {
  const f = fixture(); try { assert.equal(typeof f.provider.inspectControls, 'function'); assert.equal(typeof f.provider.bindZoom, 'function');
    assert.equal(f.opens(), 0); assert.equal(f.stream.track.constraints.length, 0); assert.equal(f.provider.controlStatus().rawPending, 0);
  } finally { await f.close(); }
});
function zoomFixture(change: Partial<BrowserCameraOptions> = {}) {
  const control = new AbortController(), connections = new Map<string, ReturnType<ReturnType<typeof fixture>['runtime']['route']>>();
  const f = fixture({ controlDeliveryLimits(context): BrowserCameraControlDeliveryLimits | undefined {
    const connection = connections.get(context.routeId), limits = connection?.limits();
    if (!connection || !limits || connection.status().state !== 'active' || !context.operationId) return;
    const operation = connection.operations().find(record => record.id === context.operationId && record.handlerResult === 'running');
    if (!operation) return;
    return { context, expiresAt: Math.min(limits.expiresAt, operation.deadline), maxAgeMs: Math.min(limits.maxAgeMs, 250), maxHz: Math.min(limits.maxHz, 2) };
  }, authorizeControl: request => ({ request, signal: control.signal, expiresAt: 1100 }), ...change });
  f.stream.track.range = { min: 1, max: 4, step: 0.5 }; f.stream.track.zoom = 1;
  function route(bound: BrowserCameraControlActivation) {
    const device = parseDeviceDescriptor({ ...bound.device, id: bound.device.id + ':source', capabilities: bound.device.capabilities.map(c => ({ ...c, kind: 'event' as const, permissions: ['subscribe'] })) });
    const source = f.runtime.registerSource({ device, capability: 'camera-zoom' }); f.runtime.setReadiness(source, 'available');
    const connection = f.runtime.route({ from: source, to: bound.sink, principalId: 'camera-owner', applicationId: 'camera-app', sessionId: 'camera-session', leaseMs: 1000, queueCapacity: 1 });
    connections.set(connection.id, connection); let operation = 0;
    return { connection, publish(value: unknown, deadline = f.at() + 250) { const result = f.runtime.publish(source, value, { operationId: String(++operation), deadline }); f.runtime.flush(); return result; } };
  }
  return { ...f, control, route };
}
test('control consent defaults deny and never replaces the current captured frame owner', async () => {
  const f = fixture(); f.stream.track.range = { min: 1, max: 4, step: 0.5 }; f.stream.track.zoom = 1;
  try { const active = await f.start(); assert.ok(f.provider.inspectControls(active).ok);
    assert.deepEqual(f.provider.bindZoom(active, { purpose: 'reviewed-zoom' }), { ok: false, reason: 'denied' });
    assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.stream.track.constraints.length, 0);
  } finally { await f.close(); }
});
test('only exact current issued camera activation can inspect or bind reported controls', async () => {
  const f = zoomFixture(), foreign = zoomFixture();
  try { const active = await f.start(), other = await foreign.start();
    for (const candidate of [{ ...active }, other, {} as BrowserCameraActivation]) { assert.equal(f.provider.inspectControls(candidate).ok, false); assert.equal(f.provider.bindZoom(candidate, { purpose: 'no-authority' }).ok, false); }
    f.provider.stop(); assert.equal(f.provider.inspectControls(active).ok, false); assert.equal(f.stream.track.constraints.length, 0);
  } finally { await f.close(); await foreign.close(); }
});
test('reported capability and control consent do not authorize an independently denied SDK invoke route', async () => {
  const f = zoomFixture(); try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'reviewed-zoom' }); assert.ok(bound.ok);
    const route = f.route(bound.value); assert.equal(route.connection.start().ok, false); route.publish(2); await turn();
    assert.equal(f.stream.track.constraints.length, 0); assert.equal(f.provider.snapshot().activeSources, 1);
  } finally { await f.close(); }
});
test('a separately approved real SDK subscribe-to-invoke route issues only the reviewed zoom payload', async () => {
  const f = zoomFixture(); f.enableZoomRoutes(); try { const active = await f.start(), report = f.provider.inspectControls(active); assert.ok(report.ok);
    assert.deepEqual(report.value.zoom, { state: 'reported', min: 1, max: 4, step: 0.5, current: 1 }); assert.equal(report.value.opticalVerification, false);
    const bound = f.provider.bindZoom(active, { purpose: 'reviewed-zoom' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    assert.ok(route.publish(2.5).ok); await turn(); assert.deepEqual(f.stream.track.constraints, [{ advanced: [{ zoom: 2.5 }] }]); assert.equal(f.stream.track.zoom, 2.5);
    assert.equal(f.provider.controlStatus().state, 'api-returned'); assert.equal(f.provider.controlStatus().reportedSetting, 2.5);
  } finally { await f.close(); }
});
test('missing, malformed and nonfinite native-shaped zoom facts never create a control endpoint', async () => {
  const cases = [undefined, { min: 4, max: 1, step: 0.5 }, { min: 1, max: Infinity, step: 0.5 }, { min: 1, max: 4, step: 0 }, { min: 0, max: 1025, step: 1 }, { min: 1, max: 4, step: 0.000001 }];
  for (const range of cases) { const f = zoomFixture(); f.stream.track.range = range; try { const active = await f.start(); const report = f.provider.inspectControls(active); assert.ok(report.ok); assert.equal(report.value.zoom.state, 'unsupported');
      assert.equal(f.provider.bindZoom(active, { purpose: 'no-reported-range' }).ok, false); assert.equal(f.provider.controlStatus().activeSinks, 0); assert.equal(f.stream.track.constraints.length, 0);
    } finally { await f.close(); } }
});
test('offstep, overrange, nonfinite and object values never issue a native setting', async () => {
  const f = zoomFixture(); f.enableZoomRoutes(); try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'reviewed-zoom' }); assert.ok(bound.ok);
    const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    for (const value of [1.25, 5, NaN, { zoom: 2 }, Object.defineProperty({}, 'zoom', { get() { throw Error('No caller accessor'); } })]) { route.publish(value); await turn(); }
    assert.equal(f.stream.track.constraints.length, 0);
  } finally { await f.close(); }
});
test('native range changes after consent retire the control before any mutation', async () => {
  const f = zoomFixture(); f.enableZoomRoutes(); try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'reviewed-zoom' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    f.stream.track.range = { min: 1, max: 3, step: 0.5 }; route.publish(2); await turn(); assert.equal(f.stream.track.constraints.length, 0); assert.equal(f.provider.controlStatus().activeSinks, 0);
    assert.equal(f.provider.snapshot().activeSources, 1, 'Unissued control invalidation preserves camera capture');
  } finally { await f.close(); }
});
for (const cause of ['authorizer', 'getter', 'final-clock'] as const) test('reentrant ' + cause + ' retirement cannot bind a late zoom sink', async () => {
  let stopClock = false;
  const f: ReturnType<typeof zoomFixture> = zoomFixture({ ...(cause === 'authorizer' ? { authorizeControl(request) { f.provider.stop(); return { request, signal: f.control.signal, expiresAt: 1100 }; } } : {}),
    ...(cause === 'final-clock' ? { now: () => { if (stopClock) f.provider.stop(); return 100; } } : {}) });
  try { const active = await f.start(); if (cause === 'getter') f.stream.track.onCapabilities = () => f.provider.stop(); if (cause === 'final-clock') stopClock = true;
    assert.equal(f.provider.bindZoom(active, { purpose: 'reentrant' }).ok, false); assert.equal(f.provider.controlStatus().activeSinks, 0); assert.equal(f.stream.track.constraints.length, 0);
  } finally { stopClock = false; await f.close(); }
});
test('final actual delivery observer clock advance to absolute capture expiry prevents native dispatch', async () => {
  const f = zoomFixture(); f.enableZoomRoutes(); const register = f.runtime.registerSink.bind(f.runtime);
  f.runtime.registerSink = provider => register(provider.capability !== 'camera-zoom' ? provider : { ...provider,
    apply(observation, context) { return provider.apply(observation, { ...context, isCurrent() { const current = context.isCurrent(); f.setAt(1100); return current; } }); } });
  try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'final-observer' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    route.publish(2); await turn(); assert.equal(f.stream.track.constraints.length, 0);
  } finally { f.runtime.registerSink = register; await f.close(); }
});
test('a native applyConstraints method getter that retires capture cannot issue a command', async () => {
  const f = zoomFixture(); f.enableZoomRoutes(); try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'method-getter' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    const method = f.stream.track.applyConstraints.bind(f.stream.track); Object.defineProperty(f.stream.track, 'applyConstraints', { get() { f.provider.stop(); return method; } });
    route.publish(2); await turn(); assert.equal(f.stream.track.constraints.length, 0);
  } finally { await f.close(); }
});
test('a genuine late returned control endpoint is unregistered once after registerSink reentrancy', async () => {
  const f = zoomFixture(), register = f.runtime.registerSink.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime); let issued: ReturnType<typeof register> | undefined, removed = 0;
  f.runtime.registerSink = provider => { const handle = register(provider); if (provider.capability === 'camera-zoom') { issued = handle; f.provider.stop(); } return handle; };
  f.runtime.unregister = handle => { if (handle === issued) removed++; return unregister(handle); };
  try { const active = await f.start(); assert.equal(f.provider.bindZoom(active, { purpose: 'late-registration' }).ok, false); assert.ok(issued); assert.equal(removed, 1); assert.equal(f.provider.controlStatus().activeSinks, 0);
  } finally { f.runtime.registerSink = register; f.runtime.unregister = unregister; await f.close(); }
});
for (const cause of ['stop', 'control-revoke', 'expiry'] as const) test('issued constraint retains raw work and close through ' + cause + ' until actual Promise settlement', async () => {
  const f = zoomFixture(), native = gate<void>(); f.enableZoomRoutes(); f.stream.track.applyGate = native.promise;
  try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'held-setting' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    route.publish(2); assert.equal(f.stream.track.constraints.length, 1);
    if (cause === 'stop') f.provider.stop(); else if (cause === 'control-revoke') f.control.abort(); else { f.setAt(1100); f.provider.sweep(); }
    assert.equal(f.provider.controlStatus().rawPending, 1); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.provider.controlStatus().state, 'uncertain');
    let settled = false; const closing = f.provider.close().then(() => { settled = true; }); await turn(); assert.equal(settled, false);
    native.resolve(); await closing; assert.equal(f.provider.controlStatus().rawPending, 0); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { native.resolve(); await f.close(); }
});
test('reentrant native issuance close sees its prepublished constraint reservation', async () => {
  const f = zoomFixture(), native = gate<void>(); f.enableZoomRoutes(); f.stream.track.applyGate = native.promise; let closing: Promise<void> | undefined, settled = false;
  f.stream.track.onApply = () => { closing = f.provider.close().then(() => { settled = true; }); };
  try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'factory-close' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    route.publish(2); await turn(); assert.ok(closing); assert.equal(settled, false); assert.equal(f.provider.controlStatus().rawPending, 1); native.resolve(); await closing; assert.equal(f.provider.controlStatus().rawPending, 0);
  } finally { native.resolve(); await f.close(); }
});

for (const bound of ['grant', 'reliable-operation'] as const) test('final controller clock observes the actual shorter ' + bound + ' deadline before native issuance', async () => {
  let advance = false;
  const f: ReturnType<typeof zoomFixture> = zoomFixture({ now: () => { if (advance) f.setAt(140); return f.at(); } }); f.enableZoomRoutes();
  try { const active = await f.start(), binding = f.provider.bindZoom(active, { purpose: 'narrow-actual-deadline' }); assert.ok(binding.ok);
    if (bound === 'grant') f.narrowRoutes(125); const route = f.route(binding.value); assert.ok(route.connection.start().ok); advance = true;
    route.publish(2, bound === 'reliable-operation' ? 125 : 350); await turn(); assert.equal(f.stream.track.constraints.length, 0);
    assert.equal(f.provider.controlStatus().rawPending, 0);
  } finally { advance = false; await f.close(); }
});
test('missing or copied exact delivered-context numeric limits deny native zoom by default', async () => {
  for (const kind of ['missing', 'copy'] as const) {
    const f = zoomFixture({ controlDeliveryLimits: kind === 'missing' ? undefined : context => ({ context: { ...context }, expiresAt: 1100, maxAgeMs: 250, maxHz: 2 }) }); f.enableZoomRoutes();
    try { const active = await f.start(), binding = f.provider.bindZoom(active, { purpose: 'numeric-bound-identity' }); assert.ok(binding.ok); const route = f.route(binding.value); assert.ok(route.connection.start().ok);
      route.publish(2); await turn(); assert.equal(f.stream.track.constraints.length, 0); assert.equal(f.provider.snapshot().activeSources, 1);
    } finally { await f.close(); }
  }
});


test('capture registration reentrancy retires its exact genuine late returned SDK source', async () => {
  // Test-only inherited capture selector: fixture() supplies no new control options,
  // so root can run it against the unchanged public/camera baseline first.
  const f = fixture(), register = f.runtime.registerSource.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime);
  let issued: ReturnType<typeof register> | undefined, removed = 0;
  f.runtime.registerSource = provider => { const source = register(provider); issued = source; f.provider.stop(); return source; };
  f.runtime.unregister = source => { if (source === issued) removed++; return unregister(source); };
  try { const starting = f.provider.start(await f.selection(), { purpose: 'late-capture-registration' }); await turn(); f.video.emit();
    assert.equal((await starting).ok, false); assert.ok(issued); assert.equal(f.runtime.setReadiness(issued, 'available').ok, false, 'Late owned source must actually be unregistered'); assert.equal(removed, 1);
  } finally { f.runtime.registerSource = register; f.runtime.unregister = unregister; await f.close(); }
});
test('copied, expired, widened, accessor and foreign-signal control grants produce no native effect', async () => {
  const grants: NonNullable<BrowserCameraOptions['authorizeControl']>[] = [
    request => ({ request: { ...request }, signal: new AbortController().signal, expiresAt: 1100 }),
    request => ({ request, signal: new AbortController().signal, expiresAt: 100 }),
    request => ({ request, signal: new AbortController().signal, expiresAt: 1101 }),
    request => ({ request, signal: {} as AbortSignal, expiresAt: 1100 }),
    request => Object.defineProperty({ request, expiresAt: 1100 }, 'signal', { enumerable: true, get() { throw Error('Caller accessor must remain unexecuted'); } }) as ReturnType<NonNullable<BrowserCameraOptions['authorizeControl']>>
  ];
  for (const authorizeControl of grants) { const f = zoomFixture({ authorizeControl });
    try { const active = await f.start(); assert.equal(f.provider.bindZoom(active, { purpose: 'denied-control' }).ok, false); assert.equal(f.stream.track.constraints.length, 0); assert.equal(f.provider.snapshot().activeSources, 1); assert.equal(f.provider.controlStatus().activeSinks, 0); }
    finally { await f.close(); }
  }
});
test('control lifetime admission cannot be reset by forged activations or capture Stop', async () => {
  const f = zoomFixture(); try { for (let i = 0; i < 32; i++) assert.equal(f.provider.inspectControls({} as BrowserCameraActivation).ok, false);
    f.provider.stop(); assert.deepEqual(f.provider.inspectControls({} as BrowserCameraActivation), { ok: false, reason: 'quota' }); assert.equal(f.stream.track.constraints.length, 0);
  } finally { await f.close(); }
});
test('native constraint rejection settles raw work while retiring the unusable command', async () => {
  const f = zoomFixture(); f.enableZoomRoutes(); try { const active = await f.start(), bound = f.provider.bindZoom(active, { purpose: 'native-api-reject' }); assert.ok(bound.ok); const route = f.route(bound.value); assert.ok(route.connection.start().ok);
    f.stream.track.applyGate = Promise.reject(new DOMException('', 'NotSupportedError')); route.publish(2); await turn();
    assert.equal(f.stream.track.constraints.length, 1); assert.equal(f.provider.controlStatus().rawPending, 0); assert.equal(f.provider.controlStatus().activeSinks, 0); assert.equal(f.provider.controlStatus().state, 'rejected');
  } finally { await f.close(); }
});

test('thrown cleanup of its genuine late returned zoom endpoint quarantines control admission', async () => {
  const f = zoomFixture(), register = f.runtime.registerSink.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime);
  let issued: ReturnType<typeof register> | undefined, cleanupCalls = 0;
  f.runtime.registerSink = provider => { const endpoint = register(provider); if (provider.capability === 'camera-zoom') { issued = endpoint; f.provider.stop(); } return endpoint; };
  f.runtime.unregister = endpoint => { if (endpoint === issued) { cleanupCalls++; throw Error('software-late-endpoint-cleanup-failed'); } return unregister(endpoint); };
  try {
    const active = await f.start(), result = f.provider.bindZoom(active, { purpose: 'late-endpoint-cleanup' });
    assert.equal(result.ok, false); assert.ok(issued); assert.equal(cleanupCalls, 1); assert.equal(f.stream.track.constraints.length, 0);
    assert.equal(f.provider.snapshot().cleanupFailures, 1, 'Unknown real endpoint cleanup must be recorded');
    assert.deepEqual(f.provider.inspectControls(active), { ok: false, reason: 'busy' });
    assert.deepEqual(f.provider.bindZoom(active, { purpose: 'quarantined-control' }), { ok: false, reason: 'busy' });
  } finally {
    f.runtime.registerSink = register; f.runtime.unregister = unregister;
    if (issued) unregister(issued); await f.close();
  }
});
