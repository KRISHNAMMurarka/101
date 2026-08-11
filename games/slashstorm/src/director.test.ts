import assert from "node:assert/strict";
import test from "node:test";
import { SlashstormDirector, type SlashTarget } from "./director.ts";

function firstTargets(seed: string) {
  const director = new SlashstormDirector(seed);
  const targets: SlashTarget[] = [];
  for (let index = 0; index < 80; index += 1) director.update(0.1, index / 2, (target) => targets.push(target));
  return targets.slice(0, 8).map(({ kind, x, vy, health }) => ({ kind, x, vy, health }));
}

test("Slashstorm produces the same opening wave for the same seed", () => {
  assert.deepEqual(firstTargets("daily-101"), firstTargets("daily-101"));
  assert.notDeepEqual(firstTargets("daily-101"), firstTargets("friend-101"));
});
