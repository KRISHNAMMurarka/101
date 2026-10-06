import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime } from './index.ts';
import { createMediaSynchronizationController } from './media-synchronization.ts';
import type { Connection, DeliveryContext, Observation } from './types.ts';

// Controlled clock arithmetic is logic evidence. Real native PCM/raster and
// MessagePort exchanges are qualified separately by the public browser caller.
function fixture() {
  let at = 1000, nextClock: (() => void) | undefined;
  const owner = new AbortController(), effects: number[] = [];
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
    onPair(pair, context) { if (context.isCurrent()) effects.push(pair.audioSequence); return effect(context); } });
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
  return { owner, controller, runtime, routes, effects, maps, sample, setEffect(value: typeof effect) { effect = value; },
    onClock(value: () => void) { nextClock = value; }, advance(ms: number) { at += ms; }, async close() { runtime.close(); await controller.close(); } };
}

test('three fresh pairs retain real apply contexts and permit a software effect', async () => {
  const h = fixture(); await h.sample(); await h.sample(); assert.deepEqual(h.effects, []);
  await h.sample(); assert.deepEqual(h.effects, [3]); assert.equal(h.controller.snapshot().state, 'aligned-software-observations');
  await h.close(); assert.equal(h.controller.snapshot().pendingContexts, 0);
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

test('a missing second lane expires and discards its unresolved apply', async () => {
  const h = fixture(); await h.sample({ onlyAudio: true }); assert.equal(h.controller.snapshot().pendingContexts, 1);
  h.advance(101); h.controller.tick(); await Promise.resolve(); assert.equal(h.controller.snapshot().pendingContexts, 0);
  assert.deepEqual(h.effects, []); await h.close();
});
