import assert from "node:assert/strict";
import test from "node:test";

import type { ControllerElement } from "@101/protocol";

import { clusterWeight, planControllerDeck } from "./index.ts";

const button = (action: string, extra: Partial<ControllerElement> = {}) =>
  ({ type: "button", action, label: action.toUpperCase(), ...extra }) as ControllerElement;
const dpad = (extra: Partial<ControllerElement> = {}) => ({ type: "dpad", action: "move", ...extra }) as ControllerElement;

function all(plan: ReturnType<typeof planControllerDeck>) {
  return [...plan.left.bars, ...plan.left.pads, ...plan.left.keys,
          ...plan.center.bars, ...plan.center.pads, ...plan.center.keys,
          ...plan.right.bars, ...plan.right.pads, ...plan.right.keys];
}

test("every control is placed exactly once", () => {
  // The old renderer wrote an inline grid-column per element, so two controls on the same side
  // claimed overlapping tracks and drew on top of each other. Placement is now a partition.
  const elements = [dpad(), button("a"), button("b"), button("c"),
    { type: "slider", action: "power", label: "OUTPUT", min: 0, max: 1 } as ControllerElement,
    { type: "shoulder", action: "l1", label: "L1" } as ControllerElement];
  const plan = planControllerDeck(elements);
  const placed = all(plan);

  assert.equal(placed.length, elements.length);
  assert.equal(new Set(placed.map((p) => p.element.action)).size, elements.length);
  for (const element of elements) {
    assert.equal(placed.filter((p) => p.element.action === element.action).length, 1,
      `${element.action} must appear exactly once`);
  }
});

test("a pad goes left, keys go right, a slider goes down the middle", () => {
  const plan = planControllerDeck([dpad(), button("a"), button("b"),
    { type: "slider", action: "power", label: "OUTPUT", min: 0, max: 1 } as ControllerElement]);

  assert.equal(plan.left.pads.length, 1);
  assert.equal(plan.right.keys.length, 2, "two buttons must sit beside each other, not stack");
  assert.equal(plan.center.bars.length, 1);
  assert.equal(plan.left.keys.length, 0);
});

test("bars, pads and keys are the order a hand meets them", () => {
  // Back of the phone forwards: shoulders under the index finger, pads in the middle, buttons under
  // the thumb. A shoulder that landed in `keys` would be a shoulder under a thumb.
  const plan = planControllerDeck([
    { type: "shoulder", action: "l1", label: "L1", side: "left" } as ControllerElement,
    { type: "trigger", action: "l2", label: "L2", side: "left" } as ControllerElement,
    dpad(),
    button("a", { side: "left" }),
  ]);
  assert.deepEqual(plan.left.bars.map((p) => p.element.action), ["l1", "l2"]);
  assert.deepEqual(plan.left.pads.map((p) => p.element.action), ["move"]);
  assert.deepEqual(plan.left.keys.map((p) => p.element.action), ["a"]);
});

test("a left-handed player gets the deck mirrored, and only then", () => {
  const elements = [dpad(), button("a")];

  const asAuthored = planControllerDeck(elements, { authoredHandedness: "right", playerHandedness: "right" });
  assert.equal(asAuthored.left.pads.length, 1);
  assert.equal(asAuthored.right.keys.length, 1);

  const mirrored = planControllerDeck(elements, { authoredHandedness: "right", playerHandedness: "left" });
  assert.equal(mirrored.right.pads.length, 1, "the pad moves to the other thumb");
  assert.equal(mirrored.left.keys.length, 1);

  // Without both halves of the comparison there is nothing to mirror against, so nothing moves.
  const unknown = planControllerDeck(elements, { playerHandedness: "left" });
  assert.equal(unknown.left.pads.length, 1);
});

test("a centre control is never mirrored", () => {
  // Mirroring is about which thumb reaches a control. Something in the middle is reached by both,
  // and swapping it would move it for no reason.
  const plan = planControllerDeck(
    [{ type: "slider", action: "power", label: "OUTPUT", min: 0, max: 1 } as ControllerElement],
    { authoredHandedness: "right", playerHandedness: "left" },
  );
  assert.equal(plan.center.bars.length, 1);
});

test("cluster weight is bounded at both ends", () => {
  // One control must not claim the whole width, and seven must not squeeze the other side to
  // nothing — a cluster at zero width is a control nobody can press.
  assert.equal(clusterWeight(0), 0);
  assert.ok(clusterWeight(1) >= 0.8);
  assert.ok(clusterWeight(7) <= 1.8);
  assert.ok(clusterWeight(16) <= 1.8, "the schema admits sixteen elements");
  for (let count = 1; count <= 16; count++) {
    const weight = clusterWeight(count);
    assert.ok(weight >= 0.8 && weight <= 1.8, `${count} controls gave weight ${weight}`);
  }
});

test("an empty side asks for no width", () => {
  const plan = planControllerDeck([button("a"), button("b")]);
  assert.equal(plan.left.count, 0);
  assert.equal(plan.left.weight, 0, "a cluster with nothing in it must not reserve space");
  assert.equal(plan.right.count, 2);
});

test("a declared side beats the default", () => {
  // A game that puts its pad on the right means it.
  const plan = planControllerDeck([dpad({ side: "right" }), button("a", { side: "left" })]);
  assert.equal(plan.right.pads.length, 1);
  assert.equal(plan.left.keys.length, 1);
});
