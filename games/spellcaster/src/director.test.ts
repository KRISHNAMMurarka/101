import assert from "node:assert/strict";
import test from "node:test";
import { SpellcasterDirector, validateArcaneWave } from "./director.ts";

test("generates deterministic validated arcane waves and bosses", () => {
  const first = generate("spell-seed", 24);
  assert.deepEqual(first, generate("spell-seed", 24));
  assert.ok(first.every((wave, index) => validateArcaneWave(wave, first[index - 1])));
  assert.equal(first[7]?.boss, true);
  assert.equal(first[7]?.spawns[0]?.type, "warden");
  assert.ok(new Set(first.flatMap((wave) => wave.spawns.map((spawn) => spawn.weakness))).size >= 5);
});

test("friend seeds create different spell encounters", () => {
  assert.notDeepEqual(generate("spell-seed", 10), generate("friend-seed", 10));
});

function generate(seed: string, count: number) {
  const director = new SpellcasterDirector(seed);
  return Array.from({ length: count }, () => director.next());
}
