import assert from "node:assert/strict";
import test from "node:test";
import { BeatForgeDirector, validateBeatGroup } from "./director.ts";

test("generates deterministic validated rhythm groups", () => {
  const first = generate("forge-seed", 180);
  const second = generate("forge-seed", 180);
  assert.deepEqual(first, second);
  assert.ok(first.every((group, index) => validateBeatGroup(group, first[index - 1])));
  assert.ok(first.some((group) => group.actions.length === 2));
  assert.ok(first.some((group) => group.actions.includes("duck")));
  assert.ok(first.at(-1)!.bpm > first[0]!.bpm);
});

test("a friend seed produces a different chart", () => {
  assert.notDeepEqual(generate("forge-seed", 30), generate("friend-seed", 30));
});

function generate(seed: string, count: number) {
  const director = new BeatForgeDirector(seed);
  return Array.from({ length: count }, () => director.next());
}
