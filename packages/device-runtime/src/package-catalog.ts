import { LOCAL_PACKAGE_CATALOG_PROFILE as PROFILE, LOCAL_PACKAGE_CATALOG_LIMITS as LIMITS,
  parseCatalogSubmission, catalogSubmissionSha256, verifyCatalogSubmission, parseCatalogReviewAttestation,
  verifyCatalogReviewAttestation, catalogProcessorReportPassed, catalogSha256, catalogReleaseSha256,
  verifyCatalogSignature, snapshotResourceBytes, verifyAssetContent } from '@101/device-model';
import type { CatalogSubmission, CatalogReviewAttestation } from '@101/device-model';

export type LocalPackageCatalogRole = 'author' | 'reviewer' | 'owner';
export type LocalPackageCatalogAction = 'submit' | 'inspect' | 'read-submission' | 'review' | 'supersede' | 'revoke' | 'remove';
export type LocalPackageCatalogStatus = 'submitted' | 'approved' | 'changes-requested' | 'rejected' | 'superseded' | 'revoked' | 'removed';
export type LocalPackageCatalogFailure = 'invalid' | 'wrong-owner' | 'wrong-role' | 'integrity' | 'untrusted' | 'rollback'
  | 'denied' | 'expired' | 'conflict' | 'duplicate-version' | 'downgrade' | 'not-found' | 'revoked' | 'capacity'
  | 'busy' | 'closed' | 'invalid-clock' | 'unavailable' | 'conformance';
export type LocalPackageCatalogResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: LocalPackageCatalogFailure }>;
export interface LocalPackageCatalogWriteGuard { readonly signal: AbortSignal; isCurrent(): boolean }
/** Host-owned atomic storage; check both guards at the real commit, including late completions. */
export interface LocalPackageCatalogStorage {
  read(key: string): Promise<string | undefined>;
  compareAndSwap(key: string, expected: string | undefined, value: string, guard: LocalPackageCatalogWriteGuard): Promise<boolean>;
  isCurrent(key: string, expected: string | undefined): boolean;
}
export interface LocalPackageCatalogTrust { readonly key: CryptoKey; readonly minimumSequence: number }
export interface LocalPackageCatalogOwnerTrust {
  readonly key: CryptoKey;
  /** Provisioned outside this document. Restoring both this checkpoint and the document is excluded. */
  readonly minimumRevision: number;
}
export interface LocalPackageCatalogScope {
  readonly ownerId: string; readonly principalId: string; readonly role: LocalPackageCatalogRole;
  readonly action: LocalPackageCatalogAction; readonly packageId?: string; readonly version?: string;
  readonly submissionSha256?: string; readonly targetVersion?: string;
}
/** Own data properties only. Grants and signing credentials stay outside catalog storage. */
export interface LocalPackageCatalogApproval { readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal }
export interface LocalPackageCatalogOptions {
  readonly ownerId: string; readonly principalId: string; readonly role: LocalPackageCatalogRole;
  readonly storage: LocalPackageCatalogStorage;
  readonly ownerTrust: () => LocalPackageCatalogOwnerTrust | undefined;
  readonly publisherTrust: (id: string) => LocalPackageCatalogTrust | undefined;
  readonly reviewerTrust: (id: string) => LocalPackageCatalogTrust | undefined;
  /** Explicit host signer receives private snapshot bytes; its result is verified against the original. */
  readonly signOwnerSnapshot: (bytes: Uint8Array<ArrayBuffer>) => string | Promise<string>;
  readonly authorize: (scope: LocalPackageCatalogScope) => LocalPackageCatalogApproval | undefined | Promise<LocalPackageCatalogApproval | undefined>;
  readonly now?: () => number;
}
export interface LocalPackageCatalogReleaseSummary {
  readonly version: string; readonly sequence: number; readonly submissionSha256: string;
  readonly sourceSha256: string; readonly title: string; readonly status: LocalPackageCatalogStatus;
  /** Current review/trust availability describes catalog data, never executable or resource authority. */
  readonly available: boolean; readonly reviewerId?: string;
}
export interface LocalPackageCatalogSnapshot {
  readonly ownerId: string; readonly revision: number;
  readonly packages: readonly Readonly<{ packageId: string; publisherId: string; highestSequence: number;
    releases: readonly LocalPackageCatalogReleaseSummary[]; knownVersions: number }>[];
}
export interface LocalPackageCatalog {
  readonly key: string;
  submit(submission: unknown, source: Uint8Array): Promise<LocalPackageCatalogResult<LocalPackageCatalogSnapshot>>;
  inspect(): Promise<LocalPackageCatalogResult<LocalPackageCatalogSnapshot>>;
  readSubmission(packageId: string, version: string): Promise<LocalPackageCatalogResult<Readonly<{
    submission: Readonly<CatalogSubmission>; source: Uint8Array; status: LocalPackageCatalogStatus; attestation?: Readonly<CatalogReviewAttestation>;
  }>>>;
  review(packageId: string, version: string, submissionSha256: string, attestation: unknown): Promise<LocalPackageCatalogResult<LocalPackageCatalogSnapshot>>;
  supersede(packageId: string, oldVersion: string, newVersion: string): Promise<LocalPackageCatalogResult<LocalPackageCatalogSnapshot>>;
  revoke(packageId: string, version: string): Promise<LocalPackageCatalogResult<LocalPackageCatalogSnapshot>>;
  remove(packageId: string): Promise<LocalPackageCatalogResult<LocalPackageCatalogSnapshot>>;
  close(): void;
}
interface Known { version: string; sequence: number; submissionSha256: string; status: LocalPackageCatalogStatus }
interface Entry { submission: Readonly<CatalogSubmission>; sourceBase64: string; status: LocalPackageCatalogStatus; attestation?: Readonly<CatalogReviewAttestation> }
interface Package { packageId: string; publisherId: string; highestSequence: number; known: Known[]; releases: Entry[] }
interface Event { revision: number; action: LocalPackageCatalogAction; principalId: string; packageId: string;
  version?: string; targetVersion?: string; time: number; reviewerSequence?: number }
interface Payload { schemaVersion: 1; profile: typeof PROFILE; ownerId: string; revision: number; packages: Package[];
  events: Event[]; reviewerSequences: Array<{ reviewerId: string; sequence: number }> }
interface Document extends Payload { signature: string }
interface Authority { kind: 'publisher' | 'reviewer'; id: string; sequence: number; trust: LocalPackageCatalogTrust }
class CatalogError extends Error {
  readonly reason: LocalPackageCatalogFailure;
  constructor(reason: LocalPackageCatalogFailure) { super(reason); this.reason = reason; }
}
function fail(reason: LocalPackageCatalogFailure): never { throw new CatalogError(reason); }
function bad(reason: LocalPackageCatalogFailure): LocalPackageCatalogResult<never> { return Object.freeze({ ok: false, reason }); }
function ok<T>(value: T): LocalPackageCatalogResult<T> { return Object.freeze({ ok: true, value }); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid');
  return input as Record<string, unknown>;
}
function exact(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const value = object(input), own = Reflect.ownKeys(value);
  if (keys.some(key => !Object.hasOwn(value, key)) || own.some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))) fail('invalid');
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid');
  }
  return value;
}
function field(input: unknown, key: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(input), key);
  if (!descriptor && optional) return undefined;
  if (!descriptor || !('value' in descriptor)) fail('invalid'); return descriptor.value;
}
function integer(input: unknown, minimum = 0): input is number { return typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum; }
function identifier(input: unknown): input is string { return typeof input === 'string' && input.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input); }
function version(input: unknown): input is string {
  return typeof input === 'string' && input.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(input);
}
function digest(input: unknown): input is string { return typeof input === 'string' && /^[0-9a-f]{64}$/.test(input); }
function validSignature(input: unknown): input is string { return typeof input === 'string' && /^[0-9a-f]{128}$/.test(input); }
const STATUSES: LocalPackageCatalogStatus[] = ['submitted', 'approved', 'changes-requested', 'rejected', 'superseded', 'revoked', 'removed'];
function status(input: unknown): input is LocalPackageCatalogStatus { return typeof input === 'string' && STATUSES.includes(input as LocalPackageCatalogStatus); }
function canonical(input: unknown): unknown {
  return Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical((input as Record<string, unknown>)[key])])) : input;
}
function signingBytes(input: Payload): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(JSON.stringify(canonical(input))); }
function base64(bytes: Uint8Array): string { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function unbase64(input: unknown): Uint8Array<ArrayBuffer> {
  if (typeof input !== 'string' || input.length > Math.ceil(LIMITS.sourceBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) fail('integrity');
  const bytes = Uint8Array.from(atob(input), character => character.charCodeAt(0));
  if (bytes.byteLength < 1 || bytes.byteLength > LIMITS.sourceBytes || base64(bytes) !== input) fail('integrity'); return bytes;
}
async function bounded<T>(value: T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(value), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CatalogError('unavailable')), LIMITS.asyncMs);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
function document(raw: string | undefined, ownerId: string): Payload | Document {
  if (raw === undefined) return { schemaVersion: 1, profile: PROFILE, ownerId, revision: 0, packages: [], events: [], reviewerSequences: [] };
  if (typeof raw !== 'string' || raw.length > LIMITS.documentBytes || new TextEncoder().encode(raw).byteLength > LIMITS.documentBytes) fail('capacity');
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { fail('integrity'); }
  const value = exact(parsed, ['schemaVersion', 'profile', 'ownerId', 'revision', 'packages', 'events', 'reviewerSequences', 'signature']);
  if (value.ownerId !== ownerId) fail('wrong-owner');
  if (value.schemaVersion !== 1 || value.profile !== PROFILE || !integer(value.revision, 1) || !validSignature(value.signature) ||
    !Array.isArray(value.packages) || value.packages.length > LIMITS.packages || !Array.isArray(value.events) ||
    value.events.length > LIMITS.events || value.events.length !== value.revision || !Array.isArray(value.reviewerSequences) ||
    value.reviewerSequences.length > LIMITS.reviewers) fail('integrity');
  let knownCount = 0;
  const packageIds = new Set<string>();
  const packages = value.packages.map(input => {
    const item = exact(input, ['packageId', 'publisherId', 'highestSequence', 'known', 'releases']);
    if (!identifier(item.packageId) || !identifier(item.publisherId) || packageIds.has(item.packageId) || !integer(item.highestSequence, 1) ||
      !Array.isArray(item.known) || item.known.length < 1 || (knownCount += item.known.length) > LIMITS.knownVersions ||
      !Array.isArray(item.releases) || item.releases.length > LIMITS.releasesPerPackage) fail('integrity');
    packageIds.add(item.packageId); const versions = new Set<string>(), sequences = new Set<number>();
    const known = item.known.map(input => {
      const entry = exact(input, ['version', 'sequence', 'submissionSha256', 'status']);
      if (!version(entry.version) || versions.has(entry.version) || !integer(entry.sequence, 1) || sequences.has(entry.sequence) ||
        !digest(entry.submissionSha256) || !status(entry.status)) fail('integrity');
      versions.add(entry.version); sequences.add(entry.sequence);
      return { version: entry.version, sequence: entry.sequence, submissionSha256: entry.submissionSha256, status: entry.status };
    });
    if (Math.max(...known.map(entry => entry.sequence)) !== item.highestSequence) fail('integrity');
    const resident = new Set<string>();
    const releases = item.releases.map(input => {
      const entry = exact(input, ['submission', 'sourceBase64', 'status'], ['attestation']);
      const submission = parseCatalogSubmission(entry.submission), release = submission.release;
      const old = known.find(entry => entry.version === release.version);
      if (submission.ownerId !== ownerId || release.packageId !== item.packageId || release.publisherId !== item.publisherId ||
        resident.has(release.version) || !old || old.sequence !== release.sequence || entry.status !== old.status ||
        entry.status === 'removed' || !status(entry.status)) fail('integrity');
      resident.add(release.version); unbase64(entry.sourceBase64);
      const attestation = entry.attestation === undefined ? undefined : parseCatalogReviewAttestation(entry.attestation);
      if (['approved', 'superseded', 'changes-requested', 'rejected'].includes(entry.status) &&
        (!attestation || attestation.decision !== (entry.status === 'superseded' ? 'approved' : entry.status))) fail('integrity');
      if (entry.status === 'submitted' && attestation) fail('integrity');
      return { submission, sourceBase64: entry.sourceBase64 as string, status: entry.status,
        ...(attestation ? { attestation } : {}) };
    });
    if (known.some(entry => entry.status !== 'removed' && !resident.has(entry.version))) fail('integrity');
    return { packageId: item.packageId, publisherId: item.publisherId, highestSequence: item.highestSequence, known, releases };
  });
  const events = value.events.map((input, index) => {
    const event = exact(input, ['revision', 'action', 'principalId', 'packageId', 'time'], ['version', 'targetVersion', 'reviewerSequence']);
    if (event.revision !== index + 1 || !identifier(event.principalId) || !identifier(event.packageId) || !integer(event.time) ||
      !['submit', 'review', 'supersede', 'revoke', 'remove'].includes(String(event.action)) ||
      event.version !== undefined && !version(event.version) || event.targetVersion !== undefined && !version(event.targetVersion) ||
      event.reviewerSequence !== undefined && !integer(event.reviewerSequence, 1)) fail('integrity');
    if ((event.action === 'review') !== (event.reviewerSequence !== undefined) ||
      (event.action === 'supersede') !== (event.targetVersion !== undefined) ||
      (event.action !== 'remove') !== (event.version !== undefined)) fail('integrity');
    return event as unknown as Event;
  });
  const reviewers = new Set<string>();
  const reviewerSequences = value.reviewerSequences.map(input => {
    const entry = exact(input, ['reviewerId', 'sequence']);
    if (!identifier(entry.reviewerId) || reviewers.has(entry.reviewerId) || !integer(entry.sequence, 1) ||
      entry.sequence !== Math.max(...events.filter(event => event.action === 'review' && event.principalId === entry.reviewerId)
        .map(event => event.reviewerSequence!))) fail('integrity');
    reviewers.add(entry.reviewerId); return { reviewerId: entry.reviewerId, sequence: entry.sequence };
  });
  if (events.some(event => event.action === 'review' && !reviewers.has(event.principalId))) fail('integrity');
  return { schemaVersion: 1, profile: PROFILE, ownerId, revision: value.revision, packages, events, reviewerSequences, signature: value.signature };
}

/** Inert local package review history. It cannot select imports, construct a factory or grant resources. */
export function createLocalPackageCatalog(options: LocalPackageCatalogOptions): LocalPackageCatalog {
  const ownerInput = field(options, 'ownerId'), principalInput = field(options, 'principalId'), roleInput = field(options, 'role');
  if (!identifier(ownerInput) || !identifier(principalInput) || typeof roleInput !== 'string' || !['author', 'reviewer', 'owner'].includes(roleInput)) fail('invalid');
  const ownerId = ownerInput as string, principalId = principalInput as string, role = roleInput as LocalPackageCatalogRole;
  if (role === 'owner' && principalId !== ownerId) fail('wrong-owner');
  const storage = field(options, 'storage') as LocalPackageCatalogStorage;
  const ownerTrust = field(options, 'ownerTrust') as LocalPackageCatalogOptions['ownerTrust'];
  const publisherTrust = field(options, 'publisherTrust') as LocalPackageCatalogOptions['publisherTrust'];
  const reviewerTrust = field(options, 'reviewerTrust') as LocalPackageCatalogOptions['reviewerTrust'];
  const signOwnerSnapshot = field(options, 'signOwnerSnapshot') as LocalPackageCatalogOptions['signOwnerSnapshot'];
  const authorize = field(options, 'authorize') as LocalPackageCatalogOptions['authorize'];
  const now = (field(options, 'now', true) ?? Date.now) as () => number;
  if ([ownerTrust, publisherTrust, reviewerTrust, signOwnerSnapshot, authorize, now].some(value => typeof value !== 'function') ||
    !storage || ['read', 'isCurrent', 'compareAndSwap'].some(key => typeof field(storage, key) !== 'function')) fail('invalid');
  const key = `101:package-catalog:${encodeURIComponent(ownerId)}`;
  let closed = false, busy = false, epoch = 0, lastTime = -1, observedFloor = 0;
  let controller: AbortController | undefined;
  const seenFloors = new Map<string, number>();
  function time(): number {
    let value: unknown; try { value = now(); } catch { value = NaN; }
    if (!integer(value) || value < lastTime) { closed = true; epoch++; controller?.abort(); fail('invalid-clock'); }
    lastTime = value; return value;
  }
  function check(id: number): void { if (closed) fail('closed'); if (epoch !== id) fail('conflict'); }
  function owner(): LocalPackageCatalogOwnerTrust {
    const input = ownerTrust(); if (!input) fail('untrusted'); exact(input, ['key', 'minimumRevision']);
    const key = field(input, 'key') as CryptoKey, minimumRevision = field(input, 'minimumRevision');
    if (!key || key.type !== 'public' || key.algorithm.name !== 'ECDSA' || (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
      !key.usages.includes('verify') || !integer(minimumRevision) || minimumRevision < observedFloor) fail('untrusted');
    observedFloor = minimumRevision; return Object.freeze({ key, minimumRevision });
  }
  function trust(kind: Authority['kind'], id: string, sequence: number): LocalPackageCatalogTrust {
    const input = (kind === 'publisher' ? publisherTrust : reviewerTrust)(id); if (!input) fail('untrusted');
    exact(input, ['key', 'minimumSequence']);
    const key = field(input, 'key') as CryptoKey, minimumSequence = field(input, 'minimumSequence'), marker = `${kind}\0${id}`;
    if (!key || key.type !== 'public' || key.algorithm.name !== 'ECDSA' || (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
      !key.usages.includes('verify') || !integer(minimumSequence, 1) ||
      minimumSequence < (seenFloors.get(marker) ?? 0)) fail('untrusted');
    if (!seenFloors.has(marker) && seenFloors.size >= LIMITS.reviewers + LIMITS.packages) fail('capacity');
    seenFloors.set(marker, minimumSequence);
    if (minimumSequence > sequence) fail('untrusted'); return Object.freeze({ key, minimumSequence });
  }
  function currentAuthority(expected: LocalPackageCatalogOwnerTrust, revision: number, authorities: Authority[]): boolean {
    try {
      const current = owner();
      if (current.key !== expected.key || current.minimumRevision < expected.minimumRevision || current.minimumRevision > revision) return false;
      return authorities.every(authority => {
        const current = trust(authority.kind, authority.id, authority.sequence);
        return current.key === authority.trust.key && current.minimumSequence >= authority.trust.minimumSequence;
      });
    } catch { return false; }
  }
  function approvalCurrent(approval: LocalPackageCatalogApproval): boolean {
    try { return !approval.signal?.aborted && time() < approval.expiresAt && approval.isCurrent() === true && !approval.signal?.aborted; }
    catch { return false; }
  }
  function guard(id: number, approval: LocalPackageCatalogApproval, expected: LocalPackageCatalogOwnerTrust,
    revision: number, authorities: Authority[] = []): boolean {
    try { check(id); return approvalCurrent(approval) && currentAuthority(expected, revision, authorities) && !closed && epoch === id; }
    catch { return false; }
  }
  async function operation<T>(run: (id: number, signal: AbortSignal) => Promise<T>): Promise<LocalPackageCatalogResult<T>> {
    if (closed) return bad('closed'); if (busy) return bad('busy');
    busy = true; const id = ++epoch, abort = new AbortController(); controller = abort;
    try { time(); const value = await run(id, abort.signal); check(id); return ok(value); }
    catch (error) { return bad(error instanceof CatalogError ? error.reason : 'invalid'); }
    finally { abort.abort(); if (controller === abort) controller = undefined; epoch++; busy = false; }
  }
  function requireRole(expected: LocalPackageCatalogRole): void { if (role !== expected) fail('wrong-role'); }
  function identifiers(packageId: unknown, releaseVersion?: unknown): void {
    if (!identifier(packageId) || releaseVersion !== undefined && !version(releaseVersion)) fail('invalid');
  }
  async function approve(id: number, scope: Omit<LocalPackageCatalogScope, 'ownerId' | 'principalId' | 'role'>): Promise<LocalPackageCatalogApproval> {
    const input = await bounded(authorize(Object.freeze({ ownerId, principalId, role: role as LocalPackageCatalogRole, ...scope }))); check(id);
    if (!input) fail('denied'); exact(input, ['expiresAt', 'isCurrent'], ['signal']);
    const expiresAt = field(input, 'expiresAt'), isCurrent = field(input, 'isCurrent'), signal = field(input, 'signal', true), currentTime = time();
    if (!integer(expiresAt) || expiresAt <= currentTime || expiresAt > currentTime + LIMITS.approvalMs || typeof isCurrent !== 'function' ||
      signal !== undefined && !(signal instanceof AbortSignal)) fail('denied');
    const value = Object.freeze({ expiresAt, isCurrent: isCurrent as () => boolean,
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }) });
    if (!approvalCurrent(value)) fail('denied'); check(id); return value;
  }
  async function load(id: number): Promise<{ raw: string | undefined; doc: Payload | Document; expected: LocalPackageCatalogOwnerTrust }> {
    const expected = owner(); check(id);
    let raw: string | undefined; try { raw = await bounded(storage.read(key)); } catch { fail('unavailable'); }
    check(id); const doc = document(raw, ownerId);
    if (doc.revision < expected.minimumRevision) fail('rollback');
    if (raw !== undefined) {
      const { signature, ...payload } = doc as Document;
      if (!await bounded(verifyCatalogSignature(expected.key, signingBytes(payload), signature))) fail('integrity'); check(id);
      for (const item of doc.packages) for (const entry of item.releases) {
        if (!await bounded(verifyAssetContent(entry.submission.release.source, unbase64(entry.sourceBase64))) ||
          await bounded(catalogSubmissionSha256(entry.submission)) !== item.known.find(value => value.version === entry.submission.release.version)?.submissionSha256 ||
          await bounded(catalogSha256(entry.submission.authorEvidence.report)) !== entry.submission.authorEvidence.reportSha256) fail('integrity');
        if (entry.attestation && !await matches(entry.submission, entry.attestation)) fail('integrity'); check(id);
      }
    }
    if (!currentAuthority(expected, doc.revision, [])) fail('untrusted'); check(id); return { raw, doc, expected };
  }
  async function matches(submission: CatalogSubmission, attestation: CatalogReviewAttestation): Promise<boolean> {
    return attestation.ownerId === ownerId && attestation.packageId === submission.release.packageId && attestation.version === submission.release.version &&
      attestation.submissionSha256 === await bounded(catalogSubmissionSha256(submission)) &&
      attestation.releaseSha256 === await bounded(catalogReleaseSha256(submission.release)) && attestation.sourceSha256 === submission.release.source.sha256 &&
      attestation.docsSha256 === await bounded(catalogSha256(submission.docs)) && attestation.provenanceSha256 === await bounded(catalogSha256(submission.provenance)) &&
      attestation.reportSha256 === await bounded(catalogSha256(attestation.report)) &&
      (attestation.decision !== 'approved' || catalogProcessorReportPassed(attestation.report, submission.release.manifest));
  }
  function find(doc: Payload, packageId: string, releaseVersion: string): { item: Package; entry: Entry; known: Known } {
    const item = doc.packages.find(value => value.packageId === packageId), entry = item?.releases.find(value => value.submission.release.version === releaseVersion),
      known = item?.known.find(value => value.version === releaseVersion);
    if (!item || !entry || !known) fail('not-found'); return { item, entry, known };
  }
  function snapshot(doc: Payload, available: ReadonlySet<Entry>): LocalPackageCatalogSnapshot {
    return Object.freeze({ ownerId, revision: doc.revision, packages: Object.freeze(doc.packages.map(item => Object.freeze({
      packageId: item.packageId, publisherId: item.publisherId, highestSequence: item.highestSequence, knownVersions: item.known.length,
      releases: Object.freeze(item.releases.map(entry => Object.freeze({ version: entry.submission.release.version, sequence: entry.submission.release.sequence,
        submissionSha256: item.known.find(value => value.version === entry.submission.release.version)!.submissionSha256,
        sourceSha256: entry.submission.release.source.sha256, title: entry.submission.docs.title, status: entry.status,
        available: available.has(entry), ...(entry.attestation ? { reviewerId: entry.attestation.reviewerId } : {}) }))) }))) });
  }
  function currentRead(id: number, raw: string | undefined, approval: LocalPackageCatalogApproval, expected: LocalPackageCatalogOwnerTrust,
    revision: number, authorities: Authority[] = []): void {
    if (!guard(id, approval, expected, revision, authorities)) fail('denied');
    if (!storage.isCurrent(key, raw)) fail('conflict');
    if (!guard(id, approval, expected, revision, authorities)) fail('denied');
  }
  async function save(id: number, signal: AbortSignal, raw: string | undefined, doc: Payload | Document, expected: LocalPackageCatalogOwnerTrust,
    approval: LocalPackageCatalogApproval, event: Omit<Event, 'revision' | 'principalId' | 'time'>, authorities: Authority[] = []): Promise<string> {
    if (doc.events.length >= LIMITS.events || doc.revision >= Number.MAX_SAFE_INTEGER) fail('capacity');
    if (!guard(id, approval, expected, doc.revision, authorities)) fail('denied');
    const revision = doc.revision + 1;
    const payload: Payload = { schemaVersion: 1, profile: PROFILE, ownerId, revision, packages: doc.packages,
      events: [...doc.events, { ...event, revision, principalId, time: time() }], reviewerSequences: doc.reviewerSequences };
    const bytes = signingBytes(payload);
    if (bytes.byteLength + 160 > LIMITS.documentBytes) fail('capacity');
    const signature = await bounded(signOwnerSnapshot(bytes.slice())); check(id);
    if (!validSignature(signature) || !await bounded(verifyCatalogSignature(expected.key, bytes, signature))) fail('integrity'); check(id);
    const encoded = JSON.stringify({ ...payload, signature });
    if (new TextEncoder().encode(encoded).byteLength > LIMITS.documentBytes) fail('capacity');
    if (!guard(id, approval, expected, revision, authorities)) fail('denied');
    let committed: boolean;
    try { committed = await bounded(storage.compareAndSwap(key, raw, encoded,
      { signal, isCurrent: () => guard(id, approval, expected, revision, authorities) })); } catch { fail('unavailable'); }
    check(id); if (!committed) fail('conflict');
    doc.revision = revision; doc.events = payload.events;
    currentRead(id, encoded, approval, expected, revision, authorities);
    return encoded;
  }
  async function authenticated(id: number, entry: Entry): Promise<Authority[]> {
    const release = entry.submission.release, publisher = trust('publisher', release.publisherId, release.sequence);
    if (!await bounded(verifyCatalogSubmission(entry.submission, unbase64(entry.sourceBase64), publisher.key))) fail('integrity'); check(id);
    const authorities: Authority[] = [{ kind: 'publisher', id: release.publisherId, sequence: release.sequence, trust: publisher }];
    if (entry.attestation) {
      const attestation = entry.attestation, reviewer = trust('reviewer', attestation.reviewerId, attestation.sequence);
      if (!await bounded(verifyCatalogReviewAttestation(attestation, reviewer.key))) fail('integrity'); check(id);
      authorities.push({ kind: 'reviewer', id: attestation.reviewerId, sequence: attestation.sequence, trust: reviewer });
    }
    return authorities;
  }
  async function finish(id: number, raw: string | undefined, doc: Payload, expected: LocalPackageCatalogOwnerTrust,
    approval: LocalPackageCatalogApproval, authorities: Authority[] = []): Promise<LocalPackageCatalogSnapshot> {
    const available = new Set<Entry>(), projected: Authority[] = [];
    for (const item of doc.packages) for (const entry of item.releases) {
      if (entry.status !== 'approved') continue;
      try { projected.push(...await authenticated(id, entry)); available.add(entry); }
      catch (error) {
        if (!(error instanceof CatalogError) || !['untrusted', 'integrity'].includes(error.reason)) throw error;
      }
      check(id);
    }
    const value = snapshot(doc, available);
    currentRead(id, raw, approval, expected, doc.revision, [...authorities, ...projected]); return value;
  }
  return Object.freeze({ key,
    submit(input: unknown, inputBytes: Uint8Array) {
      return operation(async (id, signal) => {
        requireRole('author'); const submission = parseCatalogSubmission(input), release = submission.release;
        if (submission.ownerId !== ownerId) fail('wrong-owner'); if (principalId !== release.publisherId) fail('wrong-role');
        if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength > LIMITS.sourceBytes) fail('capacity');
        const source = snapshotResourceBytes(inputBytes), publisher = trust('publisher', release.publisherId, release.sequence);
        const authorities: Authority[] = [{ kind: 'publisher', id: release.publisherId, sequence: release.sequence, trust: publisher }];
        if (!await bounded(verifyCatalogSubmission(submission, source, publisher.key))) fail('integrity'); check(id);
        const identity = await bounded(catalogSubmissionSha256(submission)); check(id);
        const { raw, doc, expected } = await load(id);
        let item = doc.packages.find(value => value.packageId === release.packageId);
        if (item && item.publisherId !== release.publisherId) fail('untrusted');
        const known = item?.known.find(value => value.version === release.version);
        if (known && known.submissionSha256 !== identity) fail('duplicate-version');
        if (known && ['revoked', 'removed'].includes(known.status)) fail('revoked');
        const approval = await approve(id, { action: 'submit', packageId: release.packageId, version: release.version, submissionSha256: identity });
        if (known) return finish(id, raw, doc, expected, approval, authorities);
        if (item && release.sequence <= item.highestSequence) fail('downgrade');
        if (doc.packages.reduce((count, value) => count + value.known.length, 0) >= LIMITS.knownVersions ||
          item && item.releases.length >= LIMITS.releasesPerPackage || !item && doc.packages.length >= LIMITS.packages) fail('capacity');
        if (!item) { item = { packageId: release.packageId, publisherId: release.publisherId, highestSequence: release.sequence, known: [], releases: [] }; doc.packages.push(item); }
        item.highestSequence = release.sequence;
        item.known.push({ version: release.version, sequence: release.sequence, submissionSha256: identity, status: 'submitted' });
        item.releases.push({ submission, sourceBase64: base64(source), status: 'submitted' });
        const encoded = await save(id, signal, raw, doc, expected, approval, { action: 'submit', packageId: release.packageId, version: release.version }, authorities);
        return finish(id, encoded, doc, expected, approval, authorities);
      });
    },
    inspect() {
      return operation(async id => {
        const { raw, doc, expected } = await load(id), approval = await approve(id, { action: 'inspect' });
        return finish(id, raw, doc, expected, approval);
      });
    },
    readSubmission(packageId: string, releaseVersion: string) {
      return operation(async id => {
        identifiers(packageId, releaseVersion); const { raw, doc, expected } = await load(id), { entry, known } = find(doc, packageId, releaseVersion);
        if (entry.status === 'revoked') fail('revoked'); const authorities = await authenticated(id, entry);
        const approval = await approve(id, { action: 'read-submission', packageId, version: releaseVersion, submissionSha256: known.submissionSha256 });
        currentRead(id, raw, approval, expected, doc.revision, authorities);
        return Object.freeze({ submission: entry.submission, source: unbase64(entry.sourceBase64), status: entry.status,
          ...(entry.attestation ? { attestation: entry.attestation } : {}) });
      });
    },
    review(packageId: string, releaseVersion: string, submissionSha256: string, input: unknown) {
      return operation(async (id, signal) => {
        requireRole('reviewer'); identifiers(packageId, releaseVersion); if (!digest(submissionSha256)) fail('invalid');
        const attestation = parseCatalogReviewAttestation(input);
        if (attestation.ownerId !== ownerId) fail('wrong-owner'); if (attestation.reviewerId !== principalId) fail('wrong-role');
        if (attestation.packageId !== packageId || attestation.version !== releaseVersion || attestation.submissionSha256 !== submissionSha256) fail('conflict');
        const reviewer = trust('reviewer', attestation.reviewerId, attestation.sequence);
        if (!await bounded(verifyCatalogReviewAttestation(attestation, reviewer.key))) fail('integrity'); check(id);
        const { raw, doc, expected } = await load(id), { entry, known } = find(doc, packageId, releaseVersion);
        if (known.submissionSha256 !== submissionSha256 || !await matches(entry.submission, attestation)) fail('conflict'); check(id);
        if (attestation.decision === 'approved' && !catalogProcessorReportPassed(attestation.report, entry.submission.release.manifest)) fail('conformance');
        const authorities = await authenticated(id, entry);
        authorities.push({ kind: 'reviewer', id: attestation.reviewerId, sequence: attestation.sequence, trust: reviewer });
        const approval = await approve(id, { action: 'review', packageId, version: releaseVersion, submissionSha256 });
        if (entry.attestation && JSON.stringify(entry.attestation) === JSON.stringify(attestation)) {
          return finish(id, raw, doc, expected, approval, authorities);
        }
        if (entry.status !== 'submitted') fail('revoked');
        const currentTime = time(); if (attestation.reviewedAt > currentTime || currentTime - attestation.reviewedAt > LIMITS.approvalMs) fail('expired');
        let sequence = doc.reviewerSequences.find(value => value.reviewerId === attestation.reviewerId);
        if (sequence && attestation.sequence <= sequence.sequence) fail('conflict');
        if (!sequence) {
          if (doc.reviewerSequences.length >= LIMITS.reviewers) fail('capacity');
          sequence = { reviewerId: attestation.reviewerId, sequence: attestation.sequence }; doc.reviewerSequences.push(sequence);
        } else sequence.sequence = attestation.sequence;
        entry.attestation = attestation; entry.status = attestation.decision; known.status = attestation.decision;
        const encoded = await save(id, signal, raw, doc, expected, approval,
          { action: 'review', packageId, version: releaseVersion, reviewerSequence: attestation.sequence }, authorities);
        return finish(id, encoded, doc, expected, approval, authorities);
      });
    },
    supersede(packageId: string, oldVersion: string, newVersion: string) {
      return operation(async (id, signal) => {
        requireRole('owner'); identifiers(packageId, oldVersion); identifiers(packageId, newVersion);
        const { raw, doc, expected } = await load(id), old = find(doc, packageId, oldVersion), next = find(doc, packageId, newVersion);
        if (old.entry.status !== 'approved' || next.entry.status !== 'approved' || next.known.sequence <= old.known.sequence) fail('downgrade');
        const authorities = [...await authenticated(id, old.entry), ...await authenticated(id, next.entry)];
        const approval = await approve(id, { action: 'supersede', packageId, version: oldVersion,
          targetVersion: newVersion, submissionSha256: next.known.submissionSha256 });
        old.entry.status = 'superseded'; old.known.status = 'superseded';
        const encoded = await save(id, signal, raw, doc, expected, approval, { action: 'supersede', packageId, version: oldVersion, targetVersion: newVersion }, authorities);
        return finish(id, encoded, doc, expected, approval, authorities);
      });
    },
    revoke(packageId: string, releaseVersion: string) {
      return operation(async (id, signal) => {
        requireRole('owner'); identifiers(packageId, releaseVersion); const { raw, doc, expected } = await load(id), { entry, known } = find(doc, packageId, releaseVersion);
        const approval = await approve(id, { action: 'revoke', packageId, version: releaseVersion, submissionSha256: known.submissionSha256 });
        if (entry.status === 'revoked') return finish(id, raw, doc, expected, approval);
        entry.status = 'revoked'; known.status = 'revoked';
        const encoded = await save(id, signal, raw, doc, expected, approval, { action: 'revoke', packageId, version: releaseVersion });
        return finish(id, encoded, doc, expected, approval);
      });
    },
    remove(packageId: string) {
      return operation(async (id, signal) => {
        requireRole('owner'); identifiers(packageId); const { raw, doc, expected } = await load(id), item = doc.packages.find(value => value.packageId === packageId);
        if (!item) fail('not-found'); const approval = await approve(id, { action: 'remove', packageId });
        if (item.releases.length === 0) return finish(id, raw, doc, expected, approval);
        for (const entry of item.known) entry.status = 'removed'; item.releases = [];
        const encoded = await save(id, signal, raw, doc, expected, approval, { action: 'remove', packageId });
        return finish(id, encoded, doc, expected, approval);
      });
    },
    close() { if (closed) return; closed = true; epoch++; controller?.abort(); },
  });
}
