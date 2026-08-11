import assert from "node:assert/strict";
import test from "node:test";
import type { InputFrame } from "@101/input";
import type { PoseLandmark } from "@101/vision";
import { PoseInputAdapter } from "./index.ts";

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
