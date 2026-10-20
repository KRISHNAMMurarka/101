import assert from "node:assert/strict";
import test from "node:test";
import { createSensorMapping, mapSensorObservation, type SensorObservation } from "./sensor-mapping.ts";

const pose = (slot = 1, sequence = 1): SensorObservation => ({
  deviceId: `camera.subject-${slot}`, sequence, timestamp: 10, source: "camera-pose",
  subject: { id: slot + 20, slot }, actions: { guard: true, jump: false, armsRaisedEdge: true },
  axes: { bodyX: .5 }, vectors: { body: { x: .5, y: 0 } }, poses: { body: [1, 2, 3, 4] },
});
test("camera mapping owns combat meanings and exposes only presence to game input", () => {
  const frame = mapSensorObservation(pose())!;
  assert.equal(frame.actions["combat.block"], true);
  assert.equal(frame.actions["combat.special"], true);
  assert.equal(frame.axes?.dodgeX, .5);
  assert.deepEqual(frame.poses, { body: [1] });
  assert.equal(frame.actions.guard, undefined);
});
test("hand activation is an edge while the physical gesture remains held", () => {
  const frame = mapSensorObservation({ ...pose(), source: "camera-hand",
    actions: { "hand.twoFingers": true, "hand.twoFingersEdge": false } })!;
  assert.equal(frame.actions["hand.twoFingers"], true);
  assert.equal(frame.actions["spell.cast.projectile"], false);
  assert.equal(frame.poses, undefined);
});
test("tracked subjects bind only to declared players and teardown retires each contribution", () => {
  const emitted: { playerId: string; deviceId: string; sequence: number }[] = [];
  const removed: string[] = [];
  const mapping = createSensorMapping({ scopeId: "camera-run-1", players: ["p1", "p2"],
    emit: (frame) => emitted.push(frame), removeDevice: (id) => removed.push(id) });
  mapping.accept(pose(1, 100));
  mapping.accept(pose(2, 1));
  mapping.accept(pose(1, 99));
  mapping.accept(pose(3, 1));
  assert.deepEqual(emitted.map((frame) => [frame.playerId, frame.sequence]), [["p1", 1], ["p2", 1]]);
  mapping.close();
  mapping.accept(pose(1, 101));
  assert.equal(emitted.length, 2);
  assert.deepEqual(removed, emitted.map((frame) => frame.deviceId));
});
