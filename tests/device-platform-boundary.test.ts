import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createDeviceRuntime, parseDeviceDescriptor, DEVICE_DESCRIPTOR_SCHEMA, RemoteResourcePublisher, RemoteResourceReceiver, PeerDataTransport } from "@101/connect";

const packages = ["device-model", "device-runtime", "device-web", "transport-webrtc", "transport-websocket", "vision", "connect"];
const publicNames = packages.map(name => `@101/${name}`);
function moduleDependencies(file: string, source: string) {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  return syntax.statements.flatMap(statement => {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier))
      return [statement.moduleSpecifier.text];
    return [];
  });
}
function assertPackageBoundary(name: string, metadata: { dependencies?: Record<string, string>; exports?: Record<string, unknown> }, sources: Map<string, string>) {
  const dependencies = Object.keys(metadata.dependencies ?? {});
  assert.ok(dependencies.every(dependency => publicNames.includes(dependency)), `${name}: ${dependencies}`);
  const nodeFiles = new Set<string>();
  if (name === "device-runtime" && metadata.exports?.["./node"] !== undefined) {
    assert.equal(metadata.exports["./node"], "./src/processor-node.ts");
    for (const file of ["processor-node.ts", "processor-worker.ts"]) { assert.ok(sources.has(file)); nodeFiles.add(file); }
  }
  const imports = new Map([...sources].map(([file, source]) => [file, moduleDependencies(file, source)]));
  const localTarget = (file: string, dependency: string) => {
    const target = new URL(dependency, `file:///src/${file}`);
    assert.ok(target.href.startsWith("file:///src/"), `${name}/${file}: local dependency escaped source`);
    const relative = target.pathname.slice("/src/".length);
    assert.ok(sources.has(relative), `${name}/${file}: missing local dependency ${relative}`);
    return relative;
  };
  for (const [file, imported] of imports) {
    for (const dependency of imported) {
      if (dependency.startsWith("./")) localTarget(file, dependency);
      else assert.ok(dependency === "node:worker_threads" && nodeFiles.has(file) || dependencies.includes(dependency) && publicNames.includes(dependency), `${name}/${file}: ${imported}`);
    }
  }
  const visited = new Set<string>();
  function browserClosure(file: string) {
    assert.ok(!nodeFiles.has(file), `${name}: browser root reaches Node-only ${file}`);
    if (visited.has(file)) return; visited.add(file);
    for (const dependency of imports.get(file) ?? []) if (dependency.startsWith("./")) browserClosure(localTarget(file, dependency));
  }
  browserClosure("index.ts");
}

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
  for (const name of packages) {
    const root = new URL(`../packages/${name}/`, import.meta.url);
    const metadata = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const sources = new Map<string, string>();
    for (const file of readdirSync(new URL("src/", root)).filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))) {
      sources.set(file, readFileSync(new URL(`src/${file}`, root), "utf8"));
    }
    assertPackageBoundary(name, metadata, sources);
  }
});

test("browser roots cannot import or re-export a Node-only executor and the Node entry cannot import other builtins", () => {
  const metadata = { exports: { "./node": "./src/processor-node.ts" } };
  const sources = new Map([["index.ts", "export {};"], ["processor-node.ts", "import { Worker } from 'node:worker_threads';"],
    ["processor-worker.ts", "import { parentPort } from 'node:worker_threads';"]]);
  for (const source of ["export * from './processor-node.ts';", "import './processor-worker.ts';", "import 'node:worker_threads';"])
    assert.throws(() => assertPackageBoundary("device-runtime", metadata, new Map(sources).set("index.ts", source)), /browser root reaches Node-only|device-runtime\/index.ts/);
  assert.throws(() => assertPackageBoundary("device-runtime", metadata, new Map(sources).set("processor-node.ts", "import 'node:fs';")), /device-runtime\/processor-node.ts/);
  assert.throws(() => assertPackageBoundary("device-web", metadata, sources), /device-web\/processor-node.ts/);
});

test("standalone descriptor schema exactly matches the editor schema export", () => {
  assert.equal(readFileSync(new URL("../schemas/device-descriptor.schema.json", import.meta.url), "utf8"),
    `${JSON.stringify(DEVICE_DESCRIPTOR_SCHEMA, null, 2)}\n`);
});
