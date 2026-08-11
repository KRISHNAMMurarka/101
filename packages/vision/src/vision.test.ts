import assert from "node:assert/strict";
import test from "node:test";
import { flattenHand, flattenPose, HandGestureClassifier, mirrorPose, PoseClassifier, type HandLandmark, type PoseLandmark, type TrackedHand } from "./index.ts";

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

test("hand classifier stabilizes semantic poses before activation", () => {
  const classifier = new HandGestureClassifier({ smoothing: 1, stableFrames: 2, gestureCooldownMs: 100 });
  assert.deepEqual(classifier.process([tracked(openHand())], 0).activated, []);
  const open = classifier.process([tracked(openHand())], 20);
  assert.equal(open.gestures.openPalm, true);
  assert.deepEqual(open.activated, ["openPalm"]);

  classifier.process([], 160);
  classifier.process([tracked(twoFingerHand())], 180);
  const projectile = classifier.process([tracked(twoFingerHand())], 200);
  assert.equal(projectile.gestures.twoFingers, true);
  assert.ok(projectile.activated.includes("twoFingers"));
  assert.equal(flattenHand(projectile.hand!.landmarks).length, 63);
});

test("hand classifier recognizes a closed circle and directional swipe over time", () => {
  const circleClassifier = new HandGestureClassifier({ smoothing: 1, stableFrames: 1, gestureCooldownMs: 100 });
  let circleDetected = false;
  for (let index = 0; index <= 20; index += 1) {
    const hand = pointHand();
    const angle = index / 20 * Math.PI * 2;
    hand[8] = { x: .5 + Math.cos(angle) * .12, y: .43 + Math.sin(angle) * .12, z: 0 };
    circleDetected ||= circleClassifier.process([tracked(hand)], index * 55).activated.includes("circle");
  }
  assert.equal(circleDetected, true);

  const swipeClassifier = new HandGestureClassifier({ smoothing: 1, stableFrames: 1, gestureCooldownMs: 100 });
  let swipeDetected = false;
  for (let index = 0; index < 7; index += 1) {
    const shifted = openHand().map((landmark) => ({ ...landmark, x: landmark.x - index * .075 }));
    swipeDetected ||= swipeClassifier.process([tracked(shifted)], 1_500 + index * 35).activated.includes("swipeLeft");
  }
  assert.equal(swipeDetected, true);
});

function tracked(landmarks: HandLandmark[]): TrackedHand {
  return { landmarks, handedness: "right", confidence: .98 };
}

function openHand(): HandLandmark[] {
  const hand = Array.from({ length: 21 }, () => ({ x: .5, y: .65, z: 0 }));
  hand[0] = { x: .5, y: .85, z: 0 };
  hand[1] = { x: .46, y: .76, z: 0 }; hand[2] = { x: .42, y: .69, z: 0 }; hand[3] = { x: .34, y: .62, z: 0 }; hand[4] = { x: .24, y: .57, z: 0 };
  setFinger(hand, [5, 6, 7, 8], .41);
  setFinger(hand, [9, 10, 11, 12], .48);
  setFinger(hand, [13, 14, 15, 16], .55);
  setFinger(hand, [17, 18, 19, 20], .62);
  return hand;
}

function foldedHand(): HandLandmark[] {
  const hand = openHand();
  for (const [mcp, pip, dip, tip] of [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    hand[pip] = { ...hand[pip]!, y: .57 };
    hand[dip] = { ...hand[dip]!, y: .62 };
    hand[tip] = { ...hand[tip]!, y: .67 };
    hand[mcp] = { ...hand[mcp]!, y: .65 };
  }
  hand[2] = { x: .43, y: .7, z: 0 };
  hand[3] = { x: .55, y: .66, z: 0 };
  hand[4] = { x: .62, y: .69, z: 0 };
  return hand;
}

function twoFingerHand() {
  const hand = foldedHand();
  const open = openHand();
  for (const index of [5, 6, 7, 8, 9, 10, 11, 12]) hand[index] = { ...open[index]! };
  return hand;
}

function pointHand() {
  const hand = foldedHand();
  const open = openHand();
  for (const index of [5, 6, 7, 8]) hand[index] = { ...open[index]! };
  return hand;
}

function setFinger(hand: HandLandmark[], indices: number[], x: number) {
  const ys = [.65, .49, .35, .21];
  indices.forEach((index, position) => { hand[index] = { x, y: ys[position]!, z: 0 }; });
}
