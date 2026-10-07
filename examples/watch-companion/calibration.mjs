import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeviceRuntime, createWatchCompanionResources, decodeWatchCompanionReport, watchCompanionReportDevice,
  createWearableCalibrationProcessor, wearableFusionInputDevice, WEARABLE_CALIBRATION_PROFILE } from '@101/connect';

/** Software bridge replay of retained executable encoder bytes; no watch, native bridge or sensor is opened. */
export async function runWearableCalibrationExample(fixture) {
  const checks = [], records = [], approvals = [], rawTasks = new Set();
  const bytes = Uint8Array.from(Buffer.from(fixture.baseHex, 'hex'));
  assert.equal(bytes.byteLength, 53);
  const original = decodeWatchCompanionReport(bytes);
  const check = (name, work) => { work(); checks.push(name); };
  check('retained genuine encoder packet decodes without physical qualification', () => {
    assert.equal(original.sequence, 4321); assert.equal(original.physicalValidity, 'unspecified');
  });
  let at = 1000, starts = 0, stops = 0, epoch = 0, enrollment, reportListener;
  let sourceAllowed = false, outputAllowed = false, owner = new AbortController(), issuer;
  let handle, sourceReference, outputSource, outputSink, outputRoute, lastEffect, releases = 0, effects = 0;
  let computeRoute, inputSource, failure, beforeCurrent;
  const clockDomain = 'software-watch-arrival-' + process.pid;
  const FRAME = { id: 'declared:wearer', origin: 'declared:reference', unit: 'm', axes: ['right', 'up', 'forward'], handedness: 'right' };
  const LEFT = { ...FRAME, id: 'declared:left', axes: ['left', 'up', 'forward'], handedness: 'left' };
  function tracked(work) {
    const pending = Promise.resolve().then(work); rawTasks.add(pending);
    pending.then(() => rawTasks.delete(pending), () => rawTasks.delete(pending)); return pending;
  }
  const bridge = {
    enroll: signal => tracked(() => { assert.equal(signal.aborted, false); issuer = new AbortController();
      enrollment = Object.freeze({ platform: 'watchos', epoch: ++epoch, signal: issuer.signal,
        snapshot: Object.freeze({ platform: 'watchos', companionPaired: true, appInstalled: true, reachable: true, nearby: false }) }); return enrollment; }),
    start: (selected, listener, _loss, signal) => tracked(() => { assert.equal(selected, enrollment); assert.equal(signal.aborted, false); starts++; reportListener = listener; }),
    stop: selected => tracked(() => { assert.equal(selected, enrollment); stops++; if (selected.signal === issuer.signal) issuer.abort(); }),
  };
  const runtime = createDeviceRuntime({ clockDomain, now: () => at, maxRoutes: 8, maxRegistrations: 8,
    authorize(request) { approvals.push(request); assert.equal(request.sourceOperation, 'subscribe'); assert.equal(request.sinkOperation, 'write');
      if (request.applicationId !== 'reported-projection' || request.sessionId !== 'software-only') return undefined;
      if (request.principalId === 'compute-owner' && request.source.registrationId === inputSource?.id &&
        request.sink.registrationId === computeSink.id && request.source.capabilityId === 'report' && request.sink.capabilityId === 'report') {
        sourceReference = request.source; return { expiresAt: 5000, maxHz: 30, maxAgeMs: 250 };
      }
      return outputAllowed && request.principalId === 'application-owner' && request.source.registrationId === outputSource?.id &&
        request.sink.registrationId === outputSink?.id && request.source.capabilityId === 'reported-motion' && request.sink.capabilityId === 'reported-motion'
        ? { expiresAt: 5000, maxHz: 30, maxAgeMs: 250 } : undefined;
    } });
  const processor = createWearableCalibrationProcessor({ clockDomain, now: () => at });
  function retireOutput() {
    const route = outputRoute, source = outputSource, sink = outputSink;
    outputRoute = undefined; outputSource = undefined; outputSink = undefined;
    route?.stop('projection-retired'); if (source) runtime.unregister(source); if (sink) runtime.unregister(sink); lastEffect = undefined;
  }
  const raw = watchCompanionReportDevice('application:raw-compute', 'watchos');
  const computeSink = runtime.registerSink({ device: { ...raw, capabilities: raw.capabilities.map(cap => ({ ...cap, permissions: ['write'], ownership: { mode: 'exclusive' } })) }, capability: 'report',
    apply(observation, context) {
      const selected = handle;
      if (!selected) return;
      const limits = computeRoute?.limits();
      if (!limits) { processor.reset(); retireOutput(); return; }
      const result = processor.process(selected, observation,
        { ...context, isCurrent() { beforeCurrent?.(); return context.isCurrent(); } },
        { routeId: computeRoute.id, expiresAt: limits.expiresAt, maxAgeMs: limits.maxAgeMs });
      failure = result.ok ? undefined : result.reason;
      if (!result.ok) { if (result.reason === 'retired') retireOutput(); return; }
      assert.ok(records.length < 32); records.push(result.value);
      if (outputSource && context.isCurrent() && processor.isCurrent(selected))
        assert.equal(runtime.publish(outputSource, result.value.value, { timestamp: result.value.timestamp, clockDomain, provenance: result.value.provenance }).ok, true);
    }, release() { processor.reset(); retireOutput(); } }); runtime.setReadiness(computeSink, 'available');
  const resources = createWatchCompanionResources({ runtime, bridge, ownerId: 'software-watch-owner', now: () => at,
    approve: request => sourceAllowed && request.ownerId === 'software-watch-owner' && request.operation === 'subscribe' &&
      request.profile === 'watch-companion-report/1' && request.enrollment === enrollment
      ? { request, signal: owner.signal, expiresAt: 5000 } : undefined });
  const profile = { id: 'software:reviewed-watch', version: '1.0.0', sha256: 'a'.repeat(64), revision: 1,
    reportProfile: 'watch-companion-report/1', orientationConvention: 'xyzw-device-to-reference', accelerationKind: 'reported-linear',
    sourceFrame: FRAME, referenceFrame: 'declared:reference' };
  function configuration(revision, hand = 'right', targetFrame = FRAME, mounting = [0, 0, 0, 1], neutral = [0, 0, 0, 1]) {
    return { profile, calibration: { revision, hand, targetFrame, mounting, neutral }, source: sourceReference,
      signal: owner.signal, expiresAt: Math.min(5000, at + 2000) };
  }
  function select(config) {
    const result = processor.configure(config); if (!result.ok) return result;
    // Real route removal drops queued old observations; the sink also fences its captured handle.
    retireOutput(); handle = result.value;
    const selected = handle, device = wearableFusionInputDevice('application:reported-projection', config.calibration.targetFrame, config.calibration.revision);
    outputSource = runtime.registerSource({ device, capability: 'reported-motion' }); runtime.setReadiness(outputSource, 'available');
    outputSink = runtime.registerSink({ device: { ...device, id: 'application:owned-effect', capabilities: device.capabilities.map(cap =>
      ({ ...cap, permissions: ['write'], ownership: { mode: 'exclusive' } })) }, capability: 'reported-motion',
      apply(observation, context) {
        if (context.isCurrent() && processor.isCurrent(selected) && !context.signal.aborted && observation.value.generation === selected.generation) {
          effects++; lastEffect = observation;
        }
      }, release() { releases++; lastEffect = undefined; } }); runtime.setReadiness(outputSink, 'available');
    outputRoute = runtime.route({ from: outputSource, to: outputSink, principalId: 'application-owner', applicationId: 'reported-projection',
      sessionId: 'software-only', sourceOperation: 'subscribe', leaseMs: 1000, queueCapacity: 1 });
    outputRoute.start(); return result;
  }
  async function open() {
    const opened = await resources.start(); assert.equal(opened.ok, true);
    inputSource = opened.value;
    computeRoute = runtime.route({ from: opened.value, to: computeSink, principalId: 'compute-owner', applicationId: 'reported-projection',
      sessionId: 'software-only', sourceOperation: 'subscribe', leaseMs: 1000 }); assert.equal(computeRoute.start().ok, true);
  }
  function emit(sequence = original.sequence, emission = original.relayEmissionMs, orientation) {
    const data = bytes.slice(), view = new DataView(data.buffer);
    view.setUint16(2, sequence, true); view.setUint32(4, emission, true);
    orientation?.forEach((value, index) => view.setFloat32(8 + 4 * index, value, true));
    reportListener({ enrollment, data: Buffer.from(data).toString('base64') }); runtime.flush(); runtime.flush();
  }
  try {
    check('construction is inert', () => { assert.equal(starts, 0); assert.equal(effects, 0); });
    assert.equal((await resources.start()).ok, false);
    check('exact source owner denial opens no report capture', () => assert.equal(starts, 0));
    sourceAllowed = true; await open();
    check('undeclared report cannot project or deliver', () => { emit(); assert.equal(records.length, 0); assert.equal(effects, 0); });
    assert.equal(select(configuration(1)).ok, true); at = 1040; emit(4322, 1234568);
    check('independent output owner denial produces no application effect', () => { assert.equal(records.length, 1); assert.equal(effects, 0); assert.equal(outputRoute.status().state, 'idle'); });
    outputAllowed = true; assert.equal(outputRoute.start().ok, true); at = 1080; emit(4323, 1234569);
    check('real typed separately granted application effect', () => { assert.equal(effects, 1); assert.equal(lastEffect.value.physicalValidity, 'unspecified'); });
    check('arrival and relay emission retain different meanings', () => { assert.equal(lastEffect.timestamp, 1080); assert.equal(lastEffect.provenance.relayEmissionMs, 1234569); assert.equal(lastEffect.provenance.captureTimeKnown, false); });
    check('reported units are retained without grams or synthetic capture conversion', () => {
      assert.deepEqual(lastEffect.value.accelerationG, { x: 0.5, y: -1.25, z: 0.125 }); assert.deepEqual(lastEffect.value.rotationDegPerSecond, { x: 120.5, y: -45.25, z: 8 });
    });
    const old = handle;
    check('copied generation handle is inert', () => assert.equal(processor.isCurrent({ ...handle }), false));
    assert.equal(select({ ...configuration(2), profile: { ...profile, orientationConvention: 'undeclared' } }).ok, false);
    check('unknown candidate preserves incumbent consent and application output', () => { assert.equal(processor.isCurrent(old), true); assert.equal(outputRoute.status().state, 'active'); });
    assert.equal(select(configuration(2, 'left')).ok, true); at = 1120; emit(4324, 1234570);
    check('hand metadata alone does not mirror physical axes', () => assert.deepEqual(lastEffect.value.accelerationG, { x: 0.5, y: -1.25, z: 0.125 }));
    assert.equal(select(configuration(3, 'left', LEFT)).ok, true); at = 1160; emit(4325, 1234571);
    check('declared handed frame maps polar acceleration', () => assert.deepEqual(lastEffect.value.accelerationG, { x: -0.5, y: -1.25, z: 0.125 }));
    check('declared handed frame maps axial angular velocity with parity', () => assert.deepEqual(lastEffect.value.rotationDegPerSecond, { x: 120.5, y: 45.25, z: -8 }));
    check('changed generation and declared calibration provenance', () => { assert.equal(processor.isCurrent(old), false); assert.equal(lastEffect.provenance.calibrationRevision, 3); assert.equal(lastEffect.provenance.mirrored, true); });
    assert.equal(select(configuration(4, 'right', FRAME, [0, 0, 1, 0], [0, 0, 1, 0])).ok, true); at = 1200; emit(4326, 1234572, [0, 0, 0, 1]);
    check('explicit mounting and neutral attitude projection', () => { assert.deepEqual(lastEffect.value.orientation, { x: 0, y: 0, z: 0, w: 1 }); assert.deepEqual(lastEffect.value.accelerationG, { x: -0.5, y: 1.25, z: 0.125 }); });
    const prior = lastEffect, before = effects; runtime.publish(outputSource, prior.value, { timestamp: prior.timestamp, provenance: prior.provenance });
    assert.equal(select(configuration(5)).ok, true); runtime.flush();
    check('actual unregister releases old output and removes its queued application effect', () => { assert.equal(effects, before); assert.equal(lastEffect, undefined); assert.ok(releases >= 4); });
    at = 1240; emit(4327, 1234573); issuer.abort();
    check('actual report source loss retires computation and downstream output', () => { assert.equal(computeRoute.status().state, 'closed'); assert.equal(outputRoute, undefined); assert.equal(lastEffect, undefined); });
    await Promise.allSettled([...rawTasks]); owner = new AbortController(); at = 1280; await open();
    assert.equal(select(configuration(6)).ok, true); at = 1320; emit();
    check('fresh enrollment registration and consent accept a fresh original packet without replaying old registration', () => { assert.equal(lastEffect.value.calibrationRevision, 6); assert.equal(starts, 2); });
    const expires = at + 100; assert.equal(select({ ...configuration(7), expiresAt: expires }).ok, true);
    beforeCurrent = () => { at = expires; }; at = 1360; const effectCount = effects; emit(4322, 1234568);
    check('final trusted callout clock expiry refuses new effect and retires the owned output', () => { assert.equal(failure, 'retired'); assert.equal(effects, effectCount); assert.equal(lastEffect, undefined); });
    beforeCurrent = undefined;
    check('resource route approvals retain exact independent operations', () => assert.ok(approvals.length >= 8 && approvals.every(r => r.sourceOperation === 'subscribe' && r.sinkOperation === 'write')));
  } finally {
    beforeCurrent = undefined; retireOutput(); computeRoute?.stop(); owner.abort(); resources.close(); processor.close(); runtime.close();
    await Promise.allSettled([...rawTasks]); await new Promise(resolve => setImmediate(resolve)); await Promise.allSettled([...rawTasks]);
    assert.equal(rawTasks.size, 0); assert.equal(resources.status().pendingNativeOperations, 0);
  }
  return { status: 'pass', profile: WEARABLE_CALIBRATION_PROFILE, checks, observedEffects: effects, releases, sourceStarts: starts, sourceStops: stops,
    producerMeaning: 'Retained genuine encoder base; sequence/emission/orientation patches are labeled software vectors',
    physicalValidity: 'unspecified', captureTimeKnown: false, nativeFrameworkDelivery: 'unqualified-software-bridge-only',
    clockDomain, rawSoftwarePromises: 0, activeOutput: false, cleanup: { runtimeClosed: true, processorClosed: true, reportProviderClosed: true } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = readFileSync(process.argv[2]); assert.ok(input.byteLength <= 32768);
  const proof = await runWearableCalibrationExample(JSON.parse(input)); console.log(JSON.stringify(proof));
}
