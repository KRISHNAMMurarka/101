import assert from "node:assert/strict";
import test from "node:test";
import { canTravel, generateMaze, MAZE_DIRECTIONS, shortestPath, validateMaze } from "./index.ts";

test("maze floors are deterministic, connected, and have reciprocal walls", () => {
  const first = generateMaze("echo-daily", 7);
  assert.deepEqual(first, generateMaze("echo-daily", 7));
  assert.notDeepEqual(first, generateMaze("echo-friend", 7));
  assert.equal(validateMaze(first), true);
  assert.equal(shortestPath(first, first.start, first.exit).length > 10, true);
});

test("maze generation preserves at least one legal move from every cell", () => {
  for (let level = 1; level <= 20; level += 1) {
    const floor = generateMaze("validator", level);
    assert.equal(floor.cells.every((cell) => MAZE_DIRECTIONS.some((direction) => canTravel(floor, cell, direction))), true);
    assert.equal(floor.fragments.length >= 2, true);
  }
});
