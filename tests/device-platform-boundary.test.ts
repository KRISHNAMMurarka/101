import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createDeviceRuntime, parseDeviceDescriptor, DEVICE_DESCRIPTOR_SCHEMA, RemoteResourcePublisher, RemoteResourceReceiver, PeerDataTransport } from "@101/connect";

test("public facade exposes the independently packaged secure WebSocket transport", async () => {
  const facade = await import("@101/connect");
  assert.equal(typeof facade.SecureWebSocketTransport, "function");
  assert.equal(facade.WSS_SUBPROTOCOL, "101-resource-wss-1");
});

test("public device facade exposes embedded and peer-bound resources without a game dependency", () => {
  assert.equal(typeof createDeviceRuntime, "function");
  assert.equal(typeof parseDeviceDescriptor, "function");
  assert.equal(DEVICE_DESCRIPTOR_SCHEMA.$schema, "http://json-schema.org/draft-07/schema#");
  for (const implementation of [RemoteResourcePublisher, RemoteResourceReceiver, PeerDataTransport]) assert.equal(typeof implementation, "function");
  const packages = ["device-model", "device-runtime", "device-web", "transport-webrtc", "transport-websocket", "vision", "connect"];
  const publicNames = packages.map(name => `@101/${name}`);
  for (const name of packages) {
    const root = new URL(`../packages/${name}/`, import.meta.url);
    const metadata = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const dependencies = Object.keys(metadata.dependencies ?? {});
    assert.ok(dependencies.every(dependency => publicNames.includes(dependency)), `${name}: ${dependencies}`);
    for (const file of readdirSync(new URL("src/", root)).filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(`src/${file}`, root), "utf8");
      const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
      const imports = syntax.statements.filter(ts.isImportDeclaration).map(declaration =>
        (declaration.moduleSpecifier as ts.StringLiteral).text);
      assert.ok(imports.every(dependency => dependency.startsWith("./") ? new URL(dependency, new URL(`src/${file}`, root)).href.startsWith(new URL("src/", root).href)
        : dependencies.includes(dependency) && publicNames.includes(dependency)), `${name}/${file}: ${imports}`);
    }
  }
});

test("standalone descriptor schema exactly matches the editor schema export", () => {
  assert.equal(readFileSync(new URL("../schemas/device-descriptor.schema.json", import.meta.url), "utf8"),
    `${JSON.stringify(DEVICE_DESCRIPTOR_SCHEMA, null, 2)}\n`);
});
