import { parseProcessorManifest, snapshotJson, snapshotResourceBytes, verifyAssetContent, parseProcessorExtensionRelease,
  PROCESSOR_EXTENSION_LIMITS as LIMITS, processorExtensionManifestSha256, processorExtensionSigningBytes,
  verifyProcessorExtensionRelease } from '@101/device-model';
import type { ProcessorExtensionRelease } from '@101/device-model';
import { createProcessorRegistry } from './processor-registry.ts';
import type { ResolvedProcessor, TrustedProcessorRegistration } from './processor-registry.ts';
import { runProcessorConformance } from './conformance.ts';
import type { ProcessorConformanceFixture } from './conformance.ts';

export interface ProcessorInstallationWriteGuard { readonly signal: AbortSignal; isCurrent(): boolean }
/** Host-owned atomic storage. All guards are checked at the commit, including late completions. */
export interface ProcessorInstallationStorage {
  read(key: string): Promise<string | undefined>;
  compareAndSwap(key: string, expected: string | undefined, value: string, guard: ProcessorInstallationWriteGuard): Promise<boolean>;
  /** Synchronous current revision truth fences execution after another controller's mutation. */
  isCurrent(key: string, expected: string): boolean;
}
export interface ProcessorPublisherTrust {
  readonly key: CryptoKey;
  /** Current provisioned external rollback floor. This is never restored from release data. */
  readonly minimumSequence: number;
}
export type ProcessorInstallationAction = 'install' | 'read-release' | 'activate-reviewed' | 'rollback-reviewed'
  | 'revoke-release' | 'revoke-publisher' | 'remove';
export interface ProcessorInstallationScope {
  readonly ownerId: string; readonly action: ProcessorInstallationAction;
  readonly packageId?: string; readonly version?: string; readonly publisherId?: string;
  readonly release?: Readonly<ProcessorExtensionRelease>;
}
/** Own data properties only; never persisted. A current grant is not a device route grant. */
export interface ProcessorInstallationApproval {
  readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal;
}
export type ProcessorInstallationFailure = 'invalid' | 'corrupt' | 'wrong-owner' | 'incompatible' | 'unavailable'
  | 'conflict' | 'capacity' | 'denied' | 'closed' | 'integrity' | 'revoked' | 'not-found' | 'duplicate-version'
  | 'downgrade' | 'untrusted' | 'conformance' | 'busy' | 'expired' | 'invalid-clock';
export type ProcessorInstallationResult<T> = Readonly<{ ok: true; value: T }> |
  Readonly<{ ok: false; reason: ProcessorInstallationFailure }>;
export interface ProcessorInstallationPackage {
  readonly packageId: string; readonly publisherId: string; readonly highestSequence: number;
  /** A historical selected version. Presence never proves current activation or effect. */
  readonly selectedVersion?: string; readonly active: boolean;
  readonly releases: readonly Readonly<{ release: Readonly<ProcessorExtensionRelease>; revoked: boolean }>[];
}
export interface ProcessorInstallationSnapshot {
  readonly ownerId: string; readonly revision: number;
  readonly packages: readonly ProcessorInstallationPackage[]; readonly revokedPublishers: readonly string[];
}
export interface ReviewedProcessorActivationRequest {
  readonly packageId: string; readonly version: string; readonly codeSha256: string;
  /** Host-reviewed exact factory binding, not obtained by executing incoming release data. */
  readonly trusted: TrustedProcessorRegistration;
  /** Independent host-authored expectations; a package's self-reported pass is not accepted. */
  readonly fixture: ProcessorConformanceFixture;
  readonly configuration: unknown;
  /** Required synchronous retirement of every owned route and derived output. */
  readonly retireOwned: () => void;
}
export interface ProcessorExtensionActivation {
  readonly processor: ResolvedProcessor;
  isCurrent(): boolean;
  close(): void;
}
export interface ProcessorInstallation {
  readonly key: string;
  install(release: unknown, source: Uint8Array): Promise<ProcessorInstallationResult<ProcessorInstallationSnapshot>>;
  inspect(): Promise<ProcessorInstallationResult<ProcessorInstallationSnapshot>>;
  readRelease(packageId: string, version: string): Promise<ProcessorInstallationResult<Readonly<{
    release: Readonly<ProcessorExtensionRelease>; source: Uint8Array;
  }>>>;
  activateReviewed(request: ReviewedProcessorActivationRequest): Promise<ProcessorInstallationResult<ProcessorExtensionActivation>>;
  rollbackReviewed(request: ReviewedProcessorActivationRequest): Promise<ProcessorInstallationResult<ProcessorExtensionActivation>>;
  revokeRelease(packageId: string, version: string): Promise<ProcessorInstallationResult<ProcessorInstallationSnapshot>>;
  revokePublisher(publisherId: string): Promise<ProcessorInstallationResult<ProcessorInstallationSnapshot>>;
  remove(packageId: string): Promise<ProcessorInstallationResult<ProcessorInstallationSnapshot>>;
  /** Retires authority and cleanup synchronously. The caller separately closes its storage. */
  close(): void;
}
export interface ProcessorInstallationOptions {
  readonly ownerId: string; readonly storage: ProcessorInstallationStorage;
  readonly publisherTrust: (publisherId: string) => ProcessorPublisherTrust | undefined;
  readonly authorize: (scope: ProcessorInstallationScope) => ProcessorInstallationApproval | undefined | Promise<ProcessorInstallationApproval | undefined>;
  readonly now?: () => number;
}
interface StoredRelease { release: Readonly<ProcessorExtensionRelease>; sourceBase64: string; revoked: boolean }
interface KnownVersion { version: string; codeSha256: string; sequence: number; releaseSha256: string; revoked: boolean }
interface StoredPackage { packageId: string; publisherId: string; highestSequence: number;
  selectedVersion?: string; releases: StoredRelease[]; known: KnownVersion[] }
interface Document { version: 1; ownerId: string; revision: number; packages: StoredPackage[]; revokedPublishers: string[] }
interface Active { release: Readonly<ProcessorExtensionRelease>; raw: string; approval: ProcessorInstallationApproval;
  trust: ProcessorPublisherTrust; processor: ResolvedProcessor; retireOwned: () => void; retired: boolean;
  checking: boolean; timer?: ReturnType<typeof setTimeout>; detach: () => void }
class InstallationError extends Error {
  readonly reason: ProcessorInstallationFailure;
  constructor(reason: ProcessorInstallationFailure) { super(reason); this.reason = reason; }
}
function fail(reason: ProcessorInstallationFailure): never { throw new InstallationError(reason); }
const ok = <T>(value: T): ProcessorInstallationResult<T> => Object.freeze({ ok: true, value });
const bad = (reason: ProcessorInstallationFailure): ProcessorInstallationResult<never> => Object.freeze({ ok: false, reason });
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid');
  return value as Record<string, unknown>;
}
function field(input: unknown, name: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(input), name);
  if (!descriptor && optional) return undefined;
  if (!descriptor || !('value' in descriptor)) fail('invalid');
  return descriptor.value;
}
function exact(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void {
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) fail('invalid');
}
function base64(source: Uint8Array): string {
  let value = ''; for (const byte of source) value += String.fromCharCode(byte); return btoa(value);
}
function unbase64(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(LIMITS.sourceBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('corrupt');
  const decoded = atob(value), bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (base64(bytes) !== value) fail('corrupt'); return bytes;
}
async function bounded<T>(promise: T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InstallationError('unavailable')), LIMITS.asyncMs);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function releaseIdentity(release: ProcessorExtensionRelease): Promise<string> {
  const payload = Object.fromEntries(Object.entries(release).filter(([key]) => key !== 'signature'));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', processorExtensionSigningBytes(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function trustSnapshot(value: unknown): ProcessorPublisherTrust {
  const input = object(value); exact(input, ['key', 'minimumSequence']);
  const key = field(value, 'key'), minimumSequence = field(value, 'minimumSequence');
  if (!integer(minimumSequence) || minimumSequence < 1 || !(key instanceof CryptoKey) || key.type !== 'public' ||
    key.algorithm.name !== 'ECDSA' || (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' || !key.usages.includes('verify')) fail('untrusted');
  return Object.freeze({ key, minimumSequence });
}
function document(raw: string | undefined, ownerId: string): Document {
  if (raw === undefined) return { version: 1, ownerId, revision: 0, packages: [], revokedPublishers: [] };
  if (new TextEncoder().encode(raw).byteLength > LIMITS.documentBytes) fail('corrupt');
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(raw)); } catch { fail('corrupt'); }
  if (value.version !== 1) fail('incompatible');
  if (value.ownerId !== ownerId) fail('wrong-owner');
  try {
    exact(value, ['version', 'ownerId', 'revision', 'packages', 'revokedPublishers']);
    if (!integer(value.revision) || !Array.isArray(value.packages) || value.packages.length > LIMITS.packages ||
      !Array.isArray(value.revokedPublishers) || value.revokedPublishers.length > LIMITS.revokedPublishers ||
      !value.revokedPublishers.every(identifier) || new Set(value.revokedPublishers).size !== value.revokedPublishers.length) fail('corrupt');
    let versions = 0;
    const packages = value.packages.map(input => {
      const item = object(input); exact(item, ['packageId', 'publisherId', 'highestSequence', 'releases', 'known'], ['selectedVersion']);
      if (!identifier(item.packageId) || !identifier(item.publisherId) || !integer(item.highestSequence) || item.highestSequence < 1 ||
        !Array.isArray(item.releases) || item.releases.length > LIMITS.releasesPerPackage || !Array.isArray(item.known) || item.known.length > LIMITS.knownVersions) fail('corrupt');
      const known: KnownVersion[] = item.known.map(input => {
        const entry = object(input); exact(entry, ['version', 'codeSha256', 'sequence', 'releaseSha256', 'revoked']);
        if (typeof entry.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
          entry.version.length > 64 || typeof entry.codeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.codeSha256) ||
          typeof entry.releaseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.releaseSha256) ||
          !integer(entry.sequence) || entry.sequence < 1 || entry.sequence > (item.highestSequence as number) || typeof entry.revoked !== 'boolean') fail('corrupt');
        return entry as unknown as KnownVersion;
      });
      versions += known.length;
      if (known.length < 1 || new Set(known.map(entry => entry.version)).size !== known.length ||
        new Set(known.map(entry => entry.sequence)).size !== known.length ||
        Math.max(...known.map(entry => entry.sequence)) !== item.highestSequence) fail('corrupt');
      const releases: StoredRelease[] = item.releases.map(input => {
        const entry = object(input); exact(entry, ['release', 'sourceBase64', 'revoked']);
        const release = parseProcessorExtensionRelease(entry.release), pinned = known.find(item => item.version === release.version);
        if (release.packageId !== item.packageId || release.publisherId !== item.publisherId || typeof entry.revoked !== 'boolean' ||
          !pinned || pinned.codeSha256 !== release.source.sha256 || pinned.sequence !== release.sequence || pinned.revoked !== entry.revoked) fail('corrupt');
        const source = unbase64(entry.sourceBase64);
        if (source.byteLength !== release.source.byteLength) fail('corrupt');
        return { release, sourceBase64: entry.sourceBase64 as string, revoked: entry.revoked };
      });
      if (new Set(releases.map(entry => entry.release.version)).size !== releases.length ||
        item.selectedVersion !== undefined && (typeof item.selectedVersion !== 'string' ||
          !releases.some(entry => entry.release.version === item.selectedVersion && !entry.revoked))) fail('corrupt');
      return { packageId: item.packageId, publisherId: item.publisherId, highestSequence: item.highestSequence,
        releases, known, ...(item.selectedVersion === undefined ? {} : { selectedVersion: item.selectedVersion as string }) };
    });
    if (versions > LIMITS.knownVersions || new Set(packages.map(item => item.packageId)).size !== packages.length) fail('corrupt');
    return { version: 1, ownerId, revision: value.revision, packages, revokedPublishers: value.revokedPublishers as string[] };
  } catch { fail('corrupt'); }
}

/** Stores signed data and executes only an explicit host-reviewed binding. This is not a sandbox. */
export function createProcessorInstallation(options: ProcessorInstallationOptions): ProcessorInstallation {
  const ownerValue = field(options, 'ownerId'), storageInput = field(options, 'storage');
  const authorize = field(options, 'authorize') as ProcessorInstallationOptions['authorize'];
  const publisherTrust = field(options, 'publisherTrust') as ProcessorInstallationOptions['publisherTrust'];
  const clock = (field(options, 'now', true) ?? Date.now) as () => number;
  const read = field(storageInput, 'read'), compare = field(storageInput, 'compareAndSwap'), revisionCurrent = field(storageInput, 'isCurrent');
  if (!identifier(ownerValue) || typeof authorize !== 'function' || typeof publisherTrust !== 'function' || typeof clock !== 'function' ||
    typeof read !== 'function' || typeof compare !== 'function' || typeof revisionCurrent !== 'function') fail('invalid');
  const ownerId: string = ownerValue;
  const storage: ProcessorInstallationStorage = { read: read.bind(storageInput), compareAndSwap: compare.bind(storageInput), isCurrent: revisionCurrent.bind(storageInput) };
  const key = `101:processor-installation:${encodeURIComponent(ownerId)}`;
  const active = new Set<Active>(), locallyRevoked = new Set<string>(), locallyRevokedPublishers = new Set<string>(), locallyRemoved = new Set<string>();
  let closed = false, busy = false, epoch = 0, lastTime = -1;
  let operationAbort: AbortController | undefined;
  function retire(entry: Active): void {
    if (entry.retired) return;
    entry.retired = true; active.delete(entry); if (entry.timer !== undefined) clearTimeout(entry.timer); entry.detach();
    try { entry.retireOwned(); } catch { /* Authority is already fenced; never retain private reasons. */ }
    try { entry.processor.reset(); } catch { /* A reviewed callback cannot restore authority. */ }
  }
  function retireWhere(predicate: (entry: Active) => boolean): void { for (const entry of [...active]) if (predicate(entry)) retire(entry); }
  function remember(set: Set<string>, value: string, maximum: number): void {
    if (!set.has(value) && set.size >= maximum) fail('capacity'); set.add(value);
  }
  function time(): number {
    let value: number; try { value = clock(); } catch { retireWhere(() => true); fail('invalid-clock'); }
    if (!integer(value) || value < lastTime) { retireWhere(() => true); fail('invalid-clock'); }
    lastTime = value; return value;
  }
  function approvalCurrent(approval: ProcessorInstallationApproval): boolean {
    try {
      const alive = !closed && time() < approval.expiresAt && !approval.signal?.aborted && approval.isCurrent() === true;
      return alive && !closed && time() < approval.expiresAt && !approval.signal?.aborted;
    } catch { return false; }
  }
  function trust(release: ProcessorExtensionRelease): ProcessorPublisherTrust {
    let value: ProcessorPublisherTrust; try { value = trustSnapshot(publisherTrust(release.publisherId)); } catch { fail('untrusted'); }
    if (closed || release.sequence < value.minimumSequence) fail('untrusted'); return value;
  }
  function trustCurrent(release: ProcessorExtensionRelease, expected: ProcessorPublisherTrust): boolean {
    try { const value = trust(release); return value.key === expected.key; } catch { return false; }
  }
  function locallyDenied(release: ProcessorExtensionRelease): boolean {
    return locallyRevoked.has(`${release.packageId}\0${release.version}`) || locallyRevokedPublishers.has(release.publisherId) || locallyRemoved.has(release.packageId);
  }
  function current(entry: Active): boolean {
    if (entry.retired || entry.checking) return false;
    entry.checking = true;
    let alive = false;
    try { alive = !locallyDenied(entry.release) && approvalCurrent(entry.approval) && trustCurrent(entry.release, entry.trust) &&
      storage.isCurrent(key, entry.raw) && !closed && !entry.retired; } catch { /* Fixed inactive outcome. */ }
    finally { entry.checking = false; }
    if (!alive) retire(entry); return alive;
  }
  async function operation<T>(run: (id: number, signal: AbortSignal) => Promise<T>): Promise<ProcessorInstallationResult<T>> {
    if (closed) return bad('closed'); if (busy) return bad('busy');
    busy = true; const id = ++epoch, controller = new AbortController(); operationAbort = controller;
    try { const value = await run(id, controller.signal); check(id); return ok(value); }
    catch (error) { return bad(error instanceof InstallationError ? error.reason : 'invalid'); }
    finally { controller.abort(); if (operationAbort === controller) operationAbort = undefined; epoch++; busy = false; }
  }
  function check(id: number): void { if (closed) fail('closed'); if (epoch !== id) fail('conflict'); }
  async function approve(id: number, scope: Omit<ProcessorInstallationScope, 'ownerId'>): Promise<ProcessorInstallationApproval> {
    time(); const input = await bounded(authorize(Object.freeze({ ownerId, ...scope }))); check(id);
    if (!input) fail('denied');
    const value = object(input); exact(value, ['expiresAt', 'isCurrent'], ['signal']);
    const expiresAt = field(input, 'expiresAt'), isCurrent = field(input, 'isCurrent'), signal = field(input, 'signal', true);
    const now = time();
    if (!integer(expiresAt) || expiresAt <= now || expiresAt > now + LIMITS.approvalMs || typeof isCurrent !== 'function' ||
      signal !== undefined && !(signal instanceof AbortSignal)) fail('denied');
    const approval = Object.freeze({ expiresAt, isCurrent: isCurrent as () => boolean, ...(signal === undefined ? {} : { signal: signal as AbortSignal }) });
    if (!approvalCurrent(approval)) fail('denied'); check(id); return approval;
  }
  function guard(id: number, approval: ProcessorInstallationApproval, release?: ProcessorExtensionRelease, expected?: ProcessorPublisherTrust): boolean {
    try { check(id); return approvalCurrent(approval) && (!release || !locallyDenied(release) && !!expected && trustCurrent(release, expected)) && !closed && epoch === id; }
    catch { return false; }
  }
  async function load(id: number): Promise<{ raw: string | undefined; doc: Document }> {
    let raw: string | undefined; try { raw = await bounded(storage.read(key)); } catch { fail('unavailable'); }
    check(id); const doc = document(raw, ownerId);
    for (const item of doc.packages) for (const entry of item.releases) {
      if (!await bounded(verifyAssetContent(entry.release.source, unbase64(entry.sourceBase64))) ||
        await bounded(processorExtensionManifestSha256(entry.release.manifest)) !== entry.release.manifestSha256 ||
        await bounded(releaseIdentity(entry.release)) !== item.known.find(value => value.version === entry.release.version)?.releaseSha256) fail('integrity');
      check(id);
    }
    return { raw, doc };
  }
  function snapshot(doc: Document): ProcessorInstallationSnapshot {
    return Object.freeze({ ownerId, revision: doc.revision, revokedPublishers: Object.freeze([...doc.revokedPublishers]),
      packages: Object.freeze(doc.packages.map(item => Object.freeze({ packageId: item.packageId, publisherId: item.publisherId,
        highestSequence: item.highestSequence, ...(item.selectedVersion === undefined ? {} : { selectedVersion: item.selectedVersion }),
        active: [...active].some(entry => entry.release.packageId === item.packageId && current(entry)),
        releases: Object.freeze(item.releases.map(entry => Object.freeze({ release: entry.release, revoked: entry.revoked }))) }))) });
  }
  async function save(id: number, signal: AbortSignal, raw: string | undefined, doc: Document, approval: ProcessorInstallationApproval,
    release?: ProcessorExtensionRelease, expected?: ProcessorPublisherTrust, retirePackage?: string): Promise<string> {
    if (!guard(id, approval, release, expected)) fail('denied');
    if (doc.revision >= Number.MAX_SAFE_INTEGER) fail('capacity'); doc.revision++;
    const encoded = JSON.stringify(doc);
    if (new TextEncoder().encode(encoded).byteLength > LIMITS.documentBytes) fail('capacity');
    let committed: boolean;
    try { committed = await bounded(storage.compareAndSwap(key, raw, encoded, { signal, isCurrent: () => guard(id, approval, release, expected) })); }
    catch { fail('unavailable'); }
    check(id); if (!committed) fail('conflict');
    if (retirePackage) retireWhere(entry => entry.release.packageId === retirePackage);
    if (!guard(id, approval, release, expected)) fail('denied');
    for (const entry of [...active]) {
      if (entry.raw !== raw) retire(entry); else entry.raw = encoded;
    }
    return encoded;
  }
  function find(doc: Document, packageId: string, version: string): { item: StoredPackage; entry: StoredRelease } {
    const item = doc.packages.find(item => item.packageId === packageId), entry = item?.releases.find(entry => entry.release.version === version);
    if (!item || !entry) fail('not-found'); return { item, entry };
  }
  function allow(doc: Document, entry: StoredRelease): void {
    if (entry.revoked || doc.revokedPublishers.includes(entry.release.publisherId) || locallyDenied(entry.release)) fail('revoked');
  }
  function identifiers(packageId: unknown, version?: unknown): void {
    if (!identifier(packageId) || version !== undefined && (typeof version !== 'string' || version.length > 64)) fail('invalid');
  }
  function activation(input: ReviewedProcessorActivationRequest, rollback: boolean): Promise<ProcessorInstallationResult<ProcessorExtensionActivation>> {
    return operation(async (id, signal) => {
      const request = object(input); exact(request, ['packageId', 'version', 'codeSha256', 'trusted', 'fixture', 'configuration', 'retireOwned']);
      const packageId = field(input, 'packageId'), version = field(input, 'version'), codeSha256 = field(input, 'codeSha256');
      identifiers(packageId, version);
      const registrationInput = field(input, 'trusted'), retireOwned = field(input, 'retireOwned');
      const manifest = parseProcessorManifest(field(registrationInput, 'manifest')), source = snapshotResourceBytes(field(registrationInput, 'source'));
      const factory = field(registrationInput, 'factory') as TrustedProcessorRegistration['factory'];
      const fixture = snapshotJson(field(input, 'fixture')) as unknown as ProcessorConformanceFixture, configuration = snapshotJson(field(input, 'configuration'));
      if (typeof factory !== 'function' || typeof retireOwned !== 'function') fail('invalid');
      const { raw, doc } = await load(id), { item, entry } = find(doc, packageId as string, version as string); allow(doc, entry);
      if (codeSha256 !== entry.release.source.sha256 || JSON.stringify(manifest) !== JSON.stringify(entry.release.manifest) ||
        source.byteLength !== entry.release.source.byteLength || base64(source) !== entry.sourceBase64) fail('untrusted');
      if (rollback ? item.selectedVersion === undefined || entry.release.sequence >= (item.releases.find(value => value.release.version === item.selectedVersion)?.release.sequence ?? 0)
        : item.selectedVersion !== entry.release.version && entry.release.sequence < item.highestSequence) fail('downgrade');
      const remainingHandles = [...active].filter(value => item.selectedVersion === entry.release.version || value.release.packageId !== item.packageId).length;
      if (remainingHandles >= LIMITS.handles) fail('capacity');
      const expected = trust(entry.release);
      if (!await bounded(verifyProcessorExtensionRelease(entry.release, unbase64(entry.sourceBase64), expected.key))) fail('integrity'); check(id);
      const approval = await approve(id, { action: rollback ? 'rollback-reviewed' : 'activate-reviewed',
        packageId: entry.release.packageId, version: entry.release.version, publisherId: entry.release.publisherId, release: entry.release });
      const registration: TrustedProcessorRegistration = { manifest, source, factory(configuration) {
        if (!guard(id, approval, entry.release, expected)) fail('denied');
        const implementation = factory(configuration);
        if (!guard(id, approval, entry.release, expected)) {
          try { implementation.reset(); } catch { /* Retire a late reviewed instance. */ } fail('denied');
        }
        return implementation;
      } };
      if (!guard(id, approval, entry.release, expected)) fail('denied');
      const conformanceRegistration: TrustedProcessorRegistration = { manifest, source, factory(configuration) {
        const implementation = registration.factory(configuration);
        return { process(inputs) {
          if (!guard(id, approval, entry.release, expected)) fail('denied');
          const result = implementation.process(inputs);
          if (!guard(id, approval, entry.release, expected)) fail('denied'); return result;
        }, reset() { implementation.reset(); } };
      } };
      const report = await bounded(runProcessorConformance(conformanceRegistration, fixture)); check(id);
      if (!guard(id, approval, entry.release, expected)) fail('denied'); if (report.outcome !== 'passed') fail('conformance');
      const registry = createProcessorRegistry(); await bounded(registry.registerTrusted(registration)); check(id);
      if (!guard(id, approval, entry.release, expected)) fail('denied');
      const processor = registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: manifest.codeSha256, configuration });
      let attached = false;
      try {
        if (!guard(id, approval, entry.release, expected)) fail('denied');
        const switched = item.selectedVersion !== entry.release.version;
        item.selectedVersion = entry.release.version;
        const newRaw = await save(id, signal, raw, doc, approval, entry.release, expected, switched ? item.packageId : undefined);
        if (!guard(id, approval, entry.release, expected)) fail('denied');
        const value: Active = { release: entry.release, raw: newRaw, approval, trust: expected, processor,
          retireOwned: retireOwned as () => void, retired: false, checking: false, detach() {} };
        active.add(value); attached = true;
        const stop = () => retire(value); approval.signal?.addEventListener('abort', stop, { once: true });
        value.detach = () => approval.signal?.removeEventListener('abort', stop);
        value.timer = setTimeout(stop, Math.max(1, approval.expiresAt - time())); (value.timer as unknown as { unref?: () => void }).unref?.();
        if (!current(value)) fail('denied');
        const wrapped = Object.freeze({ manifest: processor.manifest,
          process(inputs: unknown) {
            if (!current(value)) throw new TypeError('extension-inactive');
            try { const output = processor.process(inputs); if (!current(value)) throw new TypeError('extension-inactive'); return output; }
            catch { retire(value); throw new TypeError('extension-processor-failed'); }
          },
          reset() {
            if (!current(value)) throw new TypeError('extension-inactive');
            try { processor.reset(); if (!current(value)) throw new TypeError('extension-inactive'); }
            catch { retire(value); throw new TypeError('extension-processor-failed'); }
          },
        });
        return Object.freeze({ processor: wrapped, isCurrent: () => current(value), close: stop });
      } finally { if (!attached) try { processor.reset(); } catch { /* Never retain private errors. */ } }
    });
  }
  return Object.freeze({ key,
    install(input: unknown, inputBytes: Uint8Array) {
      return operation(async (id, signal) => {
        const release = parseProcessorExtensionRelease(input), source = snapshotResourceBytes(inputBytes), expected = trust(release);
        if (!await bounded(verifyProcessorExtensionRelease(release, source, expected.key))) fail('integrity'); check(id);
        const identity = await bounded(releaseIdentity(release)); check(id);
        const { raw, doc } = await load(id);
        if (doc.revokedPublishers.includes(release.publisherId) || locallyRevokedPublishers.has(release.publisherId) ||
          locallyRevoked.has(`${release.packageId}\0${release.version}`)) fail('revoked');
        let item = doc.packages.find(item => item.packageId === release.packageId);
        if (item && item.publisherId !== release.publisherId) fail('untrusted');
        const known = item?.known.find(value => value.version === release.version);
        if (known?.revoked) fail('revoked');
        if (known && (known.codeSha256 !== release.source.sha256 || known.sequence !== release.sequence || known.releaseSha256 !== identity)) fail('duplicate-version');
        const approval = await approve(id, { action: 'install', packageId: release.packageId, version: release.version,
          publisherId: release.publisherId, release });
        if (item?.releases.some(value => value.release.version === release.version)) return snapshot(doc);
        if (!known && item && release.sequence <= item.highestSequence) fail('downgrade');
        if (!known && doc.packages.reduce((count, item) => count + item.known.length, 0) >= LIMITS.knownVersions) fail('capacity');
        if (!item) {
          if (doc.packages.length >= LIMITS.packages) fail('capacity');
          item = { packageId: release.packageId, publisherId: release.publisherId, highestSequence: release.sequence, releases: [], known: [] };
          doc.packages.push(item);
        }
        if (item.releases.length >= LIMITS.releasesPerPackage) {
          const removable = item.releases.filter(value => value.release.version !== item!.selectedVersion)
            .sort((left, right) => left.release.sequence - right.release.sequence)[0];
          if (!removable) fail('capacity'); item.releases.splice(item.releases.indexOf(removable), 1);
        }
        item.highestSequence = Math.max(item.highestSequence, release.sequence);
        if (!known) item.known.push({ version: release.version, codeSha256: release.source.sha256, sequence: release.sequence, releaseSha256: identity, revoked: false });
        item.releases.push({ release, sourceBase64: base64(source), revoked: false });
        locallyRemoved.delete(release.packageId);
        await save(id, signal, raw, doc, approval, release, expected); return snapshot(doc);
      });
    },
    inspect() { return operation(async id => snapshot((await load(id)).doc)); },
    readRelease(packageId: string, version: string) {
      return operation(async id => {
        identifiers(packageId, version); const { raw, doc } = await load(id), { entry } = find(doc, packageId, version); allow(doc, entry);
        const expected = trust(entry.release);
        if (!await bounded(verifyProcessorExtensionRelease(entry.release, unbase64(entry.sourceBase64), expected.key))) fail('integrity'); check(id);
        const approval = await approve(id, { action: 'read-release', packageId, version, publisherId: entry.release.publisherId, release: entry.release });
        if (!guard(id, approval, entry.release, expected)) fail('denied');
        // Approval may await a human while another installation controller changes this owner document.
        if (raw === undefined || !storage.isCurrent(key, raw)) fail('conflict');
        if (!guard(id, approval, entry.release, expected)) fail('denied');
        return Object.freeze({ release: entry.release, source: unbase64(entry.sourceBase64) });
      });
    },
    activateReviewed(input: ReviewedProcessorActivationRequest) { return activation(input, false); },
    rollbackReviewed(input: ReviewedProcessorActivationRequest) { return activation(input, true); },
    revokeRelease(packageId: string, version: string) {
      return operation(async (id, signal) => {
        identifiers(packageId, version); const approval = await approve(id, { action: 'revoke-release', packageId, version });
        if ([...active].some(value => value.release.packageId === packageId && value.release.version === version)) {
          remember(locallyRevoked, `${packageId}\0${version}`, LIMITS.knownVersions);
          retireWhere(value => value.release.packageId === packageId && value.release.version === version);
        }
        const { raw, doc } = await load(id), item = doc.packages.find(value => value.packageId === packageId), known = item?.known.find(value => value.version === version);
        if (!item || !known) fail('not-found'); remember(locallyRevoked, `${packageId}\0${version}`, LIMITS.knownVersions); known.revoked = true;
        for (const entry of item.releases) if (entry.release.version === version) entry.revoked = true;
        if (item.selectedVersion === version) delete item.selectedVersion;
        await save(id, signal, raw, doc, approval); return snapshot(doc);
      });
    },
    revokePublisher(publisherId: string) {
      return operation(async (id, signal) => {
        identifiers(publisherId); const approval = await approve(id, { action: 'revoke-publisher', publisherId });
        remember(locallyRevokedPublishers, publisherId, LIMITS.revokedPublishers); retireWhere(value => value.release.publisherId === publisherId);
        const { raw, doc } = await load(id);
        if (!doc.revokedPublishers.includes(publisherId)) {
          if (doc.revokedPublishers.length >= LIMITS.revokedPublishers) fail('capacity'); doc.revokedPublishers.push(publisherId);
        }
        for (const item of doc.packages) if (item.publisherId === publisherId) delete item.selectedVersion;
        await save(id, signal, raw, doc, approval); return snapshot(doc);
      });
    },
    remove(packageId: string) {
      return operation(async (id, signal) => {
        identifiers(packageId); const approval = await approve(id, { action: 'remove', packageId });
        if ([...active].some(value => value.release.packageId === packageId)) {
          remember(locallyRemoved, packageId, LIMITS.packages); retireWhere(value => value.release.packageId === packageId);
        }
        const { raw, doc } = await load(id), item = doc.packages.find(item => item.packageId === packageId);
        if (!item) fail('not-found'); remember(locallyRemoved, packageId, LIMITS.packages); item.releases = []; delete item.selectedVersion;
        await save(id, signal, raw, doc, approval); return snapshot(doc);
      });
    },
    close() { if (closed) return; closed = true; epoch++; operationAbort?.abort(); retireWhere(() => true); },
  });
}
