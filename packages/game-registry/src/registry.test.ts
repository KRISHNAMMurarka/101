import assert from "node:assert/strict";
import test from "node:test";
import { Game101 } from "@101/sdk";
import { GameRegistry } from "./index.ts";

function game(version: string, engine = "^1") {
  return Game101.package({
    manifest: {
      id: "tiny-game", name: "Tiny Game", version, engine, renderer: "2d",
      players: { min: 1, max: 1 }, inputs: ["keyboard"], offline: true,
      procedural: false, controllers: { basic: ["keyboard"] },
    },
    input: { game: "tiny-game", actions: { trigger: { recommended: ["keyboard"] } } },
    game: Game101.define({ id: "tiny-game", initialState: () => ({}), update() {} }),
  });
}

test("installs, updates, catalogs, and uninstalls game packages", () => {
  const registry = new GameRegistry();
  registry.install(game("1.0.0"), { kind: "local", path: "/games/tiny" }, 10);
  registry.install(game("1.1.0"), { kind: "download", url: "https://local.invalid/tiny" }, 20);
  assert.deepEqual(registry.catalog(), [{
    id: "tiny-game", name: "Tiny Game", version: "1.1.0", renderer: "2d", runtime: "local",
    players: { min: 1, max: 1 }, offline: true, procedural: false,
    inputs: ["keyboard"], source: "download",
  }]);
  assert.equal(registry.uninstall("tiny-game"), true);
  assert.equal(registry.get("tiny-game"), undefined);
});

test("rejects accidental downgrades and incompatible engine packages", () => {
  const registry = new GameRegistry();
  registry.install(game("2.0.0"));
  assert.throws(() => registry.install(game("1.9.0")), /downgrade/);
  const incompatible = { ...game("2.1.0"), manifest: { ...game("2.1.0").manifest, engine: "^2" } };
  assert.throws(() => registry.install(incompatible), /requires engine/);
});
