import assert from "node:assert/strict";
import test from "node:test";
import { TiltDriftDirector } from "./director.ts";

function opening(seed: string) {
  const director = new TiltDriftDirector(seed);
  const segments = [];
  let distance = 0;
  for (let index = 0; index < 18; index += 1) {
    const segment = director.next(distance);
    segments.push(segment);
    distance += segment.length;
  }
  return segments;
}

test("TiltDrift road generation is deterministic and seedable", () => {
  assert.deepEqual(opening("daily-101"), opening("daily-101"));
  assert.notDeepEqual(opening("daily-101"), opening("rival-101"));
});

test("road pieces are continuous and remain within playable width", () => {
  const segments = opening("continuity-101");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    assert.ok(segment.width >= 6.4 && segment.width <= 12);
    if (index === 0) continue;
    const previous = segments[index - 1]!;
    assert.equal(segment.startDistance, previous.startDistance + previous.length);
    assert.equal(segment.startCurve, previous.endCurve);
    assert.equal(segment.startX, previous.endX);
  }
});
