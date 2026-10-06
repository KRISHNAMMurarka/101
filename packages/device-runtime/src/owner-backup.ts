import { createAssetReference, parseAssetReference, snapshotResourceBytes, verifyAssetContent } from '@101/device-model';
import type { AssetReference } from '@101/device-model';
import { createOwnerDataController, OWNER_DATA_LIMITS, OWNER_DATA_PROFILE, snapshotOwnerDataState } from './owner-data.ts';
import type { OwnerDataAudit, OwnerDataDeletion, OwnerDataOptions, OwnerDataStorage } from './owner-data.ts';

export const OWNER_BACKUP_PROFILE = 'managed-owner-backup/1';
export const OWNER_BACKUP_LIMITS = Object.freeze({ archives: 2, archiveBytes: 131072, managedBytes: 1572864,
  ownerBytes: 2097152, retentionMs: 7 * 86400000, grantMs: 60000, operationMs: 5000, authorizationMs: 1000 });
export type OwnerBackupFailure = 'invalid' | 'corrupt' | 'incompatible' | 'wrong-owner' | 'fence-missing' | 'review-required' |
  'integrity' | 'denied' | 'revoked' | 'expired' | 'closed' | 'busy' | 'capacity' | 'conflict' | 'unavailable' | 'invalid-clock' | 'not-found' | 'unsupported';
export type OwnerBackupResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: OwnerBackupFailure }>;
export interface OwnerBackupScope {
  readonly ownerId: string; readonly action: 'migrate-reviewed' | 'backup' | 'read-backup' | 'restore-reviewed' | 'inspect' | 'sweep';
  readonly purpose: string; readonly destinationId: 'local-recovery'; readonly epoch: number; readonly dataRevision: number;
  readonly recoveryRevision: number; readonly stateSha256: string; readonly deadline: number; readonly maxBytes: number;
  readonly backupId?: string; readonly backupSha256?: string;
  readonly registeredCopies?: Readonly<{ selection: 'all-registered-local'; count: number; sha256: string }>;
}
/** Current own-data properties only; approval and callbacks never enter the recovery document. */
export interface OwnerBackupGrant { readonly scope: OwnerBackupScope; readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal }
export interface OwnerBackupReceipt {
  readonly backupId: string; readonly reference: Readonly<AssetReference>; readonly createdAt: number; readonly expiresAt: number;
  readonly epoch: number; readonly dataRevision: number;
}
export interface OwnerBackupRequest { readonly backupId: string; readonly purpose: string; readonly destinationId: 'local-recovery';
  /** Explicit inclusion of the complete registered local recipient-copy set, never remote copies. */
  readonly registeredCopies?: 'include' }
export interface OwnerBackupOptions {
  readonly ownerId: string; readonly storage: OwnerDataStorage; readonly trustedNow: () => number;
  readonly authorize: (scope: OwnerBackupScope) => OwnerBackupGrant | undefined | Promise<OwnerBackupGrant | undefined>;
  readonly availableDevices?: () => readonly string[];
  readonly reviewedArtifacts?: OwnerDataOptions['reviewedArtifacts'];
}
export interface OwnerBackupController {
  /** Host storage port for the existing managed owner controller; it establishes no recording/route grant. */
  readonly managedStorage: OwnerDataStorage;
  migrateReviewed(request: { purpose: string; destinationId: 'local-recovery'; registeredCopies?: 'include' }): Promise<OwnerBackupResult<{ epoch: number; dataRevision: number }>>;
  backup(request: OwnerBackupRequest): Promise<OwnerBackupResult<OwnerBackupReceipt>>;
  readBackup(request: OwnerBackupRequest): Promise<OwnerBackupResult<Readonly<{ receipt: OwnerBackupReceipt; bytes: Uint8Array }>>>;
  restoreReviewed(request: OwnerBackupRequest & { expectedSha256: string; retireOwned(): void }): Promise<OwnerBackupResult<{ epoch: number; dataRevision: number }>>;
  inspect(request: { purpose: string; destinationId: 'local-recovery' }): Promise<OwnerBackupResult<Readonly<{ epoch: number; dataRevision: number; archives: readonly OwnerBackupReceipt[] }>>>;
  sweep(request: { purpose: string; destinationId: 'local-recovery' }): Promise<OwnerBackupResult<{ removed: number }>>;
  /** Retires authority synchronously; completion waits for actual owned asynchronous work. */
  close(): Promise<void>;
}
interface Managed {
  version: 1; profile: typeof OWNER_DATA_PROFILE; ownerId: string; revision: number; dataRevision: number; epoch: number; lastNow: number;
  records: { telemetry?: unknown; settings?: string; artifacts?: string }; copies: unknown[]; audit: OwnerDataAudit[];
  artifactExpiresAt?: number; deletion?: OwnerDataDeletion;
}
interface Archive extends OwnerBackupReceipt { bytesBase64: string }
interface Recovery {
  version: 1; profile: typeof OWNER_BACKUP_PROFILE; ownerId: string; revision: number; epoch: number; dataRevision: number; lastNow: number;
  managed?: unknown; audit: OwnerDataAudit[]; deletion?: OwnerDataDeletion; archives: Archive[]; fenceChecksum: string;
}
interface Payload { version: 1; profile: typeof OWNER_BACKUP_PROFILE; ownerId: string; createdAt: number; expiresAt: number; managed: Managed }
interface Operation { readonly abort: AbortController; readonly pending: Set<Promise<void>>;
  onSettled?: () => void; grant?: OwnerBackupGrant; archiveExpiresAt?: number;
  registeredCopies?: OwnerBackupScope['registeredCopies'] }
class BackupError extends Error { readonly reason: OwnerBackupFailure; constructor(reason: OwnerBackupFailure) { super(reason); this.reason = reason; } }
function fail(reason: OwnerBackupFailure): never { throw new BackupError(reason); }
const ok = <T>(value: T): OwnerBackupResult<T> => Object.freeze({ ok: true, value });
const encoder = new TextEncoder();
const abortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const signalListen = EventTarget.prototype.addEventListener;
const signalUnlisten = EventTarget.prototype.removeEventListener;
function signalAborted(signal?: AbortSignal): boolean {
  if (!signal) return false;
  try { return abortState?.call(signal) !== false; } catch { return true; }
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) fail('invalid');
  for (const key of Reflect.ownKeys(value)) { const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !('value' in property)) fail('invalid'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function copy<T>(value: T): T { return value === undefined ? value : snapshotOwnerDataState(value) as T; }
function byteSize(value: unknown) { return encoder.encode(canonical(value)).byteLength; }
function encode(bytes: Uint8Array) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function decode(value: string) { try { return Uint8Array.from(atob(value), byte => byte.charCodeAt(0)); } catch { return fail('corrupt'); } }
async function digest(value: unknown) { const hash = await crypto.subtle.digest('SHA-256', encoder.encode(canonical(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''); }
function audit(input: unknown): OwnerDataAudit[] {
  if (!Array.isArray(input) || input.length > OWNER_DATA_LIMITS.auditRows || byteSize(input) > OWNER_DATA_LIMITS.auditBytes) fail('corrupt');
  const seen = new Set<string>();
  for (const row of input) {
    const value = object(row); exact(value, ['operationId', 'action', 'at', 'expiresAt', 'kinds', 'state', 'removed']);
    if (!id(value.operationId) || seen.has(value.operationId) || !['deletion', 'expiry'].includes(value.action as string) ||
      !integer(value.at) || value.expiresAt !== value.at + OWNER_DATA_LIMITS.auditRetentionMs || !['pending', 'completed'].includes(value.state as string) ||
      !Array.isArray(value.kinds) || value.kinds.length < 1 || value.kinds.length > 4 || new Set(value.kinds).size !== value.kinds.length ||
      value.kinds.some(kind => !['telemetry', 'settings', 'artifacts', 'copies'].includes(kind))) fail('corrupt');
    const counts = object(value.removed); exact(counts, ['telemetry', 'settings', 'artifacts', 'copies']);
    if (Object.values(counts).some(count => !integer(count) || count > 1000000)) fail('corrupt'); seen.add(value.operationId);
  }
  return copy(input as OwnerDataAudit[]);
}
function deletion(input: unknown): OwnerDataDeletion | undefined {
  if (input === undefined) return undefined;
  const value = object(input); exact(value, ['operationId', 'kinds', 'state', 'completedStages', 'startedAt', 'updatedAt', 'removed']);
  if (!id(value.operationId) || !Array.isArray(value.kinds) || value.kinds.length < 1 || value.kinds.length > 4 ||
    new Set(value.kinds).size !== value.kinds.length || value.kinds.some(kind => !['telemetry', 'settings', 'artifacts', 'copies'].includes(kind)) ||
    !['pending', 'completed'].includes(value.state as string) || !integer(value.completedStages) || value.completedStages > value.kinds.length ||
    (value.completedStages === value.kinds.length) !== (value.state === 'completed') || !integer(value.startedAt) || !integer(value.updatedAt) || value.updatedAt < value.startedAt) fail('corrupt');
  const counts = object(value.removed); exact(counts, ['telemetry', 'settings', 'artifacts', 'copies']);
  if (Object.values(counts).some(count => !integer(count) || count > 1000000)) fail('corrupt');
  return copy(value as unknown as OwnerDataDeletion);
}
function managed(input: unknown, owner: string): Managed {
  const value = object(copy(input));
  if (value.ownerId !== owner) fail('wrong-owner');
  if (value.version !== 1 || value.profile !== OWNER_DATA_PROFILE) fail('incompatible');
  exact(value, ['version', 'profile', 'ownerId', 'revision', 'dataRevision', 'epoch', 'lastNow', 'records', 'copies', 'audit'], ['artifactExpiresAt', 'deletion']);
  if (![value.revision, value.dataRevision, value.epoch, value.lastNow].every(integer) || value.epoch === 0 || byteSize(value) > OWNER_BACKUP_LIMITS.managedBytes) fail('corrupt');
  exact(object(value.records), [], ['telemetry', 'settings', 'artifacts']);
  if (!Array.isArray(value.copies)) fail('corrupt'); audit(value.audit); deletion(value.deletion);
  if (value.artifactExpiresAt !== undefined && !integer(value.artifactExpiresAt)) fail('corrupt');
  return value as unknown as Managed;
}
function currentManaged(state: Recovery, owner: string, time: number): Managed {
  const value = managed(state.managed, owner);
  if (value.epoch !== state.epoch || value.dataRevision !== state.dataRevision ||
    canonical(value.audit.filter(row => row.expiresAt > time)) !== canonical(state.audit.filter(row => row.expiresAt > time)) ||
    canonical(value.deletion) !== canonical(state.deletion)) fail('corrupt');
  return value;
}
function recovery(input: unknown, owner: string, time: number): Recovery {
  if (input === undefined) fail('fence-missing');
  const value = object(copy(input));
  if (value.ownerId !== owner) fail('wrong-owner');
  if (value.version !== 1 || value.profile !== OWNER_BACKUP_PROFILE) fail('incompatible');
  exact(value, ['version', 'profile', 'ownerId', 'revision', 'epoch', 'dataRevision', 'lastNow', 'audit', 'archives', 'fenceChecksum'], ['managed', 'deletion']);
  if (![value.revision, value.epoch, value.dataRevision, value.lastNow].every(integer) || (value.lastNow as number) > time) fail('corrupt');
  const retainedAudit = audit(value.audit), retainedDeletion = deletion(value.deletion);
  if (!Array.isArray(value.archives) || value.archives.length > OWNER_BACKUP_LIMITS.archives) fail('capacity');
  const seen = new Set<string>();
  for (const input of value.archives) { const row = object(input); exact(row, ['backupId', 'reference', 'createdAt', 'expiresAt', 'epoch', 'dataRevision', 'bytesBase64']);
    if (!id(row.backupId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.backupId) || seen.has(row.backupId) ||
      ![row.createdAt, row.expiresAt, row.epoch, row.dataRevision].every(integer) || (row.createdAt as number) > time ||
      (row.expiresAt as number) <= (row.createdAt as number) || (row.expiresAt as number) - (row.createdAt as number) > OWNER_BACKUP_LIMITS.retentionMs ||
      row.epoch !== value.epoch || row.dataRevision !== value.dataRevision || typeof row.bytesBase64 !== 'string' ||
      row.bytesBase64.length > Math.ceil(OWNER_BACKUP_LIMITS.archiveBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.bytesBase64)) fail('corrupt');
    const reference = parseAssetReference(row.reference);
    if (reference.id !== `backup:${row.backupId}` || reference.kind !== 'blob' || reference.byteLength > OWNER_BACKUP_LIMITS.archiveBytes) fail('corrupt'); seen.add(row.backupId);
  }
  const result = { ...(value as unknown as Recovery), audit: retainedAudit, ...(retainedDeletion ? { deletion: retainedDeletion } : {}) };
  if (result.fenceChecksum !== seal(result)) fail('integrity'); return result;
}
function receipt(row: Archive): OwnerBackupReceipt { return Object.freeze(copy({ backupId: row.backupId, reference: row.reference,
  createdAt: row.createdAt, expiresAt: row.expiresAt, epoch: row.epoch, dataRevision: row.dataRevision })); }
/** Accidental metadata corruption detection, not authentication. Archive content separately uses native SHA-256. */
function seal(state: Recovery) {
  const metadata = { version: state.version, profile: state.profile, ownerId: state.ownerId, revision: state.revision,
    epoch: state.epoch, dataRevision: state.dataRevision, lastNow: state.lastNow, audit: state.audit,
    ...(state.deletion ? { deletion: state.deletion } : {}), archives: state.archives.map(receipt) };
  let checksum = 0xffffffff;
  for (const byte of encoder.encode(canonical(metadata))) { checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = checksum >>> 1 ^ (checksum & 1 ? 0xedb88320 : 0); }
  return 'crc32:' + ((checksum ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function selected(input: unknown, withId = false, restore = false, allowCopies = withId) {
  const value = object(input); exact(value, ['purpose', 'destinationId', ...(withId ? ['backupId'] : []), ...(restore ? ['expectedSha256', 'retireOwned'] : [])],
    allowCopies ? ['registeredCopies'] : []);
  if (!id(value.purpose) || value.destinationId !== 'local-recovery' || withId && (typeof value.backupId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.backupId)) ||
    restore && (typeof value.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedSha256) || typeof value.retireOwned !== 'function') ||
    Object.hasOwn(value, 'registeredCopies') && value.registeredCopies !== 'include') fail('invalid');
  return { purpose: value.purpose, destinationId: 'local-recovery' as const, ...(withId ? { backupId: value.backupId as string } : {}),
    ...(restore ? { expectedSha256: value.expectedSha256 as string, retireOwned: value.retireOwned as () => void } : {}),
    ...(value.registeredCopies === 'include' ? { registeredCopies: 'include' as const } : {}) };
}

/** Local recovery only with an intact durable fence. Hashes detect corruption, not malicious host tampering. */
export function createOwnerBackupController(options: OwnerBackupOptions): OwnerBackupController {
  if (!id(options.ownerId) || typeof options.storage?.transact !== 'function' || typeof options.trustedNow !== 'function' || typeof options.authorize !== 'function') throw new TypeError('Invalid owner backup configuration');
  const owner = options.ownerId, storage = options.storage, clock = options.trustedNow, authorize = options.authorize;
  const reviewed = copy(options.reviewedArtifacts ?? []);
  let closed = false, clockFault = false, previous = -1, busy = false;
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>(); let closing: Promise<void> | undefined;
  function track<T>(work: Promise<T>, operation: Operation): Promise<T> {
    const settled = work.then(finished, finished); pending.add(settled); operation.pending.add(settled);
    function finished() { pending.delete(settled); operation.pending.delete(settled); operation.onSettled?.(); }
    return work;
  }
  function now() {
    if (closed) fail('closed'); if (clockFault) fail('invalid-clock');
    let value: unknown; try { value = clock(); } catch { value = undefined; }
    if (closed) fail('closed'); if (clockFault) fail('invalid-clock');
    if (!integer(value) || value < previous || value > Number.MAX_SAFE_INTEGER - OWNER_DATA_LIMITS.auditRetentionMs) { clockFault = true; lifetime.abort(); fail('invalid-clock'); }
    previous = value; return value;
  }
  function check(operation: Operation) {
    const time = now(); if (signalAborted(operation.abort.signal)) fail(closed ? 'closed' : 'expired');
    if (operation.archiveExpiresAt !== undefined && time >= operation.archiveExpiresAt) fail('expired');
    const grant = operation.grant; if (!grant) return;
    if (signalAborted(grant.signal)) fail('revoked'); if (time >= grant.expiresAt) fail('expired');
    let current = false; try { current = grant.isCurrent() === true; } catch { /* Current owner authority is required. */ }
    if (closed || !current || signalAborted(grant.signal) || signalAborted(operation.abort.signal)) fail(closed ? 'closed' : 'revoked');
    if (now() >= Math.min(grant.expiresAt, operation.archiveExpiresAt ?? Infinity)) fail('expired');
    if (closed || signalAborted(grant.signal) || signalAborted(operation.abort.signal)) fail(closed ? 'closed' : 'revoked');
  }
  async function tx<T>(mutate: (raw: unknown) => { state: unknown; result: T }, operation: Operation,
    producer?: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) {
    const abort = new AbortController(), signals = new Set([lifetime.signal, operation.abort.signal,
      ...(operation.grant?.signal ? [operation.grant.signal] : []), ...(producer ? [producer.signal] : [])]);
    const stop = () => abort.abort();
    const current = () => { check(operation); if (producer && (!producer.isCurrent() || signalAborted(producer.signal))) return false;
      check(operation); return !signalAborted(abort.signal) && !signalAborted(producer?.signal); };
    let mutationFailed = false, mutationFailure: unknown;
    try {
      for (const signal of signals) { signalListen.call(signal, 'abort', stop, { once: true }); if (signalAborted(signal)) stop(); }
      if (!current()) fail('revoked');
      // Reserve before entering a supplied storage call, including direct managedStorage writers.
      const work = track(Promise.resolve().then(() => { if (!current()) fail('revoked'); return storage.transact(owner, raw => { try { if (!current()) fail('revoked'); const next = mutate(raw);
        if (byteSize(next.state) > OWNER_BACKUP_LIMITS.ownerBytes) fail('capacity'); if (!current()) fail('revoked'); return next;
      } catch (error) { mutationFailed = true; mutationFailure = error; throw error; } },
      { signal: abort.signal, isCurrent() { try { return current(); } catch { return false; } } }); }), operation);
      const result = await work;
      check(operation); return result;
    } catch (error) { if (mutationFailed) throw mutationFailure; if (error instanceof BackupError) throw error; check(operation); fail('unavailable'); }
    finally { for (const signal of signals) signalUnlisten.call(signal, 'abort', stop); }
  }
  function fresh(time: number): Recovery { const state: Recovery = { version: 1, profile: OWNER_BACKUP_PROFILE, ownerId: owner, revision: 0,
    epoch: 0, dataRevision: 0, lastNow: time, audit: [], archives: [], fenceChecksum: '' }; state.fenceChecksum = seal(state); return state; }
  function update(state: Recovery, next: Managed, time: number) {
    if (next.epoch < state.epoch || next.dataRevision < state.dataRevision) fail('conflict');
    if (next.epoch !== state.epoch || next.dataRevision !== state.dataRevision) state.archives = [];
    state.epoch = next.epoch; state.dataRevision = next.dataRevision;
    const retained = new Map(state.audit.filter(row => row.expiresAt > time).map(row => [row.operationId, row]));
    for (const row of next.audit) if (row.expiresAt > time) retained.set(row.operationId, row);
    state.audit = audit([...retained.values()]); state.deletion = next.deletion;
    if (state.deletion === undefined) delete state.deletion;
    state.managed = next; state.lastNow = time;
    state.archives = state.archives.filter(row => row.expiresAt > time);
    if (state.revision >= Number.MAX_SAFE_INTEGER) fail('capacity'); state.revision++;
  }
  const managedStorage: OwnerDataStorage = Object.freeze({ async transact<T>(requested: string, mutate: (raw: unknown) => { state: unknown; result: T }, guard?: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) {
    if (requested !== owner) fail('wrong-owner'); if (typeof mutate !== 'function') fail('invalid');
    const operation: Operation = { abort: new AbortController(), pending: new Set() };
    return tx(raw => {
      const time = now(), state = raw === undefined ? fresh(time) : recovery(raw, owner, time);
      if (state.managed === undefined && state.epoch !== 0) fail('review-required');
      if (state.managed !== undefined) currentManaged(state, owner, time);
      const next = mutate(copy(state.managed)); const fields = object(next); exact(fields, ['state', 'result']);
      const value = managed(fields.state, owner); update(state, value, time); state.fenceChecksum = seal(state); return { state, result: fields.result as T };
    }, operation, guard);
  } });
  async function attempt<T>(work: (operation: Operation) => Promise<T>): Promise<OwnerBackupResult<T>> {
    if (busy) return { ok: false, reason: 'busy' }; busy = true;
    const operation: Operation = { abort: new AbortController(), pending: new Set() };
    let timer: ReturnType<typeof setTimeout> | undefined, detach = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      let settled = false;
      const abort = () => { if (settled) return; settled = true; operation.abort.abort(); reject(new BackupError(closed ? 'closed' : clockFault ? 'invalid-clock' : 'expired')); };
      signalListen.call(operation.abort.signal, 'abort', abort, { once: true });
      signalListen.call(lifetime.signal, 'abort', abort, { once: true });
      detach = () => { signalUnlisten.call(operation.abort.signal, 'abort', abort); signalUnlisten.call(lifetime.signal, 'abort', abort); };
      timer = setTimeout(abort, OWNER_BACKUP_LIMITS.operationMs);
    });
    let publicFinished = false;
    const release = () => { if (publicFinished && operation.pending.size === 0) busy = false; };
    operation.onSettled = release;
    const task = track(Promise.resolve().then(() => { check(operation); return work(operation); }), operation);
    try { const result = await Promise.race([task, stopped]); check(operation); return ok(result); }
    catch (error) { return { ok: false, reason: error instanceof BackupError ? error.reason : 'unavailable' }; }
    finally { clearTimeout(timer); detach(); operation.abort.abort(); publicFinished = true; release(); }
  }
  async function read(operation: Operation) { return tx(raw => { if (raw === undefined) fail('fence-missing'); return { state: raw, result: copy(raw) }; }, operation); }
  async function approval(operation: Operation, action: OwnerBackupScope['action'], request: ReturnType<typeof selected>, raw: unknown, state: Pick<Recovery, 'epoch' | 'dataRevision' | 'revision'>, pin?: string, copySource?: Managed) {
    const stateSha256 = await digest(raw); check(operation);
    if (copySource?.copies.length && request.registeredCopies !== 'include') fail('unsupported');
    let registeredCopies: OwnerBackupScope['registeredCopies'];
    if (request.registeredCopies === 'include') {
      if (!copySource) fail('invalid');
      for (const input of copySource.copies) { const record = object(object(input).record);
        if (!integer(record.expiresAt)) fail('corrupt');
        operation.archiveExpiresAt = Math.min(operation.archiveExpiresAt ?? Infinity, record.expiresAt); }
      const sha256 = await digest(copySource.copies); check(operation);
      registeredCopies = Object.freeze({ selection: 'all-registered-local' as const, count: copySource.copies.length, sha256 });
      operation.registeredCopies = registeredCopies;
    }
    const scope: OwnerBackupScope = Object.freeze({ ownerId: owner, action, purpose: request.purpose, destinationId: request.destinationId,
      epoch: state.epoch, dataRevision: state.dataRevision, recoveryRevision: state.revision, stateSha256,
      deadline: Math.min(now() + OWNER_BACKUP_LIMITS.grantMs, registeredCopies ? operation.archiveExpiresAt ?? Infinity : Infinity),
      maxBytes: OWNER_BACKUP_LIMITS.archiveBytes,
      ...(request.backupId ? { backupId: request.backupId } : {}), ...(pin ? { backupSha256: pin } : {}),
      ...(registeredCopies ? { registeredCopies } : {}) });
    const received = await new Promise<unknown>(resolve => {
      let settled = false; const timer = setTimeout(() => finish(undefined), OWNER_BACKUP_LIMITS.authorizationMs);
      function finish(value: unknown) { if (settled) return; settled = true; clearTimeout(timer); signalUnlisten.call(operation.abort.signal, 'abort', abort); resolve(value); }
      function abort() { finish(undefined); }
      signalListen.call(operation.abort.signal, 'abort', abort, { once: true });
      track(Promise.resolve().then(() => { check(operation); return authorize(scope); }), operation).then(finish, () => finish(undefined));
    });
    check(operation);
    try { const value = object(received); exact(value, ['scope', 'expiresAt', 'isCurrent'], ['signal']);
      if (canonical(copy(value.scope)) !== canonical(scope) || !integer(value.expiresAt) || value.expiresAt <= now() || value.expiresAt > scope.deadline ||
        typeof value.isCurrent !== 'function' || value.signal !== undefined && !(value.signal instanceof AbortSignal)) fail('denied');
      if (registeredCopies) {
        if (!value.signal || signalAborted(value.signal as AbortSignal)) fail('denied');
      }
      operation.grant = Object.freeze({ scope, expiresAt: value.expiresAt, isCurrent: value.isCurrent as () => boolean,
        ...(value.signal ? { signal: value.signal as AbortSignal } : {}) });
    } catch { fail('denied'); } check(operation);
  }
  async function validate(input: unknown, operation: Operation): Promise<Managed> {
    let state = managed(input, owner); if (state.deletion?.state === 'pending') fail('review-required');
    // Copy-bearing recovery requires its own exact selected-set consent at every new operation.
    if (state.copies.length !== 0 && !operation.registeredCopies) fail('unsupported');
    const detached: OwnerDataStorage = { async transact(requested, mutate, guard) { check(operation); if (requested !== owner) fail('wrong-owner');
      if (guard && (signalAborted(guard.signal) || !guard.isCurrent())) fail('revoked'); const next = mutate(copy(state)); check(operation);
      if (guard && (signalAborted(guard.signal) || !guard.isCurrent())) fail('revoked'); state = copy(next.state) as Managed; return next.result; } };
    const controller = createOwnerDataController({ ownerId: owner, storage: detached, trustedNow: now,
      availableDevices: options.availableDevices ?? (() => []), reviewedArtifacts: reviewed,
      authorize: scope => { check(operation); return { scope, expiresAt: Math.min(operation.grant!.expiresAt, scope.deadline),
        isCurrent: () => { try { check(operation); return true; } catch { return false; } }, signal: operation.abort.signal }; } });
    try {
      const swept = await controller.sweep(); check(operation); if (!swept.ok) fail(swept.reason === 'integrity' ? 'integrity' : 'corrupt'); check(operation);
      for (const kind of ['telemetry', 'settings', 'artifacts', ...(operation.registeredCopies ? ['copies' as const] : [])] as const) {
        let cursor;
        for (let page = 0; page < 8; page++) { const result = await controller.exportPage({ kind, purpose: 'owner-recovery', destinationId: 'local-recovery',
          ...(kind === 'artifacts' ? { includeArtifactBytes: true } : {}), ...(cursor ? { cursor } : {}) });
          check(operation); if (!result.ok) fail(['integrity', 'denied'].includes(result.reason) ? result.reason as 'integrity' | 'denied' : 'corrupt'); check(operation);
          cursor = result.value.next; if (!cursor) break; if (page === 7) fail('capacity');
        }
      }
      if (operation.registeredCopies) {
        const sha256 = await digest(state.copies); check(operation);
        if (sha256 !== operation.registeredCopies.sha256 || state.copies.length !== operation.registeredCopies.count) fail('conflict');
      }
      return managed(state, owner);
    } finally { controller.close(); }
  }
  async function archive(state: Recovery, backupId: string, operation: Operation) {
    const row = state.archives.find(row => row.backupId === backupId); if (!row) fail('not-found');
    operation.archiveExpiresAt = Math.min(operation.archiveExpiresAt ?? Infinity, row.expiresAt); check(operation);
    const bytes = decode(row.bytesBase64); if (!await verifyAssetContent(row.reference, bytes)) fail('integrity'); check(operation);
    let payload: Payload; try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('corrupt'); }
    const value = object(payload); exact(value, ['version', 'profile', 'ownerId', 'createdAt', 'expiresAt', 'managed']);
    if (value.version !== 1 || value.profile !== OWNER_BACKUP_PROFILE || value.ownerId !== owner || value.createdAt !== row.createdAt || value.expiresAt !== row.expiresAt) fail('corrupt');
    const source = managed(value.managed, owner); if (source.epoch !== state.epoch || source.dataRevision !== state.dataRevision) fail('conflict');
    return { row, bytes, source };
  }
  async function replace(raw: unknown, state: Recovery, operation: Operation) { const expected = canonical(raw); state.fenceChecksum = seal(state);
    await tx(current => { if (canonical(current) !== expected) fail('conflict'); return { state, result: undefined }; }, operation);
  }
  const controller: OwnerBackupController = {
    managedStorage,
    migrateReviewed: input => attempt(async operation => {
      const request = selected(input, false, false, true), raw = await read(operation), source = managed(raw, owner);
      await approval(operation, 'migrate-reviewed', request, raw, source, undefined, source);
      const normalized = await validate(source, operation), state = fresh(now()); update(state, normalized, now());
      await replace(raw, state, operation); return Object.freeze({ epoch: state.epoch, dataRevision: state.dataRevision });
    }),
    backup: input => attempt(async operation => {
      const request = selected(input, true), raw = await read(operation), state = recovery(raw, owner, now());
      if (state.deletion?.state === 'pending') fail('review-required');
      const existing = state.archives.some(row => row.backupId === request.backupId) ? await archive(state, request.backupId!, operation) : undefined;
      await approval(operation, 'backup', request, raw, state, existing?.row.reference.sha256, existing?.source ?? currentManaged(state, owner, now()));
      if (state.archives.some(row => row.backupId === request.backupId)) {
        const retained = await archive(state, request.backupId!, operation); await validate(retained.source, operation);
        if (canonical(await read(operation)) !== canonical(raw)) fail('conflict'); return receipt(retained.row);
      }
      const normalized = await validate(currentManaged(state, owner, now()), operation); let expiresAt = now() + OWNER_BACKUP_LIMITS.retentionMs;
      const telemetry = normalized.records.telemetry as { rows?: { expiresAt: number }[] } | undefined;
      for (const row of telemetry?.rows ?? []) expiresAt = Math.min(expiresAt, row.expiresAt);
      for (const input of normalized.copies) expiresAt = Math.min(expiresAt, object(object(input).record).expiresAt as number);
      if (normalized.artifactExpiresAt !== undefined) expiresAt = Math.min(expiresAt, normalized.artifactExpiresAt);
      for (const row of normalized.audit) expiresAt = Math.min(expiresAt, row.expiresAt);
      const createdAt = now(), payload: Payload = { version: 1, profile: OWNER_BACKUP_PROFILE, ownerId: owner, createdAt, expiresAt, managed: normalized };
      const bytes = encoder.encode(canonical(payload)); if (bytes.byteLength > OWNER_BACKUP_LIMITS.archiveBytes || expiresAt <= createdAt) fail('capacity');
      operation.archiveExpiresAt = expiresAt; check(operation);
      const reference = await createAssetReference(`backup:${request.backupId}`, 'blob', bytes); check(operation);
      update(state, normalized, now());
      const previous = state.archives.find(row => row.backupId === request.backupId);
      if (previous) { if (previous.reference.sha256 !== reference.sha256) fail('conflict'); return receipt(previous); }
      if (state.archives.length >= OWNER_BACKUP_LIMITS.archives) fail('capacity');
      const row: Archive = { backupId: request.backupId!, reference, createdAt, expiresAt, epoch: state.epoch,
        dataRevision: state.dataRevision, bytesBase64: encode(bytes) }; state.archives.push(row);
      await replace(raw, state, operation);
      const observed = recovery(await read(operation), owner, now()); await archive(observed, row.backupId, operation);
      return receipt(row);
    }),
    readBackup: input => attempt(async operation => {
      const request = selected(input, true), raw = await read(operation), state = recovery(raw, owner, now());
      const row = state.archives.find(row => row.backupId === request.backupId); if (!row) fail('not-found');
      const retained = await archive(state, request.backupId!, operation);
      await approval(operation, 'read-backup', request, raw, state, row.reference.sha256, retained.source);
      await validate(retained.source, operation);
      if (canonical(await read(operation)) !== canonical(raw)) fail('conflict');
      return Object.freeze({ receipt: receipt(retained.row), bytes: snapshotResourceBytes(retained.bytes) });
    }),
    restoreReviewed: input => attempt(async operation => {
      const request = selected(input, true, true), raw = await read(operation), state = recovery(raw, owner, now());
      if (state.deletion?.state === 'pending') fail('review-required');
      const row = state.archives.find(row => row.backupId === request.backupId); if (!row) fail('not-found');
      if (row.reference.sha256 !== request.expectedSha256) fail('integrity');
      if (state.managed !== undefined) { const header = object(state.managed); if (header.ownerId !== owner) fail('wrong-owner');
        if (header.version !== 1 || header.profile !== OWNER_DATA_PROFILE) fail('incompatible'); }
      const retained = await archive(state, request.backupId!, operation);
      await approval(operation, 'restore-reviewed', request, raw, state, row.reference.sha256, retained.source);
      if (state.managed !== undefined) {
        let damaged = false;
        try { await validate(currentManaged(state, owner, now()), operation); }
        catch (error) { if (!(error instanceof BackupError) || !['invalid', 'corrupt', 'integrity'].includes(error.reason)) throw error; damaged = true; }
        check(operation); if (!damaged) fail('review-required');
      }
      const normalized = await validate(retained.source, operation);
      if (state.epoch >= Number.MAX_SAFE_INTEGER || state.dataRevision >= Number.MAX_SAFE_INTEGER || normalized.revision >= Number.MAX_SAFE_INTEGER) fail('capacity');
      const time = now(); normalized.epoch = state.epoch + 1; normalized.dataRevision = state.dataRevision + 1; normalized.revision++;
      normalized.lastNow = time; normalized.audit = state.audit.filter(row => row.expiresAt > time);
      if (state.deletion) normalized.deletion = state.deletion; else delete normalized.deletion;
      if (normalized.records.telemetry) (normalized.records.telemetry as { epoch: string }).epoch = crypto.randomUUID();
      if (normalized.records.artifacts) {
        const document = JSON.parse(normalized.records.artifacts);
        for (const job of document.jobs) if (job.state === 'accepted' || job.state === 'running') {
          job.state = 'interrupted'; job.updatedAt = Math.max(job.updatedAt, time);
          for (const attempt of job.attempts) if (attempt.outcome === 'running') { attempt.outcome = 'interrupted'; attempt.endedAt = Math.max(attempt.startedAt, time); }
        }
        if (!integer(document.revision) || document.revision >= Number.MAX_SAFE_INTEGER) fail('capacity');
        document.revision++; normalized.records.artifacts = JSON.stringify(document);
      }
      request.retireOwned!(); check(operation); update(state, normalized, time); state.archives = [];
      await replace(raw, state, operation);
      const observed = recovery(await read(operation), owner, now());
      if (observed.epoch !== normalized.epoch || observed.dataRevision !== normalized.dataRevision || canonical(observed.managed) !== canonical(normalized)) fail('conflict');
      return Object.freeze({ epoch: observed.epoch, dataRevision: observed.dataRevision });
    }),
    inspect: input => attempt(async operation => {
      const request = selected(input), raw = await read(operation), state = recovery(raw, owner, now());
      await approval(operation, 'inspect', request, raw, state);
      for (const row of state.archives) if (row.expiresAt > now()) await archive(state, row.backupId, operation);
      if (canonical(await read(operation)) !== canonical(raw)) fail('conflict');
      return Object.freeze({ epoch: state.epoch, dataRevision: state.dataRevision, archives: Object.freeze(state.archives.filter(row => row.expiresAt > now()).map(receipt)) });
    }),
    sweep: input => attempt(async operation => {
      const request = selected(input), raw = await read(operation), state = recovery(raw, owner, now());
      await approval(operation, 'sweep', request, raw, state); const before = state.archives.length;
      state.archives = state.archives.filter(row => row.expiresAt > now()); state.audit = state.audit.filter(row => row.expiresAt > now());
      state.lastNow = now(); state.revision++; await replace(raw, state, operation); return Object.freeze({ removed: before - state.archives.length });
    }),
    close() {
      if (closing) return closing;
      let finish: () => void = () => {};
      closing = new Promise<void>(resolve => { finish = resolve; });
      closed = true; lifetime.abort();
      void Promise.resolve().then(async () => { while (pending.size) await Promise.all([...pending]); }).then(finish);
      return closing;
    },
  };
  return Object.freeze(controller);
}
