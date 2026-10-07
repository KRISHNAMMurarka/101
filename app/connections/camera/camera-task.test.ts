import test from 'node:test';
import assert from 'node:assert/strict';
import { runSoftwareCameraPanTilt } from '../../../examples/browser-resources/camera-controls.ts';
import type { BrowserCameraEnvironment } from '@101/connect';
import type { CameraTaskOptions } from './camera-task.ts';

const api = await import('./camera-task.ts').catch(() => undefined);
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test('local camera task is missing only after actual separately approved public pan and tilt caller effects', async () => {
  const prefix = await runSoftwareCameraPanTilt();
  assert.equal(prefix.positiveHardwareEvidence, false); assert.equal(prefix.pan.result, 'pass'); assert.equal(prefix.tilt.result, 'pass');
  for (const run of [prefix.pan, prefix.tilt]) {
    assert.equal(run.returned.control.state, 'api-returned'); assert.equal(run.returned.control.reportedSetting, -2.5);
    assert.equal(run.pending.rawPending, 1); assert.equal(run.cleanup.control.rawPending, 0);
    assert.equal(run.cleanup.frameCallbacks, 0); assert.equal(run.cleanup.producerTimers, 0); assert.equal(run.cleanup.trackEnded, true);
  }
  assert.equal(typeof api?.createLocalCameraTask, 'function', 'Missing local camera choice and independently reviewed preview/control task');
});

class Track extends EventTarget {
  kind = 'video'; readyState = 'live'; muted = false; id = 'owned-camera-track'; zoom = 1; pan = -1; tilt = 0; stops = 0;
  returned?: Promise<void>; calls: MediaTrackConstraints[] = [];
  stop() { this.readyState = 'ended'; this.stops++; }
  getSettings() { return { deviceId: 'selected-camera', width: 64, height: 48, zoom: this.zoom, pan: this.pan, tilt: this.tilt }; }
  getCapabilities() { return { zoom: { min: 1, max: 4, step: 0.5 }, pan: { min: -90, max: 90, step: 0.5 }, tilt: { min: -45, max: 45, step: 0.5 } }; }
  applyConstraints(payload: MediaTrackConstraints) {
    this.calls.push(payload); const first = payload.advanced?.[0] as Partial<Record<'zoom' | 'pan' | 'tilt', number>>;
    const keys = Object.keys(first); assert.equal(keys.length, 1); const axis = keys[0]; assert.ok(axis === 'zoom' || axis === 'pan' || axis === 'tilt');
    const value = first[axis]; assert.equal(typeof value, 'number'); assert.deepEqual(payload, { advanced: [{ [axis]: value }] });
    return (this.returned ?? Promise.resolve()).then(() => { this[axis] = value!; });
  }
}
class Stream { track = new Track(); getTracks() { return [this.track]; } }
class Video extends EventTarget {
  srcObject: unknown; muted = false; playsInline = false; readyState = 2; videoWidth = 64; videoHeight = 48; frames = 0; next = 0;
  pending = new Map<number, VideoFrameRequestCallback>();
  play() { return Promise.resolve(); } pause() {} remove() {}
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { const token = ++this.next; this.pending.set(token, callback); return token; }
  cancelVideoFrameCallback(token: number) { this.pending.delete(token); }
  emit(at: number) { const item = this.pending.entries().next().value; if (!item) return; this.pending.delete(item[0]); item[1](at, { mediaTime: ++this.frames / 10,
    presentedFrames: this.frames, width: 64, height: 48, expectedDisplayTime: at, presentationTime: at, processingDuration: 0 }); }
}
class Pixels { width = 8; height = 8; data = new Uint8ClampedArray(256).fill(255); }
class Canvas { width = 0; height = 0; getContext() { return { drawImage() {}, getImageData: () => new Pixels() }; } remove() {} }
function fixture(change: Partial<CameraTaskOptions> = {}) {
  let at = 100, inventories = 0, acquisitions = 0, preview = false;
  const owner = new AbortController(), stream = new Stream(), video = new Video(), canvas = new Canvas();
  const timers = new Map<number, () => void>(); let token = 0, inventoryReturn: Promise<readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]> | undefined;
  const environment: BrowserCameraEnvironment = { fixtureKind: 'software-fixture', target: new EventTarget(), document: new EventTarget(), mediaDevicesTarget: new EventTarget(),
    enumerateDevices() { inventories++; return inventoryReturn ?? Promise.resolve([{ kind: 'videoinput', deviceId: 'selected-camera' }]); },
    getUserMedia(value) { acquisitions++; assert.deepEqual(value, { audio: false, video: { deviceId: { exact: 'selected-camera' }, width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 10, max: 15 } } }); return Promise.resolve(stream as unknown as MediaStream); },
    createVideo: () => video as unknown as HTMLVideoElement, createCanvas: () => canvas as unknown as HTMLCanvasElement,
    MediaStream: Stream as unknown as typeof MediaStream, HTMLVideoElement: Video as unknown as typeof HTMLVideoElement,
    HTMLCanvasElement: Canvas as unknown as typeof HTMLCanvasElement, ImageData: Pixels as unknown as typeof ImageData,
    hidden: () => false, focused: () => true, secureContext: () => true };
  const task = api!.createLocalCameraTask({ owner: owner.signal, now: () => at, environment,
    setTimer(run) { const id = ++token; timers.set(id, run); return id; }, clearTimer(id) { timers.delete(id as number); }, onPreview(frame) { preview = frame !== undefined; }, ...change });
  async function choose() { const result = await task.inventory(); assert.ok(result.ok); assert.equal(result.value.length, 1); const review = task.reviewCapture(result.value[0]!); assert.ok(review.ok); return review.value; }
  function approve(review: Awaited<ReturnType<typeof choose>>) { for (const part of ['capture', 'source', 'preview'] as const) assert.ok(task.approveCapture(review, part).ok); }
  async function start() { const review = await choose(); approve(review); const started = task.start(review); await turn(); video.emit(at); assert.ok((await started).ok); return review; }
  function wake(ms = 100) { at += ms; const run = timers.values().next().value; if (run) { timers.clear(); run(); } }
  return { task, owner, stream, video, timers, choose, approve, start, wake, environment, setAt(value: number) { at = value; }, at: () => at,
    inventoryReturn(value: typeof inventoryReturn) { inventoryReturn = value; }, inventories: () => inventories, acquisitions: () => acquisitions, preview: () => preview };
}

test('construction is inert and an issued exact choice needs all three explicit preview approvals', async () => {
  const f = fixture(); try { assert.equal(f.inventories(), 0); assert.equal(f.acquisitions(), 0); assert.equal(f.timers.size, 0);
    const review = await f.choose(); assert.equal(f.acquisitions(), 0); assert.equal((await f.task.start({ ...review })).ok, false);
    assert.ok(f.task.approveCapture(review, 'capture').ok); assert.equal((await f.task.start(review)).ok, false);
    assert.ok(f.task.approveCapture(review, 'source').ok); assert.equal((await f.task.start(review)).ok, false); assert.equal(f.acquisitions(), 0);
    assert.ok(f.task.approveCapture(review, 'preview').ok); const starting = f.task.start(review); await turn(); f.video.emit(f.at()); assert.ok((await starting).ok);
    assert.equal(f.acquisitions(), 1); assert.equal(f.task.snapshot().phase, 'active'); assert.equal(f.stream.track.calls.length, 0);
  } finally { await f.task.close(); }
});
for (const axis of ['zoom', 'pan', 'tilt'] as const) test(axis + ' requires a current reported-facts review and three independent control approvals', async () => {
  const f = fixture(); try { await f.start(); const review = f.task.reviewControl(axis); assert.ok(review.ok);
    assert.equal(f.task.connectControl(review.value).ok, false); assert.ok(f.task.approveControl(review.value, 'control').ok);
    assert.equal(f.task.connectControl(review.value).ok, false); assert.ok(f.task.approveControl(review.value, 'source').ok);
    assert.equal(f.task.connectControl(review.value).ok, false); assert.ok(f.task.approveControl(review.value, 'target').ok);
    assert.ok(f.task.connectControl(review.value).ok); assert.equal(f.stream.track.calls.length, 0);
    assert.equal(f.task.setSetting(axis === 'zoom' ? 1.25 : -2.25).ok, false); assert.ok(f.task.setSetting(axis === 'zoom' ? 2.5 : -2.5).ok); await turn();
    assert.deepEqual(f.stream.track.calls, [{ advanced: [{ [axis]: axis === 'zoom' ? 2.5 : -2.5 }] }]);
    assert.equal(f.task.reviewControl(axis === 'zoom' ? 'pan' : 'zoom').ok, false, 'One reviewed setting per capture');
  } finally { await f.task.close(); }
});
test('unsupported native facts offer no setting and focus/exposure stay explicitly unavailable', async () => {
  const f = fixture(); f.stream.track.getCapabilities = () => ({ zoom: { min: 1, max: 4, step: 0.5 } } as ReturnType<typeof f.stream.track.getCapabilities>);
  try { await f.start(); const snapshot = f.task.snapshot(); assert.deepEqual(snapshot.controls.map(item => item.axis), ['zoom']); assert.equal(snapshot.focusSupported, false); assert.equal(snapshot.exposureSupported, false);
    assert.equal(f.task.reviewControl('pan').ok, false); assert.equal(f.task.reviewControl('tilt').ok, false); assert.equal(f.stream.track.calls.length, 0);
  } finally { await f.task.close(); }
});
test('Stop stays immediately authoritative while inventory is held and returns a stable true-settlement barrier', async () => {
  const f = fixture(), held = deferred<readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]>(); f.inventoryReturn(held.promise);
  const inventory = f.task.inventory(); await turn(); const stopped = f.task.stop(); assert.equal(f.task.stop(), stopped); assert.equal(f.task.snapshot().phase, 'stopping');
  let settled = false; void stopped.then(() => { settled = true; }); await turn(); assert.equal(settled, false); assert.equal(f.task.snapshot().rawPending > 0, true);
  assert.equal((await f.task.inventory()).ok, false); held.resolve([{ kind: 'videoinput', deviceId: 'selected-camera' }]); await inventory; await stopped;
  assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.acquisitions(), 0); assert.equal(f.timers.size, 0); await f.task.close();
});
test('Stop retains an actually issued control return, clears preview immediately and blocks replacement', async () => {
  const f = fixture(), held = deferred<void>();
  try { await f.start(); f.video.emit(f.at() + 100); f.wake(); assert.equal(f.preview(), true); const review = f.task.reviewControl('pan'); assert.ok(review.ok);
    for (const part of ['control', 'source', 'target'] as const) assert.ok(f.task.approveControl(review.value, part).ok);
    assert.ok(f.task.connectControl(review.value).ok); f.stream.track.returned = held.promise; assert.ok(f.task.setSetting(-2.5).ok); await turn(); assert.equal(f.stream.track.calls.length, 1);
    const stopped = f.task.stop(); assert.equal(f.preview(), false); assert.equal(f.task.snapshot().rawPending > 0, true); assert.equal((await f.task.inventory()).ok, false);
    let settled = false; void stopped.then(() => { settled = true; }); await turn(); assert.equal(settled, false);
    held.resolve(); await stopped; assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.video.pending.size, 0); assert.equal(f.timers.size, 0);
  } finally { held.resolve(); await f.task.close(); }
});
for (const cause of ['hidden', 'revoked', 'expiry', 'loss'] as const) test(cause + ' clears current preview and requires fresh selection/approvals', async () => {
  const f = fixture(); try { await f.start(); f.video.emit(f.at() + 100); f.wake(); assert.equal(f.preview(), true);
    if (cause === 'hidden') await f.task.stop('hidden'); else if (cause === 'revoked') await f.task.revokeCapture('preview');
    else if (cause === 'expiry') { f.setAt(30100); f.wake(0); await f.task.stop(); }
    else { f.stream.track.readyState = 'ended'; f.stream.track.dispatchEvent(new Event('ended')); f.wake(); await f.task.stop(); }
    assert.equal(f.preview(), false); assert.equal(f.task.snapshot().phase, 'stopped'); assert.equal(f.task.snapshot().captureReview, undefined);
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.video.pending.size, 0);
  } finally { await f.task.close(); }
});
test('notification reentry retires before late construction/inventory and no camera can acquire after Stop', async () => {
  let once = false;
  const f: ReturnType<typeof fixture> = fixture({ onChange() { if (!once && f.task.snapshot().phase === 'inventory') { once = true; void f.task.stop(); } } });
  try { assert.equal((await f.task.inventory()).ok, false); await f.task.stop(); assert.equal(f.acquisitions(), 0); assert.equal(f.task.snapshot().rawPending, 0); }
  finally { await f.task.close(); }
});
test('capture and control reviews are private epoch-bound handles and owner abort cannot auto-reacquire', async () => {
  const f = fixture(), other = fixture(); try { const one = await f.choose(), two = await other.choose();
    assert.equal(f.task.approveCapture(two, 'capture').ok, false); assert.equal(f.task.approveCapture({ ...one }, 'capture').ok, false);
    f.owner.abort(); await f.task.close(); assert.equal((await f.task.inventory()).ok, false); assert.equal(f.acquisitions(), 0);
  } finally { await f.task.close(); await other.task.close(); }
});

test('a delayed explicit camera approval remains inside the actually issued selection lifetime', async () => {
  const f = fixture();
  try {
    const review = await f.choose(); assert.equal(f.acquisitions(), 0);
    f.setAt(200); f.approve(review);
    const starting = f.task.start(review); await turn(); f.video.emit(f.at());
    const started = await starting; assert.ok(started.ok, 'Fresh delayed approval must fit the original provider selection deadline');
    assert.equal(f.acquisitions(), 1); assert.equal(f.task.snapshot().phase, 'active');
  } finally { await f.task.close(); }
});

test('a failed stale-preview clear retires the exact capture instead of leaving it active', async () => {
  let cleared = 0;
  const f = fixture({ onPreview(frame) { if (frame === undefined) { cleared++; throw new Error('owned output cannot clear'); } } });
  try {
    await f.start(); f.video.emit(f.at() + 100); f.wake();
    assert.equal(f.task.snapshot().previewVisible, true); assert.equal(f.stream.track.readyState, 'live');
    f.wake(300); await turn();
    assert.equal(cleared, 1); assert.equal(f.task.snapshot().cleanupUnconfirmed, true);
    assert.notEqual(f.task.snapshot().phase, 'active', 'A failed preview clear must retire current camera access');
    assert.equal(f.stream.track.readyState, 'ended'); assert.equal(f.video.pending.size, 0); assert.equal(f.timers.size, 0);
  } finally { await f.task.close(); }
});
