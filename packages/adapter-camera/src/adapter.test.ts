import assert from "node:assert/strict";
import test from "node:test";
import type { InputFrame } from "@101/input";
import type { HandLandmark, PoseLandmark } from "@101/vision";
import { HandInputAdapter, PoseInputAdapter } from "./index.ts";

function pose(): PoseLandmark[] {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  points[0] = { x: 0.5, y: 0.12, z: 0, visibility: 1 };
  points[11] = { x: 0.4, y: 0.34, z: 0, visibility: 1 };
  points[12] = { x: 0.6, y: 0.34, z: 0, visibility: 1 };
  points[23] = { x: 0.44, y: 0.6, z: 0, visibility: 1 };
  points[24] = { x: 0.56, y: 0.6, z: 0, visibility: 1 };
  points[25] = { x: 0.45, y: 0.75, z: 0, visibility: 1 };
  points[26] = { x: 0.55, y: 0.75, z: 0, visibility: 1 };
  points[27] = { x: 0.45, y: 0.94, z: 0, visibility: 1 };
  points[28] = { x: 0.55, y: 0.94, z: 0, visibility: 1 };
  return points;
}

test("camera-independent pose adapter emits normalized semantic frames", () => {
  const frames: InputFrame[] = [];
  const adapter = new PoseInputAdapter({ mirror: true, classifier: { autoCalibrationFrames: 1, smoothing: 1 } });
  adapter.start((frame) => frames.push(frame));
  adapter.ingestPose(pose(), 0);
  const moved = pose().map((point) => ({ ...point, x: point.x + 0.1 }));
  adapter.ingestPose(moved, 16);
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.source, "camera-pose");
  assert.ok((frames[1]?.axes?.bodyX ?? 0) < -0.5);
  assert.equal(frames[1]?.poses?.body.length, 132);
});

test("pose adapter publishes reusable combat actions without changing the camera boundary", () => {
  const adapter = new PoseInputAdapter({ mirror: false, classifier: { autoCalibrationFrames: 1, smoothing: 1, gestureCooldownMs: 80 } });
  adapter.start(() => undefined);
  adapter.ingestPose(pose(), 0);
  const guard = pose();
  guard[15] = { ...guard[15]!, x: .47, y: .35 };
  guard[16] = { ...guard[16]!, x: .53, y: .35 };
  const frame = adapter.ingestPose(guard, 100);
  assert.equal(frame.actions["combat.block"], true);
  assert.deepEqual(frame.vectors?.["combat.move"], { x: 0, y: 0 });
});

test("camera-independent hand adapter maps gestures to shared spell and swarm actions", () => {
  const frames: InputFrame[] = [];
  const adapter = new HandInputAdapter({ mirror: false, classifier: { smoothing: 1, stableFrames: 2 } });
  adapter.start((frame) => frames.push(frame));
  const hand = twoFingerHand();
  adapter.ingestHands([{ landmarks: hand, handedness: "right", confidence: .98 }], 0);
  const frame = adapter.ingestHands([{ landmarks: hand, handedness: "right", confidence: .98 }], 20);
  assert.equal(frame.source, "camera-hand");
  assert.equal(frame.actions["hand.twoFingers"], true);
  assert.equal(frame.actions["spell.cast.projectile"], true);
  assert.deepEqual(frame.vectors?.["swarm.command"], frame.vectors?.aim);
  assert.equal(frame.poses?.hand?.length, 63);
  assert.equal(frames.length, 2);
});

function twoFingerHand(): HandLandmark[] {
  const hand = Array.from({ length: 21 }, () => ({ x: .5, y: .65, z: 0 }));
  hand[0] = { x: .5, y: .85, z: 0 };
  hand[1] = { x: .46, y: .76, z: 0 }; hand[2] = { x: .43, y: .7, z: 0 }; hand[3] = { x: .55, y: .66, z: 0 }; hand[4] = { x: .62, y: .69, z: 0 };
  setFinger(hand, [5, 6, 7, 8], .41, true);
  setFinger(hand, [9, 10, 11, 12], .48, true);
  setFinger(hand, [13, 14, 15, 16], .55, false);
  setFinger(hand, [17, 18, 19, 20], .62, false);
  return hand;
}

function setFinger(hand: HandLandmark[], indices: number[], x: number, extended: boolean) {
  const ys = extended ? [.65, .49, .35, .21] : [.65, .57, .62, .67];
  indices.forEach((index, position) => { hand[index] = { x, y: ys[position]!, z: 0 }; });
}
