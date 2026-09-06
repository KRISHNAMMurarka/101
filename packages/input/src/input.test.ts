import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderSourceSchemas } from "../../../tools/generate-input-source-schemas.mjs";
import { InputBus, normalizeInputFrame, resolveInputManifest, type InputManifest } from "./index.ts";

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
    poses: { body: [2, -2, Number.NaN, 0.8] },
  }, 100);

  assert.equal(frame.sequence, 1);
  assert.equal(frame.timestamp, 100);
  assert.equal(frame.axes?.steer, 1);
  assert.deepEqual(frame.vectors?.aim, { x: -1, y: 0.4, z: 0 });
  assert.deepEqual(frame.poses?.body, [1, -1, 0, 0.8]);
});

test("reads normalized pose landmarks through the same player/device ordering", () => {
  const bus = new InputBus();
  bus.accept({
    deviceId: "camera-1",
    playerId: "player-1",
    sequence: 1,
    timestamp: 10,
    source: "camera-pose",
    actions: { duck: false },
    poses: { body: [0.2, 0.4, -0.1, 0.95] },
  });
  assert.deepEqual(bus.pose("body"), [0.2, 0.4, -0.1, 0.95]);
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

test("combines simultaneous devices without allowing newer neutral frames to mask active input", () => {
  const bus = new InputBus();
  bus.accept({
    deviceId: "keyboard",
    playerId: "player-1",
    sequence: 1,
    timestamp: 1,
    source: "keyboard",
    actions: { jump: true },
    axes: { steer: -.8 },
    vectors: { aim: { x: -.7, y: .1 } },
  });
  bus.accept({
    deviceId: "gamepad",
    playerId: "player-1",
    sequence: 1,
    timestamp: 2,
    source: "gamepad",
    actions: { jump: false },
    axes: { steer: 0 },
    vectors: { aim: { x: 0, y: 0 } },
  });

  assert.equal(bus.action("jump"), true);
  assert.equal(bus.axis("steer"), -.8);
  assert.deepEqual(bus.vector("aim"), { x: -.7, y: .1 });
});

test("uses the strongest live analog intent and newest value for equal magnitude", () => {
  const bus = new InputBus();
  bus.accept({ deviceId: "first", playerId: "player-1", sequence: 1, timestamp: 1, source: "custom", actions: {}, axes: { steer: -.4 } });
  bus.accept({ deviceId: "second", playerId: "player-1", sequence: 1, timestamp: 2, source: "custom", actions: {}, axes: { steer: .9 } });
  assert.equal(bus.axis("steer"), .9);
  bus.accept({ deviceId: "first", playerId: "player-1", sequence: 2, timestamp: 3, source: "custom", actions: {}, axes: { steer: -.9 } });
  assert.equal(bus.axis("steer"), -.9);
});

test("evicts every frame owned by a disconnected device", () => {
  const bus = new InputBus();
  for (const playerId of ["player-1", "role-pilot"]) bus.accept({
    deviceId: "phone",
    playerId,
    sequence: 1,
    timestamp: 1,
    source: "custom",
    actions: { trigger: true },
    axes: { steer: 1 },
  });
  assert.equal(bus.removeDevice("phone"), true);
  assert.equal(bus.action("trigger"), false);
  assert.equal(bus.axis("steer", "role-pilot"), 0);
  assert.deepEqual(bus.connectedDevices(), []);
  assert.equal(bus.removeDevice("phone"), false);
});

test("maps a game manifest to the best available input fallback", () => {
  const resolution = resolveInputManifest({
    game: "slashstorm",
    actions: {
      slash: { recommended: ["phone-motion", "camera-hand"], fallback: ["mouse", "keyboard"] },
      pause: { recommended: ["gamepad"], fallback: ["keyboard"] },
    },
  }, ["mouse", "keyboard"]);
  assert.deepEqual(resolution, {
    mappings: { slash: "mouse", pause: "keyboard" },
    missing: [],
    blocking: [],
    // Both controls fell through to `fallback`, so the game runs but is not being played the way
    // it was designed. A host that cannot tell the difference cannot offer to improve it.
    degraded: ["slash", "pause"],
    // Both controls wanted something better than the mouse and keyboard that served them, and the
    // list is what a host turns into "pair a phone" rather than a list of control names.
    wanted: ["phone-motion", "camera-hand", "gamepad"],
    playable: true,
  });
});

test("a game is blocked only by the controls it says it needs", () => {
  const manifest: InputManifest = {
    game: "tiltdrift",
    axes: { steer: { recommended: ["phone-motion"], fallback: ["keyboard"] } },
    actions: {
      boost: { recommended: ["touch"] },
      celebrate: { recommended: ["camera-pose"], optional: true },
    },
  };

  // Nothing but a keyboard: steering degrades to it, the optional flourish is simply absent, and
  // `boost` has nothing at all — which is what stops the game, not the missing camera.
  const bare = resolveInputManifest(manifest, ["keyboard"]);
  assert.deepEqual(bare.mappings, { steer: "keyboard" });
  assert.deepEqual(bare.degraded, ["steer"]);
  assert.deepEqual(bare.missing, ["boost", "celebrate"]);
  assert.deepEqual(bare.blocking, ["boost"], "an optional control must never block a launch");
  assert.equal(bare.playable, false);

  // Pair a phone and the game is playable and undegraded, still without a camera.
  const paired = resolveInputManifest(manifest, ["keyboard", "touch", "phone-motion"]);
  assert.deepEqual(paired.mappings, { steer: "phone-motion", boost: "touch" });
  assert.deepEqual(paired.degraded, []);
  assert.deepEqual(paired.blocking, []);
  assert.equal(paired.playable, true);
  assert.deepEqual(paired.missing, ["celebrate"], "an unserved optional control is still reported");
});

test("the published schemas are generated from INPUT_SOURCES", () => {
  // Four hand-kept copies of one list is how `maxItems: 14` outlived a thirteen-entry tuple. The
  // schemas are output now, and this compares the checked-in bytes with what the generator emits.
  for (const [url, expected] of renderSourceSchemas()) {
    assert.equal(readFileSync(url, "utf8"), expected, `${String(url)} is stale — run npm run schemas:sources`);
  }
});
