import assert from "node:assert/strict";
import test from "node:test";

import { coverTransform, createSimulatedPose, targetFrame } from "./overlay.ts";
import { PLACEMENT_LIMITS } from "./placement.ts";

test("a stream whose shape matches its box maps straight through", () => {
  const transform = coverTransform({ streamWidth: 640, streamHeight: 480, boxWidth: 320, boxHeight: 240 });
  assert.equal(transform.offsetX, 0);
  assert.equal(transform.offsetY, 0);
  assert.deepEqual(transform.project(0.5, 0.5), { x: 160, y: 120 });
  assert.deepEqual(transform.project(0, 0), { x: 0, y: 0 });
  assert.deepEqual(transform.project(1, 1), { x: 320, y: 240 });
});

test("a 4:3 camera in a 16:9 box is cropped top and bottom, and the overlay is cropped with it", () => {
  /*
   * The bug this exists for: landmarks are fractions of the STREAM, the canvas is sized to the BOX,
   * and `object-fit: cover` crops the difference. Multiplying a landmark by the box width put the
   * skeleton a whole head away from the body on any camera whose shape did not match its frame.
   */
  const box = { streamWidth: 640, streamHeight: 480, boxWidth: 1_600, boxHeight: 900 };
  const transform = coverTransform(box);

  // Cover scales to fill the wider axis: 1600/640 = 2.5, which makes the picture 1200 tall in a
  // 900 box, so 150 is lost off the top and 150 off the bottom.
  assert.equal(transform.scale, 2.5);
  assert.equal(transform.offsetX, 0);
  assert.equal(transform.offsetY, -150);

  // The centre of the stream is still the centre of the box.
  assert.deepEqual(transform.project(0.5, 0.5), { x: 800, y: 450 });
  // And the top of the stream is above the box, which is exactly what the viewer cannot see.
  assert.equal(transform.project(0.5, 0).y, -150);

  // Naively mapping to the box would have put it at y=0. That difference is the defect.
  assert.notEqual(transform.project(0.5, 0).y, 0);
});

test("a tall box crops the sides instead", () => {
  const transform = coverTransform({ streamWidth: 1_280, streamHeight: 720, boxWidth: 400, boxHeight: 400 });
  assert.equal(transform.scale, 400 / 720);
  assert.ok(transform.offsetX < 0, "a 16:9 stream in a square box must overflow horizontally");
  assert.equal(transform.offsetY, 0);
  assert.deepEqual(transform.project(0.5, 0.5), { x: 200, y: 200 });
});

test("a mirrored preview flips across, and only across", () => {
  const size = { streamWidth: 640, streamHeight: 480, boxWidth: 640, boxHeight: 480 };
  const plain = coverTransform(size);
  const mirrored = coverTransform({ ...size, mirrored: true });
  assert.deepEqual(plain.project(0.25, 0.3), { x: 160, y: 144 });
  assert.deepEqual(mirrored.project(0.25, 0.3), { x: 480, y: 144 });
  assert.deepEqual(mirrored.project(0.5, 0.5), plain.project(0.5, 0.5));
});

test("a video with no metadata yet does not project the body to nowhere", () => {
  // videoWidth and videoHeight are both 0 until loadedmetadata fires, and a few frames are drawn
  // before it does. A NaN there is an overlay that never reappears, because nothing recovers it.
  const transform = coverTransform({ streamWidth: 0, streamHeight: 0, boxWidth: 320, boxHeight: 240 });
  const point = transform.project(0.5, 0.5);
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `projected to ${point.x},${point.y}`);
  assert.deepEqual(point, { x: 160, y: 120 });
});

test("the target frame is derived from the limits the check applies", () => {
  // Drawn target and judged target are the same number, so a player who fills the rectangle passes.
  // Two constants would drift, and the drift would be invisible: the box would simply be a lie.
  const box = { streamWidth: 640, streamHeight: 480, boxWidth: 640, boxHeight: 480 };
  const rect = targetFrame(coverTransform(box), box, PLACEMENT_LIMITS.minFill, PLACEMENT_LIMITS.maxFill);
  assert.ok(rect.height > 0 && rect.width > 0);
  assert.ok(rect.height < box.boxHeight, "the target filled the whole frame, so it teaches nothing");
  assert.ok(Math.abs((rect.x + rect.width / 2) - box.boxWidth / 2) < 0.001, "the target is not centred");
  assert.ok(Math.abs((rect.y + rect.height / 2) - box.boxHeight / 2) < 0.001, "the target is not centred");
});

test("the simulated body is a whole body", () => {
  const pose = createSimulatedPose({ x: 0, duck: false, jump: false, arms: false, punch: false });
  assert.equal(pose.length, 33);
  assert.ok(pose.every((landmark) => Number.isFinite(landmark.x) && Number.isFinite(landmark.y)));

  const raised = createSimulatedPose({ x: 0, duck: false, jump: false, arms: true, punch: false });
  assert.ok(raised[15]!.y < pose[15]!.y, "raising the arms must move the wrists up the picture");
});
