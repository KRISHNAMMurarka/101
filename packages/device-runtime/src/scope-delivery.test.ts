import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import type { AuthorizationRequest, DeliveryContext } from './types.ts';

function device(id: string, reliable: boolean, sink = false) {
  return { schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'example:scope-delivery', version: '1.0.0' }, runtime: { platform: 'embedded-node' },
    capabilities: [{ id: 'signal', semantic: 'example:scope-delivery', schemaVersion: 1,
      kind: sink ? reliable ? 'command' : 'property' : reliable ? 'event' : 'sample', value: { type: 'boolean' },
      delivery: reliable ? { mode: 'reliable', maxAgeMs: 5000 } : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: sink ? [reliable ? 'invoke' : 'write'] : ['subscribe'],
      ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] };
}
const scope = { principalId: 'owner', applicationId: 'quota', sessionId: 'room' };
const key = (value: typeof scope) => JSON.stringify([value.principalId, value.applicationId, value.sessionId]);

function fixture(reliable: boolean, limit?: number) {
  let now = 0, operation = 0;
  const approved = new Map<string, string>();
  let sourceId = '';
  const options = { now: () => now, maxPendingDeliveries: 4,
    ...(limit === undefined ? {} : { maxPendingDeliveriesPerScope: limit }),
    authorize(request: AuthorizationRequest) {
      if (request.source.registrationId !== sourceId || approved.get(request.sink.registrationId) !== key(request) ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== (reliable ? 'invoke' : 'write')) return;
      return { expiresAt: 10000, maxAgeMs: 5000, maxHz: 100 };
    } };
  const runtime = createDeviceRuntime(options);
  const source = runtime.registerSource({ device: device('source', reliable), capability: 'signal' });
  sourceId = source.id; runtime.setReadiness(source, 'available');
  const held: { context: DeliveryContext; settle(failed?: boolean): void }[] = [];
  let effects = 0, sinks = 0;
  function route(selected: typeof scope, slow: boolean) {
    const sink = runtime.registerSink({ device: device(`sink-${++sinks}`, reliable, true), capability: 'signal',
      apply(_observation, context) {
        assert.equal(context.isCurrent(), true);
        if (!slow) { effects++; return; }
        return new Promise<void>((resolve, reject) => held.push({ context,
          settle: failed => failed ? reject(Error('provider failed after retirement')) : resolve() }));
      }, release() {} });
    approved.set(sink.id, key(selected)); runtime.setReadiness(sink, 'available');
    const connection = runtime.route({ from: source, to: sink, ...selected, queueCapacity: 4 });
    assert.equal(connection.start().ok, true); return connection;
  }
  function publish() { now += 20; assert.equal(runtime.publish(source, true,
    reliable ? { operationId: String(++operation), deadline: now + 1000 } : {}).ok, true); runtime.flush(); }
  async function close() { runtime.close(); for (const entry of held) entry.settle(); await new Promise<void>(resolve => setImmediate(resolve)); }
  return { runtime, route, publish, held, effects: () => effects, close };
}

for (const reliable of [false, true]) {
  test(`${reliable ? 'reliable' : 'latest'} scope cap leaves capacity for other exact authorized tuples after retirement`, async () => {
    for (const failed of [false, true]) {
      const f = fixture(reliable, 1);
      try {
        const first = f.route(scope, true);
        f.route(scope, true); f.route(scope, true);
        f.route({ ...scope, principalId: 'another-owner' }, false);
        f.route({ ...scope, applicationId: 'another-app' }, false);
        f.route({ ...scope, sessionId: 'another-room' }, false);
        f.publish();
        assert.equal(f.held.length, 1, 'One authorized scope cannot reserve every global slot');
        assert.equal(f.effects(), 3, 'Each independently authorized tuple retains admission capacity');
        first.stop('replacement');
        assert.equal(f.held[0]!.context.signal.aborted, true);
        assert.equal(f.held[0]!.context.isCurrent(), false);
        f.publish();
        assert.equal(f.held.length, 1, 'Logical retirement cannot release actual unresolved provider work');
        assert.equal(f.effects(), 6);
        f.held[0]!.settle(failed); await new Promise<void>(resolve => setImmediate(resolve));
        f.publish();
        assert.equal(f.held.length, 2, 'Raw provider settlement permits a current same-scope successor');
        assert.equal(f.effects(), 9);
      } finally { await f.close(); }
    }
  });
}

test('scope tuple encoding keeps delimiter-containing identities independent', async () => {
  const f = fixture(false, 1);
  try {
    f.route({ principalId: 'owner|app', applicationId: 'room', sessionId: 'session' }, true);
    f.route({ principalId: 'owner', applicationId: 'app|room', sessionId: 'session' }, true);
    f.publish(); assert.equal(f.held.length, 2);
  } finally { await f.close(); }
});

test('omitted scope cap preserves the existing global admission policy', async () => {
  const f = fixture(false);
  try { f.route(scope, true); f.route(scope, true); f.route(scope, true); f.publish(); assert.equal(f.held.length, 3); }
  finally { await f.close(); }
});

test('scope capacity is an integer within the selected global capacity', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 5]) {
    const options = { authorize: () => undefined, maxPendingDeliveries: 4, maxPendingDeliveriesPerScope: value };
    assert.throws(() => createDeviceRuntime(options), RangeError);
  }
});
