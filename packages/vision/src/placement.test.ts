import assert from "node:assert/strict";
import test from "node:test";

import { HAND_LANDMARK, POSE_LANDMARK, type HandLandmark, type PoseLandmark } from "./index.ts";
import {
  PLACEMENT_COPY,
  PLACEMENT_LIMITS,
  PLACEMENT_PRECEDENCE,
  PlacementGate,
  describePlacement,
  readBodyPlacement,
  readHandPlacement,
  type PlacementIssue,
} from "./placement.ts";

/**
 * A body standing at `centre` across the frame, filling `fill` of its height from head to hip.
 * `visible` names the regions the camera can see; anything omitted is behind a desk or out of shot.
 */
function body({ centre = 0.5, fill = 0.4, visible = ["head", "torso", "arms", "legs"] as string[] } = {}): PoseLandmark[] {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: centre, y: 0.5, z: 0, visibility: 0 }));
  const at = (index: number, x: number, y: number, region: string) => {
    landmarks[index] = { x, y, z: 0, visibility: visible.includes(region) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? 0.95 : 0.05 };
  };
  const hipY = 0.5 + fill / 2;
  const noseY = hipY - fill;
  at(POSE_LANDMARK.nose, centre, noseY, "head");
  at(POSE_LANDMARK.leftShoulder, centre - 0.06, noseY + fill * 0.45, "torso");
  at(POSE_LANDMARK.rightShoulder, centre + 0.06, noseY + fill * 0.45, "torso");
  at(POSE_LANDMARK.leftHip, centre - 0.05, hipY, "torso");
  at(POSE_LANDMARK.rightHip, centre + 0.05, hipY, "torso");
  at(POSE_LANDMARK.leftElbow, centre - 0.1, noseY + fill * 0.6, "arms");
  at(POSE_LANDMARK.rightElbow, centre + 0.1, noseY + fill * 0.6, "arms");
  at(POSE_LANDMARK.leftWrist, centre - 0.12, noseY + fill * 0.8, "arms");
  at(POSE_LANDMARK.rightWrist, centre + 0.12, noseY + fill * 0.8, "arms");
  at(POSE_LANDMARK.leftKnee, centre - 0.05, hipY + fill * 0.5, "legs");
  at(POSE_LANDMARK.rightKnee, centre + 0.05, hipY + fill * 0.5, "legs");
  at(POSE_LANDMARK.leftAnkle, centre - 0.05, hipY + fill * 0.7, "legs");
  at(POSE_LANDMARK.rightAnkle, centre + 0.05, hipY + fill * 0.7, "legs");
  return landmarks;
}

function hand({ centre = 0.5, size = 0.15 } = {}): HandLandmark[] {
  const landmarks: HandLandmark[] = Array.from({ length: 21 }, () => ({ x: centre, y: 0.5, z: 0 }));
  landmarks[HAND_LANDMARK.wrist] = { x: centre, y: 0.5 + size / 2, z: 0 };
  landmarks[HAND_LANDMARK.middleMcp] = { x: centre, y: 0.5 - size / 2, z: 0 };
  return landmarks;
}

test("a well framed body has nothing to say about it", () => {
  const reading = readBodyPlacement(body(), { light: { luma: 0.5, subjectLuma: 0.5 } });
  assert.deepEqual(reading.issues, []);
  assert.equal(reading.ok, true);
  assert.equal(describePlacement(reading), undefined);
});

test("someone framed head to knees passes, and a waist-up framing is named rather than dropped", () => {
  // The distinction the old confidence score could not make: a body whose legs are under a desk is
  // a framing note, not an absence. Reporting it as "nobody" sends the player to look for a camera
  // fault they do not have.
  const seated = readBodyPlacement(body({ visible: ["head", "torso", "arms"] }));
  assert.equal(seated.issues.includes("nobody"), false, "a visible upper body was treated as an empty room");
  assert.ok(seated.regions.torso > PLACEMENT_LIMITS.seen);
  assert.equal(seated.regions.legs < PLACEMENT_LIMITS.seen, true);

  const headToKnees = readBodyPlacement(body({ visible: ["head", "torso", "arms", "legs"] }));
  assert.deepEqual(headToKnees.issues, []);
});

test("legs are a requirement a game states, not a property of the camera", () => {
  /*
   * Dodging on your feet needs the whole body in shot; casting with your hands at a desk does not,
   * and demanding legs there would send a seated player backwards until they could no longer reach
   * anything. Without this, `cut-off-legs` had copy and a place in the order and was never raised —
   * a message the product could not produce, which is the same defect as an input nothing reads.
   */
  const seated = body({ visible: ["head", "torso", "arms"] });
  assert.deepEqual(readBodyPlacement(seated).issues, [], "a hands game complained about legs it does not need");
  assert.deepEqual(readBodyPlacement(seated, { needsLegs: true }).issues, ["cut-off-legs"]);
  assert.deepEqual(readBodyPlacement(body(), { needsLegs: true }).issues, []);
});

test("an empty picture is nobody, and a partial body is a partial body", () => {
  assert.deepEqual(readBodyPlacement([]).issues, ["nobody"]);
  const armOnly = readBodyPlacement(body({ visible: ["arms"] }));
  assert.equal(armOnly.issues[0], "cut-off-torso");
});

test("distance and drift are reported from the picture", () => {
  assert.equal(readBodyPlacement(body({ fill: 0.85 })).issues[0], "too-close");
  assert.equal(readBodyPlacement(body({ fill: 0.1 })).issues[0], "too-far");
  assert.ok(readBodyPlacement(body({ centre: 0.1 })).issues.includes("off-left"));
  assert.ok(readBodyPlacement(body({ centre: 0.9 })).issues.includes("off-right"));
});

test("a dark room outranks framing, and a backlit one is told apart from a dark one", () => {
  // A window behind someone raises the average brightness while leaving the person unlit, so a
  // brightness threshold alone reads the room as well lit and then complains about their position.
  const dark = readBodyPlacement(body({ centre: 0.1 }), { light: { luma: 0.05, subjectLuma: 0.04 } });
  assert.equal(dark.issues[0], "too-dark", "told someone to move while the room was too dark to see them");

  const backlit = readBodyPlacement(body(), { light: { luma: 0.8, subjectLuma: 0.2 } });
  assert.equal(backlit.issues[0], "backlit");

  const fine = readBodyPlacement(body(), { light: { luma: 0.8, subjectLuma: 0.75 } });
  assert.deepEqual(fine.issues, []);
});

test("no light sample is not a dark room", () => {
  // Brightness comes from the video element, not the model. A caller that has not sampled it must
  // get a framing verdict, not an invented complaint about the lighting.
  assert.deepEqual(readBodyPlacement(body()).issues, []);
});

test("hand size is measured in one unit, so a sideways hand is not a distant one", () => {
  // Both landmark axes are fractions of a different edge. Mixing them makes an upright hand measure
  // about a third larger than the same hand turned sideways on a 4:3 stream.
  const ASPECT = 4 / 3;
  const upright = readHandPlacement([hand({ size: 0.12 })], ASPECT);
  const sideways: HandLandmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  sideways[HAND_LANDMARK.wrist] = { x: 0.5 - 0.12 / 2 / ASPECT, y: 0.5, z: 0 };
  sideways[HAND_LANDMARK.middleMcp] = { x: 0.5 + 0.12 / 2 / ASPECT, y: 0.5, z: 0 };

  const turned = readHandPlacement([sideways], ASPECT);
  assert.ok(Math.abs(upright.fill - turned.fill) < 0.005, `the same hand measured ${upright.fill} upright and ${turned.fill} turned`);
  assert.deepEqual(upright.issues, []);
  assert.deepEqual(turned.issues, []);
});

test("no hands in shot is its own message, not a framing note", () => {
  assert.deepEqual(readHandPlacement([]).issues, ["hands-not-in-shot"]);
  assert.equal(readHandPlacement([hand({ size: 0.02 })]).issues[0], "hand-too-small");
});

test("left and right are flipped for a mirrored preview", () => {
  // The preview is mirrored so it behaves like a mirror. In a mirror the player's own left appears
  // on the right of the picture, so an instruction taken from frame coordinates is backwards.
  const drifted = readBodyPlacement(body({ centre: 0.1 }));
  assert.equal(drifted.issues.includes("off-left"), true);
  assert.equal(describePlacement(drifted, true)!.issue, "off-right");
  assert.equal(describePlacement(drifted, false)!.issue, "off-left");
});

test("the gate does not pass on one lucky frame", () => {
  const gate = new PlacementGate({ holdMs: 1_000 });
  const clean = readBodyPlacement(body());
  assert.equal(gate.update(clean, 0).passed, false);
  assert.equal(gate.update(clean, 500).passed, false);
  assert.equal(gate.update(clean, 999).passed, false);
  assert.equal(gate.update(clean, 1_000).passed, true);
});

test("a dropped frame does not restart the hold, but the player moving does", () => {
  /*
   * Tracking drops frames routinely. A hold that demands an unbroken run of clean ones is roughly a
   * one-in-six proposition over 1.2s at thirty frames a second, so someone standing in exactly the
   * right place would watch the check never finish. A lapse shorter than the grace window is a
   * dropped frame; a longer one is someone who walked off.
   */
  const gate = new PlacementGate({ holdMs: 1_000, graceMs: 350 });
  const clean = readBodyPlacement(body());
  const gone = readBodyPlacement([]);

  gate.update(clean, 0);
  gate.update(clean, 900);
  gate.update(gone, 933);                                  // one frame missed at 30fps
  assert.equal(gate.update(clean, 966).passed, false);
  assert.equal(gate.update(clean, 1_000).passed, true, "a single dropped frame reset a hold it should have survived");

  const second = new PlacementGate({ holdMs: 1_000, graceMs: 350 });
  second.update(clean, 0);
  second.update(clean, 900);
  for (let t = 933; t <= 1_500; t += 33) second.update(gone, t);   // walked out of shot
  assert.equal(second.update(clean, 1_533).passed, false, "passed a hold the player had left");
  assert.equal(second.update(clean, 2_533).passed, true);
});

test("the shown message does not flicker between two near-equal complaints", () => {
  const gate = new PlacementGate({ settleMs: 500 });
  const far = readBodyPlacement(body({ fill: 0.1 }));
  const close = readBodyPlacement(body({ fill: 0.85 }));

  // The first problem of a run appears at once: there is nothing on screen to flicker against yet,
  // and half a second of silence reads as the camera not working.
  assert.equal(gate.update(far, 0).issue, "too-far");
  assert.equal(gate.update(close, 100).issue, "too-far", "swapped the message inside the settle window");
  assert.equal(gate.update(close, 400).issue, "too-far");
  assert.equal(gate.update(close, 600).issue, "too-close");
});

test("every issue has copy, and it is ordered", () => {
  const issues = Object.keys(PLACEMENT_COPY) as PlacementIssue[];
  assert.deepEqual([...PLACEMENT_PRECEDENCE].sort(), issues.sort(), "an issue with no place in the order, or an order with no copy");
});

test("the copy contains no developer vocabulary", () => {
  /*
   * The boundary guard. This copy lives beside the arithmetic that raises it, which is what makes it
   * testable and also what makes it drift: the words a threshold is called are right there. A player
   * is never told about a landmark, a confidence, a model or a percentage.
   */
  const BANNED = /landmark|confidence|model|inference|delegate|tflite|threshold|calibrat|\bfps\b|frame rate|%|camera-(pose|hand)|visibility|luma|normali[sz]ed/i;
  for (const [issue, copy] of Object.entries(PLACEMENT_COPY)) {
    for (const [role, sentence] of Object.entries(copy)) {
      assert.ok(sentence.length > 12, `${issue}.${role} is too short to be a sentence: ${sentence}`);
      assert.doesNotMatch(sentence, BANNED, `${issue}.${role} uses developer vocabulary: ${sentence}`);
      assert.match(sentence, /[.!?]$/, `${issue}.${role} is not a sentence: ${sentence}`);
    }
  }
});
