import { createAssetReference, parseAssetReference, snapshotResourceBytes, verifyAssetContent } from '@101/device-model';
import type { AssetReference } from '@101/device-model';
import { createMediaRecording } from './media-recording.ts';
import type { MediaRecording, MediaRecordingOptions, MediaRecordingStoredFrame } from './media-recording.ts';
import { snapshotOwnerDataState } from './owner-data.ts';
import type { OwnerDataStorage } from './owner-data.ts';

export const RECORDING_OWNER_DATA_PROFILE = 'managed-recorded-media-owner-data/1';
export const RECORDING_OWNER_DATA_LIMITS = Object.freeze({ producerPorts: 1, mutators: 1, storageOperations: 8,
  ownerDocumentBytes: 524288, exportFramesPerPage: 4, exportPageBytes: 8192, registeredCopyFrames: 64,
  registeredCopyBytes: 65536, auditRows: 128, auditBytes: 65536, auditRetentionMs: 30 * 86400000,
  grantMs: 30000, authorizationMs: 1000 });
export type RecordingOwnerDataFailure = 'invalid' | 'corrupt' | 'incompatible' | 'wrong-owner' | 'unavailable' | 'denied' |
  'revoked' | 'expired' | 'closed' | 'busy' | 'capacity' | 'conflict' | 'review-required' | 'integrity' | 'invalid-clock' | 'not-found';
export type RecordingOwnerDataResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: RecordingOwnerDataFailure }>;
export interface RecordingOwnerDataScope {
  readonly ownerId: string; readonly action: 'open-recording' | 'export' | 'register-copy' | 'delete' | 'resume-delete' | 'review' | 'sweep';
  readonly epoch: number; readonly revision: number; readonly dataRevision: number; readonly purpose: string;
  readonly destinationId: string; readonly deadline: number; readonly maxBytes: number;
  readonly clipIds: readonly string[]; readonly frameHashes: readonly string[]; readonly operationId?: string; readonly stage?: number;
  readonly afterIndex?: number; readonly limit?: number;
}
export interface RecordingOwnerDataGrant { readonly scope: RecordingOwnerDataScope; readonly signal: AbortSignal;
  readonly expiresAt: number; readonly isCurrent: () => boolean }
export interface RecordingOwnerDataOptions {
  readonly ownerId: string; readonly ownerSignal: AbortSignal; readonly storage: OwnerDataStorage; readonly trustedNow: () => number;
  readonly authorizeRecording: MediaRecordingOptions['authorize'];
  readonly authorize: (scope: RecordingOwnerDataScope) => RecordingOwnerDataGrant | undefined | Promise<RecordingOwnerDataGrant | undefined>;
}
export interface RecordingOwnerDataPort { readonly recording: MediaRecording; readonly signal: AbortSignal; close(): Promise<void> }
export interface RecordingOwnerDataFrame {
  readonly index: number; readonly ingestedAt: number; readonly sourceTime: Readonly<{ clockId: string; at: number }>;
  readonly sequence: number; readonly quality: 'valid' | 'observed' | 'unverified'; readonly decodedMediaTime?: number;
  readonly bytes: Uint8Array; readonly reference: Readonly<AssetReference>;
}
export interface RecordingOwnerDataExportPage {
  readonly profile: typeof RECORDING_OWNER_DATA_PROFILE; readonly clipId: string; readonly afterIndex: number;
  readonly createdAt: number; readonly expiresAt: number; readonly epoch: number; readonly dataRevision: number;
  readonly frames: readonly RecordingOwnerDataFrame[]; readonly nextIndex?: number;
}
export interface RecordingOwnerDataDeletion {
  readonly operationId: string; readonly state: 'pending' | 'completed'; readonly completedStages: number;
  readonly startedAt: number; readonly updatedAt: number; readonly removed: Readonly<{ clips: number; copyFrames: number }>;
}
export interface RecordingOwnerDataAudit {
  readonly operationId: string; readonly action: 'deletion' | 'expiry'; readonly state: 'pending' | 'completed';
  readonly at: number; readonly expiresAt: number; readonly removed: Readonly<{ clips: number; copyFrames: number }>;
}
interface ExportRequest { readonly clipId: string; readonly purpose: string; readonly destinationId: string;
  readonly expiresAt: number; readonly afterIndex: number; readonly limit: number }
export interface RecordingOwnerDataController {
  openRecording(request: { purpose: string; expiresAt: number; retireOwned(): void }): Promise<RecordingOwnerDataResult<RecordingOwnerDataPort>>;
  exportPage(request: ExportRequest): Promise<RecordingOwnerDataResult<RecordingOwnerDataExportPage>>;
  storeRegisteredExport(page: unknown, request: { purpose: string; destinationId: string }): Promise<RecordingOwnerDataResult<{ copied: number; copyId: string }>>;
  beginDeletion(request: { clipIds: readonly string[]; purpose: string }): Promise<RecordingOwnerDataResult<RecordingOwnerDataDeletion>>;
  resumeDeletionReviewed(operationId: string): Promise<RecordingOwnerDataResult<RecordingOwnerDataDeletion>>;
  inspectDeletion(): Promise<RecordingOwnerDataResult<RecordingOwnerDataDeletion | undefined>>;
  listAudit(): Promise<RecordingOwnerDataResult<readonly RecordingOwnerDataAudit[]>>;
  sweep(): Promise<RecordingOwnerDataResult<{ clipsRemoved: number; copyFramesRemoved: number }>>;
  close(): Promise<void>;
}
interface StoredFrame { index: number; ingestedAt: number; sourceTime: { clockId: string; at: number }; sequence: number;
  quality: RecordingOwnerDataFrame['quality']; decodedMediaTime?: number; hex: string; reference: AssetReference }
interface Copy { id: string; clipId: string; expiresAt: number; frames: StoredFrame[] }
interface PendingDeletion extends RecordingOwnerDataDeletion { clipIds: string[] }
interface Envelope { version: 1; profile: typeof RECORDING_OWNER_DATA_PROFILE; ownerId: string; epoch: number;
  revision: number; dataRevision: number; lastNow: number; nextCopy: number; nextOperation: number;
  recording?: unknown; copies: Copy[]; audit: RecordingOwnerDataAudit[]; deletion?: PendingDeletion }
interface IssuedPage { epoch: number; dataRevision: number; clipId: string; afterIndex: number; limit: number;
  purpose: string; destinationId: string; expiresAt: number; hashes: string[]; used: boolean }
interface Operation { abort: AbortController; grant?: RecordingOwnerDataGrant; expectedRevision?: number; expectedEpoch?: number;
  contentExpiresAt?: number; active: boolean }
interface Lease { abort: AbortController; grant: RecordingOwnerDataGrant; epoch: number; recording: MediaRecording;
  retired: boolean; retireOwned(): void; closePromise?: Promise<void>; off: () => void; timer?: ReturnType<typeof setTimeout> }
interface Context { op?: Operation; lease?: Lease; abort: AbortController; refusal?: RecordingOwnerDataFailure;
  expired: { clips: number; copyFrames: number }; hook?: (state: Envelope, result: unknown, at: number) => void }
class Refusal extends Error { readonly reason: RecordingOwnerDataFailure;
  constructor(reason: RecordingOwnerDataFailure) { super('managed-recording-refused'); this.reason = reason; } }
function fail(reason: RecordingOwnerDataFailure): never { throw new Refusal(reason); }
const ok = <T>(value: T): RecordingOwnerDataResult<T> => Object.freeze({ ok: true, value });
const bad = (reason: RecordingOwnerDataFailure): RecordingOwnerDataResult<never> => Object.freeze({ ok: false, reason });
const abortedGet = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const on = EventTarget.prototype.addEventListener, off = EventTarget.prototype.removeEventListener;
function aborted(signal: unknown): boolean { try { return abortedGet.call(signal) as boolean; } catch { return fail('invalid'); } }
function object(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== Object.keys(descriptors).length || required.some(key => !Object.hasOwn(descriptors, key)) ||
    Object.entries(descriptors).some(([key, value]) => ![...required, ...optional].includes(key) || !value.enumerable || !('value' in value))) fail('invalid');
  return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid'); return value;
}
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('invalid'); return value; }
function token(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('invalid'); return value; }
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input)) fail('invalid'); const size = integer(input.length, 0, maximum);
  if (Reflect.ownKeys(input).length !== size + 1) fail('invalid');
  return Array.from({ length: size }, (_, index) => { const d = Object.getOwnPropertyDescriptor(input, String(index));
    if (!d?.enumerable || !('value' in d)) fail('invalid'); return d.value; });
}
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));
function frame(input: unknown): StoredFrame {
  const v = object(input, ['index', 'ingestedAt', 'sourceTime', 'sequence', 'quality', 'hex', 'reference'], ['decodedMediaTime']);
  const time = object(v.sourceTime, ['clockId', 'at']);
  if (typeof v.hex !== 'string' || !/^[0-9a-f]{512}$/.test(v.hex) || !['valid', 'observed', 'unverified'].includes(v.quality as string)) fail('corrupt');
  const reference = parseAssetReference(v.reference); if (reference.id !== 'recording:frame' || reference.kind !== 'blob' || reference.byteLength !== 256) fail('corrupt');
  return { index: integer(v.index, 0, 31), ingestedAt: integer(v.ingestedAt), sourceTime: { clockId: token(time.clockId), at: finite(time.at) },
    sequence: integer(v.sequence, 0, 0xffffffff), quality: v.quality as StoredFrame['quality'], hex: v.hex, reference,
    ...(v.decodedMediaTime === undefined ? {} : { decodedMediaTime: finite(v.decodedMediaTime) }) };
}
function audit(input: unknown): RecordingOwnerDataAudit {
  const v = object(input, ['operationId', 'action', 'state', 'at', 'expiresAt', 'removed']);
  if (!['deletion', 'expiry'].includes(v.action as string) || !['pending', 'completed'].includes(v.state as string)) fail('corrupt');
  const removed = object(v.removed, ['clips', 'copyFrames']), at = integer(v.at);
  return Object.freeze({ operationId: token(v.operationId), action: v.action as RecordingOwnerDataAudit['action'], state: v.state as RecordingOwnerDataAudit['state'],
    at, expiresAt: integer(v.expiresAt, at + RECORDING_OWNER_DATA_LIMITS.auditRetentionMs, at + RECORDING_OWNER_DATA_LIMITS.auditRetentionMs),
    removed: Object.freeze({ clips: integer(removed.clips, 0, 4), copyFrames: integer(removed.copyFrames, 0, 64) }) });
}
function parse(raw: unknown, owner: string, at: number): Envelope {
  if (raw === undefined) return { version: 1, profile: RECORDING_OWNER_DATA_PROFILE, ownerId: owner, epoch: 1,
    revision: 0, dataRevision: 0, lastNow: at, nextCopy: 1, nextOperation: 1, copies: [], audit: [] };
  try {
    const v = object(snapshotOwnerDataState(raw), ['version', 'profile', 'ownerId', 'epoch', 'revision', 'dataRevision', 'lastNow', 'nextCopy', 'nextOperation', 'copies', 'audit'], ['recording', 'deletion']);
    if (v.ownerId !== owner) fail('wrong-owner'); if (v.version !== 1 || v.profile !== RECORDING_OWNER_DATA_PROFILE) fail('incompatible');
    const state: Envelope = { version: 1, profile: RECORDING_OWNER_DATA_PROFILE, ownerId: owner, epoch: integer(v.epoch, 1), revision: integer(v.revision),
      dataRevision: integer(v.dataRevision), lastNow: integer(v.lastNow), nextCopy: integer(v.nextCopy, 1), nextOperation: integer(v.nextOperation, 1),
      copies: [], audit: array(v.audit, 128).map(audit), ...(v.recording === undefined ? {} : { recording: v.recording }) };
    if (state.lastNow > at) fail('invalid-clock');
    state.copies = array(v.copies, 64).map(value => { const c = object(value, ['id', 'clipId', 'expiresAt', 'frames']);
      return { id: token(c.id), clipId: token(c.clipId), expiresAt: integer(c.expiresAt), frames: array(c.frames, 4).map(frame) }; });
    if (new Set(state.copies.map(copy => copy.id)).size !== state.copies.length) fail('corrupt');
    if (v.deletion !== undefined) { const d = object(v.deletion, ['operationId', 'state', 'completedStages', 'startedAt', 'updatedAt', 'removed', 'clipIds']);
      if (d.state !== 'pending' && d.state !== 'completed') fail('corrupt'); const removed = object(d.removed, ['clips', 'copyFrames']);
      state.deletion = { operationId: token(d.operationId), state: d.state, completedStages: integer(d.completedStages, 0, 5),
        startedAt: integer(d.startedAt), updatedAt: integer(d.updatedAt), removed: { clips: integer(removed.clips, 0, 4), copyFrames: integer(removed.copyFrames, 0, 64) },
        clipIds: array(d.clipIds, 4).map(token) };
      if (!state.deletion.clipIds.length || new Set(state.deletion.clipIds).size !== state.deletion.clipIds.length || state.deletion.updatedAt < state.deletion.startedAt ||
        state.deletion.completedStages > state.deletion.clipIds.length + 1 || state.deletion.state === 'completed' && state.deletion.completedStages !== state.deletion.clipIds.length + 1) fail('corrupt');
    }
    bounded(state); return state;
  } catch (error) { if (error instanceof Refusal && ['wrong-owner', 'incompatible', 'invalid-clock'].includes(error.reason)) throw error; return fail('corrupt'); }
}
function bounded(state: Envelope) {
  if (size(state) > RECORDING_OWNER_DATA_LIMITS.ownerDocumentBytes || state.copies.reduce((sum, copy) => sum + copy.frames.length, 0) > 64 ||
    size(state.copies) > RECORDING_OWNER_DATA_LIMITS.registeredCopyBytes || state.audit.length > 128 || size(state.audit) > 65536) fail('capacity');
}
function bump(value: number): number { if (value >= Number.MAX_SAFE_INTEGER - 1) fail('capacity'); return value + 1; }
function publicDeletion(value: PendingDeletion | undefined): RecordingOwnerDataDeletion | undefined {
  if (!value) return;
  return Object.freeze({ operationId: value.operationId, state: value.state, completedStages: value.completedStages,
    startedAt: value.startedAt, updatedAt: value.updatedAt, removed: Object.freeze({ ...value.removed }) });
}

/** Managed local recipients only. Caller-retained or externally sent bytes cannot be recalled. */
export function createRecordingOwnerData(options: RecordingOwnerDataOptions): RecordingOwnerDataController {
  const o = object(options, ['ownerId', 'ownerSignal', 'storage', 'trustedNow', 'authorizeRecording', 'authorize']);
  const owner = token(o.ownerId), ownerSignal = o.ownerSignal as AbortSignal; aborted(ownerSignal);
  if (typeof o.trustedNow !== 'function' || typeof o.authorize !== 'function' || typeof o.authorizeRecording !== 'function') throw new TypeError('Invalid managed recording configuration');
  const storage = o.storage as OwnerDataStorage, transact = Object.getOwnPropertyDescriptor(storage, 'transact')?.value;
  if (typeof transact !== 'function') throw new TypeError('Invalid managed recording storage');
  const trustedNow = o.trustedNow as () => number, authorize = o.authorize as RecordingOwnerDataOptions['authorize'], authorizeRecording = o.authorizeRecording as MediaRecordingOptions['authorize'];
  const lifetime = new AbortController(), tasks = new Set<Promise<unknown>>(), pages = new WeakMap<object, IssuedPage>();
  let closed = false, lastNow = -1, busy = false, rawStorage = 0, rawAuthorizers = 0, activePort: Lease | undefined, closePromise: Promise<void> | undefined;
  function alive(op?: Operation) { if (closed) fail('closed'); if (aborted(ownerSignal) || aborted(lifetime.signal) || op && (!op.active || aborted(op.abort.signal))) fail('revoked'); }
  function clock(op?: Operation): number {
    alive(op); let at: unknown; try { at = trustedNow(); } catch { lifetime.abort(); void retirePort(activePort); fail('invalid-clock'); } alive(op);
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - RECORDING_OWNER_DATA_LIMITS.auditRetentionMs || at < lastNow) {
      lifetime.abort(); retirePort(activePort); fail('invalid-clock');
    }
    lastNow = at;
    // Selected content keeps its original ingestion expiry through authorizer
    // callouts and the actual storage engine's final isCurrent readback.
    if (op?.contentExpiresAt !== undefined && at >= op.contentExpiresAt) fail('expired');
    return at;
  }
  function listen(signal: AbortSignal, callback: () => void): () => void {
    aborted(signal); let installed = true;
    const changed = () => { remove(); callback(); };
    const remove = () => { if (!installed) return; installed = false; off.call(signal, 'abort', changed); };
    on.call(signal, 'abort', changed, { once: true }); if (aborted(signal)) changed(); return remove;
  }
  function tracked<T>(promise: Promise<T>): Promise<T> { tasks.add(promise); void promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise; }
  function checkGrant(grant: RecordingOwnerDataGrant, op?: Operation): number {
    alive(op); if (aborted(grant.signal)) fail('revoked'); let current = false;
    try { current = grant.isCurrent() === true; } catch { /* Fixed refusal, never a provider message. */ }
    alive(op); if (!current || aborted(grant.signal)) fail('revoked');
    const at = clock(op); if (at >= grant.expiresAt) fail('expired');
    if (closed || aborted(ownerSignal) || aborted(lifetime.signal) || aborted(grant.signal) || op && (!op.active || aborted(op.abort.signal))) fail('revoked'); return at;
  }
  function retirePort(port: Lease | undefined): Promise<void> {
    if (!port) return Promise.resolve(); if (port.closePromise) return port.closePromise;
    let settled!: () => void;
    // Reserve retirement before abort listeners or the caller callback can reenter close.
    port.closePromise = tracked(new Promise<void>(resolve => { settled = resolve; }));
    port.retired = true; port.abort.abort(); port.off(); if (port.timer !== undefined) clearTimeout(port.timer);
    try { port.retireOwned(); } catch { /* Output retirement cannot restore a durable barrier or authority. */ }
    void port.recording.close().finally(() => { if (activePort === port) activePort = undefined; settled(); }); return port.closePromise;
  }
  async function native<T>(mutation: (state: Envelope, at: number) => T, op?: Operation, context?: Context,
    innerGuard?: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>, preserveProducerFailure = false): Promise<T> {
    if (rawStorage >= 8) fail('capacity'); rawStorage++;
    const commit = new AbortController(), removers: (() => void)[] = [];
    const grant = op?.grant ?? context?.lease?.grant;
    const check = () => { alive(op); if (context?.lease?.retired) fail('revoked'); if (grant) checkGrant(grant, op);
      if (innerGuard && (aborted(innerGuard.signal) || innerGuard.isCurrent() !== true)) fail('revoked');
      const at = clock(op); if (grant && (at >= grant.expiresAt || aborted(grant.signal)) || aborted(commit.signal) ||
        innerGuard && aborted(innerGuard.signal) || context && aborted(context.abort.signal)) fail('revoked'); return at; };
    try {
      for (const signal of [ownerSignal, lifetime.signal, ...(op ? [op.abort.signal] : []), ...(context ? [context.abort.signal] : []),
        ...(grant ? [grant.signal] : []), ...(innerGuard ? [innerGuard.signal] : [])]) removers.push(listen(signal, () => commit.abort()));
      check();
      return await tracked(Promise.resolve().then(() => Reflect.apply(transact, storage, [owner, (raw: unknown) => {
        const at = check(), state = parse(raw, owner, at);
        if (op?.expectedRevision !== undefined && state.revision !== op.expectedRevision || op?.expectedEpoch !== undefined && state.epoch !== op.expectedEpoch ||
          context?.lease && state.epoch !== context.lease.epoch) fail('conflict');
        const before = JSON.stringify(state), result = mutation(state, at); check(); bounded(state);
        if (before !== JSON.stringify(state)) state.revision = bump(state.revision);
        bounded(state); check();
        return { state: snapshotOwnerDataState(state), result: { result, revision: state.revision, epoch: state.epoch } };
      }, { signal: commit.signal, isCurrent: () => { try { check(); return true; } catch { return false; } } }]))).then(value => {
        const result = value as { result: T; revision: number; epoch: number };
        if (op) { op.expectedRevision = result.revision; op.expectedEpoch = result.epoch; }
        return result.result;
      });
    } catch (error) { if (error instanceof Refusal) throw error; alive(op); if (grant) checkGrant(grant, op);
      // The real producer owns its parser's fixed failure classification. Its
      // caught result is projected later; this error is never stored or reported.
      if (preserveProducerFailure) throw error; return fail('unavailable'); }
    finally { for (const remove of removers) remove(); rawStorage--; }
  }
  async function approve(op: Operation, action: RecordingOwnerDataScope['action'], state: Envelope, purpose: string, destinationId: string,
    clipIds: string[] = [], hashes: string[] = [], deadline = clock(op) + 30000, allowPending = false,
    selection?: Readonly<{ afterIndex: number; limit: number }>): Promise<void> {
    if (!allowPending && state.deletion?.state === 'pending') fail('review-required');
    const scope: RecordingOwnerDataScope = Object.freeze({ ownerId: owner, action, epoch: state.epoch, revision: state.revision,
      dataRevision: state.dataRevision, purpose, destinationId, deadline, maxBytes: action === 'export' ? 8192 : action === 'register-copy' ? 65536 : 524288,
      clipIds: Object.freeze([...clipIds]), frameHashes: Object.freeze([...hashes]),
      ...(selection ? { afterIndex: selection.afterIndex, limit: selection.limit } : {}),
      ...(action === 'resume-delete' ? { operationId: state.deletion!.operationId, stage: state.deletion!.completedStages } : {}) });
    rawAuthorizers++;
    const actual = tracked(Promise.resolve().then(() => { alive(op); return authorize(scope); }).finally(() => { rawAuthorizers--; }));
    let timer: ReturnType<typeof setTimeout> | undefined, remove = () => {};
    const received = await Promise.race([actual, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), 1000); remove = listen(lifetime.signal, () => resolve(undefined));
    })]).finally(() => { if (timer !== undefined) clearTimeout(timer); remove(); });
    alive(op); if (received === undefined) fail('denied');
    const g = object(received, ['scope', 'signal', 'expiresAt', 'isCurrent']); if (g.scope !== scope || typeof g.isCurrent !== 'function') fail('denied');
    const at = clock(op), signal = g.signal as AbortSignal; aborted(signal);
    const expiresAt = integer(g.expiresAt, at + 1, deadline);
    op.grant = Object.freeze({ scope, signal, expiresAt, isCurrent: g.isCurrent as () => boolean });
    op.expectedEpoch = state.epoch; op.expectedRevision = state.revision; checkGrant(op.grant, op);
  }
  function attempt<T>(body: (op: Operation) => Promise<T>): Promise<RecordingOwnerDataResult<T>> {
    if (busy || rawAuthorizers) return Promise.resolve(bad('busy')); if (closed) return Promise.resolve(bad('closed'));
    busy = true; const op: Operation = { abort: new AbortController(), active: true };
    return tracked(Promise.resolve().then(async () => {
      try { clock(op); return ok(await body(op)); } catch (error) { return bad(error instanceof Refusal ? error.reason : 'unavailable'); }
      finally { op.active = false; op.abort.abort(); busy = false; }
    }));
  }
  async function verifyCopies(state: Envelope, current: () => void): Promise<void> {
    for (const copy of state.copies) for (const stored of copy.frames) {
      current(); if (!await verifyAssetContent(stored.reference, unhex(stored.hex))) fail('integrity'); current();
    }
  }
  async function initial(op: Operation): Promise<Envelope> {
    const state = await native(value => value, op); await verifyCopies(state, () => { clock(op); }); return state;
  }
  function appendAudit(state: Envelope, action: RecordingOwnerDataAudit['action'], at: number, removed: { clips: number; copyFrames: number }, pending = false,
    operationId = `cleanup:${state.nextOperation}`): string {
    state.audit = state.audit.filter(row => row.expiresAt > at);
    if (state.audit.length >= 128) fail('capacity');
    state.audit.push(Object.freeze({ operationId, action, state: pending ? 'pending' : 'completed', at,
      expiresAt: at + RECORDING_OWNER_DATA_LIMITS.auditRetentionMs, removed: Object.freeze({ ...removed }) }));
    state.nextOperation = bump(state.nextOperation); bounded(state); return operationId;
  }
  function actualClips(input: unknown): { id: string; expiresAt: number }[] {
    // This helper runs only AFTER the actual MediaRecording mutation validated this inner value in the same transaction.
    if (input === undefined) return [];
    const value = input as { clips: { id: string; expiresAt: number }[] }; return value.clips.map(clip => ({ id: clip.id, expiresAt: clip.expiresAt }));
  }
  function actualContent(input: unknown): string | undefined {
    // Invoked after the real producer validated both values. Trusted-time readbacks
    // advance the document revision, without changing the recorded content pin.
    if (input === undefined) return;
    const value = input as { epoch: number; nextClip: number; clips: unknown };
    return JSON.stringify({ epoch: value.epoch, nextClip: value.nextClip, clips: value.clips });
  }
  function makeProducer(context: Context): MediaRecording {
    const wrapped = Object.freeze<OwnerDataStorage>({ async transact<T>(requestedOwner: string, mutation: (current: unknown) => { state: unknown; result: T }, guard?: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) {
      if (requestedOwner !== owner || !guard) fail('wrong-owner');
      let advanced = false;
      try {
      const selected = await native(state => state, context.op, context, guard);
      await verifyCopies(selected, () => { if (context.lease) checkGrant(context.lease.grant); else clock(context.op); });
      const value = await native((state) => {
        if (state.revision !== selected.revision) fail('conflict');
        if (state.deletion?.state === 'pending' && !context.op) fail('review-required');
        const previous = state.recording;
        const next = mutation(previous); // Real createMediaRecording parser, mutation and native cancellation guard.
        const at = clock(context.op);
        const oldClips = actualClips(previous), newClips = actualClips(next.state);
        const expired = oldClips.filter(clip => clip.expiresAt <= at && !newClips.some(candidate => candidate.id === clip.id));
        const removedCopyFrames = state.copies.filter(copy => copy.expiresAt <= at || expired.some(clip => clip.id === copy.clipId)).reduce((sum, copy) => sum + copy.frames.length, 0);
        const changed = actualContent(previous) !== actualContent(next.state);
        state.audit = state.audit.filter(row => row.expiresAt > at);
        if (expired.length || removedCopyFrames) {
          appendAudit(state, 'expiry', at, { clips: expired.length, copyFrames: removedCopyFrames });
          state.copies = state.copies.filter(copy => copy.expiresAt > at && !expired.some(clip => clip.id === copy.clipId));
          state.epoch = bump(state.epoch); advanced = true;
        }
        context.expired = { clips: expired.length, copyFrames: removedCopyFrames };
        if (changed) state.dataRevision = bump(state.dataRevision);
        state.recording = next.state; state.lastNow = at;
        context.hook?.(state, next.result, at); bounded(state);
        return next.result;
      }, context.op, context, guard, true);
      if (advanced) void retirePort(activePort);
      return value;
      } catch (error) {
        if (error instanceof Refusal) {
          context.refusal = error.reason;
          if (context.lease && ['conflict', 'revoked', 'expired', 'invalid-clock'].includes(error.reason)) void retirePort(context.lease);
        }
        throw error;
      }
    } });
    return createMediaRecording({ ownerId: owner, ownerSignal: context.abort.signal, storage: wrapped, trustedNow,
      authorize(request) {
        alive(context.op); if (context.lease) { if (context.lease.retired) return undefined; checkGrant(context.lease.grant);
          // Managed byte export and deletion must go through fresh exact outer selection grants.
          if (request.action === 'export' || request.action === 'delete') return undefined;
        } else if (!context.op?.grant) return undefined;
        const grant = authorizeRecording(request); alive(context.op); return grant;
      } });
  }
  async function usingProducer<T>(op: Operation, hook: Context['hook'], body: (producer: MediaRecording) => Promise<T>): Promise<T> {
    const context: Context = { op, abort: op.abort, hook, expired: { clips: 0, copyFrames: 0 } }, producer = makeProducer(context);
    try { return await body(producer); }
    catch (error) { if (context.refusal) fail(context.refusal); throw error; }
    finally { await producer.close(); }
  }
  function producerValue<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>): T {
    if (result.ok) return result.value;
    const reason = result.reason; if (reason === 'storage-invalid') fail('corrupt'); if (reason === 'epoch-changed') fail('conflict');
    if (reason === 'quota' || reason === 'exhausted' || reason === 'backpressure') fail('capacity');
    if (['closed', 'expired', 'denied', 'busy', 'not-found', 'invalid-clock', 'unavailable'].includes(reason)) fail(reason as RecordingOwnerDataFailure);
    fail('revoked');
  }
  function exportInput(input: unknown, op: Operation): ExportRequest {
    const v = object(input, ['clipId', 'purpose', 'destinationId', 'expiresAt', 'afterIndex', 'limit']);
    return { clipId: token(v.clipId), purpose: token(v.purpose), destinationId: token(v.destinationId),
      expiresAt: integer(v.expiresAt, clock(op) + 1, lastNow + 30000), afterIndex: integer(v.afterIndex, 0, 32), limit: integer(v.limit, 1, 4) };
  }
  function expose(value: StoredFrame): RecordingOwnerDataFrame {
    const { hex: payload, ...facts } = value;
    return Object.freeze({ ...facts, sourceTime: Object.freeze({ ...facts.sourceTime }), reference: Object.freeze({ ...facts.reference }),
      get bytes() { return snapshotResourceBytes(unhex(payload)); } });
  }
  async function closedFrame(value: MediaRecordingStoredFrame): Promise<StoredFrame> {
    const payload = snapshotResourceBytes(value.bytes), reference = await createAssetReference('recording:frame', 'blob', payload);
    if (reference.sha256 !== value.sha256 || !await verifyAssetContent(reference, payload)) fail('integrity');
    return { index: value.index, ingestedAt: value.ingestedAt, sourceTime: { clockId: value.sourceTime.clockId, at: value.sourceTime.at },
      sequence: value.sequence, quality: value.quality, ...(value.decodedMediaTime === undefined ? {} : { decodedMediaTime: value.decodedMediaTime }), hex: hex(payload), reference };
  }
  let ownerOff = () => {};
  const controller = Object.freeze<RecordingOwnerDataController>({
    openRecording(input) { return attempt(async op => {
      if (activePort) fail('busy');
      const v = object(input, ['purpose', 'expiresAt', 'retireOwned']); if (typeof v.retireOwned !== 'function') fail('invalid');
      const expiresAt = integer(v.expiresAt, clock(op) + 1, lastNow + 30000), state = await initial(op);
      await approve(op, 'open-recording', state, token(v.purpose), 'local-recording', [], [], expiresAt);
      const abort = new AbortController(), context: Context = { op, abort, expired: { clips: 0, copyFrames: 0 } }, recording = makeProducer(context);
      let installed = false;
      try {
        producerValue(await recording.listReviewed({ purpose: 'managed-owner-validation', expiresAt: op.grant!.expiresAt })); checkGrant(op.grant!, op);
        const port: Lease = { abort, grant: op.grant!, epoch: op.expectedEpoch!, recording, retired: false,
          retireOwned: v.retireOwned as () => void, off: () => {} };
        activePort = port; context.op = undefined; context.lease = port; installed = true;
        port.off = listen(op.grant!.signal, () => { void retirePort(port); });
        port.timer = setTimeout(() => { void retirePort(port); }, Math.max(1, op.grant!.expiresAt - lastNow));
        alive(op); checkGrant(port.grant, op); if (port.retired || aborted(abort.signal)) fail('revoked');
        return Object.freeze({ recording, signal: abort.signal, close: () => retirePort(port) });
      } catch (error) { if (context.refusal) fail(context.refusal); throw error; }
      finally { if (!installed) { abort.abort(); await recording.close(); } }
    }); },
    exportPage(input) { return attempt(async op => {
      const request = exportInput(input, op), state = await initial(op);
      await approve(op, 'export', state, request.purpose, request.destinationId, [request.clipId], [], request.expiresAt, false, request);
      return usingProducer(op, undefined, async producer => {
        const clips = producerValue(await producer.listReviewed({ purpose: request.purpose, expiresAt: op.grant!.expiresAt }));
        const clip = clips.find(value => value.clipId === request.clipId); if (!clip) fail('not-found');
        op.contentExpiresAt = clip.expiresAt;
        const raw = producerValue(await producer.exportPage(request)), frames: StoredFrame[] = [];
        for (const value of raw.frames) { checkGrant(op.grant!, op); frames.push(await closedFrame(value)); checkGrant(op.grant!, op); }
        const current = await native(value => value, op);
        if (size(frames) > 8192 || clock(op) >= clip.expiresAt) fail('expired');
        await approve(op, 'export', current, request.purpose, request.destinationId, [request.clipId],
          frames.map(value => value.reference.sha256), request.expiresAt, false, request);
        await native(() => undefined, op); checkGrant(op.grant!, op);
        const page = Object.freeze({ profile: RECORDING_OWNER_DATA_PROFILE, clipId: clip.clipId, afterIndex: request.afterIndex,
          createdAt: clip.createdAt, expiresAt: clip.expiresAt, epoch: current.epoch, dataRevision: current.dataRevision,
          frames: Object.freeze(frames.map(expose)), ...(raw.nextIndex === undefined ? {} : { nextIndex: raw.nextIndex }) });
        pages.set(page, { epoch: page.epoch, dataRevision: page.dataRevision, clipId: page.clipId, afterIndex: request.afterIndex, limit: request.limit,
          purpose: request.purpose, destinationId: request.destinationId, expiresAt: page.expiresAt, hashes: frames.map(value => value.reference.sha256), used: false });
        return page;
      });
    }); },
    storeRegisteredExport(page, input) { return attempt(async op => {
      if (!page || typeof page !== 'object') fail('invalid'); const issued = pages.get(page); if (!issued || issued.used) fail('invalid');
      op.contentExpiresAt = issued.expiresAt;
      const request = object(input, ['purpose', 'destinationId']);
      if (token(request.purpose) !== issued.purpose || token(request.destinationId) !== issued.destinationId) fail('denied');
      const state = await initial(op);
      if (state.epoch !== issued.epoch || state.dataRevision !== issued.dataRevision) fail('conflict');
      if (clock(op) >= issued.expiresAt) fail('expired');
      await approve(op, 'register-copy', state, issued.purpose, issued.destinationId, [issued.clipId], issued.hashes,
        clock(op) + 30000, false, issued);
      let copied = 0, copyId = '';
      return usingProducer(op, (current, _result, at) => {
        if (current.epoch !== issued.epoch || current.dataRevision !== issued.dataRevision || at >= issued.expiresAt) fail('conflict');
      }, async producer => {
        const raw = producerValue(await producer.exportPage({ clipId: issued.clipId, purpose: issued.purpose, destinationId: issued.destinationId,
          expiresAt: op.grant!.expiresAt, afterIndex: issued.afterIndex, limit: issued.limit }));
        const frames: StoredFrame[] = [];
        for (const value of raw.frames) frames.push(await closedFrame(value));
        if (frames.length !== issued.hashes.length || frames.some((value, index) => value.reference.sha256 !== issued.hashes[index])) fail('integrity');
        await native((current, at) => {
          if (current.epoch !== issued.epoch || current.dataRevision !== issued.dataRevision || at >= issued.expiresAt) fail('conflict');
          copyId = `copy:${current.nextCopy}`; current.nextCopy = bump(current.nextCopy);
          current.copies.push({ id: copyId, clipId: issued.clipId, expiresAt: issued.expiresAt, frames });
          current.dataRevision = bump(current.dataRevision); copied = frames.length; bounded(current);
        }, op);
        issued.used = true; return Object.freeze({ copied, copyId });
      });
    }); },
    beginDeletion(input) { return attempt(async op => {
      const request = object(input, ['clipIds', 'purpose']), clipIds = array(request.clipIds, 4).map(token);
      if (!clipIds.length || new Set(clipIds).size !== clipIds.length) fail('invalid');
      const state = await initial(op); await approve(op, 'delete', state, token(request.purpose), 'owner-local', clipIds);
      let deletion: RecordingOwnerDataDeletion | undefined;
      await usingProducer(op, (current, result, at) => {
        const clips = result as readonly { clipId: string }[]; if (clipIds.some(id => !clips.some(clip => clip.clipId === id))) fail('not-found');
        const operationId = appendAudit(current, 'deletion', at, { clips: 0, copyFrames: 0 }, true);
        current.epoch = bump(current.epoch);
        current.deletion = { operationId, state: 'pending', completedStages: 0, startedAt: at, updatedAt: at,
          removed: { clips: 0, copyFrames: 0 }, clipIds };
        bounded(current); void retirePort(activePort); checkGrant(op.grant!, op);
        deletion = publicDeletion(current.deletion);
      }, async producer => { producerValue(await producer.listReviewed({ purpose: 'managed-owner-deletion', expiresAt: op.grant!.expiresAt })); });
      return deletion!;
    }); },
    resumeDeletionReviewed(operationId) { return attempt(async op => {
      token(operationId); const state = await initial(op), pending = state.deletion;
      if (!pending || pending.operationId !== operationId) fail('not-found'); if (pending.state === 'completed') fail('review-required');
      await approve(op, 'resume-delete', state, 'owner-reviewed-stage', 'owner-local', pending.clipIds, [], clock(op) + 30000, true);
      let result: RecordingOwnerDataDeletion | undefined;
      if (pending.completedStages < pending.clipIds.length) {
        await usingProducer(op, (current, value, at) => {
          const deletion = current.deletion!; if (deletion.operationId !== operationId || deletion.completedStages !== pending.completedStages) fail('conflict');
          // The hook is inside the real storage mutation: deleteReviewed stores
          // a numeric removal count, then wraps it as { removed } after commit.
          const removed = integer(value, 0, 1);
          current.deletion = { ...deletion, completedStages: deletion.completedStages + 1, updatedAt: at,
            removed: { clips: deletion.removed.clips + removed, copyFrames: deletion.removed.copyFrames } };
          current.dataRevision = bump(current.dataRevision); result = publicDeletion(current.deletion);
        }, async producer => { producerValue(await producer.deleteReviewed({ clipId: pending.clipIds[pending.completedStages]!,
          purpose: 'owner-reviewed-stage', expiresAt: op.grant!.expiresAt })); });
      } else {
        await usingProducer(op, (current, value, at) => {
          const clips = value as readonly { clipId: string }[]; if (pending.clipIds.some(id => clips.some(clip => clip.clipId === id))) fail('conflict');
          const deletion = current.deletion!, removed = current.copies.filter(copy => pending.clipIds.includes(copy.clipId)).reduce((sum, copy) => sum + copy.frames.length, 0);
          current.copies = current.copies.filter(copy => !pending.clipIds.includes(copy.clipId));
          current.deletion = { ...deletion, state: 'completed', completedStages: pending.clipIds.length + 1, updatedAt: at,
            removed: { clips: deletion.removed.clips, copyFrames: deletion.removed.copyFrames + removed } };
          const previousAudit = current.audit.findIndex(row => row.operationId === operationId);
          if (previousAudit < 0) appendAudit(current, 'deletion', at, current.deletion.removed, false, operationId);
          else current.audit[previousAudit] = Object.freeze({ operationId, action: 'deletion', state: 'completed', at,
            expiresAt: at + RECORDING_OWNER_DATA_LIMITS.auditRetentionMs, removed: Object.freeze({ ...current.deletion.removed }) });
          current.dataRevision = bump(current.dataRevision); bounded(current); result = publicDeletion(current.deletion);
        }, async producer => { producerValue(await producer.listReviewed({ purpose: 'owner-reviewed-stage', expiresAt: op.grant!.expiresAt })); });
      }
      const verified = await native(current => publicDeletion(current.deletion), op);
      if (!verified || verified.operationId !== operationId || verified.completedStages !== result!.completedStages) fail('conflict');
      return verified;
    }); },
    inspectDeletion() { return attempt(async op => { const state = await initial(op);
      await approve(op, 'review', state, 'owner-review', 'owner-review', [], [], clock(op) + 30000, true);
      return usingProducer(op, undefined, async producer => { producerValue(await producer.listReviewed({ purpose: 'owner-review', expiresAt: op.grant!.expiresAt }));
        return native(current => publicDeletion(current.deletion), op); }); }); },
    listAudit() { return attempt(async op => { const state = await initial(op);
      await approve(op, 'review', state, 'owner-review', 'owner-review', [], [], clock(op) + 30000, true);
      return usingProducer(op, undefined, async producer => { producerValue(await producer.listReviewed({ purpose: 'owner-review', expiresAt: op.grant!.expiresAt }));
        return native(current => Object.freeze(current.audit.map(value => audit(value))), op); }); }); },
    sweep() { return attempt(async op => { const state = await initial(op);
      await approve(op, 'sweep', state, 'owner-retention', 'owner-local');
      let removed = { clipsRemoved: 0, copyFramesRemoved: 0 };
      const context: Context = { op, abort: op.abort, expired: { clips: 0, copyFrames: 0 } }, producer = makeProducer(context);
      try { producerValue(await producer.sweep()); removed = { clipsRemoved: context.expired.clips, copyFramesRemoved: context.expired.copyFrames }; }
      catch (error) { if (context.refusal) fail(context.refusal); throw error; }
      finally { await producer.close(); }
      return Object.freeze(removed);
    }); },
    close() {
      if (closePromise) return closePromise; closed = true;
      closePromise = Promise.resolve().then(async () => { while (tasks.size) await Promise.allSettled([...tasks]); });
      lifetime.abort(); ownerOff(); void retirePort(activePort); return closePromise;
    },
  });
  ownerOff = listen(ownerSignal, () => { void controller.close(); });
  return controller;
}
