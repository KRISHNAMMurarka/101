import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import { parseProcessorExtensionRelease, processorExtensionSigningBytes, verifyProcessorExtensionRelease } from './extension-release.ts';
import type { ProcessorExtensionRelease } from './extension-release.ts';
import type { ProcessorManifest } from './processor-manifest.ts';
import { snapshotResourceBytes } from './resource.ts';

export const LOCAL_PACKAGE_CATALOG_PROFILE = 'local-reviewed-processor-catalog/1' as const;
export const LOCAL_PACKAGE_CATALOG_LIMITS = Object.freeze({ packages: 4, releasesPerPackage: 2, knownVersions: 16,
  events: 64, reviewers: 16, sourceBytes: 256 * 1024, docsBytes: 16 * 1024, provenanceBytes: 4 * 1024,
  evidenceBytes: 8 * 1024, documentBytes: 4 * 1024 * 1024, approvalMs: 60_000, asyncMs: 1000 });
export interface CatalogConformanceReport {
  readonly schemaVersion: 1; readonly suite: 'processor'; readonly scope: 'trusted-in-process';
  readonly outcome: 'passed' | 'failed';
  readonly checks: readonly Readonly<{ id: string; status: 'passed' | 'failed' | 'not-applicable' }>[];
  readonly limits: Readonly<{ maxFixtureCases: 32; maxCallbacks: 256; maxResources: 128; asyncTimeoutMs: 1000 }>;
  readonly limitations: readonly string[];
}
export interface CatalogDocs { readonly title: string; readonly instructions: string; readonly license: string }
export interface CatalogProvenance {
  readonly builderId: string; readonly builderVersion: string; readonly sourceRevision: string;
  readonly sourceSha256: string; readonly buildSha256: string;
}
export interface UnsignedCatalogSubmission {
  readonly schemaVersion: 1; readonly profile: typeof LOCAL_PACKAGE_CATALOG_PROFILE; readonly ownerId: string;
  readonly release: Readonly<ProcessorExtensionRelease>; readonly docs: Readonly<CatalogDocs>;
  readonly provenance: Readonly<CatalogProvenance>;
  /** Author claims remain untrusted review inputs, including a claimed passing report. */
  readonly authorEvidence: Readonly<{ fixtureSha256: string; reportSha256: string; report: Readonly<CatalogConformanceReport> }>;
}
export interface CatalogSubmission extends UnsignedCatalogSubmission { readonly signature: string }
export type CatalogReviewDecision = 'approved' | 'changes-requested' | 'rejected';
export interface UnsignedCatalogReviewAttestation {
  readonly schemaVersion: 1; readonly profile: typeof LOCAL_PACKAGE_CATALOG_PROFILE; readonly ownerId: string;
  readonly reviewerId: string; readonly packageId: string; readonly version: string;
  readonly sequence: number; readonly reviewedAt: number; readonly decision: CatalogReviewDecision;
  readonly submissionSha256: string; readonly releaseSha256: string; readonly sourceSha256: string;
  readonly docsSha256: string; readonly provenanceSha256: string; readonly fixtureSha256: string;
  readonly reportSha256: string; readonly report: Readonly<CatalogConformanceReport>;
}
export interface CatalogReviewAttestation extends UnsignedCatalogReviewAttestation { readonly signature: string }
const LIMITATIONS = ['Local deterministic fixtures; no physical-device or plugin-isolation certification.',
  'Trusted synchronous code cannot be preempted; memory and uninstrumented resources are not measured.'];
const SUBMISSION = ['schemaVersion', 'profile', 'ownerId', 'release', 'docs', 'provenance', 'authorEvidence'];
const REVIEW = ['schemaVersion', 'profile', 'ownerId', 'reviewerId', 'packageId', 'version', 'sequence', 'reviewedAt',
  'decision', 'submissionSha256', 'releaseSha256', 'sourceSha256', 'docsSha256', 'provenanceSha256',
  'fixtureSha256', 'reportSha256', 'report'];
function fail(): never { throw new DeviceValidationError('package-catalog'); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  return input as Record<string, unknown>;
}
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = object(input), own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== 'string') || own.map(String).sort().join('\0') !== [...keys].sort().join('\0')) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail();
  }
  return value;
}
function text(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || new TextEncoder().encode(input).byteLength > max) fail();
  for (const character of input) {
    const code = character.charCodeAt(0);
    if (code < 32 && ![9, 10, 13].includes(code) || code >= 127 && code <= 159) fail();
  }
  return input;
}
function id(input: unknown): string {
  const value = text(input, 128); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail(); return value;
}
function namespaced(input: unknown): string {
  const value = id(input); if (!/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail(); return value;
}
function hash(input: unknown): string { if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) fail(); return input; }
function signature(input: unknown): string { if (typeof input !== 'string' || !/^[0-9a-f]{128}$/.test(input)) fail(); return input; }
function integer(input: unknown, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) fail(); return input;
}
function bounded<T>(value: T, max: number): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > max) fail(); return value;
}
function canonical(input: unknown): unknown {
  return Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical((input as Record<string, unknown>)[key])])) : input;
}
function bytes(input: unknown): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(JSON.stringify(canonical(input))); }
export async function catalogSha256(input: unknown): Promise<string> {
  const copied = snapshotJson(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(copied))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function report(input: unknown): Readonly<CatalogConformanceReport> {
  const value = exact(snapshotJson(input), ['schemaVersion', 'suite', 'scope', 'outcome', 'checks', 'limits', 'limitations']);
  const limits = exact(value.limits, ['maxFixtureCases', 'maxCallbacks', 'maxResources', 'asyncTimeoutMs']);
  if (value.schemaVersion !== 1 || value.suite !== 'processor' || value.scope !== 'trusted-in-process' ||
    typeof value.outcome !== 'string' || !['passed', 'failed'].includes(value.outcome) || !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 32 ||
    limits.maxFixtureCases !== 32 || limits.maxCallbacks !== 256 || limits.maxResources !== 128 || limits.asyncTimeoutMs !== 1000 ||
    JSON.stringify(value.limitations) !== JSON.stringify(LIMITATIONS)) fail();
  const seen = new Set<string>();
  const checks = value.checks.map(input => {
    const check = exact(input, ['id', 'status']);
    if (typeof check.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(check.id) || seen.has(check.id) ||
      typeof check.status !== 'string' || !['passed', 'failed', 'not-applicable'].includes(check.status)) fail();
    seen.add(check.id); return Object.freeze({ id: check.id, status: check.status as CatalogConformanceReport['checks'][number]['status'] });
  });
  return bounded(Object.freeze({ schemaVersion: 1 as const, suite: 'processor' as const, scope: 'trusted-in-process' as const,
    outcome: value.outcome as CatalogConformanceReport['outcome'], checks: Object.freeze(checks),
    limits: Object.freeze({ maxFixtureCases: 32 as const, maxCallbacks: 256 as const, maxResources: 128 as const, asyncTimeoutMs: 1000 as const }),
    limitations: Object.freeze([...LIMITATIONS]) }), LOCAL_PACKAGE_CATALOG_LIMITS.evidenceBytes);
}
function submission(input: unknown, signed: boolean): UnsignedCatalogSubmission {
  const value = exact(input, [...SUBMISSION, ...(signed ? ['signature'] : [])]);
  if (value.schemaVersion !== 1 || value.profile !== LOCAL_PACKAGE_CATALOG_PROFILE) fail();
  const release = parseProcessorExtensionRelease(value.release), docs = exact(value.docs, ['title', 'instructions', 'license']);
  const provenance = exact(value.provenance, ['builderId', 'builderVersion', 'sourceRevision', 'sourceSha256', 'buildSha256']);
  const evidence = exact(value.authorEvidence, ['fixtureSha256', 'reportSha256', 'report']);
  if (provenance.sourceSha256 !== release.source.sha256) fail();
  return Object.freeze({ schemaVersion: 1, profile: LOCAL_PACKAGE_CATALOG_PROFILE, ownerId: id(value.ownerId), release,
    docs: bounded(Object.freeze({ title: text(docs.title, 128), instructions: text(docs.instructions, 16 * 1024),
      license: text(docs.license, 128) }), LOCAL_PACKAGE_CATALOG_LIMITS.docsBytes),
    provenance: bounded(Object.freeze({ builderId: namespaced(provenance.builderId), builderVersion: text(provenance.builderVersion, 64),
      sourceRevision: hash(provenance.sourceRevision), sourceSha256: hash(provenance.sourceSha256), buildSha256: hash(provenance.buildSha256) }), LOCAL_PACKAGE_CATALOG_LIMITS.provenanceBytes),
    authorEvidence: Object.freeze({ fixtureSha256: hash(evidence.fixtureSha256), reportSha256: hash(evidence.reportSha256), report: report(evidence.report) }) });
}
export function parseCatalogSubmission(input: unknown): Readonly<CatalogSubmission> {
  const value = submission(input, true); return Object.freeze({ ...value, signature: signature(object(input).signature) });
}
export function catalogSubmissionSigningBytes(input: unknown): Uint8Array<ArrayBuffer> { return bytes(submission(input, false)); }
export async function catalogSubmissionSha256(input: unknown): Promise<string> {
  const value = parseCatalogSubmission(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyCatalogSignature(publicKey: CryptoKey, input: Uint8Array<ArrayBuffer>, hex: string): Promise<boolean> {
  try {
    signature(hex);
    if (publicKey.type !== 'public' || publicKey.algorithm.name !== 'ECDSA' ||
      (publicKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' || !publicKey.usages.includes('verify')) return false;
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
      new Uint8Array(hex.match(/../g)!.map(value => Number.parseInt(value, 16))), input);
  } catch { return false; }
}
export async function verifyCatalogSubmission(input: unknown, source: Uint8Array, publicKey: CryptoKey): Promise<boolean> {
  try {
    const value = parseCatalogSubmission(input), { signature: received, ...payload } = value;
    if (!(source instanceof Uint8Array) || source.byteLength > LOCAL_PACKAGE_CATALOG_LIMITS.sourceBytes) return false;
    const captured = snapshotResourceBytes(source);
    return await catalogSha256(value.authorEvidence.report) === value.authorEvidence.reportSha256 &&
      await verifyProcessorExtensionRelease(value.release, captured, publicKey) &&
      await verifyCatalogSignature(publicKey, catalogSubmissionSigningBytes(payload), received);
  } catch { return false; }
}
function review(input: unknown, signed: boolean): UnsignedCatalogReviewAttestation {
  const value = exact(input, [...REVIEW, ...(signed ? ['signature'] : [])]);
  if (value.schemaVersion !== 1 || value.profile !== LOCAL_PACKAGE_CATALOG_PROFILE ||
    typeof value.decision !== 'string' || !['approved', 'changes-requested', 'rejected'].includes(value.decision)) fail();
  return Object.freeze({ schemaVersion: 1, profile: LOCAL_PACKAGE_CATALOG_PROFILE, ownerId: id(value.ownerId),
    reviewerId: namespaced(value.reviewerId), packageId: namespaced(value.packageId), version: text(value.version, 64),
    sequence: integer(value.sequence, 1), reviewedAt: integer(value.reviewedAt), decision: value.decision as CatalogReviewDecision,
    submissionSha256: hash(value.submissionSha256), releaseSha256: hash(value.releaseSha256), sourceSha256: hash(value.sourceSha256),
    docsSha256: hash(value.docsSha256), provenanceSha256: hash(value.provenanceSha256), fixtureSha256: hash(value.fixtureSha256),
    reportSha256: hash(value.reportSha256), report: report(value.report) });
}
export function parseCatalogReviewAttestation(input: unknown): Readonly<CatalogReviewAttestation> {
  const value = review(input, true); return Object.freeze({ ...value, signature: signature(object(input).signature) });
}
export function catalogReviewSigningBytes(input: unknown): Uint8Array<ArrayBuffer> { return bytes(review(input, false)); }
export async function verifyCatalogReviewAttestation(input: unknown, publicKey: CryptoKey): Promise<boolean> {
  try {
    const value = parseCatalogReviewAttestation(input), { signature: received, ...payload } = value;
    return await catalogSha256(value.report) === value.reportSha256 &&
      await verifyCatalogSignature(publicKey, catalogReviewSigningBytes(payload), received);
  } catch { return false; }
}
/** Only the complete current processor suite can support an approval; its signer supplies independent provenance. */
export function catalogProcessorReportPassed(input: unknown, manifest: Readonly<ProcessorManifest>): boolean {
  const value = report(input);
  const required = ['manifest', 'fixtures', 'code-pin', 'configuration-rejection', 'untrusted-lookup', 'resolve',
    'input-rejection', 'output-vectors', 'deterministic-replay', 'cleanup',
    ...(manifest.state.mode === 'resettable' ? manifest.state.resetOn.map(cause => `reset-${cause}`) : ['stateless-replay'])];
  return value.outcome === 'passed' && value.checks.length === required.length &&
    required.every(id => value.checks.some(check => check.id === id && check.status === 'passed'));
}
/** Canonical signed release identity, independent of JSON property order. */
export async function catalogReleaseSha256(input: unknown): Promise<string> {
  const value = parseProcessorExtensionRelease(input), { signature: received, ...payload } = value;
  const unsigned = processorExtensionSigningBytes(payload);
  const combined = new Uint8Array(unsigned.byteLength + 128); combined.set(unsigned); combined.set(new TextEncoder().encode(received), unsigned.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', combined)), byte => byte.toString(16).padStart(2, '0')).join('');
}
