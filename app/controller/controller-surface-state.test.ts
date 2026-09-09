import assert from "node:assert/strict";
import test from "node:test";

import { controllerSurfaceState } from "./controller-surface-state.ts";

test("only shows game controls after this phone has an assigned, non-empty panel", () => {
  assert.equal(controllerSurfaceState({ connected: false, assigned: false, controlCount: 3 }), "waiting");
  assert.equal(controllerSurfaceState({ connected: true, assigned: false, controlCount: 3 }), "waiting");
  assert.equal(controllerSurfaceState({ connected: true, assigned: true, controlCount: 0 }), "waiting");
  assert.equal(controllerSurfaceState({ connected: true, assigned: true, controlCount: 1 }), "play");
});
