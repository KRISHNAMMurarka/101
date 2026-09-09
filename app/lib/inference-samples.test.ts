import assert from "node:assert/strict";
import test from "node:test";

import { appendInferenceSample, summarizeInferenceSamples } from "./inference-samples.ts";

test("keeps a bounded window of usable inference durations", () => {
  let samples: readonly number[] = [];
  for (const sample of [5, 8, -1, Number.NaN, 13, 21]) samples = appendInferenceSample(samples, sample, 3);
  assert.deepEqual(samples, [8, 13, 21]);
});

test("reports a stable mean, median, and nearest-rank p95", () => {
  assert.equal(summarizeInferenceSamples([]), undefined);
  assert.deepEqual(summarizeInferenceSamples([9, 1, 5, 7, 3]), {
    count: 5,
    minimumMs: 1,
    meanMs: 5,
    medianMs: 5,
    p95Ms: 9,
    maximumMs: 9,
  });
  assert.deepEqual(summarizeInferenceSamples([1, 2, 3, 4]), {
    count: 4,
    minimumMs: 1,
    meanMs: 2.5,
    medianMs: 2.5,
    p95Ms: 4,
    maximumMs: 4,
  });
});
