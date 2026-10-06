import assert from 'node:assert/strict';
import { createOperatorHealthMonitor, createRuntimeInspector, parseDeviceDescriptor } from '@101/connect';

/** Owned Node software example. The transport is borrowed; this caller never
 * disconnects it. Metadata approval and resource route approval are separate. */
export function createOwnedOperatorExample({ transport, now = Date.now }) {
  let metadataAllowed = false, routesAllowed = false, sequence = 0, deliveries = 0, lastRss = 0;
  const abort = new AbortController(), clockDomain = 'private-rss-clock';
  const inspector = createRuntimeInspector({ now, clockDomain, authorize(request) {
    if (routesAllowed && request.principalId === 'private-principal' && request.applicationId === 'private-application' && request.sessionId === 'private-session')
      return { expiresAt: now() + 5000, maxAgeMs: 1000, maxHz: 100 };
  } });
  const runtime = inspector.runtime;
  function device(id, sink = false, reliable = false) {
    return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'PRIVATE_DEVICE_LABEL', revision: 1,
      adapter: { id: 'example:owned-operator', version: '1.0.0' }, runtime: { platform: 'node-process' },
      metadata: { credential: 'PRIVATE_DESCRIPTOR_CREDENTIAL' }, capabilities: [{ id: 'private-signal', schemaVersion: 1,
        semantic: reliable ? 'example:owned-notification' : 'example:resident-memory', kind: reliable ? sink ? 'command' : 'event' : 'property',
        value: reliable ? { type: 'boolean' } : { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
        delivery: reliable ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
        permissions: [sink ? reliable ? 'invoke' : 'write' : 'subscribe'] }] });
  }
  const source = runtime.registerSource({ device: device('private-rss-source'), capability: 'private-signal' });
  const sink = runtime.registerSink({ device: device('private-rss-sink', true), capability: 'private-signal', apply(observation, context) {
    if (context.isCurrent()) { lastRss = observation.value; deliveries++; }
  }, release() { lastRss = 0; } });
  const commandSource = runtime.registerSource({ device: device('private-event-source', false, true), capability: 'private-signal' });
  const commandSink = runtime.registerSink({ device: device('private-command-sink', true, true), capability: 'private-signal', apply() {}, release() {} });
  for (const handle of [source, sink, commandSource, commandSink]) assert.ok(runtime.setReadiness(handle, 'available').ok);
  const request = { principalId: 'private-principal', applicationId: 'private-application', sessionId: 'private-session' };
  const denied = runtime.route({ ...request, from: source, to: sink }); assert.equal(denied.start().ok, false);
  const monitor = createOperatorHealthMonitor({ now,
    scope: { ownerId: 'private-owner', operatorId: 'private-operator', applicationId: 'private-application', sessionId: 'private-session', purpose: 'health' },
    sources: [{ id: 'private-runtime', kind: 'runtime-inspector', poll: () => inspector.snapshot() },
      { id: 'private-wss', kind: 'wss-transport', poll: () => ({ ...transport.status(), state: transport.state }) }],
    authorize(scope) { return metadataAllowed ? { scope, expiresAt: now() + 2000, isCurrent: () => metadataAllowed, signal: abort.signal } : undefined; } });
  let route, commands;
  return {
    monitor, inspector,
    allowMetadata(value) { metadataAllowed = value; },
    async approveMetadata() { metadataAllowed = true; return monitor.start(); },
    startRoutes() {
      routesAllowed = true; route = runtime.route({ ...request, from: source, to: sink }); assert.ok(route.start().ok);
      commands = runtime.route({ ...request, from: commandSource, to: commandSink, queueCapacity: 2 }); assert.ok(commands.start().ok);
    },
    readRss() {
      const rss = process.memoryUsage().rss; assert.ok(Number.isSafeInteger(rss) && rss > 0);
      assert.ok(runtime.publish(source, rss, { sequence: ++sequence, timestamp: now(), clockDomain }).ok); runtime.flush();
      assert.equal(lastRss, rss); return { rss, deliveries };
    },
    queueLoad() {
      for (let index = 1; index <= 3; index++) {
        const result = runtime.publish(commandSource, true, { operationId: String(index), deadline: now() + 1000 });
        assert.equal(result.ok, index <= 2, JSON.stringify(result));
      }
    },
    revokeRoutes() { if (route) runtime.revoke(route); if (commands) runtime.revoke(commands); },
    abortMetadata() { abort.abort(); },
    close() { monitor.close(); inspector.close(); },
  };
}
