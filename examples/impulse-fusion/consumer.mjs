import assert from 'node:assert/strict';
import { createDeviceRuntime, parseDeviceDescriptor, createImpulseFusionProcessor, measurePcmImpulse, IMPULSE_FUSION_PROFILE } from '@101/connect';

// Labeled synthetic producer inputs, never a microphone permission or physical tap accuracy receipt.
const config = { id: 'example:impulse', version: '1.0.0', configurationRevision: 1,
  audioSourceId: 'audio:owned', motionSourceId: 'motion:owned', audioEpoch: 'audio-one', motionEpoch: 'motion-one',
  audioCalibrationRevision: 1, motionCalibrationRevision: 1, clockId: 'fixture',
  audioHigh: 0.5, audioLow: 0.1, motionHigh: 3, motionLow: 0.5,
  coincidenceWindowMs: 30, refractoryMs: 100, maxAgeMs: 100, maxUncertaintyMs: 2, maxGapMs: 200 };
const stamp = at => ({ clockId: 'fixture', at });
const timing = at => ({ capture: stamp(at), receipt: stamp(at), mapping: null, processors: [] });
const audio = (at, level, extra = {}) => ({ ...measurePcmImpulse({ samples: new Float32Array(480).fill(level), sampleRate: 48000,
  sourceId: config.audioSourceId, epoch: config.audioEpoch, calibrationRevision: 1, timing: timing(at) }), ...extra });
const motion = (at, acceleration, extra = {}) => ({ kind: 'motion', sourceId: config.motionSourceId, epoch: config.motionEpoch,
  quality: 'valid', measurement: { orientation: [0, 0, 0, 1], acceleration, angularVelocity: [0, 0, 0],
    units: { acceleration: 'm/s2', angularVelocity: 'rad/s' }, deviceFrame: 'fixture:body', referenceFrame: 'fixture:start',
    accelerationKind: 'linear', calibrationRevision: 1, timing: timing(at) }, ...extra });
const checks = [];
function check(name, condition) { assert.ok(condition, name); checks.push({ name, result: 'pass' }); }
function runLabel(label, events, want) {
  const p = createImpulseFusionProcessor(config); p.process(audio(100, 0), stamp(100)); p.process(motion(100, [0, 0, 0]), stamp(100));
  let found = 0; for (const event of events) if (p.process(event, stamp(event.kind === 'audio' ? event.timing.receipt.at : event.measurement.timing.receipt.at)).state === 'candidate') found++;
  check(label, found === want);
}
runLabel('coincident synthetic impulse', [audio(110, 0.8), motion(125, [4, 0, 0])], 1);
runLabel('reverse arrival synthetic impulse', [motion(110, [4, 0, 0]), audio(125, 0.8)], 1);
runLabel('audio-only synthetic sound', [audio(110, 0.8), motion(125, [0.1, 0, 0])], 0);
runLabel('motion-only synthetic movement', [motion(110, [4, 0, 0]), audio(125, 0.01)], 0);
runLabel('separated synthetic impulses', [audio(110, 0.8), motion(160, [4, 0, 0])], 0);
runLabel('repeated sustained signals', [audio(110, 0.8), motion(125, [4, 0, 0]), audio(150, 0.8), motion(160, [4, 0, 0])], 1);
runLabel('unavailable input clears prior impulse', [audio(110, 0.8), motion(125, [4, 0, 0], { quality: 'unavailable' }), motion(140, [4, 0, 0])], 0);
runLabel('replacement generation is never merged', [audio(110, 0.8), motion(125, [4, 0, 0], { epoch: 'motion-two' }), motion(140, [4, 0, 0])], 0);

const scalar = (unit, min, max) => ({ type: 'scalar', unit, min, max });
const audioSchema = { type: 'record', fields: { peak: scalar('1', 0, 1), rms: scalar('1', 0, 1) } };
const motionSchema = { type: 'vector', unit: 'm/s2', frame: 'fixture:body', min: -100, max: 100, components: ['x', 'y', 'z'] };
function descriptor(id, value, semantic, sink = false) {
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Labeled synthetic impulse fixture', revision: 1,
    adapter: { id: 'example:impulse-fixture', version: '1.0.0' }, runtime: { platform: 'owned-node-fixture' }, capabilities: [{
      id: 'reading', semantic, schemaVersion: 1, kind: 'event', value, delivery: { mode: 'reliable', maxAgeMs: 100 },
      permissions: [sink ? 'write' : 'subscribe'], ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] });
}
let at = 100, audioAllowed = true, outputsAllowed = true;
const outputs = [], p = createImpulseFusionProcessor(config);
const policy = new Map([['audio:owned', 'fusion:audio'], ['motion:owned', 'fusion:motion'], ['fusion:output', 'application:output']]);
const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'fixture', maxRoutes: 3, maxRegistrations: 6,
  authorize(request) {
    if (request.principalId !== 'application-owner' || request.applicationId !== 'impulse-demo' || request.sessionId !== 'local' ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
        policy.get(request.source.deviceId) !== request.sink.deviceId || request.source.deviceId === 'audio:owned' && !audioAllowed ||
        request.source.deviceId === 'fusion:output' && !outputsAllowed) return;
    return { maxHz: 100, maxAgeMs: 100, expiresAt: 1000 };
  } });
const source = (id, value, semantic) => {
  const handle = runtime.registerSource({ device: descriptor(id, value, semantic), capability: 'reading' }); runtime.setReadiness(handle, 'available'); return handle;
};
const audioSource = source('audio:owned', audioSchema, 'sensor:pcm-impulse-feature/1');
const motionSource = source('motion:owned', motionSchema, 'sensor:linear-acceleration/1');
const fusedSource = source('fusion:output', scalar('1', 1, Number.MAX_SAFE_INTEGER), 'sensor:coincident-impulse/1');
const operationIds = new Map();
function emit(handle, value) {
  const operation = (operationIds.get(handle) ?? 0) + 1; operationIds.set(handle, operation);
  const result = runtime.publish(handle, value, { timestamp: at, clockDomain: 'fixture', operationId: String(operation), deadline: at + 50 });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
function deliver(result) {
  if (result.state === 'candidate') emit(fusedSource, result.candidate.sequence);
}
function sink(id, value, semantic, receive) {
  const handle = runtime.registerSink({ device: descriptor(id, value, semantic, true), capability: 'reading', apply: receive, release() { p.reset(); } });
  runtime.setReadiness(handle, 'available'); return handle;
}
const audioSink = sink('fusion:audio', audioSchema, 'sensor:pcm-impulse-feature/1', observation => {
  deliver(p.process({ ...audio(observation.timestamp, 0), ...observation.value }, stamp(at)));
});
const motionSink = sink('fusion:motion', motionSchema, 'sensor:linear-acceleration/1', observation => {
  deliver(p.process(motion(observation.timestamp, [observation.value.x, observation.value.y, observation.value.z]), stamp(at)));
});
const outputSink = sink('application:output', scalar('1', 1, Number.MAX_SAFE_INTEGER), 'sensor:coincident-impulse/1', observation => outputs.push(observation.value));
const route = (source, sink) => {
  const connection = runtime.route({ from: source, to: sink, principalId: 'application-owner', applicationId: 'impulse-demo', sessionId: 'local' });
  return { connection, ok: connection.start().ok };
};
const audioRoute = route(audioSource, audioSink), motionRoute = route(motionSource, motionSink), outputRoute = route(fusedSource, outputSink);
try {
  check('three independent ordinary SDK grants', audioRoute.ok && motionRoute.ok && outputRoute.ok);
  function publish(time, level, acceleration) {
    at = time; const measured = audio(time, level);
    emit(audioSource, { peak: measured.peak, rms: measured.rms });
    emit(motionSource, { x: acceleration, y: 0, z: 0 });
    runtime.flush();
  }
  publish(100, 0, 0); publish(110, 0.8, 4); runtime.flush();
  check('granted inputs reach one actual application event sink', outputs.length === 1 && outputs[0] === 1);
  publish(125, 0, 0); at = 140; const feature = audio(at, 0.8);
  emit(audioSource, { peak: feature.peak, rms: feature.rms }); runtime.flush();
  runtime.setReadiness(motionSource, 'unavailable'); runtime.flush();
  check('real source loss closes the input route and clears retained evidence', motionRoute.ok && motionRoute.connection.status().state === 'closed');
  at = 150; check('actual route release erased the remembered audio impulse', p.process(motion(at, [4, 0, 0]), stamp(at)).state === 'none');
  audioAllowed = false; if (audioRoute.ok) audioRoute.connection.stop();
  check('source owner denial blocks a fresh ordinary route', !route(audioSource, audioSink).ok);
  outputsAllowed = false; if (outputRoute.ok) outputRoute.connection.stop();
  check('destination owner denial blocks a fresh event route', !route(fusedSource, outputSink).ok);
  runtime.close(); check('all owned SDK connections close', [audioRoute, motionRoute, outputRoute].every(route => route.connection.status().state === 'closed'));
} finally { runtime.close(); p.reset(); }
console.log(JSON.stringify({ status: 'pass', profile: IMPULSE_FUSION_PROFILE, inputEvidence: 'labeled-synthetic-producer-fixtures',
  hardwareAccuracy: 'unqualified', microphonePermissionOpened: false, recording: false, checks,
  exclusions: ['No physical tap classifier accuracy, acoustic calibration, human false-activation rates, battery/thermal or hardware latency claim',
    'The processor does not authenticate source labels or grant capture/sharing; trusted runtime source/destination grants remain separate'] }));
