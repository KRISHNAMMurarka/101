import { snapshotJson } from '@101/device-model';

export interface ManualPeerCode {
  readonly protocol: 'connect-manual'; readonly version: 1; readonly epoch: string;
  readonly description: Readonly<{ type: 'offer' | 'answer'; sdp: string }>;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Local diagnostic hand transfer. Possession of a code does not authenticate an endpoint. */
export function decodeManualPeerCode(code: string, expectedType: 'offer' | 'answer', expectedEpoch?: string): ManualPeerCode {
  try {
    if (typeof code !== 'string' || code.length > 65536 || new TextEncoder().encode(code).length > 65536) throw new Error();
    const packet = snapshotJson(JSON.parse(code));
    if (!object(packet) || !exact(packet, ['protocol', 'version', 'epoch', 'description']) ||
      packet.protocol !== 'connect-manual' || packet.version !== 1 || typeof packet.epoch !== 'string' ||
      !/^[0-9a-f]{32}$/.test(packet.epoch) || expectedEpoch !== undefined && packet.epoch !== expectedEpoch ||
      !object(packet.description) || !exact(packet.description, ['type', 'sdp']) ||
      packet.description.type !== expectedType || typeof packet.description.sdp !== 'string' || !packet.description.sdp) throw new Error();
    return Object.freeze({ protocol: 'connect-manual', version: 1, epoch: packet.epoch,
      description: Object.freeze({ type: expectedType, sdp: packet.description.sdp }) });
  } catch { throw new TypeError(`Use a complete local ${expectedType} code for this connection`); }
}
export function encodeManualPeerCode(epoch: string, description: RTCSessionDescriptionInit): string {
  if (description.type !== 'offer' && description.type !== 'answer') throw new TypeError('Use a complete local offer or answer');
  const packet = snapshotJson({ protocol: 'connect-manual', version: 1, epoch, description: { type: description.type, sdp: description.sdp } });
  const code = JSON.stringify(packet);
  decodeManualPeerCode(code, description.type);
  return code;
}
