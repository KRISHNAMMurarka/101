import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '@101/device-runtime';
import { createBrowserOutputSharing } from './output-sharing.ts';

function source() { return { schemaVersion: 1, id: 'example:audio', label: 'Owned audio', revision: 1,
  adapter: { id: 'example:sharing', version: '1.0.0' }, runtime: { platform: 'embedded-test' }, capabilities: [{ id: 'audio', semantic: 'app:private-audio-gate/1', schemaVersion: 1,
    kind: 'sample', value: { type: 'record', fields: { running: { type: 'boolean' }, generation: { type: 'scalar', unit: '1', min: 1, max: Number.MAX_SAFE_INTEGER },
      sampleRateHz: { type: 'scalar', unit: 'Hz', min: 48000, max: 48000 }, channels: { type: 'scalar', unit: '1', min: 2, max: 2 } } },
    delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['subscribe'] }] }; }

test('inert audio construction and denied policy create no native AudioContext or borrowed stream read', async () => {
  let native = 0, reads = 0;
  const owner = new AbortController(), consent = new AbortController(), device = source();
  const runtime = createDeviceRuntime({ now: () => 10, authorize: request => bus.controller.authorizeRoute(request) });
  const handle = runtime.registerSource({ device, capability: 'audio' }); runtime.setReadiness(handle, 'available');
  const bus = createBrowserOutputSharing({ runtime, ownerSignal: owner.signal, applicationId: 'app', sessionId: 'session', now: () => 10,
    sources: [{ id: 'input', ownerId: 'producer', handle, device, capability: 'audio', kind: 'audio', signal: consent.signal, audio() { reads++; return undefined; } }],
    destinations: [{ id: 'audio', kind: 'audio', ownerId: 'listener' }], authorizePolicy: () => undefined, authorizeSource: () => undefined, authorizeSink: () => undefined,
    environment: { createAudioContext() { native++; throw Error('Must remain inert'); }, createCanvas() { throw Error('Must remain inert'); } } });
  assert.equal(bus.select('audio', 0, { kind: 'audio', mode: 'exclusive', inputs: [{ slotId: 'a', sourceId: 'input', principalId: 'listener' }] }).ok, false);
  assert.equal(native, 0); assert.equal(reads, 0); assert.equal(bus.output('audio'), undefined); await bus.close(); runtime.close();
});

test('a copied source identity or grant request cannot turn an unsupported borrowed stream into audio', async () => {
  let reads = 0;
  const runtime = createDeviceRuntime({ now: () => 1, authorize: request => bus.controller.authorizeRoute(request) }), owner = new AbortController(), consent = new AbortController(), device = source();
  const handle = runtime.registerSource({ device, capability: 'audio' }); runtime.setReadiness(handle, 'available');
  const bus = createBrowserOutputSharing({ runtime, ownerSignal: owner.signal, applicationId: 'app', sessionId: 'session', now: () => 1,
    sources: [{ id: 'input', ownerId: 'producer', handle, device, capability: 'audio', kind: 'audio', signal: consent.signal, audio() { reads++; return undefined; } }],
    destinations: [{ id: 'audio', kind: 'audio', ownerId: 'listener' }], authorizePolicy: request => ({ request, signal: consent.signal, expiresAt: 101 }),
    authorizeSource: request => ({ request: { ...request }, signal: consent.signal, expiresAt: 101, maxHz: 20, maxAgeMs: 250 }),
    authorizeSink: request => ({ request, signal: consent.signal, expiresAt: 101, maxHz: 20, maxAgeMs: 250 }) });
  assert.equal(bus.select('audio', 0, { kind: 'audio', mode: 'exclusive', inputs: [{ slotId: 'a', sourceId: 'input', principalId: 'listener' }] }).ok, true);
  assert.equal(bus.start('audio'), false); runtime.publish(handle, { running: true, generation: 1, sampleRateHz: 48000, channels: 2 }); runtime.flush();
  assert.equal(reads, 0); assert.equal(bus.output('audio'), undefined); await bus.close(); runtime.close();
});

test('a final trusted upstream clock advance expires private output despite live consent signals', async () => {
  // Native-shaped software ports qualify this authority ordering only, not native audio effects.
  // The route, gate observation, owner requests, signals and DeliveryContext are genuine SDK producers.
  class Track { readonly kind = 'audio'; readyState = 'live'; stop() { this.readyState = 'ended'; } }
  class Stream { readonly tracks = [new Track()]; getTracks() { return [...this.tracks]; } }
  class Node { connect() { return this; } disconnect() {} }
  const savedStream = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
  Object.defineProperty(globalThis, 'MediaStream', { value: Stream, configurable: true, writable: true });
  let at = 100, armed = false, observers = 0, bus!: ReturnType<typeof createBrowserOutputSharing>;
  const owner = new AbortController(), sourceConsent = new AbortController(), sinkConsent = new AbortController(), policyConsent = new AbortController();
  const borrowed = new Stream(), privateStream = new Stream();
  const native = { state: 'running', sampleRate: 48000, resume: () => Promise.resolve(),
    close() { this.state = 'closed'; return Promise.resolve(); }, createMediaStreamDestination: () => Object.assign(new Node(), { stream: privateStream }),
    createGain: () => Object.assign(new Node(), { gain: { value: 0 } }), createMediaStreamSource: () => new Node() };
  const runtime = createDeviceRuntime({ now: () => at, authorize: request => bus.controller.authorizeRoute(request), maxPendingDeliveries: 2 });
  const device = source(), handle = runtime.registerSource({ device, capability: 'audio' }); runtime.setReadiness(handle, 'available');
  try {
    bus = createBrowserOutputSharing({ runtime, ownerSignal: owner.signal, applicationId: 'app', sessionId: 'session', now: () => at,
      sources: [{ id: 'input', ownerId: 'producer', handle, device, capability: 'audio', kind: 'audio', signal: sourceConsent.signal,
        audio: () => borrowed as unknown as MediaStream,
        upstream() { if (armed && ++observers === 2) at = 1101; return true; } }],
      destinations: [{ id: 'audio', kind: 'audio', ownerId: 'listener' }],
      authorizePolicy: request => ({ request, signal: policyConsent.signal, expiresAt: 1100 }),
      authorizeSource: request => ({ request, signal: sourceConsent.signal, expiresAt: 1100, maxHz: 20, maxAgeMs: 250 }),
      authorizeSink: request => ({ request, signal: sinkConsent.signal, expiresAt: 1100, maxHz: 20, maxAgeMs: 250 }),
      environment: { createAudioContext: () => native as unknown as AudioContext, createCanvas() { throw Error('Audio fixture has no raster'); } } });
    assert.equal(bus.select('audio', 0, { kind: 'audio', mode: 'exclusive', inputs: [{ slotId: 'a', sourceId: 'input', principalId: 'listener' }] }).ok, true);
    assert.equal(bus.start('audio'), true);
    assert.equal(runtime.publish(handle, { running: true, generation: 1, sampleRateHz: 48000, channels: 2 }).ok, true); runtime.flush();
    for (let turn = 0; turn < 16 && bus.snapshot().providerPending; turn++) await Promise.resolve();
    assert.equal(bus.snapshot().providerPending, 0); assert.equal(bus.output('audio'), privateStream);
    armed = true; observers = 0;
    const returned = bus.output('audio');
    assert.equal(at, 1101); assert.equal(sourceConsent.signal.aborted, false); assert.equal(sinkConsent.signal.aborted, false); assert.equal(policyConsent.signal.aborted, false);
    assert.equal(returned, undefined, 'Clock-only expiry at the final upstream callback must prevent private stream return');
  } finally {
    await bus?.close(); runtime.close();
    if (savedStream) Object.defineProperty(globalThis, 'MediaStream', savedStream); else Reflect.deleteProperty(globalThis, 'MediaStream');
  }
});
