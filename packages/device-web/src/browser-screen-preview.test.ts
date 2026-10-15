import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserScreenPreviewEnvironment, BrowserScreenPreviewActivation, BrowserScreenPreviewOptions } from './browser-screen-preview.ts';

const api = await import('./browser-screen-preview.ts').catch(() => undefined);
test('a distinct approved screen preview source is available without a camera alias', () => {
  assert.equal(typeof api?.createBrowserScreenPreviewProvider, 'function', 'Missing selected screen preview provider');
});

class Track extends EventTarget { kind = 'video'; readyState = 'live'; muted = false; id = 'native-track'; stops = 0; width = 64; height = 48; surface: string | undefined = 'window'; cursor: string | undefined = 'never'; stop() { this.stops++; this.readyState = 'ended'; } getSettings() { return { width: this.width, height: this.height, displaySurface: this.surface, cursor: this.cursor }; } }
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
function fixture(change: Partial<BrowserScreenPreviewOptions> = {}) {
  let at = 100, opens = 0, approvals = 0, hidden = false, focused = true, gesture = true, allowed = true, released = 0, held: unknown;
  const owner = new AbortController(), capture = new AbortController(), video = new Video(), canvas = new Canvas(), stream = new Stream();
  const target = new EventTarget(), document = new EventTarget();
  let openGate: Promise<MediaStream> | undefined;
  const scope = { principalId: 'screen-owner', applicationId: 'screen-app', sessionId: 'screen-session' }, observations: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'screen-js-retrieval', authorize(request) { if (allowed && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: at + 1000, maxAgeMs: 250, maxHz: 10 }; } });
  const environment: BrowserScreenPreviewEnvironment = { fixtureKind: 'software-fixture', getDisplayMedia(constraints) { opens++; assert.deepEqual(constraints, { video: true, audio: false }); return openGate ?? Promise.resolve(stream as unknown as MediaStream); },
    createVideo: () => video as unknown as HTMLVideoElement, createCanvas: () => canvas as unknown as HTMLCanvasElement,
    MediaStream: Stream as unknown as typeof MediaStream, HTMLVideoElement: Video as unknown as typeof HTMLVideoElement, HTMLCanvasElement: Canvas as unknown as typeof HTMLCanvasElement, ImageData: Pixels as unknown as typeof ImageData,
    target, document, userActivation: () => gesture, hidden: () => hidden, focused: () => focused, secureContext: () => true };
  const provider = api!.createBrowserScreenPreviewProvider({ runtime, ownerSignal: owner.signal, scope, now: () => at, authorizeCapture(request) { approvals++; return { request, signal: capture.signal, expiresAt: at + 1000 }; }, environment, ...change });
  async function start() { const starting = provider.start({ purpose: 'selected-screen-preview' }); await turn(); video.emit(at); const result = await starting; assert.ok(result.ok); return result.value; }
  function bind(active: BrowserScreenPreviewActivation) { const device = parseDeviceDescriptor({ ...active.device, id: active.device.id + ':consumer', capabilities: active.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'screen-preview', apply(observation, context) { if (context.isCurrent() && !context.signal.aborted) { observations.push(observation); held = observation.value; } }, release() { held = undefined; released++; } }); runtime.setReadiness(sink, 'available'); const route = runtime.route({ from: active.source, to: sink, ...scope, leaseMs: 1000 }); return route; }
  return { provider, runtime, owner, capture, video, canvas, stream, environment, target, document, observations, start, bind,
    opens: () => opens, approvals: () => approvals, loseGesture() { gesture = false; }, held: () => held, released: () => released, setAt(value: number) { at = value; }, denyRoutes() { allowed = false; }, holdOpen(promise: Promise<MediaStream>) { openGate = promise; },
    sample() { at += 100; video.emit(at); runtime.flush(); }, hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }, blur() { focused = false; target.dispatchEvent(new Event('blur')); }, async close() { await provider.close(); runtime.close(); } };
}


test('arrival is inert and missing gesture never invokes consent or native chooser', async () => {
  const f = fixture(); try { assert.equal(f.opens(), 0); assert.equal(f.approvals(), 0); assert.equal(f.provider.snapshot().listeners, 0);
    f.loseGesture(); assert.deepEqual(await f.provider.start({ purpose: 'preview' }), { ok: false, reason: 'gesture-required' }); assert.equal(f.opens(), 0); assert.equal(f.approvals(), 0);
  } finally { await f.close(); }
});
test('the real SDK receives the worst 256-byte screen raster within its 4KiB envelope with distinct provenance', async () => {
  const f = fixture(); try { const active = await f.start(); assert.equal(active.device.capabilities[0]!.semantic, 'media:screen-preview-rgba8/1'); assert.equal(active.facts.displaySurface, 'window');
    assert.ok(f.bind(active).start().ok); f.sample(); const observation = f.observations.at(-1)!; assert.ok(observation);
    assert.equal(observation.clockDomain, 'screen-js-retrieval'); assert.equal(observation.timestamp, 200); assert.ok(JSON.stringify(observation).length <= 4096);
    const frame = observation.value as { rows: number[][] }; for (const row of frame.rows) assert.deepEqual(row, Array(32).fill(255));
    assert.equal(observation.provenance?.captureTimeKnown, false); assert.equal(observation.provenance?.factoryKind, 'software-fixture'); assert.equal(observation.provenance?.downsizedPreview, true);
    f.canvas.level = 0; f.sample(); assert.equal((f.observations.at(-1)!.value as { rows: number[][] }).rows[0]![0], 0);
  } finally { await f.close(); }
});
test('native facts absent remain unknown and a resize retires before any new pixel read', async () => {
  const f = fixture(); f.stream.track.surface = undefined; f.stream.track.cursor = undefined;
  try { const active = await f.start(); assert.equal(active.facts.displaySurface, 'unknown'); assert.equal(active.facts.cursor, 'unknown'); assert.ok(f.bind(active).start().ok);
    f.stream.track.width = 80; f.video.videoWidth = 80; f.sample(); assert.equal(f.canvas.reads, 0); assert.equal(f.provider.snapshot().reason, 'changed'); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { await f.close(); }
});
test('capture approval cannot substitute for an independently denied runtime resource route', async () => {
  const f = fixture(); try { const active = await f.start(); f.denyRoutes(); assert.equal(f.bind(active).start().ok, false); f.sample(); assert.equal(f.observations.length, 0); } finally { await f.close(); }
});
test('a consent callback losing activation or stopping cannot open the native chooser', async () => {
  for (const action of ['gesture', 'stop'] as const) { const f = fixture({ authorizeCapture(request) { if (action === 'gesture') f.loseGesture(); else f.provider.stop(); return { request, signal: f.capture.signal, expiresAt: 1100 }; } });
    try { assert.equal((await f.provider.start({ purpose: 'reentrant' })).ok, false); assert.equal(f.opens(), 0); } finally { await f.close(); }
  }
});
test('request descriptor reentry is refused before any second authorization', async () => {
  const f = fixture(); let nested: ReturnType<typeof f.provider.start> | undefined;
  const request = new Proxy({ purpose: 'outer' }, { ownKeys(target) { nested = f.provider.start({ purpose: 'nested' }); return Reflect.ownKeys(target); } });
  try { const start = f.provider.start(request); await turn(); f.video.emit(); assert.ok((await start).ok); assert.deepEqual(await nested!, { ok: false, reason: 'busy' }); assert.equal(f.approvals(), 1); assert.equal(f.opens(), 1); }
  finally { await f.close(); }
});
test('copied or accessor grants issue no native chooser', async () => {
  const authorizers: BrowserScreenPreviewOptions['authorizeCapture'][] = [() => undefined, request => ({ request: { ...request }, signal: new AbortController().signal, expiresAt: 1100 }), request => Object.defineProperty({ request, expiresAt: 1100 }, 'signal', { get() { throw Error('No accessors'); } }) as ReturnType<BrowserScreenPreviewOptions['authorizeCapture']>];
  for (const authorizeCapture of authorizers) { const f = fixture({ authorizeCapture }); try { assert.equal((await f.provider.start({ purpose: 'denied' })).ok, false); assert.equal(f.opens(), 0); } finally { await f.close(); } }
});
for (const cause of ['stop', 'owner', 'capture', 'hide', 'blur', 'ended', 'mute'] as const) test(cause + ' releases real SDK input and only owned issued capture tracks', async () => {
  const f = fixture(); try { const active = await f.start(); assert.ok(f.bind(active).start().ok); f.sample(); assert.ok(f.held());
    if (cause === 'stop') f.provider.stop(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'capture') f.capture.abort(); else if (cause === 'hide') f.hide(); else if (cause === 'blur') f.blur(); else { if (cause === 'ended') f.stream.track.readyState = 'ended'; else f.stream.track.muted = true; f.stream.track.dispatchEvent(new Event(cause)); }
    assert.equal(f.held(), undefined); assert.ok(f.released()); assert.ok(f.stream.track.stops); assert.equal(f.video.pending.size, 0); assert.equal(f.canvas.width, 1); assert.equal(f.provider.snapshot().listeners, 0);
  } finally { await f.close(); }
});
test('a cancelled late chooser holds actual raw work and closes its late returned owned track', async () => {
  const f = fixture(), late = gate<MediaStream>(); let closed = false;
  try { f.holdOpen(late.promise); const starting = f.provider.start({ purpose: 'held' }); await turn(); f.provider.stop(); assert.equal((await starting).ok, false); assert.equal(f.provider.snapshot().rawPending, 1);
    const closing = f.provider.close(); assert.equal(f.provider.close(), closing); void closing.then(() => { closed = true; }); await turn(); assert.equal(closed, false);
    late.resolve(f.stream as unknown as MediaStream); await closing; assert.ok(f.stream.track.stops); assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.provider.snapshot().activeSources, 0);
  } finally { late.resolve(f.stream as unknown as MediaStream); await f.close(); }
});
test('close called from native acquisition waits the task reserved before its factory callout', async () => {
  const f = fixture(), late = gate<MediaStream>(); let closing: Promise<void> | undefined, settled = false;
  const environment: BrowserScreenPreviewEnvironment = { ...f.environment, getDisplayMedia() { closing = provider.close(); void closing.then(() => { settled = true; }); return late.promise; } };
  const provider = api!.createBrowserScreenPreviewProvider({ runtime: f.runtime, now: () => 100, ownerSignal: f.owner.signal, scope: { principalId: 'owner', applicationId: 'close', sessionId: 'local' }, authorizeCapture(request) { return { request, signal: f.capture.signal, expiresAt: 1100 }; }, environment });
  try { assert.equal((await provider.start({ purpose: 'reentrant-close' })).ok, false); await turn(); assert.equal(settled, false); late.resolve(f.stream as unknown as MediaStream); await closing; assert.equal(provider.snapshot().rawPending, 0); assert.ok(f.stream.track.stops); }
  finally { late.resolve(f.stream as unknown as MediaStream); await provider.close(); await f.close(); }
});
test('late native frame token after stop is cancelled exactly and partial listener add is removed', async () => {
  for (const cause of ['frame', 'listener'] as const) { const f = fixture(); if (cause === 'frame') f.video.onRequest = () => f.provider.stop(); else { const add = f.target.addEventListener.bind(f.target); f.target.addEventListener = (type, callback, options) => { if (type === 'blur') f.provider.stop(); add(type, callback, options); if (type === 'blur') throw Error('Partial install'); }; }
    try { assert.equal((await f.provider.start({ purpose: 'late-install' })).ok, false); await turn(); assert.equal(f.video.pending.size, 0); assert.equal(getEventListeners(f.target, 'blur').length, 0); assert.equal(f.provider.snapshot().rawPending, 0); }
    finally { await f.close(); }
  }
});
test('revocation during native raster retrieval and quiet expiry never publish late private pixels', async () => {
  for (const cause of ['pixels', 'expiry', 'clock'] as const) { const f = fixture(); try { const active = await f.start(); assert.ok(f.bind(active).start().ok);
    if (cause === 'pixels') { f.canvas.onRead = () => f.capture.abort(); f.sample(); } else { f.setAt(cause === 'expiry' ? 1101 : 99); f.provider.sweep(); }
    assert.equal(f.observations.length, 0); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.video.pending.size, 0);
  } finally { await f.close(); } }
});

test('a quiet held native play stays reserved through actual settlement after expiry', async () => {
  const f = fixture(), play = gate<void>();
  try { f.video.playGate = play.promise; const starting = f.provider.start({ purpose: 'held-play' }); await turn(); f.setAt(1101); f.provider.sweep();
    assert.deepEqual(await starting, { ok: false, reason: 'expired' }); assert.equal(f.provider.snapshot().rawPending, 1); play.resolve(); await turn(); assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.video.pending.size, 0);
  } finally { play.resolve(); await f.close(); }
});
test('the lifetime attempt ceiling survives denial and stop without a new native chooser', async () => {
  const f = fixture(); try { for (let index = 0; index < 32; index++) { assert.equal((await f.provider.start({ purpose: 'invalid purpose' })).ok, false); f.provider.stop(); }
    assert.deepEqual(await f.provider.start({ purpose: 'quota' }), { ok: false, reason: 'quota' }); assert.equal(f.opens(), 0); assert.equal(f.approvals(), 0);
  } finally { await f.close(); }
});

test('stop before a real registerSource returns unregisters the exact late endpoint once', async () => {
  const f = fixture(), register = f.runtime.registerSource.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime);
  let issued: ReturnType<typeof register> | undefined, unregisterCalls = 0;
  f.runtime.registerSource = options => { f.provider.stop(); issued = register(options); return issued; };
  f.runtime.unregister = handle => { if (handle === issued) unregisterCalls++; return unregister(handle); };
  try {
    const starting = f.provider.start({ purpose: 'late-real-registration' }); await turn(); f.video.emit();
    assert.equal((await starting).ok, false); await f.provider.close();
    assert.ok(issued, 'The actual public runtime must have returned its genuine source handle');
    assert.equal(unregisterCalls, 1, 'The late returned actual endpoint must be unregistered exactly once');
    assert.equal(f.runtime.setReadiness(issued, 'available').ok, false, 'The genuine runtime must refuse the retired endpoint');
    assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.provider.snapshot().activeSources, 0);
    assert.equal(f.video.pending.size, 0); assert.ok(f.stream.track.stops > 0);
  } finally {
    await f.provider.close(); f.runtime.registerSource = register; f.runtime.unregister = unregister; await f.close();
  }
});

test('final activation clock expiry prevents the actual chooser factory from being issued', async () => {
  const f = fixture(); let at = 100, activationReads = 0, approvals = 0;
  const environment: BrowserScreenPreviewEnvironment = { ...f.environment, userActivation() { if (++activationReads === 2) { at = 1100; f.setAt(at); } return true; } };
  const provider = api!.createBrowserScreenPreviewProvider({ runtime: f.runtime, now: () => at, ownerSignal: f.owner.signal,
    scope: { principalId: 'owner', applicationId: 'activation-clock', sessionId: 'local' }, environment,
    authorizeCapture(request) { approvals++; return { request, signal: f.capture.signal, expiresAt: 1100 }; } });
  try {
    assert.equal((await provider.start({ purpose: 'final-activation-expiry' })).ok, false);
    assert.equal(approvals, 1); assert.equal(activationReads, 2);
    assert.equal(f.opens(), 0, 'A true activation read cannot authorize a chooser after its callback reaches the exact capture expiry');
    await provider.close(); assert.equal(provider.snapshot().rawPending, 0); assert.equal(provider.snapshot().activeSources, 0);
  } finally { await provider.close(); await f.close(); }
});

function opaqueHostFailure(shape: 'revoked' | 'throwing-name' | 'denied' | 'ordinary-name'): unknown {
  if (shape === 'denied') return new DOMException('Capture blocked', 'NotAllowedError');
  if (shape === 'ordinary-name') { const error = new Error('Opaque host failure'); error.name = 'NotAllowedError'; return error; }
  const value = Proxy.revocable({}, {}); value.revoke();
  if (shape === 'revoked') return value.proxy;
  return Object.defineProperty(new DOMException('Unreadable host error', 'NotAllowedError'), 'name', { get() { throw value.proxy; } });
}

for (const shape of ['revoked', 'throwing-name', 'denied', 'ordinary-name'] as const) test(shape + ' screen raster error retires the real route and held frame', async () => {
  const f = fixture(), error = opaqueHostFailure(shape);
  try {
    const active = await f.start(); assert.ok(f.bind(active).start().ok); f.sample(); assert.ok(f.held());
    f.canvas.onRead = () => { throw error; };
    assert.doesNotThrow(() => f.sample());
    assert.equal(f.held(), undefined); assert.ok(f.released() > 0);
    assert.equal(f.provider.snapshot().reason, shape === 'denied' ? 'denied' : 'unavailable'); assert.equal(f.provider.snapshot().activeSources, 0);
    assert.equal(f.video.pending.size, 0); assert.ok(f.stream.track.stops > 0);
  } finally { await f.close(); }
});
