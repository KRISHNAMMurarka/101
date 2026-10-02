import { parseDeviceDescriptor, snapshotJson } from '@101/device-model';
import type { DeviceDescriptor, SignalValue } from '@101/device-model';

export type WireCodec = 'json/1' | 'json/2' | 'normalized-pointer/1';
type Envelope = { protocol: 'connect'; epoch: string };
export type WireControl = Envelope & { version: 1 } & (
  | { type: 'describe'; clockId: string; device: Readonly<DeviceDescriptor>; codecs: readonly WireCodec[] }
  | { type: 'bind'; slot: number; capability: string; descriptorRevision: number; schemaVersion: number; codec: WireCodec; maxHz: number; maxAgeMs: number }
  | { type: 'ready'; slot: number; maxHz: number; maxAgeMs: number }
  | { type: 'stop'; slot: number; reason: 'stopped' | 'unavailable' | 'expired' | 'overload' | 'incompatible' }
  | { type: 'clock'; id: number; sentAt: number; remoteReceivedAt?: number; remoteSentAt?: number }
);
export type WireValue = Envelope & { version: 1 | 2; slot: number; sequence: number; capturedAt: number; value: SignalValue } & (
  | { type: 'sample'; operationId?: never; deadline?: never }
  | { type: 'event'; operationId: string; deadline: number }
);
export type WirePacket = WireControl | WireValue;

const MAX_ENVELOPE_BYTES = 66 * 1024;
const MAX_PACKET_BYTES = 4 * 1024;
const UINT32_MAX = 4294967295;
const EPOCH = /^[0-9a-f]{32}$/;
const ENVELOPE_KEYS = ['protocol', 'version', 'type', 'epoch'];
const STOP_REASONS = ['stopped', 'unavailable', 'expired', 'overload', 'incompatible'];
const textEncoder = new TextEncoder();

function invalid(): never { throw new TypeError('Invalid connect/1 packet'); }

/** Inspect only bounded own data fields; serialization never touches caller accessors. */
function fields(input: unknown, maxEntries = 12): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length > maxEntries) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') invalid();
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
    result[key] = property.value;
  }
  return result;
}

function closed(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!Object.hasOwn(input, key)) invalid();
  for (const key of Object.keys(input)) if (!required.includes(key) && !optional.includes(key)) invalid();
}

function uint(input: unknown, max = UINT32_MAX): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > max) invalid();
  return input;
}

function finite(input: unknown, min = 0, max = Number.MAX_VALUE): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) invalid();
  return input;
}

function text(input: unknown, max = 128): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > max * 2 || Array.from(input).length > max || Array.from(input).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return input;
}

function codec(input: unknown): WireCodec {
  if (input !== 'json/1' && input !== 'json/2' && input !== 'normalized-pointer/1') invalid();
  return input;
}

function codecs(input: unknown): readonly WireCodec[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value as number;
  if (length < 1 || length > 3) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1 || keys.some((key) => key !== 'length' && !Array.from({ length }, (_, index) => String(index)).includes(key as string))) invalid();
  const result: WireCodec[] = [];
  for (let index = 0; index < length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
    result.push(codec(property.value));
  }
  if (!result.includes('json/1') || new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}

function signal(input: unknown, structured = false): SignalValue {
  if (structured) {
    const copied = snapshotJson(input);
    function validate(value: typeof copied): void {
      if (value === null) invalid();
      if (typeof value === 'object') for (const child of Object.values(value)) validate(child);
    }
    validate(copied);
    return copied as SignalValue;
  }
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) invalid();
    return input;
  }
  if (typeof input === 'string') {
    if (input.length > MAX_PACKET_BYTES) invalid();
    return input;
  }
  const value = fields(input, 3);
  closed(value, ['x', 'y'], ['z']);
  const coordinate = (input: unknown) => {
    if (typeof input !== 'number' || !Number.isFinite(input)) invalid();
    return input;
  };
  return Object.freeze({ x: coordinate(value.x), y: coordinate(value.y), ...(Object.hasOwn(value, 'z') ? { z: coordinate(value.z) } : {}) });
}

function parsePacket(input: unknown): WirePacket {
  const packet = fields(input);
  if (packet.protocol !== 'connect' || (packet.version !== 1 && packet.version !== 2) || typeof packet.epoch !== 'string' || !EPOCH.test(packet.epoch) ||
    packet.version === 2 && packet.type !== 'sample' && packet.type !== 'event') invalid();
  const envelope = { protocol: 'connect' as const, version: 1 as const, epoch: packet.epoch };
  const shape = (required: readonly string[], optional: readonly string[] = []) => closed(packet, [...ENVELOPE_KEYS, ...required], optional);
  const limits = () => ({ maxHz: finite(packet.maxHz, 1, 1000), maxAgeMs: finite(packet.maxAgeMs, 1, 60000) });
  switch (packet.type) {
    case 'describe': {
      shape(['clockId', 'device', 'codecs']);
      const clockId = text(packet.clockId);
      const supported = codecs(packet.codecs);
      // This parser owns its independent 64 KiB, depth and capability limits.
      if (packet.device === null || typeof packet.device !== 'object' || Array.isArray(packet.device)) invalid();
      const device = parseDeviceDescriptor(packet.device);
      return Object.freeze({ ...envelope, type: 'describe', clockId, device, codecs: supported });
    }
    case 'bind':
      shape(['slot', 'capability', 'descriptorRevision', 'schemaVersion', 'codec', 'maxHz', 'maxAgeMs']);
      return Object.freeze({ ...envelope, type: 'bind', slot: uint(packet.slot, 128), capability: text(packet.capability), descriptorRevision: uint(packet.descriptorRevision), schemaVersion: uint(packet.schemaVersion), codec: codec(packet.codec), ...limits() });
    case 'ready':
      shape(['slot', 'maxHz', 'maxAgeMs']);
      return Object.freeze({ ...envelope, type: 'ready', slot: uint(packet.slot, 128), ...limits() });
    case 'stop':
      shape(['slot', 'reason']);
      if (typeof packet.reason !== 'string' || !STOP_REASONS.includes(packet.reason)) invalid();
      return Object.freeze({ ...envelope, type: 'stop', slot: uint(packet.slot, 128), reason: packet.reason as Extract<WireControl, { type: 'stop' }>['reason'] });
    case 'clock': {
      shape(['id', 'sentAt'], ['remoteReceivedAt', 'remoteSentAt']);
      const response = Object.hasOwn(packet, 'remoteReceivedAt');
      if (response !== Object.hasOwn(packet, 'remoteSentAt')) invalid();
      return Object.freeze({ ...envelope, type: 'clock', id: uint(packet.id), sentAt: finite(packet.sentAt), ...(response ? { remoteReceivedAt: finite(packet.remoteReceivedAt), remoteSentAt: finite(packet.remoteSentAt) } : {}) });
    }
    case 'sample':
    case 'event': {
      const event = packet.type === 'event';
      shape(['slot', 'sequence', 'capturedAt', 'value', ...(event ? ['operationId', 'deadline'] : [])]);
      const value = { ...envelope, version: packet.version as 1 | 2, slot: uint(packet.slot, 128), sequence: uint(packet.sequence), capturedAt: finite(packet.capturedAt), value: signal(packet.value, packet.version === 2) };
      if (!event) return Object.freeze({ ...value, type: 'sample' });
      const operationId = packet.operationId;
      if (typeof operationId !== 'string' || operationId.length > 16 || !/^[1-9][0-9]*$/.test(operationId) || !Number.isSafeInteger(Number(operationId))) invalid();
      const deadline = finite(packet.deadline);
      if (deadline <= value.capturedAt) invalid();
      return Object.freeze({ ...value, type: 'event', operationId, deadline });
    }
    default: return invalid();
  }
}

function withinBytes(input: string, max: number): boolean {
  return input.length <= max && textEncoder.encode(input).byteLength <= max;
}

function compactValue(packet: WirePacket): { x: number; y: number } {
  if (packet.type !== 'sample' || packet.version !== 1) invalid();
  const value = fields(packet.value, 2);
  closed(value, ['x', 'y']);
  return { x: finite(value.x, 0, 1), y: finite(value.y, 0, 1) };
}

function encodeCompact(packet: WirePacket): ArrayBuffer {
  const value = compactValue(packet);
  if (packet.type !== 'sample') invalid();
  const buffer = new ArrayBuffer(48);
  const view = new DataView(buffer);
  view.setUint16(0, 0x434e);
  view.setUint8(2, 1);
  view.setUint8(3, 1);
  for (let index = 0; index < 16; index += 1) view.setUint8(4 + index, parseInt(packet.epoch.slice(index * 2, index * 2 + 2), 16));
  view.setUint16(20, packet.slot);
  view.setUint32(24, packet.sequence);
  view.setFloat64(28, packet.capturedAt);
  view.setFloat32(36, value.x);
  view.setFloat32(40, value.y);
  return buffer;
}

function decodeCompact(data: ArrayBuffer): WireValue {
  if (data.byteLength !== 48) invalid();
  const view = new DataView(data);
  if (view.getUint16(0) !== 0x434e || view.getUint8(2) !== 1 || view.getUint8(3) !== 1 || view.getUint16(22) !== 0 || view.getUint32(44) !== 0) invalid();
  let epoch = '';
  for (let index = 0; index < 16; index += 1) epoch += view.getUint8(4 + index).toString(16).padStart(2, '0');
  return Object.freeze({ protocol: 'connect', version: 1, type: 'sample', epoch, slot: uint(view.getUint16(20), 128), sequence: uint(view.getUint32(24)), capturedAt: finite(view.getFloat64(28)), value: Object.freeze({ x: finite(view.getFloat32(36), 0, 1), y: finite(view.getFloat32(40), 0, 1) }) });
}

/** Decode bounded wire data; schema and negotiated-codec authority belong to the receiver. */
export function decodePacket(data: string | ArrayBuffer, lane: 'reliable' | 'disposable'): { packet: WirePacket; codec: WireCodec } | undefined {
  try {
    if (lane !== 'reliable' && lane !== 'disposable') return undefined;
    if (data instanceof ArrayBuffer) return lane === 'disposable' ? { packet: decodeCompact(data), codec: 'normalized-pointer/1' } : undefined;
    if (typeof data !== 'string' || !withinBytes(data, MAX_ENVELOPE_BYTES)) return undefined;
    const packet = parsePacket(JSON.parse(data));
    if (packet.type !== 'describe' && !withinBytes(data, MAX_PACKET_BYTES)) return undefined;
    if ((packet.type === 'sample') !== (lane === 'disposable')) return undefined;
    return { packet, codec: packet.version === 2 ? 'json/2' : 'json/1' };
  } catch { return undefined; }
}

/** Encode only validated inert snapshots; throws rather than coercing malformed input. */
export function encodePacket(packet: unknown, selectedCodec: WireCodec = 'json/1'): string | ArrayBuffer {
  const selected = codec(selectedCodec);
  const input = fields(packet);
  if (selected === 'json/2') {
    if ((input.version !== 1 && input.version !== 2) || input.type !== 'sample' && input.type !== 'event') invalid();
    input.version = 2;
  } else if (input.version !== 1) invalid();
  const parsed = parsePacket(input);
  if (selected === 'normalized-pointer/1') return encodeCompact(parsed);
  const data = JSON.stringify(parsed);
  if (!withinBytes(data, parsed.type === 'describe' ? MAX_ENVELOPE_BYTES : MAX_PACKET_BYTES)) invalid();
  return data;
}
