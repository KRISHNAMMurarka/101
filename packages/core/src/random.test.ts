import assert from "node:assert/strict";
import test from "node:test";
import { difficultyAt, SeededRandom } from "./random.ts";

test("replays the same procedural sequence from the same seed", () => {
  const first = new SeededRandom("daily-101");
  const second = new SeededRandom("daily-101");
  assert.deepEqual(
    [first.next(), first.next(), first.next()],
    [second.next(), second.next(), second.next()],
  );
});

test("difficulty combines pressure without collapsing reaction time", () => {
  const late = difficultyAt(400);
  assert.ok(late.simultaneousThreats > 1);
  assert.ok(late.modifierChance > 0);
  assert.ok(late.reactionTime >= 0.35);
});
