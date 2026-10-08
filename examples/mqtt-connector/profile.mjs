import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseConnectorProfileManifest } from '@101/connect';

const decoderSource = readFileSync(new URL('./decoder.mjs', import.meta.url));
export const MQTT_EXAMPLE_DECODER_SOURCE = decoderSource;
export const MQTT_EXAMPLE_DECODER_SHA256 = createHash('sha256').update(decoderSource).digest('hex');

export function createMqttExampleProfile() {
  const manifest = parseConnectorProfileManifest({
    schemaVersion: 1, id: 'example:mqtt-telemetry-command', version: '1.0.0',
    decoder: { id: 'example:mqtt-json-frame-decoder', version: '1.0.0', codeSha256: MQTT_EXAMPLE_DECODER_SHA256 },
    identityFilters: [{ field: 'backendId', equals: 'mqtt5' }, { field: 'wireVersion', equals: 1 }, { field: 'clockId', equals: 'mqtt-demo-clock' }],
    framing: { kind: 'jsonl', maxFrameBytes: 4096, maxChunkBytes: 8192, maxFramesPerPush: 1 },
    resources: [
      { capability: { id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
        value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 }, delivery: { mode: 'latest', maxHz: 5, maxAgeMs: 5000 }, permissions: ['subscribe'] },
        direction: 'source', calibration: { revision: 1, unit: 'Cel', maxAbsoluteErrorBound: 1 }, command: null },
      { capability: { id: 'enabled', semantic: 'example:enabled', schemaVersion: 1, kind: 'property',
        value: { type: 'boolean' }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 5000 }, permissions: ['subscribe'] },
        direction: 'source', calibration: null, command: null },
      { capability: { id: 'set-enabled', semantic: 'example:enabled', schemaVersion: 1, kind: 'command',
        value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 5000 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } },
        direction: 'sink', calibration: null, command: { idempotent: true, deadlineMs: 3000,
          feedback: ['dispatched', 'target-acknowledged', 'observed'], observedState: 'enabled', safeState: false } },
    ],
    budgets: { maxBufferedBytes: 4096, maxOutputsPerFrame: 1, maxPendingCommands: 4, maxCommandBytes: 1024, callbackTimeoutMs: 3000 },
    license: 'MIT',
  });
  return manifest;
}

export function createMqttTransportProfile() {
  const manifest = createMqttExampleProfile();
  return Object.freeze({ schemaVersion: 1, id: manifest.id, version: manifest.version,
    decoder: manifest.decoder,
    topics: Object.freeze([
      Object.freeze({ topic: '101/demo/telemetry/temperature', resourceId: 'temperature', direction: 'sample', qos: 0, maxAgeMs: 5000, expirySeconds: 5 }),
      Object.freeze({ topic: '101/demo/state/enabled', resourceId: 'enabled', direction: 'sample', qos: 1, maxAgeMs: 5000, expirySeconds: 5 }),
      Object.freeze({ topic: '101/demo/commands/set-enabled', resourceId: 'set-enabled', direction: 'command', qos: 1, maxAgeMs: 3000, expirySeconds: 3 }),
      Object.freeze({ topic: '101/demo/acks/set-enabled', resourceId: 'set-enabled', direction: 'ack', qos: 1, maxAgeMs: 3000, expirySeconds: 3 }),
    ]), maxPayloadBytes: 2048, maxMessages: 128, maxPendingPublishes: 4 });
}
