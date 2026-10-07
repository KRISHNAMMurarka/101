import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createBrowserScreenPreviewPipeline } from '../../../examples/browser-resources/screen-preview.ts';
import type { BrowserScreenPreviewEnvironment } from '@101/connect';
import type { ScreenTaskOptions } from './screen-task.ts';

const api = await import('./screen-task.ts').catch(() => undefined);
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

/** Explicit cooperative realm only; no native display chooser, browser, camera or
 * screen device is invoked. Existing pipeline uses global ImageData, while the
 * provider checks the same declared fixture constructor. Restore exact preimage. */
class Pixels {
  readonly data: Uint8ClampedArray; readonly width: number; readonly height: number;
  constructor(data: Uint8ClampedArray, width = 8, height = 8) { this.data = new Uint8ClampedArray(data); this.width = width; this.height = height; }
}
const imagePreimage = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
Object.defineProperty(globalThis, 'ImageData', { configurable: true, writable: true, value: Pixels });
after(() => { if (imagePreimage) Object.defineProperty(globalThis, 'ImageData', imagePreimage); else Reflect.deleteProperty(globalThis, 'ImageData'); });
class Track extends EventTarget {
  kind = 'video'; readyState = 'live'; muted = false; id = 'owned-software-display-track'; stops = 0;
  width = 64; height = 48; surface: string | undefined = 'window'; cursor: string | undefined = 'never';
  stop() { this.stops++; this.readyState = 'ended'; }
  getSettings() { return { width: this.width, height: this.height, ...(this.surface === undefined ? {} : { displaySurface: this.surface }), ...(this.cursor === undefined ? {} : { cursor: this.cursor }) }; }
}
class Stream { track = new Track(); getTracks() { return [this.track]; } }
class Video extends EventTarget {
  srcObject: unknown; muted = false; playsInline = false; videoWidth = 64; videoHeight = 48; readyState = 2; frames = 0; next = 0;
  pending = new Map<number, VideoFrameRequestCallback>(); playReturn?: Promise<void>; detached = false;
  play() { return this.playReturn ?? Promise.resolve(); } pause() {} remove() { this.detached = true; }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { const token = ++this.next; this.pending.set(token, callback); return token; }
  cancelVideoFrameCallback(token: number) { this.pending.delete(token); }
  emit(at: number) { const entry = this.pending.entries().next().value; if (!entry) return; this.pending.delete(entry[0]); entry[1](at, {
    mediaTime: ++this.frames / 10, presentedFrames: this.frames, width: this.videoWidth, height: this.videoHeight,
    expectedDisplayTime: at, presentationTime: at, processingDuration: 0 }); }
}
class Canvas {
  width = 8; height = 8; level = 64; pixels = new Uint8ClampedArray(256); draws = 0; writes = 0; clears = 0; removed = false; failClear = false;
  getContext() { return { drawImage: () => { this.draws++; }, getImageData: () => new Pixels(new Uint8ClampedArray(256).fill(this.level)),
    putImageData: (image: Pixels) => { assert.equal(image.width, 8); assert.equal(image.height, 8); this.writes++; this.pixels.set(image.data); },
    clearRect: () => { this.clears++; if (this.failClear) throw Error('Owned display clear failed'); this.pixels.fill(0); } }; }
  remove() { this.removed = true; }
}
function ports() {
  let at = 100, opens = 0, videos = 0, pixelFactories = 0, gesture = true, hidden = false, focused = true;
  let openReturn: Promise<MediaStream> | undefined;
  const stream = new Stream(), video = new Video(), sampling = new Canvas(), preview = new Canvas(), target = new EventTarget(), document = new EventTarget();
  const environment: BrowserScreenPreviewEnvironment = { fixtureKind: 'software-fixture',
    getDisplayMedia(options) { opens++; assert.deepEqual(options, { video: true, audio: false }); return openReturn ?? Promise.resolve(stream as unknown as MediaStream); },
    createVideo() { videos++; return video as unknown as HTMLVideoElement; }, createCanvas() { pixelFactories++; return sampling as unknown as HTMLCanvasElement; },
    MediaStream: Stream as unknown as typeof MediaStream, HTMLVideoElement: Video as unknown as typeof HTMLVideoElement,
    HTMLCanvasElement: Canvas as unknown as typeof HTMLCanvasElement, ImageData: Pixels as unknown as typeof ImageData,
    target, document, userActivation: () => gesture, hidden: () => hidden, focused: () => focused, secureContext: () => true };
  async function first() { for (let attempt = 0; attempt < 20 && video.pending.size === 0; attempt++) await turn(); assert.ok(video.pending.size > 0, 'Actual issued first-frame callback'); video.emit(at); await turn(); }
  return { stream, video, sampling, preview, target, document, environment, now: () => at,
    setAt(value: number) { at = value; }, advance(ms: number) { at += ms; }, opens: () => opens, videos: () => videos, pixelFactories: () => pixelFactories,
    holdChooser(promise: Promise<MediaStream>) { openReturn = promise; }, loseGesture() { gesture = false; },
    hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }, blur() { focused = false; target.dispatchEvent(new Event('blur')); }, first };
}
async function existingPipelinePrefix() {
  const f = ports(), owner = new AbortController(), capture = new AbortController(); let approvals = 0, routes = 0;
  const end = f.now() + 10000;
  const pipeline = createBrowserScreenPreviewPipeline({ ownerSignal: owner.signal, environment: f.environment,
    preview: f.preview as unknown as HTMLCanvasElement, now: f.now,
    authorizeCapture(request) { approvals++; assert.equal(request.purpose, 'selected-local-screen-preview'); assert.equal(request.profile, 'browser-screen-preview/1'); assert.equal(request.capabilityId, 'screen-preview'); assert.equal(request.operation, 'subscribe'); return { request, signal: capture.signal, expiresAt: end }; },
    authorizeRoutes(request) { assert.equal(request.principalId, 'screen-owner'); assert.equal(request.applicationId, 'screen-example'); assert.equal(request.sessionId, 'screen-session');
      assert.equal(request.source.capabilityId, 'screen-preview'); assert.equal(request.sink.capabilityId, 'screen-preview'); assert.equal(request.sourceOperation, 'subscribe'); assert.equal(request.sinkOperation, 'write');
      routes++; return { expiresAt: end, maxAgeMs: 250, maxHz: 10 }; } });
  try {
    assert.equal(f.opens(), 0); const starting = pipeline.activate('selected-local-screen-preview'); await f.first(); const started = await starting; assert.ok(started.ok);
    assert.equal(started.value.device.capabilities[0]!.semantic, 'media:screen-preview-rgba8/1'); assert.equal(started.value.facts.displaySurface, 'window');
    f.advance(100); f.video.emit(f.now()); pipeline.tick(); await turn(); const first = pipeline.state(); assert.ok(first.latest); assert.equal(first.latest.clockDomain, 'screen-javascript-retrieval');
    assert.equal(first.latest.provenance?.captureTimeKnown, false); assert.equal(first.latest.provenance?.factoryKind, 'software-fixture');
    assert.equal(first.latest.provenance?.downsizedPreview, true); assert.ok(f.preview.writes > 0); assert.equal(f.preview.pixels.every(value => value === 64), true);
    f.sampling.level = 192; f.advance(100); f.video.emit(f.now()); pipeline.tick(); await turn(); assert.ok(pipeline.state().delivered > first.delivered); assert.equal(f.preview.pixels.every(value => value === 192), true);
    f.stream.track.width = 80; f.video.videoWidth = 80; f.advance(100); f.video.emit(f.now()); pipeline.tick(); await turn();
    assert.equal(pipeline.provider.snapshot().reason, 'changed'); assert.equal(pipeline.state().latest, undefined); assert.equal(f.preview.pixels.every(value => value === 0), true);
    assert.ok(pipeline.state().released > 0); assert.equal(approvals, 1); assert.equal(routes, 1);
  } finally { owner.abort(); await pipeline.close(); }
  assert.equal(pipeline.provider.snapshot().rawPending, 0); assert.equal(pipeline.provider.snapshot().framePending, 0);
  assert.equal(pipeline.provider.snapshot().listeners, 0); assert.equal(pipeline.provider.snapshot().expiryArmed, false); assert.equal(f.video.pending.size, 0);
  assert.equal(f.stream.track.readyState, 'ended'); assert.equal(f.video.srcObject, null); assert.equal(f.sampling.width, 1);
  assert.equal(getEventListeners(f.target, 'blur').length, 0); assert.equal(getEventListeners(f.document, 'visibilitychange').length, 0);

  const heldPorts = ports(), held = deferred<MediaStream>(), heldOwner = new AbortController(), heldCapture = new AbortController(); heldPorts.holdChooser(held.promise);
  const heldPipeline = createBrowserScreenPreviewPipeline({ ownerSignal: heldOwner.signal, environment: heldPorts.environment,
    preview: heldPorts.preview as unknown as HTMLCanvasElement, now: heldPorts.now,
    authorizeCapture: request => ({ request, signal: heldCapture.signal, expiresAt: heldPorts.now() + 10000 }), authorizeRoutes: () => undefined });
  let closing: Promise<void> | undefined;
  try { const opening = heldPipeline.activate('selected-local-screen-preview'); await turn(); assert.equal(heldPorts.opens(), 1);
    heldPipeline.stop(); assert.equal((await opening).ok, false); assert.equal(heldPipeline.provider.snapshot().rawPending, 1);
    closing = heldPipeline.close(); assert.equal(heldPipeline.close(), closing); let settled = false; void closing.then(() => { settled = true; }); await turn(); assert.equal(settled, false);
    held.resolve(heldPorts.stream as unknown as MediaStream); await closing;
    assert.equal(heldPipeline.provider.snapshot().rawPending, 0); assert.equal(heldPipeline.provider.snapshot().framePending, 0); assert.equal(heldPorts.video.pending.size, 0); assert.equal(heldPorts.stream.track.readyState, 'ended');
  } finally { held.resolve(heldPorts.stream as unknown as MediaStream); heldOwner.abort(); await (closing ?? heldPipeline.close()); }
}
test('local screen task is missing only after actual granted typed preview and true held-chooser cleanup', async () => {
  await existingPipelinePrefix(); assert.equal(typeof api?.createLocalScreenTask, 'function', 'Missing local separately reviewed brief screen-preview task');
});

function fixture(change: Partial<ScreenTaskOptions> = {}) {
  const f = ports(), owner = new AbortController(), timers = new Map<number, () => void>(); let token = 0;
  const task = api!.createLocalScreenTask({ owner: owner.signal, now: f.now, preview: f.preview as unknown as HTMLCanvasElement, environment: f.environment,
    setTimer(run) { const id = ++token; timers.set(id, run); return id; }, clearTimer(handle) { timers.delete(handle as number); }, ...change });
  function review() { const value = task.review(); assert.ok(value.ok); return value.value; }
  function approve(handle: ReturnType<typeof review>) { for (const part of ['capture', 'source', 'display'] as const) assert.ok(task.approve(handle, part).ok); }
  async function start() { const handle = review(); approve(handle); const opening = task.start(handle); await f.first(); assert.ok((await opening).ok); return handle; }
  function wake(ms = 100) { f.advance(ms); const run = timers.values().next().value; if (run) { timers.clear(); run(); } }
  async function sample() { f.advance(100); f.video.emit(f.now()); wake(0); await turn(); }
  return { ...f, task, owner, timers, review, approve, start, wake, sample };
}
test('arrival and review are inert; exact private review needs all three distinct approvals', async () => {
  const f = fixture(); try {
    assert.equal(f.opens(), 0); assert.equal(f.videos(), 0); assert.equal(f.pixelFactories(), 0); assert.equal(f.preview.writes, 0);
    const review = f.review(); assert.equal((await f.task.start({ ...review })).ok, false);
    assert.ok(f.task.approve(review, 'capture').ok); assert.equal((await f.task.start(review)).ok, false);
    assert.ok(f.task.approve(review, 'source').ok); assert.equal((await f.task.start(review)).ok, false); assert.equal(f.opens(), 0);
    assert.ok(f.task.approve(review, 'display').ok); const starting = f.task.start(review); await f.first(); assert.ok((await starting).ok); assert.equal(f.opens(), 1);
    assert.equal(f.task.snapshot().previewVisible, false, 'Capture readiness is not an active display sample'); await f.sample(); assert.equal(f.task.snapshot().previewVisible, true);
  } finally { await f.task.close(); }
});
test('a missing native gesture cannot invoke chooser; copied and cross-owner approvals cannot grant capture', async () => {
  const f = fixture(), other = fixture(); try {
    const review = f.review(), cross = other.review(); assert.equal(f.task.approve(cross, 'capture').ok, false); assert.equal(f.task.approve({ ...review }, 'capture').ok, false);
    f.approve(review); f.loseGesture(); assert.equal((await f.task.start(review)).ok, false); assert.equal(f.opens(), 0); assert.equal(f.preview.writes, 0);
  } finally { await f.task.close(); await other.task.close(); }
});
test('preview visibility needs an actual fresh retrieval-domain sample, not only capture readiness', async () => {
  const f = fixture(); try { await f.start(); assert.equal(f.task.snapshot().previewVisible, false); await f.sample(); assert.equal(f.task.snapshot().previewVisible, true);
    f.wake(300); assert.equal(f.task.snapshot().previewVisible, false); assert.equal(f.preview.pixels.every(value => value === 0), true);
    assert.equal(f.stream.track.readyState, 'live', 'Unknown/stale display does not imply a native track ended'); await f.sample(); assert.equal(f.task.snapshot().previewVisible, true);
  } finally { await f.task.close(); }
});
for (const phase of ['chooser', 'play'] as const) test('Stop during held ' + phase + ' keeps the actual return reserved and blocks replacement', async () => {
  const f = fixture(), held = deferred<MediaStream>(), play = deferred<void>(); if (phase === 'chooser') f.holdChooser(held.promise); else f.video.playReturn = play.promise;
  let stopped: Promise<void> | undefined;
  try {
    const review = f.review(); f.approve(review); const opening = f.task.start(review); await turn(); assert.equal(f.opens(), 1);
    stopped = f.task.stop(); assert.equal(f.task.stop(), stopped); assert.equal(f.task.snapshot().previewVisible, false); assert.equal(f.task.snapshot().rawPending > 0, true);
    let settled = false; void stopped.then(() => { settled = true; }); await turn(); assert.equal(settled, false); assert.equal(f.task.review().ok, false);
    held.resolve(f.stream as unknown as MediaStream); play.resolve(); await opening; await stopped;
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.video.pending.size, 0); assert.equal(f.stream.track.readyState, 'ended'); assert.equal(f.timers.size, 0);
  } finally { held.resolve(f.stream as unknown as MediaStream); play.resolve(); await (stopped ?? f.task.close()); await f.task.close(); }
});
for (const part of ['capture', 'source', 'display'] as const) test('removing ' + part + ' permission releases output and never auto-reopens', async () => {
  const f = fixture(); try { await f.start(); await f.sample(); assert.equal(f.task.snapshot().previewVisible, true);
    await f.task.revoke(part); assert.equal(f.task.snapshot().previewVisible, false); assert.equal(f.preview.pixels.every(value => value === 0), true); assert.equal(f.stream.track.readyState, 'ended');
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.opens(), 1); assert.equal(f.task.snapshot().review, undefined);
  } finally { await f.task.close(); }
});
for (const cause of ['hidden', 'resize', 'loss', 'expiry'] as const) test(cause + ' ends the brief selected preview and requires a fresh review', async () => {
  const f = fixture(); try {
    if (cause === 'hidden') { await f.start(); await f.sample(); f.hide(); }
    else { await f.start(); await f.sample(); if (cause === 'resize') { f.stream.track.width = 80; f.video.videoWidth = 80; await f.sample(); }
      else if (cause === 'loss') { f.stream.track.readyState = 'ended'; f.stream.track.dispatchEvent(new Event('ended')); }
      else { f.setAt(10100); } }
    f.wake(0); await f.task.stop(); assert.equal(f.task.snapshot().previewVisible, false); assert.equal(f.task.snapshot().rawPending, 0);
    assert.equal(f.task.snapshot().review, undefined); assert.equal(f.opens(), 1); assert.equal(f.video.pending.size, 0); assert.equal(f.timers.size, 0);
  } finally { await f.task.close(); }
});
test('the original10s approval deadline includes opening time and cannot renew from quiet/current samples', async () => {
  const f = fixture(); try { const review = f.review(); f.approve(review); f.advance(1000); const opening = f.task.start(review); await f.first(); assert.ok((await opening).ok);
    for (let index = 0; index < 80; index++) await f.sample(); assert.equal(f.now(), 9100); assert.equal(f.task.snapshot().previewVisible, true);
    f.setAt(10100); f.wake(0); await f.task.stop(); assert.equal(f.task.snapshot().previewVisible, false); assert.equal(f.stream.track.readyState, 'ended'); assert.equal(f.opens(), 1);
  } finally { await f.task.close(); }
});
test('expired review, pre-aborted owner and opening notification reentry issue no chooser', async () => {
  const f = fixture(); try { const review = f.review(); f.approve(review); f.setAt(5100); assert.equal((await f.task.start(review)).ok, false); assert.equal(f.opens(), 0); } finally { await f.task.close(); }
  const aborted = new AbortController(); aborted.abort(); const closed = fixture({ owner: aborted.signal }); try { assert.equal(closed.task.review().ok, false); assert.equal(closed.opens(), 0); } finally { await closed.task.close(); }
  const current: { value?: ReturnType<typeof fixture> } = {}; let stopped = false;
  const reentrant = fixture({ onChange() { if (current.value && !stopped && current.value.task.snapshot().phase === 'opening') { stopped = true; void current.value.task.stop(); } } }); current.value = reentrant;
  try { const review = reentrant.review(); reentrant.approve(review); assert.equal((await reentrant.task.start(review)).ok, false); await reentrant.task.stop(); assert.equal(reentrant.opens(), 0); }
  finally { await reentrant.task.close(); }
});
test('an independent display-clear failure cannot bypass native teardown', async () => {
  const f = fixture(); try { await f.start(); await f.sample(); f.preview.failClear = true; await f.task.stop();
    assert.equal(f.stream.track.readyState, 'ended'); assert.equal(f.video.pending.size, 0); assert.equal(f.task.snapshot().rawPending, 0);
    assert.equal(f.task.snapshot().cleanupUnconfirmed, true); assert.equal(f.task.review().ok, false);
  } finally { f.preview.failClear = false; await f.task.close(); }
});
test('surface and cursor facts remain unknown when absent; labels never identify or approve another surface', async () => {
  const f = fixture(); f.stream.track.surface = undefined; f.stream.track.cursor = undefined;
  try { await f.start(); assert.equal(f.task.snapshot().facts?.displaySurface, 'unknown'); assert.equal(f.task.snapshot().facts?.cursor, 'unknown');
    assert.equal(f.task.snapshot().previewVisible, false); assert.equal(f.opens(), 1);
  } finally { await f.task.close(); }
});
