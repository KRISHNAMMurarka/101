import assert from "node:assert/strict";
import test from "node:test";
import { beatAtTime, beatDurationSeconds, judgeTiming, quantizeBeat, timeAtBeat } from "./index.ts";

test("converts beats and time without frame-count coupling", () => {
  assert.equal(beatDurationSeconds(120), .5);
  assert.equal(timeAtBeat(8, 120, 2), 6);
  assert.equal(beatAtTime(6, 120, 2), 8);
  assert.equal(quantizeBeat(2.37, 4), 2.25);
});

test("grades symmetric bounded timing windows", () => {
  assert.equal(judgeTiming(.04).grade, "perfect");
  assert.equal(judgeTiming(-.1).grade, "great");
  assert.equal(judgeTiming(.16).grade, "good");
  assert.equal(judgeTiming(.24).grade, "miss");
  assert.throws(() => judgeTiming(0, { perfect: .1, great: .05, good: .2 }));
});
