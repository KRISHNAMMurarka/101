import assert from "node:assert/strict";
import test from "node:test";

import { POSE_LANDMARK, type PoseLandmark } from "./index.ts";
import { PLAYER_COLOURS, PersonTracker, playerColour } from "./people.ts";

/** A body at a position on the floor. Only the hips matter to the tracker. */
function person(x: number, z = 0): PoseLandmark[] {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [index, offset] of [[POSE_LANDMARK.leftHip, 0.1], [POSE_LANDMARK.rightHip, -0.1]] as const) {
    landmarks[index] = { x, y: 0, z, visibility: 1, world: { x: x + offset, y: 0, z } };
  }
  return landmarks;
}

test("a person keeps their number while they stay", () => {
  const tracker = new PersonTracker();
  const [first] = tracker.update([person(0)], 0);
  assert.equal(first!.slot, 1);

  // Walking across the room, a little at a time.
  for (let step = 1; step <= 10; step++) {
    const people = tracker.update([person(step * 0.05)], step * 16);
    assert.equal(people.length, 1);
    assert.equal(people[0]!.id, first!.id, "the same person must not be renumbered as they move");
    assert.equal(people[0]!.slot, 1);
  }
});

test("two people who cross do not swap places", () => {
  const tracker = new PersonTracker();
  const start = tracker.update([person(-0.5), person(0.5)], 0);
  const left = start.find((p) => p.position.x < 0)!;
  const right = start.find((p) => p.position.x > 0)!;
  assert.notEqual(left.id, right.id);

  /*
   * They walk towards each other and pass. The model returns them in an arbitrary order — here
   * reversed, which is the case that renumbers players if identity comes from array position.
   */
  let a = -0.5;
  let b = 0.5;
  for (let step = 1; step <= 8; step++) {
    a += 0.12;
    b -= 0.12;
    const people = tracker.update([person(b), person(a)], step * 16);
    assert.equal(people.length, 2);
    const stillLeft = people.find((p) => p.id === left.id);
    const stillRight = people.find((p) => p.id === right.id);
    assert.ok(stillLeft && stillRight, "both people must survive the crossing");
    assert.equal(stillLeft!.slot, left.slot);
    assert.equal(stillRight!.slot, right.slot);
  }
});

test("a dropped frame does not renumber anyone", () => {
  // Tracking misses a frame regularly. Releasing a slot on the first miss is how a game ends up
  // handing player one's controls to player two mid-round.
  const tracker = new PersonTracker();
  const [only] = tracker.update([person(0)], 0);

  const missed = tracker.update([], 100);
  assert.equal(missed.length, 1, "someone missed for a moment has not left");
  assert.equal(missed[0]!.id, only!.id);

  const back = tracker.update([person(0.05)], 200);
  assert.equal(back[0]!.id, only!.id, "they are the same person when they reappear");
});

test("someone who leaves frees their number for the next person", () => {
  const tracker = new PersonTracker({ forgetAfterMs: 500 });
  const two = tracker.update([person(-0.5), person(0.5)], 0);
  const leaving = two.find((p) => p.slot === 1)!;

  // Long enough to have actually left, not just been missed.
  tracker.update([person(0.5)], 1_000);
  const after = tracker.current();
  assert.equal(after.length, 1);
  assert.ok(!after.some((p) => p.id === leaving.id));

  // A new arrival takes the free number, and does not inherit the identity that left it.
  const [arrived] = tracker.update([person(0.5), person(-1.2)], 1_100).filter((p) => p.slot === 1);
  assert.ok(arrived, "the freed slot is offered to the next person");
  assert.notEqual(arrived!.id, leaving.id, "a slot is reused; an identity is not");
});

test("a body with no metric hips is not a person the tracker can place", () => {
  // Without world landmarks there is no position, so there is nothing to match on. Guessing would
  // mean inventing a location and then tracking the invention.
  const tracker = new PersonTracker();
  const flat: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  assert.deepEqual(tracker.update([flat], 0), []);
});

test("more people than the game seats are not handed slots", () => {
  const tracker = new PersonTracker({ maxPeople: 2 });
  const people = tracker.update([person(-1), person(0), person(1)], 0);
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((p) => p.slot), [1, 2]);
});

test("every player has a colour, and it is theirs for as long as the slot is", () => {
  const tracker = new PersonTracker();
  const people = tracker.update([person(-1), person(0), person(1)], 0);
  const colours = people.map((p) => playerColour(p.slot));
  assert.equal(new Set(colours).size, 3, "players at the same time must not share a colour");

  // A number is not something anyone can see across a room, so the colour has to be as stable as the
  // slot is — it is the only way someone knows which silhouette is theirs.
  const moved = tracker.update([person(0.05), person(1.05), person(-0.95)], 16);
  for (const p of moved) {
    const before = people.find((original) => original.id === p.id)!;
    assert.equal(playerColour(p.slot), playerColour(before.slot));
  }

  // More players than colours wraps rather than returning nothing.
  assert.equal(playerColour(PLAYER_COLOURS.length + 1), PLAYER_COLOURS[0]);
  assert.ok(playerColour(99));
});
