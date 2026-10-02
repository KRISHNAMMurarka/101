import { snapshotJson } from '@101/device-model';
import { bytesToHex } from './identity-format.ts';

export interface ReceiverInvitation {
  readonly protocol: 'connect-invite'; readonly version: 1; readonly epoch: string;
  readonly applicationId: string; readonly sessionId: string; readonly expiresAt: number;
}
const LIFETIME = 300000;
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value &&
    !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; });
}
function parse(input: unknown): ReceiverInvitation {
  const value = snapshotJson(input);
  const keys = ['protocol', 'version', 'epoch', 'applicationId', 'sessionId', 'expiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key)) || value.protocol !== 'connect-invite' || value.version !== 1 ||
    typeof value.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(value.epoch) || !id(value.applicationId) || !id(value.sessionId) ||
    !timestamp(value.expiresAt)) throw new TypeError('Use a complete current receiver invitation');
  return Object.freeze({ protocol: 'connect-invite', version: 1, epoch: value.epoch,
    applicationId: value.applicationId, sessionId: value.sessionId, expiresAt: value.expiresAt });
}
/** Receiver-owned data; parsing/possession never supplies consent or endpoint identity. */
export function createReceiverInvitation(options: {
  applicationId: string; sessionId: string; now: number; randomBytes: (length: number) => Uint8Array;
}): ReceiverInvitation {
  if (!timestamp(options.now) || options.now > Number.MAX_SAFE_INTEGER - LIFETIME || typeof options.randomBytes !== 'function')
    throw new TypeError('Receiver invitation clock or entropy unavailable');
  const bytes = options.randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new TypeError('Receiver invitation entropy unavailable');
  return parse({ protocol: 'connect-invite', version: 1, epoch: bytesToHex(new Uint8Array(bytes)),
    applicationId: options.applicationId, sessionId: options.sessionId, expiresAt: options.now + LIFETIME });
}
export function receiverInvitationCurrent(invitation: ReceiverInvitation, now: number): boolean {
  try { const value = parse(invitation); return timestamp(now) && now < value.expiresAt && value.expiresAt - now <= LIFETIME; }
  catch { return false; }
}
export function encodeReceiverInvitation(invitation: ReceiverInvitation): string {
  return JSON.stringify(parse(invitation));
}
/** Review the returned target locally before choosing it as expected application/session. */
export function decodeReceiverInvitation(code: string, now: number): ReceiverInvitation {
  try {
    if (typeof code !== 'string' || code.length > 2048 || new TextEncoder().encode(code).length > 2048) throw new Error();
    const value = parse(JSON.parse(code));
    if (!receiverInvitationCurrent(value, now)) throw new Error();
    return value;
  } catch { throw new TypeError('Use a complete invitation created within the last five minutes; check both device clocks'); }
}
