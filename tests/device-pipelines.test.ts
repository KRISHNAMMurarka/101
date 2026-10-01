import assert from 'node:assert/strict';
import test from 'node:test';
import { createPointerPipeline, runPointerExample } from '../examples/device-pipelines/pointer.ts';
import { createSensorFeedbackPipeline, runSensorFeedbackExample } from '../examples/device-pipelines/sensor-feedback.ts';
import { createTemperatureThreshold } from '../examples/device-pipelines/threshold.ts';
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
  assert.deepEqual(example.receiveFeedback(), { value: true, timestamp: 0 });
  assert.equal(example.state().operations[0].state, 'observed');
  example.runtime.close();
  assert.equal(runSensorFeedbackExample({ feedback: false }).operations[0].state, 'unverified');
  assert.equal(runSensorFeedbackExample().operations[0].state, 'observed');
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
