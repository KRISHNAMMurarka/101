import assert from "node:assert/strict";
import test from "node:test";
import { ShadowArenaDirector, validateShadowRound } from "./director.ts";

function run(seed: string) {
  const director = new ShadowArenaDirector(seed);
  return Array.from({ length: 35 }, () => director.next());
}

test("Shadow Arena generates deterministic validated combat rounds", () => {
  const rounds = run("shadow-daily");
  assert.deepEqual(rounds, run("shadow-daily"));
  assert.notDeepEqual(rounds, run("shadow-friend"));
  rounds.forEach((round, index) => assert.equal(validateShadowRound(round, rounds[index - 1]), true));
});

test("the director schedules bosses and bounded defensive answers", () => {
  const rounds = run("shadow-validator");
  assert.deepEqual(rounds.filter((round) => round.boss).map((round) => round.id).slice(0, 4), [7, 14, 21, 28]);
  assert.equal(new Set(rounds.flatMap((round) => round.spawns.map((spawn) => spawn.attack))).size, 3);
  assert.equal(rounds.some((round) => round.modifier !== "clear"), true);
});
