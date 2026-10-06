import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { EmbeddedRuntime } from './runtime.ts';
import { getHapticOutputProfile } from '../../device-model/src/haptic-profile.ts';
import type { HapticBackend, HapticBackendOutcome } from './haptic-output.ts';

// Source-unit resolution only; the independent QA distinguishes this from an installed SDK.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@101/device-model') return { shortCircuit: true, url: new URL('../../device-model/src/index.ts', import.meta.url).href };
  return next(specifier, context);
} });
const { createHapticOutputController, createBrowserHapticBackend } = await import('./haptic-output.ts');

function fixture(invoke: HapticBackend['invoke'] = () => 'api-returned', supported = true) {
  let time = 1000, approved = true, calls = 0;
  const requests: unknown[] = [];
  const runtime = new EmbeddedRuntime({ now: () => time, authorize(request) {
    requests.push(request);
    return approved && request.principalId === 'owner' && request.applicationId === 'haptic-example' && request.sessionId === 'local' &&
      request.source.deviceId === 'haptic-source' && request.sink.deviceId === 'haptic-output' && request.sinkOperation === 'invoke'
      ? { expiresAt: 30000, maxAgeMs: 100, maxHz: 10 } : undefined;
  } });
  const output = createHapticOutputController({ runtime, deviceId: 'haptic-output', now: () => time,
    backend: { profileId: 'app:expo-haptic-presets/1', supported, invoke(preset) { calls++; return invoke(preset); } } });
  output.setAvailable(true);
  const capability = getHapticOutputProfile('app:expo-haptic-presets/1').capability;
  const source = runtime.registerSource({ device: { schemaVersion: 1, id: 'haptic-source', label: 'Haptic source', revision: 1,
    adapter: { id: 'local:haptic-source', version: '1' }, runtime: { platform: 'test' },
    capabilities: [{ ...capability, kind: 'event', permissions: ['subscribe'] }] }, capability: 'preset' });
  runtime.setReadiness(source, 'available');
  const route = runtime.route({ from: source, to: output.endpoint, principalId: 'owner', applicationId: 'haptic-example', sessionId: 'local',
    leaseMs: 1000, queueCapacity: 1 });
  function publish(id: string, value: unknown = 'tap', deadline = time + 100) { return runtime.publish(source, value, { operationId: id, deadline }); }
  return { runtime, output, route, requests, publish, calls: () => calls, approve: (value: boolean) => { approved = value; },
    time: (value: number) => { time = value; }, close() { output.close(); runtime.close(); } };
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));

test('an exact real runtime grant is required before any haptic dispatch', async () => {
  const f = fixture();
  try {
    f.approve(false); assert.equal(f.route.start().ok, false); f.publish('1'); f.runtime.flush(); assert.equal(f.calls(), 0);
    f.approve(true); assert.equal(f.route.start().ok, true); assert.equal(f.publish('1').ok, true); f.runtime.flush(); await drain();
    assert.equal(f.calls(), 1);
    assert.equal(f.route.operations()[0]?.handlerResult, 'returned');
    assert.equal(f.route.operations()[0]?.effectEvidence, 'dispatched');
    assert.equal(f.route.operations()[0]?.state, 'unverified');
    assert.equal(f.output.records()[0]?.outcome, 'api-returned');
    assert.equal(f.output.records()[0]?.physical, 'unverified');
  } finally { f.close(); }
});

test('one held invocation, replay and queued capacity do not repeat a native effect', async () => {
  let resolve!: (outcome: HapticBackendOutcome) => void;
  const held = new Promise<HapticBackendOutcome>(done => { resolve = done; });
  const f = fixture(() => held);
  try {
    f.route.start(); assert.equal(f.publish('1').ok, true); assert.equal(f.publish('2').ok, false);
    f.runtime.flush(); assert.equal(f.publish('1').ok, false); assert.equal(f.calls(), 1);
    f.time(1100); assert.equal(f.publish('2').ok, false, 'the in-flight operation reserves queue capacity');
    resolve('api-returned'); await drain(); assert.equal(f.calls(), 1);
  } finally { resolve('api-returned'); f.close(); }
});

test('revoke fences late return while preserving issued-but-unverified effect evidence', async () => {
  let resolve!: (outcome: HapticBackendOutcome) => void;
  const f = fixture(() => new Promise<HapticBackendOutcome>(done => { resolve = done; }));
  try {
    f.route.start(); f.publish('1'); f.runtime.flush(); f.runtime.revoke(f.route); await drain();
    assert.equal(f.output.records()[0]?.outcome, 'cancelled');
    resolve('api-returned'); await drain();
    assert.equal(f.output.records()[0]?.outcome, 'cancelled');
    assert.equal(f.route.operations()[0]?.state, 'cancelled');
    assert.equal(f.route.operations()[0]?.effectEvidence, 'dispatched');
    assert.equal(f.calls(), 1);
  } finally { resolve('api-returned'); f.close(); }
});

test('expiry before flush, unsupported presets and custom parameters remain inert', async () => {
  const f = fixture();
  try {
    f.route.start(); assert.equal(f.publish('1', { preset: 'tap', duration: 20 }).ok, false);
    assert.equal(f.publish('1', 'tap', 1101).ok, false); assert.equal(f.publish('1').ok, true);
    f.time(1100); f.runtime.flush(); await drain(); assert.equal(f.calls(), 0);
    assert.equal(f.route.operations()[0]?.state, 'expired');
  } finally { f.close(); }
  const absent = fixture(() => { throw Error('unsupported API must never be called'); }, false);
  try { assert.equal(absent.route.start().ok, false); assert.equal(absent.calls(), 0); } finally { absent.close(); }
});

test('browser boolean rejection and missing API never imply target or physical acknowledgement', async () => {
  const absent = createBrowserHapticBackend(undefined);
  assert.equal(absent.supported, false); assert.equal(await absent.invoke('tap'), 'unavailable');
  const patterns: unknown[] = [];
  const backend = createBrowserHapticBackend({ vibrate(pattern) { patterns.push(pattern); return false; } });
  assert.equal(await backend.invoke('warning'), 'unavailable');
  assert.deepEqual(patterns, [[50, 35, 50]]);
});

test('redacted live records are capped and callback rejection is consumed', async () => {
  const f = fixture();
  try {
    f.route.start();
    for (let i = 1; i <= 70; i++) {
      f.time(1000 + (i - 1) * 100);
      if (i % 8 === 0) assert.equal(f.route.renew('owner').ok, true);
      assert.equal(f.publish(String(i)).ok, true); f.runtime.flush(); await drain();
    }
    assert.equal(f.output.records().length, 64);
    assert.equal(f.output.records()[0]?.operationId, '7');
    assert.equal(JSON.stringify(f.output.records()).includes('principalId'), false);
  } finally { f.close(); }
  const rejected = fixture(() => Promise.reject(Error('private native reason')));
  try { rejected.route.start(); rejected.publish('1'); rejected.runtime.flush(); await drain();
    assert.equal(rejected.output.records()[0]?.outcome, 'api-rejected');
    assert.equal(JSON.stringify(rejected.output.records()).includes('private native reason'), false);
  } finally { rejected.close(); }
});

test('an issued synchronous API failure retains the same dispatched evidence as its runtime operation', async () => {
  const f = fixture(() => { throw Error('private synchronous bridge failure'); });
  try {
    f.route.start(); f.publish('1'); f.runtime.flush(); await drain();
    assert.equal(f.calls(), 1);
    assert.equal(f.route.operations()[0]?.effectEvidence, 'dispatched');
    assert.equal(f.output.records()[0]?.effect, 'dispatched');
    assert.equal(f.output.records()[0]?.outcome, 'api-rejected');
    assert.equal(f.output.records()[0]?.physical, 'unverified');
    assert.equal(JSON.stringify(f.output.records()).includes('private synchronous'), false);
  } finally { f.close(); }
});

test('a shared native reservation refusal has no accepted effect and allows a later current retry', async () => {
  let occupied = true;
  const f = fixture(() => occupied ? 'busy' : 'api-returned');
  try {
    f.route.start(); f.publish('1'); f.runtime.flush(); await drain();
    assert.equal(f.output.records()[0]?.outcome, 'busy');
    assert.equal(f.output.records()[0]?.effect, 'none');
    assert.equal(f.route.operations()[0]?.effectEvidence, 'none');
    occupied = false; f.time(1100); assert.equal(f.publish('2').ok, true); f.runtime.flush(); await drain();
    assert.equal(f.output.records()[1]?.outcome, 'api-returned');
    assert.equal(f.output.records()[1]?.effect, 'dispatched');
    assert.equal(f.calls(), 2);
  } finally { f.close(); }
});
