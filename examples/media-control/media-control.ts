import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chunkResource, createAssetReference, createDeviceRuntime, intersectMediaRouteGrants, readVerifiedResource, snapshotResourceBytes } from '@101/connect';
import type { AssetReference, AuthorizationRequest, Authorize, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation, ResourceReadGrant, ResourceReadRequest, RouteGrant } from '@101/connect';

export const MEDIA_CONTROL_LIMITS = Object.freeze({ workers: 2, recipients: 2, frameBytes: 65536, chunkBytes: 4096,
  callerBufferBytes: 524288, frameAttempts: 64, controlAttempts: 64, lifetimeMs: 10000, latestPerRoute: 1,
  mediaPending: 2, controlPending: 1, workerOldHeapMiB: 16, startupMs: 2500, closeMs: 1000 });
export interface MediaApprovalRequest {
  readonly role: 'source' | 'recipient'; readonly operation: 'private-raster'; readonly recipient: 0 | 1;
  readonly applicationId: 'media-control-example'; readonly sessionId: 'owned-worker-session';
  readonly epoch: number; readonly width: 64 | 128; readonly height: 64 | 128;
  readonly format: 'rgba8'; readonly maxBytes: 16384 | 65536;
}
export interface MediaApproval { readonly request: MediaApprovalRequest; readonly signal: AbortSignal; readonly grant: RouteGrant }
export interface MediaControlOptions {
  readonly signal: AbortSignal; readonly authorize: Authorize;
  readonly approveMedia: (request: MediaApprovalRequest) => MediaApproval | undefined;
  readonly authorizeResource: (request: Readonly<ResourceReadRequest>) => ResourceReadGrant | undefined;
}
export interface AuthoredMediaFrame {
  readonly reference: Readonly<AssetReference>; readonly bytes: Uint8Array; readonly epoch: number;
  readonly sequence: number; readonly width: 64 | 128; readonly createdAt: number;
}
export interface MediaControlReceipt {
  profile: string; status: 'pass' | 'failed' | 'cancelled' | 'denied' | 'busy' | 'invalid'; reason: string;
  topology: 'split' | 'shared-negative'; controlDuringHeldMedia: boolean; latestReplacementObserved: boolean;
  slowFastIsolationObserved: boolean;
  adaptedFrameObserved: boolean; oldEpochAckActivated: boolean; deniedMediaDispatched: number;
  corruptRejected: boolean; overbyteRejected: boolean; rawRetainedAfterRevoke: boolean; expiryReleasedControl: boolean;
  frameAttempts: number; controlAttempts: number; peakCallerBytes: number; helperSha256: string;
  targets: readonly TargetMetrics[]; ownedCleanup: { workersStarted: number; workersExited: number; rawOperations: number; rawBytes: number; timers: number; listeners: number };
  scope: string;
}
interface TargetMetrics {
  recipient: number; mediaDispatched: number; mediaObserved: number; mediaCancelled: number; held: number; staleAck: number; controlApplied: number;
  controlReleased: number; lastSequence: number; lastWidth: number; lastSha256: string; contactHeld: boolean;
  nativeClock: { id: string; first: number; last: number; count: number }; uncertainOnExit: number;
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function aborted(value: unknown): boolean { try { return abortedGetter.call(value) !== false; } catch { return true; } }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) throw Error('closed-fields');
  const result: Record<string, unknown> = {};
  for (const key of keys) { const property = Object.getOwnPropertyDescriptor(value, key); if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw Error('closed-fields'); result[key] = property.value; }
  return result;
}
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
function inputBytes(input: unknown, size: number): Uint8Array {
  if (!(input instanceof Uint8Array) || byteLengthGetter.call(input) !== size) throw Error('selected-frame-size');
  return snapshotResourceBytes(input);
}
/** Authored software raster, not device/camera capture. Construction has no native effects. */
export function createAuthoredRgbaFrame(width: 64 | 128, seed: number): Uint8Array {
  if (![64, 128].includes(width) || !integer(seed, 1, 64)) throw Error('selected-frame');
  const bytes = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 4; bytes[at] = (x + seed) % 256; bytes[at + 1] = (y + seed * 3) % 256; bytes[at + 2] = seed; bytes[at + 3] = 255; }
  return bytes;
}
export function downscaleAuthoredRgbaFrame(input: Uint8Array): Uint8Array {
  const source = inputBytes(input, 65536), output = new Uint8Array(16384);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const from = ((y * 2) * 128 + x * 2) * 4, to = (y * 64 + x) * 4; for (let component = 0; component < 4; component++) output[to + component] = source[from + component]!; }
  return output;
}
export async function prepareAuthoredMediaFrame(input: Uint8Array, width: 64 | 128, epoch: number, sequence: number): Promise<AuthoredMediaFrame> {
  if (![64, 128].includes(width) || !integer(epoch, 1, 4) || !integer(sequence, 1, 64)) throw Error('selected-frame');
  const bytes = inputBytes(input, width * width * 4), createdAt = performance.now();
  const reference = await createAssetReference('frame:owned-' + sequence, 'blob', bytes);
  return Object.freeze({ reference, bytes, epoch, sequence, width, createdAt });
}

interface RawOperation {
  kind: 'media' | 'contact' | 'release' | 'hold' | 'epoch'; id: number; bytes: number; context?: DeliveryContext;
  epoch?: number; sequence?: number; width?: number; sha256?: string; held: boolean; issued: boolean;
  finish: () => void; detach: () => void;
}
class PrivateTarget {
  readonly metric: TargetMetrics; readonly ready: Promise<void>; readonly exited: Promise<void>;
  readonly recipient: 0 | 1;
  private readonly current: () => boolean; private readonly epochCurrent: (epoch: number) => boolean; private readonly fail: () => void;
  private readyYes!: () => void; private readyNo!: (error: Error) => void; private exitYes!: () => void;
  private worker?: Worker; private readonly capability = randomBytes(16).toString('hex'); private readonly pending = new Map<number, RawOperation>();
  private sequence = 0; private messages = 0; private outputBytes = 0; private closing = false; private didExit = false;
  private startup?: ReturnType<typeof setTimeout>; private closeTimer?: ReturnType<typeof setTimeout>;
  constructor(recipient: 0 | 1, helperSha256: string, current: () => boolean, epochCurrent: (epoch: number) => boolean, fail: () => void) {
    this.recipient = recipient; this.current = current; this.epochCurrent = epochCurrent; this.fail = fail;
    this.metric = { recipient, mediaDispatched: 0, mediaObserved: 0, mediaCancelled: 0, held: 0, staleAck: 0, controlApplied: 0, controlReleased: 0,
      lastSequence: 0, lastWidth: 0, lastSha256: '', contactHeld: false, nativeClock: { id: 'owned-media-control-worker-' + recipient, first: 0, last: 0, count: 0 }, uncertainOnExit: 0 };
    this.ready = new Promise((resolve, reject) => { this.readyYes = resolve; this.readyNo = reject; }); void this.ready.catch(() => {});
    this.exited = new Promise(resolve => { this.exitYes = resolve; });
    try {
      this.worker = new Worker(new URL('./application-target.mjs', import.meta.url), { workerData: { version: 1, recipient, capability: this.capability, sourceSha256: helperSha256 },
        execArgv: [], argv: [], env: { NODE_ENV: 'production' }, stdin: false, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1, codeRangeSizeMb: 4 } });
      this.worker.on('message', this.message); this.worker.on('error', this.error); this.worker.on('exit', this.exit);
      this.worker.stdout?.on('data', this.output); this.worker.stderr?.on('data', this.output);
      this.startup = setTimeout(() => { this.readyNo(Error('startup')); this.fail(); }, 2500);
    } catch { this.didExit = true; this.readyNo(Error('startup')); this.exitYes(); this.fail(); }
  }
  private output = (bytes: Uint8Array) => { this.outputBytes += bytes.byteLength; if (this.outputBytes > 4096) this.fail(); };
  private error = () => { this.readyNo(Error('worker')); this.fail(); };
  private finish(id: number) { const operation = this.pending.get(id); if (!operation) return; this.pending.delete(id); operation.detach(); operation.finish(); }
  private exit = () => {
    this.didExit = true; if (this.startup) clearTimeout(this.startup); if (this.closeTimer) clearTimeout(this.closeTimer);
    this.startup = undefined; this.closeTimer = undefined; this.readyNo(Error('worker-ended'));
    for (const [id, operation] of this.pending) { if (operation.issued) this.metric.uncertainOnExit++; this.finish(id); }
    if (!this.closing) this.fail(); this.exitYes();
  };
  private shape(input: unknown, keys: readonly string[]) {
    const value = exact(input, [...keys, 'capability', 'clockId', 'emittedAt']);
    if (value.capability !== this.capability || value.clockId !== this.metric.nativeClock.id || typeof value.emittedAt !== 'number' || !Number.isFinite(value.emittedAt) || value.emittedAt < this.metric.nativeClock.last) throw Error('identity-clock');
    const clock = this.metric.nativeClock; if (!clock.count) clock.first = value.emittedAt; clock.last = value.emittedAt; clock.count++; return value;
  }
  private message = (input: unknown) => {
    try {
      if (++this.messages > 256 || !input || typeof input !== 'object') throw Error('traffic');
      const kind = Object.getOwnPropertyDescriptor(input, 'kind')?.value;
      if (kind === 'ready') { const value = this.shape(input, ['kind', 'profile', 'recipient']); if (value.profile !== 'owned-private-raster-contact/1' || value.recipient !== this.recipient) throw Error('identity'); if (this.startup) clearTimeout(this.startup); this.startup = undefined; this.readyYes(); return; }
      if (kind === 'closed') { const value = this.shape(input, ['kind', 'rawBytes', 'contactHeld', 'nativeTimers', 'nativeListeners']); if (value.rawBytes !== 0 || value.contactHeld !== false || value.nativeTimers !== 0 || value.nativeListeners !== 0) throw Error('cleanup'); this.metric.contactHeld = false; return; }
      const id = Object.getOwnPropertyDescriptor(input, 'id')?.value; if (!integer(id, 1, 256)) throw Error('operation'); const operation = this.pending.get(id); if (!operation) throw Error('unknown-operation');
      if (kind === 'held') { const value = this.shape(input, ['kind', 'id', 'byteLength']); if (operation.kind !== 'media' || value.byteLength !== operation.bytes) throw Error('held'); operation.held = true; this.metric.held++; return; }
      if (kind === 'media') {
        const value = this.shape(input, ['kind', 'id', 'epoch', 'sequence', 'width', 'byteLength', 'sha256', 'firstPixel']);
        if (operation.kind !== 'media' || value.epoch !== operation.epoch || value.sequence !== operation.sequence || value.width !== operation.width || value.byteLength !== operation.bytes || value.sha256 !== operation.sha256 || !Array.isArray(value.firstPixel) || value.firstPixel.length !== 4 || !value.firstPixel.every(item => integer(item, 0, 255))) throw Error('raster-effect');
        if (this.current() && operation.context?.isCurrent() && !aborted(operation.context.signal) && this.epochCurrent(operation.epoch!)) {
          this.metric.mediaObserved++; this.metric.lastSequence = operation.sequence!; this.metric.lastWidth = operation.width!; this.metric.lastSha256 = operation.sha256!; operation.context.reportEvidence('observed');
        } else this.metric.staleAck++;
      } else if (kind === 'contact') {
        const value = this.shape(input, ['kind', 'id', 'sequence', 'held', 'released']);
        if (typeof value.held !== 'boolean' || typeof value.released !== 'boolean' || operation.kind !== 'contact' && operation.kind !== 'release') throw Error('contact');
        if (operation.kind === 'release') { if (value.sequence !== 0 || value.held !== false || value.released !== true) throw Error('release'); this.metric.controlReleased++; this.metric.contactHeld = false; }
        else if (value.sequence !== operation.sequence || value.released !== false) throw Error('contact');
        else if (this.current() && operation.context?.isCurrent() && !aborted(operation.context.signal)) { this.metric.controlApplied++; this.metric.contactHeld = value.held; operation.context.reportEvidence('observed'); }
      } else if (kind === 'cancelled') { this.shape(input, ['kind', 'id']); if (operation.kind !== 'media') throw Error('cancel'); this.metric.mediaCancelled++; }
      else if (kind === 'mode') { this.shape(input, ['kind', 'id', 'hold', 'pending']); if (operation.kind !== 'hold') throw Error('mode'); }
      else if (kind === 'epoch') { this.shape(input, ['kind', 'id', 'epoch']); if (operation.kind !== 'epoch') throw Error('epoch'); }
      else if (kind === 'rejected') { this.shape(input, ['kind', 'id']); this.fail(); }
      else throw Error('grammar');
      this.finish(id);
    } catch { this.fail(); }
  };
  private call(kind: RawOperation['kind'], fields: Record<string, unknown>, context?: DeliveryContext, bytes = 0, transfers: ArrayBuffer[] = []): Promise<void> {
    if (this.didExit || this.closing || this.sequence >= 256 || kind === 'media' && [...this.pending.values()].some(item => item.kind === 'media')) return Promise.reject(Error('raw-capacity'));
    const id = ++this.sequence; let finish!: () => void; const work = new Promise<void>(resolve => { finish = resolve; });
    const operation: RawOperation = { kind, id, bytes, context, epoch: fields.epoch as number | undefined, sequence: fields.sequence as number | undefined,
      width: fields.width as number | undefined, sha256: (fields.reference as AssetReference | undefined)?.sha256, issued: false, held: false, finish, detach: () => {} };
    this.pending.set(id, operation);
    try {
      if (context) {
        const cancel = () => { if (operation.issued && !this.didExit) this.worker?.postMessage({ kind: 'cancel', capability: this.capability, id }); };
        EventTarget.prototype.addEventListener.call(context.signal, 'abort', cancel, { once: true }); operation.detach = () => EventTarget.prototype.removeEventListener.call(context.signal, 'abort', cancel);
        if (!this.current() || !context.isCurrent() || aborted(context.signal)) { this.finish(id); return work; }
      }
      operation.issued = true; if (kind === 'media') this.metric.mediaDispatched++;
      this.worker!.postMessage({ kind: kind === 'epoch' ? 'retire-epoch' : kind, capability: this.capability, id, ...fields }, transfers);
    } catch { this.fail(); /* An issued reservation survives until actual exit. */ }
    return work;
  }
  async media(frame: AuthoredMediaFrame, bytes: Uint8Array, context: DeliveryContext): Promise<{ settlement: Promise<void> }> {
    const chunks = []; for await (const chunk of chunkResource(bytes, 4096)) chunks.push(chunk);
    return { settlement: this.call('media', { epoch: frame.epoch, sequence: frame.sequence, width: frame.width, height: frame.width, reference: frame.reference, chunks }, context, bytes.byteLength, chunks.map(item => item.bytes.buffer as ArrayBuffer)) };
  }
  contact(sequence: number, phase: 'down' | 'up' | 'cancel', context: DeliveryContext): Promise<void> { return this.call('contact', { sequence, phase }, context); }
  release(): Promise<void> { return this.call('release', {}); }
  hold(hold: boolean): Promise<void> { return this.call('hold', { hold }); }
  retireEpoch(epoch: number): Promise<void> { return this.call('epoch', { epoch }); }
  async close(): Promise<void> {
    if (!this.closing) { this.closing = true; if (!this.didExit) { try { this.worker?.postMessage({ kind: 'close', capability: this.capability }); } catch { /* Actual exit remains the settlement fence. */ } this.closeTimer = setTimeout(() => { void this.worker?.terminate(); }, 1000); } }
    await this.exited; this.worker?.removeListener('message', this.message); this.worker?.removeListener('error', this.error); this.worker?.removeListener('exit', this.exit);
    this.worker?.stdout?.removeListener('data', this.output); this.worker?.stderr?.removeListener('data', this.output);
  }
  get rawOperations() { return this.pending.size; }
  get rawBytes() { return [...this.pending.values()].reduce((sum, item) => sum + item.bytes, 0); }
  get heldMedia() { return [...this.pending.values()].filter(item => item.kind === 'media' && item.held).length; }
  get timers() { return Number(!!this.startup) + Number(!!this.closeTimer); }
  get listeners() { return (this.worker?.listenerCount('message') ?? 0) + (this.worker?.listenerCount('error') ?? 0) + (this.worker?.listenerCount('exit') ?? 0) + this.pending.size + (this.worker?.stdout?.listeners('data').filter(item => item === this.output).length ?? 0) + (this.worker?.stderr?.listeners('data').filter(item => item === this.output).length ?? 0); }
  get hasExited() { return this.didExit; }
  get hasStarted() { return !!this.worker; }
}

function mediaDescriptor(id: string, sink = false) { return { schemaVersion: 1, id, label: 'Private authored raster', revision: 1, adapter: { id: 'example:media-control', version: '1.0.0' }, runtime: { platform: 'node-private-worker' }, capabilities: [{ id: 'frame', semantic: 'example:private-rgba-reference/1', schemaVersion: 1, kind: 'sample', value: { type: 'record', fields: { epoch: { type: 'scalar', unit: '1', min: 1, max: 4 }, sequence: { type: 'scalar', unit: '1', min: 1, max: 64 } } }, delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 1000 }, permissions: sink ? ['write'] : ['subscribe'], ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] }; }
function contactDescriptor(id: string, sink = false) { return { schemaVersion: 1, id, label: 'Owned application contact', revision: 1, adapter: { id: 'example:media-control', version: '1.0.0' }, runtime: { platform: 'node-private-worker' }, capabilities: [{ id: 'contact', semantic: 'input:contact', schemaVersion: 2, kind: 'event', value: { type: 'contact', frame: 'surface-normalized' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: sink ? ['write'] : ['subscribe'], ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] }; }
let running = false;
/** A runnable selected composition, not a scheduler factory. Media work and
 * contact work use separate public runtimes. The private native target stores
 * authored raster bytes and contact state; no physical/media-transport claim. */
export async function runMediaControlQualification(options: MediaControlOptions): Promise<MediaControlReceipt> { return run(options, false); }
/** Intentional bad composition used only to demonstrate the missing-example
 * regression. A shared global pending cap is behaving according to its contract. */
export async function runSharedMediaControlNegative(options: MediaControlOptions): Promise<MediaControlReceipt> { return run(options, true); }

async function run(input: MediaControlOptions, shared: boolean): Promise<MediaControlReceipt> {
  const receipt: MediaControlReceipt = { profile: 'private-worker-media-control/1', status: 'invalid', reason: 'invalid', topology: shared ? 'shared-negative' : 'split',
    controlDuringHeldMedia: false, latestReplacementObserved: false, slowFastIsolationObserved: false, adaptedFrameObserved: false, oldEpochAckActivated: false, deniedMediaDispatched: 0,
    corruptRejected: false, overbyteRejected: false, rawRetainedAfterRevoke: false, expiryReleasedControl: false, frameAttempts: 0, controlAttempts: 0, peakCallerBytes: 0, helperSha256: '', targets: [],
    ownedCleanup: { workersStarted: 0, workersExited: 0, rawOperations: 0, rawBytes: 0, timers: 0, listeners: 0 },
    scope: 'Owned software RGBA resources and native private Worker raster/contact state. No browser, physical capture/output, WSS/RTC, codecs, hostile-host sandbox, RSS or cross-host clock claim. Issued cancelled work remains uncertain until native ACK/exit.' };
  if (running) return { ...receipt, status: 'busy', reason: 'busy' }; running = true;
  const owned = new AbortController(), targets: PrivateTarget[] = [], runtimes = new Set<DeviceRuntime>(), routes: Connection[] = [], detachers: (() => void)[] = [], frames = new Map<number, AuthoredMediaFrame>();
  let owner: AbortSignal | undefined, media: DeviceRuntime | undefined, control: DeviceRuntime | undefined, mediaSource: EndpointHandle | undefined, contactSource: EndpointHandle | undefined;
  let options: MediaControlOptions, epoch = 1, width: 64 | 128 = 128, frameSequence = 0, contactSequence = 0, failed = false, phase = 'setup';
  let lifetime: ReturnType<typeof setTimeout> | undefined, waitTimer: ReturnType<typeof setTimeout> | undefined, verificationTail = Promise.resolve(), verificationBytes = 0, publicationBytes = 0;
  const providerTasks = new Set<Promise<void>>(), mediaRoutes: Connection[] = []; let controlRoute: Connection | undefined;
  const allowed = new Map<string, { source: EndpointHandle; sourceId: string; sinkId: string; capability: string; principal: string; schema: number; constraints?: RouteGrant }>();
  const current = () => !failed && !aborted(owned.signal) && !!owner && !aborted(owner);
  function cancel() { owned.abort(); for (const runtime of runtimes) runtime.close(); }
  function fail() { failed = true; cancel(); }
  function callerBytes() { const bytes = [...frames.values()].reduce((sum, frame) => sum + frame.bytes.byteLength, 0) + targets.reduce((sum, target) => sum + target.rawBytes, 0) + verificationBytes + publicationBytes; receipt.peakCallerBytes = Math.max(receipt.peakCallerBytes, bytes); if (bytes > 524288) throw Error('caller-byte-capacity'); }
  async function wait(ms: number) { if (!current()) throw Error('cancelled'); await new Promise<void>(resolve => { waitTimer = setTimeout(() => { waitTimer = undefined; resolve(); }, ms); }); if (!current()) throw Error('cancelled'); }
  async function until(check: () => boolean, name: string) { const deadline = performance.now() + 1000; while (!check()) { if (performance.now() >= deadline) throw Error(name); media?.flush(); control?.flush(); await wait(10); } }
  function authorize(request: Readonly<AuthorizationRequest>) {
    // Registration ids are local to each runtime. Bind the exact device as well
    // so the independent control and media runtimes cannot overwrite a scope.
    const expected = allowed.get(request.sink.deviceId + '@' + request.sink.registrationId);
    if (!current() || !expected || request.source.registrationId !== expected.source.id || request.source.deviceId !== expected.sourceId || request.sink.deviceId !== expected.sinkId || request.source.capabilityId !== expected.capability || request.sink.capabilityId !== expected.capability || request.source.schemaVersion !== expected.schema || request.sink.schemaVersion !== expected.schema || request.source.descriptorRevision !== 1 || request.sink.descriptorRevision !== 1 || request.partition !== undefined || request.principalId !== expected.principal || request.applicationId !== 'media-control-example' || request.sessionId !== 'owned-worker-session' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    const granted = options.authorize(request); if (!current()) return;
    return intersectMediaRouteGrants(granted, expected.constraints ?? { expiresAt: performance.now() + 9000, maxAgeMs: 1000, maxHz: 30 }, performance.now());
  }
  function approval(recipient: 0 | 1, role: MediaApprovalRequest['role']) {
    const request: MediaApprovalRequest = Object.freeze({ role, operation: 'private-raster', recipient, applicationId: 'media-control-example', sessionId: 'owned-worker-session', epoch, width, height: width, format: 'rgba8', maxBytes: width === 128 ? 65536 : 16384 });
    const candidate = options.approveMedia(request); if (candidate === undefined) throw Error('media-denied');
    const value = exact(candidate, ['request', 'signal', 'grant']);
    if (value.request !== request || aborted(value.signal) || !current()) throw Error('media-denied');
    const grant = intersectMediaRouteGrants(value.grant, value.grant, performance.now()); if (!grant || !current()) throw Error('media-denied');
    return { request, signal: value.signal as AbortSignal, grant };
  }
  function tracked(work: () => Promise<void>): Promise<void> {
    let settle!: () => void; const reservation = new Promise<void>(resolve => { settle = resolve; }); providerTasks.add(reservation);
    void reservation.finally(() => providerTasks.delete(reservation)); void work().then(settle, () => { fail(); settle(); }); return reservation;
  }
  async function sendFrame(recipient: 0 | 1, observation: Observation, context: DeliveryContext, grants: readonly AbortSignal[]) {
    const posted = await dispatchFrame(recipient, observation, context, grants);
    if (posted) await posted.settlement;
  }
  async function dispatchFrame(recipient: 0 | 1, observation: Observation, context: DeliveryContext, grants: readonly AbortSignal[]) {
    const value = exact(observation.value, ['epoch', 'sequence']); if (!integer(value.sequence, 1, 64) || value.epoch !== epoch) return;
    const frame = frames.get(value.sequence); if (!frame || frame.epoch !== epoch || frame.width !== width || !context.isCurrent() || !current() || grants.some(aborted)) return;
    let unlock!: () => void; const prior = verificationTail; verificationTail = new Promise<void>(resolve => { unlock = resolve; }); await prior;
    let dispatched: { settlement: Promise<void> } | undefined;
    try {
      if (!current() || !context.isCurrent() || grants.some(aborted)) return;
      // One bounded verification at a time. Reserve the helper's bounded copies
      // in addition to retained/staged caller raster and raw native bytes.
      verificationBytes = 262144; callerBytes();
      const verified = await readVerifiedResource({ reference: frame.reference, chunks: chunkResource(frame.bytes, 4096),
        principalId: 'media-recipient-' + recipient, applicationId: 'media-control-example', sessionId: 'owned-worker-session',
        signal: AbortSignal.any([owned.signal, owner!, context.signal, ...grants]), now: () => performance.now(),
        authorize(request) { if (!current() || !context.isCurrent() || grants.some(aborted) || request.reference.sha256 !== frame.reference.sha256 || request.reference.id !== frame.reference.id || request.reference.byteLength !== frame.reference.byteLength) return;
          const result = options.authorizeResource(request); return current() && context.isCurrent() && !grants.some(aborted) ? result : undefined; } });
      if (!current() || !context.isCurrent() || frame.epoch !== epoch || grants.some(aborted)) return;
      if (++receipt.frameAttempts > 64) throw Error('frame-attempts');
      // Keep the verification/staging reservation through actual native post.
      // ACK may remain held while the next recipient verifies its own grant.
      dispatched = await targets[recipient]!.media(frame, verified, context); callerBytes();
    } finally { verificationBytes = 0; unlock(); }
    // This scope returns before awaiting the ACK. Only metadata and the raw
    // settlement promise remain owned by the held operation, not verified bytes.
    return dispatched;
  }
  async function installMedia() {
    mediaRoutes.splice(0).forEach(route => route.stop('format-retired'));
    for (const recipient of [0, 1] as const) {
      const source = approval(recipient, 'source'), output = approval(recipient, 'recipient');
      const grant = intersectMediaRouteGrants(source.grant, output.grant, performance.now()); if (!grant || !current()) throw Error('media-denied');
      const signals = [source.signal, output.signal], sinkId = 'app:media-recipient-' + recipient + '-epoch-' + epoch;
      const sink = media!.registerSink({ device: mediaDescriptor(sinkId, true), capability: 'frame', apply: (observation, context) => tracked(() => sendFrame(recipient, observation, context, signals)), release() {} });
      media!.setReadiness(sink, 'available'); allowed.set(sinkId + '@' + sink.id, { source: mediaSource!, sourceId: 'app:media-source', sinkId, capability: 'frame', principal: 'media-recipient-' + recipient, schema: 1, constraints: grant });
      const route = media!.route({ from: mediaSource!, to: sink, principalId: 'media-recipient-' + recipient, applicationId: 'media-control-example', sessionId: 'owned-worker-session', sourceOperation: 'subscribe', queueCapacity: 1, leaseMs: 10000, constraints: grant }); routes.push(route); mediaRoutes.push(route);
      for (const signal of signals) { const revoke = () => route.stop('owner-revoked'); EventTarget.prototype.addEventListener.call(signal, 'abort', revoke, { once: true }); detachers.push(() => EventTarget.prototype.removeEventListener.call(signal, 'abort', revoke)); }
      if (!current() || signals.some(aborted) || !route.start().ok) { route.stop('denied'); throw Error('media-denied'); }
      if (!current() || signals.some(aborted)) { route.stop('denied'); throw Error('media-denied'); }
    }
  }
  async function publishFrame(bytes?: Uint8Array) {
    if (++frameSequence > 64 || !current()) throw Error('frame-attempts');
    let frame: AuthoredMediaFrame;
    try {
      publicationBytes = 262144; callerBytes();
      frame = await prepareAuthoredMediaFrame(bytes ?? createAuthoredRgbaFrame(width, frameSequence), width, epoch, frameSequence);
    } finally { publicationBytes = 0; }
    if (!current()) throw Error('cancelled'); frames.set(frameSequence, frame); while (frames.size > 2) frames.delete(frames.keys().next().value!); callerBytes();
    const result = media!.publish(mediaSource!, { epoch, sequence: frameSequence }, { sequence: frameSequence, timestamp: frame.createdAt, clockDomain: 'owned-node-host', quality: 'valid', provenance: { source: 'authored-software-rgba', widthPx: width, heightPx: width, formatEpoch: epoch, physicalCapture: false } });
    if (!result.ok) throw Error('frame-publish'); media!.flush(); return frame;
  }
  async function contact(phase: 'down' | 'up' | 'cancel') {
    if (++contactSequence > 62 || ++receipt.controlAttempts > 62) throw Error('control-attempts');
    const timestamp = performance.now();
    const result = control!.publish(contactSource!, { id: 'contact:owned', phase, position: { x: 0.5, y: 0.5 }, primary: true },
      { sequence: contactSequence, timestamp, clockDomain: 'owned-node-host', operationId: String(contactSequence), deadline: timestamp + 1000 });
    if (!result.ok) throw Error('contact-publish'); control!.flush();
  }
  try {
    const value = exact(input, ['signal', 'authorize', 'approveMedia', 'authorizeResource']); if (aborted(value.signal) || !['authorize', 'approveMedia', 'authorizeResource'].every(key => typeof value[key] === 'function')) return receipt;
    options = Object.freeze({ ...value }) as unknown as MediaControlOptions; owner = options.signal;
    const stop = () => cancel(); EventTarget.prototype.addEventListener.call(owner, 'abort', stop, { once: true }); detachers.push(() => EventTarget.prototype.removeEventListener.call(owner!, 'abort', stop)); if (!current()) throw Error('cancelled');
    lifetime = setTimeout(fail, 10000);
    const helper = readFileSync(new URL('./application-target.mjs', import.meta.url)); if (helper.byteLength > 16384) throw Error('helper-size'); receipt.helperSha256 = createHash('sha256').update(helper).digest('hex');
    for (const recipient of [0, 1] as const) { if (!current()) throw Error('cancelled'); const target = new PrivateTarget(recipient, receipt.helperSha256, current, value => value === epoch, fail); targets.push(target); if (target.hasStarted) receipt.ownedCleanup.workersStarted++; }
    await Promise.all(targets.map(target => target.ready)); if (!current()) throw Error('cancelled');
    // Both runtimes use this actual parent's performance clock. Worker emission
    // remains separately identified; no inter-worker/host mapping is inferred.
    media = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'owned-node-host', authorize, maxRegistrations: 12, maxRoutes: 8, maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 1 }); runtimes.add(media);
    control = shared ? media : createDeviceRuntime({ now: () => performance.now(), clockDomain: 'owned-node-host', authorize, maxRegistrations: 2, maxRoutes: 1, maxPendingDeliveries: 1 }); runtimes.add(control);
    mediaSource = media.registerSource({ device: mediaDescriptor('app:media-source'), capability: 'frame' }); media.setReadiness(mediaSource, 'available');
    contactSource = control.registerSource({ device: contactDescriptor('app:contact-source'), capability: 'contact' }); control.setReadiness(contactSource, 'available');
    const contactSink = control.registerSink({ device: contactDescriptor('app:contact-target', true), capability: 'contact',
      apply(observation, context) { const contact = exact(observation.value, ['id', 'phase', 'position', 'primary']); if (contact.id !== 'contact:owned' || !['down', 'up', 'cancel'].includes(contact.phase as string) || !context.isCurrent() || !current()) return;
        return tracked(() => targets[0]!.contact(observation.sequence, contact.phase as 'down' | 'up' | 'cancel', context)); },
      release() { if (targets[0] && !targets[0].hasExited) { receipt.controlAttempts++; void targets[0].release().catch(fail); } } });
    control.setReadiness(contactSink, 'available'); allowed.set('app:contact-target@' + contactSink.id, { source: contactSource, sourceId: 'app:contact-source', sinkId: 'app:contact-target', capability: 'contact', principal: 'control-owner', schema: 2 });
    controlRoute = control.route({ from: contactSource, to: contactSink, principalId: 'control-owner', applicationId: 'media-control-example', sessionId: 'owned-worker-session', sourceOperation: 'subscribe', queueCapacity: 1, leaseMs: 10000 }); routes.push(controlRoute); if (!controlRoute.start().ok) throw Error('control-denied');
    await installMedia();
    phase = 'held-media'; await Promise.all(targets.map(target => target.hold(true))); await publishFrame(); await until(() => targets.every(target => target.heldMedia === 1), 'held-media');
    phase = 'control-held'; const beforeControl = targets[0]!.metric.controlApplied; await contact('down'); await wait(80); control.flush(); await wait(30);
    receipt.controlDuringHeldMedia = targets[0]!.metric.controlApplied > beforeControl && targets[0]!.metric.contactHeld;
    if (shared) { receipt.status = receipt.controlDuringHeldMedia ? 'failed' : 'pass'; receipt.reason = 'intentional-shared-pending-cap-negative'; return receipt; }
    if (!receipt.controlDuringHeldMedia) throw Error('control-starved'); await contact('up'); await until(() => !targets[0]!.metric.contactHeld, 'contact-up');
    phase = 'latest'; await publishFrame(); const latestSequence = (await publishFrame()).sequence; if (mediaRoutes.some(route => route.status().pending > 1)) throw Error('latest-capacity');
    await Promise.all(targets.map(target => target.hold(false))); await until(() => targets.every(target => target.metric.lastSequence === latestSequence), 'latest-replacement'); receipt.latestReplacementObserved = true;
    phase = 'slow-fast'; await targets[0]!.hold(true); await wait(40); const fastSequence = (await publishFrame()).sequence;
    await until(() => targets[0]!.heldMedia === 1 && targets[1]!.metric.lastSequence === fastSequence, 'slow-fast-isolation');
    const slowControl = targets[0]!.metric.controlApplied; await contact('down'); await until(() => targets[0]!.metric.controlApplied > slowControl && targets[0]!.metric.contactHeld, 'slow-contact');
    await contact('up'); await until(() => !targets[0]!.metric.contactHeld, 'slow-contact-up'); receipt.slowFastIsolationObserved = true;
    await targets[0]!.hold(false); await until(() => targets[0]!.metric.lastSequence === fastSequence, 'slow-settlement');
    phase = 'format'; await Promise.all(targets.map(target => target.hold(true))); await wait(40); const full = await publishFrame(); await until(() => targets.every(target => target.heldMedia === 1), 'format-held');
    mediaRoutes.forEach(route => route.stop('format-retired')); const raw = targets.reduce((sum, target) => sum + target.rawOperations, 0); await wait(20);
    receipt.rawRetainedAfterRevoke = raw >= 2 && targets.every(target => target.rawBytes === 65536); if (!receipt.rawRetainedAfterRevoke) throw Error('raw-released-early');
    const observedBeforeOldAck = targets.map(target => target.metric.mediaObserved);
    epoch = 2; width = 64; await Promise.all(targets.map(target => target.retireEpoch(epoch))); await Promise.all(targets.map(target => target.hold(false)));
    await until(() => targets.every(target => target.rawBytes === 0), 'old-raw-settlement');
    receipt.oldEpochAckActivated = targets.some((target, index) => target.metric.mediaObserved !== observedBeforeOldAck[index]);
    if (receipt.oldEpochAckActivated) throw Error('old-epoch-ack'); await installMedia();
    const adapted = await publishFrame(downscaleAuthoredRgbaFrame(full.bytes)); await until(() => targets.every(target => target.metric.lastSequence === adapted.sequence), 'adapted-frame');
    receipt.adaptedFrameObserved = targets.every(target => target.metric.lastWidth === 64 && target.metric.lastSha256 === adapted.reference.sha256); if (!receipt.adaptedFrameObserved) throw Error('format-epoch');
    phase = 'resource-negatives'; try { await prepareAuthoredMediaFrame(new Uint8Array(65537), 128, 2, 63); } catch { receipt.overbyteRejected = true; }
    const changed = snapshotResourceBytes(adapted.bytes); changed[0] = (changed[0]! + 1) % 256;
    try { await readVerifiedResource({ reference: adapted.reference, chunks: chunkResource(changed, 4096), signal: owned.signal, now: () => performance.now(), principalId: 'media-recipient-0', applicationId: 'media-control-example', sessionId: 'owned-worker-session', authorize: options.authorizeResource }); } catch { receipt.corruptRejected = true; }
    if (!receipt.overbyteRejected || !receipt.corruptRejected) throw Error('resource-boundary');
    phase = 'expiry'; const previousRelease = targets[0]!.metric.controlReleased; controlRoute.stop('prepare-expiry');
    await until(() => targets[0]!.metric.controlReleased > previousRelease, 'prepare-expiry-release');
    const expiry = performance.now() + 200;
    controlRoute = control.route({ from: contactSource, to: contactSink, principalId: 'control-owner', applicationId: 'media-control-example', sessionId: 'owned-worker-session', sourceOperation: 'subscribe', queueCapacity: 1, leaseMs: 10000, constraints: { expiresAt: expiry, maxAgeMs: 1000, maxHz: 30 } });
    routes.push(controlRoute); if (!controlRoute.start().ok) throw Error('expiry-grant');
    await contact('down'); await until(() => targets[0]!.metric.contactHeld, 'expiry-contact'); const releasedBeforeExpiry = targets[0]!.metric.controlReleased;
    await wait(220); control.flush(); await until(() => controlRoute!.status().state === 'closed' && controlRoute!.status().reason === 'expired' && targets[0]!.metric.controlReleased > releasedBeforeExpiry && !targets[0]!.metric.contactHeld, 'expiry-release'); receipt.expiryReleasedControl = true;
    receipt.status = 'pass'; receipt.reason = 'selected-owned-composition';
  } catch (error) { receipt.status = owner && aborted(owner) ? 'cancelled' : error instanceof Error && error.message === 'media-denied' ? 'denied' : 'failed'; receipt.reason = receipt.status === 'cancelled' ? 'cancelled' : receipt.status === 'denied' ? 'media-denied' : 'qualification-' + phase; }
  finally {
    owned.abort(); for (const runtime of runtimes) runtime.close(); for (const route of routes) route.stop('stopped');
    if (lifetime) clearTimeout(lifetime); lifetime = undefined; if (waitTimer) clearTimeout(waitTimer); waitTimer = undefined;
    for (const detach of detachers.splice(0)) detach(); await Promise.all(targets.map(target => target.close()));
    while (providerTasks.size) await Promise.all([...providerTasks]); await verificationTail; frames.clear();
    receipt.targets = targets.map(target => target.metric); receipt.deniedMediaDispatched = receipt.status === 'denied' ? targets.reduce((sum, target) => sum + target.metric.mediaDispatched, 0) : 0;
    receipt.ownedCleanup.workersExited = targets.filter(target => target.hasStarted && target.hasExited).length;
    receipt.ownedCleanup.rawOperations = targets.reduce((sum, target) => sum + target.rawOperations, 0); receipt.ownedCleanup.rawBytes = targets.reduce((sum, target) => sum + target.rawBytes, 0);
    receipt.ownedCleanup.timers = targets.reduce((sum, target) => sum + target.timers, 0); receipt.ownedCleanup.listeners = targets.reduce((sum, target) => sum + target.listeners, 0) + detachers.length;
    if (receipt.ownedCleanup.workersExited !== receipt.ownedCleanup.workersStarted || receipt.ownedCleanup.rawOperations || receipt.ownedCleanup.rawBytes || receipt.ownedCleanup.timers || receipt.ownedCleanup.listeners) { receipt.status = 'failed'; receipt.reason = 'cleanup'; }
    if (owner && aborted(owner)) { receipt.status = 'cancelled'; receipt.reason = 'cancelled'; } running = false;
  }
  return receipt;
}
