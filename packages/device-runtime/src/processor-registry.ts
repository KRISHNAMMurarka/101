import { DeviceValidationError, parseProcessorManifest, parseSignalValue, snapshotJson, snapshotResourceBytes } from '@101/device-model';
import type { ProcessorManifest, ProcessorPort, SignalValue } from '@101/device-model';

export type ProcessorFrame = Readonly<Record<string, SignalValue>>;
export interface ProcessorImplementation {
  process(inputs: ProcessorFrame): unknown;
  reset(): void;
}
export interface TrustedProcessorRegistration {
  readonly manifest: unknown;
  /** Bytes of the reviewed code artifact. The host must bind its factory to this artifact. */
  readonly source: Uint8Array;
  readonly factory: (configuration: SignalValue) => ProcessorImplementation;
}
export interface ProcessorRequest {
  readonly id: string;
  readonly version: string;
  readonly codeSha256: string;
  readonly configuration: unknown;
}
export interface ResolvedProcessor {
  readonly manifest: Readonly<ProcessorManifest>;
  process(inputs: unknown): ProcessorFrame | undefined;
  reset(): void;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function frame(input: unknown, ports: readonly ProcessorPort[], path: string): ProcessorFrame {
  const copied = snapshotJson(input);
  if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) fail('processor-frame', path);
  const fields = copied as Record<string, unknown>;
  if (Object.keys(fields).sort().join('\0') !== ports.map((port) => port.id).sort().join('\0')) {
    fail('processor-frame-ports', path);
  }
  const values: Record<string, SignalValue> = {};
  for (const port of ports) values[port.id] = parseSignalValue(fields[port.id], port.value);
  return Object.freeze(values);
}
function key(manifest: Pick<ProcessorManifest, 'id' | 'version' | 'codeSha256'>): string {
  return `${manifest.id}\0${manifest.version}\0${manifest.codeSha256}`;
}

/** Host-populated registry: remote manifests never register or execute code. */
export function createProcessorRegistry() {
  const trusted = new Map<string, { manifest: Readonly<ProcessorManifest>; factory: TrustedProcessorRegistration['factory'] }>();
  return Object.freeze({
    async registerTrusted(registration: TrustedProcessorRegistration): Promise<void> {
      const manifest = parseProcessorManifest(registration.manifest);
      if (typeof registration.factory !== 'function') fail('processor-factory', '$.factory');
      const source = snapshotResourceBytes(registration.source);
      const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== manifest.codeSha256) fail('processor-code-pin', '$.codeSha256');
      const identity = key(manifest);
      if (trusted.has(identity)) fail('processor-duplicate', '$.id');
      trusted.set(identity, { manifest, factory: registration.factory });
    },
    resolve(request: ProcessorRequest): ResolvedProcessor {
      const copied = snapshotJson(request);
      if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) fail('processor-request', '$');
      const fields = copied as Record<string, unknown>;
      if (Object.keys(fields).sort().join('\0') !== 'codeSha256\0configuration\0id\0version' ||
          typeof fields.id !== 'string' || typeof fields.version !== 'string' || typeof fields.codeSha256 !== 'string') {
        fail('processor-request', '$');
      }
      const entry = trusted.get(key({ id: fields.id, version: fields.version, codeSha256: fields.codeSha256 }));
      if (!entry) fail('processor-untrusted', '$.id');
      const configuration = parseSignalValue(fields.configuration, entry.manifest.configuration);
      const implementation = entry.factory(configuration);
      if (!implementation || typeof implementation.process !== 'function' || typeof implementation.reset !== 'function') {
        fail('processor-implementation', '$.factory');
      }
      return Object.freeze({
        manifest: entry.manifest,
        process(inputs: unknown): ProcessorFrame | undefined {
          const admitted = frame(inputs, entry.manifest.inputs, '$.inputs');
          const result = implementation.process(admitted);
          return result === undefined ? undefined : frame(result, entry.manifest.outputs, '$.outputs');
        },
        reset(): void { implementation.reset(); },
      });
    },
  });
}
