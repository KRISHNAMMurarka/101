import assert from "node:assert/strict";
import test from "node:test";
import { InputBus, normalizeInputFrame, resolveInputManifest } from "./index.ts";

test("normalizes invalid and out-of-range input values", () => {
  const frame = normalizeInputFrame({
    deviceId: "keyboard-1",
    playerId: "player-1",
    sequence: 1.8,
    timestamp: Number.NaN,
    source: "keyboard",
    actions: { jump: true },
    axes: { steer: 4 },
    vectors: { aim: { x: -3, y: 0.4, z: Number.NaN } },
  }, 100);

  assert.equal(frame.sequence, 1);
  assert.equal(frame.timestamp, 100);
  assert.equal(frame.axes?.steer, 1);
  assert.deepEqual(frame.vectors?.aim, { x: -1, y: 0.4, z: 0 });
});

test("drops stale realtime frames and reads the newest device value", () => {
  const bus = new InputBus();
  const base = {
    deviceId: "phone-1",
    playerId: "player-1",
    timestamp: 1,
    source: "phone-motion" as const,
    actions: {},
  };

  assert.equal(bus.accept({ ...base, sequence: 4, axes: { steer: 0.7 } }), true);
  assert.equal(bus.accept({ ...base, sequence: 3, axes: { steer: -0.5 } }), false);
  assert.equal(bus.axis("steer"), 0.7);
});

test("maps a game manifest to the best available input fallback", () => {
  const resolution = resolveInputManifest({
    game: "slashstorm",
    actions: {
      slash: { recommended: ["phone-motion", "camera-hand"], fallback: ["mouse", "keyboard"] },
      pause: { recommended: ["gamepad"], fallback: ["keyboard"] },
    },
  }, ["mouse", "keyboard"]);
  assert.deepEqual(resolution, { mappings: { slash: "mouse", pause: "keyboard" }, missing: [] });
});
