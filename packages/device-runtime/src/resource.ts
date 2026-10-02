import { MAX_RESOURCE_BYTES, MAX_RESOURCE_CHUNK_BYTES, parseAssetReference, snapshotResourceBytes, verifyAssetContent } from '@101/device-model';
import type { AssetReference } from '@101/device-model';

export interface ResourceChunk { readonly index: number; readonly offset: number; readonly bytes: Uint8Array }
export interface ResourceReadScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface ResourceReadRequest extends ResourceReadScope { readonly reference: Readonly<AssetReference> }
export interface ResourceReadGrant { readonly expiresAt: number; readonly maxBytes: number }
export interface ReadVerifiedResourceOptions extends ResourceReadScope {
  readonly reference: unknown;
  readonly chunks: AsyncIterable<ResourceChunk>;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly authorize: (request: Readonly<ResourceReadRequest>) => ResourceReadGrant | undefined | Promise<ResourceReadGrant | undefined>;
}

export class ResourceTransferError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ResourceTransferError'; this.code = code; }
}
const MAX_RESOURCE_CHUNKS = 512;
function fail(code: string): never { throw new ResourceTransferError(code); }
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127; });
}
function clock(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) fail('invalid-clock');
  return value;
}
/** Snapshot caller bytes immediately; each yielded chunk is an independent copy. */
export function chunkResource(input: Uint8Array, chunkSize = MAX_RESOURCE_CHUNK_BYTES): AsyncIterable<ResourceChunk> {
  const bytes = snapshotResourceBytes(input);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_RESOURCE_CHUNK_BYTES) fail('chunk-size');
  if (Math.ceil(bytes.byteLength / chunkSize) > MAX_RESOURCE_CHUNKS) fail('chunk-count');
  return (async function* () {
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkSize, index++) {
      yield Object.freeze({ index, offset, bytes: bytes.slice(offset, offset + chunkSize) });
    }
  })();
}

function chunk(input: unknown): ResourceChunk {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid-chunk');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid-chunk');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['index', 'offset', 'bytes'].includes(key))) fail('invalid-chunk');
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) fail('invalid-chunk');
    values[key as string] = property.value;
  }
  const { index, offset } = values;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
      typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) fail('invalid-chunk');
  const bytes = snapshotResourceBytes(values.bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RESOURCE_CHUNK_BYTES) fail('chunk-size');
  return { index, offset, bytes };
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ResourceTransferError(String(signal.reason ?? 'aborted')));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new ResourceTransferError(String(signal.reason ?? 'aborted'))); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** One authorized, bounded local resource read. No partial bytes leave this function. */
export async function readVerifiedResource(options: ReadVerifiedResourceOptions): Promise<Uint8Array> {
  const reference = parseAssetReference(options.reference);
  if (![options.principalId, options.applicationId, options.sessionId].every(identifier) ||
      typeof options.now !== 'function' || typeof options.authorize !== 'function' ||
      !options.signal || typeof options.signal.addEventListener !== 'function' ||
      !options.chunks || typeof options.chunks[Symbol.asyncIterator] !== 'function') fail('invalid-request');
  const start = clock(options.now);
  if (options.signal.aborted) fail('aborted');
  const request = Object.freeze({ principalId: options.principalId, applicationId: options.applicationId,
    sessionId: options.sessionId, reference });
  const grant = await raceAbort(Promise.resolve().then(() => options.authorize(request)), options.signal);
  if (!grant || Object.getPrototypeOf(grant) !== Object.prototype ||
      Reflect.ownKeys(grant).length !== 2 || !Object.hasOwn(grant, 'expiresAt') || !Object.hasOwn(grant, 'maxBytes')) fail('denied');
  const expiry = Object.getOwnPropertyDescriptor(grant, 'expiresAt');
  const ceiling = Object.getOwnPropertyDescriptor(grant, 'maxBytes');
  if (!expiry || !ceiling || !Object.hasOwn(expiry, 'value') || !Object.hasOwn(ceiling, 'value') ||
      typeof expiry.value !== 'number' || !Number.isFinite(expiry.value) || expiry.value <= start || expiry.value - start > 60000 ||
      typeof ceiling.value !== 'number' || !Number.isSafeInteger(ceiling.value) || ceiling.value < reference.byteLength ||
      ceiling.value > MAX_RESOURCE_BYTES) fail('denied');
  if (options.signal.aborted) fail('aborted');
  const grantedAt = clock(options.now);
  if (grantedAt < start || grantedAt >= expiry.value) fail('expired');
  const timeout = new AbortController();
  const abort = () => timeout.abort('aborted');
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = setTimeout(() => timeout.abort('expired'), expiry.value - grantedAt);
  const output = new Uint8Array(reference.byteLength);
  let iterator: AsyncIterator<ResourceChunk> | undefined;
  let success = false;
  try {
    iterator = options.chunks[Symbol.asyncIterator]();
    let offset = 0, index = 0, previousTime = grantedAt;
    const readTime = () => {
      const current = clock(options.now);
      if (current < previousTime) fail('invalid-clock');
      previousTime = current;
      return current;
    };
    while (true) {
      const now = readTime();
      if (now >= expiry.value) fail('expired');
      const next = await raceAbort(Promise.resolve().then(() => iterator!.next()), timeout.signal);
      if (timeout.signal.aborted) fail(String(timeout.signal.reason ?? 'aborted'));
      if (next.done) break;
      const received = chunk(next.value);
      if (index >= MAX_RESOURCE_CHUNKS || received.index !== index || received.offset !== offset || offset + received.bytes.byteLength > output.byteLength)
        fail('chunk-order');
      output.set(received.bytes, offset);
      offset += received.bytes.byteLength; index++;
    }
    if (offset !== reference.byteLength) fail('truncated');
    if (readTime() >= expiry.value || timeout.signal.aborted) fail('expired');
    if (!await verifyAssetContent(reference, output)) fail('integrity');
    if (readTime() >= expiry.value || timeout.signal.aborted) fail('expired');
    success = true;
    return snapshotResourceBytes(output);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    if (!success && iterator?.return) void Promise.resolve().then(() => iterator!.return!()).catch(() => {});
    output.fill(0);
  }
}
