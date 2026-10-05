import { createTelemetryHistory, parseSignalValue } from '@101/connect';
import type { TelemetryCaptureHandle, TelemetryHistoryOptions, TelemetryQuality, ValueSchema } from '@101/connect';

export const MEMORY_HISTORY_SCHEMA: ValueSchema = { type: 'record', fields: {
  residentBytes: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
} };
const MEMORY_BATCH_V2: ValueSchema = { type: 'array', minItems: 1, maxItems: 16,
  items: { type: 'record', fields: {
    timestamp: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER },
    residentBytes: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
    quality: { type: 'enum', values: ['observed', 'unverified'] },
  }, optional: ['quality'] } };

/**
 * A caller can supply process.memoryUsage().rss in real telemetry-batch v2 readings.
 * Each nested reading keeps its producer clock/time and quality. The SDK publication's
 * outer clock remains a separate live-route concern. Construction grants no capture.
 */
export function createMemoryTelemetryHistory(options: TelemetryHistoryOptions) {
  const history = createTelemetryHistory(options);
  return Object.freeze({
    history,
    requestCapture(consent: { purpose: string; expiresAt: number }) {
      return history.requestCapture({ resourceId: 'process:memory', schemaVersion: 2,
        schema: MEMORY_HISTORY_SCHEMA, fields: ['residentBytes'], provenanceFields: [],
        destinationId: 'local-history', ...consent });
    },
    recordBatch(handle: TelemetryCaptureHandle, input: unknown, sourceClockId: string) {
      const readings = parseSignalValue(input, MEMORY_BATCH_V2) as unknown as readonly {
        timestamp: number; residentBytes: number; quality?: TelemetryQuality;
      }[];
      let admitted = 0, dropped = 0;
      for (const reading of readings) {
        const result = history.enqueue(handle, { sourceTime: { clockId: sourceClockId, at: reading.timestamp },
          quality: reading.quality ?? 'unverified', values: { residentBytes: reading.residentBytes } });
        if (result.ok) admitted++; else dropped++;
      }
      return Object.freeze({ admitted, dropped });
    },
  });
}
