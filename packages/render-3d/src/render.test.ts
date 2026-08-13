import assert from "node:assert/strict";
import test from "node:test";

test("3D renderer module exposes an availability contract for graceful fallback", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./index.ts", import.meta.url), "utf8"));
  assert.match(source, /readonly available: boolean/);
  assert.match(source, /class Renderer3DFallback/);
  assert.match(source, /GAMEPLAY \+ INPUT CONTINUE/);
});
