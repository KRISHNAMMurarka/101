import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceRuntime } from "./index.ts";
import type { AuthorizationRequest, DeliveryContext, Observation, RouteGrant } from "./types.ts";

function device(id: string, command = false, sink = false) {
  return {
    schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: "example:embedded", version: "1.0.0" }, runtime: { platform: "embedded-test" },
    capabilities: [{ id: "control", semantic: command ? "example:relay-state" : "example:pointer",
      schemaVersion: 1, kind: sink ? (command ? "command" : "property") : (command ? "event" : "sample"),
      value: command ? { type: "boolean" } : { type: "vector", components: ["x", "y"], unit: "1", frame: "surface-normalized", min: 0, max: 1 },
      delivery: command ? { mode: "reliable", maxAgeMs: 5000 } : { mode: "latest", maxHz: 100, maxAgeMs: 100 },
      permissions: sink ? [command ? "invoke" : "write"] : ["subscribe"],
    }],
  };
}

function harness(options: { command?: boolean; authorize?: (request: Readonly<AuthorizationRequest>) => RouteGrant | undefined;
  apply?: (observation: Observation, context: DeliveryContext) => void | Promise<void> } = {}) {
  let now = 0;
  let releases = 0;
  const received: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => now,
    authorize: options.authorize ?? (() => ({ expiresAt: 10000, maxAgeMs: 1000, maxHz: 100 })) });
  const source = runtime.registerSource({ device: device("phone", options.command), capability: "control" });
  const sink = runtime.registerSink({ device: device("screen", options.command, true), capability: "control",
    apply: options.apply ?? ((observation) => { received.push(observation); }), release: () => { releases++; } });
  runtime.setReadiness(source, "available"); runtime.setReadiness(sink, "available");
  const request = { from: source, to: sink, principalId: "owner", applicationId: "demo", sessionId: "test" };
  const connection = runtime.route(request);
  return { runtime, source, sink, request, connection, received, releases: () => releases, setNow: (value: number) => { now = value; } };
}

test('preparation reserves owner lease without activating delivery or physical release', () => {
  const h = harness();
  assert.equal(typeof h.connection.prepare, 'function');
  assert.equal(typeof h.connection.activate, 'function');
  assert.deepEqual(h.connection.prepare(), { ok: true, value: undefined });
  assert.equal(h.connection.status().state, 'prepared');
  const competitor = h.runtime.route(h.request);
  assert.deepEqual(competitor.start(), { ok: false, reason: 'busy' });
  h.runtime.publish(h.source, { x: 0.1, y: 0.2 }); h.runtime.flush();
  assert.equal(h.received.length, 0);
  assert.equal(h.releases(), 0);
  assert.equal(h.connection.activate().ok, true);
  h.runtime.publish(h.source, { x: 0.3, y: 0.4 }); h.runtime.flush();
  assert.equal(h.received.length, 1);
  h.connection.stop();
  assert.equal(h.releases(), 1);
  assert.equal(competitor.start().ok, true);
  h.runtime.close();
});

test('prepared routes release leases on expiry, endpoint loss and runtime close without sink effects', () => {
  for (const loss of ['expiry', 'endpoint', 'close']) {
    const h = harness();
    assert.equal(h.connection.prepare().ok, true);
    if (loss === 'expiry') { h.setNow(1600); h.runtime.flush(); }
    else if (loss === 'endpoint') h.runtime.setReadiness(h.source, 'unavailable');
    else h.runtime.close();
    assert.equal(h.connection.status().state, 'closed');
    assert.equal(h.releases(), 0);
    if (loss !== 'close') {
      if (loss === 'endpoint') h.runtime.setReadiness(h.source, 'available');
      assert.equal(h.runtime.route(h.request).start().ok, true);
      h.runtime.close();
    }
  }
});

test("routes bind both resource operations and reject denied or forged authority", () => {
  let request: Readonly<AuthorizationRequest> | undefined;
  const h = harness({ authorize: (value) => { request = value; return undefined; } });
  assert.deepEqual(h.connection.start(), { ok: false, reason: "denied" });
  assert.equal(request?.sourceOperation, "subscribe"); assert.equal(request?.sinkOperation, "write");
  assert.equal(Object.isFrozen(request?.source), true);
  const forged = h.runtime.route({ ...h.request, from: { ...h.source } });
  assert.equal(forged.start().ok, false);
  assert.equal(h.runtime.publish({ ...h.source }, { x: 0, y: 0 }).ok, false);
});

test("inert descriptor extensions cannot authorize a route", () => {
  const runtime = createDeviceRuntime({ now: () => 0, authorize: () => undefined });
  const source = runtime.registerSource({ device: { ...device('extended-source'),
    extensions: { 'vendor:authority': { authorize: true } } }, capability: 'control' });
  const sink = runtime.registerSink({ device: { ...device('extended-sink', false, true),
    extensions: { 'vendor:authority': { authorize: true } } }, capability: 'control',
    apply() { assert.fail('Extension granted a route'); }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'example', sessionId: 'session' });
  assert.deepEqual(route.start(), { ok: false, reason: 'denied' });
  runtime.close();
});

test("property reads are one-shot while subscriptions remain authorized streams", () => {
  let now = 0;
  const requests: AuthorizationRequest[] = [];
  const received: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => now, authorize(request) {
    requests.push(request);
    return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 100 };
  } });
  const sourceDevice = { ...device('readable'), capabilities: [{ ...device('readable').capabilities[0],
    kind: 'property', permissions: ['read', 'subscribe'] }] };
  const sinkDevice = { ...device('reader', false, true), capabilities: [{ ...device('reader', false, true).capabilities[0],
    kind: 'property', permissions: ['write'] }] };
  const source = runtime.registerSource({ device: sourceDevice, capability: 'control' });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'control',
    apply(observation) { received.push(observation); }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const base = { from: source, to: sink, principalId: 'owner', applicationId: 'example', sessionId: 'session' };
  assert.equal(runtime.publish(source, { x: 0.2, y: 0.8 }).ok, true);
  const read = runtime.route({ ...base, sourceOperation: 'read' });
  assert.equal(read.start().ok, true);
  assert.equal(requests[0].sourceOperation, 'read');
  runtime.flush();
  assert.equal(received.length, 1);
  assert.equal(read.status().state, 'closed');
  const subscribe = runtime.route({ ...base, sourceOperation: 'subscribe' });
  assert.equal(subscribe.start().ok, true);
  assert.equal(requests[1].sourceOperation, 'subscribe');
  now = 20;
  runtime.publish(source, { x: 0.4, y: 0.6 }); runtime.flush();
  assert.equal(received.length, 2);
  assert.equal(subscribe.status().state, 'active');
  subscribe.stop('done');
  now = 200;
  assert.deepEqual(runtime.route({ ...base, sourceOperation: 'read' }).start(), { ok: false, reason: 'stale' });
  runtime.publish(source, { x: 0.8, y: 0.2 });
  const expiringRead = runtime.route({ ...base, sourceOperation: 'read' });
  assert.equal(expiringRead.start().ok, true);
  now = 301;
  runtime.flush();
  assert.equal(expiringRead.status().state, 'closed');
  assert.equal(received.length, 2);
  runtime.close();
  const sample = harness();
  assert.equal(sample.runtime.route({ ...sample.request, sourceOperation: 'read' }).start().ok, false);
  sample.runtime.close();
});

test("latest samples remain immutable and coalesced within the negotiated rate", () => {
  const h = harness(); assert.equal(h.connection.start().ok, true);
  const position = { x: 0.2, y: 0.8 };
  assert.equal(h.runtime.publish(h.source, position).ok, true);
  position.x = 0.9;
  h.runtime.flush();
  assert.deepEqual(h.received[0].value, { x: 0.2, y: 0.8 });
  assert.equal(Object.isFrozen(h.received[0]), true);
  for (let i = 0; i < 1000; i++) h.runtime.publish(h.source, { x: 0.4, y: 0.6 });
  h.runtime.flush(); assert.equal(h.received.length, 1); assert.equal(h.connection.status().pending, 1);
  h.setNow(10); h.runtime.flush(); assert.equal(h.received.length, 2);
});

test("active route limits expose actual descriptor/grant intersections without renewing authority", () => {
  const h = harness({ authorize: () => ({ expiresAt: 1000, maxAgeMs: 50, maxHz: 20.5 }) });
  assert.equal(h.connection.limits(), undefined);
  assert.equal(h.connection.start().ok, true);
  const limits = h.connection.limits();
  assert.deepEqual(limits, { maxAgeMs: 50, maxHz: 20.5, expiresAt: 1000 });
  assert.equal(Object.isFrozen(limits), true);
  h.setNow(1000);
  assert.equal(h.connection.limits(), undefined);
  assert.equal(h.releases(), 1);
  assert.equal(h.runtime.clockDomain, "embedded");
});
test("a source readiness deadline closes an active route before further delivery", () => {
  const h = harness();
  assert.deepEqual(h.runtime.setReadiness(h.source, "available", 1), { ok: true, value: undefined });
  assert.equal(h.connection.start().ok, true);
  assert.equal(h.runtime.publish(h.source, { x: 0.2, y: 0.8 }).ok, true);
  h.setNow(2);
  h.runtime.flush();
  assert.equal(h.connection.status().state, "closed");
  assert.equal(h.releases(), 1);
  assert.deepEqual(h.received, []);
  assert.equal(h.runtime.publish(h.source, { x: 0.2, y: 0.8 }).ok, false);
  const next = h.runtime.route(h.request);
  assert.equal(next.start().ok, false);
  h.runtime.close();
});
test("route constraints narrow host authority, remain immutable and cap renewal/dispatch", () => {
  const h = harness();
  const constraints = { expiresAt: 100, maxAgeMs: 30, maxHz: 20 };
  const route = h.runtime.route({ ...h.request, constraints }); constraints.expiresAt = 10000;
  assert.equal(route.start().ok, true); assert.deepEqual(route.limits(), { expiresAt: 100, maxAgeMs: 30, maxHz: 20 });
  h.setNow(50); assert.equal(route.renew("owner").ok, true);
  h.setNow(99); h.runtime.publish(h.source, { x: 0.9, y: 0.9 });
  h.setNow(100); h.runtime.flush(); assert.equal(h.received.length, 0); assert.equal(h.releases(), 1);
  const invalid = h.runtime.route({ ...h.request, constraints: { expiresAt: 101, maxAgeMs: 0 } });
  assert.equal(invalid.start().ok, false);
});

test("exclusive ownership, renewal and expiry release exactly once", () => {
  const h = harness(); assert.equal(h.connection.start().ok, true);
  const other = h.runtime.route({ ...h.request, principalId: "other" });
  assert.deepEqual(other.start(), { ok: false, reason: "busy" });
  assert.equal(h.connection.renew("other").ok, false);
  h.setNow(1500); h.runtime.flush();
  assert.equal(h.connection.status().state, "closed"); assert.equal(h.releases(), 1);
  h.connection.stop(); h.runtime.revoke(h.connection); assert.equal(h.releases(), 1);
  assert.equal(other.start().ok, true);
});

test("unavailable quality invalidates a route instead of producing false input", () => {
  const h = harness(); h.connection.start();
  h.runtime.publish(h.source, { x: 0.8, y: 0.8 });
  assert.equal(h.runtime.publish(h.source, undefined, { quality: "unavailable" }).ok, false);
  h.runtime.flush(); assert.equal(h.received.length, 0); assert.equal(h.releases(), 1);
});

test("stale, invalid, foreign-clock and out-of-order observations do not reach a sink", () => {
  const h = harness(); h.connection.start();
  assert.equal(h.runtime.publish(h.source, { x: NaN, y: 0 }).ok, false);
  assert.equal(h.runtime.publish(h.source, { x: 0, y: 0 }, { clockDomain: "another-device" }).ok, false);
  assert.equal(h.runtime.publish(h.source, { x: 0, y: 0 }, { timestamp: 1 }).ok, false);
  h.runtime.publish(h.source, { x: 0.3, y: 0.3 }, { sequence: 4 });
  assert.equal(h.runtime.publish(h.source, { x: 0.9, y: 0.9 }, { sequence: 3 }).ok, false);
  h.setNow(101); h.runtime.flush(); assert.equal(h.received.length, 0);
});

test("reliable command admission is bounded and cannot extend duplicate deadlines", () => {
  const h = harness({ command: true });
  const route = h.runtime.route({ ...h.request, queueCapacity: 1 }); route.start();
  assert.equal(h.runtime.publish(h.source, true, { operationId: "1", deadline: 100 }).ok, true);
  assert.equal(h.runtime.publish(h.source, false, { operationId: "1", deadline: 200 }).ok, false);
  assert.equal(h.runtime.publish(h.source, false, { operationId: "2", deadline: 100 }).ok, false);
  h.setNow(100); h.runtime.flush(); assert.equal(h.received.length, 0);
  assert.equal(route.operations()[0].state, "expired");
  h.setNow(1200); h.runtime.flush();
  assert.equal(h.runtime.publish(h.source, true, { operationId: "1", deadline: 1300 }).ok, false);
});

test("async revocation cancels without blocking and cannot apply into a replacement route", async () => {
  let finish: (() => void) | undefined;
  let applied = 0;
  let context: DeliveryContext | undefined;
  const h = harness({ command: true, apply: async (_observation, value) => {
    context = value;
    await new Promise<void>((resolve) => { finish = resolve; });
    if (value.isCurrent() && !value.signal.aborted) { applied++; value.reportEvidence("observed"); }
  } });
  h.connection.start(); h.runtime.publish(h.source, true, { operationId: "1", deadline: 100 }); h.runtime.flush();
  h.runtime.revoke(h.connection);
  assert.equal(context?.signal.aborted, true); assert.equal(h.releases(), 1);
  const replacement = h.runtime.route(h.request); assert.equal(replacement.start().ok, true);
  finish?.(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(applied, 0); assert.equal(replacement.status().state, "active");
  assert.equal(h.connection.operations()[0].state, "cancelled"); h.runtime.close();
});

test("authorization reentry and endpoint removal cannot bypass route activation", () => {
  const h = harness({ authorize: () => {
    const nested = h.runtime.route(h.request);
    assert.equal(nested.start().ok, false);
    h.runtime.unregister(h.source);
    return { expiresAt: 10000, maxAgeMs: 100 };
  } });
  assert.equal(h.connection.start().ok, false);
  h.runtime.flush(); assert.equal(h.received.length, 0);
});

test("provider failure closes the route and reentrant flush does not recurse", () => {
  const h = harness({ apply: () => { h.runtime.flush(); throw new Error("adapter failed"); } });
  h.connection.start(); h.runtime.publish(h.source, { x: 0, y: 0 }); h.runtime.flush();
  assert.equal(h.connection.status().state, "closed"); assert.equal(h.releases(), 1);
  assert.equal(h.connection.status().reason, "provider-failed");
});

test("unit mismatch and independent runtime handles are rejected", () => {
  const h = harness();
  const wrong = device("other", false, true); wrong.capabilities[0].value.unit = "m";
  const sink = h.runtime.registerSink({ device: wrong, capability: "control", apply() {}, release() {} });
  h.runtime.setReadiness(sink, "available");
  assert.equal(h.runtime.route({ ...h.request, to: sink }).start().ok, false);
  const other = harness();
  assert.equal(h.runtime.route({ ...h.request, to: other.sink }).start().ok, false);
});

test("registry, route and subscriber capacities fail explicitly", () => {
  const runtime = createDeviceRuntime({ now: () => 0, maxRegistrations: 2, maxRoutes: 1,
    authorize: () => ({ expiresAt: 5000, maxAgeMs: 100 }) });
  const source = runtime.registerSource({ device: device("phone"), capability: "control" });
  const output = device("screen", false, true);
  const sink = runtime.registerSink({ device: output, capability: "control", apply() {}, release() {} });
  assert.throws(() => runtime.registerSource({ device: device("extra"), capability: "control" }));
  runtime.setReadiness(source, "available"); runtime.setReadiness(sink, "available");
  const request = { from: source, to: sink, principalId: "owner", applicationId: "demo", sessionId: "test" };
  assert.equal(runtime.route(request).start().ok, true);
  assert.deepEqual(runtime.route(request).start(), { ok: false, reason: "capacity" });
  runtime.close(); assert.equal(runtime.publish(source, { x: 0, y: 0 }).ok, false);
});

test("work published by a processor waits for the next flush", () => {
  const h = harness({ apply: () => { h.runtime.publish(extraSource, { x: 0.9, y: 0.2 }); } });
  const extraSource = h.runtime.registerSource({ device: device("derived"), capability: "control" });
  const output: Observation[] = [];
  const extraSink = h.runtime.registerSink({ device: device("output", false, true), capability: "control",
    apply: (observation) => { output.push(observation); }, release() {} });
  h.runtime.setReadiness(extraSource, "available"); h.runtime.setReadiness(extraSink, "available");
  h.connection.start(); h.runtime.route({ ...h.request, from: extraSource, to: extraSink }).start();
  h.runtime.publish(h.source, { x: 0, y: 0 }); h.runtime.flush();
  assert.equal(output.length, 0); h.runtime.flush(); assert.equal(output.length, 1);
});

test("unsettled async work remains bounded across revocation and replacement", async () => {
  let calls = 0;
  const finishes: (() => void)[] = [];
  const runtime = createDeviceRuntime({ now: () => 0, maxPendingDeliveries: 1,
    authorize: () => ({ expiresAt: 5000, maxAgeMs: 100 }) });
  const source = runtime.registerSource({ device: device("phone"), capability: "control" });
  const sink = runtime.registerSink({ device: device("screen", false, true), capability: "control",
    apply: async () => { calls++; await new Promise<void>((resolve) => finishes.push(resolve)); }, release() {} });
  runtime.setReadiness(source, "available"); runtime.setReadiness(sink, "available");
  const request = { from: source, to: sink, principalId: "owner", applicationId: "demo", sessionId: "test" };
  const first = runtime.route(request); first.start(); runtime.publish(source, { x: 0, y: 0 }); runtime.flush(); first.stop();
  const second = runtime.route(request); second.start(); runtime.publish(source, { x: 1, y: 1 }); runtime.flush();
  assert.equal(calls, 1); assert.equal(second.status().pending, 1);
  finishes[0](); await new Promise<void>((resolve) => setImmediate(resolve)); runtime.flush(); assert.equal(calls, 2);
  finishes[1](); runtime.close();
});

test("partition providers receive the partition on apply and release", () => {
  const h = harness(); const descriptor = device("partition-output", false, true);
  const declared = { ...descriptor, capabilities: [{ ...descriptor.capabilities[0], ownership: { mode: "partitioned", partitions: ["left", "right"] } }] };
  const applied: string[] = [], released: string[] = [];
  const sink = h.runtime.registerSink({ device: declared, capability: "control",
    apply: (_value, context) => { applied.push(context.partition!); }, release: (_reason, context) => { released.push(context.partition!); } });
  h.runtime.setReadiness(sink, "available");
  const left = h.runtime.route({ ...h.request, to: sink, partition: "left" });
  const right = h.runtime.route({ ...h.request, to: sink, partition: "right" }); left.start(); right.start();
  h.runtime.publish(h.source, { x: 0, y: 0 }); h.runtime.flush(); left.stop();
  assert.deepEqual(applied, ["left", "right"]); assert.deepEqual(released, ["left"]);
  assert.equal(right.status().state, "active"); h.runtime.close();
});

test("reliable dispatch respects the effective grant cadence", () => {
  const h = harness({ command: true, authorize: () => ({ expiresAt: 10000, maxAgeMs: 5000, maxHz: 1 }) });
  h.connection.start();
  h.runtime.publish(h.source, true, { operationId: "1", deadline: 3000 });
  h.runtime.publish(h.source, false, { operationId: "2", deadline: 3000 });
  h.runtime.flush(); assert.equal(h.received.length, 1);
  h.setNow(999); h.runtime.flush(); assert.equal(h.received.length, 1);
  h.setNow(1000); h.runtime.flush(); assert.equal(h.received.length, 2);
});

test("stale or foreign-clock loss reports cannot revoke a newer observation", () => {
  const h = harness(); h.connection.start();
  h.runtime.publish(h.source, { x: 0.3, y: 0.3 }, { sequence: 10 });
  h.runtime.publish(h.source, undefined, { sequence: 1, quality: "unavailable" });
  assert.equal(h.connection.status().state, "active");
  h.runtime.publish(h.source, undefined, { sequence: 11, quality: "stale", clockDomain: "foreign" });
  assert.equal(h.connection.status().state, "active");
  h.runtime.flush(); assert.equal(h.received.length, 1);
  h.runtime.publish(h.source, undefined, { sequence: 11, quality: "unavailable" });
  assert.equal(h.connection.status().state, "closed");
});

test("expired async operations retain late evidence until completion retention elapses", async () => {
  let finish: (() => void) | undefined;
  let context: DeliveryContext | undefined;
  const h = harness({ command: true, apply: async (_observation, current) => {
    context = current; await new Promise<void>((resolve) => { finish = resolve; });
  } });
  const route = h.runtime.route({ ...h.request, leaseMs: 10000 }); route.start();
  h.runtime.publish(h.source, true, { operationId: "1", deadline: 100 }); h.runtime.flush();
  h.setNow(1101); h.runtime.flush();
  assert.equal(route.operations()[0]?.state, "expired");
  context!.reportEvidence("observed"); finish!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(route.operations()[0]?.state, "observed");
  h.setNow(2100); h.runtime.flush(); assert.equal(route.operations().length, 1);
  h.setNow(2101); h.runtime.flush(); assert.equal(route.operations().length, 0); h.runtime.close();
});

test("asynchronous command result, effect observation and non-idempotent replay stay separate", async () => {
  let finish: (() => void) | undefined;
  let context: DeliveryContext | undefined;
  const h = harness({ command: true, apply: async (_observation, current) => {
    context = current;
    current.reportEvidence('dispatched');
    await new Promise<void>(resolve => { finish = resolve; });
  } });
  assert.equal(h.connection.start().ok, true);
  assert.equal(h.runtime.publish(h.source, true, { operationId: '1', deadline: 100 }).ok, true);
  h.runtime.flush();
  assert.deepEqual(h.connection.operations()[0], { id: '1', deadline: 100, state: 'dispatched',
    handlerResult: 'running', effectEvidence: 'dispatched' });
  assert.equal(h.runtime.publish(h.source, true, { operationId: '1', deadline: 200 }).ok, false);
  finish!(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.connection.operations()[0], { id: '1', deadline: 100, state: 'unverified',
    handlerResult: 'returned', effectEvidence: 'dispatched' });
  context!.reportEvidence('observed');
  assert.deepEqual(h.connection.operations()[0], { id: '1', deadline: 100, state: 'observed',
    handlerResult: 'returned', effectEvidence: 'observed' });
  h.connection.stop('owner-left');
  const next = h.runtime.route(h.request);
  assert.equal(next.start().ok, true);
  assert.equal(h.runtime.publish(h.source, true, { operationId: '1', deadline: 200 }).ok, false);
  h.runtime.close();
});

test("a declared asynchronous job is invoked and can finish without effect proof", async () => {
  let now = 0;
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const runtime = createDeviceRuntime({ now: () => now, authorize: request => {
    assert.equal(request.sinkOperation, 'invoke');
    return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 };
  } });
  const source = runtime.registerSource({ device: device('submitter', true), capability: 'control' });
  const sinkDevice = { ...device('printer', true, true), capabilities: [{ ...device('printer', true, true).capabilities[0], kind: 'job' }] };
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'control',
    async apply(_observation, context) {
      signal = context.signal;
      context.reportEvidence('dispatched');
      await new Promise<void>(resolve => { finish = resolve; });
    }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'example', sessionId: 'session' });
  assert.equal(route.start().ok, true);
  assert.equal(runtime.publish(source, true, { operationId: '1', deadline: 500 }).ok, true);
  runtime.flush();
  assert.equal(route.operations()[0].handlerResult, 'running');
  finish!(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(route.operations()[0], { id: '1', deadline: 500, state: 'unverified',
    handlerResult: 'returned', effectEvidence: 'dispatched' });
  now = 200;
  assert.equal(runtime.publish(source, true, { operationId: '2', deadline: 600 }).ok, true);
  runtime.flush();
  assert.equal(route.operations()[1].handlerResult, 'running');
  runtime.revoke(route);
  assert.equal(signal?.aborted, true);
  assert.equal(route.operations()[1].handlerResult, 'running');
  finish!(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(route.operations()[1].handlerResult, 'returned');
  assert.equal(route.operations()[1].state, 'cancelled');
  runtime.close();
});
