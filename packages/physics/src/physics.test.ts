import assert from "node:assert/strict";
import test from "node:test";
import { Physics101 } from "./index.ts";

test("keeps Rapier behind stable handles and supports rotating gravity", async () => {
  const physics = new Physics101();
  await physics.initialize({ x: 0, y: 9.81 });
  const body = physics.createBody({ x: 0, y: 0 });
  physics.createCollider(body, { type: "box", width: 1, height: 1 }, { friction: .8 });
  physics.step(1 / 30);
  const falling = physics.bodyState(body);
  assert.ok(falling.position.y > 0);

  physics.setGravity(9.81, 0);
  physics.step(1 / 30);
  const sideways = physics.bodyState(body);
  assert.ok(sideways.velocity.x > 0);
  assert.deepEqual(physics.gravity(), { x: 9.81, y: 0 });
  assert.equal(physics.removeBody(body), true);
  assert.throws(() => physics.bodyState(body));
  await physics.initialize();
  const replacement = physics.createBody();
  assert.notEqual(replacement.id, body.id);
  assert.throws(() => physics.bodyState(body));
  physics.destroy();
});
