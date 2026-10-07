import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import { decodeWatchCompanionReport, watchCompanionReportDevice } from '@101/device-model';
import type { SpatialFrame } from '@101/device-model';
import { createWearableCalibrationProcessor, wearableFusionInputDevice } from './wearable-calibration.ts';
import type { WearableCalibrationConfiguration, WearableCalibrationHandle, WearableCalibrationResult, WearableFusionInput } from './wearable-calibration.ts';
import type { DeliveryContext, Observation } from './types.ts';

// Exact retained output of the unchanged Swift/Kotlin WatchPayload encoders; not sensor capture.
const HEX = '3101e11087d61200cdcccc3dcdcc4cbe9a99993edf4f6d3f0000003f0000a0bf0000003e0000f142000035c20000004100002a4201';
const FRAME: SpatialFrame = Object.freeze({ id: 'declared:wearer', origin: 'declared:reference', unit: 'm',
  axes: Object.freeze(['right', 'up', 'forward'] as const), handedness: 'right' });
function packet(sequence = 4321, emission = 1234567, orientation?: readonly number[]) {
  const bytes = Uint8Array.from(Buffer.from(HEX, 'hex')), view = new DataView(bytes.buffer);
  view.setUint16(2, sequence, true); view.setUint32(4, emission, true);
  orientation?.forEach((value, i) => view.setFloat32(8 + i * 4, value, true));
  return decodeWatchCompanionReport(bytes);
}
function fixture(options: Readonly<{ routeMaxAgeMs?: number }> = {}) {
  let at = 1000, clockHook: (() => void) | undefined, contextHook: (() => void) | undefined, allowed = true;
  const owner = new AbortController(), results: WearableCalibrationResult<WearableFusionInput>[] = [];
  const runtime = createDeviceRuntime({ clockDomain: 'software-report-arrival', now: () => at,
    authorize: () => allowed ? { expiresAt: 5000, maxAgeMs: options.routeMaxAgeMs ?? 250, maxHz: 30 } : undefined });
  const raw = watchCompanionReportDevice('watch:software-raw', 'watchos');
  const source = runtime.registerSource({ device: raw, capability: 'report' }); runtime.setReadiness(source, 'available');
  const processor = createWearableCalibrationProcessor({ clockDomain: runtime.clockDomain, now: () => { clockHook?.(); return at; } });
  let handle: WearableCalibrationHandle | undefined, deliveredContext: DeliveryContext | undefined;
  const configuration = (revision = 1): WearableCalibrationConfiguration => ({
    profile: { id: 'software:reviewed-watch', version: '1.0.0', sha256: 'a'.repeat(64), revision: 1,
      reportProfile: 'watch-companion-report/1', orientationConvention: 'xyzw-device-to-reference',
      accelerationKind: 'reported-linear', sourceFrame: FRAME, referenceFrame: 'declared:reference' },
    calibration: { revision, hand: 'right', mounting: [0, 0, 0, 1], neutral: [0, 0, 0, 1], targetFrame: FRAME },
    source: { registrationId: source.id, deviceId: raw.id, capabilityId: 'report', descriptorRevision: 1, schemaVersion: 1 },
    signal: owner.signal, expiresAt: 2000,
  });
  const sink = runtime.registerSink({ device: { ...raw, id: 'application:compute', capabilities: raw.capabilities.map(cap =>
    ({ ...cap, permissions: ['write'], ownership: { mode: 'exclusive' } })) }, capability: 'report',
    apply(observation, context) {
      deliveredContext = context;
      const selected = handle;
      const limits = route.limits();
      if (selected && limits) results.push(processor.process(selected, observation,
        { ...context, isCurrent() { contextHook?.(); return context.isCurrent(); } },
        { routeId: route.id, expiresAt: limits.expiresAt, maxAgeMs: limits.maxAgeMs }));
    }, release() { /* No effects in this compute-only fixture. */ } }); runtime.setReadiness(sink, 'available');
  const route = runtime.route({ from: source, to: sink, principalId: 'compute-owner', applicationId: 'reported-projection',
    sessionId: 'software-only', sourceOperation: 'subscribe', leaseMs: 1000 });
  function install(config = configuration()) { const result = processor.configure(config); if (result.ok) handle = result.value; return result; }
  function send(value = packet()) { assert.equal(runtime.publish(source, value, { timestamp: at, clockDomain: runtime.clockDomain }).ok, true); runtime.flush(); }
  return { runtime, processor, owner, source, route, results, configuration, install, send,
    setAt(value: number) { at = value; }, clock(value: (() => void) | undefined) { clockHook = value; },
    context(value: (() => void) | undefined) { contextHook = value; }, allow(value: boolean) { allowed = value; },
    get handle() { return handle!; }, get deliveredContext() { return deliveredContext; }, close() { processor.close(); runtime.close(); } };
}
function value(f: ReturnType<typeof fixture>) { const last = f.results.at(-1); assert.equal(last?.ok, true); if (!last?.ok) throw Error('projection'); return last.value; }

test('real decoded report enters an independently authorized route with reported units and receipt provenance', () => {
  const f = fixture(); try { assert.equal(f.install().ok, true); assert.equal(f.route.start().ok, true); f.send();
    const out = value(f); assert.deepEqual(out.value.accelerationG, { x: 0.5, y: -1.25, z: 0.125 });
    assert.deepEqual(out.value.rotationDegPerSecond, { x: 120.5, y: -45.25, z: 8 });
    assert.equal(out.timestamp, 1000); assert.equal(out.provenance.relayEmissionMs, 1234567);
    assert.equal(out.value.physicalValidity, 'unspecified'); assert.equal(out.value.captureTimeKnown, false);
    assert.equal(out.provenance.observation, 'report-arrival'); assert.ok(Object.isFrozen(out.value.orientation));
  } finally { f.close(); }
});
test('mounting rotates vectors while neutral calibration changes only attitude', () => {
  const f = fixture(); try { const c = f.configuration(); const config = { ...c, calibration: { ...c.calibration,
      mounting: [0, 0, 1, 0] as const, neutral: [0, 0, 1, 0] as const } };
    assert.equal(f.install(config).ok, true); f.route.start(); f.send(packet(4321, 1234567, [0, 0, 0, 1]));
    const out = value(f); assert.deepEqual(out.value.accelerationG, { x: -0.5, y: 1.25, z: 0.125 });
    assert.deepEqual(out.value.rotationDegPerSecond, { x: -120.5, y: 45.25, z: 8 });
    assert.deepEqual(out.value.orientation, { x: 0, y: 0, z: 0, w: 1 });
  } finally { f.close(); }
});
test('declared mirrored frame maps polar and axial vectors differently; hand label alone does not mirror', () => {
  const f = fixture(); try { const c = f.configuration();
    assert.equal(f.install({ ...c, calibration: { ...c.calibration, hand: 'left' } }).ok, true); f.route.start(); f.send();
    assert.deepEqual(value(f).value.accelerationG, { x: 0.5, y: -1.25, z: 0.125 });
    f.setAt(1040); assert.equal(f.install({ ...c, calibration: { ...c.calibration, revision: 2, hand: 'left',
      targetFrame: { ...FRAME, id: 'declared:left-frame', axes: ['left', 'up', 'forward'], handedness: 'left' } } }).ok, true);
    f.send(packet(4322, 1234568)); const out = value(f);
    assert.deepEqual(out.value.accelerationG, { x: -0.5, y: -1.25, z: 0.125 });
    assert.deepEqual(out.value.rotationDegPerSecond, { x: 120.5, y: 45.25, z: -8 });
    assert.equal(out.provenance.mirrored, true); assert.equal(out.value.calibrationRevision, 2);
  } finally { f.close(); }
});
test('unknown semantics and malformed candidates retain the current opaque generation', () => {
  const f = fixture(); try { f.install(); const old = f.handle, c = f.configuration(2);
    assert.equal(f.processor.configure({ ...c, profile: { ...c.profile, orientationConvention: 'unknown' } } as never).ok, false);
    assert.equal(f.processor.configure({ ...c, calibration: { ...c.calibration, mounting: [0, 0, 0, 0] } }).ok, false);
    assert.equal(f.processor.configure({ ...c, profile: { ...c.profile, referenceFrame: 'unrelated-origin' } }).ok, false);
    assert.equal(f.processor.configure({ ...c, source: { ...c.source, schemaVersion: 2 } }).ok, false);
    assert.equal(f.processor.isCurrent(old), true); f.route.start(); f.send(); assert.equal(value(f).value.generation, old.generation);
  } finally { f.close(); }
});
test('revision rollback, copied handle and old generation cannot become current', () => {
  const f = fixture(); try { f.install(); const old = f.handle; assert.equal(f.processor.isCurrent({ ...old }), false);
    assert.equal(f.install(f.configuration()).ok, false); assert.equal(f.install(f.configuration(2)).ok, true);
    assert.equal(f.processor.isCurrent(old), false); assert.equal(f.processor.isCurrent(f.handle), true);
    assert.equal(f.processor.configure({ ...f.configuration(3), profile: { ...f.configuration().profile, sha256: 'b'.repeat(64) } }).ok, false);
  } finally { f.close(); }
});
test('same source ordering floors survive reset and calibration replacement; unsigned wrap remains forward', () => {
  const f = fixture(); try { f.install(); f.route.start(); f.send(packet(65535)); f.processor.reset();
    f.setAt(1040); f.install(f.configuration(2)); f.send(packet(65535)); assert.equal(f.results.at(-1)?.ok, false);
    f.setAt(1080); f.send(packet(0, 1234568)); assert.equal(value(f).value.generation, f.handle.generation);
    f.setAt(1120); f.send(packet(32768, 1234569)); assert.equal(f.results.at(-1)?.ok, false);
  } finally { f.close(); }
});
test('source A to B to A preserves A replay floor under a fresh mounting generation', () => {
  const f = fixture(); try { f.install(); f.route.start(); f.send(); const c = f.configuration(2);
    const device = watchCompanionReportDevice('watch:software-B', 'wearos');
    const second = f.runtime.registerSource({ device, capability: 'report' }); f.runtime.setReadiness(second, 'available');
    assert.equal(f.install({ ...c, source: { ...c.source, registrationId: second.id, deviceId: device.id } }).ok, true);
    assert.equal(f.install(f.configuration(3)).ok, true); f.setAt(1040); f.send();
    assert.deepEqual(f.results.at(-1), { ok: false, reason: 'replay' });
    f.setAt(1080); f.send(packet(4322, 1234568)); assert.equal(value(f).value.calibrationRevision, 3);
  } finally { f.close(); }
});
test('changing only declared descriptor revision does not erase the actual registration replay floor', () => {
  const f = fixture(); try { f.install(); f.route.start(); f.send(); const c = f.configuration(2);
    assert.equal(f.install({ ...c, source: { ...c.source, descriptorRevision: 2 } }).ok, true);
    f.setAt(1040); f.send(); assert.deepEqual(f.results.at(-1), { ok: false, reason: 'replay' });
    f.setAt(1080); f.send(packet(4322, 1234568)); assert.equal(value(f).value.calibrationRevision, 2);
  } finally { f.close(); }
});
test('saturation and nonunit raw orientation are grammar-valid reports but unavailable projection inputs', () => {
  for (const orientation of [[0, 0, 0, 0], [1, 1, 1, 1]]) { const f = fixture(); try {
    f.install(); f.route.start(); f.send(packet(4321, 1234567, orientation)); assert.equal(f.results.at(-1)?.ok, false);
  } finally { f.close(); } }
  const f = fixture(); try { f.install(); f.route.start(); f.send({ ...packet(), accelerationG: [33, 0, 0] }); assert.equal(f.results.at(-1)?.ok, false); } finally { f.close(); }
});
test('exact receipt age and clock failure retire local compute authority', () => {
  const f = fixture(); try { f.install(); f.route.start(); f.context(() => f.setAt(1250)); f.send();
    assert.deepEqual(f.results.at(-1), { ok: false, reason: 'stale' });
    f.context(undefined); f.clock(() => f.setAt(NaN)); assert.equal(f.processor.isCurrent(f.handle), false);
    f.clock(undefined); f.setAt(1300); assert.equal(f.processor.isCurrent(f.handle), false);
  } finally { f.close(); }
});
test('final clock after context callout refuses exact consent expiry and reentrant retirement', () => {
  for (const action of ['expiry', 'reset', 'abort', 'close'] as const) { const f = fixture(); try {
    f.install(); f.route.start(); f.context(() => { if (action === 'expiry') f.setAt(2000); else if (action === 'reset') f.processor.reset();
      else if (action === 'abort') f.owner.abort(); else f.processor.close(); });
    f.send(); assert.equal(f.results.at(-1)?.ok, false);
  } finally { f.close(); } }
});
test('provisional admission is reserved before proxy traps and trusted clock callbacks', () => {
  const f = fixture(); try { let nested: unknown; const config = f.configuration(); const proxy = new Proxy(config, {
      getOwnPropertyDescriptor(target, property) { nested = f.processor.configure(config); return Reflect.getOwnPropertyDescriptor(target, property); } });
    assert.equal(f.processor.configure(proxy).ok, true); assert.deepEqual(nested, { ok: false, reason: 'busy' });
    f.clock(() => f.processor.close()); assert.equal(f.processor.configure(f.configuration(2)).ok, false);
    f.clock(undefined); assert.equal(f.processor.isCurrent(f.handle), false);
  } finally { f.close(); }
});
test('aborted intrinsic signals and accessors never configure authority; attempts are finite', () => {
  const f = fixture(); try { const c = f.configuration(); const aborted = new AbortController(); aborted.abort();
    Object.defineProperty(aborted.signal, 'aborted', { value: false }); assert.equal(f.processor.configure({ ...c, signal: aborted.signal }).ok, false);
    assert.equal(f.processor.configure(Object.defineProperty({ ...c }, 'expiresAt', { get() { throw Error('getter'); } })).ok, false);
    for (let i = 0; i < 30; i++) assert.equal(f.processor.configure({ ...c, profile: { ...c.profile, reportProfile: 'future' } } as never).ok, false);
    assert.deepEqual(f.processor.configure(c), { ok: false, reason: 'capacity' });
  } finally { f.close(); }
});
test('real route denial produces no computation, and stale queued projection is rejected by the final application guard', () => {
  const f = fixture(); let effects = 0, releases = 0; try { f.install(); f.allow(false); assert.equal(f.route.start().ok, false); f.send(); assert.equal(f.results.length, 0);
    f.allow(true); assert.equal(f.route.start().ok, true); f.send(); const out = value(f), old = f.handle;
    const device = wearableFusionInputDevice('application:projection', FRAME, 1);
    const source = f.runtime.registerSource({ device, capability: 'reported-motion' }); f.runtime.setReadiness(source, 'available');
    const sink = f.runtime.registerSink({ device: { ...device, id: 'application:owned-output', capabilities: device.capabilities.map(cap =>
      ({ ...cap, permissions: ['write'], ownership: { mode: 'exclusive' } })) }, capability: 'reported-motion',
      apply(_observation, context) { if (context.isCurrent() && f.processor.isCurrent(old)) effects++; }, release() { releases++; } });
    f.runtime.setReadiness(sink, 'available'); const route = f.runtime.route({ from: source, to: sink, principalId: 'output-owner', applicationId: 'reported-projection', sessionId: 'software-only', leaseMs: 1000 });
    assert.equal(route.start().ok, true); f.runtime.publish(source, out.value, { timestamp: out.timestamp, provenance: out.provenance });
    f.install(f.configuration(2)); f.runtime.flush(); assert.equal(effects, 0); route.stop(); assert.equal(releases, 1);
  } finally { f.close(); }
});
test('foreign registration and raw capture labels cannot change the configured source or manufacture capture timing', () => {
  const f = fixture(); try { f.install(); let result: unknown;
    const raw = watchCompanionReportDevice('watch:foreign', 'wearos'), foreign = f.runtime.registerSource({ device: raw, capability: 'report' }); f.runtime.setReadiness(foreign, 'available');
    const sink = f.runtime.registerSink({ device: { ...raw, id: 'application:foreign-compute', capabilities: raw.capabilities.map(cap => ({ ...cap, permissions: ['write'] })) }, capability: 'report',
      apply(observation: Observation, context: DeliveryContext) { const limits = route.limits(); assert.ok(limits); result = f.processor.process(f.handle, observation, context, { routeId: route.id, expiresAt: limits.expiresAt, maxAgeMs: limits.maxAgeMs }); }, release() {} });
    f.runtime.setReadiness(sink, 'available'); const route = f.runtime.route({ from: foreign, to: sink, principalId: 'compute-owner', applicationId: 'reported-projection', sessionId: 'software-only' }); route.start();
    f.runtime.publish(foreign, packet()); f.runtime.flush(); assert.deepEqual(result, { ok: false, reason: 'wrong-source' });
  } finally { f.close(); }
});

test('final processor clock cannot return a projection after the actual route freshness grant retires', () => {
  const f = fixture({ routeMaxAgeMs: 25 }); try {
    assert.equal(f.install().ok, true); assert.equal(f.route.start().ok, true);
    // Only the processor clock call advances the shared runtime clock: the real
    // DeliveryContext was current at1000, but its narrower grant is stale at1040.
    f.clock(() => f.setAt(1040)); f.send();
    assert.equal(f.deliveredContext?.isCurrent(), false, 'actual runtime context must now refuse its expired freshness scope');
    assert.equal(f.results.at(-1)?.ok, false, 'a late trusted clock callback cannot return a successful projection from the stale route');
  } finally { f.clock(undefined); f.close(); }
});

test('final currentness callback cannot return a projection after the local calibration consent expires', () => {
  const f = fixture(); try {
    assert.equal(f.install({ ...f.configuration(), expiresAt: 1050 }).ok, true);
    assert.equal(f.route.start().ok, true);
    let checks = 0;
    f.context(() => { if (++checks === 2) f.setAt(1100); });
    f.send();
    assert.equal(checks, 2, 'the final actual context check exercises the reciprocal callout');
    assert.equal(f.deliveredContext?.isCurrent(), true, 'the real route remains within its independent lease and freshness grant');
    assert.equal(f.processor.isCurrent(f.handle), false, 'the narrower calibration consent is now expired');
    assert.equal(f.results.at(-1)?.ok, false, 'a final currentness callout cannot use a cached pre-expiry clock to return a successful projection');
  } finally { f.context(undefined); f.close(); }
});

test('the final advancing processor clock honors captured actual route age without requiring a stable clock', () => {
  const f = fixture({ routeMaxAgeMs: 25 }); try {
    assert.equal(f.install().ok, true); assert.equal(f.route.start().ok, true);
    let clocks = 0;
    f.clock(() => { if (++clocks === 2) f.setAt(1040); });
    f.send();
    assert.equal(clocks, 2);
    assert.equal(f.deliveredContext?.isCurrent(), false);
    assert.deepEqual(f.results.at(-1), { ok: false, reason: 'stale' });
    f.clock(undefined); f.setAt(1080); f.send(packet(4322, 1234568));
    assert.equal(value(f).value.generation, f.handle.generation, 'refused projection did not consume the source sequence or output cadence');
  } finally { f.clock(undefined); f.close(); }
});
test('a monotonically advancing high resolution clock can project within declared real route bounds', () => {
  const f = fixture(); try {
    assert.equal(f.install().ok, true); assert.equal(f.route.start().ok, true);
    let clocks = 0;
    f.clock(() => f.setAt(1000 + (++clocks / 10)));
    f.send();
    assert.equal(clocks, 2);
    assert.equal(value(f).value.physicalValidity, 'unspecified');
    assert.equal(f.deliveredContext?.isCurrent(), true);
  } finally { f.clock(undefined); f.close(); }
});
