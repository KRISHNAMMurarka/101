import type { EndpointCrypto } from './identity-types.ts';

const ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function hexToBytes(value: string, expectedLength: number): Uint8Array {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > 8192 ||
    typeof value !== 'string' || value.length !== expectedLength * 2 || !/^[0-9a-f]+$/.test(value))
    throw new TypeError('Invalid identity byte encoding');
  return Uint8Array.from({ length: expectedLength }, (_, index) => parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
function scalar(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const value = BigInt(`0x${bytesToHex(bytes)}`);
  return value > 0n && value < ORDER;
}

/** Strict DER X9.62 to WebCrypto's fixed-width P-256 r || s signature. */
export function derToP1363(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array) || input.length < 8 || input.length > 72) throw new TypeError('Invalid ECDSA signature');
  const der = new Uint8Array(input);
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new TypeError('Invalid ECDSA signature');
  let offset = 2;
  const read = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new TypeError('Invalid ECDSA signature');
    const size = der[offset++] ?? 0;
    if (size < 1 || size > 33 || offset + size > der.length) throw new TypeError('Invalid ECDSA signature');
    const value = der.slice(offset, offset + size); offset += size;
    if (value[0]! >= 128 || value.length > 1 && value[0] === 0 && value[1]! < 128 || value.length === 33 && value[0] !== 0)
      throw new TypeError('Invalid ECDSA signature');
    const positive = value[0] === 0 ? value.slice(1) : value;
    const fixed = new Uint8Array(32); fixed.set(positive, 32 - positive.length);
    if (!scalar(fixed)) throw new TypeError('Invalid ECDSA signature');
    return fixed;
  };
  const r = read(), s = read();
  if (offset !== der.length) throw new TypeError('Invalid ECDSA signature');
  return Uint8Array.from([...r, ...s]);
}

export function p1363ToDer(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array) || input.length !== 64) throw new TypeError('Invalid ECDSA signature');
  const fixed = new Uint8Array(input);
  const integer = (value: Uint8Array): number[] => {
    if (!scalar(value)) throw new TypeError('Invalid ECDSA signature');
    let start = 0; while (value[start] === 0) start++;
    const bytes = Array.from(value.slice(start));
    if (bytes[0]! >= 128) bytes.unshift(0);
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...integer(fixed.slice(0, 32)), ...integer(fixed.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** The identifier names this key, not a person, account, device label or grant. */
export async function endpointKeyId(publicKey: Uint8Array, crypto: Pick<EndpointCrypto, 'sha256'>): Promise<string> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 65 || publicKey[0] !== 4) throw new TypeError('Invalid P-256 public key');
  const prefix = new TextEncoder().encode('101.endpoint-key/1\0');
  const message = new Uint8Array(prefix.length + publicKey.length);
  message.set(prefix); message.set(publicKey, prefix.length);
  const digest = await crypto.sha256(message);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new TypeError('Invalid identity digest');
  return bytesToHex(digest);
}
