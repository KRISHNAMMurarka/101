import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, createRuntimeInspector } from '@101/connect';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, Observation, RuntimeOptions } from '@101/connect';

function descriptor(id: string, reliable: boolean, sink = false) {
  return { schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'example:route-settlement', version: '1.0.0' }, runtime: { platform: 'embedded-node' },
    capabilities: [{ id: 'value', semantic: 'example:route-settlement', schemaVersion: 1,
      kind: sink ? reliable ? 'command' : 'property' : reliable ? 'event' : 'sample',
      value: { type: 'boolean' }, delivery: reliable ? { mode: 'reliable', maxAgeMs: 5000 }
        : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: sink ? [reliable ? 'invoke' : 'write'] : ['subscribe'] }] };
}
type BarrierConnection = Connection & { whenSettled?: () => Promise<void> };
function barrier(route: Connection): Promise<void> {
  const method = (route as BarrierConnection).whenSettled;
  assert.equal(typeof method, 'function', 'the genuine public route exposes its actual reservation barrier');
  return method!.call(route);
}
async function drain() { for (let count = 0; count < 6; count++) await Promise.resolve(); }
function fixture(reliable = true, useInspector = false) {
  let now = 100, sequence = 0, sourceId = '', sinkId = '', releases = 0;
  const options: RuntimeOptions = { now: () => now, maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 1,
    authorize(request: Readonly<AuthorizationRequest>) {
      if (request.principalId !== 'owner' || request.applicationId !== 'settlement' || request.sessionId !== 'room' ||
          request.source.registrationId !== sourceId || request.sink.registrationId !== sinkId ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== (reliable ? 'invoke' : 'write')) return;
      return { expiresAt: 10000, maxAgeMs: reliable ? 5000 : 1000, maxHz: 100 };
    } };
  const inspector = useInspector ? createRuntimeInspector(options) : undefined;
  const runtime: DeviceRuntime = inspector?.runtime ?? createDeviceRuntime(options);
  let apply: (observation: Observation, context: DeliveryContext) => void | Promise<void> = () => {};
  let release = () => {};
  const held: { context: DeliveryContext; resolve(): void; reject(): void }[] = [];
  const source = runtime.registerSource({ device: descriptor('source', reliable), capability: 'value' }); sourceId = source.id;
  const sink = runtime.registerSink({ device: descriptor('sink', reliable, true), capability: 'value',
    apply(observation, context) { return apply(observation, context); }, release() { releases++; release(); } }); sinkId = sink.id;
  assert.equal(runtime.setReadiness(source, 'available').ok, true); assert.equal(runtime.setReadiness(sink, 'available').ok, true);
  const route = runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'settlement', sessionId: 'room', leaseMs: 1500, queueCapacity: 2 });
  function hold(_observation: Observation, context: DeliveryContext) {
    return new Promise<void>((resolve, reject) => held.push({ context, resolve, reject: () => reject(Error('software provider failure')) }));
  }
  function publish() { now += 20; return runtime.publish(source, true, reliable ? { operationId: String(++sequence), deadline: now + 1000 } : {}); }
  async function cleanup() { runtime.close(); for (const entry of held) entry.resolve(); await drain(); inspector?.close(); }
  return { runtime, inspector, route, source, sink, held, hold, publish, cleanup, releases: () => releases,
    apply(value: typeof apply) { apply = value; }, release(value: typeof release) { release = value; }, time(value: number) { now = value; } };
}

test('public settlement waits after actual approved held invocation and logical stop', async () => {
  const f = fixture(); f.apply(f.hold);
  try {
    assert.equal(f.route.start().ok, true); assert.equal(f.publish().ok, true); f.runtime.flush();
    assert.equal(f.held.length, 1); assert.equal(f.held[0]!.context.isCurrent(), true);
    assert.equal(f.route.operations()[0]!.handlerResult, 'running');
    f.route.stop('owner-stop');
    assert.deepEqual(f.route.status(), { state: 'closed', reason: 'owner-stop', pending: 0 });
    assert.equal(f.held[0]!.context.signal.aborted, true); assert.equal(f.releases(), 1);
    let settled = false; const done = barrier(f.route); assert.equal(barrier(f.route), done);
    void done.then(() => { settled = true; }); await drain(); assert.equal(settled, false);
    f.held[0]!.resolve(); await done;
    assert.equal(f.route.operations()[0]!.handlerResult, 'returned'); assert.equal(f.route.operations()[0]!.state, 'cancelled');
    assert.equal(f.route.operations()[0]!.effectEvidence, 'none'); assert.equal(f.releases(), 1);
  } finally { await f.cleanup(); }
});

test('terminal cause never substitutes for fulfilled or rejected actual apply work', async () => {
  for (const reliable of [false, true]) for (const reason of ['revoked', 'expired', 'unregistered', 'runtime-closed']) {
    const f = fixture(reliable); f.apply(f.hold);
    try {
      assert.equal(f.route.start().ok, true); assert.equal(f.publish().ok, true); f.runtime.flush(); assert.equal(f.held.length, 1);
      if (reason === 'revoked') f.runtime.revoke(f.route);
      else if (reason === 'expired') { f.time(1600); f.runtime.flush(); }
      else if (reason === 'unregistered') assert.equal(f.runtime.unregister(f.source).ok, true);
      else f.runtime.close();
      assert.equal(f.route.status().reason, reason); assert.equal(f.held[0]!.context.isCurrent(), false);
      let settled = false; const done = barrier(f.route); void done.then(() => { settled = true; });
      await drain(); assert.equal(settled, false); f.held[0]!.reject(); await done;
      if (reliable) assert.equal(f.route.operations()[0]!.handlerResult, 'failed');
    } finally { await f.cleanup(); }
  }
});

test('reentrant provider retirement is reserved before a held Promise is returned', async () => {
  for (const close of [false, true]) {
    const f = fixture(); let done: Promise<void> | undefined, settled = false;
    f.apply((observation, context) => {
      if (close) f.runtime.close(); else f.route.stop('during-apply');
      done = barrier(f.route); void done.then(() => { settled = true; });
      return f.hold(observation, context);
    });
    try {
      assert.equal(f.route.start().ok, true); assert.equal(f.publish().ok, true); f.runtime.flush();
      assert.equal(f.held.length, 1); await drain(); assert.equal(settled, false);
      f.held[0]!.resolve(); await done; assert.equal(f.route.operations()[0]!.state, 'cancelled');
    } finally { await f.cleanup(); }
  }
});

test('barrier includes reserved frozen dispatch retired by an earlier real provider', async () => {
  let now = 100, done: Promise<void> | undefined, issued = 0;
  const registrations = new Map<string, string>();
  const runtime = createDeviceRuntime({ now: () => now, maxPendingDeliveries: 2, authorize(request) {
    if (request.principalId === 'owner' && request.applicationId === 'settlement' &&
        registrations.get(request.sink.registrationId) === request.sessionId)
      return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 100 };
  } });
  const source = runtime.registerSource({ device: descriptor('source', false), capability: 'value' });
  const firstSink = runtime.registerSink({ device: descriptor('first', false, true), capability: 'value', apply() {
    second!.stop('earlier-provider'); done = barrier(second!);
  }, release() {} });
  const secondSink = runtime.registerSink({ device: descriptor('second', false, true), capability: 'value', apply() { issued++; }, release() {} });
  registrations.set(firstSink.id, 'first'); registrations.set(secondSink.id, 'second');
  for (const handle of [source, firstSink, secondSink]) assert.equal(runtime.setReadiness(handle, 'available').ok, true);
  const first = runtime.route({ from: source, to: firstSink, principalId: 'owner', applicationId: 'settlement', sessionId: 'first' });
  const second = runtime.route({ from: source, to: secondSink, principalId: 'owner', applicationId: 'settlement', sessionId: 'second' });
  try {
    assert.equal(first.start().ok, true); assert.equal(second.start().ok, true); now = 120;
    assert.equal(runtime.publish(source, true).ok, true); runtime.flush(); await done;
    assert.equal(issued, 0); assert.equal(second.status().state, 'closed');
    assert.equal(barrier(second), done);
  } finally { runtime.close(); }
});

test('active synchronous return and throw retain existing results and history, not automatic retirement', async () => {
  for (const throwing of [false, true]) {
    const f = fixture(); f.apply(() => { if (throwing) throw Error('software callback failure'); });
    try {
      const done = barrier(f.route); let settled = false; void done.then(() => { settled = true; });
      assert.equal(f.route.start().ok, true); assert.equal(f.publish().ok, true); f.runtime.flush(); await drain();
      assert.equal(f.route.operations()[0]!.handlerResult, throwing ? 'failed' : 'returned');
      if (!throwing) { assert.equal(settled, false); assert.equal(f.route.status().state, 'active'); f.route.stop(); }
      await done; assert.equal(f.route.status().state, 'closed');
      assert.equal(f.route.operations()[0]!.effectEvidence, 'none');
    } finally { await f.cleanup(); }
  }
});

test('idle and prepared retirement waits until synchronous onClose and release callouts finish', async () => {
  for (const phase of ['idle', 'prepared', 'active']) {
    const f = fixture(); const order: string[] = [];
    try {
      if (phase === 'prepared') assert.equal(f.route.prepare().ok, true);
      if (phase === 'active') assert.equal(f.route.start().ok, true);
      f.route.onClose(() => { order.push('onClose'); void barrier(f.route).then(() => order.push('settled')); });
      f.release(() => { order.push('release'); f.route.stop('reentry'); assert.equal(barrier(f.route), barrier(f.route)); });
      f.route.stop(); order.push('returned'); await barrier(f.route); await drain();
      assert.deepEqual(order, phase === 'active' ? ['onClose', 'release', 'returned', 'settled'] : ['onClose', 'returned', 'settled']);
      assert.equal(f.releases(), phase === 'active' ? 1 : 0);
    } finally { await f.cleanup(); }
  }
});

test('public inspector forwards the same underlying actual reservation barrier', async () => {
  const f = fixture(true, true); f.apply(f.hold);
  try {
    assert.equal(f.route.start().ok, true); assert.equal(f.publish().ok, true); f.runtime.flush();
    f.inspector!.close(); let settled = false; const done = barrier(f.route);
    void done.then(() => { settled = true; }); await drain(); assert.equal(settled, false);
    f.held[0]!.resolve(); await done; assert.equal(f.route.operations()[0]!.handlerResult, 'returned');
  } finally { await f.cleanup(); }
});

test('one-shot property read settles only after actual return and automatic read retirement', async () => {
  let now = 100, releases = 0, resolve!: () => void;
  const held = new Promise<void>(done => { resolve = done; });
  const sourceDevice = descriptor('read-source', false);
  sourceDevice.capabilities[0]!.kind = 'property'; sourceDevice.capabilities[0]!.permissions = ['read'];
  let sourceId = '', sinkId = '';
  const runtime = createDeviceRuntime({ now: () => now, authorize(request) {
    if (request.source.registrationId === sourceId && request.sink.registrationId === sinkId &&
        request.principalId === 'owner' && request.applicationId === 'settlement' && request.sessionId === 'room' &&
        request.sourceOperation === 'read' && request.sinkOperation === 'write')
      return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 100 };
  } });
  const source = runtime.registerSource({ device: sourceDevice, capability: 'value' }); sourceId = source.id;
  const sink = runtime.registerSink({ device: descriptor('read-sink', false, true), capability: 'value',
    apply() { return held; }, release() { releases++; } }); sinkId = sink.id;
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'settlement', sessionId: 'room', sourceOperation: 'read' });
  try {
    assert.equal(runtime.publish(source, true).ok, true); assert.equal(route.start().ok, true); now = 120; runtime.flush();
    let settled = false; const done = barrier(route); void done.then(() => { settled = true; }); await drain();
    assert.equal(settled, false); assert.equal(route.status().state, 'active'); resolve(); await done;
    assert.equal(route.status().reason, 'read-complete'); assert.equal(releases, 1);
  } finally { resolve(); await held; runtime.close(); await drain(); }
});
