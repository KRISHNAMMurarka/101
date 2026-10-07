import { snapshotJson } from '@101/device-model';
import type { AssetReference } from '@101/device-model';
import { createTelemetryHistory } from './telemetry-history.ts';
import type { TelemetryStorage } from './telemetry-storage.ts';
import type { TelemetryRecord } from './telemetry-history.ts';
import { createSettingsStore } from './settings-store.ts';
import type { SettingsStorage } from './settings-store.ts';
import { createDurableArtifactJobStore } from './durable-artifact-jobs.ts';
import type { ArtifactJobStorage, ArtifactJobWriteGuard } from './durable-artifact-jobs.ts';

export const OWNER_DATA_PROFILE = 'managed-owner-data/1';
export const OWNER_DATA_LIMITS = Object.freeze({ ownerBytes: 2 * 1024 * 1024, leases: 8, storageOperations: 8, pageRows: 32, pageBytes: 65536,
  copyRows: 64, copyBytes: 262144, auditRows: 128, auditBytes: 65536, auditRetentionMs: 30 * 86400000,
  grantMs: 60000, authorizationMs: 1000, artifactRetentionMs: 7 * 86400000 });
type Kind = 'telemetry' | 'settings' | 'artifacts' | 'copies';
const KINDS: readonly Kind[] = ['telemetry', 'settings', 'artifacts', 'copies'];
export type OwnerDataFailure = 'invalid' | 'corrupt' | 'incompatible' | 'wrong-owner' | 'unavailable' | 'denied' |
  'revoked' | 'expired' | 'closed' | 'busy' | 'capacity' | 'conflict' | 'review-required' | 'integrity' | 'invalid-clock' | 'not-found';
export type OwnerDataResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: OwnerDataFailure }>;
/** One synchronous mutation and its guard MUST commit in the same durable engine transaction. */
export interface OwnerDataStorage {
  transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T },
    guard?: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): Promise<T>;
}
export interface OwnerDataSelection {
  readonly kinds: readonly Kind[]; readonly purpose: string;
  /** Only kinds:['telemetry']. The controller also removes this resource's registered local copies. */
  readonly telemetryResourceId?: string;
}
export interface OwnerDataScope {
  readonly ownerId: string; readonly action: 'open-stores' | 'export' | 'copy' | 'delete' | 'resume-delete' | 'sweep';
  readonly epoch: number; readonly deadline: number; readonly maxBytes: number; readonly request: Readonly<Record<string, unknown>>;
}
export interface OwnerDataGrant {
  readonly scope: OwnerDataScope; readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal;
}
export interface OwnerDataAudit {
  readonly operationId: string; readonly action: 'deletion' | 'expiry'; readonly at: number; readonly expiresAt: number;
  readonly kinds: readonly Kind[]; readonly state: 'pending' | 'completed'; readonly removed: Readonly<Record<Kind, number>>;
}
export interface OwnerDataDeletion {
  readonly operationId: string; readonly kinds: readonly Kind[]; readonly state: 'pending' | 'completed';
  readonly completedStages: number; readonly startedAt: number; readonly updatedAt: number;
  readonly removed: Readonly<Record<Kind, number>>;
  /** Pending review only. Completed plans and redacted audit omit the selector. */
  readonly telemetryResourceId?: string;
}
export interface OwnerDataPorts {
  readonly telemetry: TelemetryStorage; readonly settings: SettingsStorage; readonly artifacts: ArtifactJobStorage;
  readonly signal: AbortSignal; close(): void;
}
interface Cursor { readonly epoch: number; readonly revision: number; readonly offset: number }
interface ExportRequest {
  readonly kind: Kind; readonly purpose: string; readonly destinationId: string; readonly limit?: number;
  readonly resourceId?: string; readonly fields?: readonly string[]; readonly includeArtifactBytes?: boolean; readonly cursor?: Cursor;
}
export interface OwnerDataExportPage {
  readonly profile: typeof OWNER_DATA_PROFILE; readonly kind: Kind; readonly records: readonly unknown[]; readonly next?: Cursor;
}
export interface OwnerDataController {
  openStores(options: { retireOwned(): void }): Promise<OwnerDataResult<OwnerDataPorts>>;
  exportPage(request: ExportRequest): Promise<OwnerDataResult<OwnerDataExportPage>>;
  storeLocalTelemetryCopy(batch: unknown, request: { purpose: string; destinationId: string }): Promise<OwnerDataResult<{ copied: number }>>;
  beginDeletion(selection: OwnerDataSelection): Promise<OwnerDataResult<OwnerDataDeletion>>;
  resumeDeletionReviewed(operationId: string): Promise<OwnerDataResult<OwnerDataDeletion>>;
  inspectDeletion(): Promise<OwnerDataResult<OwnerDataDeletion | undefined>>;
  sweep(): Promise<OwnerDataResult<{ telemetryRemoved: number; artifactsRemoved: number; copiesRemoved: number }>>;
  close(): void;
}
export interface OwnerDataOptions {
  readonly ownerId: string; readonly storage: OwnerDataStorage; readonly trustedNow: () => number;
  readonly authorize: (scope: OwnerDataScope) => OwnerDataGrant | undefined | Promise<OwnerDataGrant | undefined>;
  readonly availableDevices?: () => readonly string[];
  /** A collection retention window begins at its first write and updates never extend it. */
  readonly artifactRetentionMs?: number;
  /** Explicit trusted export classification. These pins are not read from a job or restored storage. */
  readonly reviewedArtifacts?: readonly Readonly<{ applicationId: string; destinationId: string; sha256: string }>[];
}
interface Copy { batchId: string; batchSha256: string; recordSha256: string; record: TelemetryRecord }
interface Envelope {
  version: 1; profile: typeof OWNER_DATA_PROFILE; ownerId: string; revision: number; dataRevision: number; epoch: number; lastNow: number;
  records: { telemetry?: unknown; settings?: string; artifacts?: string }; artifactExpiresAt?: number;
  copies: Copy[]; audit: OwnerDataAudit[]; deletion?: OwnerDataDeletion;
}
interface Lease { grant: OwnerDataGrant; epoch: number; abort: AbortController; retired: boolean;
  cleanup: () => void; timer?: ReturnType<typeof setTimeout>; detach?: () => void }
interface CommitFence { readonly signals: readonly AbortSignal[]; isCurrent(): boolean }
class DataError extends Error { readonly reason: OwnerDataFailure; constructor(reason: OwnerDataFailure) { super(reason); this.reason = reason; } }
class WriteCancelled extends Error { constructor() { super('managed-write-cancelled'); } }
function fail(reason: OwnerDataFailure): never { throw new DataError(reason); }
// Authority is the native signal's state/event, not an own shadow property or
// an overridable caller method. Intrinsic branding also rejects prototype-only
// impostors before a lease or producer guard is admitted.
const abortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const signalListen = EventTarget.prototype.addEventListener, signalUnlisten = EventTarget.prototype.removeEventListener;
function isSignal(input: unknown): input is AbortSignal {
  try { return typeof abortState?.call(input) === 'boolean'; } catch { return false; }
}
function signalAborted(signal?: AbortSignal): boolean {
  if (signal === undefined) return false;
  try { return abortState?.call(signal) !== false; } catch { return true; }
}
const ok = <T>(value: T): OwnerDataResult<T> => Object.freeze({ ok: true, value });
const bad = (reason: OwnerDataFailure): OwnerDataResult<never> => Object.freeze({ ok: false, reason });
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function canonical(input: unknown): string {
  if (Array.isArray(input)) return '[' + input.map(canonical).join(',') + ']';
  if (input !== null && typeof input === 'object') return '{' + Object.keys(input).sort().map(key => JSON.stringify(key) + ':' + canonical((input as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(input);
}
async function sha256(input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function verifyCopies(copies: readonly Copy[]) {
  for (const copy of copies) if (await sha256(copy.record) !== copy.recordSha256) fail('integrity');
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
    required.some(key => !Object.hasOwn(value, key))) fail('invalid');
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('invalid'); }
}
function kinds(input: unknown): Kind[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4 || input.some(value => !KINDS.includes(value)) || new Set(input).size !== input.length) fail('invalid');
  return KINDS.filter(kind => input.includes(kind));
}
function counts(): Record<Kind, number> { return { telemetry: 0, settings: 0, artifacts: 0, copies: 0 }; }
function validCounts(input: unknown) { const value = object(input); exact(value, KINDS); if (KINDS.some(kind => !integer(value[kind], 1000000))) fail('corrupt'); }
function copyRecord(input: unknown): TelemetryRecord {
  const value = object(input); exact(value, ['id', 'resourceId', 'schemaVersion', 'ingestedAt', 'expiresAt', 'sourceTime', 'quality', 'values'], ['provenance']);
  if (!integer(value.id) || value.id === 0 || !id(value.resourceId) || !integer(value.schemaVersion) || value.schemaVersion === 0 ||
    !integer(value.ingestedAt) || !integer(value.expiresAt) || value.expiresAt <= value.ingestedAt ||
    !['observed', 'unverified', 'valid', 'stale', 'unavailable'].includes(value.quality as string)) fail('corrupt');
  const clock = object(value.sourceTime); exact(clock, ['clockId', 'at']);
  if (!id(clock.clockId) || typeof clock.at !== 'number' || !Number.isFinite(clock.at) || clock.at < 0 || clock.at > Number.MAX_SAFE_INTEGER) fail('corrupt');
  const values = object(value.values), fields = Object.keys(values);
  if (fields.length < 1 || fields.length > 16 || fields.some(field => !id(field))) fail('corrupt');
  for (const entry of Object.values(values)) if (typeof entry !== 'boolean' && !(typeof entry === 'number' && Number.isFinite(entry)) &&
    !(typeof entry === 'string' && entry.length <= 128 && !/\p{Cc}/u.test(entry))) fail('corrupt');
  if (value.provenance !== undefined) {
    const provenance = object(value.provenance); exact(provenance, [], ['calibrationRevision', 'processorPin', 'unitConversion']);
    if (provenance.calibrationRevision !== undefined && (!integer(provenance.calibrationRevision, 2147483647) || provenance.calibrationRevision === 0) ||
      provenance.processorPin !== undefined && (typeof provenance.processorPin !== 'string' || !/^[0-9a-f]{64}$/.test(provenance.processorPin))) fail('corrupt');
    if (provenance.unitConversion !== undefined) { const conversion = object(provenance.unitConversion); exact(conversion, ['sourceUnit', 'targetUnit', 'decimalPlaces', 'maxAbsoluteError']);
      if (![conversion.sourceUnit, conversion.targetUnit].every(unit => typeof unit === 'string' && /^[A-Za-z0-9][A-Za-z0-9./%{}_-]{0,31}$/.test(unit)) ||
        !integer(conversion.decimalPlaces, 12) || typeof conversion.maxAbsoluteError !== 'number' || !Number.isFinite(conversion.maxAbsoluteError) || conversion.maxAbsoluteError < 0) fail('corrupt'); }
  }
  return value as unknown as TelemetryRecord;
}

/** Bounded JSON snapshot for the known managed envelope, including producer records deeper than descriptor JSON. */
export function snapshotOwnerDataState(input: unknown): unknown {
  let nodes = 0;
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 16) fail('capacity');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= OWNER_DATA_LIMITS.ownerBytes) return value;
    if (Array.isArray(value)) {
      if (value.length > 10000) fail('capacity');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || key !== 'length' && !/^\d+$/.test(key))) fail('invalid');
      return Array.from({ length: value.length }, (_, index) => {
        const item = descriptors[String(index)]; if (!item || !('value' in item)) fail('invalid'); return copy(item.value, depth + 1);
      });
    }
    const source = object(value), target: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string') fail('invalid'); const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) fail('invalid');
      Object.defineProperty(target, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return target;
  }
  const result = copy(input, 0); if (size(result) > OWNER_DATA_LIMITS.ownerBytes) fail('capacity'); return result;
}
function parse(raw: unknown, owner: string, now: number): Envelope {
  if (raw === undefined) return { version: 1, profile: OWNER_DATA_PROFILE, ownerId: owner, revision: 0, dataRevision: 0, epoch: 1,
    lastNow: now, records: {}, copies: [], audit: [] };
  const value = object(snapshotOwnerDataState(raw));
  if (value.ownerId !== owner) fail('wrong-owner');
  if (value.version !== 1 || value.profile !== OWNER_DATA_PROFILE) fail('incompatible');
  exact(value, ['version', 'profile', 'ownerId', 'revision', 'dataRevision', 'epoch', 'lastNow', 'records', 'copies', 'audit'], ['artifactExpiresAt', 'deletion']);
  if (![value.revision, value.dataRevision, value.epoch, value.lastNow].every(item => integer(item)) || value.epoch === 0) fail('corrupt');
  if ((value.lastNow as number) > now) fail('invalid-clock');
  const records = object(value.records); exact(records, [], ['telemetry', 'settings', 'artifacts']);
  if (records.settings !== undefined && (typeof records.settings !== 'string' || size(records.settings) > 8192) ||
    records.artifacts !== undefined && (typeof records.artifacts !== 'string' || size(records.artifacts) > 131072) ||
    records.telemetry !== undefined && size(records.telemetry) > 1048576) fail('corrupt');
  for (const kind of ['telemetry', 'settings', 'artifacts'] as const) {
    if (records[kind] === undefined) continue;
    let header: Record<string, unknown>;
    try { header = object(kind === 'telemetry' ? records[kind] : JSON.parse(records[kind] as string)); } catch { fail('corrupt'); }
    if (header.ownerId !== owner) fail('wrong-owner');
    if (header.version !== (kind === 'settings' ? 2 : 1)) fail('incompatible');
    exact(header, kind === 'telemetry' ? ['version', 'ownerId', 'epoch', 'nextId', 'lastNow', 'bytes', 'rows'] :
      kind === 'settings' ? ['version', 'ownerId', 'revision', 'preferences', 'profiles'] : ['version', 'ownerId', 'revision', 'jobs']);
  }
  if (value.artifactExpiresAt !== undefined && !integer(value.artifactExpiresAt)) fail('corrupt');
  if (records.artifacts !== undefined && value.artifactExpiresAt === undefined || records.artifacts === undefined && value.artifactExpiresAt !== undefined) fail('corrupt');
  if (!Array.isArray(value.copies) || value.copies.length > OWNER_DATA_LIMITS.copyRows || size(value.copies) > OWNER_DATA_LIMITS.copyBytes) fail('corrupt');
  const copyIds = new Set<string>();
  for (const input of value.copies) { const copy = object(input); exact(copy, ['batchId', 'batchSha256', 'recordSha256', 'record']);
    if (!id(copy.batchId) || [copy.batchSha256, copy.recordSha256].some(pin => typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin))) fail('corrupt'); const record = copyRecord(copy.record);
    const key = `${copy.batchId}:${record.id}`; if (copyIds.has(key)) fail('corrupt'); copyIds.add(key); }
  if (!Array.isArray(value.audit) || value.audit.length > OWNER_DATA_LIMITS.auditRows || size(value.audit) > OWNER_DATA_LIMITS.auditBytes) fail('corrupt');
  for (const input of value.audit) { const event = object(input); exact(event, ['operationId', 'action', 'at', 'expiresAt', 'kinds', 'state', 'removed']);
    if (!id(event.operationId) || !['deletion', 'expiry'].includes(event.action as string) || !integer(event.at) || !integer(event.expiresAt) ||
      event.expiresAt !== (event.at as number) + OWNER_DATA_LIMITS.auditRetentionMs || !['pending', 'completed'].includes(event.state as string)) fail('corrupt');
    kinds(event.kinds); validCounts(event.removed); }
  if (new Set(value.audit.map(event => event.operationId)).size !== value.audit.length) fail('corrupt');
  if (value.deletion !== undefined) { const deletion = object(value.deletion);
    exact(deletion, ['operationId', 'kinds', 'state', 'completedStages', 'startedAt', 'updatedAt', 'removed'], ['telemetryResourceId']);
    const selected = kinds(deletion.kinds);
    if (!id(deletion.operationId) || !['pending', 'completed'].includes(deletion.state as string) ||
      !integer(deletion.completedStages, selected.length) || !integer(deletion.startedAt) || !integer(deletion.updatedAt) ||
      (deletion.completedStages === selected.length) !== (deletion.state === 'completed')) fail('corrupt');
    if (deletion.telemetryResourceId !== undefined && (!id(deletion.telemetryResourceId) || deletion.state !== 'pending' ||
      selected.join(',') !== 'telemetry,copies')) fail('corrupt');
    validCounts(deletion.removed); }
  return value as unknown as Envelope;
}

/** Selected local SDK profile only. It does not discover existing databases or unmanaged recipients. */
export function createOwnerDataController(options: OwnerDataOptions): OwnerDataController {
  if (!id(options.ownerId) || typeof options.storage?.transact !== 'function' || typeof options.trustedNow !== 'function' || typeof options.authorize !== 'function') throw new TypeError('Invalid owner data scope');
  const owner = options.ownerId, storage = options.storage, trustedNow = options.trustedNow, authorize = options.authorize;
  const artifactRetention = options.artifactRetentionMs ?? OWNER_DATA_LIMITS.artifactRetentionMs;
  if (!integer(artifactRetention, OWNER_DATA_LIMITS.artifactRetentionMs) || artifactRetention === 0) throw new TypeError('Invalid artifact retention');
  const reviewed = snapshotJson(options.reviewedArtifacts ?? []) as unknown as NonNullable<OwnerDataOptions['reviewedArtifacts']>;
  if (!Array.isArray(reviewed) || reviewed.length > 8 || reviewed.some(pin => { const value = object(pin); exact(value, ['applicationId', 'destinationId', 'sha256']);
    return !id(value.applicationId) || !id(value.destinationId) || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256); })) throw new TypeError('Invalid reviewed artifact pins');
  let closed = false, clockFault = false, lastNow = -1, busy = false;
  const lifetime = new AbortController(), leases = new Set<Lease>();
  function retire(lease: Lease) {
    if (lease.retired) return; lease.retired = true; lease.abort.abort(); clearTimeout(lease.timer); lease.detach?.(); leases.delete(lease);
    try { lease.cleanup(); } catch { /* Cleanup cannot restore a storage epoch or imply external effect cancellation. */ }
  }
  function retireAll() { for (const lease of [...leases]) retire(lease); }
  function now(): number {
    if (closed) fail('closed'); if (clockFault) fail('invalid-clock');
    let value: unknown; try { value = trustedNow(); } catch { value = undefined; }
    if (closed) fail('closed'); if (clockFault) fail('invalid-clock');
    if (!integer(value, Number.MAX_SAFE_INTEGER - OWNER_DATA_LIMITS.auditRetentionMs) || value < lastNow) { clockFault = true; retireAll(); fail('invalid-clock'); }
    lastNow = value; return value;
  }
  function check(grant: OwnerDataGrant) {
    const time = now(); if (signalAborted(grant.signal)) fail('revoked'); if (time >= grant.expiresAt) fail('expired');
    let current = false; try { current = grant.isCurrent() === true; } catch { /* Reject a unavailable current-authority source. */ }
    if (!current || closed || signalAborted(grant.signal)) fail(closed ? 'closed' : 'revoked');
    if (now() >= grant.expiresAt) fail('expired');
    if (closed || signalAborted(grant.signal)) fail(closed ? 'closed' : 'revoked');
  }
  async function transaction<T>(mutation: (state: Envelope) => T, grant?: OwnerDataGrant, fence?: CommitFence): Promise<T> {
    const commit = new AbortController(), signals = new Set([lifetime.signal, ...(grant?.signal ? [grant.signal] : []), ...(fence?.signals ?? [])]);
    const abort = () => commit.abort(); let rejected = false;
    function checkFence() {
      // The supplied producer observer may advance the trusted clock. Check
      // expiry and native cancellation again after that callback returns.
      if (fence && (!fence.isCurrent() || signalAborted(commit.signal) ||
          grant && now() >= grant.expiresAt || signalAborted(commit.signal))) {
        rejected = true; throw new WriteCancelled();
      }
    }
    const guard = { signal: commit.signal, isCurrent() { try { if (grant) check(grant); else now(); checkFence(); return !signalAborted(commit.signal); } catch { return false; } } };
    try {
      for (const signal of signals) { signalListen.call(signal, 'abort', abort, { once: true }); if (signalAborted(signal)) abort(); }
      now();
      return await storage.transact(owner, raw => {
      const time = now(); if (grant) check(grant); const state = parse(raw, owner, time);
      checkFence(); const before = JSON.stringify(state), result = mutation(state); if (grant) check(grant); else now(); checkFence();
      state.lastNow = time;
      if (before !== JSON.stringify(state)) { if (state.revision >= Number.MAX_SAFE_INTEGER) fail('capacity'); state.revision++; }
      if (size(state.audit) > OWNER_DATA_LIMITS.auditBytes || size(state) > OWNER_DATA_LIMITS.ownerBytes) fail('capacity');
      return { state: snapshotOwnerDataState(state), result };
    }, guard); } catch (error) {
      if (signalAborted(commit.signal) || rejected) throw new WriteCancelled();
      if (error instanceof DataError) { if (error.reason === 'invalid-clock') { clockFault = true; retireAll(); } throw error; }
      if (grant) check(grant); return fail('unavailable');
    } finally { for (const signal of signals) signalUnlisten.call(signal, 'abort', abort); }
  }
  async function attempt<T>(action: () => Promise<T>): Promise<OwnerDataResult<T>> {
    if (busy) return bad('busy'); busy = true;
    try { now(); return ok(await action()); } catch (error) { return bad(error instanceof DataError ? error.reason : 'unavailable'); }
    finally { busy = false; }
  }
  async function approval(action: OwnerDataScope['action'], request: Readonly<Record<string, unknown>>, allowPending = false) {
    const state = await transaction(value => value);
    if (!allowPending && state.deletion?.state === 'pending') fail('review-required');
    await verifyCopies(state.copies); now();
    const scope: OwnerDataScope = Object.freeze({ ownerId: owner, action, epoch: state.epoch, deadline: now() + OWNER_DATA_LIMITS.grantMs,
      maxBytes: action === 'export' ? OWNER_DATA_LIMITS.pageBytes : action === 'copy' ? 32768 : OWNER_DATA_LIMITS.ownerBytes,
      request: Object.freeze(snapshotJson(request) as Record<string, unknown>) });
    const received = await new Promise<unknown>(resolve => {
      let settled = false; const timer = setTimeout(() => finish(undefined), OWNER_DATA_LIMITS.authorizationMs);
      function finish(value: unknown) { if (settled) return; settled = true; clearTimeout(timer); signalUnlisten.call(lifetime.signal, 'abort', abort); resolve(value); }
      function abort() { finish(undefined); }
      signalListen.call(lifetime.signal, 'abort', abort, { once: true });
      Promise.resolve().then(() => { now(); return authorize(scope); }).then(finish, () => finish(undefined));
    });
    now(); let grant: OwnerDataGrant;
    try { const value = object(received); exact(value, ['scope', 'expiresAt', 'isCurrent'], ['signal']);
      if (JSON.stringify(snapshotJson(value.scope)) !== JSON.stringify(scope) || !integer(value.expiresAt) || value.expiresAt <= now() ||
        value.expiresAt > scope.deadline || typeof value.isCurrent !== 'function' || value.signal !== undefined && !isSignal(value.signal)) fail('denied');
      grant = Object.freeze({ scope, expiresAt: value.expiresAt, isCurrent: value.isCurrent as () => boolean,
        ...(value.signal === undefined ? {} : { signal: value.signal as AbortSignal }) });
    } catch { fail('denied'); }
    check(grant); await transaction(value => { if (value.epoch !== scope.epoch || !allowPending && value.deletion?.state === 'pending') fail('conflict'); }, grant);
    return grant;
  }
  function currentState(state: Envelope, grant: OwnerDataGrant) {
    check(grant); if (state.epoch !== grant.scope.epoch || state.deletion?.state === 'pending') fail('review-required');
  }
  function dataChanged(state: Envelope) { if (state.dataRevision >= Number.MAX_SAFE_INTEGER) fail('capacity'); state.dataRevision++; }
  function ports(grant: OwnerDataGrant, cleanup: () => void, tracked: boolean, revision?: { value: number }, validateExpiredArtifacts = false): OwnerDataPorts {
    const lease: Lease = { grant, epoch: grant.scope.epoch, abort: new AbortController(), retired: false, cleanup };
    function active() { if (lease.retired) fail('revoked'); try { check(grant); if (lease.retired || signalAborted(lease.abort.signal)) fail('revoked'); }
      catch (error) { retire(lease); throw error; } }
    async function access<T>(operation: (state: Envelope) => T, producer?: ArtifactJobWriteGuard): Promise<T> {
      const fence: CommitFence = { signals: [lease.abort.signal, ...(producer?.signal ? [producer.signal] : [])], isCurrent() {
        try { active(); if (signalAborted(producer?.signal)) return false;
          const current = !producer?.isCurrent || producer.isCurrent() === true;
          return current && !lease.retired && !signalAborted(lease.abort.signal) && !signalAborted(lifetime.signal) && !signalAborted(grant.signal) && !signalAborted(producer?.signal);
        } catch { return false; }
      } };
      active(); try { return await transaction(state => {
        active(); currentState(state, grant); if (revision && revision.value !== state.dataRevision) fail('conflict');
        const result = operation(state); active(); if (revision) revision.value = state.dataRevision; return result;
      }, grant, fence); }
      catch (error) { if (error instanceof DataError && ['review-required', 'revoked', 'expired', 'closed', 'invalid-clock'].includes(error.reason)) retire(lease); throw error; }
    }
    if (tracked) {
      try {
        // Finish trusted callbacks before installing owned resources. Reentrant retirement cannot reacquire them.
        active(); const delay = Math.max(1, grant.expiresAt - lastNow);
        leases.add(lease); lease.timer = setTimeout(() => retire(lease), delay);
        if (grant.signal) { const signal = grant.signal, abort = () => retire(lease); lease.detach = () => signalUnlisten.call(signal, 'abort', abort);
          signalListen.call(signal, 'abort', abort, { once: true }); }
        if (lease.retired || closed || signalAborted(grant.signal)) fail(closed ? 'closed' : 'revoked');
      } catch (error) { retire(lease); throw error; }
    }
    const settingsKey = `101.settings:${owner}`, artifactsKey = `101.artifact-jobs:${owner}`;
    return Object.freeze({
      signal: lease.abort.signal, close() { retire(lease); },
      telemetry: Object.freeze<TelemetryStorage>({ transact: (requested, mutate) => access(state => {
        if (requested !== owner || typeof mutate !== 'function') fail('wrong-owner');
        const next = mutate(structuredClone(state.records.telemetry)); const value = object(next); exact(value, ['state', 'result']);
        const copied = snapshotOwnerDataState(value.state); if (size(copied) > 1048576) fail('capacity');
        // The actual producer has already validated its envelope. Audit removal of expired source rows in this same commit.
        const previous = state.records.telemetry === undefined ? [] : object(state.records.telemetry).rows;
        const retained = object(copied).rows;
        if (!Array.isArray(previous) || !Array.isArray(retained)) fail('corrupt');
        const removed = previous.filter(row => { const record = object(row); return integer(record.expiresAt) && record.expiresAt <= now() && !retained.some(next => object(next).id === record.id); }).length;
        if (removed) { const time = now(); audit(state, { operationId: crypto.randomUUID(), action: 'expiry', at: time,
          expiresAt: time + OWNER_DATA_LIMITS.auditRetentionMs, kinds: ['telemetry'], state: 'completed', removed: { ...counts(), telemetry: removed } }, time); }
        // A projection must not create a new producer epoch merely to report an empty collection.
        if (!(state.records.telemetry === undefined && !tracked && retained.length === 0) &&
          JSON.stringify(copied) !== JSON.stringify(state.records.telemetry)) { state.records.telemetry = copied; dataChanged(state); }
        return value.result as never;
      }) }),
      settings: Object.freeze<SettingsStorage>({ read: key => access(state => { if (key !== settingsKey) fail('wrong-owner'); return state.records.settings; }),
        compareAndSwap: async (key, expected, value) => { try { return await access(state => {
          if (key !== settingsKey) fail('wrong-owner'); if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 4096) fail('capacity');
          if (state.records.settings !== expected) return false; if (value !== expected) { state.records.settings = value; dataChanged(state); } return true;
        }); } catch (error) { if (error instanceof WriteCancelled) return false; throw error; } } }),
      artifacts: Object.freeze<ArtifactJobStorage>({ read: key => access(state => { if (key !== artifactsKey) fail('wrong-owner');
        if (!validateExpiredArtifacts && state.artifactExpiresAt !== undefined && state.artifactExpiresAt <= now()) fail('expired'); return state.records.artifacts; }),
        compareAndSwap: async (key, expected, value, guard) => {
          let producer: ArtifactJobWriteGuard | undefined;
          if (guard !== undefined) { const source = object(guard); exact(source, [], ['signal', 'isCurrent']);
            if (source.signal !== undefined && !isSignal(source.signal) || source.isCurrent !== undefined && typeof source.isCurrent !== 'function') fail('invalid');
            producer = Object.freeze({ ...(source.signal === undefined ? {} : { signal: source.signal as AbortSignal }),
              ...(source.isCurrent === undefined ? {} : { isCurrent: source.isCurrent as () => boolean }) }); }
          try { return await access(state => {
          if (key !== artifactsKey) fail('wrong-owner'); if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 65536) fail('capacity');
          if (state.artifactExpiresAt !== undefined && state.artifactExpiresAt <= now()) fail('expired');
          if (state.records.artifacts !== expected) return false;
          active(); if (value !== expected) { state.records.artifacts = value; state.artifactExpiresAt ??= now() + artifactRetention; dataChanged(state); } return true;
        }, producer); } catch (error) { if (error instanceof WriteCancelled) return false; throw error; } } }),
    });
  }
  function request(input: unknown): ExportRequest {
    const value = object(snapshotJson(input)); exact(value, ['kind', 'purpose', 'destinationId'], ['limit', 'resourceId', 'fields', 'includeArtifactBytes', 'cursor']);
    if (!KINDS.includes(value.kind as Kind) || !id(value.purpose) || !id(value.destinationId) || !integer(value.limit ?? 32, 32) || value.limit === 0) fail('invalid');
    if (value.resourceId !== undefined && !id(value.resourceId) || value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 16 || value.fields.some(field => !id(field)) || new Set(value.fields).size !== value.fields.length) ||
      value.includeArtifactBytes !== undefined && typeof value.includeArtifactBytes !== 'boolean') fail('invalid');
    if (value.kind !== 'telemetry' && (value.fields !== undefined || value.resourceId !== undefined) || value.kind !== 'artifacts' && value.includeArtifactBytes !== undefined) fail('invalid');
    if (value.cursor !== undefined) { const cursor = object(value.cursor); exact(cursor, ['epoch', 'revision', 'offset']); if (!Object.values(cursor).every(item => integer(item))) fail('invalid'); }
    return Object.freeze(value as unknown as ExportRequest);
  }
  function producerFailure(result: { ok: boolean; reason?: string }) { if (!result.ok) fail(result.reason === 'integrity' ? 'integrity' : 'corrupt'); }
  async function telemetryRows(source: OwnerDataPorts, resourceId?: string): Promise<TelemetryRecord[]> {
    const history = createTelemetryHistory({ ownerId: owner, storage: source.telemetry, trustedNow: now, authorize: () => undefined });
    try { const rows: TelemetryRecord[] = []; let afterId = 0;
      for (let pages = 0; pages < 4; pages++) { const page = await history.exportPage({ limit: 64, afterId, ...(resourceId ? { resourceId } : {}) });
        if (!page.ok) fail('corrupt'); rows.push(...page.records); if (page.nextAfterId === undefined) return rows; afterId = page.nextAfterId; }
      fail('capacity');
    } finally { history.close(); }
  }
  async function artifactRows(source: OwnerDataPorts, grant: OwnerDataGrant, includeBytes: boolean): Promise<unknown[]> {
    const jobs = createDurableArtifactJobStore({ ownerId: owner, storage: source.artifacts, now,
      authorize: () => { check(grant); return { expiresAt: grant.expiresAt, isCurrent: () => { try { check(grant); return true; } catch { return false; } }, signal: grant.signal }; } });
    try { const inspected = await jobs.inspect(); producerFailure(inspected); if (!inspected.ok) fail('corrupt');
      const results: unknown[] = [];
      for (const job of inspected.value.jobs) {
        let retained: Readonly<{ reference: AssetReference; bytes: Uint8Array }> | undefined;
        if (job.output) { const output = await jobs.readOutput(job.request.idempotencyKey); producerFailure(output); if (output.ok) retained = output.value; }
        if (includeBytes && retained && !reviewed.some(pin => pin.applicationId === job.request.applicationId && pin.destinationId === job.request.destinationId && pin.sha256 === retained!.reference.sha256)) fail('denied');
        results.push(Object.freeze({ idempotencyKey: job.request.idempotencyKey, applicationId: job.request.applicationId,
          profileId: job.request.profileId, profileRevision: job.request.profileRevision, destinationId: job.request.destinationId,
          historicalOutcome: job.lastKnownState, requiresReview: job.requiresReview, createdAt: job.createdAt, updatedAt: job.updatedAt,
          evidence: retained ? 'verified-local-artifact' : 'none', ...(retained ? { output: retained.reference } : {}),
          ...(includeBytes && retained ? { bytesBase64: encode(retained.bytes) } : {}) }));
      }
      return results;
    } finally {
      // Projection never owns or resumes a job. Close must not rewrite running history from this temporary reader.
      await jobs.close();
    }
  }
  function encode(bytes: Uint8Array) { let result = ''; for (let at = 0; at < bytes.length; at++) result += String.fromCharCode(bytes[at]!); return btoa(result); }
  function audit(state: Envelope, event: OwnerDataAudit, time: number) {
    state.audit = state.audit.filter(item => item.expiresAt > time && item.operationId !== event.operationId);
    if (state.audit.length >= OWNER_DATA_LIMITS.auditRows) fail('capacity'); state.audit.push(event);
    if (size(state.audit) > OWNER_DATA_LIMITS.auditBytes) fail('capacity');
  }
  function redacted(deletion: OwnerDataDeletion, action: 'deletion' | 'expiry', time: number): OwnerDataAudit {
    return Object.freeze({ operationId: deletion.operationId, action, at: time, expiresAt: time + OWNER_DATA_LIMITS.auditRetentionMs,
      kinds: deletion.kinds, state: deletion.state, removed: deletion.removed });
  }
  function empty(state: Envelope, kind: Kind): number {
    let removed = 0;
    if (kind === 'copies') { removed = state.copies.length; state.copies = []; }
    else if (kind === 'telemetry') { const raw = state.records.telemetry; if (raw !== undefined) removed = Array.isArray(object(raw).rows) ? (object(raw).rows as unknown[]).length : 1; delete state.records.telemetry; }
    else if (kind === 'artifacts') { const raw = state.records.artifacts; if (raw !== undefined) { const value = object(JSON.parse(raw)); removed = Array.isArray(value.jobs) ? value.jobs.length : 1; }
      delete state.records.artifacts; delete state.artifactExpiresAt; }
    else { removed = state.records.settings === undefined ? 0 : 1; delete state.records.settings; }
    if (removed) dataChanged(state); return removed;
  }
  async function stageTelemetryRemoval(input: unknown, resourceId: string, grant: OwnerDataGrant) {
    // No host storage is written here. The authoritative history producer validates,
    // expires, deletes, assigns its epoch and accounts bytes in a bounded snapshot.
    // The returned snapshot is admitted only by the owner CAS/final guard below.
    let staged = input === undefined ? undefined : snapshotOwnerDataState(input);
    const stagedStorage: TelemetryStorage = Object.freeze({ async transact<T>(requested: string,
      mutation: (current: unknown) => { state: unknown; result: T }): Promise<T> {
      if (requested !== owner) fail('wrong-owner'); check(grant);
      const next = mutation(staged === undefined ? undefined : snapshotOwnerDataState(staged));
      check(grant); const value = object(next); exact(value, ['state', 'result']);
      staged = snapshotOwnerDataState(value.state); return value.result as T;
    } });
    const history = createTelemetryHistory({ ownerId: owner, storage: stagedStorage, trustedNow: now, authorize: () => undefined });
    try {
      const result = await history.delete(resourceId); check(grant);
      if (!result.ok) fail(result.reason === 'invalid-clock' ? 'invalid-clock' : 'corrupt');
      const absent = await history.exportPage({ resourceId, limit: 1 }); check(grant);
      if (!absent.ok || absent.records.length !== 0) fail('integrity');
      return Object.freeze({ state: input === undefined ? undefined : staged, removed: result.removed, expired: history.status().expired });
    } finally { history.close(); }
  }
  async function resumeSelectedDeletion(operationId: string, resourceId: string, grant: OwnerDataGrant) {
    const initial = await transaction(state => {
      check(grant); const deletion = state.deletion;
      if (state.epoch !== grant.scope.epoch) fail('conflict');
      if (!deletion || deletion.operationId !== operationId || deletion.state !== 'pending' || deletion.telemetryResourceId !== resourceId) fail('conflict');
      return state;
    }, grant);
    const previous = initial.deletion!, kind = previous.kinds[previous.completedStages]!;
    if (kind !== 'telemetry' && kind !== 'copies') fail('corrupt');
    const staged = kind === 'telemetry' ? await stageTelemetryRemoval(initial.records.telemetry, resourceId, grant) : undefined;
    check(grant);
    return transaction(state => {
      check(grant); const current = state.deletion;
      if (state.epoch !== grant.scope.epoch || state.dataRevision !== initial.dataRevision || !current ||
        current.operationId !== operationId || current.state !== 'pending' || current.telemetryResourceId !== resourceId ||
        current.completedStages !== previous.completedStages) fail('conflict');
      let removed = 0;
      if (kind === 'telemetry') {
        if (!staged) fail('integrity'); removed = staged.removed;
        if (JSON.stringify(state.records.telemetry) !== JSON.stringify(staged.state)) {
          if (staged.state === undefined) delete state.records.telemetry; else state.records.telemetry = staged.state;
          dataChanged(state);
        }
        if (staged.expired) { const time = now(); audit(state, { operationId: crypto.randomUUID(), action: 'expiry', at: time,
          expiresAt: time + OWNER_DATA_LIMITS.auditRetentionMs, kinds: ['telemetry'], state: 'completed',
          removed: Object.freeze({ ...counts(), telemetry: staged.expired }) }, time); }
      } else {
        // These closed records and hashes were validated by parse/approval; this is
        // registered-copy selection, not a second parser for producer history.
        const before = state.copies.length;
        state.copies = state.copies.filter(copy => copy.record.resourceId !== resourceId);
        removed = before - state.copies.length; if (removed) dataChanged(state);
      }
      const completedStages = previous.completedStages + 1, completed = completedStages === previous.kinds.length;
      const { telemetryResourceId: pendingSelector, ...redactedPlan } = previous;
      const deletion: OwnerDataDeletion = Object.freeze({ ...redactedPlan,
        ...(!completed ? { telemetryResourceId: pendingSelector } : {}),
        removed: Object.freeze({ ...previous.removed, [kind]: removed }), completedStages,
        state: completed ? 'completed' : 'pending', updatedAt: now() });
      const event = state.audit.find(event => event.operationId === operationId);
      audit(state, Object.freeze({ ...(event ?? redacted(deletion, 'deletion', now())), state: deletion.state, removed: deletion.removed }), now());
      state.deletion = deletion; return deletion;
    }, grant);
  }
  const controller: OwnerDataController = {
    openStores: input => attempt(async () => {
      const value = object(input); exact(value, ['retireOwned']); if (typeof value.retireOwned !== 'function') fail('invalid');
      if (leases.size >= OWNER_DATA_LIMITS.leases) fail('capacity');
      const grant = await approval('open-stores', { kinds: KINDS, artifactRetentionMs: artifactRetention });
      return ports(grant, value.retireOwned as () => void, true);
    }),
    exportPage: input => attempt(async () => {
      const selected = request(input), grant = await approval('export', selected as unknown as Record<string, unknown>);
      const initial = await transaction(state => { currentState(state, grant); if (selected.cursor && (selected.cursor.epoch !== state.epoch || selected.cursor.revision !== state.dataRevision)) fail('conflict'); return { epoch: state.epoch, revision: state.dataRevision }; }, grant);
      const revision = { value: initial.revision }, source = ports(grant, () => {}, false, revision);
      try {
        let rows: unknown[];
        if (selected.kind === 'telemetry') rows = (await telemetryRows(source, selected.resourceId)).map(record => {
          const fields = selected.fields ?? Object.keys(record.values), values: Record<string, number | boolean | string> = {};
          for (const field of fields) { if (!Object.hasOwn(record.values, field)) fail('invalid'); values[field] = record.values[field]!; }
          // Explicit scalar/boolean/enum observation fields only; owner/grants/upload configuration are not in this projection.
          return Object.freeze({ id: record.id, resourceId: record.resourceId, schemaVersion: record.schemaVersion, sourceTime: record.sourceTime,
            quality: record.quality, ingestedAt: record.ingestedAt, expiresAt: record.expiresAt, values: Object.freeze(values) });
        });
        else if (selected.kind === 'settings') { const settings = createSettingsStore({ ownerId: owner, storage: source.settings, availableDevices: options.availableDevices ?? (() => []) });
          const loaded = await settings.load(); producerFailure(loaded); if (!loaded.ok) fail('corrupt'); rows = [{ preferences: loaded.value.preferences, profiles: loaded.value.profiles }]; }
        else if (selected.kind === 'artifacts') rows = await artifactRows(source, grant, selected.includeArtifactBytes === true);
        else rows = await transaction(state => { currentState(state, grant); return state.copies.filter(copy => copy.record.expiresAt > now()).map(copy => copy.record); }, grant);
        const state = await transaction(value => { currentState(value, grant); if (value.epoch !== initial.epoch || value.dataRevision !== revision.value || selected.cursor && selected.cursor.revision !== revision.value) fail('conflict'); return value; }, grant);
        const offset = selected.cursor?.offset ?? 0, page: unknown[] = [];
        if (offset > rows.length) fail('invalid');
        for (const row of rows.slice(offset, offset + (selected.limit ?? 32))) { if (size({ profile: OWNER_DATA_PROFILE, kind: selected.kind, records: [...page, row], next: { epoch: state.epoch, revision: state.dataRevision, offset: offset + page.length + 1 } }) > OWNER_DATA_LIMITS.pageBytes) { if (page.length === 0) fail('capacity'); break; } page.push(row); }
        check(grant);
        return Object.freeze({ profile: OWNER_DATA_PROFILE, kind: selected.kind, records: Object.freeze(page),
          ...(offset + page.length < rows.length ? { next: Object.freeze({ epoch: state.epoch, revision: state.dataRevision, offset: offset + page.length }) } : {}) });
      } finally { source.close(); }
    }),
    storeLocalTelemetryCopy: (input, details) => attempt(async () => {
      const value = object(snapshotJson(input)); exact(value, ['batchId', 'records']);
      const request = object(snapshotJson(details)); exact(request, ['purpose', 'destinationId']);
      if (!id(value.batchId) || !Array.isArray(value.records) || value.records.length < 1 || value.records.length > 16 || size(value.records) > 32768 ||
        !id(request.purpose) || request.destinationId !== 'local-recipient') fail('invalid');
      const rows = value.records.map(copyRecord); if (new Set(rows.map(record => record.id)).size !== rows.length) fail('invalid');
      const batchSha256 = await sha256(value), recordPins = await Promise.all(rows.map(sha256));
      const grant = await approval('copy', { ...request, batchId: value.batchId, recordIds: value.records.map(record => object(record).id),
        // Pin the complete public batch, not a caller chosen mutable object or merely its ID.
        records: value.records });
      const revision = { value: await transaction(state => { currentState(state, grant); return state.dataRevision; }, grant) };
      const source = ports(grant, () => {}, false, revision);
      try { const available = await telemetryRows(source);
        for (const row of rows) { if (!available.some(record => {
          const selected = object(row); exact(selected, ['id', 'resourceId', 'schemaVersion', 'ingestedAt', 'expiresAt', 'sourceTime', 'quality', 'values'], ['provenance']);
          const values = object(row.values), fields = Object.keys(values); if (fields.length < 1 || fields.length > 16 || fields.some(field => !Object.hasOwn(record.values, field))) return false;
          const projected = { ...record, values: Object.fromEntries(fields.map(field => [field, record.values[field]])) };
          if (!Object.hasOwn(selected, 'provenance')) delete projected.provenance;
          return canonical(projected) === canonical(row);
        })) fail('integrity'); }
        return await transaction(state => { currentState(state, grant); if (state.dataRevision !== revision.value) fail('conflict'); let copied = 0;
          if (state.copies.some(copy => copy.batchId === value.batchId && copy.batchSha256 !== batchSha256)) fail('conflict');
          for (let index = 0; index < rows.length; index++) { const row = rows[index]!, previous = state.copies.find(copy => copy.batchId === value.batchId && copy.record.id === row.id);
            if (previous) { if (canonical(previous.record) !== canonical(row)) fail('integrity'); continue; }
            state.copies.push({ batchId: value.batchId as string, batchSha256, recordSha256: recordPins[index]!, record: row }); copied++; }
          if (state.copies.length > OWNER_DATA_LIMITS.copyRows || size(state.copies) > OWNER_DATA_LIMITS.copyBytes) fail('capacity');
          if (copied) dataChanged(state); return Object.freeze({ copied }); }, grant);
      } finally { source.close(); }
    }),
    beginDeletion: input => attempt(async () => {
      const value = object(snapshotJson(input)); exact(value, ['kinds', 'purpose'], ['telemetryResourceId']); if (!id(value.purpose)) fail('invalid');
      let selected = kinds(value.kinds);
      if (Object.hasOwn(value, 'telemetryResourceId') && (!id(value.telemetryResourceId) || selected.join(',') !== 'telemetry')) fail('invalid');
      const selector = value.telemetryResourceId === undefined ? {} : { telemetryResourceId: value.telemetryResourceId as string };
      if (selected.includes('telemetry') && !selected.includes('copies')) selected = kinds([...selected, 'copies']);
      const grant = await approval('delete', { kinds: selected, purpose: value.purpose, ...selector });
      const revision = { value: await transaction(state => { currentState(state, grant); return state.dataRevision; }, grant) };
      const source = ports(grant, () => {}, false, revision, true);
      try {
        // Read through the actual producer validators. Unreadable/future/foreign bytes require a separate recovery decision.
        if (selected.includes('telemetry')) await telemetryRows(source);
        if (selected.includes('settings')) { const settings = createSettingsStore({ ownerId: owner, storage: source.settings, availableDevices: options.availableDevices ?? (() => []) }); producerFailure(await settings.load()); }
        if (selected.includes('artifacts')) await artifactRows(source, grant, false);
      } finally { source.close(); }
      retireAll();
      return transaction(state => { currentState(state, grant); if (state.dataRevision !== revision.value) fail('conflict'); const time = now(); if (state.epoch >= Number.MAX_SAFE_INTEGER) fail('capacity');
        const deletion: OwnerDataDeletion = Object.freeze({ operationId: crypto.randomUUID(), kinds: Object.freeze(selected), state: 'pending', completedStages: 0,
          startedAt: time, updatedAt: time, removed: Object.freeze(counts()), ...selector });
        audit(state, redacted(deletion, 'deletion', time), time); state.epoch++; state.deletion = deletion; dataChanged(state); return deletion; }, grant);
    }),
    resumeDeletionReviewed: operationId => attempt(async () => {
      if (!id(operationId)) fail('invalid');
      const pending = await transaction(state => state.deletion);
      const resourceId = pending?.operationId === operationId ? pending.telemetryResourceId : undefined;
      const grant = await approval('resume-delete', { operationId, ...(resourceId ? { telemetryResourceId: resourceId } : {}) }, true);
      if (resourceId) return resumeSelectedDeletion(operationId, resourceId, grant);
      const result = await transaction(state => { check(grant); const previous = state.deletion;
        if (!previous || previous.operationId !== operationId) fail('not-found'); if (previous.state === 'completed') return previous;
        const kind = previous.kinds[previous.completedStages]!;
        const removed = { ...previous.removed, [kind]: empty(state, kind) }, completedStages = previous.completedStages + 1;
        const deletion: OwnerDataDeletion = Object.freeze({ ...previous, removed: Object.freeze(removed), completedStages,
          state: completedStages === previous.kinds.length ? 'completed' : 'pending', updatedAt: now() });
        state.deletion = deletion;
        const event = state.audit.find(event => event.operationId === operationId);
        audit(state, Object.freeze({ ...(event ?? redacted(deletion, 'deletion', now())), state: deletion.state, removed: deletion.removed }), now()); return deletion; }, grant);
      return transaction(state => { check(grant); if (state.deletion?.operationId !== operationId || state.deletion.completedStages < result.completedStages) fail('conflict');
        for (const kind of result.kinds.slice(0, result.completedStages)) if (kind === 'copies' ? state.copies.length > 0 : state.records[kind] !== undefined) fail('integrity');
        return state.deletion; }, grant);
    }),
    inspectDeletion: () => attempt(() => transaction(state => state.deletion)),
    sweep: () => attempt(async () => {
      const grant = await approval('sweep', { kinds: KINDS, artifactRetentionMs: artifactRetention }, true);
      const initial = await transaction(state => { if (state.deletion?.state === 'pending') fail('review-required'); return state; }, grant);
      const source = ports(grant, () => {}, false);
      let telemetryRemoved = 0;
      try { const history = createTelemetryHistory({ ownerId: owner, storage: source.telemetry, trustedNow: now, authorize: () => undefined });
        const result = await history.sweep(); if (!result.ok) fail('corrupt'); telemetryRemoved = result.removed; history.close();
      } finally { source.close(); }
      const artifactsExpire = initial.artifactExpiresAt !== undefined && initial.artifactExpiresAt <= now();
      if (artifactsExpire) retireAll();
      return transaction(state => { currentState(state, grant); const time = now(), before = state.copies.length;
        state.copies = state.copies.filter(copy => copy.record.expiresAt > time); const copiesRemoved = before - state.copies.length;
        const artifactsRemoved = state.artifactExpiresAt !== undefined && state.artifactExpiresAt <= time ? empty(state, 'artifacts') : 0;
        state.audit = state.audit.filter(event => event.expiresAt > time);
        if (artifactsExpire) { if (state.epoch >= Number.MAX_SAFE_INTEGER) fail('capacity'); state.epoch++; dataChanged(state); }
        if (copiesRemoved) dataChanged(state);
        // Telemetry's own transaction already retains its required audit alongside removed rows.
        if (artifactsRemoved || copiesRemoved) { const removed = { ...counts(), artifacts: artifactsRemoved, copies: copiesRemoved };
          audit(state, { operationId: crypto.randomUUID(), action: 'expiry', at: time, expiresAt: time + OWNER_DATA_LIMITS.auditRetentionMs,
            kinds: KINDS.filter(kind => removed[kind] > 0), state: 'completed', removed }, time); }
        return Object.freeze({ telemetryRemoved, artifactsRemoved, copiesRemoved }); }, grant);
    }),
    close() { if (closed) return; closed = true; lifetime.abort(); retireAll(); },
  };
  return Object.freeze(controller);
}
