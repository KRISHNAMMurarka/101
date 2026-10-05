import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeInspector, InspectorDiagnosticError } from './inspector.ts';
import type { RouteRequest } from './types.ts';

function device(sink = false, schemaVersion = 1) {
  return { schemaVersion: 1, id: sink ? 'private-sink-id' : 'private-source-id', label: 'personal-device-label', revision: 1,
    adapter: { id: 'example:inspector', version: '1.0.0' }, runtime: { platform: 'local' },
    metadata: { token: 'authorization-token', privateKey: 'private-key' },
    capabilities: [{ id: 'private-capability-id', semantic: 'example:private-signal', schemaVersion,
      kind: sink ? 'command' : 'event', value: { type: 'boolean' },
      delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: [sink ? 'invoke' : 'subscribe'] }] };
}
function harness(traceCapacity = 12) {
  let now = 0, allow = false, deliveries = 0, releases = 0;
  const inspector = createRuntimeInspector({ now: () => now, traceCapacity, maxTrackedRoutes: 3,
    authorize: () => allow ? { expiresAt: 10000, maxAgeMs: 1000, maxHz: 100 } : undefined });
  const runtime = inspector.runtime;
  const source = runtime.registerSource({ device: device(), capability: 'private-capability-id' });
  const sink = runtime.registerSink({ device: device(true), capability: 'private-capability-id',
    apply() { deliveries++; }, release() { releases++; } });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const request = { from: source, to: sink, principalId: 'personal-principal', applicationId: 'private-application',
    sessionId: 'authorization-token', queueCapacity: 2 };
  return { inspector, runtime, source, sink, request, allow: () => { allow = true; },
    now: (value: number) => { now = value; }, deliveries: () => deliveries, releases: () => releases };
}

test('inspector follows real authority, typed delivery, bounded queues, readiness loss and revocation', () => {
  const h = harness();
  const denied = h.runtime.route(h.request);
  assert.deepEqual(denied.start(), { ok: false, reason: 'denied' });
  assert.equal(h.inspector.snapshot().routes[0]?.grant, 'denied');
  h.allow();
  const route = h.runtime.route(h.request); assert.equal(route.start().ok, true);
  assert.equal(h.inspector.snapshot().routes[1]?.grant, 'allowed');
  for (let operation = 1; operation <= 3; operation++) {
    const result = h.runtime.publish(h.source, true, { operationId: String(operation), deadline: 1000 });
    assert.equal(result.ok, operation <= 2);
  }
  let snapshot = h.inspector.snapshot();
  assert.equal(snapshot.routes[1]?.pending, 2);
  assert.equal(snapshot.routes[1]?.queueCapacity, 2);
  assert.equal(snapshot.routes[1]?.operations.length, 2);
  assert.ok(snapshot.errors.some(entry => entry.code === 'capacity'));
  h.runtime.flush(); assert.equal(h.deliveries(), 1);
  snapshot = h.inspector.snapshot();
  assert.equal(snapshot.routes[1]?.operations[0]?.handlerResult, 'returned');
  assert.equal(snapshot.routes[1]?.operations[0]?.effectEvidence, 'none');
  h.runtime.setReadiness(h.source, 'unavailable');
  assert.equal(h.inspector.snapshot().resources[0]?.readiness, 'unavailable');
  assert.equal(h.inspector.snapshot().routes[1]?.state, 'closed');
  assert.equal(h.releases(), 1);
  h.runtime.setReadiness(h.source, 'available');
  const replacement = h.runtime.route(h.request); assert.equal(replacement.start().ok, true);
  h.runtime.revoke(replacement);
  assert.equal(h.inspector.snapshot().routes[2]?.grant, 'revoked');
  h.runtime.flush(); assert.equal(h.deliveries(), 1);
  h.inspector.close();
});

test('reports exclude descriptor and identity fields, samples, provenance, arbitrary reasons and thrown messages', () => {
  const h = harness(); h.allow();
  const route = h.runtime.route(h.request); route.start();
  h.runtime.publish(h.source, 'sample-secret', { provenance: { secret: 'personal-provenance' } });
  route.stop('raw-secret-error');
  assert.throws(() => h.runtime.registerSource({ device: { ...device(), schemaVersion: 2, label: 'raw-secret-error' },
    capability: 'private-capability-id' }), error => error instanceof InspectorDiagnosticError && error.code === 'schema-version');
  assert.throws(() => h.runtime.registerSource({ device: { ...device(), capabilities: 'invalid', label: 'raw-secret-error' },
    capability: 'private-capability-id' }), error => error instanceof InspectorDiagnosticError && error.code === 'schema-invalid');
  const report = JSON.stringify(h.inspector.snapshot());
  for (const privateValue of ['private-source-id', 'private-sink-id', 'private-capability-id', 'personal-device-label',
    'authorization-token', 'private-key', 'personal-principal', 'private-application', 'sample-secret',
    'personal-provenance', 'raw-secret-error', 'example:private-signal']) assert.equal(report.includes(privateValue), false);
  assert.ok(h.inspector.snapshot().errors.some(entry => entry.code === 'schema-version'));
  assert.ok(h.inspector.snapshot().errors.some(entry => entry.code === 'schema-invalid'));
  h.inspector.close();
});

test('rejected route operations cannot retain mutable caller secrets in diagnostic snapshots', () => {
  const object = { token: 'SECRET_TOKEN' };
  const cyclic: { token: string; cycle?: unknown } = { token: 'SECRET_TOKEN' };
  cyclic.cycle = cyclic;
  for (const value of ['SECRET_TOKEN', object, ['SECRET_TOKEN'], cyclic]) {
    const h = harness();
    const route = h.runtime.route({ ...h.request, sourceOperation: value as unknown as RouteRequest['sourceOperation'] });
    const before = h.inspector.snapshot();
    assert.equal(before.routes[0]?.sourceOperation, 'unknown');
    assert.deepEqual(route.start(), { ok: false, reason: 'unsupported-operation' });
    const report = h.inspector.snapshot();
    assert.equal(report.routes[0]?.sourceOperation, 'unknown');
    assert.equal(JSON.stringify(report).includes('SECRET_TOKEN'), false);
    assert.ok(report.errors.some(entry => entry.code === 'unsupported-operation'));
    object.token = 'MUTATED_SECRET';
    assert.equal(before.routes[0]?.sourceOperation, 'unknown');
    assert.equal(JSON.stringify(before).includes('MUTATED_SECRET'), false);
    h.inspector.close();
  }
});

test('queue capacity diagnostics exclude malformed values and snapshot changing getters once', () => {
  for (const value of [{ token: 'SECRET_QUEUE' }, 'SECRET_QUEUE', 257, Number.MAX_SAFE_INTEGER]) {
    const h = harness();
    assert.throws(() => h.runtime.route({ ...h.request, queueCapacity: value as unknown as number }),
      error => error instanceof InspectorDiagnosticError);
    assert.equal(h.inspector.snapshot().routes.length, 0);
    assert.equal(JSON.stringify(h.inspector.snapshot()).includes('SECRET_QUEUE'), false);
    h.inspector.close();
  }
  const h = harness();
  let reads = 0;
  h.runtime.route({ ...h.request, get queueCapacity() { return (++reads === 1 ? 2 : { token: 'SECRET_QUEUE' }) as number; } });
  assert.equal(h.inspector.snapshot().routes[0]?.queueCapacity, 2);
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(h.inspector.snapshot()).includes('SECRET_QUEUE'), false);
  h.inspector.close();
});

test('schema mismatch and readiness expiry are current and immutable without private runtime access', () => {
  const h = harness(); h.allow();
  const incompatible = h.runtime.registerSink({ device: device(true, 2), capability: 'private-capability-id', apply() {}, release() {} });
  h.runtime.setReadiness(incompatible, 'available');
  const route = h.runtime.route({ ...h.request, to: incompatible });
  assert.deepEqual(route.start(), { ok: false, reason: 'incompatible' });
  assert.equal(h.inspector.snapshot().errors.at(-1)?.code, 'schema-version-mismatch');
  h.runtime.setReadiness(h.source, 'available', 1); h.now(2); h.runtime.flush();
  const report = h.inspector.snapshot();
  assert.equal(report.resources[0]?.readiness, 'stale');
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.resources[0]), true);
  assert.equal(Object.isFrozen(report.routes), true);
  h.inspector.close();
});

test('producer quality loss updates resource readiness and class providers keep their receiver', () => {
  const h = harness(); h.allow();
  class Sink {
    device = device(true);
    capability = 'private-capability-id';
    deliveries = 0;
    releases = 0;
    apply() { this.deliveries++; }
    release() { this.releases++; }
  }
  const provider = new Sink();
  const sink = h.runtime.registerSink(provider); h.runtime.setReadiness(sink, 'available');
  const route = h.runtime.route({ ...h.request, to: sink }); route.start();
  h.runtime.publish(h.source, true, { operationId: '1', deadline: 1000 }); h.runtime.flush();
  assert.equal(provider.deliveries, 1);
  assert.deepEqual(h.runtime.publish(h.source, true, { quality: 'unavailable' }), { ok: false, reason: 'unavailable' });
  assert.equal(h.inspector.snapshot().resources[0]?.readiness, 'unavailable');
  assert.equal(route.status().state, 'closed');
  assert.equal(provider.releases, 1);
  h.inspector.close();
});

test('tracked idle routes have an admission bound independent of the runtime active-route limit', () => {
  const h = harness();
  for (let index = 0; index < 3; index++) h.runtime.route(h.request);
  assert.throws(() => h.runtime.route(h.request), error => error instanceof InspectorDiagnosticError && error.code === 'capacity');
  assert.equal(h.inspector.snapshot().routes.length, 3);
  h.inspector.close();
});

test('unattached stale-quality ambiguity is explicit instead of claiming cached readiness is current', () => {
  const h = harness();
  assert.deepEqual(h.runtime.publish(h.source, true, { quality: 'stale' }), { ok: false, reason: 'stale' });
  assert.equal(h.inspector.snapshot().resources[0]?.readiness, 'unknown');
  h.runtime.setReadiness(h.source, 'available');
  assert.equal(h.inspector.snapshot().resources[0]?.readiness, 'available');
  h.inspector.close();
});

test('owned runtime clock shutdown is reflected with and without active routes', () => {
  for (const active of [true, false]) for (const loss of ['backwards', 'throwing']) {
    let now = 1, throwing = false;
    const inspector = createRuntimeInspector({ now: () => {
      if (throwing) throw new Error('SECRET_CLOCK_ERROR');
      return now;
    }, authorize: () => ({ expiresAt: 10000, maxAgeMs: 1000 }) });
    const source = inspector.runtime.registerSource({ device: device(), capability: 'private-capability-id' });
    const sink = inspector.runtime.registerSink({ device: device(true), capability: 'private-capability-id', apply() {}, release() {} });
    inspector.runtime.setReadiness(source, 'available'); inspector.runtime.setReadiness(sink, 'available');
    if (active) assert.equal(inspector.runtime.route({ from: source, to: sink, principalId: 'owner',
      applicationId: 'example', sessionId: 'local' }).start().ok, true);
    inspector.runtime.flush();
    if (loss === 'backwards') now = 0; else throwing = true;
    inspector.runtime.flush();
    const report = inspector.snapshot();
    assert.equal(report.closed, true, `${loss} clock closes inspector (active=${active})`);
    assert.equal(report.resources.length, 0);
    assert.equal(report.routes.length, 0);
    assert.equal(JSON.stringify(report).includes('SECRET_CLOCK_ERROR'), false);
    assert.throws(() => inspector.runtime.route({ from: source, to: sink, principalId: 'owner',
      applicationId: 'example', sessionId: 'local' }), error => error instanceof InspectorDiagnosticError && error.code === 'closed');
    inspector.close();
  }
});

test('shutdown discovered while reading route limits leaves no resources advertised as available', () => {
  let calls = 0, failAt = Infinity;
  const inspector = createRuntimeInspector({ now: () => {
    if (++calls === failAt) throw new Error('SECRET_CLOCK_ERROR');
    return 1;
  }, authorize: () => ({ expiresAt: 10000, maxAgeMs: 1000 }) });
  const source = inspector.runtime.registerSource({ device: device(), capability: 'private-capability-id' });
  const sink = inspector.runtime.registerSink({ device: device(true), capability: 'private-capability-id', apply() {}, release() {} });
  inspector.runtime.setReadiness(source, 'available'); inspector.runtime.setReadiness(sink, 'available');
  inspector.runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'example', sessionId: 'local' }).start();
  failAt = calls + 2;
  const report = inspector.snapshot();
  assert.equal(report.closed, true);
  assert.equal(report.resources.length, 0);
  assert.equal(report.routes.length, 0);
  inspector.close();
});

test('a caller supplied stop reason cannot impersonate an owned runtime shutdown', () => {
  const h = harness(); h.allow();
  const route = h.runtime.route(h.request); route.start();
  route.stop('runtime-closed');
  assert.equal(h.inspector.snapshot().closed, false);
  assert.equal(h.inspector.snapshot().resources.length, 2);
  assert.equal(h.runtime.route(h.request).start().ok, true);
  h.inspector.close();
});

test('trace and route retention stay bounded, teardown rejects work and releases owned routes', () => {
  const h = harness(4); h.allow();
  for (let index = 0; index < 40; index++) {
    const route = h.runtime.route(h.request); assert.equal(route.start().ok, true);
    route.stop('secret-reason');
  }
  let report = h.inspector.snapshot();
  assert.equal(report.trace.length, 4);
  assert.equal(report.routes.length, 3);
  assert.equal(report.traceCapacity, 4);
  const active = h.runtime.route(h.request); active.start();
  const releases = h.releases();
  h.inspector.close(); h.inspector.close();
  assert.equal(h.releases(), releases + 1);
  assert.equal(active.status().state, 'closed');
  report = h.inspector.snapshot();
  assert.equal(report.closed, true);
  assert.equal(report.resources.length, 0);
  assert.equal(report.routes.length, 0);
  assert.throws(() => h.runtime.route(h.request), error => error instanceof InspectorDiagnosticError && error.code === 'closed');
  assert.equal(h.runtime.publish(h.source, true).ok, false);
});
