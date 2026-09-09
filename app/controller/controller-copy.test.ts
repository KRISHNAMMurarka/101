import assert from "node:assert/strict";
import test from "node:test";

import { controllerHint } from "./controller-copy.ts";

test("does not repeat a controller label as its secondary hint", () => {
  assert.equal(controllerHint("MOVE", "move"), undefined);
  assert.equal(controllerHint("Flight vector", "flight"), undefined);
  assert.equal(controllerHint("Throttle", "Spring"), "Spring");
  assert.equal(controllerHint("", "Pressure"), undefined);
});
