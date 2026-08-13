import assert from "node:assert/strict";
import test from "node:test";
import { createGameScaffold } from "./index.ts";

test("creates a complete independent game package without hardware or networking code", () => {
  const files = createGameScaffold({ id: "meteor-dash", name: "Meteor Dash" });
  assert.deepEqual(Object.keys(files).sort(), ["README.md", "input.manifest.json", "manifest.json", "package.json", "src/game.test.ts", "src/game.ts", "src/index.ts", "src/roles.ts"]);
  assert.match(files["src/index.ts"], /Game101\.package/);
  assert.match(files["src/roles.ts"], /GameControllerRole/);
  assert.doesNotMatch(files["src/game.ts"], /navigator|WebSocket|RTCPeerConnection|getGamepads/);
});

test("rejects unsafe scaffold identifiers", () => {
  assert.throws(() => createGameScaffold({ id: "../escape", name: "Escape" }), /kebab-case/);
});
