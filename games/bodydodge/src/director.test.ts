import assert from "node:assert/strict";
import test from "node:test";
import { BodyDodgeDirector, validateGate } from "./director.ts";

function course(seed: string) {
  const director = new BodyDodgeDirector(seed);
  const gates = [];
  let distance = 0;
  for (let index = 0; index < 40; index += 1) {
    const gate = director.next(distance);
    gates.push(gate);
    distance = gate.distance;
  }
  return gates;
}

test("BodyDodge produces deterministic infinite gate courses", () => {
  assert.deepEqual(course("daily-101"), course("daily-101"));
  assert.notDeepEqual(course("daily-101"), course("friend-101"));
});

test("every generated gate preserves a bounded reaction window", () => {
  let previousDistance = 0;
  for (const gate of course("validator-101")) {
    assert.equal(validateGate(gate, previousDistance), true);
    previousDistance = gate.distance;
  }
});
