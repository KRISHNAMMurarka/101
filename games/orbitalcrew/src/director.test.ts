import assert from "node:assert/strict";
import test from "node:test";
import { OrbitalDirector, validateOrbitalEvent } from "./director.ts";

test("generates deterministic validated infinite orbital events", () => {
  const first = generate("crew-seed", 120);
  const second = generate("crew-seed", 120);
  assert.deepEqual(first, second);
  assert.ok(first.every((event, index) => validateOrbitalEvent(event, index ? first[index - 1]!.startAt : 0)));
  assert.ok(first.some((event) => event.requiredRoles.length > 1));
  assert.ok(first.some((event) => event.kind === "boss"));
});

test("changes event grammar for a different seed", () => {
  const first = generate("crew-seed", 20).map((event) => [event.kind, event.bearing]);
  const second = generate("friend-seed", 20).map((event) => [event.kind, event.bearing]);
  assert.notDeepEqual(first, second);
});

function generate(seed: string, count: number) {
  const director = new OrbitalDirector(seed);
  const events = [];
  let previousStart = 0;
  for (let index = 0; index < count; index += 1) {
    const event = director.next(previousStart);
    events.push(event);
    previousStart = event.startAt;
  }
  return events;
}
