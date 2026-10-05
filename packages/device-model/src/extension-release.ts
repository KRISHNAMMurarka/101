import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import { parseProcessorManifest } from './processor-manifest.ts';
import type { ProcessorManifest } from './processor-manifest.ts';
import { parseAssetReference, snapshotResourceBytes, verifyAssetContent } from './resource.ts';
import type { AssetReference } from './resource.ts';

export const PROCESSOR_EXTENSION_PROFILE = 'reviewed-processor-extension/1' as const;
export const PROCESSOR_EXTENSION_LIMITS = Object.freeze({ packages: 4, releasesPerPackage: 2,
  sourceBytes: 256 * 1024, documentBytes: 4 * 1024 * 1024, handles: 8,
  knownVersions: 16, revokedPublishers: 16, approvalMs: 60_000, asyncMs: 1000 });
export interface UnsignedProcessorExtensionRelease {
  readonly schemaVersion: 1;
  readonly profile: typeof PROCESSOR_EXTENSION_PROFILE;
  readonly publisherId: string;
  readonly packageId: string;
  readonly version: string;
  /** Signed monotonic publisher sequence; a rollback requires a separate current owner decision. */
  readonly sequence: number;
  readonly abi: '101:processor/1';
  readonly runtimeVersion: '0.1.0';
  readonly manifest: Readonly<ProcessorManifest>;
  readonly manifestSha256: string;
  readonly source: Readonly<AssetReference>;
  readonly privileges: readonly ['compute-local'];
  readonly dependencies: readonly [];
}
export interface ProcessorExtensionRelease extends UnsignedProcessorExtensionRelease {
  /** Native WebCrypto P-256 ECDSA (IEEE P1363 r || s), lowercase hexadecimal. */
  readonly signature: string;
}
function fail(): never { throw new DeviceValidationError('extension-release'); }
function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input !== null && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort()
    .map(key => [key, canonical((input as Record<string, unknown>)[key])]));
  return input;
}
function bytes(input: unknown): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(JSON.stringify(canonical(input))); }
function unsigned(input: unknown, signed: boolean): UnsignedProcessorExtensionRelease {
  const copied = snapshotJson(input);
  if (!copied || typeof copied !== 'object' || Array.isArray(copied)) fail();
  const keys = ['schemaVersion', 'profile', 'publisherId', 'packageId', 'version', 'sequence', 'abi',
    'runtimeVersion', 'manifest', 'manifestSha256', 'source', 'privileges', 'dependencies', ...(signed ? ['signature'] : [])];
  if (Object.keys(copied).sort().join('\0') !== keys.sort().join('\0')) fail();
  const value = copied as Record<string, unknown>;
  const manifest = parseProcessorManifest(value.manifest), source = parseAssetReference(value.source);
  if (value.schemaVersion !== 1 || value.profile !== PROCESSOR_EXTENSION_PROFILE || value.abi !== '101:processor/1' ||
    value.runtimeVersion !== '0.1.0' || typeof value.publisherId !== 'string' || value.publisherId.length > 128 ||
    !/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.publisherId) ||
    value.packageId !== manifest.id || value.version !== manifest.version ||
    typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    typeof value.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.manifestSha256) ||
    source.kind !== 'blob' || source.byteLength < 1 || source.byteLength > PROCESSOR_EXTENSION_LIMITS.sourceBytes ||
    source.sha256 !== manifest.codeSha256 || manifest.assets.length !== 0 || manifest.budgets.privacy !== 'local-only' ||
    !Array.isArray(value.privileges) || value.privileges.length !== 1 || value.privileges[0] !== 'compute-local' ||
    !Array.isArray(value.dependencies) || value.dependencies.length !== 0) fail();
  return Object.freeze({ schemaVersion: 1, profile: PROCESSOR_EXTENSION_PROFILE, publisherId: value.publisherId,
    packageId: manifest.id, version: manifest.version, sequence: value.sequence, abi: '101:processor/1', runtimeVersion: '0.1.0',
    manifest, manifestSha256: value.manifestSha256, source, privileges: Object.freeze(['compute-local'] as const),
    dependencies: Object.freeze([] as const) });
}
/** Closed, inert data. It cannot import code, select a factory, or grant a capability. */
export function parseProcessorExtensionRelease(input: unknown): Readonly<ProcessorExtensionRelease> {
  const copied = snapshotJson(input), release = unsigned(copied, true);
  const signature = (copied as Record<string, unknown>).signature;
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) fail();
  return Object.freeze({ ...release, signature });
}
/** The only signing format: canonical UTF-8 JSON of the validated unsigned envelope. */
export function processorExtensionSigningBytes(input: unknown): Uint8Array<ArrayBuffer> { return bytes(unsigned(input, false)); }
export async function processorExtensionManifestSha256(input: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes(parseProcessorManifest(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Verify provisioned publisher signature and both real content pins. No executable is loaded. */
export async function verifyProcessorExtensionRelease(input: unknown, inputBytes: Uint8Array, publicKey: CryptoKey): Promise<boolean> {
  const release = parseProcessorExtensionRelease(input), source = snapshotResourceBytes(inputBytes);
  try {
    if (publicKey.type !== 'public' || publicKey.algorithm.name !== 'ECDSA' ||
      (publicKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' || !publicKey.usages.includes('verify') ||
      !await verifyAssetContent(release.source, source) ||
      await processorExtensionManifestSha256(release.manifest) !== release.manifestSha256) return false;
    const { signature, ...payload } = release;
    const signatureBytes = new Uint8Array(signature.match(/../g)!.map(value => Number.parseInt(value, 16)));
    return await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
      signatureBytes, processorExtensionSigningBytes(payload));
  } catch { return false; }
}
