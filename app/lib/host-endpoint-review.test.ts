import assert from "node:assert/strict";
import test from "node:test";
import { boundedQuery, canonicalHubEndpoint, controllerOriginForPhone, endpointCandidates, isLoopback, readBoundedJson, validateHubHealth } from "./host-endpoint-review.ts";

test("connection hints are bounded origins without credentials, paths, hidden delimiters or ambiguous query keys", () => {
  assert.equal(canonicalHubEndpoint("http://192.168.1.10:10101/"), "http://192.168.1.10:10101");
  assert.equal(canonicalHubEndpoint("https://LOCALHOST:443"), "https://localhost");
  assert.equal(canonicalHubEndpoint("http://[::1]:10101"), "http://[::1]:10101");
  for (const value of ["http://user:pass@host", "http://@host", "http://host/path", "http://host/./", "http://host?", "http://host#", "http://host\\other", "http://host\n", "http://host/%2e", "http://" + "a".repeat(2050)]) assert.throws(() => canonicalHubEndpoint(value));
  assert.throws(() => boundedQuery("?hub=http://first&hub=http://second"));
  assert.throws(() => boundedQuery("?" + "a".repeat(8192)));
  assert.equal(isLoopback("127.evil.example"), false);
});

test("query and saved candidates are unverified, deduplicated, and cannot bypass original byte limits", () => {
  assert.deepEqual(endpointCandidates("?hub=http%3A%2F%2F192.168.1.10%3A10101", "https://host:443/", "http://localhost:3000"), [
    { endpoint: "http://192.168.1.10:10101", source: "link" }, { endpoint: "https://host", source: "saved" }, { endpoint: "http://localhost:10101", source: "this device" },
  ]);
  assert.deepEqual(endpointCandidates("?hub=http://first&hub=http://second", "http://" + "a".repeat(5000), "http://localhost:3000"), [{ endpoint: "http://localhost:10101", source: "this device" }]);
});

test("real Hub health offers bounded IPv4 candidates only at the explicitly checked scheme and port", () => {
  const endpoint = "http://127.0.0.1:10101", health = { service: "101-hub", version: 1, endpoint, addresses: ["192.168.1.10", "169.254.1.2", "127.0.0.1"] };
  assert.deepEqual(validateHubHealth(health, endpoint), { endpoint, phoneEndpoints: [endpoint, "http://192.168.1.10:10101"] });
  for (const bad of [{ ...health, endpoint: "https://127.0.0.1:10101" }, { ...health, endpoint: "http://127.0.0.1:9999" }, { ...health, endpoint: "http://127.evil.example:10101" }, { ...health, addresses: ["evil.example"] }, { ...health, addresses: Array(33).fill("192.168.1.10") }, { ...health, version: 2 }, { ...health, extra: true }]) assert.throws(() => validateHubHealth(bad, endpoint));
  assert.equal(controllerOriginForPhone("http://localhost:3000", "http://192.168.1.10:10101"), "http://192.168.1.10:3000");
  assert.equal(controllerOriginForPhone("https://game.example", "http://192.168.1.10:10101"), "https://game.example");
});

test("response byte limits apply to actual streamed bytes before JSON parsing, including misleading Content-Length", async () => {
  const encoder = new TextEncoder(), signal = new AbortController().signal;
  let canceled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"a":"')); controller.enqueue(encoder.encode("x".repeat(100))); }, cancel() { canceled = true; } }), { headers: { "Content-Length": "1" } });
  await assert.rejects(() => readBoundedJson(response, 32, signal)); assert.equal(canceled, true);
  assert.deepEqual(await readBoundedJson(Response.json({ valid: true }), 32, signal), { valid: true });
  await assert.rejects(() => readBoundedJson(new Response(new Uint8Array([0xff])), 32, signal));
});

test("the native desktop Rust health producer has a closed version 2 profile with bounded inert counts", () => {
  // signaling.rs Health is serde camelCase: PROTOCOL_VERSION=2, mdns, sessionCount and peerCount are always present.
  const endpoint = "http://127.0.0.1:10101";
  const native = { service: "101-hub", version: 2, endpoint, addresses: ["192.168.1.10"], mdns: true, sessionCount: 1, peerCount: 2 };
  assert.deepEqual(validateHubHealth(native, endpoint), { endpoint, phoneEndpoints: [endpoint, "http://192.168.1.10:10101"] });
  for (const invalid of [{ ...native, mdns: "yes" }, { ...native, sessionCount: -1 }, { ...native, sessionCount: 129 },
    { ...native, sessionCount: 1.5 }, { ...native, peerCount: 8193 }, { ...native, peerCount: 1.5 },
    { ...native, sessionCount: 0 }, { ...native, version: 3 }, { ...native, extra: true },
    { service: "101-hub", version: 2, endpoint, addresses: [] }]) assert.throws(() => validateHubHealth(invalid, endpoint));
});
