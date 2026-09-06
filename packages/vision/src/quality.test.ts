import assert from "node:assert/strict";
import test from "node:test";

import { TRACKING_PROFILES, recommendQuality, resolvePoseModel } from "./quality.ts";

test("the recommendation is conservative about what a device can afford", () => {
  // No GPU delegate means every frame is inference on the CPU, where even `balanced` struggles.
  assert.equal(recommendQuality({ gpu: false, cores: 16, memoryGB: 32 }), "fast");
  // A metered connection decides before performance does: the largest model is a 30MB download.
  assert.equal(recommendQuality({ gpu: true, cores: 16, memoryGB: 32, saveData: true }), "fast");

  assert.equal(recommendQuality({ gpu: true, cores: 16, memoryGB: 32 }), "precise");
  assert.equal(recommendQuality({ gpu: true, cores: 4, memoryGB: 8 }), "balanced");
  assert.equal(recommendQuality({ gpu: true, cores: 2, memoryGB: 4 }), "fast");

  // A phone is held to a higher bar for the same tier than a laptop is.
  assert.equal(recommendQuality({ gpu: true, cores: 8, memoryGB: 8, coarsePointer: true }), "balanced");
  assert.equal(recommendQuality({ gpu: true, cores: 6, memoryGB: 4, coarsePointer: true }), "fast");
  assert.notEqual(recommendQuality({ gpu: true, cores: 16, memoryGB: 16, coarsePointer: true }), "precise");

  // An unknown device must still get an answer rather than an exception.
  assert.ok(["fast", "balanced", "precise"].includes(recommendQuality()));
});

test("a tier whose model is not deployed falls back instead of failing to start", () => {
  const committed = new Set([TRACKING_PROFILES.fast.poseModel]);
  // The whole point: a checkout without the fetched models still tracks a body.
  assert.deepEqual(resolvePoseModel("precise", committed), { quality: "fast", poseModel: TRACKING_PROFILES.fast.poseModel });
  assert.deepEqual(resolvePoseModel("balanced", committed), { quality: "fast", poseModel: TRACKING_PROFILES.fast.poseModel });

  const all = new Set(Object.values(TRACKING_PROFILES).map((profile) => profile.poseModel));
  assert.equal(resolvePoseModel("precise", all).quality, "precise");
  assert.equal(resolvePoseModel("balanced", all).quality, "balanced");

  // It steps down one tier at a time rather than straight to the floor.
  const withoutHeavy = new Set([TRACKING_PROFILES.fast.poseModel, TRACKING_PROFILES.balanced.poseModel]);
  assert.equal(resolvePoseModel("precise", withoutHeavy).quality, "balanced");
});

test("every tier tells a player what it costs and what it buys", () => {
  for (const profile of Object.values(TRACKING_PROFILES)) {
    assert.ok(profile.note.length > 20, `${profile.quality} needs a real explanation, not a label`);
    assert.doesNotMatch(profile.label + profile.note, /landmark|delegate|inference|tflite|\.task/i,
      `${profile.quality} describes itself to a developer, not to a player`);
    assert.ok(profile.downloadMB > 0, "a player on cellular is told the size before committing");
  }
});
