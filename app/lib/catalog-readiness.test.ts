import assert from "node:assert/strict";
import test from "node:test";
import type { InputSource } from "@101/input";
import { catalogReadiness } from "./catalog-readiness.ts";
import { createLauncherCatalogEntry } from "./catalog.ts";

const game = createLauncherCatalogEntry({
  id: "shared-controls", name: "Shared controls", tagline: "Use both controls", version: "1.0.0",
  engine: "^1", renderer: "2d", players: { min: 1, max: 1 },
  inputs: ["keyboard", "touch", "phone-motion", "camera-pose"], offline: true, procedural: true,
  status: "playable",
}, {
  game: "shared-controls",
  actions: { fire: { recommended: ["touch"], fallback: ["keyboard"] } },
  axes: { steer: { recommended: ["phone-motion"], fallback: ["keyboard"] } },
  poses: { flourish: { recommended: ["camera-pose"], optional: true } },
});

test("unmeasured catalog readiness makes no missing-control claim", () => {
  assert.deepEqual(catalogReadiness(game, []), { ok: false, text: "Checking…" });
});

test("partial sources name the remaining required group rather than optional inputs", () => {
  assert.deepEqual(catalogReadiness(game, ["phone-motion"]), { ok: false, text: "Needs Keyboard or Touch" });
  assert.deepEqual(catalogReadiness(game, ["touch"]), { ok: false, text: "Needs Keyboard or Phone motion" });
});

test("fallback and combined sources become ready without optional camera input", () => {
  assert.deepEqual(catalogReadiness(game, ["keyboard"]), { ok: true, text: "Ready on this device" });
  assert.deepEqual(catalogReadiness(game, ["touch", "phone-motion"]), { ok: true, text: "Ready on this device" });
});

test("required groups retain conjunction while source alternatives retain choice", () => {
  const onlyOptional: InputSource[] = ["camera-pose"];
  assert.deepEqual(catalogReadiness(game, onlyOptional), {
    ok: false, text: "Needs (Keyboard or Touch) and (Keyboard or Phone motion)",
  });
  assert.deepEqual(catalogReadiness({ ...game, status: "planned" }, onlyOptional), { ok: false, text: "Coming soon" });
});
