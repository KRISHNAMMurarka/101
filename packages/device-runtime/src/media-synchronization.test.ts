import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime } from './index.ts';
import { createMediaSynchronizationController, MEDIA_SYNCHRONIZATION_LIMITS } from './media-synchronization.ts';
import type { MediaSynchronizationPair } from './media-synchronization.ts';
import type { Connection, DeliveryContext, Observation } from './types.ts';

// Controlled clock arithmetic is logic evidence. Real native PCM/raster and
// MessagePort exchanges are qualified separately by the public browser caller.
function fixture() {
  let at = 1000, nextClock: (() => void) | undefined;
  const owner = new AbortController(), effects: number[] = [], pairs: MediaSynchronizationPair[] = [];
  let effect: (context: { isCurrent(): boolean }) => void | Promise<void> = () => {};
  const device = (id: string, sink = false) => ({ schemaVersion: 1, id, label: 'Software event', revision: 1,
    adapter: { id: 'example:media-events', version: '1.0.0' }, runtime: { platform: 'software' }, capabilities: [
      { id: 'event', semantic: 'example:software-media-event', schemaVersion: 1, kind: sink ? 'property' : 'sample',
        value: { type: 'scalar', unit: '1', min: 0, max: 255 }, delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 100 },
        permissions: [sink ? 'write' : 'subscribe'], ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] });
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'display', maxRoutes: 2, maxRegistrations: 4,
    maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 2,
    authorize: request => !owner.signal.aborted && request.principalId === 'owner' && request.applicationId === 'sync' && request.sessionId === 'run' ?
      { expiresAt: 2000, maxAgeMs: 100, maxHz: 30 } : undefined });
  const sources = { audio: runtime.registerSource({ device: device('audio'), capability: 'event' }), video: runtime.registerSource({ device: device('video'), capability: 'event' }) };
  const apply = (role: 'audio' | 'video') => (observation: Observation, context: DeliveryContext) => controller.offer(role, observation, context);
  const sinks = { audio: runtime.registerSink({ device: device('audio-sink', true), capability: 'event', apply: apply('audio'), release() {} }),
    video: runtime.registerSink({ device: device('video-sink', true), capability: 'event', apply: apply('video'), release() {} }) };
  for (const handle of [...Object.values(sources), ...Object.values(sinks)]) runtime.setReadiness(handle, 'available');
  const routes: Record<'audio' | 'video', Connection> = {
    audio: runtime.route({ from: sources.audio, to: sinks.audio, principalId: 'owner', applicationId: 'sync', sessionId: 'run', leaseMs: 500, queueCapacity: 1 }),
    video: runtime.route({ from: sources.video, to: sinks.video, principalId: 'owner', applicationId: 'sync', sessionId: 'run', leaseMs: 500, queueCapacity: 1 }),
  };
  const controller = createMediaSynchronizationController({ ownerSignal: owner.signal, displayClockId: 'display', now() { nextClock?.(); return at; },
    audio: { clockId: 'audio-events', routeId: routes.audio.id, source: { registrationId: sources.audio.id, deviceId: 'audio', capabilityId: 'event', descriptorRevision: 1, schemaVersion: 1 } },
    video: { clockId: 'video-events', routeId: routes.video.id, source: { registrationId: sources.video.id, deviceId: 'video', capabilityId: 'event', descriptorRevision: 1, schemaVersion: 1 } },
    onPair(pair, context) { if (context.isCurrent()) { effects.push(pair.audioSequence); pairs.push(pair); } return effect(context); } });
  for (const route of Object.values(routes)) assert.equal(route.start().ok, true);
  const maps = () => { for (const [role, offset] of [['audio', 1000], ['video', 2000]] as const)
    assert.equal(controller.observeClock(role, controller.snapshot().epoch, { localSentAt: at, remoteReceivedAt: at + offset, remoteSentAt: at + offset, localReceivedAt: at }), true); };
  maps(); let sequence = 0;
  async function sample(options: { skew?: number; unknown?: boolean; onlyAudio?: boolean } = {}) {
    at += 40; sequence++;
    for (const [role, offset] of [['audio', 1000], ['video', 2000]] as const) {
      if (options.onlyAudio && role === 'video') continue;
      assert.equal(runtime.publish(sources[role], role === 'audio' ? 1 : 230, { sequence, timestamp: at, clockDomain: 'display',
        provenance: options.unknown ? { captureTimeKnown: false, clockMappingEstablished: false } : { sync: { profile: 'software-media-observation-sync/1',
          epoch: controller.snapshot().epoch, basis: 'software-observation', clockId: role + '-events', at: at + offset - (role === 'audio' ? options.skew ?? 0 : 0) } } }).ok, true);
    }
    runtime.flush(); await Promise.resolve(); await Promise.resolve(); runtime.flush();
  }
  return { owner, controller, runtime, routes, effects, pairs, maps, sample, setEffect(value: typeof effect) { effect = value; },
    onClock(value: () => void) { nextClock = value; }, advance(ms: number) { at += ms; }, async close() { runtime.close(); await controller.close(); } };
}

test('three fresh pairs retain real apply contexts and permit a software effect', async () => {
  const h = fixture(); await h.sample(); await h.sample(); assert.deepEqual(h.effects, []);
  await h.sample(); assert.deepEqual(h.effects, [3]); assert.equal(h.controller.snapshot().state, 'aligned-software-observations');
  await h.close(); assert.equal(h.controller.snapshot().pendingContexts, 0);
});

test('two accepted recovery pairs expire during a scheduling gap and cannot supply a later effect', async () => {
  const h = fixture();
  try {
    await h.sample(); await h.sample();
    const epoch = h.controller.snapshot().epoch;
    assert.equal(h.controller.snapshot().recoveryPairs, 2);
    h.advance(101); h.controller.tick();
    assert.equal(h.controller.snapshot().reason, 'age-budget');
    assert.equal(h.controller.snapshot().recoveryPairs, 0);
    assert.ok(h.controller.snapshot().epoch > epoch);
    assert.equal(h.controller.snapshot().pendingContexts, 0);
    assert.deepEqual(h.effects, []);
    // The original maps retire with the old recovery history. New software
    // mappings and all three fresh pairs are required, within the same lease.
    h.maps(); await h.sample(); await h.sample();
    assert.deepEqual(h.effects, []);
    await h.sample(); assert.equal(h.effects.length, 1);
  } finally { await h.close(); }
});

test('unknown native clock provenance stays unsynchronized and does not become a mapping', async () => {
  const h = fixture(); await h.sample({ unknown: true }); assert.deepEqual(h.effects, []);
  assert.equal(h.controller.snapshot().reason, 'native-clock-unmapped'); await h.close();
});

test('excess skew discards epoch and requires fresh maps and three fresh pairs', async () => {
  const h = fixture(); const epoch = h.controller.snapshot().epoch; await h.sample({ skew: 30 });
  assert.equal(h.controller.snapshot().reason, 'skew-budget'); assert.ok(h.controller.snapshot().epoch > epoch);
  h.maps(); await h.sample(); await h.sample(); assert.deepEqual(h.effects, []); await h.sample(); assert.equal(h.effects.length, 1); await h.close();
});

test('excessive affine clock drift rejects even monotonic exchanges with bounded uncertainty', async () => {
  for (const driftPpm of [-10000, 10000]) {
    const h = fixture();
    try {
      h.controller.reset(); h.advance(2); const epoch = h.controller.snapshot().epoch;
      // A 2ms round trip gives a 1ms uncertainty interval. Both clocks run
      // monotonically; their 400ms separation is inside the map age budget.
      for (const [role, offset] of [['audio', 1000], ['video', 2000]] as const)
        assert.equal(h.controller.observeClock(role, epoch, { localSentAt: 1000, remoteReceivedAt: 1001 + offset, remoteSentAt: 1001 + offset, localReceivedAt: 1002 }), true);
      h.advance(400);
      const remote = 1401 + 1000 + 400 * driftPpm / 1000000;
      assert.ok(remote > 2001);
      assert.ok(Math.abs(driftPpm) > MEDIA_SYNCHRONIZATION_LIMITS.driftPpm);
      assert.equal(h.controller.observeClock('audio', epoch, { localSentAt: 1400, remoteReceivedAt: remote, remoteSentAt: remote, localReceivedAt: 1402 }), false);
      assert.equal(h.controller.snapshot().reason, 'map-unavailable');
      assert.equal(h.controller.snapshot().state, 'degraded');
      assert.ok(h.controller.snapshot().epoch > epoch);
      assert.equal(h.controller.snapshot().pendingContexts, 0);
      assert.deepEqual(h.effects, []);
      assert.equal(h.controller.observeClock('video', epoch, { localSentAt: 1400, remoteReceivedAt: 3401, remoteSentAt: 3401, localReceivedAt: 1402 }), false);
      for (const route of Object.values(h.routes)) assert.equal(route.renew('owner').ok, true);
      h.maps(); await h.sample(); await h.sample(); assert.deepEqual(h.effects, []);
      await h.sample(); assert.equal(h.effects.length, 1);
      assert.equal(h.controller.snapshot().state, 'aligned-software-observations');
    } finally { await h.close(); }
  }
});

test('clock uncertainty above the declared budget refuses a pair and requires fresh recovery', async () => {
  const h = fixture();
  try {
    h.controller.reset(); h.advance(12); const epoch = h.controller.snapshot().epoch;
    for (const [role, offset] of [['audio', 1000], ['video', 2000]] as const)
      assert.equal(h.controller.observeClock(role, epoch, { localSentAt: 1000, remoteReceivedAt: 1006 + offset, remoteSentAt: 1006 + offset, localReceivedAt: 1012 }), true);
    assert.ok(12 / 2 > MEDIA_SYNCHRONIZATION_LIMITS.uncertaintyMs);
    await h.sample({ onlyAudio: true }); assert.equal(h.controller.snapshot().reason, 'map-unavailable');
    assert.equal(h.controller.snapshot().state, 'degraded');
    assert.equal(h.controller.snapshot().pendingContexts, 0); assert.deepEqual(h.effects, []);
    h.maps(); await h.sample(); await h.sample(); assert.deepEqual(h.effects, []);
    await h.sample(); assert.equal(h.effects.length, 1);
  } finally { await h.close(); }
});

test('accepted nonzero uncertainty remains conservative in paired software timing evidence', async () => {
  const h = fixture();
  try {
    h.controller.reset(); h.advance(8); const epoch = h.controller.snapshot().epoch;
    for (const [role, offset] of [['audio', 1000], ['video', 2000]] as const)
      assert.equal(h.controller.observeClock(role, epoch, { localSentAt: 1000, remoteReceivedAt: 1004 + offset, remoteSentAt: 1004 + offset, localReceivedAt: 1008 }), true);
    await h.sample(); await h.sample(); await h.sample(); assert.equal(h.pairs.length, 1);
    const pair = h.pairs[0]!;
    for (const lane of [pair.audio, pair.video]) {
      assert.ok(lane.mapping!.uncertaintyMs > 4);
      assert.ok(lane.mapping!.uncertaintyMs <= MEDIA_SYNCHRONIZATION_LIMITS.uncertaintyMs);
      assert.equal(lane.mapping!.maxDriftPpm, MEDIA_SYNCHRONIZATION_LIMITS.driftPpm);
      assert.ok(lane.mapping!.earliest < lane.mapping!.latest);
    }
    assert.ok(pair.skew.earliestMs < 0 && pair.skew.latestMs > 0);
    assert.ok(Math.max(Math.abs(pair.skew.earliestMs), Math.abs(pair.skew.latestMs)) <= MEDIA_SYNCHRONIZATION_LIMITS.skewMs);
    assert.equal(pair.nativeCaptureMapping, 'unknown'); assert.equal(pair.displayScanoutMapping, 'unknown');
  } finally { await h.close(); }
});

test('final clock owner revocation blocks a paired effect', async () => {
  const h = fixture(); await h.sample(); await h.sample();
  h.onClock(() => { if (h.controller.snapshot().pendingEffects === 1) h.owner.abort(); }); await h.sample();
  assert.deepEqual(h.effects, []); assert.equal(h.controller.snapshot().state, 'closed'); await h.close();
});

test('logical close holds both real provider contexts through issued effect settlement', async () => {
  const h = fixture(); let release!: () => void, settled = false;
  h.setEffect(() => new Promise<void>(resolve => { release = resolve; }));
  await h.sample(); await h.sample(); await h.sample(); assert.equal(h.controller.snapshot().pendingContexts, 2);
  const closed = h.controller.close().then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  release(); await closed; assert.equal(h.controller.snapshot().pendingContexts, 0); await h.close();
});

test('an issued final effect observes Stop before release and cannot become an accepted effect', async () => {
  const h = fixture(); let release!: () => void, closedSettled = false, finalEffects = 0;
  try {
    h.setEffect(context => new Promise<void>(resolve => { release = () => { if (context.isCurrent()) finalEffects++; resolve(); }; }));
    await h.sample(); await h.sample(); await h.sample();
    assert.equal(h.controller.snapshot().pendingEffects, 1); assert.equal(h.controller.snapshot().pendingContexts, 2);
    const closed = h.controller.close().then(() => { closedSettled = true; }); await Promise.resolve();
    assert.equal(closedSettled, false); assert.equal(h.controller.snapshot().state, 'closed');
    release(); await closed;
    assert.equal(finalEffects, 0); assert.equal(h.controller.snapshot().effects, 0);
    assert.equal(h.controller.snapshot().pendingEffects, 0); assert.equal(h.controller.snapshot().pendingContexts, 0);
  } finally { release?.(); await h.close(); }
});

test('a missing second lane expires and discards its unresolved apply', async () => {
  const h = fixture(); await h.sample({ onlyAudio: true }); assert.equal(h.controller.snapshot().pendingContexts, 1);
  h.advance(101); h.controller.tick(); await Promise.resolve(); assert.equal(h.controller.snapshot().pendingContexts, 0);
  assert.deepEqual(h.effects, []); await h.close();
});
