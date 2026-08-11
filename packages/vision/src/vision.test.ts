import assert from "node:assert/strict";
import test from "node:test";
import { flattenPose, mirrorPose, PoseClassifier, type PoseLandmark } from "./index.ts";

function neutralPose(): PoseLandmark[] {
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.98 }));
  pose[0] = { x: 0.5, y: 0.16, z: 0, visibility: 0.98 };
  pose[11] = { x: 0.4, y: 0.34, z: 0, visibility: 0.98 };
  pose[12] = { x: 0.6, y: 0.34, z: 0, visibility: 0.98 };
  pose[15] = { x: 0.35, y: 0.56, z: 0, visibility: 0.98 };
  pose[16] = { x: 0.65, y: 0.56, z: 0, visibility: 0.98 };
  pose[23] = { x: 0.44, y: 0.59, z: 0, visibility: 0.98 };
  pose[24] = { x: 0.56, y: 0.59, z: 0, visibility: 0.98 };
  pose[25] = { x: 0.45, y: 0.75, z: 0, visibility: 0.98 };
  pose[26] = { x: 0.55, y: 0.75, z: 0, visibility: 0.98 };
  pose[27] = { x: 0.45, y: 0.94, z: 0, visibility: 0.98 };
  pose[28] = { x: 0.55, y: 0.94, z: 0, visibility: 0.98 };
  return pose;
}

function move(pose: PoseLandmark[], indices: number[], x: number, y: number) {
  for (const index of indices) pose[index] = { ...pose[index]!, x: pose[index]!.x + x, y: pose[index]!.y + y };
  return pose;
}

test("pose classifier calibrates once and derives bounded body actions", () => {
  const classifier = new PoseClassifier({ autoCalibrationFrames: 1, smoothing: 1 });
  assert.equal(classifier.process(neutralPose(), 0).calibrated, true);

  const duck = neutralPose();
  move(duck, [0, 11, 12, 13, 14, 15, 16], 0, 0.09);
  assert.equal(classifier.process(duck, 16).actions.duck, true);

  const jump = move(neutralPose(), [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28], 0, -0.08);
  assert.equal(classifier.process(jump, 32).actions.jump, true);

  const lean = neutralPose();
  move(lean, [0, 11, 12, 13, 14, 15, 16], -0.07, 0);
  assert.ok(classifier.process(lean, 48).axes.lean < -0.5);
});

test("raised arms and punch are classified from a temporal pose sequence", () => {
  const classifier = new PoseClassifier({ autoCalibrationFrames: 1, smoothing: 1, gestureCooldownMs: 100 });
  classifier.process(neutralPose(), 0);
  const arms = neutralPose();
  arms[15] = { ...arms[15]!, y: 0.18 };
  arms[16] = { ...arms[16]!, y: 0.18 };
  assert.equal(classifier.process(arms, 100).actions.armsRaised, true);
  const punch = neutralPose();
  punch[16] = { ...punch[16]!, x: 0.88, y: 0.32 };
  assert.equal(classifier.process(punch, 150).actions.punch, true);
});

test("pose serialization and mirroring preserve compact landmarks", () => {
  const pose = neutralPose();
  assert.equal(flattenPose(pose).length, 132);
  const mirrored = mirrorPose(pose);
  assert.equal(mirrored[11]?.x, 0.6);
  assert.equal(mirrored[12]?.x, 0.4);
});
