import { createDeviceRuntime, parseMeasurementReport } from '@101/connect';
import type { Authorize, DeliveryContext, DeviceDescriptor, JsonObject, MeasurementReport, PublishOptions } from '@101/connect';
import { createTemperatureThreshold } from './threshold.ts';

interface SensorOptions { feedback?: boolean; now?: () => number; authorize?: Authorize }
interface AppliedCommand { value: boolean; operationId: string; provenance?: JsonObject }

const thermometer: DeviceDescriptor = {
  schemaVersion: 1, id: 'demo-thermometer', label: 'Room temperature', revision: 1,
  adapter: { id: 'example:embedded-temperature', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [{
    id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'],
  }],
};

const thresholdDevice: DeviceDescriptor = {
  schemaVersion: 1, id: 'temperature-threshold', label: 'Temperature threshold', revision: 1,
  adapter: { id: 'example:threshold', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [
    { ...thermometer.capabilities[0], id: 'temperature-input', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } },
    { id: 'relay-state', semantic: 'example:relay-state', schemaVersion: 1, kind: 'event',
      value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
  ],
};

const relay: DeviceDescriptor = {
  schemaVersion: 1, id: 'simulated-relay', label: 'Simulated relay', revision: 1,
  adapter: { id: 'example:embedded-relay', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [{ ...thresholdDevice.capabilities[1], id: 'set-state', kind: 'command', permissions: ['invoke'], ownership: { mode: 'exclusive' } }],
};

/** Explicit two-leg processor wiring. All output and feedback here are simulated. */
export function createSensorFeedbackPipeline(options: SensorOptions = {}) {
  const now = options.now ?? (() => 0);
  const processor = createTemperatureThreshold({ unit: 'Cel', onAt: 30, offAt: 28, revision: 1 });
  let temperature: number | undefined;
  let operationSequence = 0;
  let simulatedState = false;
  let pendingFeedback: { value: boolean; context: DeliveryContext } | undefined;
  let lastReport: MeasurementReport | undefined;
  const commands: AppliedCommand[] = [];
  const runtime = createDeviceRuntime({ now, clockDomain: 'embedded-demo',
    authorize: options.authorize ?? (() => ({ expiresAt: now() + 10000, maxAgeMs: 1000, maxHz: 10 })),
  });
  const sensor = runtime.registerSource({ device: thermometer, capability: 'temperature' });
  const derived = runtime.registerSource({ device: thresholdDevice, capability: 'relay-state' });
  const relaySink = runtime.registerSink({ device: relay, capability: 'set-state',
    apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      if (typeof observation.value !== 'boolean' || !context.operationId) throw new TypeError('Expected a declared set-state command');
      simulatedState = observation.value;
      commands.push({ value: observation.value, operationId: context.operationId, ...(observation.provenance ? { provenance: observation.provenance } : {}) });
      if (commands.length > 64) commands.shift();
      context.reportEvidence('dispatched');
      // Return from apply is dispatch evidence. A later read supplies feedback.
      context.reportEvidence('unverified');
      pendingFeedback = options.feedback === false ? undefined : { value: observation.value, context };
    },
    release() { simulatedState = false; pendingFeedback = undefined; },
  });
  const processorSink = runtime.registerSink({ device: thresholdDevice, capability: 'temperature-input',
    apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      if (typeof observation.value !== 'number') throw new TypeError('Expected the declared Celsius measurement');
      temperature = observation.value;
      const next = processor.evaluate(temperature);
      if (next === undefined) return;
      const provenance: JsonObject = {
        upstream: { source: { ...observation.source }, sequence: observation.sequence, timestamp: observation.timestamp,
          clockDomain: observation.clockDomain, quality: observation.quality,
          ...(observation.provenance ? { provenance: observation.provenance } : {}),
        },
        processor: { ...processor.metadata },
      };
      const processedAt = now();
      const admitted = runtime.publish(derived, next, {
        operationId: String(++operationSequence), deadline: Math.min(processedAt + 500, observation.timestamp + 1000),
        timestamp: processedAt, clockDomain: observation.clockDomain, quality: observation.quality, provenance,
      });
      if (!admitted.ok || admitted.value.accepted === 0) processor.reset();
    },
    release() {
      temperature = undefined;
      processor.reset();
      runtime.setReadiness(derived, 'unavailable');
    },
  });
  for (const handle of [sensor, processorSink, relaySink]) runtime.setReadiness(handle, 'available');
  const identity = { principalId: 'example-owner', applicationId: 'sensor-example', sessionId: 'embedded-demo' };
  const upstream = runtime.route({ from: sensor, to: processorSink, ...identity });
  const inputStart = upstream.start();
  if (inputStart.ok) runtime.setReadiness(derived, 'available');
  const downstream = runtime.route({ from: derived, to: relaySink, ...identity });
  const outputStart = downstream.start();
  return {
    runtime, sensor, derived, processorSink, relaySink, upstream, downstream, inputStart, outputStart,
    publishTemperature(value: unknown, publication?: PublishOptions) { return runtime.publish(sensor, value, publication); },
    publishReport(input: unknown) {
      const report = parseMeasurementReport(input, thermometer.capabilities[0].value);
      lastReport = report;
      return report.status === 'valid'
        ? runtime.publish(sensor, report.value, { quality: 'valid', provenance: {
          calibration: { ...report.calibration }, uncertainty: { ...report.uncertainty },
        } })
        : runtime.publish(sensor, undefined, { quality: report.status });
    },
    receiveFeedback() {
      const pending = pendingFeedback;
      pendingFeedback = undefined;
      if (!pending || pending.context.signal.aborted || !pending.context.isCurrent()) return undefined;
      const observed = { value: simulatedState, timestamp: now() };
      if (observed.value === pending.value) pending.context.reportEvidence('observed');
      return observed;
    },
    state() {
      return { temperature, unit: 'Cel', lastReport, commands: commands.map((command) => ({ ...command })), operations: downstream.operations() };
    },
  };
}

export function runSensorFeedbackExample(options: Pick<SensorOptions, 'feedback'> = {}) {
  const example = createSensorFeedbackPipeline(options);
  try {
    example.publishReport({ status: 'valid', value: 31.25, calibration: { revision: 7 },
      uncertainty: { absoluteErrorBound: 0.5, unit: 'Cel' }, faults: [] });
    example.runtime.flush();
    example.runtime.flush();
    example.receiveFeedback();
    return { kind: 'embedded-simulation', ...example.state() };
  } finally { example.runtime.close(); }
}
