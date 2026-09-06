import assert from "node:assert/strict";
import test from "node:test";

import { POSE_LANDMARK, type PoseLandmark } from "./index.ts";
import { readSkeleton } from "./skeleton.ts";

/**
 * Build a pose from metric joint positions. MediaPipe's world frame has y growing downward and the
 * origin at the midpoint of the hips, so a standing person's shoulders sit at negative y.
 */
function pose(world: Partial<Record<keyof typeof POSE_LANDMARK, readonly [number, number, number]>>): PoseLandmark[] {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [name, [x, y, z]] of Object.entries(world)) {
    landmarks[POSE_LANDMARK[name as keyof typeof POSE_LANDMARK]] = { x, y, z, visibility: 1, world: { x, y, z } };
  }
  return landmarks;
}

const STANDING = {
  nose: [0, -0.7, 0] as [number, number, number],
  leftShoulder: [0.2, -0.5, 0], rightShoulder: [-0.2, -0.5, 0],
  leftHip: [0.1, 0, 0], rightHip: [-0.1, 0, 0],
  leftElbow: [0.22, -0.25, 0], rightElbow: [-0.22, -0.25, 0],
  leftWrist: [0.24, 0, 0], rightWrist: [-0.24, 0, 0],
  leftKnee: [0.1, 0.45, 0], rightKnee: [-0.1, 0.45, 0],
  leftAnkle: [0.1, 0.9, 0], rightAnkle: [-0.1, 0.9, 0],
} as const;

test("a body with no metric landmarks is unreadable, not guessed at", () => {
  // Every frame from a backend that does not produce world landmarks, and every frame with the body
  // out of shot. A caller that gets an answer needs to know it was measured.
  const flat: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  assert.equal(readSkeleton(flat), undefined);
});

test("standing reads as standing, with straight limbs", () => {
  const signals = readSkeleton(pose(STANDING))!;
  assert.equal(signals.posture, "standing");
  assert.ok(signals.joints.leftKnee > 2.9, "a straight leg is near π");
  assert.ok(Math.abs(signals.tilt) < 0.2, "an upright spine has almost no tilt");
  assert.ok(signals.uprightness > 0.6, "hip to head is the full standing height");
});

test("a bent knee is bent, and a crouch is not a sit", () => {
  // Knees bent and the head dropped: a crouch.
  const crouch = readSkeleton(pose({ ...STANDING, nose: [0, -0.35, 0],
    leftKnee: [0.1, 0.2, 0.3], rightKnee: [-0.1, 0.2, 0.3],
    leftAnkle: [0.1, 0.45, 0], rightAnkle: [-0.1, 0.45, 0] }))!;
  assert.ok(crouch.joints.leftKnee < 2.0, "a bent knee must read as bent");
  assert.equal(crouch.posture, "crouching");

  // The same bent knees with the head still high: sitting. Knees alone cannot tell these apart,
  // which is why the head height decides.
  const sitting = readSkeleton(pose({ ...STANDING, nose: [0, -0.72, 0],
    leftKnee: [0.1, 0.1, 0.4], rightKnee: [-0.1, 0.1, 0.4],
    leftAnkle: [0.1, 0.5, 0.4], rightAnkle: [-0.1, 0.5, 0.4] }))!;
  assert.equal(sitting.posture, "sitting");
});

test("lying down is read from the torso, whatever the legs do", () => {
  // Shoulders level with the hips and pushed forward: the spine is horizontal.
  const lying = readSkeleton(pose({ ...STANDING, nose: [0, 0, -0.7],
    leftShoulder: [0.2, 0, -0.5], rightShoulder: [-0.2, 0, -0.5],
    leftKnee: [0.1, 0, 0.45], rightKnee: [-0.1, 0, 0.45],
    leftAnkle: [0.1, 0, 0.9], rightAnkle: [-0.1, 0, 0.9] }))!;
  assert.equal(lying.posture, "lying");
});

test("turning away changes facing, which image space could never see", () => {
  const front = readSkeleton(pose(STANDING))!;
  // Rotated a quarter turn: the shoulder line now runs in z instead of x. In image space this is a
  // person getting narrower; in metres it is a person turning.
  const turned = readSkeleton(pose({ ...STANDING, leftShoulder: [0, -0.5, 0.2], rightShoulder: [0, -0.5, -0.2] }))!;
  const difference = Math.abs(turned.facing - front.facing);
  assert.ok(difference > 1.0, `facing should swing about a quarter turn, moved ${difference.toFixed(2)}rad`);
});

test("reach is the same number for a tall player and a short one", () => {
  const tall = readSkeleton(pose({ ...STANDING, leftElbow: [0.5, -0.5, 0], leftWrist: [0.9, -0.5, 0] }))!;
  const short = readSkeleton(pose({ ...STANDING, leftElbow: [0.35, -0.5, 0], leftWrist: [0.55, -0.5, 0] }))!;
  // Both arms are straight out; only the limb lengths differ. A raw distance would disagree.
  assert.ok(Math.abs(tall.leftArmReach - short.leftArmReach) < 0.01);
  assert.ok(tall.leftArmReach > 0.98, "a straight arm is fully extended");

  const tucked = readSkeleton(pose({ ...STANDING, leftElbow: [0.3, -0.4, 0], leftWrist: [0.22, -0.52, 0] }))!;
  assert.ok(tucked.leftArmReach < 0.7, "a folded arm is not extended");
});

test("an unseen limb reads as straight rather than as a gesture", () => {
  // A missing wrist must not produce a bent elbow, which is how an occluded arm would otherwise
  // fire whatever a game binds to "arm bent".
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured to omit it
  const { leftWrist, ...withoutWrist } = STANDING;
  const signals = readSkeleton(pose(withoutWrist))!;
  assert.equal(signals.joints.leftElbow, Math.PI);
  assert.equal(signals.leftArmReach, 0);
});
