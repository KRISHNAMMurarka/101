import assert from "node:assert/strict";
import test from "node:test";
import { Game101, parseGameManifest } from "./index.ts";

const definition = Game101.define({ id: "sdk-test", initialState: () => ({ value: 0 }), update() {} });
const manifest = { id: "sdk-test", name: "SDK Test", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["keyboard", "touch"], offline: true, procedural: false, controllers: { basic: ["keyboard"] } };
const input = { game: "sdk-test", actions: { trigger: { recommended: ["touch"], fallback: ["keyboard"] } }, vectors: { move: { recommended: ["touch"], fallback: ["keyboard"] } } };

test("validates and freezes a complete game/controller package", () => {
  const gamePackage = Game101.package({
    manifest,
    input,
    controllers: [{ id: "pilot", label: "Pilot", playerId: "player-1", requiredCapabilities: ["touch"], layout: { layout: [{ type: "joystick", action: "move" }, { type: "button", action: "trigger", label: "GO" }] } }],
    game: definition,
  });
  assert.equal(gamePackage.manifest.id, "sdk-test");
  assert.equal(Object.isFrozen(gamePackage.controllers[0].layout.layout), true);
  assert.throws(() => Object.assign(gamePackage.manifest, { name: "Changed" }), TypeError);
});

test("rejects inconsistent identity and undeclared controller controls", () => {
  assert.throws(() => Game101.package({ manifest, input: { ...input, game: "other" }, game: definition }), /IDs must match/);
  assert.throws(() => Game101.package({ manifest, input, controllers: [{ id: "bad", label: "Bad", playerId: "player-1", layout: { layout: [{ type: "button", action: "missing", label: "BAD" }] } }], game: definition }), /undeclared missing/);
});

test("rejects invalid manifests before they enter a registry", () => {
  assert.throws(() => parseGameManifest({ ...manifest, inputs: ["keyboard", "future-glove"] }), /unsupported source/);
  assert.throws(() => parseGameManifest({ ...manifest, controllers: { basic: ["gamepad"] } }), /not listed/);
});

test("requires a conventional playable preset at the package boundary", () => {
  const withoutControllers = { ...manifest, controllers: undefined };
  assert.throws(() => Game101.package({ manifest: withoutControllers, input, game: definition }), /basic controllers/);
});
