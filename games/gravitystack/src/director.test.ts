import assert from "node:assert/strict";
import test from "node:test";
import { GravityStackDirector, validateStackShape } from "./director.ts";

test("generates deterministic valid stack pieces", () => {
  const first = generate("gravity-seed", 160);
  assert.deepEqual(first, generate("gravity-seed", 160));
  assert.ok(first.every(validateStackShape));
  assert.ok(first.some((shape) => shape.kind === "orb"));
  assert.ok(first.some((shape) => shape.material !== "steady"));
});

test("changes the shape sequence for a friend seed", () => {
  assert.notDeepEqual(generate("gravity-seed", 30), generate("friend-seed", 30));
});

function generate(seed: string, count: number) {
  const director = new GravityStackDirector(seed);
  return Array.from({ length: count }, () => director.next());
}
