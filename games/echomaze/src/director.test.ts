import assert from "node:assert/strict";
import test from "node:test";
import { EchoMazeDirector, validateEchoFloor } from "./director.ts";

function expedition(seed: string) {
  const director = new EchoMazeDirector(seed);
  return Array.from({ length: 24 }, () => director.next());
}

test("Echo Maze produces deterministic connected infinite floors", () => {
  assert.deepEqual(expedition("echo-daily"), expedition("echo-daily"));
  assert.notDeepEqual(expedition("echo-daily"), expedition("echo-friend"));
  assert.equal(expedition("validator").every(validateEchoFloor), true);
});

test("floor grammar expands and rotates environments", () => {
  const floors = expedition("growth");
  assert.equal(floors.at(-1)!.cells.length > floors[0]!.cells.length, true);
  assert.equal(new Set(floors.map((floor) => floor.theme)).size, 4);
  assert.equal(floors.some((floor) => floor.modifier !== "still"), true);
});
