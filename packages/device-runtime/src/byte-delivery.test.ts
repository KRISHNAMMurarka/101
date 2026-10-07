import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '@101/connect';
import type { Connection, DeliveryContext, EndpointHandle, Observation, PublishOptions, RuntimeOptions } from '@101/connect';

const textValue = (text: string) => Array.from({ length: Math.ceil(text.length / 10) }, () => 123456.789);
function device(id: string, reliable: boolean, sink = false, property = false) {
  return { schemaVersion: 1, id, label: id, revision: 1, adapter: { id: 'example:byte-delivery', version: '1.0.0' }, runtime: { platform: 'embedded-node' },
    capabilities: [{ id: 'signal', semantic: 'example:byte-delivery', schemaVersion: 1,
      kind: sink ? reliable ? 'command' : 'property' : reliable ? 'event' : property ? 'property' : 'sample',
      value: { type: 'array', minItems: 0, maxItems: 128, items: { type: 'scalar', unit: '1', min: 0, max: 200000 } },
      delivery: reliable ? { mode: 'reliable', maxAgeMs: 5000 } : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: sink ? [reliable ? 'invoke' : 'write'] : property ? ['read', 'subscribe'] : ['subscribe'],
      ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] };
}
const tuple = (r: { principalId: string; applicationId: string; sessionId: string }) => JSON.stringify([r.principalId, r.applicationId, r.sessionId]);
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function cost(text: string, reliable = false, extra: PublishOptions = {}) {
  const options = { sequence: 1, timestamp: 100, ...(reliable ? { operationId: '1', deadline: 1100 } : {}), ...extra };
  const observation = { value: textValue(text), sequence: 1, timestamp: 100, receivedAt: 100, clockDomain: 'embedded', quality: 'valid',
    ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
    source: { registrationId: 'registration-1', deviceId: 'source', capabilityId: 'signal' } };
  return new TextEncoder().encode(JSON.stringify({ observation, options })).length;
}
function fixture(reliable: boolean, budgets: Record<string, unknown> = {}, property = false) {
  let at = 100, serial = 0, sequence = 0;
  const approved = new Map<string, string>(), calls: { principal: string; observation: Observation }[] = [];
  const held: { context: DeliveryContext; resolve(): void; reject(): void }[] = [];
  const runtime = createDeviceRuntime({ now: () => at, maxPendingDeliveries: 8, ...budgets,
    authorize: r => approved.get(r.sink.registrationId) === tuple(r) ? { expiresAt: 20000, maxAgeMs: 5000, maxHz: 100 } : undefined,
  } as RuntimeOptions);
  const source = runtime.registerSource({ device: device('source', reliable, false, property), capability: 'signal' });
  runtime.setReadiness(source, 'available');
  function route(principal = 'A', slot = 0, mode: 'held' | 'sync' | 'resolve' | 'reject' | 'throw' = 'held',
    read = false, permitted = true, onApply?: (route: Connection) => void, from: EndpointHandle = source) {
    const sink = runtime.registerSink({ device: device(`sink-${++serial}`, reliable, true), capability: 'signal',
      apply(observation, context) {
        calls.push({ principal, observation }); onApply?.(connection);
        if (mode === 'sync') return;
        if (mode === 'resolve') return Promise.resolve();
        if (mode === 'reject') return Promise.reject(Error('Expected provider rejection'));
        if (mode === 'throw') throw Error('Expected provider throw');
        return new Promise<void>((resolve, reject) => held.push({ context, resolve, reject: () => reject(Error('Expected retired rejection')) }));
      }, release() {} });
    runtime.setReadiness(sink, 'available');
    const request = { from, to: sink, principalId: principal, applicationId: `app-${slot}`, sessionId: `session-${slot}`,
      ...(read ? { sourceOperation: 'read' as const } : {}), queueCapacity: 16 };
    if (permitted) approved.set(sink.id, tuple(request));
    const connection = runtime.route(request); assert.equal(connection.start().ok, permitted); return connection;
  }
  function publish(text = '', extra: PublishOptions = {}, from = source) {
    const n = ++sequence;
    const options = { sequence: n, timestamp: at, ...(reliable ? { operationId: String(n), deadline: at + 1000 } : {}), ...extra };
    assert.equal(runtime.publish(from, textValue(text), options).ok, true); return options;
  }
  async function close() { runtime.close(); for (const pending of held) pending.resolve(); await drain(); }
  return { runtime, source, route, publish, calls, held, close, advance(ms = 20) { at += ms; }, flush() { runtime.flush(); } };
}

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} aggregate byte budgets refuse fanout despite spare count slots and preserve another principal`, async () => {
  const large = 'x'.repeat(700), bytes = cost(large, reliable);
  const f = fixture(reliable, { maxPendingDeliveryBytes: bytes * 2, maxPendingDeliveryBytesPerPrincipal: bytes });
  try { f.route('A', 0); f.route('A', 1); f.route('B', 0); f.publish(large); f.flush();
    assert.deepEqual(f.calls.map(c => c.principal), ['A', 'B']); assert.equal(f.held.length, 2);
  } finally { await f.close(); }
});

for (const reliable of [false, true]) for (const failed of [false, true]) test(`${reliable ? 'reliable' : 'latest'} byte reservation survives Stop until raw ${failed ? 'rejection' : 'fulfillment'}`, async () => {
  const f = fixture(reliable, { maxPendingDeliveryBytes: 1800, maxPendingDeliveryBytesPerPrincipal: 1100 });
  try { const first = f.route(); f.publish('x'.repeat(600)); f.flush(); assert.equal(f.held.length, 1);
    first.stop('replacement'); const replacement = f.route('A', 1); f.route('B', 0, 'sync');
    f.advance(); f.publish('x'.repeat(600)); f.flush(); assert.equal(f.held.length, 1);
    assert.equal(f.held[0]!.context.isCurrent(), false); assert.equal(f.held[0]!.context.signal.aborted, true);
    let settled = false; const barrier = first.whenSettled!(); void barrier.then(() => { settled = true; }); await drain(); assert.equal(settled, false);
    if (failed) f.held[0]!.reject(); else f.held[0]!.resolve(); await barrier;
    f.advance(); f.flush(); assert.equal(f.held.length, 2); assert.equal(replacement.status().state, 'active');
  } finally { await f.close(); }
});

for (const reliable of [false, true]) test(`${reliable ? 'reliable' : 'latest'} global byte refusal retains queued work while smaller other-route delivery progresses`, async () => {
  const f = fixture(reliable, { maxPendingDeliveryBytes: 1500 });
  try { const first = f.route('A'); const blocked = f.route('B'); f.publish('x'.repeat(650)); f.flush(); assert.equal(f.held.length, 1);
    first.stop(); const small = f.runtime.registerSource({ device: device('small', reliable), capability: 'signal' }); f.runtime.setReadiness(small, 'available');
    f.route('C', 0, 'sync', false, true, undefined, small); f.advance(); f.publish('', {}, small); f.flush();
    assert.equal(f.calls.filter(c => c.principal === 'C').length, 1); assert.equal(blocked.status().pending, 1);
    if (reliable) assert.equal(blocked.operations()[0]!.state, 'accepted');
    f.held[0]!.resolve(); await drain(); f.advance(); f.flush(); assert.equal(f.calls.filter(c => c.principal === 'B').length, 1);
    assert.equal((f.calls.find(c => c.principal === 'B')!.observation.value as number[]).length, 65);
  } finally { await f.close(); }
});

test('reliable byte-blocked head cannot jump FIFO for a smaller subsequent operation', async () => {
  const f = fixture(true, { maxPendingDeliveryBytes: 1500 });
  try { const first = f.route('A'); const waiting = f.route('B'); f.publish('x'.repeat(650)); f.flush(); first.stop();
    f.advance(); f.publish(''); f.flush(); assert.equal(f.calls.length, 1); assert.deepEqual(waiting.operations().map(o => o.state), ['accepted', 'accepted']);
    f.held[0]!.resolve(); await drain(); f.advance(); f.flush(); assert.equal((f.calls[1]!.observation.value as number[]).length, 65);
    f.held[1]!.resolve(); await drain(); f.advance(); f.flush(); assert.equal((f.calls[2]!.observation.value as number[]).length, 0);
  } finally { await f.close(); }
});

for (const reliable of [false, true]) for (const mode of ['sync', 'resolve', 'reject', 'throw'] as const) test(`${reliable ? 'reliable' : 'latest'} ${mode} return releases exact byte reservation`, async () => {
  const f = fixture(reliable, { maxPendingDeliveryBytes: cost('', reliable) });
  try { f.route('A', 0, mode); f.route('B', 0, 'sync'); f.publish(); f.flush(); assert.equal(f.calls.length, 1);
    await drain(); f.advance(); f.flush(); assert.deepEqual(f.calls.map(c => c.principal), ['A', 'B']);
  } finally { await f.close(); }
});

test('UTF-8 envelope boundary includes copied options and provenance and rejects one byte below', async () => {
  const value = 'é🙂', extra = { provenance: { origin: 'क' }, quality: 'valid' as const, clockDomain: 'embedded' };
  for (const delta of [0, -1]) {
    const f = fixture(false, { maxPendingDeliveryBytes: cost(value, false, extra) + delta });
    try { const route = f.route(); f.publish(value, extra); f.flush(); assert.equal(f.calls.length, delta === 0 ? 1 : 0); assert.equal(route.status().pending, delta === 0 ? 0 : 1); }
    finally { await f.close(); }
  }
});

test('one-shot property read retains the original publication envelope cost and retires after raw return', async () => {
  const extra = { provenance: { origin: 'x'.repeat(150) }, quality: 'valid' as const };
  const bytes = cost('', false, extra), f = fixture(false, { maxPendingDeliveryBytes: bytes * 2 - 1 }, true);
  try { const options = f.publish('', extra); extra.provenance.origin = ''; options.quality = 'valid';
    const first = f.route('A', 0, 'held', true), second = f.route('B', 0, 'sync', true); f.flush(); assert.equal(f.calls.length, 1);
    assert.equal(first.status().state, 'active'); assert.equal(second.status().pending, 1); f.held[0]!.resolve(); await drain();
    assert.equal(first.status().reason, 'read-complete'); f.advance(); f.flush(); assert.equal(second.status().reason, 'read-complete'); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('stale property read retires and empty or denied routes consume no byte admission', async () => {
  const f = fixture(false, { maxPendingDeliveryBytes: cost('') + 10 }, true);
  try { f.publish(); const stale = f.route('A', 0, 'held', true); f.route('D', 0, 'held', false, false);
    f.advance(1001); f.flush(); assert.equal(stale.status().reason, 'stale'); assert.equal(f.calls.length, 0);
    f.route('B', 0, 'sync'); f.flush(); f.publish(); f.flush(); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('frozen dispatch retirement balances byte reservations without calling a revoked provider', async () => {
  const f = fixture(false, { maxPendingDeliveryBytes: cost('') * 2 }); let second: Connection;
  try { f.route('A', 0, 'sync', false, true, () => f.runtime.revoke(second)); second = f.route('B', 0, 'held');
    f.publish(); f.flush(); assert.deepEqual(f.calls.map(c => c.principal), ['A']); await second.whenSettled!();
    f.route('C', 0, 'sync'); f.advance(); f.publish(); f.flush(); assert.equal(f.calls.filter(c => c.principal === 'C').length, 1);
  } finally { await f.close(); }
});

test('runtime close keeps actual held provider settlement pending', async () => {
  const f = fixture(false, { maxPendingDeliveryBytes: cost('') });
  try { const route = f.route(); f.publish(); f.flush(); f.runtime.close(); let settled = false;
    const barrier = route.whenSettled!(); void barrier.then(() => { settled = true; }); await drain(); assert.equal(settled, false);
    f.held[0]!.resolve(); await barrier; assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('byte quotas intersect with scope and principal counts and aggregate exact case-sensitive identity', async () => {
  const f = fixture(false, { maxPendingDeliveryBytes: cost('') * 4, maxPendingDeliveryBytesPerPrincipal: cost('') * 2,
    maxPendingDeliveriesPerScope: 1, maxPendingDeliveriesPerPrincipal: 2 });
  try { f.route('A', 0); f.route('A', 0); f.route('A', 1); f.route('A', 2); f.route('a', 0); f.publish(); f.flush(); assert.deepEqual(f.calls.map(c => c.principal), ['A', 'A', 'a']); }
  finally { await f.close(); }
});

test('byte budget validation accepts only actual bounded integer numbers and omitted budgets preserve count admission', async () => {
  for (const key of ['maxPendingDeliveryBytes', 'maxPendingDeliveryBytesPerPrincipal']) for (const value of [0, -1, 1.5, NaN, Infinity, null, '1', true, {}, 16777217]) {
    assert.throws(() => createDeviceRuntime({ authorize: () => undefined, [key]: value } as unknown as RuntimeOptions), RangeError);
  }
  assert.throws(() => createDeviceRuntime({ authorize: () => undefined, maxPendingDeliveryBytes: 10, maxPendingDeliveryBytesPerPrincipal: 11 } as RuntimeOptions), RangeError);
  const f = fixture(false);
  try { for (let i = 0; i < 8; i++) f.route('A', i); f.publish('x'.repeat(700)); f.flush(); assert.equal(f.held.length, 8); }
  finally { await f.close(); }
});
