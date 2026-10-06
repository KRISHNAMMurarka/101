import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import { createOutputSharingController } from './output-sharing.ts';
import type { OutputSharingController, OutputSharingPolicy, OutputSharingRoute } from './output-sharing.ts';
import type { Connection, DeliveryContext } from './types.ts';

function descriptor(id: string, sink = false) {
  return { schemaVersion: 1, id, label: id, revision: 1, adapter: { id: 'example:sharing', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
    capabilities: [{ id: 'value', semantic: 'example:sharing-value/1', schemaVersion: 1, kind: sink ? 'property' : 'sample',
      value: { type: 'scalar', unit: '1', min: 0, max: 255 }, delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 250 },
      permissions: [sink ? 'write' : 'subscribe'], ...(sink ? { ownership: { mode: 'observe' } } : {}) }] };
}
function fixture(kind: 'audio' | 'camera' | 'application' = 'audio') {
  let at = 100, routeA: OutputSharingRoute | undefined, routeB: OutputSharingRoute | undefined;
  let policyAllowed = true, sourceAllowed = true, sinkAllowed = true, clockAction: (() => void) | undefined;
  const owner = new AbortController(), policyConsent = new AbortController(), sourceConsent = new AbortController(), sinkConsent = new AbortController();
  const perSlotConsent = new Map<string, AbortController>();
  const effects: number[] = [], contexts: DeliveryContext[] = []; let released = 0, hold: (() => Promise<void>) | undefined;
  const runtime = createDeviceRuntime({ now: () => at, authorize: request => controller.authorizeRoute(request), maxPendingDeliveries: 2 });
  const sourceDevices = [descriptor('example:a'), descriptor('example:b')];
  const sources = sourceDevices.map(device => runtime.registerSource({ device, capability: 'value' }));
  const sinkDevices = [descriptor('example:slot-a', true), descriptor('example:slot-b', true)];
  const sinks = sinkDevices.map((device, index) => runtime.registerSink({ device, capability: 'value', apply(observation, context) {
    const selected = index === 0 ? routeA : routeB; assert.ok(selected);
    return controller.effect(selected, context, () => { effects.push(observation.value as number); contexts.push(context); return hold?.(); });
  }, release() { released++; } }));
  [...sources, ...sinks].forEach(handle => runtime.setReadiness(handle, 'available'));
  const controller: OutputSharingController = createOutputSharingController({ runtime, ownerSignal: owner.signal, applicationId: 'app', sessionId: 'session', now() {
    const run = clockAction; clockAction = undefined; run?.(); return at;
  }, sources: sourceDevices.map((device, index) => ({ id: index === 0 ? 'a' : 'b', ownerId: 'source-owner', handle: sources[index]!, device, capability: 'value' })),
    destinations: [{ id: 'output', ownerId: 'output-owner', kind, slots: sinkDevices.map((device, index) => ({ id: index === 0 ? 'a' : 'b', handle: sinks[index]!, device, capability: 'value' })) }],
    authorizePolicy: request => policyAllowed ? { request, expiresAt: at + 1000, signal: policyConsent.signal } : undefined,
    authorizeSource: request => sourceAllowed ? { request, expiresAt: at + 1000, maxHz: 30, maxAgeMs: 250, signal: (perSlotConsent.get(request.slotId) ?? sourceConsent).signal } : undefined,
    authorizeSink: request => sinkAllowed ? { request, expiresAt: at + 1000, maxHz: 30, maxAgeMs: 250, signal: sinkConsent.signal } : undefined });
  const mix: OutputSharingPolicy = { kind: 'audio', mode: 'mix', inputs: [{ slotId: 'a', sourceId: 'a', principalId: 'listener' }, { slotId: 'b', sourceId: 'b', principalId: 'listener' }] };
  return { runtime, controller, owner, policyConsent, sourceConsent, sinkConsent, sources, sinks, mix, effects, contexts,
    setPolicyAllowed(value: boolean) { policyAllowed = value; }, setSourceAllowed(value: boolean) { sourceAllowed = value; }, setSinkAllowed(value: boolean) { sinkAllowed = value; },
    clock(run: () => void) { clockAction = run; }, advance(ms: number) { at += ms; }, released: () => released, held(run: () => Promise<void>) { hold = run; },
    slotConsent(slot: string, grant: AbortController) { perSlotConsent.set(slot, grant); },
    bind(slotId: 'a' | 'b') { const result = controller.route({ destinationId: 'output', slotId }); assert.equal(result.ok, true, JSON.stringify(result));
      if (slotId === 'a') routeA = result.value; else routeB = result.value; assert.equal(result.value.connection.start().ok, true); return result.value; },
    async close() { await controller.close(); runtime.close(); } };
}
async function settled(f: ReturnType<typeof fixture>) {
  // Observe actual provider Promise settlement before expecting a new native admission.
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
  assert.equal(f.controller.snapshot().rawPending, 0);
}

test('all audio policies are explicit and denied/stale transfers retain the actual incumbent', async () => {
  const f = fixture(); assert.equal(f.controller.select('output', 0, f.mix).ok, true); const a = f.bind('a'), b = f.bind('b');
  f.runtime.publish(f.sources[0]!, 10); f.runtime.publish(f.sources[1]!, 20); f.runtime.flush(); await settled(f);
  assert.deepEqual(f.effects, [10, 20]); f.setPolicyAllowed(false);
  const exclusive: OutputSharingPolicy = { kind: 'audio', mode: 'exclusive', inputs: [{ slotId: 'b', sourceId: 'b', principalId: 'listener' }] };
  assert.deepEqual(f.controller.select('output', 1, exclusive), { ok: false, reason: 'denied' });
  assert.equal(a.connection.status().state, 'active'); assert.equal(b.connection.status().state, 'active');
  f.setPolicyAllowed(true); assert.deepEqual(f.controller.select('output', 0, exclusive), { ok: false, reason: 'stale' });
  assert.equal(f.controller.select('output', 1, exclusive).ok, true); assert.equal(a.connection.status().state, 'closed'); assert.equal(b.connection.status().state, 'closed');
  const fresh = f.bind('b'); f.advance(40); f.runtime.publish(f.sources[1]!, 30); f.runtime.flush(); await settled(f);
  assert.equal(f.effects.at(-1), 30); assert.equal(fresh.connection.status().state, 'active');
  assert.equal(f.controller.select('output', 2, { ...f.mix, mode: 'duck', foreground: 'a' }).ok, true); await f.close();
});

test('duplicate live and provisional tuples fail before runtime dispatch, with fresh admission after release', async () => {
  const f = fixture(); f.controller.select('output', 0, f.mix); const first = f.bind('a');
  assert.deepEqual(f.controller.route({ destinationId: 'output', slotId: 'a' }), { ok: false, reason: 'busy' });
  first.connection.stop(); const fresh = f.bind('a'); f.sourceConsent.abort(); assert.equal(fresh.connection.status().state, 'closed'); assert.ok(f.released() > 0); await f.close();
});

test('source, sink and current destination policy consent each fail closed before dispatch', async () => {
  for (const side of ['source', 'sink', 'policy'] as const) { const f = fixture(); f.controller.select('output', 0, f.mix);
    if (side === 'source') f.setSourceAllowed(false); if (side === 'sink') f.setSinkAllowed(false); if (side === 'policy') f.policyConsent.abort();
    const result = f.controller.route({ destinationId: 'output', slotId: 'a' });
    if (result.ok) assert.equal(result.value.connection.start().ok, false); else assert.equal(result.ok, false);
    f.runtime.publish(f.sources[0]!, 80); f.runtime.flush(); assert.deepEqual(f.effects, []); await f.close(); }
});

test('final caller clock revocation blocks the actual effect even with a shadowed aborted property', async () => {
  const f = fixture(); f.controller.select('output', 0, f.mix); f.bind('a');
  Object.defineProperty(f.sourceConsent.signal, 'aborted', { value: false }); f.clock(() => f.sourceConsent.abort());
  f.runtime.publish(f.sources[0]!, 99); f.runtime.flush(); await Promise.resolve(); assert.deepEqual(f.effects, []); await f.close();
});

test('logical stop retains raw issued effect reservations through actual Promise settlement', async () => {
  const f = fixture(); let resolve!: () => void; f.held(() => new Promise<void>(done => { resolve = done; }));
  f.controller.select('output', 0, f.mix); const route = f.bind('a'); f.runtime.publish(f.sources[0]!, 3); f.runtime.flush();
  assert.equal(f.controller.snapshot().rawPending, 1); let finished = false; const closed = f.controller.close().then(() => { finished = true; });
  assert.equal(route.connection.status().state, 'closed'); await Promise.resolve(); assert.equal(finished, false); assert.equal(f.controller.snapshot().rawPending, 1);
  resolve(); await closed; assert.equal(f.controller.snapshot().rawPending, 0); f.runtime.close();
});

test('malformed, overlapping slot and foreign source plans cannot evict an incumbent', async () => {
  const f = fixture(); f.controller.select('output', 0, f.mix); const a = f.bind('a');
  const policies: OutputSharingPolicy[] = [{ ...f.mix, inputs: [f.mix.inputs[0]!, f.mix.inputs[0]!] }, { ...f.mix, inputs: [{ slotId: 'a', sourceId: 'foreign', principalId: 'reader' }] }];
  for (const policy of policies)
    assert.equal(f.controller.select('output', 1, policy).ok, false);
  assert.equal(a.connection.status().state, 'active'); await f.close();
});

test('a provisional reentrant duplicate is refused before the real route handle is available', async () => {
  const f = fixture(); f.controller.select('output', 0, f.mix); const actual = f.runtime.route.bind(f.runtime); let nested: unknown, calls = 0;
  f.runtime.route = request => { calls++; nested = f.controller.route({ destinationId: 'output', slotId: 'a' }); return actual(request); };
  const connection = f.bind('a'); assert.deepEqual(nested, { ok: false, reason: 'busy' }); assert.equal(calls, 1);
  f.runtime.publish(f.sources[0]!, 44); f.runtime.flush(); await Promise.resolve(); assert.deepEqual(f.effects, [44]);
  f.sourceConsent.abort(); assert.equal(connection.connection.status().state, 'closed'); await f.close();
});

test('camera observers have independent exact owner approvals and one retirement keeps the other current', async () => {
  const f = fixture('camera'), consentA = new AbortController(), consentB = new AbortController(); f.slotConsent('a', consentA); f.slotConsent('b', consentB);
  const policy: OutputSharingPolicy = { kind: 'camera', mode: 'observers', inputs: f.mix.inputs };
  assert.equal(f.controller.select('output', 0, policy).ok, true); const a = f.bind('a'), b = f.bind('b');
  f.runtime.publish(f.sources[0]!, 10); f.runtime.publish(f.sources[1]!, 20); f.runtime.flush(); await settled(f); consentA.abort();
  assert.equal(a.connection.status().state, 'closed'); assert.equal(b.connection.status().state, 'active'); f.advance(40);
  f.runtime.publish(f.sources[1]!, 21); f.runtime.flush(); await settled(f); assert.equal(f.effects.at(-1), 21); await f.close();
});

test('application layers and fixed regions require fresh policy and resource grants after transfer', async () => {
  const f = fixture('application'); assert.equal(f.controller.select('output', 0, { kind: 'application', mode: 'layers', inputs: f.mix.inputs }).ok, true);
  const old = f.bind('a'); f.runtime.publish(f.sources[0]!, 60); f.runtime.flush(); await Promise.resolve();
  assert.equal(f.controller.select('output', 1, { kind: 'application', mode: 'regions', inputs: f.mix.inputs }).ok, true);
  assert.equal(old.connection.status().state, 'closed'); f.setSinkAllowed(false); const failed = f.controller.route({ destinationId: 'output', slotId: 'a' });
  assert.equal(failed.ok, true); if (failed.ok) assert.equal(failed.value.connection.start().ok, false); f.advance(40); f.runtime.publish(f.sources[0]!, 80); f.runtime.flush();
  assert.deepEqual(f.effects, [60]); await f.close();
});

test('a real runtime route returned after reentrant close is adopted and retired', async () => {
  const f = fixture(); const selection = f.controller.select('output', 0, f.mix); assert.equal(selection.ok, true, JSON.stringify(selection));
  const actual = f.runtime.route.bind(f.runtime); let returned: Connection | undefined, issued = 0;
  f.runtime.route = request => { issued++; void f.controller.close(); returned = actual(request); return returned; };
  try {
    const result = f.controller.route({ destinationId: 'output', slotId: 'a' });
    assert.equal(result.ok, false); assert.equal(issued, 1, JSON.stringify(result)); assert.ok(returned);
    // The native/public handle did not exist when the provisional entry was retired.
    // A refused managed route still owns this late real SDK handle's cleanup.
    assert.equal(returned.status().state, 'closed'); assert.equal(f.controller.snapshot().routes, 0);
    assert.deepEqual(f.effects, []);
  } finally { await f.close(); }
});
