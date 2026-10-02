import { createDeviceRuntime, createUnitConverter, DeviceValidationError, parseDeviceDescriptor, parseSignalValue } from '@101/connect';
import type { Authorize, DeviceDescriptor, JsonObject, ValueSchema } from '@101/connect';

export interface TelemetryReading { readonly timestamp: number; readonly residentBytes: number; readonly quality?: 'observed' | 'unverified' }
type Version = 1 | 2;
const RESIDENT_BYTES: ValueSchema = { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER };
const RESIDENT_KIBY: ValueSchema = { type: 'scalar', unit: 'KiBy', min: 0, max: 1000000000 };
const kibyConverter = createUnitConverter(RESIDENT_KIBY, RESIDENT_BYTES, { decimalPlaces: 0, maxAbsoluteError: 0.51 });

function batchSchema(version: Version): ValueSchema {
  if (version !== 1 && version !== 2) throw new TypeError('Unsupported telemetry batch version');
  return { type: 'array', minItems: 1, maxItems: 16, items: { type: 'record', fields: {
    timestamp: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER },
    residentBytes: RESIDENT_BYTES,
    ...(version === 2 ? { quality: { type: 'enum' as const, values: ['observed', 'unverified'] } } : {}),
  }, ...(version === 2 ? { optional: ['quality'] } : {}) } };
}

const kibyBatchSchema: ValueSchema = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'record', fields: {
  timestamp: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER },
  residentKiBy: RESIDENT_KIBY,
  quality: { type: 'enum', values: ['observed', 'unverified'] },
}, optional: ['quality'] } };

export function telemetryBatchDescriptor(version: Version = 2, sink = false): Readonly<DeviceDescriptor> {
  return parseDeviceDescriptor({ schemaVersion: 1, id: sink ? 'telemetry-batch-consumer' : 'telemetry-batch-source',
    label: sink ? 'Process memory summary' : 'Process memory readings', revision: version,
    adapter: { id: 'example:process-memory-batch', version: String(version) }, runtime: { platform: 'embedded-application' },
    capabilities: [{ id: 'readings', semantic: 'example:resident-memory-batch', schemaVersion: version,
      kind: sink ? 'property' : 'sample', value: batchSchema(version), delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
      permissions: sink ? ['write'] : ['subscribe'], ...(sink ? { ownership: { mode: 'observe' } } : {}) }] });
}

function readings(input: unknown, version: Version): readonly TelemetryReading[] {
  // These asserted member types follow the exact recursively validated schema.
  return parseSignalValue(input, batchSchema(version)) as unknown as readonly TelemetryReading[];
}

/** Explicit migration of validated v1; absence of quality does not imply observation. */
export function upgradeTelemetryBatchV1(input: unknown): readonly TelemetryReading[] {
  return readings(readings(input, 1).map(value => ({ ...value, quality: 'unverified' })), 2);
}

/** One embedded clock domain; nested timestamps are not automatically translated. */
export function createTelemetryBatchPipeline(options: { version?: Version; sinkVersion?: Version; now?: () => number; authorize?: Authorize } = {}) {
  const version = options.version ?? 2, now = options.now ?? (() => 0);
  const sourceDevice = telemetryBatchDescriptor(version), sinkDevice = telemetryBatchDescriptor(options.sinkVersion ?? version, true);
  let latest: readonly TelemetryReading[] = Object.freeze([]), provenance: JsonObject | undefined, released = 0;
  const scope = { principalId: 'telemetry-owner', applicationId: 'telemetry-batch-example', sessionId: 'embedded-telemetry' };
  const runtime = createDeviceRuntime({ now, clockDomain: 'embedded-telemetry-clock', authorize(request) {
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.source.registrationId !== source.id || request.sink.registrationId !== sink.id ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    return options.authorize ? options.authorize(request) : { expiresAt: now() + 10000, maxAgeMs: 1000, maxHz: 10 };
  } });
  const source = runtime.registerSource({ device: sourceDevice, capability: 'readings' });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'readings', apply(observation, context) {
    if (context.isCurrent() && !context.signal.aborted) {
      latest = readings(observation.value, options.sinkVersion ?? version);
      provenance = observation.provenance;
    }
  }, release() { latest = Object.freeze([]); provenance = undefined; released++; } });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const connection = runtime.route({ from: source, to: sink, ...scope }), start = connection.start();
  function publishBatch(batch: readonly TelemetryReading[], publicationProvenance?: JsonObject) {
    const current = now();
    const last = batch.at(-1);
    if (!last) throw new DeviceValidationError('batch-timestamp');
    if (!Number.isFinite(current) || batch.some((value, index) => {
      const previous = batch[index - 1];
      return value.timestamp > current || current - value.timestamp > 1000 ||
        index > 0 && (!previous || value.timestamp < previous.timestamp);
    })) throw new DeviceValidationError('batch-timestamp');
    return runtime.publish(source, batch, { timestamp: last.timestamp, clockDomain: runtime.clockDomain,
      ...(publicationProvenance ? { provenance: publicationProvenance } : {}) });
  }
  return { runtime, source, sink, sourceDevice, sinkDevice, connection, start,
    publish(input: unknown) { return publishBatch(readings(input, version)); },
    publishResidentKiBy(input: unknown) {
      if (version !== 2) throw new DeviceValidationError('conversion-version');
      const values = parseSignalValue(input, kibyBatchSchema) as unknown as readonly
        { timestamp: number; residentKiBy: number; quality?: 'observed' | 'unverified' }[];
      const batch = readings(values.map(({ timestamp, residentKiBy, quality }) => ({ timestamp,
        residentBytes: kibyConverter.convert(residentKiBy) as number,
        ...(quality === undefined ? {} : { quality }),
      })), 2);
      return publishBatch(batch, { conversion: { ...kibyConverter.metadata } });
    },
    state() {
      const last = latest[latest.length - 1];
      return Object.freeze({ count: latest.length, residentBytes: last?.residentBytes, quality: last?.quality, provenance, released });
    } };
}

/** Portable deterministic fixture; the Node consumer supplies actual memory readings. */
export function runTelemetryBatchExample() {
  const pipeline = createTelemetryBatchPipeline({ now: () => 1000 });
  try {
    const publication = pipeline.publish(upgradeTelemetryBatchV1([{ timestamp: 990, residentBytes: 65536 }, { timestamp: 1000, residentBytes: 69632 }]));
    pipeline.runtime.flush();
    return { kind: 'embedded-fixture', publication: publication.ok, ...pipeline.state() };
  } finally { pipeline.runtime.close(); }
}
