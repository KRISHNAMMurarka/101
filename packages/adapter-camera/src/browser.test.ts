import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { InputFrame } from "@101/input";
import type { PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { PoseLandmark } from "@101/vision";
import { BrowserCameraAdapter, BrowserHandAdapter, CameraLostError, MediaPipePoseBackend, type PoseVisionBackend } from "./index.ts";

function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
}

class Track extends EventTarget {
  stops = 0;
  readyState = "live";
  stop() { this.stops++; this.readyState = "ended"; }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}

function browser(t: TestContext) {
  const tracks: Track[] = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  let handle = 0;
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720, currentTime: 1, srcObject: null, play: async () => undefined, pause: () => undefined } as unknown as HTMLVideoElement;
  const mediaDevices = {
    enumerateDevices: async () => [{ kind: "videoinput", deviceId: "webcam", label: "Camera" }],
    getUserMedia: async () => {
      const first = new Track(); const second = new Track(); tracks.push(first, second);
      return { getTracks: () => [first, second] } as unknown as MediaStream;
    },
  };
  replaceGlobal(t, "navigator", { mediaDevices });
  replaceGlobal(t, "HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  replaceGlobal(t, "requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++handle, callback); return handle; });
  replaceGlobal(t, "cancelAnimationFrame", (id: number) => callbacks.delete(id));
  return {
    video, tracks, mediaDevices, callbacks,
    frame(now: number) { const [id, callback] = callbacks.entries().next().value!; callbacks.delete(id); video.currentTime++; callback(now); },
  };
}

function pose(center: number): PoseLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: center, y: .5, z: 0, visibility: 1 }));
  for (const [index, x, y] of [[11, -.06, .32], [12, .06, .32], [23, -.04, .58], [24, .04, .58], [15, -.1, .55], [16, .1, .55]]) {
    landmarks[index!] = { x: center + x!, y: y!, z: 0, visibility: 1 };
  }
  return landmarks;
}

test("the MediaPipe producer returns every pose with its matching metric landmarks", () => {
  const backend = new MediaPipePoseBackend({ maxPeople: 2 });
  const world = (shoulderScale: number) => pose(.5).map((point) => ({ x: (point.x - .5) * shoulderScale, y: point.y - .58, z: point.z, visibility: point.visibility }));
  const result = { landmarks: [pose(.2), pose(.8)], worldLandmarks: [world(1), world(1.5)] } satisfies Pick<PoseLandmarkerResult, "landmarks" | "worldLandmarks">;
  (backend as unknown as { landmarker: unknown }).landmarker = { detectForVideo: () => result };
  for (const world of result.worldLandmarks) {
    assert.ok(Math.abs((world[23]!.x + world[24]!.x) / 2) < 1e-10, "each body has its own metric hip origin");
  }
  const people = backend.detect({} as HTMLVideoElement, 1);
  assert.equal(people.length, 2);
  assert.equal(people[0]![11]!.x, .14);
  assert.ok(Math.abs(people[1]![11]!.world!.x + .09) < 1e-10);
});

for (const kind of ["pose", "hand"] as const) {
  test(`${kind} start failure rejects once and does not also call onError`, async (t) => {
    const env = browser(t); const failure = new Error("Permission denied"); const errors: Error[] = [];
    env.mediaDevices.getUserMedia = async () => { throw failure; };
    const options = { video: env.video, backend: { initialize: async () => undefined, detect: () => [], close: () => undefined }, onError: (error: Error) => errors.push(error) };
    const adapter = kind === "pose" ? new BrowserCameraAdapter(options) : new BrowserHandAdapter(options);
    await assert.rejects(adapter.start(() => undefined), (error) => error === failure);
    assert.deepEqual(errors, []);
    assert.equal(env.callbacks.size, 0);
    assert.equal(env.video.srcObject, null);
  });

  test(`${kind} checks actual cameras and reports track loss once across reconnects`, async (t) => {
    const env = browser(t); const losses: Error[] = []; const errors: Error[] = [];
    const options = { video: env.video, backend: { initialize: async () => undefined, detect: () => [], close: () => undefined }, onCameraLost: (error: CameraLostError) => losses.push(error), onError: (error: Error) => errors.push(error) };
    const adapter = kind === "pose" ? new BrowserCameraAdapter(options) : new BrowserHandAdapter(options);
    assert.equal(await adapter.refreshAvailability(), true);
    assert.equal(adapter.available, true);
    env.mediaDevices.enumerateDevices = async () => [];
    assert.equal(await adapter.refreshAvailability(), false);
    assert.equal(adapter.available, false);
    await adapter.start(() => undefined);
    env.tracks[0]!.end();
    env.tracks[1]!.end();
    assert.equal(losses.length, 1);
    assert.ok(losses[0] instanceof CameraLostError);
    assert.equal(env.callbacks.size, 0);
    assert.equal(env.video.srcObject, null);
    assert.equal(errors.length, 0);
    await adapter.start(() => undefined);
    adapter.stop();
    assert.equal(losses.length, 1, "intentional stop removes ended listeners before stopping tracks");
    await adapter.start(() => undefined);
    env.tracks.at(-1)!.end();
    assert.equal(losses.length, 2, "a fresh stream can report a fresh loss");
  });
}

test("one camera drives separate player frames and releases a missing player's actions", async (t) => {
  const env = browser(t); const frames: InputFrame[] = [];
  let poses = [pose(.2), pose(.8)];
  const backend: PoseVisionBackend = { initialize: async () => undefined, detect: () => poses, close: () => undefined };
  const adapter = new BrowserCameraAdapter({ video: env.video, backend, maxPeople: 2, mirror: false, classifier: { autoCalibrationFrames: 1, smoothing: 1 } });
  await adapter.start((frame) => frames.push(frame));
  env.frame(0);
  assert.deepEqual(frames.map((frame) => frame.playerId), ["player-1", "player-2"]);
  assert.notEqual(frames[0]!.deviceId, frames[1]!.deviceId);
  poses = [pose(.24), pose(.8)]; env.frame(50);
  assert.ok(frames.at(-2)!.axes!.bodyX! > .4);
  poses = [pose(.8)]; env.frame(100);
  assert.equal(frames.at(-2)!.playerId, "player-1");
  assert.equal(frames.at(-2)!.axes!.bodyX, 0);
  assert.ok(Object.values(frames.at(-2)!.actions).every((value) => value === false));
  adapter.stop();
  assert.equal(env.callbacks.size, 0);
});

test("quality selection never points the default camera at an absent model", (t) => {
  const env = browser(t);
  const adapter = new BrowserCameraAdapter({ video: env.video, quality: "precise" });
  assert.deepEqual(adapter.trackingProfile, { quality: "fast", poseModel: "/models/pose_landmarker_lite.task" });
  const provisioned = new BrowserCameraAdapter({ video: env.video, quality: "balanced", availablePoseModels: new Set(["/models/pose_landmarker_full.task"]) });
  assert.deepEqual(provisioned.trackingProfile, { quality: "balanced", poseModel: "/models/pose_landmarker_full.task" });
});

for (const kind of ["pose", "hand"] as const) {
  test(`${kind} reports one runtime failure until an actual successful frame recovers`, async (t) => {
    const env = browser(t); const errors: Error[] = []; let failed = true;
    const options = {
      video: env.video,
      backend: { initialize: async () => undefined, detect: () => { if (failed) throw new Error("inference failed"); return []; }, close: () => undefined },
      onError: (error: Error) => errors.push(error),
    };
    const adapter = kind === "pose" ? new BrowserCameraAdapter(options) : new BrowserHandAdapter(options);
    await adapter.start(() => undefined);
    env.frame(0); env.frame(50); env.frame(100);
    assert.equal(errors.length, 1);
    failed = false; env.frame(150);
    failed = true; env.frame(200);
    assert.equal(errors.length, 2);
    adapter.stop();
  });

  test(`${kind} stopping during permission request closes the late stream`, async (t) => {
    const env = browser(t); let resolve!: (stream: MediaStream) => void;
    env.mediaDevices.getUserMedia = () => new Promise((done) => { resolve = done; });
    const options = { video: env.video, backend: { initialize: async () => undefined, detect: () => [], close: () => undefined } };
    const adapter = kind === "pose" ? new BrowserCameraAdapter(options) : new BrowserHandAdapter(options);
    const start = adapter.start(() => undefined);
    adapter.stop();
    const track = new Track(); resolve({ getTracks: () => [track] } as unknown as MediaStream);
    await assert.rejects(start, { name: "AbortError" });
    assert.equal(track.stops, 1);
    assert.equal(env.video.srcObject, null);
    assert.equal(env.callbacks.size, 0);
  });

  test(`${kind} a restart waits for cancelled initialization to release its backend`, async (t) => {
    const env = browser(t); let finish!: () => void; let initialized!: () => void;
    const began = new Promise<void>((resolve) => { initialized = resolve; });
    let calls = 0; let open = false;
    const options = { video: env.video, backend: {
      initialize: async () => { calls++; if (calls === 1) { initialized(); await new Promise<void>((resolve) => { finish = resolve; }); } open = true; },
      detect: () => [], close: () => { open = false; },
    } };
    const adapter = kind === "pose" ? new BrowserCameraAdapter(options) : new BrowserHandAdapter(options);
    const first = adapter.start(() => undefined);
    await began;
    const cancelled = assert.rejects(first, { name: "AbortError" });
    const second = adapter.start(() => undefined);
    finish();
    await cancelled; await second;
    assert.equal(calls, 2);
    assert.equal(open, true);
    assert.equal(env.callbacks.size, 1);
    adapter.stop();
  });
}


test("the track fixture models native stop without an ended event", () => {
  const track = new Track(); let ended = 0;
  track.addEventListener("ended", () => { ended++; });
  track.stop();
  assert.equal(track.readyState, "ended");
  assert.equal(ended, 0);
});
