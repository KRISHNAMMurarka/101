import assert from "node:assert/strict";
import test from "node:test";

import { DPAD_DEAD_ZONE, DPAD_DIRECTIONS, readDpadDirection } from "./index.ts";

test("each edge of the pad reports the direction facing it", () => {
  assert.equal(readDpadDirection(0, -1), "up");
  assert.equal(readDpadDirection(0, 1), "down");
  assert.equal(readDpadDirection(-1, 0), "left");
  assert.equal(readDpadDirection(1, 0), "right");
});

test("a thumb resting on the centre reports nothing", () => {
  // The pad used to resolve an exact centre to `right`, which walks a player sideways while they
  // are not asking to move at all.
  assert.equal(readDpadDirection(0, 0), undefined);
  assert.equal(readDpadDirection(DPAD_DEAD_ZONE * 0.7, 0), undefined);
  assert.equal(readDpadDirection(DPAD_DEAD_ZONE * 1.1, 0), "right");
});

test("a thumb rolling from up to left crosses the diagonal once and never releases", () => {
  // Four separate buttons made this sequence up -> (nothing) -> left, because leaving a cell fired
  // a release. Every sample along the arc has to name a direction.
  const arc = Array.from({ length: 24 }, (_, step) => {
    const angle = Math.PI * (1.5 - step / 23 * 0.5); // straight up, sweeping to straight left
    return readDpadDirection(Math.cos(angle), Math.sin(angle));
  });
  assert.ok(arc.every((direction) => direction !== undefined), "released mid-roll");
  assert.equal(arc[0], "up");
  assert.equal(arc.at(-1), "left");
  assert.deepEqual([...new Set(arc)], ["up", "left"], "reported a direction the thumb never crossed");
});

test("a thumb drifting past a cell edge keeps the direction it is nearest", () => {
  // The failure this replaces: holding `up` while the thumb creeps 1px sideways dropped the input.
  assert.equal(readDpadDirection(0.4, -0.9), "up");
  assert.equal(readDpadDirection(-0.9, 0.4), "left");
});

test("every direction sends a unit vector on one axis", () => {
  for (const [name, vector] of Object.entries(DPAD_DIRECTIONS)) {
    assert.equal(Math.abs(vector.x) + Math.abs(vector.y), 1, `${name} is not a unit step`);
    assert.ok(vector.x * vector.y === 0, `${name} moves on both axes`);
  }
});
