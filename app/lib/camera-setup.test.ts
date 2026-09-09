import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  CONFIRM_GRACE_MS,
  CONFIRM_ALTERNATIVE_MS,
  INITIAL_SETUP,
  SETUP_COPY,
  advanceSetup,
  canAdvance,
  confirmsCameraGesture,
  type SetupEvent,
  type SetupState,
} from "./camera-setup.ts";
import { cameraRequested, decodeCameraPlan, encodeCameraPlan, resolveCameraPreferences, type CameraPlan } from "./camera-plan.ts";
import { createSimulatedPose, HandGestureClassifier, PoseClassifier } from "@101/vision";
import { detectLocalCapabilities, localInputSources, refreshLocalCameras } from "./local-capabilities.ts";
import { observeCanvasViewport } from "../components/camera/canvas-viewport.ts";

const run = (state: SetupState, ...events: SetupEvent[]) => events.reduce(advanceSetup, state);

test("the flow runs camera, place, check, confirm, ready", () => {
  const steps: string[] = [];
  let state = INITIAL_SETUP("body");
  for (const event of [
    { type: "camera-started" },
    { type: "continue" },
    { type: "placement-held" },
    { type: "gesture" },
  ] as SetupEvent[]) {
    state = advanceSetup(state, event);
    steps.push(state.step);
  }
  assert.deepEqual(steps, ["place", "check", "confirm", "ready"]);
  assert.equal(state.skipped, false);
});

test("someone already standing correctly is not made to watch the check", () => {
  // But the check is still reachable forwards. When one event did both jobs it stepped over `check`
  // entirely, which left that beat enterable only by falling backwards out of the confirmation.
  const early = run(INITIAL_SETUP("body"), { type: "camera-started" }, { type: "placement-held" });
  assert.equal(early.step, "check");
  assert.equal(advanceSetup(early, { type: "placement-held" }).step, "confirm");
});

test("a camera that fails after it was working sends the player back to the camera beat", () => {
  // A permission can be revoked, a lid can close and a webcam can be unplugged at any moment,
  // including after the check has passed. A flow that only handled failure at the start would leave
  // someone confirming a gesture to a camera that is no longer there.
  for (const step of ["place", "check", "confirm", "ready"] as const) {
    const path: SetupEvent[] = [{ type: "camera-started" }, { type: "continue" }, { type: "placement-held" }, { type: "gesture" }];
    const upTo = { place: 1, check: 2, confirm: 3, ready: 4 }[step];
    const state = run(INITIAL_SETUP("body"), ...path.slice(0, upTo));
    assert.equal(state.step, step, `could not reach ${step}`);
    const lost = advanceSetup(state, { type: "camera-lost" });
    assert.equal(lost.step, "camera", `a camera lost during ${step} did not interrupt it`);
    assert.equal(lost.failure, "in-use");
    assert.equal(canAdvance(lost), false, "the player could move on with no camera");
  }
});

test("a confirmation does not outlive the framing it confirms", () => {
  /*
   * Raising both hands above your head is a big enough movement to walk you out of a tight frame, so
   * a brief lapse during the gesture is the gesture. A long one is someone who has left — and
   * confirming a framing that no longer exists drops them into a game that cannot see them, having
   * just told them it could.
   */
  const confirming = run(INITIAL_SETUP("body"), { type: "camera-started" }, { type: "continue" }, { type: "placement-held" });
  assert.equal(confirming.step, "confirm");

  const blip = run(confirming, { type: "placement", issue: "cut-off-torso", elapsedMs: CONFIRM_GRACE_MS - 100 });
  assert.equal(blip.step, "confirm", "a momentary lapse during the gesture cancelled it");
  const recovered = advanceSetup(blip, { type: "placement", issue: undefined, elapsedMs: 33 });
  assert.equal(recovered.brokenForMs, 0, "the lapse was not forgiven once the framing came back");

  const gone = run(
    confirming,
    { type: "placement", issue: "nobody", elapsedMs: 500 },
    { type: "placement", issue: "nobody", elapsedMs: 500 },
  );
  assert.equal(gone.step, "check", "confirmed a framing the player had walked out of");
});

test("a skip is recorded as a skip, not as a pass", () => {
  // A game that knows the check never ran can say so if tracking then goes badly, instead of
  // insisting the camera was set up correctly.
  const skipped = run(INITIAL_SETUP("hands"), { type: "camera-started" }, { type: "skip" });
  assert.equal(skipped.step, "ready");
  assert.equal(skipped.skipped, true);
  assert.equal(canAdvance(skipped), false, "a skipped check must return to control choice, not start the camera game");
});

test("retry changes the acquisition attempt so a failed camera can actually restart", () => {
  const failed = run(INITIAL_SETUP("body"), { type: "camera-failed", failure: "denied" });
  const retried = advanceSetup(failed, { type: "retry" });
  const first = (failed as SetupState & { attempt: number }).attempt;
  const next = (retried as SetupState & { attempt: number }).attempt;
  assert.ok(Number.isInteger(next) && next > first);
});

test("a failed check cannot advance from a late gesture", () => {
  const failed = { ...INITIAL_SETUP("body"), step: "confirm" as const, failure: "denied" as const };
  assert.equal(advanceSetup(failed, { type: "gesture" }).step, "confirm");
});

test("camera plans reject invalid person counts rather than dropping the field", () => {
  for (const maxPeople of [0, 5, 1.5, "2", null]) {
    assert.equal(decodeCameraPlan(JSON.stringify({ v: 1, kind: "body", mirror: true, maxPeople })), undefined);
  }
});

test("going back never leaves the flow, and a gesture only counts while confirming", () => {
  const start = INITIAL_SETUP("body");
  assert.equal(run(start, { type: "back" }, { type: "back" }).step, "camera");
  assert.equal(run(start, { type: "gesture" }).step, "camera", "a gesture advanced the flow before the camera was on");
});

test("retry starts a new unskipped attempt", () => {
  const state = run(INITIAL_SETUP("body"), { type: "camera-started" }, { type: "skip" }, { type: "retry" });
  assert.equal(state.step, "camera");
  assert.equal(state.skipped, false);
});

test("a plan survives the trip between two pages", () => {
  const plan: CameraPlan = { kind: "body", deviceId: "cam-42", mirror: true, poseModel: "/models/pose_landmarker_lite.task", maxPeople: 2 };
  assert.deepEqual(decodeCameraPlan(encodeCameraPlan(plan)), plan);
  assert.deepEqual(decodeCameraPlan(encodeCameraPlan({ kind: "hands", mirror: false })), { kind: "hands", mirror: false });
});

test("confirmation uses game gestures rather than a body merely being visible", () => {
  const classifier = new PoseClassifier({ autoCalibrationFrames: 1, smoothing: 1 });
  const pose = createSimulatedPose({ x: 0, duck: false, jump: false, arms: false, punch: false });
  const neutral = classifier.process(pose, 0);
  assert.equal(confirmsCameraGesture(neutral, false, false), false);
  const arms = classifier.process(createSimulatedPose({ x: 0, duck: false, jump: false, arms: true, punch: false }), 1_000);
  assert.equal(confirmsCameraGesture(arms, false, false), true);
  const held = { ...arms, combat: { ...arms.combat, special: false } };
  assert.equal(confirmsCameraGesture(held, true, false), false, "held arms must not manufacture a new rising edge");
  const step = { ...neutral, actions: { ...neutral.actions, stepLeft: true } };
  assert.equal(confirmsCameraGesture(step, false, false), false);
  assert.equal(confirmsCameraGesture(step, false, true), true);
  const noHand = new HandGestureClassifier().process([], 0);
  assert.equal(confirmsCameraGesture(noHand, false, true), false);
  assert.equal(confirmsCameraGesture({ ...noHand, gestures: { ...noHand.gestures, openPalm: true } }, false, false), true);
});

test("the alternative gesture becomes available at eight seconds and resets on a recheck", () => {
  const confirming = run(INITIAL_SETUP("body"), { type: "camera-started" }, { type: "continue" }, { type: "placement-held" });
  const before = advanceSetup(confirming, { type: "confirm-time", elapsedMs: CONFIRM_ALTERNATIVE_MS - 1 });
  assert.ok(before.confirmForMs < CONFIRM_ALTERNATIVE_MS);
  const after = advanceSetup(before, { type: "confirm-time", elapsedMs: CONFIRM_ALTERNATIVE_MS });
  assert.ok(after.confirmForMs >= CONFIRM_ALTERNATIVE_MS);
  const recheck = advanceSetup(after, { type: "placement", issue: "nobody", elapsedMs: CONFIRM_GRACE_MS + 1 });
  assert.equal(recheck.step, "check");
  assert.equal(recheck.confirmForMs, 0);
});

test("saved preferences require a current camera opt-in and a present device", () => {
  assert.equal(cameraRequested("?session=room", "body"), false);
  assert.equal(cameraRequested("?camera=hands", "body"), false);
  assert.equal(cameraRequested("?camera=body", "body"), true);
  const plan: CameraPlan = { kind: "body", mirror: false, deviceId: "gone", poseModel: "/models/pose_landmarker_lite.task", maxPeople: 4 };
  assert.deepEqual(resolveCameraPreferences("body", plan, [{ deviceId: "present" }], 2),
    { kind: "body", mirror: false, poseModel: plan.poseModel, maxPeople: 2 });
  assert.equal(resolveCameraPreferences("body", plan, [{ deviceId: "gone" }], 4).deviceId, "gone");
  assert.equal(resolveCameraPreferences("body", { ...plan, maxPeople: 1 }, [], 2).maxPeople, 1);
  assert.equal(resolveCameraPreferences("body", { ...plan, poseModel: "https://example.invalid/model" }, [], 2).poseModel, undefined);
  assert.deepEqual(resolveCameraPreferences("hands", plan, [], 4), { kind: "hands", mirror: true });
});

function replaceGlobal(context: TestContext, name: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  context.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
}

test("an API-only browser claims a camera only after real device enumeration", async (context) => {
  let cameras: { kind: string; deviceId: string }[] = [];
  const navigator = { mediaDevices: { getUserMedia() {}, enumerateDevices: async () => cameras }, getGamepads: () => [] };
  replaceGlobal(context, "navigator", navigator);
  replaceGlobal(context, "window", { navigator, matchMedia: () => ({ matches: false }) });
  await refreshLocalCameras();
  assert.equal(detectLocalCapabilities().camera, false);
  cameras = [{ kind: "videoinput", deviceId: "attached" }];
  await refreshLocalCameras();
  assert.equal(detectLocalCapabilities().camera, true);
  assert.deepEqual(localInputSources().filter((source) => source.startsWith("camera")), ["camera-hand", "camera-pose"]);
  cameras = [];
  await refreshLocalCameras();
  assert.equal(detectLocalCapabilities().camera, false);
});

test("overlay backing dimensions change only when its observed size changes", (context) => {
  let measurements = 0;
  let allocations = 0;
  let width = 0;
  let height = 0;
  let onResize: ResizeObserverCallback | undefined;
  let disconnected = false;
  const canvas = {
    get width() { return width; }, set width(value: number) { width = value; allocations++; },
    get height() { return height; }, set height(value: number) { height = value; allocations++; },
    getBoundingClientRect() { measurements++; return { width: 320, height: 240 }; },
  } as HTMLCanvasElement;
  replaceGlobal(context, "window", { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} });
  replaceGlobal(context, "ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  });
  const disconnect = observeCanvasViewport(canvas, () => {});
  const observer = {} as ResizeObserver;
  const entry: ResizeObserverEntry = {
    target: canvas,
    contentRect: { width: 320, height: 240, x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240, toJSON: () => ({}) },
    borderBoxSize: [{ inlineSize: 320, blockSize: 240 }],
    contentBoxSize: [{ inlineSize: 320, blockSize: 240 }],
    devicePixelContentBoxSize: [{ inlineSize: 640, blockSize: 480 }],
  };
  for (let frame = 0; frame < 60; frame++) onResize?.([entry], observer);
  assert.equal(measurements, 1);
  assert.equal(allocations, 2);
  onResize?.([{ ...entry, contentRect: { ...entry.contentRect, width: 400 } }], observer);
  assert.equal(width, 800);
  assert.equal(allocations, 3);
  disconnect();
  assert.equal(disconnected, true);
});

test("a plan that is not one this build wrote is dropped whole", () => {
  /*
   * Storage is editable, survives deploys, and outlives the code that wrote it. A half-applied plan
   * is worse than none: a valid deviceId beside a corrupted mirror flag puts the player in front of
   * a camera that reverses everything they do, which is harder to diagnose than being asked again.
   */
  for (const bad of [
    null, undefined, "", "{", "[]", '"body"',
    JSON.stringify({ v: 99, kind: "body", mirror: true }),
    JSON.stringify({ v: 1, kind: "elbows", mirror: true }),
    JSON.stringify({ v: 1, kind: "body" }),
    JSON.stringify({ v: 1, kind: "body", mirror: "yes" }),
    JSON.stringify({ v: 1, kind: "body", mirror: true, deviceId: 42 }),
  ]) {
    assert.equal(decodeCameraPlan(bad as string), undefined, `accepted ${String(bad)}`);
  }
});

test("no step's copy uses developer vocabulary", () => {
  const BANNED = /landmark|confidence|model|inference|threshold|calibrat|\bfps\b|%|camera-(pose|hand)|mediapipe|gpu/i;
  for (const [step, copy] of Object.entries(SETUP_COPY)) {
    assert.ok(copy.title.length > 2, `${step} has no title`);
    for (const [kind, sentence] of Object.entries(copy.body)) {
      assert.ok(sentence.length > 12, `${step}.${kind} is too short: ${sentence}`);
      assert.doesNotMatch(sentence, BANNED, `${step}.${kind} uses developer vocabulary: ${sentence}`);
    }
  }
});
