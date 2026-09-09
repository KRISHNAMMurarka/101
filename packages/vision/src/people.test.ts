import assert from "node:assert/strict";
import test from "node:test";

import { POSE_LANDMARK, type PoseLandmark } from "./index.ts";
import { PLAYER_COLOURS, PersonTracker, playerColour } from "./people.ts";

/**
 * A body standing at `x` across the picture, `y` down it. Only the hips matter to the tracker.
 *
 * `world` is written the way the model really emits it — relative to the midpoint of this person's
 * own hips, so both hips straddle the origin and every person in the room looks identical in metric
 * space. The earlier version of this fixture wrote `world.x = x + offset`, an absolute room
 * coordinate no pose model produces, and that invention is the only reason a tracker matching on
 * metric hips ever passed a test.
 */
function person(x: number, y = 0.5): PoseLandmark[] {
  assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, "visible hip fixtures use image-normalized positions");
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [index, offset] of [[POSE_LANDMARK.leftHip, 0.1], [POSE_LANDMARK.rightHip, -0.1]] as const) {
    landmarks[index] = { x, y, z: 0, visibility: 1, world: { x: offset, y: 0, z: 0 } };
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
  const start = tracker.update([person(.2), person(.8)], 0);
  const left = start.find((p) => p.position.x < .5)!;
  const right = start.find((p) => p.position.x > .5)!;
  assert.notEqual(left.id, right.id);

  /*
   * They walk towards each other and pass. The model returns them in an arbitrary order — here
   * reversed, which is the case that renumbers players if identity comes from array position.
   */
  let a = .2;
  let b = .8;
  for (let step = 1; step <= 8; step++) {
    a += .07;
    b -= .07;
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
  const two = tracker.update([person(.2), person(.8)], 0);
  const leaving = two.find((p) => p.slot === 1)!;

  // Long enough to have actually left, not just been missed.
  tracker.update([person(.8)], 1_000);
  const after = tracker.current();
  assert.equal(after.length, 1);
  assert.ok(!after.some((p) => p.id === leaving.id));

  // A new arrival takes the free number, and does not inherit the identity that left it.
  const [arrived] = tracker.update([person(.8), person(.2)], 1_100).filter((p) => p.slot === 1);
  assert.ok(arrived, "the freed slot is offered to the next person");
  assert.notEqual(arrived!.id, leaving.id, "a slot is reused; an identity is not");
});

test("two people are told apart even though their metric hips are identical", () => {
  // The bug this replaces: position came from `world`, which the model expresses relative to the
  // midpoint of the hips — so the hip midpoint of every person is the origin, every pairing scored
  // a distance of zero, and identity fell out of whatever order the greedy pass happened to take.
  const tracker = new PersonTracker();
  const left = person(0.25);
  const right = person(0.75);

  const metric = (body: PoseLandmark[]) => {
    const a = body[POSE_LANDMARK.leftHip]!.world!;
    const b = body[POSE_LANDMARK.rightHip]!.world!;
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  };
  assert.deepEqual(metric(left), metric(right), "the fixture must reproduce the model's hip-relative origin");

  const [one, two] = tracker.update([left, right], 0);
  assert.notEqual(one!.id, two!.id);
  assert.notDeepEqual(one!.position, two!.position, "two people in different parts of the frame must not share a position");
});

test("a body whose hips are not in shot is not a person the tracker can place", () => {
  // Without hips there is no position, so there is nothing to match on. Guessing would mean
  // inventing a location and then tracking the invention.
  const tracker = new PersonTracker();
  const hiddenHips = person(.5);
  hiddenHips[POSE_LANDMARK.leftHip]!.visibility = .05;
  hiddenHips[POSE_LANDMARK.rightHip]!.visibility = .05;
  assert.deepEqual(tracker.update([hiddenHips], 0), []);
});

test("more people than the game seats are not handed slots", () => {
  const tracker = new PersonTracker({ maxPeople: 2 });
  const people = tracker.update([person(.15), person(.5), person(.85)], 0);
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((p) => p.slot), [1, 2]);
});

test("every player has a colour, and it is theirs for as long as the slot is", () => {
  const tracker = new PersonTracker();
  const people = tracker.update([person(.15), person(.5), person(.85)], 0);
  const colours = people.map((p) => playerColour(p.slot));
  assert.equal(new Set(colours).size, 3, "players at the same time must not share a colour");

  // A number is not something anyone can see across a room, so the colour has to be as stable as the
  // slot is — it is the only way someone knows which silhouette is theirs.
  const moved = tracker.update([person(.53), person(.88), person(.18)], 16);
  for (const p of moved) {
    const before = people.find((original) => original.id === p.id)!;
    assert.equal(playerColour(p.slot), playerColour(before.slot));
  }

  // More players than colours wraps rather than returning nothing.
  assert.equal(playerColour(PLAYER_COLOURS.length + 1), PLAYER_COLOURS[0]);
  assert.ok(playerColour(99));
});


test("identities follow both trajectories through a real normalized two-person crossing", () => {
  const tracker = new PersonTracker();
  const [one, two] = tracker.update([person(.2), person(.8)], 0);
  for (let step = 1; step <= 8; step++) {
    const a = .2 + step * .07;
    const b = .8 - step * .07;
    const people = tracker.update([person(b), person(a)], step * 50);
    assert.ok(Math.abs(people.find((p) => p.id === one!.id)!.position.x - a) < 1e-10);
    assert.ok(Math.abs(people.find((p) => p.id === two!.id)!.position.x - b) < 1e-10);
  }
});

test("a returning person retains their slot while a third joins mid-game", () => {
  const tracker = new PersonTracker({ forgetAfterMs: 500 });
  const [one, two] = tracker.update([person(.2), person(.8)], 0);
  tracker.update([person(.78)], 100);
  const returned = tracker.update([person(.5), person(.22), person(.76)], 200);
  assert.equal(returned.find((p) => p.position.x === .22)!.id, one!.id);
  assert.equal(returned.find((p) => p.position.x === .76)!.id, two!.id);
  assert.equal(returned.find((p) => p.position.x === .5)!.slot, 3);
});

test("a slot expires before matching a late arrival at the same place", () => {
  const tracker = new PersonTracker({ forgetAfterMs: 100 });
  const [one] = tracker.update([person(.5)], 0);
  const [later] = tracker.update([person(.5)], 200);
  assert.notEqual(later!.id, one!.id);
  assert.equal(later!.slot, 1);
});


test("a malformed pose with an absent hip is safely ignored", () => {
  const malformed = person(.5);
  malformed[POSE_LANDMARK.leftHip] = undefined as unknown as PoseLandmark;
  assert.deepEqual(new PersonTracker().update([malformed], 0), []);
});

test("unseen hips preserve the old identity briefly without refreshing or moving it", () => {
  const tracker = new PersonTracker({ forgetAfterMs: 500 });
  const [initial] = tracker.update([person(.3)], 0);
  const unknown = person(.4);
  unknown[POSE_LANDMARK.leftHip]!.visibility = .05;
  unknown[POSE_LANDMARK.rightHip]!.visibility = .05;
  const [held] = tracker.update([unknown], 100);
  assert.equal(held!.id, initial!.id);
  assert.equal(held!.lastSeen, 0);
  assert.equal(held!.position.x, .3);
  const [returned] = tracker.update([person(.32)], 200);
  assert.equal(returned!.id, initial!.id);
  assert.deepEqual(tracker.update([unknown], 701), [], "unseen hips cannot keep a departed identity alive");
});
