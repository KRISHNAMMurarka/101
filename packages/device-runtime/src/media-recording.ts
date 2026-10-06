import { createAssetReference, snapshotResourceBytes, verifyAssetContent } from '@101/device-model';
import type { OwnerDataStorage } from './owner-data.ts';

/** Selected local RGBA ledger budgets. These are buffer/operation limits, not a host sandbox. */
export const MEDIA_RECORDING_LIMITS = Object.freeze({ width: 8, height: 8, frameBytes: 256, clips: 4,
  framesPerClip: 32, pendingFrames: 4, pendingBytes: 1024, pageFrames: 4, ownerBytes: 262144,
  rawOperations: 1, operationAttempts: 64, consentMs: 30000, retentionMs: 60000, maxRetentionMs: 86400000,
  captureHandles: 4, playbackHandles: 4, expiryTimers: 1 });
export interface MediaRecordingSource {
  readonly deviceId: string; readonly capabilityId: string; readonly registrationId: string;
  readonly applicationId: string; readonly sessionId: string; readonly clockId: string;
}
export interface MediaRecordingFrame {
  readonly bytes: Uint8Array; readonly sourceTime: Readonly<{ clockId: string; at: number }>;
  readonly sequence: number; readonly quality: 'valid' | 'observed' | 'unverified'; readonly decodedMediaTime?: number;
}
export interface MediaRecordingSourceContext {
  readonly source: MediaRecordingSource; readonly signal: AbortSignal; isCurrent(): boolean;
}
export interface MediaRecordingRequest {
  readonly action: 'capture' | 'playback' | 'list' | 'export' | 'delete'; readonly ownerId: string;
  readonly destinationId: string; readonly purpose: string; readonly expiresAt: number;
  readonly clipId?: string; readonly source?: MediaRecordingSource; readonly retentionMs?: number;
}
export interface MediaRecordingGrant {
  readonly request: MediaRecordingRequest; readonly signal: AbortSignal; readonly expiresAt: number;
}
export interface MediaRecordingCaptureRequest {
  readonly source: MediaRecordingSource; readonly purpose: string; readonly expiresAt: number; readonly retentionMs?: number;
}
export interface MediaRecordingPlaybackRequest {
  readonly clipId: string; readonly destinationId: string; readonly purpose: string; readonly expiresAt: number;
}
export interface MediaRecordingReviewRequest { readonly purpose: string; readonly expiresAt: number }
export interface MediaRecordingExportRequest extends MediaRecordingPlaybackRequest { readonly afterIndex: number; readonly limit: number }
export interface MediaRecordingDeleteRequest extends MediaRecordingReviewRequest { readonly clipId?: string }
export interface MediaRecordingOptions {
  readonly ownerId: string; readonly ownerSignal: AbortSignal; readonly storage: OwnerDataStorage;
  readonly trustedNow: () => number;
  readonly authorize: (request: Readonly<MediaRecordingRequest>) => MediaRecordingGrant | undefined;
}
declare const captureBrand: unique symbol, playbackBrand: unique symbol;
export interface MediaRecordingCaptureHandle { readonly [captureBrand]: true }
export interface MediaRecordingPlaybackHandle { readonly [playbackBrand]: true }
export type MediaRecordingFailure = 'closed' | 'cancelled' | 'invalid-clock' | 'invalid-request' | 'invalid-frame' |
  'invalid-handle' | 'denied' | 'expired' | 'busy' | 'exhausted' | 'backpressure' | 'quota' | 'unavailable' |
  'storage-invalid' | 'epoch-changed' | 'not-found' | 'seek-changed' | 'end';
export type MediaRecordingResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: MediaRecordingFailure }>;
export interface MediaRecordingStoredFrame extends MediaRecordingFrame { readonly index: number; readonly ingestedAt: number; readonly sha256: string }
export interface MediaRecordingClip {
  readonly clipId: string; readonly source: MediaRecordingSource; readonly createdAt: number;
  readonly expiresAt: number; readonly frameCount: number;
}
export interface MediaRecordingPlaybackFrame {
  readonly frame: MediaRecordingStoredFrame;
  readonly playback: Readonly<{ clockId: 'recording-host-emission'; at: number; index: number; seekEpoch: number }>;
}
export interface MediaRecordingExportPage { readonly frames: readonly MediaRecordingStoredFrame[]; readonly nextIndex?: number }
export interface MediaRecording {
  requestCapture(request: MediaRecordingCaptureRequest): Promise<MediaRecordingResult<Readonly<{ handle: MediaRecordingCaptureHandle; clipId: string }>>>;
  enqueue(handle: unknown, frame: MediaRecordingFrame, context: MediaRecordingSourceContext): MediaRecordingResult<undefined>;
  flush(): Promise<MediaRecordingResult<Readonly<{ committed: number }>>>;
  requestPlayback(request: MediaRecordingPlaybackRequest): Promise<MediaRecordingResult<MediaRecordingPlaybackHandle>>;
  /** A retirement fence for caller-owned output; lookup cannot renew this grant or authorize a live route. */
  playbackLifetime(handle: unknown): MediaRecordingResult<Readonly<{ signal: AbortSignal; expiresAt: number }>>;
  seek(handle: unknown, index: number): MediaRecordingResult<undefined>;
  pull(handle: unknown): Promise<MediaRecordingResult<MediaRecordingPlaybackFrame>>;
  listReviewed(request: MediaRecordingReviewRequest): Promise<MediaRecordingResult<readonly MediaRecordingClip[]>>;
  exportPage(request: MediaRecordingExportRequest): Promise<MediaRecordingResult<MediaRecordingExportPage>>;
  deleteReviewed(request: MediaRecordingDeleteRequest): Promise<MediaRecordingResult<Readonly<{ removed: number }>>>;
  sweep(): Promise<MediaRecordingResult<Readonly<{ removed: number }>>>;
  revoke(handle: unknown): void;
  status(): Readonly<{ closed: boolean; clockFault: boolean; captures: number; players: number; pendingFrames: number;
    pendingBytes: number; rawPending: number; attempts: number; timers: number; listeners: number; admitted: number; dropped: number }>;
  close(): Promise<void>;
}

type Stored = Omit<MediaRecordingStoredFrame, 'bytes'> & { hex: string };
interface Clip { id: string; source: MediaRecordingSource; createdAt: number; expiresAt: number; frames: Stored[] }
interface State { version: 1; profile: 'application-rgba-recording/1'; ownerId: string; epoch: number; nextClip: number; lastNow: number; clips: Clip[] }
interface Life { controller: AbortController; signal: AbortSignal; expiresAt: number; active: boolean; off: () => void }
interface Capture extends Life { source: MediaRecordingSource; clipId: string; epoch: number; lastSequence: number; lastSourceAt: number }
interface Player extends Life { clipId: string; epoch: number; index: number; seekEpoch: number }
interface Pending { capture: Capture; frame: MediaRecordingFrame; context: MediaRecordingSourceContext; ingestedAt: number }
interface Operation { controller: AbortController; off: (() => void)[]; contexts: MediaRecordingSourceContext[]; deadline: number }
class Refusal extends Error {
  readonly reason: MediaRecordingFailure;
  constructor(reason: MediaRecordingFailure) { super('recording-refused'); this.reason = reason; }
}
function refuse(reason: MediaRecordingFailure): never { throw new Refusal(reason); }
const failure = (reason: MediaRecordingFailure): MediaRecordingResult<never> => Object.freeze({ ok: false, reason });
const success = <T>(value: T): MediaRecordingResult<T> => Object.freeze({ ok: true, value });
const abortedGet = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const on = EventTarget.prototype.addEventListener, off = EventTarget.prototype.removeEventListener;
const byteLengthGet = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function aborted(signal: unknown): boolean { try { return abortedGet.call(signal) as boolean; } catch { return refuse('invalid-request'); } }
function record(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) refuse('invalid-request');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== Object.keys(descriptors).length ||
    Object.values(descriptors).some(d => !d.enumerable || !('value' in d)) ||
    keys.some(key => !Object.hasOwn(descriptors, key)) || Object.keys(descriptors).some(key => !keys.includes(key) && !optional.includes(key))) refuse('invalid-request');
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}
function list(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input)) refuse('invalid-request');
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!Number.isSafeInteger(length) || length > maximum || length < 0 || Reflect.ownKeys(input).length !== length + 1) refuse('invalid-request');
  const output: unknown[] = [];
  for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(input, String(i));
    if (!d?.enumerable || !('value' in d)) refuse('invalid-request'); output.push(d.value); }
  return output;
}
function token(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) refuse('invalid-request'); return input;
}
function number(input: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < minimum || input > maximum || integer && !Number.isSafeInteger(input)) refuse('invalid-request'); return input;
}
function source(input: unknown): MediaRecordingSource {
  const v = record(input, ['deviceId', 'capabilityId', 'registrationId', 'applicationId', 'sessionId', 'clockId']);
  return Object.freeze({ deviceId: token(v.deviceId), capabilityId: token(v.capabilityId), registrationId: token(v.registrationId),
    applicationId: token(v.applicationId), sessionId: token(v.sessionId), clockId: token(v.clockId) });
}
function sameSource(a: MediaRecordingSource, b: MediaRecordingSource) { return Object.keys(a).every(key => a[key as keyof MediaRecordingSource] === b[key as keyof MediaRecordingSource]); }
function stamp(input: unknown): Readonly<{ clockId: string; at: number }> {
  const v = record(input, ['clockId', 'at']); return Object.freeze({ clockId: token(v.clockId), at: number(v.at) });
}
function parseFrame(input: unknown): MediaRecordingFrame {
  const v = record(input, ['bytes', 'sourceTime', 'sequence', 'quality'], ['decodedMediaTime']);
  if (!(v.bytes instanceof Uint8Array) || byteLengthGet.call(v.bytes) !== 256) refuse('invalid-frame');
  const bytes = snapshotResourceBytes(v.bytes); if (bytes.byteLength !== 256) refuse('invalid-frame');
  if (v.quality !== 'valid' && v.quality !== 'observed' && v.quality !== 'unverified') refuse('invalid-frame');
  return Object.freeze({ bytes, sourceTime: stamp(v.sourceTime), sequence: number(v.sequence, 0, 0xffffffff, true), quality: v.quality,
    ...(v.decodedMediaTime === undefined ? {} : { decodedMediaTime: number(v.decodedMediaTime) }) });
}
function parseContext(input: unknown): MediaRecordingSourceContext {
  const v = record(input, ['source', 'signal', 'isCurrent']); aborted(v.signal);
  if (typeof v.isCurrent !== 'function') refuse('invalid-request');
  return Object.freeze({ source: source(v.source), signal: v.signal as AbortSignal, isCurrent: v.isCurrent as () => boolean });
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function unhex(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16)); }
function stored(input: unknown, clip: Clip, previous?: Stored): Stored {
  const v = record(input, ['index', 'sourceTime', 'sequence', 'quality', 'ingestedAt', 'sha256', 'hex'], ['decodedMediaTime']);
  if (typeof v.hex !== 'string' || !/^[0-9a-f]{512}$/.test(v.hex) || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) refuse('storage-invalid');
  if (v.quality !== 'valid' && v.quality !== 'observed' && v.quality !== 'unverified') refuse('storage-invalid');
  const time = stamp(v.sourceTime), sequence = number(v.sequence, 0, 0xffffffff, true);
  if (time.clockId !== clip.source.clockId || previous && (sequence <= previous.sequence || time.at < previous.sourceTime.at)) refuse('storage-invalid');
  return Object.freeze({ index: number(v.index, 0, 31, true), sourceTime: time, sequence, quality: v.quality,
    ingestedAt: number(v.ingestedAt, clip.createdAt, clip.expiresAt - 1, true), sha256: v.sha256, hex: v.hex,
    ...(v.decodedMediaTime === undefined ? {} : { decodedMediaTime: number(v.decodedMediaTime) }) });
}
function parseState(input: unknown, ownerId: string, at: number): State {
  if (input === undefined) return { version: 1, profile: 'application-rgba-recording/1', ownerId, epoch: 1, nextClip: 1, lastNow: at, clips: [] };
  try {
    const v = record(input, ['version', 'profile', 'ownerId', 'epoch', 'nextClip', 'lastNow', 'clips']);
    if (v.version !== 1 || v.profile !== 'application-rgba-recording/1' || v.ownerId !== ownerId) refuse('storage-invalid');
    const state: State = { version: 1, profile: 'application-rgba-recording/1', ownerId,
      epoch: number(v.epoch, 1, Number.MAX_SAFE_INTEGER - 1, true), nextClip: number(v.nextClip, 1, Number.MAX_SAFE_INTEGER - 1, true),
      lastNow: number(v.lastNow, 0, Number.MAX_SAFE_INTEGER, true), clips: [] };
    if (state.lastNow > at) refuse('invalid-clock');
    for (const raw of list(v.clips, 4)) {
      const c = record(raw, ['id', 'source', 'createdAt', 'expiresAt', 'frames']);
      const createdAt = number(c.createdAt, 0, state.lastNow, true);
      const clip: Clip = { id: token(c.id), source: source(c.source), createdAt,
        expiresAt: number(c.expiresAt, createdAt + 1, createdAt + 86400000, true), frames: [] };
      if (!/^clip:[1-9][0-9]*$/.test(clip.id) || state.clips.some(previous => previous.id === clip.id) ||
        Number(clip.id.slice(5)) >= state.nextClip) refuse('storage-invalid');
      for (const rawFrame of list(c.frames, 32)) {
        const next = stored(rawFrame, clip, clip.frames.at(-1)); if (next.index !== clip.frames.length || next.ingestedAt > state.lastNow) refuse('storage-invalid');
        clip.frames.push(next);
      }
      state.clips.push(clip);
    }
    bounded(state); return state;
  } catch (error) { if (error instanceof Refusal && error.reason === 'invalid-clock') throw error; return refuse('storage-invalid'); }
}
function bounded(state: State) { if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 262144) refuse('quota'); }
function info(clip: Clip): MediaRecordingClip { return Object.freeze({ clipId: clip.id, source: clip.source,
  createdAt: clip.createdAt, expiresAt: clip.expiresAt, frameCount: clip.frames.length }); }
function exposed(frame: Stored): MediaRecordingStoredFrame { const { hex: encoded, ...rest } = frame; return Object.freeze({ ...rest, bytes: unhex(encoded) }); }
function reference(frame: Stored) { return { id: 'recording:frame', kind: 'blob', mediaType: 'application/octet-stream', byteLength: 256, sha256: frame.sha256 }; }

/**
 * Inert, opt-in local recording. The caller supplies actual current routed source facts and
 * separately authorizes every live source/sink route. Grants/handles never enter storage.
 * Source timestamps are preserved, never treated as capture freshness or retention clocks.
 * The trusted host, synchronous authorizer and storage contract are not a sandbox boundary.
 */
export function createMediaRecording(options: MediaRecordingOptions): MediaRecording {
  const o = record(options, ['ownerId', 'ownerSignal', 'storage', 'trustedNow', 'authorize']);
  const ownerId = token(o.ownerId), ownerSignal = o.ownerSignal as AbortSignal; aborted(ownerSignal);
  if (typeof o.trustedNow !== 'function' || typeof o.authorize !== 'function') throw new TypeError('Invalid recording configuration');
  const storage = o.storage as OwnerDataStorage, transaction = Object.getOwnPropertyDescriptor(storage, 'transact')?.value;
  if (typeof transaction !== 'function') throw new TypeError('Invalid recording storage');
  const trustedNow = o.trustedNow as () => number, authorize = o.authorize as MediaRecordingOptions['authorize'];
  let closed = false, clockFault = false, lastNow = -1, rawPending = 0, attempts = 0, admitting = false, admitted = 0, dropped = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, closePromise: Promise<void> | undefined, listeners = 0;
  let activeOperation: Operation | undefined;
  const lifetime = new AbortController(), captures = new Set<Capture>(), players = new Set<Player>();
  const captureMap = new WeakMap<object, Capture>(), playerMap = new WeakMap<object, Player>();
  const tasks = new Set<Promise<unknown>>(); let pending: Pending[] = [], flushing: Pending[] = [];
  let ownerOff = () => {};
  function listen(signal: AbortSignal, callback: () => void): () => void {
    if (aborted(signal)) { callback(); return () => {}; }
    let installed = true; listeners++;
    const remove = () => { if (!installed) return; installed = false; off.call(signal, 'abort', changed); listeners--; };
    const changed = () => { remove(); callback(); };
    on.call(signal, 'abort', changed); if (aborted(signal)) changed(); return remove;
  }
  function retire(life: Life) { if (!life.active) return; life.active = false; life.controller.abort(); life.off();
    captures.delete(life as Capture); players.delete(life as Player); pending = pending.filter(row => row.capture !== life); }
  function retireAll() { for (const item of [...captures, ...players]) retire(item); pending = []; }
  function alive(op?: Operation) { if (closed) refuse('closed'); if (aborted(ownerSignal) || aborted(lifetime.signal) || op && aborted(op.controller.signal)) refuse('cancelled'); }
  function clock(op?: Operation): number {
    alive(op); const at = trustedNow(); alive(op);
    if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 86400000 || at < lastNow) {
      clockFault = true; retireAll(); lifetime.abort(); return refuse('invalid-clock');
    }
    lastNow = at; return at;
  }
  function lifeCurrent(life: Life, op?: Operation) { const at = clock(op);
    if (!life.active || aborted(life.controller.signal) || aborted(life.signal)) refuse('cancelled');
    if (at >= life.expiresAt) { retire(life); refuse('expired'); } return at; }
  function sourceCurrent(context: MediaRecordingSourceContext, op?: Operation) {
    alive(op); if (aborted(context.signal)) refuse('cancelled'); const current = context.isCurrent(); alive(op);
    if (aborted(context.signal) || current !== true) refuse('cancelled');
  }
  function addSignal(op: Operation, signal: AbortSignal) { const cancel = () => op.controller.abort(); op.off.push(listen(signal, cancel)); alive(op); }
  function check(op: Operation) {
    if (clock(op) >= op.deadline) refuse('expired');
    for (const context of op.contexts) sourceCurrent(context, op);
    // Observers can advance the trusted clock or revoke another context. The
    // final clock call is followed only by intrinsic authority/signal checks.
    const at = clock(op); if (at >= op.deadline) refuse('expired');
    alive(op); for (const context of op.contexts) if (aborted(context.signal)) refuse('cancelled');
    return at;
  }
  function attachLife(op: Operation, life: Life) {
    lifeCurrent(life, op); op.deadline = Math.min(op.deadline, life.expiresAt);
    addSignal(op, life.controller.signal); addSignal(op, life.signal); check(op); arm(lastNow);
  }
  function run<T>(body: (op: Operation) => Promise<T>): Promise<MediaRecordingResult<T>> {
    if (closed) return Promise.resolve(failure('closed'));
    if (aborted(ownerSignal) || aborted(lifetime.signal)) return Promise.resolve(failure(clockFault ? 'invalid-clock' : 'cancelled'));
    if (rawPending) return Promise.resolve(failure('busy'));
    if (attempts >= 64) return Promise.resolve(failure('exhausted'));
    attempts++; rawPending++;
    const op: Operation = { controller: new AbortController(), off: [], contexts: [], deadline: Infinity };
    activeOperation = op;
    // Install the tracked task before ANY clock/authorizer/storage/digest callout.
    const task = Promise.resolve().then(async () => {
      try { addSignal(op, lifetime.signal); addSignal(op, ownerSignal); check(op); return success(await body(op)); }
      catch (error) { return failure(error instanceof Refusal ? error.reason : 'unavailable'); }
      finally { for (const remove of op.off) remove(); rawPending--; activeOperation = undefined; arm(lastNow); }
    });
    tasks.add(task); void task.then(() => tasks.delete(task)); return task;
  }
  function scope(action: MediaRecordingRequest['action'], input: unknown, at: number): Readonly<MediaRecordingRequest> {
    const required = action === 'capture' ? ['source', 'purpose', 'expiresAt'] : action === 'list' || action === 'delete'
      ? ['purpose', 'expiresAt'] : ['clipId', 'destinationId', 'purpose', 'expiresAt'];
    const optional = action === 'capture' ? ['retentionMs'] : action === 'export' ? ['afterIndex', 'limit'] : action === 'delete' ? ['clipId'] : [];
    const v = record(input, required, optional), expiresAt = number(v.expiresAt, at + 1, at + 30000, true);
    const issued: MediaRecordingRequest = { action, ownerId, destinationId: action === 'capture' || action === 'delete' ? 'local-recording'
      : action === 'list' ? 'owner-review' : token(v.destinationId), purpose: token(v.purpose), expiresAt,
      ...(v.clipId === undefined ? {} : { clipId: token(v.clipId) }),
      ...(action === 'capture' ? { source: source(v.source), retentionMs: number(v.retentionMs ?? 60000, 1, 86400000, true) } : {}) };
    return Object.freeze(issued);
  }
  function approve(op: Operation, issued: Readonly<MediaRecordingRequest>) {
    check(op); const result = authorize(issued); const at = check(op); if (result === undefined) refuse('denied');
    const v = record(result, ['request', 'signal', 'expiresAt']);
    if (v.request !== issued) refuse('denied'); const signal = v.signal as AbortSignal;
    if (aborted(signal)) refuse('cancelled');
    const expiresAt = number(v.expiresAt, at + 1, issued.expiresAt, true);
    op.deadline = Math.min(op.deadline, expiresAt); addSignal(op, signal); check(op); arm(lastNow); return { signal, expiresAt };
  }
  async function transact<T>(op: Operation, mutation: (state: State, at: number, pruned: number) => T): Promise<T> {
    check(op);
    let result: T;
    try { result = await Reflect.apply(transaction, storage, [ownerId, (current: unknown) => {
      const at = check(op); let state: State;
      try { state = parseState(current, ownerId, at); }
      catch (error) { if (error instanceof Refusal && error.reason === 'invalid-clock') {
        clockFault = true; retireAll(); lifetime.abort(); }
        throw error;
      }
      const retained = state.clips.filter(clip => clip.expiresAt > at);
      const pruned = state.clips.length - retained.length;
      if (pruned) { if (state.epoch >= Number.MAX_SAFE_INTEGER - 1) refuse('quota'); state.clips = retained; state.epoch++; }
      const value = mutation(state, at, pruned); state.lastNow = check(op); bounded(state);
      return { state, result: value };
    }, { signal: op.controller.signal, isCurrent: () => { try { check(op); return true; } catch { return false; } } }]) as T;
    } catch (error) { check(op); throw error; }
    check(op); return result;
  }
  function sweepAuthority() {
    try { const at = clock(); if (activeOperation && at >= activeOperation.deadline) activeOperation.controller.abort();
      for (const life of [...captures, ...players])
      if (!life.active || aborted(life.signal) || at >= life.expiresAt) retire(life);
      pending = pending.filter(row => { try { lifeCurrent(row.capture); sourceCurrent(row.context); return true; } catch { return false; } });
      arm(at);
    } catch { retireAll(); if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; }
  }
  function arm(at: number) {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
    if (closed || aborted(ownerSignal) || aborted(lifetime.signal)) return;
    const deadlines = [...captures, ...players].map(life => life.expiresAt);
    if (activeOperation && !aborted(activeOperation.controller.signal) && Number.isFinite(activeOperation.deadline)) deadlines.push(activeOperation.deadline);
    if (deadlines.length) expiryTimer = setTimeout(() => { expiryTimer = undefined; sweepAuthority(); }, Math.max(1, Math.min(...deadlines) - at));
  }
  function makeLife(grant: { signal: AbortSignal; expiresAt: number }): Life {
    const life: Life = { controller: new AbortController(), signal: grant.signal, expiresAt: grant.expiresAt, active: true, off: () => {} };
    life.off = listen(grant.signal, () => { retire(life); if (!closed) arm(lastNow); }); return life;
  }
  function lookup<T extends Life>(map: WeakMap<object, T>, handle: unknown): T {
    if (!handle || typeof handle !== 'object') refuse('invalid-handle'); const life = map.get(handle);
    if (!life) refuse('invalid-handle'); lifeCurrent(life); return life;
  }
  async function verify(op: Operation, frames: readonly Stored[]) {
    for (const frame of frames) { check(op); if (!await verifyAssetContent(reference(frame), unhex(frame.hex))) refuse('storage-invalid'); check(op); }
  }
  async function checkEpoch(op: Operation, epoch: number) { await transact(op, state => { if (state.epoch !== epoch) refuse('epoch-changed'); }); }
  function retireController() { lifetime.abort(); retireAll(); if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; ownerOff(); }
  ownerOff = listen(ownerSignal, retireController);
  const controller: MediaRecording = {
    requestCapture(input) { return run(async op => {
      if (captures.size >= 4) refuse('quota'); const issued = scope('capture', input, check(op)), grant = approve(op, issued);
      const selected = await transact(op, (state, at) => {
        if (state.clips.length >= 4 || state.nextClip >= Number.MAX_SAFE_INTEGER - 1) refuse('quota');
        const clip: Clip = { id: `clip:${state.nextClip++}`, source: issued.source!, createdAt: at,
          expiresAt: at + issued.retentionMs!, frames: [] }; state.clips.push(clip); return { clipId: clip.id, epoch: state.epoch, expiresAt: clip.expiresAt };
      });
      check(op); const item = Object.assign(makeLife({ ...grant, expiresAt: Math.min(grant.expiresAt, selected.expiresAt) }),
        { source: issued.source!, clipId: selected.clipId, epoch: selected.epoch, lastSequence: -1, lastSourceAt: -1 }) as Capture;
      lifeCurrent(item, op); const handle = Object.freeze({}) as MediaRecordingCaptureHandle;
      captures.add(item); captureMap.set(handle, item); arm(lastNow); lifeCurrent(item, op);
      return Object.freeze({ handle, clipId: selected.clipId });
    }); },
    enqueue(handle, input, suppliedContext) {
      if (admitting) return failure('busy'); admitting = true;
      try {
        const item = lookup(captureMap, handle); if (pending.length + flushing.length >= 4) refuse('backpressure');
        const context = parseContext(suppliedContext), at = lifeCurrent(item); sourceCurrent(context);
        if (!sameSource(item.source, context.source)) refuse('invalid-frame');
        const frame = parseFrame(input); lifeCurrent(item); sourceCurrent(context); lifeCurrent(item);
        if (frame.sourceTime.clockId !== item.source.clockId || frame.sequence <= item.lastSequence || frame.sourceTime.at < item.lastSourceAt) refuse('invalid-frame');
        item.lastSequence = frame.sequence; item.lastSourceAt = frame.sourceTime.at;
        pending.push({ capture: item, frame, context, ingestedAt: at }); admitted++; return success(undefined);
      } catch (error) { dropped++; return failure(error instanceof Refusal ? error.reason : 'invalid-frame'); }
      finally { admitting = false; }
    },
    flush() { return run(async op => {
      sweepAuthority(); check(op); const batch = pending.splice(0, 4).filter(row => {
        try { lifeCurrent(row.capture, op); sourceCurrent(row.context, op); return true; } catch { return false; }
      });
      if (!batch.length) return Object.freeze({ committed: 0 }); flushing = batch;
      try {
      for (const row of batch) { attachLife(op, row.capture);
        addSignal(op, row.context.signal); op.contexts.push(row.context); }
      const encoded: { pending: Pending; sha256: string }[] = [];
      for (const row of batch) {
        lifeCurrent(row.capture, op); check(op);
        const digest = await createAssetReference('recording:frame', 'blob', row.frame.bytes);
        lifeCurrent(row.capture, op); check(op); encoded.push({ pending: row, sha256: digest.sha256 });
      }
      const committed = await transact(op, state => {
        for (const entry of encoded) {
          const row = entry.pending; lifeCurrent(row.capture, op);
          if (state.epoch !== row.capture.epoch) refuse('epoch-changed');
          const clip = state.clips.find(candidate => candidate.id === row.capture.clipId); if (!clip) refuse('not-found');
          if (clip.frames.length >= 32) refuse('quota');
          const { bytes: payload, ...facts } = row.frame;
          const next: Stored = { ...facts, index: clip.frames.length, ingestedAt: row.ingestedAt, sha256: entry.sha256, hex: hex(payload) };
          const previous = clip.frames.at(-1); if (previous && (next.sequence <= previous.sequence || next.sourceTime.at < previous.sourceTime.at)) refuse('invalid-frame');
          clip.frames.push(next);
        }
        return encoded.length;
      });
      return Object.freeze({ committed });
      } finally { flushing = []; }
    }); },
    requestPlayback(input) { return run(async op => {
      if (players.size >= 4) refuse('quota'); const issued = scope('playback', input, check(op)), grant = approve(op, issued);
      const selected = await transact(op, state => { const clip = state.clips.find(candidate => candidate.id === issued.clipId);
        if (!clip) refuse('not-found'); return { epoch: state.epoch, expiresAt: clip.expiresAt }; });
      check(op); const item = Object.assign(makeLife({ ...grant, expiresAt: Math.min(grant.expiresAt, selected.expiresAt) }),
        { clipId: issued.clipId!, epoch: selected.epoch, index: 0, seekEpoch: 0 }) as Player;
      lifeCurrent(item, op); const handle = Object.freeze({}) as MediaRecordingPlaybackHandle;
      players.add(item); playerMap.set(handle, item); arm(lastNow); lifeCurrent(item, op); return handle;
    }); },
    playbackLifetime(handle) { try { const player = lookup(playerMap, handle); lifeCurrent(player);
      return success(Object.freeze({ signal: player.controller.signal, expiresAt: player.expiresAt }));
    } catch (error) { return failure(error instanceof Refusal ? error.reason : 'invalid-handle'); } },
    seek(handle, index) { try { const player = lookup(playerMap, handle); number(index, 0, 31, true);
      lifeCurrent(player); player.seekEpoch++; player.index = index; return success(undefined);
    } catch (error) { return failure(error instanceof Refusal ? error.reason : 'invalid-request'); } },
    pull(handle) { return run(async op => {
      const player = lookup(playerMap, handle); attachLife(op, player);
      const seekEpoch = player.seekEpoch, index = player.index;
      const frame = await transact(op, state => {
        lifeCurrent(player, op); if (state.epoch !== player.epoch) refuse('epoch-changed');
        const clip = state.clips.find(c => c.id === player.clipId); if (!clip) refuse('not-found');
        const frame = clip.frames[index]; if (!frame) refuse('end'); return frame;
      });
      await verify(op, [frame]); await checkEpoch(op, player.epoch);
      const at = lifeCurrent(player, op); if (seekEpoch !== player.seekEpoch) refuse('seek-changed');
      player.index++;
      return Object.freeze({ frame: exposed(frame), playback: Object.freeze({ clockId: 'recording-host-emission' as const, at, index, seekEpoch }) });
    }); },
    listReviewed(input) { return run(async op => { const issued = scope('list', input, check(op)); approve(op, issued);
      const result = await transact(op, state => Object.freeze(state.clips.map(info))); check(op); return result;
    }); },
    exportPage(input) { return run(async op => {
      const issued = scope('export', input, check(op)), grant = approve(op, issued);
      const v = record(input, ['clipId', 'destinationId', 'purpose', 'expiresAt', 'afterIndex', 'limit']);
      const index = number(v.afterIndex, 0, 32, true), limit = number(v.limit, 1, 4, true);
      const selected = await transact(op, state => { const clip = state.clips.find(c => c.id === issued.clipId); if (!clip) refuse('not-found');
        return { epoch: state.epoch, frames: clip.frames.slice(index, index + limit), nextIndex: index + limit < clip.frames.length ? index + limit : undefined };
      });
      await verify(op, selected.frames); await checkEpoch(op, selected.epoch);
      if (check(op) >= grant.expiresAt) refuse('expired');
      return Object.freeze({ frames: Object.freeze(selected.frames.map(exposed)),
        ...(selected.nextIndex === undefined ? {} : { nextIndex: selected.nextIndex }) });
    }); },
    deleteReviewed(input) { return run(async op => {
      const issued = scope('delete', input, check(op)); approve(op, issued);
      // Denied review preserves incumbent handles. An approved deletion retires local authority before durable work.
      retireAll();
      const removed = await transact(op, state => { const before = state.clips.length;
        state.clips = issued.clipId === undefined ? [] : state.clips.filter(clip => clip.id !== issued.clipId);
        if (state.epoch >= Number.MAX_SAFE_INTEGER - 1) refuse('quota'); state.epoch++; return before - state.clips.length;
      }); arm(lastNow); return Object.freeze({ removed });
    }); },
    sweep() { sweepAuthority(); return run(async op => { const removed = await transact(op, (_state, _at, pruned) => pruned);
      return Object.freeze({ removed }); }); },
    revoke(handle) { if (handle && typeof handle === 'object') {
      const life = captureMap.get(handle) ?? playerMap.get(handle); if (life) retire(life); arm(lastNow);
    } },
    status() { return Object.freeze({ closed, clockFault, captures: captures.size, players: players.size,
      pendingFrames: pending.length + flushing.length, pendingBytes: (pending.length + flushing.length) * 256, rawPending, attempts,
      timers: expiryTimer === undefined ? 0 : 1, listeners,
      admitted, dropped }); },
    close() {
      if (closePromise) return closePromise; closed = true; retireController();
      closePromise = (async () => { while (tasks.size) await Promise.allSettled([...tasks]); })(); return closePromise;
    },
  };
  return Object.freeze(controller);
}
