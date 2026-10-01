import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createDeviceRuntime, parseDeviceDescriptor, DEVICE_DESCRIPTOR_SCHEMA } from "@101/connect";

test("public device facade exposes the embedded model and runtime without a game dependency", () => {
  assert.equal(typeof createDeviceRuntime, "function");
  assert.equal(typeof parseDeviceDescriptor, "function");
  assert.equal(DEVICE_DESCRIPTOR_SCHEMA.$schema, "http://json-schema.org/draft-07/schema#");
  for (const name of ["device-model", "device-runtime", "connect"]) {
    const root = new URL(`../packages/${name}/`, import.meta.url);
    const metadata = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    assert.ok(Object.keys(metadata.dependencies ?? {}).every((dependency) => ["@101/device-model", "@101/device-runtime"].includes(dependency)));
    for (const file of readdirSync(new URL("src/", root)).filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(`src/${file}`, root), "utf8");
      const imports = [...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
      assert.ok(imports.every((dependency) => dependency.startsWith("./") || ["@101/device-model", "@101/device-runtime"].includes(dependency)), `${name}/${file}: ${imports}`);
    }
  }
});

test("standalone descriptor schema exactly matches the editor schema export", () => {
  assert.equal(readFileSync(new URL("../schemas/device-descriptor.schema.json", import.meta.url), "utf8"),
    `${JSON.stringify(DEVICE_DESCRIPTOR_SCHEMA, null, 2)}\n`);
});
