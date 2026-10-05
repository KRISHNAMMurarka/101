import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPointerPipeline, runPointerExample } from '../examples/device-pipelines/pointer.ts';
import { createSensorFeedbackPipeline, runSensorFeedbackExample } from '../examples/device-pipelines/sensor-feedback.ts';
import { createTemperatureThreshold } from '../examples/device-pipelines/threshold.ts';
import { createProcessorRegistry, parseObservationTiming, observationAgeBounds } from '@101/connect';
import type { AuthorizationRequest } from '@101/connect';

test('the pointer example maps normalized coordinates to the destination dimensions', () => {
  assert.deepEqual(runPointerExample().position, { x: 200, y: 400 });
  assert.deepEqual(runPointerExample({ width: 500, height: 1000 }).position, { x: 100, y: 800 });
  const example = createPointerPipeline({ width: 1000, height: 500 });
  assert.deepEqual(example.publish({ x: 0.2, y: 0.8 }), { ok: true, value: { accepted: 1, rejected: 0 } });
  assert.equal(example.state().position, undefined);
  example.runtime.flush();
  example.resize({ width: 500, height: 1000 });
  assert.deepEqual(example.state().position, { x: 100, y: 800 });
  example.runtime.close();
});

test('the sensor feedback caller validates its typed graph before registering routes', () => {
  const example = createSensorFeedbackPipeline();
  try {
    assert.deepEqual(example.graphPlan.executionOrder, ['sensor', 'threshold', 'relay']);
    assert.deepEqual(example.graphPlan.requiredOperations.map(({ operation }) => operation), ['subscribe', 'invoke']);
  } finally { example.runtime.close(); }
});

test('an exclusive pointer is busy until its current owner releases it', () => {
  const example = createPointerPipeline();
  const other = example.runtime.route({
    from: example.source, to: example.sink, principalId: 'second-owner', applicationId: 'pointer-example', sessionId: 'embedded-demo',
  });
  assert.deepEqual(other.start(), { ok: false, reason: 'busy' });
  example.connection.stop('owner-left');
  assert.equal(example.state().released, 1);
  assert.equal(other.start().ok, true);
  example.runtime.close();
});

test('sensor command dispatch is distinct from a separate feedback observation', () => {
  const example = createSensorFeedbackPipeline();
  assert.equal(example.publishTemperature(31.25, { sequence: 7, provenance: { calibration: { offset: 0.25 } } }).ok, true);
  example.runtime.flush();
  example.runtime.flush();
  const before = example.state();
  assert.equal(before.temperature, 31.25);
  assert.equal(before.unit, 'Cel');
  assert.deepEqual(before.commands.map((command) => command.value), [true]);
  assert.equal(before.operations[0].state, 'unverified');
  assert.deepEqual(before.commands[0].provenance?.upstream, {
    source: { registrationId: example.sensor.id, deviceId: 'demo-thermometer', capabilityId: 'temperature' },
    sequence: 7, timestamp: 0, clockDomain: 'embedded-demo', quality: 'valid',
    provenance: { calibration: { offset: 0.25 } },
  });
  const timing = parseObservationTiming(before.commands[0].provenance?.timing);
  assert.deepEqual(timing.capture, { clockId: 'embedded-demo', at: 0 });
  assert.deepEqual(timing.receipt, { clockId: 'embedded-demo', at: 0 });
  assert.deepEqual(timing.processors.map(step => step.id), ['example:temperature-threshold']);
  assert.deepEqual(observationAgeBounds(timing), { earliestMs: 0, latestMs: 0 });
  assert.deepEqual(example.receiveFeedback(), { value: true, timestamp: 0 });
  assert.equal(example.state().operations[0].state, 'observed');
  example.runtime.close();
  assert.equal(runSensorFeedbackExample({ feedback: false }).operations[0].state, 'unverified');
  assert.equal(runSensorFeedbackExample().operations[0].state, 'observed');
});

test('a source metadata claim cannot replace runtime-owned timing lineage', () => {
  const example = createSensorFeedbackPipeline();
  const forgedTiming = { capture: { clockId: 'forged-clock', at: 9000 },
    receipt: { clockId: 'embedded-demo', at: 0 },
    mapping: { earliest: 0, latest: 0, uncertaintyMs: 0, maxDriftPpm: 0 }, processors: [] };
  assert.equal(example.publishTemperature(31.25, { provenance: { timing: forgedTiming } }).ok, true);
  example.runtime.flush(); example.runtime.flush();
  const timing = parseObservationTiming(example.state().commands[0].provenance?.timing);
  assert.deepEqual(timing.capture, { clockId: 'embedded-demo', at: 0 });
  example.runtime.close();
});

test('measurement reports preserve producer calibration and fault meaning', () => {
  let now = 0;
  const example = createSensorFeedbackPipeline({ now: () => now });
  const valid = { status: 'valid', value: 31.25, calibration: { revision: 7 },
    uncertainty: { absoluteErrorBound: 0.5, unit: 'Cel' }, faults: [] } as const;
  assert.equal(example.publishReport(valid).ok, true);
  example.runtime.flush(); example.runtime.flush();
  assert.deepEqual((example.state().commands[0].provenance?.upstream as { provenance: unknown }).provenance,
    { calibration: { revision: 7 }, uncertainty: { absoluteErrorBound: 0.5, unit: 'Cel' } });
  assert.deepEqual(example.state().lastReport, valid);
  now = 100;
  assert.equal(example.publishReport({ ...valid, value: 27, calibration: { revision: 8 } }).ok, true);
  example.runtime.flush(); example.runtime.flush();
  const secondUpstream = example.state().commands[1].provenance?.upstream as { provenance: { calibration: { revision: number } } };
  assert.equal(secondUpstream.provenance.calibration.revision, 8);
  const loss = { status: 'unavailable', faults: [{ code: 'sensor:disconnected' }] } as const;
  assert.equal(example.publishReport(loss).ok, false);
  example.runtime.flush();
  assert.deepEqual(example.state().lastReport, loss);
  assert.equal(example.state().temperature, undefined);
  assert.equal(example.upstream.status().state, 'closed');
  assert.throws(() => example.publishReport({ ...valid, uncertainty: { absoluteErrorBound: 0.5, unit: 'K' } }));
  assert.deepEqual(example.state().lastReport, loss);
  example.runtime.close();
});

test('a stale producer report cancels a pending derived command', () => {
  const example = createSensorFeedbackPipeline();
  example.publishReport({ status: 'valid', value: 31.25, calibration: { revision: 7 },
    uncertainty: { absoluteErrorBound: 0.5, unit: 'Cel' }, faults: [] });
  example.runtime.flush();
  assert.equal(example.downstream.status().pending, 1);
  assert.equal(example.publishReport({ status: 'stale', faults: [{ code: 'sensor:timeout' }] }).ok, false);
  example.runtime.flush();
  assert.deepEqual(example.state().commands, []);
  assert.equal(example.downstream.operations()[0].state, 'cancelled');
  assert.deepEqual(example.state().lastReport, { status: 'stale', faults: [{ code: 'sensor:timeout' }] });
  example.runtime.close();
});

test('sensor health loss closes pending output and keeps reported limits diagnostic', () => {
  let now = 100;
  const example = createSensorFeedbackPipeline({ now: () => now });
  const health = { schemaVersion: 1, deviceId: 'demo-thermometer', observed: { clockId: 'embedded-demo', at: 100 },
    maxAgeMs: 1000, battery: { levelPercent: 0, charging: false }, thermal: 'nominal',
    firmware: { version: '1.2.3' }, connectivity: 'not-applicable', faults: [],
    resources: [{ capabilityId: 'temperature', state: 'available', maxHz: 10, maxActiveRoutes: 1 }] } as const;
  assert.deepEqual(example.publishHealth(health), { readiness: 'available', limits: { maxHz: 10, maxActiveRoutes: 1 } });
  assert.deepEqual(example.state().lastHealth, health);
  example.publishTemperature(31.25);
  example.runtime.flush();
  assert.equal(example.downstream.status().pending, 1);
  assert.deepEqual(example.publishHealth({ ...health, connectivity: 'offline' }),
    { readiness: 'unavailable', reason: 'connectivity' });
  example.runtime.flush();
  assert.deepEqual(example.state().commands, []);
  assert.equal(example.downstream.operations()[0].state, 'cancelled');
  assert.equal(example.upstream.status().state, 'closed');
  now = 1100.001;
  assert.deepEqual(example.publishHealth(health), { readiness: 'stale', reason: 'stale' });
  assert.deepEqual(example.publishHealth({ ...health, observed: { clockId: 'embedded-demo', at: now }, deviceId: 'other' }),
    { readiness: 'unavailable', reason: 'device' });
  assert.throws(() => example.publishHealth({ ...health, observed: { clockId: 'foreign', at: now } }));
  assert.equal(example.upstream.status().state, 'closed');
  example.runtime.close();
});

test('an available health claim expires during use and cancels pending output', () => {
  let now = 100;
  const example = createSensorFeedbackPipeline({ now: () => now });
  const health = { schemaVersion: 1, deviceId: 'demo-thermometer', observed: { clockId: 'embedded-demo', at: 100 },
    maxAgeMs: 1, battery: null, thermal: 'nominal', firmware: null, connectivity: 'not-applicable',
    faults: [], resources: [{ capabilityId: 'temperature', state: 'available', maxHz: 10, maxActiveRoutes: 1 }] };
  assert.equal(example.publishHealth(health).readiness, 'available');
  example.publishTemperature(31.25);
  example.runtime.flush();
  assert.equal(example.downstream.status().pending, 1);
  now = 102;
  example.runtime.flush();
  assert.equal(example.upstream.status().state, 'closed');
  assert.equal(example.downstream.operations()[0].state, 'cancelled');
  assert.equal(example.publishTemperature(31.25).ok, false);
  example.runtime.close();
});

test('both processor legs require independent resource authorization', () => {
  const requests: Readonly<AuthorizationRequest>[] = [];
  const deniedOutput = createSensorFeedbackPipeline({ authorize(request) {
    requests.push(request);
    return request.sink.deviceId === 'simulated-relay' ? undefined : { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 };
  } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].source.deviceId, 'demo-thermometer');
  assert.equal(requests[0].sink.deviceId, 'temperature-threshold');
  assert.equal(requests[0].sourceOperation, 'subscribe');
  assert.equal(requests[0].sinkOperation, 'write');
  assert.equal(requests[1].source.deviceId, 'temperature-threshold');
  assert.equal(requests[1].sink.deviceId, 'simulated-relay');
  assert.equal(requests[1].sinkOperation, 'invoke');
  deniedOutput.publishTemperature(31.25);
  deniedOutput.runtime.flush(); deniedOutput.runtime.flush();
  assert.deepEqual(deniedOutput.state().commands, []);
  assert.equal(deniedOutput.downstream.status().state, 'idle');
  deniedOutput.runtime.close();
  const deniedInput = createSensorFeedbackPipeline({ authorize: () => undefined });
  deniedInput.publishTemperature(31.25);
  deniedInput.runtime.flush(); deniedInput.runtime.flush();
  assert.equal(deniedInput.state().temperature, undefined);
  assert.deepEqual(deniedInput.state().commands, []);
  deniedInput.runtime.close();
});

test('hysteresis emits stable set-state commands with monotonic operation IDs', () => {
  let now = 0;
  const example = createSensorFeedbackPipeline({ now: () => now });
  for (const value of [31.25, 29, 27.9, 29, 30.1]) {
    example.publishTemperature(value);
    example.runtime.flush(); example.runtime.flush(); example.receiveFeedback();
    now += 100;
  }
  assert.deepEqual(example.state().commands.map(({ value, operationId }) => ({ value, operationId })), [
    { value: true, operationId: '1' }, { value: false, operationId: '2' }, { value: true, operationId: '3' },
  ]);
  example.runtime.close();
  const threshold = createTemperatureThreshold({ unit: 'Cel', onAt: 30, offAt: 28, revision: 1 });
  assert.equal(threshold.evaluate(31.25), true);
  assert.equal(threshold.evaluate(29), undefined);
  threshold.reset();
  assert.equal(threshold.evaluate(29), undefined);
  assert.equal(threshold.evaluate(31.25), true);
  assert.throws(() => createTemperatureThreshold({ unit: 'K', onAt: 30, offAt: 28, revision: 1 }), RangeError);
});

test('the reviewed threshold source resolves through the pinned processor registry', async () => {
  const registry = createProcessorRegistry();
  const manifest = {
    schemaVersion: 1, id: 'example:temperature-threshold', version: '1.0.0',
    codeSha256: 'dc9b34b2d209afe0b8a1d533db681de4a927003e578bde9f98d90d10db977793',
    inputs: [{ id: 'temperature', value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 } }],
    outputs: [{ id: 'switch', value: { type: 'boolean' } }],
    configuration: { type: 'record', fields: {
      onAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
      offAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    } },
    state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
    assets: [], license: 'MIT',
    budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' },
  };
  await registry.registerTrusted({ manifest,
    source: readFileSync(new URL('../examples/device-pipelines/threshold.ts', import.meta.url)),
    factory(configuration) {
      const { onAt, offAt } = configuration as { onAt: number; offAt: number };
      const threshold = createTemperatureThreshold({ unit: 'Cel', onAt, offAt, revision: 1 });
      return { process(inputs) {
        const next = threshold.evaluate(inputs.temperature as number);
        return next === undefined ? undefined : { switch: next };
      }, reset() { threshold.reset(); } };
    },
  });
  const processor = registry.resolve({ id: manifest.id, version: manifest.version,
    codeSha256: manifest.codeSha256, configuration: { onAt: 30, offAt: 28 } });
  assert.deepEqual(processor.process({ temperature: 31 }), { switch: true });
  assert.equal(processor.process({ temperature: 29 }), undefined);
  assert.deepEqual(processor.process({ temperature: 27 }), { switch: false });
  processor.reset();
  assert.equal(processor.process({ temperature: 29 }), undefined);
});

test('a rejected output admission does not suppress a later authorized set-state command', () => {
  let now = 0;
  let allowOutput = false;
  const example = createSensorFeedbackPipeline({ now: () => now, authorize(request) {
    return request.sink.deviceId === 'simulated-relay' && !allowOutput ? undefined : { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 };
  } });
  example.publishTemperature(31.25);
  example.runtime.flush(); example.runtime.flush();
  assert.deepEqual(example.state().commands, []);
  allowOutput = true;
  assert.equal(example.downstream.start().ok, true);
  now = 100;
  example.publishTemperature(31.25);
  example.runtime.flush(); example.runtime.flush();
  assert.deepEqual(example.state().commands.map((command) => command.value), [true]);
  example.runtime.close();
});

test('derived command provenance preserves reading time and its deadline respects reading freshness', () => {
  const example = createSensorFeedbackPipeline({ now: () => 600 });
  example.publishTemperature(31.25, { timestamp: 0 });
  example.runtime.flush(); example.runtime.flush();
  assert.deepEqual(example.state().commands.map((command) => command.value), [true]);
  assert.equal((example.state().commands[0].provenance?.upstream as { timestamp: number }).timestamp, 0);
  assert.equal(example.state().operations[0].deadline, 1000);
  example.runtime.close();
});

test('upstream loss resets the processor and cancels a pending derived command', () => {
  const example = createSensorFeedbackPipeline();
  example.publishTemperature(31.25);
  example.runtime.flush();
  assert.equal(example.downstream.status().pending, 1);
  example.runtime.revoke(example.upstream);
  example.runtime.flush();
  assert.deepEqual(example.state().commands, []);
  assert.equal(example.state().temperature, undefined);
  assert.equal(example.downstream.status().state, 'closed');
  assert.equal(example.downstream.operations()[0].state, 'cancelled');
  example.runtime.close();
});

test('invalid, unavailable and stale readings never become relay commands', () => {
  let now = 0;
  const example = createSensorFeedbackPipeline({ now: () => now });
  assert.equal(example.publishTemperature(NaN).ok, false);
  now = 1001;
  assert.equal(example.publishTemperature(31.25, { timestamp: 0 }).ok, false);
  example.runtime.flush(); example.runtime.flush();
  assert.deepEqual(example.state().commands, []);
  assert.equal(example.publishTemperature(undefined, { quality: 'unavailable' }).ok, false);
  example.runtime.flush(); example.runtime.flush();
  assert.equal(example.state().temperature, undefined);
  assert.deepEqual(example.state().commands, []);
  assert.equal(example.downstream.status().state, 'closed');
  example.runtime.close();
});
