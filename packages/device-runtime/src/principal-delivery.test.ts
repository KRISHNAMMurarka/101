import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '@101/connect';
import type { AuthorizationRequest, Connection, DeliveryContext, RuntimeOptions } from '@101/connect';

function device(id: string, reliable: boolean, sink = false) {
  return { schemaVersion: 1, id, label: id, revision: 1, adapter: { id: 'example:principal-delivery', version: '1.0.0' }, runtime: { platform: 'embedded-node' },
    capabilities: [{ id: 'signal', semantic: 'example:principal-delivery', schemaVersion: 1,
      kind: sink ? reliable ? 'command' : 'property' : reliable ? 'event' : 'sample', value: { type: 'boolean' },
      delivery: reliable ? { mode: 'reliable', maxAgeMs: 5000 } : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: sink ? [reliable ? 'invoke' : 'write'] : ['subscribe'], ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] };
}
const tuple = (scope: { principalId: string; applicationId: string; sessionId: string }) => JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId]);
const cohort = (principalId: string, slot: number) => ({ principalId, applicationId: `application-${slot}`, sessionId: `session-${slot}` });
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture(reliable: boolean, principalCap?: number, scopeCap = 1) {
  let at = 100, sequence = 0, sinks = 0, sourceId = '';
  const approved = new Map<string, string>(), calls: string[] = [], releases: string[] = [];
  const held: { principal: string; context: DeliveryContext; resolve(): void; reject(): void }[] = [];
  const options = { now: () => at, maxPendingDeliveries: 4, maxPendingDeliveriesPerScope: scopeCap,
    ...(principalCap === undefined ? {} : { maxPendingDeliveriesPerPrincipal: principalCap }),
    authorize(request: AuthorizationRequest) {
      if (request.source.registrationId !== sourceId || request.source.deviceId !== 'source' || request.source.capabilityId !== 'signal' ||
        request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 || request.sink.capabilityId !== 'signal' ||
        request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1 || approved.get(request.sink.registrationId) !== tuple(request) ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== (reliable ? 'invoke' : 'write') || request.partition !== undefined) return;
      return { expiresAt: 20000, maxAgeMs: 5000, maxHz: 100 };
    } };
  // Before the public option exists, OLD runtime ignores this extra property.
  const runtime = createDeviceRuntime(options as RuntimeOptions);
  const source = runtime.registerSource({ device: device('source', reliable), capability: 'signal' }); sourceId = source.id;
  assert.equal(runtime.setReadiness(source, 'available').ok, true);
  function route(scope: ReturnType<typeof cohort>, mode: 'held' | 'sync' | 'resolve' | 'reject' | 'throw' = 'held', permitted = true,
    onApply?: (connection: Connection, context: DeliveryContext) => void) {
    const sink = runtime.registerSink({ device: device(`sink-${++sinks}`, reliable, true), capability: 'signal',
      apply(_value, context) {
        assert.equal(context.isCurrent(), true); calls.push(scope.principalId); onApply?.(connection, context);
        if (mode === 'sync') return;
        if (mode === 'resolve') return Promise.resolve();
        if (mode === 'reject') return Promise.reject(new Error('Expected software provider failure'));
        if (mode === 'throw') throw new Error('Expected synchronous provider failure');
        return new Promise<void>((resolve, reject) => held.push({ principal: scope.principalId, context, resolve,
          reject: () => reject(new Error('Expected retired provider failure')) }));
      }, release() { releases.push(scope.principalId); } });
    if (permitted) approved.set(sink.id, tuple(scope)); assert.equal(runtime.setReadiness(sink, 'available').ok, true);
    const connection = runtime.route({ from: source, to: sink, ...scope, queueCapacity: 16 });
    assert.equal(connection.start().ok, permitted); return connection;
  }
  function publish() { at += 20; assert.equal(runtime.publish(source, true, reliable ? { operationId: String(++sequence), deadline: at + 1000 } : {}).ok, true); runtime.flush(); }
  async function close() { runtime.close(); for (const work of held) work.resolve(); await drain(); }
  return { runtime, source, route, publish, held, calls, releases, close, advance() { at += 20; }, deny(connection: Connection) { runtime.revoke(connection); } };
}

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} aggregate principal cap protects another approved principal across distinct application/session tuples`, async () => {
  const f = fixture(reliable, 1);
  try { for (let i = 0; i < 4; i++) f.route(cohort('A', i)); f.route(cohort('B', 0), 'sync'); f.publish();
    assert.equal(f.calls.filter(principal => principal === 'B').length, 1, 'Principal A must not occupy every global raw-provider slot through distinct approved tuples');
    assert.equal(f.held.length, 1); assert.equal(f.held[0]!.principal, 'A'); }
  finally { await f.close(); }
});

for (const reliable of [false, true]) for (const failed of [false, true]) test(`${reliable ? 'reliable' : 'latest'} Stop retains principal quota until the ${failed ? 'rejected' : 'fulfilled'} raw apply settles`, async () => {
  const f = fixture(reliable, 1);
  try { const first = f.route(cohort('A', 0)); f.route(cohort('B', 0), 'sync'); f.publish();
    assert.equal(f.held.length, 1); first.stop('replacement'); f.route(cohort('A', 1));
    assert.equal(f.held[0]!.context.signal.aborted, true); assert.equal(f.held[0]!.context.isCurrent(), false);
    assert.equal(typeof first.whenSettled, 'function'); let settled = false; const barrier = first.whenSettled!(); void barrier.then(() => { settled = true; });
    f.publish(); await drain(); assert.equal(settled, false); assert.equal(f.held.length, 1); assert.equal(f.calls.filter(id => id === 'B').length, 2);
    if (failed) f.held[0]!.reject(); else f.held[0]!.resolve(); await barrier; f.publish();
    assert.equal(f.held.length, 2); assert.equal(f.held[1]!.principal, 'A'); assert.equal(f.calls.filter(id => id === 'B').length, 3);
    assert.equal(f.releases.filter(id => id === 'A').length, 1); }
  finally { await f.close(); }
});

for (const reliable of [false, true]) for (const mode of ['sync', 'resolve', 'reject', 'throw'] as const) test(`${reliable ? 'reliable' : 'latest'} ${mode} completion balances principal reservations and later capacity`, async () => {
  const f = fixture(reliable, 1);
  try { f.route(cohort('A', 0), mode); f.route(cohort('A', 1), 'sync'); f.route(cohort('B', 0), 'sync'); f.publish();
    assert.equal(f.calls.filter(id => id === 'A').length, 1); assert.equal(f.calls.filter(id => id === 'B').length, 1);
    if (mode === 'resolve' || mode === 'reject') { f.advance(); f.runtime.flush(); assert.equal(f.calls.filter(id => id === 'A').length, 1, 'Actual asynchronous returns retain admission until settlement'); }
    await drain(); f.advance(); f.runtime.flush(); assert.equal(f.calls.filter(id => id === 'A').length, 2);
    f.publish(); assert.equal(f.calls.filter(id => id === 'B').length, 2, 'Empty latest/reliable attempts and provider completion must balance every quota'); }
  finally { await f.close(); }
});

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} principal and exact-scope caps intersect without replacing either policy`, async () => {
  const f = fixture(reliable, 2);
  try { f.route(cohort('A', 0)); f.route(cohort('A', 0)); f.route(cohort('A', 1)); f.route(cohort('A', 2)); f.route(cohort('B', 0), 'sync'); f.publish();
    assert.equal(f.held.length, 2); assert.equal(f.calls.filter(id => id === 'B').length, 1); }
  finally { await f.close(); }
});

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} denied routes never reserve principal or global delivery capacity`, async () => {
  const f = fixture(reliable, 1);
  try { for (let i = 0; i < 4; i++) f.route(cohort('A', i), 'held', false); f.route(cohort('A', 4)); f.route(cohort('B', 0), 'sync'); f.publish();
    assert.equal(f.held.length, 1); assert.equal(f.calls.filter(id => id === 'A').length, 1); assert.equal(f.calls.filter(id => id === 'B').length, 1); }
  finally { await f.close(); }
});

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} reentrant retirement and replacement cannot reuse an in-progress principal reservation`, async () => {
  const f = fixture(reliable, 1); let replacement: Connection | undefined;
  try { const first = f.route(cohort('A', 0), 'held', true, connection => {
      connection.stop('during-apply'); replacement = f.route(cohort('A', 1), 'sync'); f.publish();
    });
    f.route(cohort('B', 0), 'sync'); f.publish(); assert.equal(f.held.length, 1); assert.ok(replacement);
    f.publish(); assert.equal(f.calls.filter(id => id === 'A').length, 1); assert.equal(f.held[0]!.context.isCurrent(), false);
    f.held[0]!.resolve(); await first.whenSettled!(); f.publish(); assert.equal(f.calls.filter(id => id === 'A').length, 2); assert.equal(replacement.status().state, 'active'); }
  finally { await f.close(); }
});

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} omitted principal cap preserves the current global and scope admission policy`, async () => {
  const f = fixture(reliable);
  try { for (let i = 0; i < 4; i++) f.route(cohort('A', i)); f.publish(); assert.equal(f.held.length, 4); }
  finally { await f.close(); }
});

test('principal identity aggregation is exact and does not fold case or delimiter-containing identities', async () => {
  const f = fixture(false, 1);
  try { for (const id of ['A', 'a', 'A|application-0', 'A:application-0']) f.route(cohort(id, 0)); f.publish();
    assert.deepEqual(f.held.map(work => work.principal), ['A', 'a', 'A|application-0', 'A:application-0']); }
  finally { await f.close(); }
});

test('principal capacity accepts only an integer from one through selected global capacity', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 5, null, '1', {}, true]) {
    const options = { authorize: () => undefined, maxPendingDeliveries: 4, maxPendingDeliveriesPerPrincipal: value };
    assert.throws(() => createDeviceRuntime(options as unknown as RuntimeOptions), RangeError);
  }
  for (const value of [undefined, 1, 4]) {
    const runtime = createDeviceRuntime({ authorize: () => undefined, maxPendingDeliveries: 4, maxPendingDeliveriesPerPrincipal: value } as RuntimeOptions); runtime.close();
  }
});
