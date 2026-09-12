import assert from "node:assert/strict";
import test from "node:test";

import { acquireFirstFrame, hasPicture, FIRST_FRAME_TIMEOUT_MS } from "./acquire.ts";
import { describeCameraFailure } from "./errors.ts";

/** Enough of a video element to drive the wait, with no DOM and no clock. */
function fakeVideo({ playResolves = true } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    videoWidth: 0,
    videoHeight: 0,
    addEventListener(type: string, fn: () => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn); },
    play: () => (playResolves ? Promise.resolve() : Promise.reject(new DOMException("blocked", "NotAllowedError"))),
    /** The camera starts producing a picture. */
    deliverFrame() {
      video.videoWidth = 640;
      video.videoHeight = 480;
      for (const fn of listeners.get("loadeddata") ?? []) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
  return video;
}

/** A clock the test drives, so a six second timeout does not take six seconds. */
function fakeClock() {
  let pending: (() => void) | undefined;
  return {
    setTimer: (callback: () => void) => { pending = callback; return 1; },
    clearTimer: () => { pending = undefined; },
    fire: () => { const run = pending; pending = undefined; run?.(); },
    armed: () => pending !== undefined,
  };
}

test("a camera that never produces a frame fails instead of waiting forever", async () => {
  /*
   * The bug this exists for. `video.play()` on a live MediaStream resolves when playback starts and
   * never settles at all if frames do not arrive — no error, no rejection, no event. Measured on a
   * real camera that granted a track and then delivered nothing: `videoWidth` still 0 and `play()`
   * still pending after eight seconds, with the setup stuck on "starting the camera" for as long as
   * the page was open.
   */
  const clock = fakeClock();
  const video = fakeVideo();
  const waiting = acquireFirstFrame(video as unknown as HTMLVideoElement, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await Promise.resolve();
  clock.fire();

  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof Error);
    // It reads as a camera in use, which is the usual cause and the one with an action attached.
    assert.equal(describeCameraFailure(error).failure, "in-use");
    return true;
  });
  assert.equal(video.listenerCount(), 0, "listeners were left attached after the failure");
});

test("a camera that does produce a frame resolves, and stops waiting", async () => {
  const clock = fakeClock();
  const video = fakeVideo();
  const waiting = acquireFirstFrame(video as unknown as HTMLVideoElement, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await Promise.resolve();
  video.deliverFrame();
  await waiting;
  assert.equal(clock.armed(), false, "the timeout was left running after success");
  assert.equal(video.listenerCount(), 0, "listeners were left attached after success");
});

test("play() resolving is not on its own a picture", async () => {
  /*
   * `play()` can resolve while `videoWidth` is still 0. Keying on it alone let the inference backend
   * initialize against a picture with no size, which is a different failure further downstream and a
   * much harder one to read.
   */
  const clock = fakeClock();
  const video = fakeVideo({ playResolves: true });
  let settled = false;
  const waiting = acquireFirstFrame(video as unknown as HTMLVideoElement, { setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    .then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, "resolved on play() alone, with no frame");
  video.deliverFrame();
  await waiting;
  assert.equal(settled, true);
});

test("a rejected play() surfaces now rather than after the timeout", async () => {
  const clock = fakeClock();
  const video = fakeVideo({ playResolves: false });
  await assert.rejects(
    acquireFirstFrame(video as unknown as HTMLVideoElement, { setTimer: clock.setTimer, clearTimer: clock.clearTimer }),
    (error: unknown) => {
      assert.equal(describeCameraFailure(error).failure, "denied");
      return true;
    },
  );
});

test("a camera already showing a picture is not waited on", async () => {
  const video = fakeVideo();
  video.videoWidth = 640; video.videoHeight = 480;
  assert.equal(hasPicture(video), true);
  await acquireFirstFrame(video as unknown as HTMLVideoElement, { setTimer: () => { throw new Error("should not arm a timer"); } });
});

test("the timeout is long enough for a slow camera to warm up", () => {
  // A cold external webcam can take a couple of seconds to deliver its first frame.
  assert.ok(FIRST_FRAME_TIMEOUT_MS >= 4_000, "too tight for a cold camera");
  assert.ok(FIRST_FRAME_TIMEOUT_MS <= 10_000, "long enough to read as broken");
});
