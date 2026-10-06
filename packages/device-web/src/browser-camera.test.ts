import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserCameraEnvironment, BrowserCameraActivation, BrowserCameraOptions } from './browser-camera.ts';

const api = await import('./browser-camera.ts').catch(() => undefined);
test('an exact selected camera exposes a typed frame source instead of selection metadata', () => {
  assert.equal(typeof api?.createBrowserCameraProvider, 'function', 'Missing exact selected typed camera provider');
});

class Track extends EventTarget { kind = 'video'; readyState = 'live'; muted = false; id = 'native-track'; stops = 0; deviceId: string | undefined = 'selected-id'; stop() { this.stops++; this.readyState = 'ended'; } getSettings() { return { deviceId: this.deviceId, width: 64, height: 48 }; } }
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
  let at = 100, opens = 0, inspections = 0, hidden = false, focused = true, allowed = true, released = 0, held: unknown;
  const owner = new AbortController(), capture = new AbortController(), video = new Video(), canvas = new Canvas(), stream = new Stream();
  const target = new EventTarget(), document = new EventTarget(), mediaDevicesTarget = new EventTarget();
  const devices = [{ kind: 'videoinput', deviceId: 'default' }, { kind: 'videoinput', deviceId: 'communications' }, { kind: 'videoinput', deviceId: '' }, { kind: 'videoinput', deviceId: 'selected-id' }];
  let openGate: Promise<MediaStream> | undefined;
  const scope = { principalId: 'camera-owner', applicationId: 'camera-app', sessionId: 'camera-session' }, observations: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'camera-js-retrieval', authorize(request) { if (allowed && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: at + 1000, maxAgeMs: 250, maxHz: 10 }; } });
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
    opens: () => opens, inspections: () => inspections, held: () => held, released: () => released, setAt(value: number) { at = value; }, denyRoutes() { allowed = false; }, holdOpen(promise: Promise<MediaStream>) { openGate = promise; },
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
