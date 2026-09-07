import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIRM_GRACE_MS,
  INITIAL_SETUP,
  SETUP_COPY,
  advanceSetup,
  canAdvance,
  type SetupEvent,
  type SetupState,
} from "./camera-setup.ts";
import { decodeCameraPlan, encodeCameraPlan, type CameraPlan } from "./camera-plan.ts";

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
});

test("going back never leaves the flow, and a gesture only counts while confirming", () => {
  const start = INITIAL_SETUP("body");
  assert.equal(run(start, { type: "back" }, { type: "back" }).step, "camera");
  assert.equal(run(start, { type: "gesture" }).step, "camera", "a gesture advanced the flow before the camera was on");
});

test("retry starts over but remembers that the player once chose to skip", () => {
  const state = run(INITIAL_SETUP("body"), { type: "camera-started" }, { type: "skip" }, { type: "retry" });
  assert.equal(state.step, "camera");
  assert.equal(state.skipped, true);
});

test("a plan survives the trip between two pages", () => {
  const plan: CameraPlan = { kind: "body", deviceId: "cam-42", mirror: true, poseModel: "/models/pose_landmarker_lite.task" };
  assert.deepEqual(decodeCameraPlan(encodeCameraPlan(plan)), plan);
  assert.deepEqual(decodeCameraPlan(encodeCameraPlan({ kind: "hands", mirror: false })), { kind: "hands", mirror: false });
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
