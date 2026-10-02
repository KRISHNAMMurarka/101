import { DeviceValidationError, snapshotJson } from './descriptor.ts';

export type AssetKind = 'blob' | 'text' | 'json-document';
export interface AssetReference {
  readonly id: string;
  readonly kind: AssetKind;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_RESOURCE_CHUNK_BYTES = 16 * 1024;
const DOCUMENT_BYTES = 64 * 1024;
const MEDIA_TYPE: Readonly<Record<AssetKind, string>> = Object.freeze({
  blob: 'application/octet-stream',
  text: 'text/plain;charset=utf-8',
  'json-document': 'application/json',
});
const ASSET_ID = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(code: string): never { throw new DeviceValidationError(code); }

const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;

/** Copy intrinsic typed-array storage without invoking an overridable iterator. */
export function snapshotResourceBytes(input: unknown): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array)) fail('resource-bytes');
  const length = typedArrayByteLength.call(input) as number;
  if (length > MAX_RESOURCE_BYTES) fail('resource-size');
  const copied = new Uint8Array(length);
  Uint8Array.prototype.set.call(copied, input);
  return copied;
}

/** Content validation is intentionally narrower than general MIME sniffing. */
function validateContent(kind: AssetKind, bytes: Uint8Array): void {
  if (kind === 'blob') return;
  if (bytes.byteLength > DOCUMENT_BYTES) fail('document-size');
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('resource-utf8'); }
  if (kind === 'json-document') {
    let document: unknown;
    try { document = JSON.parse(decoded); } catch { fail('resource-json'); }
    if (document === null || typeof document !== 'object') fail('resource-json');
    snapshotJson(document);
  }
}

export function parseAssetReference(input: unknown): Readonly<AssetReference> {
  const copied = snapshotJson(input);
  if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) fail('resource-reference');
  const keys = Object.keys(copied);
  if (keys.length !== 5 || keys.some(key => !['id', 'kind', 'mediaType', 'byteLength', 'sha256'].includes(key))) fail('resource-fields');
  const { id, kind, mediaType, byteLength, sha256 } = copied;
  if (typeof id !== 'string' || id.length > 128 || !ASSET_ID.test(id)) fail('resource-id');
  if (kind !== 'blob' && kind !== 'text' && kind !== 'json-document') fail('resource-kind');
  if (mediaType !== MEDIA_TYPE[kind]) fail('resource-media-type');
  const maxBytes = kind === 'blob' ? MAX_RESOURCE_BYTES : DOCUMENT_BYTES;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes ||
      kind === 'json-document' && byteLength === 0) fail('resource-size');
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) fail('resource-digest');
  return Object.freeze({ id, kind, mediaType, byteLength, sha256 });
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hashed = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createAssetReference(id: string, kind: AssetKind, input: Uint8Array): Promise<Readonly<AssetReference>> {
  if (kind !== 'blob' && kind !== 'text' && kind !== 'json-document') fail('resource-kind');
  const bytes = snapshotResourceBytes(input);
  validateContent(kind, bytes);
  return parseAssetReference({ id, kind, mediaType: MEDIA_TYPE[kind], byteLength: bytes.byteLength, sha256: await digest(bytes) });
}

/** Returns false for changed or mismatched content; malformed references still throw. */
export async function verifyAssetContent(input: unknown, source: Uint8Array): Promise<boolean> {
  const reference = parseAssetReference(input);
  const bytes = snapshotResourceBytes(source);
  if (bytes.byteLength !== reference.byteLength) return false;
  try { validateContent(reference.kind, bytes); } catch { return false; }
  return (await digest(bytes)) === reference.sha256;
}
