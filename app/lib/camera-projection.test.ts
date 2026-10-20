import assert from "node:assert/strict";
import test from "node:test";
import { playerColour, projectCameraPeople } from "./camera-projection.ts";

test("avatar projection removes tracking identity and raw camera geometry", () => {
  const points = Array.from({ length: 33 }, () => ({ x: .6, y: .25, z: 10, world: { x: 5, y: 8, z: 10 } }));
  const people = projectCameraPeople([{ slot: 2, lastSeen: 10, landmarks: points },
    { slot: 1, lastSeen: 9, landmarks: points }], 10);
  assert.deepEqual(Object.keys(people[0]!).sort(), ["avatar", "slot"]);
  assert.equal(people.length, 1);
  assert.deepEqual(people[0]!.avatar[0], { x: 0, y: 2.25 });
  assert.equal(playerColour(2), "#F97316");
});
