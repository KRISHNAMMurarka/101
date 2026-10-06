import { parseDeviceDescriptor, parseMediaManifest, planMediaBinding } from '@101/device-model';
import { createDeviceRuntime, intersectMediaRouteGrants } from '@101/device-runtime';
import type { AuthorizationRequest, Connection, DeliveryContext, EndpointHandle, Observation, ResourceReference, RouteGrant } from '@101/device-runtime';

export const APPLICATION_VIDEO_CODEC_PROFILE = 'local-application-video-codec/1';
export const APPLICATION_VIDEO_CODEC_TIERS = Object.freeze([
  Object.freeze({ width: 320, height: 180, frameRate: 20, bitrate: 384000 }),
  Object.freeze({ width: 160, height: 90, frameRate: 10, bitrate: 128000 }),
]);
const LIMITS = Object.freeze({ sources: 1, outputs: 2, bindAttempts: 8, probes: 32, pendingProbes: 2, pixels: 230400,
  chunkBytes: 65536, descriptionBytes: 4096, copiedBytes: 131072, bytesPerSecond: 131072,
  attempts: 512, encodes: 256, bytesLifetime: 4194304, adaptations: 8, openMs: 2000, lifetimeMs: 30000, ownerSignals: 8 });
export type BrowserVideoCodec = 'video/vp8' | 'video/vp9';
type Failure = 'invalid' | 'denied' | 'unsupported' | 'capacity' | 'quota' | 'failed' | 'unavailable' | 'expired' | 'cancelled' | 'closed' | 'stopped';
type Tier = (typeof APPLICATION_VIDEO_CODEC_TIERS)[number];
export interface BrowserVideoCodecGrantRequest {
  readonly profile: typeof APPLICATION_VIDEO_CODEC_PROFILE; readonly role: 'source' | 'sink';
  readonly applicationId: string; readonly sessionId: string; readonly ownerPrincipalId: string; readonly recipientPrincipalId: string;
  readonly sourceOwnerPrincipalId: string; readonly sinkOwnerPrincipalId: string; readonly sourceId: string; readonly outputId: string;
  readonly source: Readonly<ResourceReference>; readonly sink: Readonly<ResourceReference>;
  readonly sourceOperation: 'subscribe'; readonly sinkOperation: 'write'; readonly codec: BrowserVideoCodec;
  readonly frameDependency: 'independent-keyframes';
  readonly tiers: typeof APPLICATION_VIDEO_CODEC_TIERS; readonly maxChunkBytes: 65536; readonly maxBytesPerSecond: 131072;
}
export interface BrowserVideoCodecOwnerGrant { readonly request: BrowserVideoCodecGrantRequest; readonly grant: RouteGrant; readonly signal: AbortSignal }
export interface BrowserApplicationVideoCodecOptions {
  readonly ownerSignal: AbortSignal; readonly applicationId: string; readonly sessionId: string; readonly clockDomain: string; readonly now: () => number;
  readonly authorizeSource: (request: BrowserVideoCodecGrantRequest) => BrowserVideoCodecOwnerGrant | undefined;
  readonly authorizeSink: (request: BrowserVideoCodecGrantRequest) => BrowserVideoCodecOwnerGrant | undefined;
}
export interface BrowserApplicationVideoCodecSource { readonly browserApplicationVideoCodecSource?: never }
export interface BrowserApplicationVideoCodecSourceOptions { readonly sourceId: string; readonly ownerPrincipalId: string; readonly canvas: HTMLCanvasElement }
export interface BrowserApplicationVideoCodecBindOptions {
  readonly source: BrowserApplicationVideoCodecSource; readonly outputId: string; readonly ownerPrincipalId: string;
  readonly container: HTMLElement; readonly label: string; readonly codecs: readonly BrowserVideoCodec[]; readonly ownerSignal: AbortSignal;
}
export interface BrowserApplicationVideoCodecStatus {
  readonly state: 'opening' | 'active' | 'stopped'; readonly reason?: Failure; readonly generation: number;
  readonly codec?: BrowserVideoCodec; readonly tier: number; readonly expiresAt?: number; readonly frames: number;
  readonly encodedBytes: number; readonly dropped: number; readonly adaptations: number; readonly pendingNative: number;
}
export interface BrowserApplicationVideoCodecBinding {
  readonly ready: Promise<boolean>; readonly closed: Promise<void>; status(): Readonly<BrowserApplicationVideoCodecStatus>;
  /** Fresh approvals can narrow the opening ceiling, never extend it. */
  renew(): boolean; stop(): void;
}
export interface BrowserApplicationVideoCodec {
  registerSource(options: BrowserApplicationVideoCodecSourceOptions): BrowserApplicationVideoCodecSource | undefined;
  bind(options: BrowserApplicationVideoCodecBindOptions): BrowserApplicationVideoCodecBinding;
  /** Caller-driven sampling; no hidden capture loop or camera/screen acquisition. */
  capture(source: BrowserApplicationVideoCodecSource): boolean;
  revokeSource(source: BrowserApplicationVideoCodecSource): boolean; revokeOutput(outputId: string): boolean;
  status(): Readonly<{ closed: boolean; sources: number; outputs: number; pendingNative: number; probes: number; attempts: number; cleanupFailures: number }>;
  close(): Promise<void>;
}
type Realm = Window & typeof globalThis;
interface Source { handle: BrowserApplicationVideoCodecSource; id: string; principal: string; canvas: HTMLCanvasElement;
  realm: Realm; width: number; height: number; alive: boolean; outputs: Set<Output> }
interface FrameRecord { sequence: number; timestamp: number; at: number; generation: number; tier: number; produced?: boolean }
interface Bank extends FrameRecord { bytes: Uint8Array; type: EncodedVideoChunkType; description?: Uint8Array }
interface Output {
  source: Source; id: string; principal: string; ownerSignal: AbortSignal; container: HTMLElement; label: string; offered: readonly BrowserVideoCodec[];
  state: BrowserApplicationVideoCodecStatus['state']; reason?: Failure; generation: number; tier: number; codec?: BrowserVideoCodec;
  sourceEndpoint?: EndpointHandle; sinkEndpoint?: EndpointHandle; route?: Connection; authorization?: AuthorizationRequest;
  sourceRequest?: BrowserVideoCodecGrantRequest; sinkRequest?: BrowserVideoCodecGrantRequest; grant?: RouteGrant; ceiling: number; openingDeadline: number;
  signals: AbortSignal[]; detach: (() => void)[]; timer?: number; timerDeadline?: number; tasks: Set<Promise<void>>; setupDone: boolean;
  encoder?: VideoEncoder; decoder?: VideoDecoder; encodeBusy: boolean; decodeBusy: boolean; needKey: boolean;
  input?: FrameRecord; bank?: Bank; delivery?: { record: Bank; observation: Observation; context: DeliveryContext };
  screen?: HTMLCanvasElement; stage?: HTMLCanvasElement; sampling?: HTMLCanvasElement;
  screenContext?: CanvasRenderingContext2D; stageContext?: CanvasRenderingContext2D; samplingContext?: CanvasRenderingContext2D;
  sequence: number; lastCapture: number; frames: number; dropped: number; pressure: number; good: number; changes: number; changeAt: number;
  encodedBytes: number; budgetAt: number; budget: number;
  ready: Promise<boolean>; resolveReady: (ready: boolean) => void; closed: Promise<void>; resolveClosed: () => void;
}
const sourceOwners = new WeakMap<HTMLCanvasElement, Source>(), containerOwners = new WeakMap<HTMLElement, Output>();
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const taLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const taBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const taOffset = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset')!.get!;
const abLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
function signal(value: unknown): value is AbortSignal { try { return typeof nativeAborted.call(value) === 'boolean'; } catch { return false; } }
function active(value: AbortSignal): boolean { return nativeAborted.call(value) === false; }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Reflect.ownKeys(value).length !== keys.length) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return; result[key] = descriptor.value; }
    return result;
  } catch { return; }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const resourceId = (value: unknown): value is string => id(value) && /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const codecs = (value: unknown): readonly BrowserVideoCodec[] | undefined => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return;
  const result: BrowserVideoCodec[] = [];
  for (let index = 0; index < value.length; index++) { const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !('value' in field) || !['video/vp8', 'video/vp9'].includes(field.value) || result.includes(field.value)) return; result.push(field.value); }
  return Object.freeze(result);
};
const nativeCodec = (codec: BrowserVideoCodec) => codec === 'video/vp8' ? 'vp8' : 'vp09.00.10.08';
function encoderConfig(codec: BrowserVideoCodec, tier: Tier): VideoEncoderConfig {
  return { codec: nativeCodec(codec), width: tier.width, height: tier.height, framerate: tier.frameRate, bitrate: tier.bitrate,
    latencyMode: 'realtime', bitrateMode: 'variable', hardwareAcceleration: 'prefer-software' };
}
function decoderConfig(codec: BrowserVideoCodec, tier: Tier, description?: Uint8Array): VideoDecoderConfig {
  return { codec: nativeCodec(codec), codedWidth: tier.width, codedHeight: tier.height, optimizeForLatency: true,
    ...(description ? { description: description as Uint8Array<ArrayBuffer> } : {}) };
}
function smallDescription(value: unknown): Uint8Array | undefined {
  if (value === undefined) return;
  let buffer: ArrayBuffer, offset = 0, size: number;
  try { size = abLength.call(value); buffer = value as ArrayBuffer; }
  catch { size = taLength.call(value); buffer = taBuffer.call(value) as ArrayBuffer; offset = taOffset.call(value); abLength.call(buffer); }
  if (!Number.isInteger(size) || size < 0 || size > LIMITS.descriptionBytes) throw Error('Description quota');
  const result = new Uint8Array(size); Uint8Array.prototype.set.call(result, new Uint8Array(buffer, offset, size)); return result;
}
function descriptor(deviceId: string, sink = false) {
  return parseDeviceDescriptor({ schemaVersion: 1, id: deviceId, label: sink ? 'Encoded application output' : 'Encoded application source', revision: 1,
    adapter: { id: 'connect:application-video-codec', version: '1.0.0' }, runtime: { platform: 'browser-local' }, capabilities: [{
      id: 'frame', semantic: 'app:private-encoded-frame-ready/1', schemaVersion: 1, kind: 'sample', value: { type: 'scalar', unit: '1', min: 1, max: 256 },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, permissions: [sink ? 'write' : 'subscribe'], ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] });
}
const denied = (reason: Failure): BrowserApplicationVideoCodecBinding => Object.freeze({ ready: Promise.resolve(false), closed: Promise.resolve(),
  status: () => Object.freeze({ state: 'stopped' as const, reason, generation: 0, tier: 0, frames: 0, encodedBytes: 0, dropped: 0, adaptations: 0, pendingNative: 0 }), renew: () => false, stop() {} });

/** Local application rasters only. Codec payloads remain private to exact runtime
 * registrations/recipients; the existing SDK wire protocol does not carry them.
 * Host approvals and same-origin isolation are cooperative, not a sandbox.
 * flush/close qualify observable WebCodecs API settlement, not internal native
 * memory or worker quiescence. Only SDK-created frames/canvases/codecs are retired. */
export function createBrowserApplicationVideoCodec(input: BrowserApplicationVideoCodecOptions): BrowserApplicationVideoCodec {
  const options = fields(input, ['ownerSignal', 'applicationId', 'sessionId', 'clockDomain', 'now', 'authorizeSource', 'authorizeSink']);
  if (!options || !signal(options.ownerSignal) || !id(options.applicationId) || !id(options.sessionId) || !id(options.clockDomain) ||
    typeof options.now !== 'function' || typeof options.authorizeSource !== 'function' || typeof options.authorizeSink !== 'function') throw new TypeError('Explicit video owner and approvals required');
  const owner = options.ownerSignal, applicationId = options.applicationId, sessionId = options.sessionId, clockDomain = options.clockDomain;
  const readNow = options.now as () => number, authorizeSource = options.authorizeSource as BrowserApplicationVideoCodecOptions['authorizeSource'];
  const authorizeSink = options.authorizeSink as BrowserApplicationVideoCodecOptions['authorizeSink'];
  const sources = new Set<Source>(), handles = new WeakMap<BrowserApplicationVideoCodecSource, Source>(), outputs = new Map<string, Output>();
  let closed = !active(owner), previousAt = -1, bindAttempts = 0, pendingBindings = 0, captureAttempts = 0, encodes = 0, probes = 0, pendingProbes = 0, totalBytes = 0, cleanupFailures = 0, registering = false;
  let closePromise: Promise<void> | undefined;
  function basic(output: Output): boolean { return !closed && outputs.get(output.id) === output && output.state !== 'stopped' && output.source.alive && sources.has(output.source); }
  function signalsCurrent(output: Output): boolean { return active(owner) && active(output.ownerSignal) && output.signals.every(active); }
  function clock(): number {
    if (closed || !active(owner)) { shutdown('denied'); return NaN; }
    let at: number; try { at = readNow(); } catch { shutdown('invalid'); return NaN; }
    if (closed || !active(owner)) return NaN;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER || at < previousAt) { shutdown('invalid'); return NaN; }
    previousAt = at; return at;
  }
  function facts(output: Output): boolean {
    const source = output.source, realm = source.realm;
    const width = Object.getOwnPropertyDescriptor(realm.HTMLCanvasElement.prototype, 'width')!.get!.call(source.canvas);
    const height = Object.getOwnPropertyDescriptor(realm.HTMLCanvasElement.prototype, 'height')!.get!.call(source.canvas);
    const doc = Object.getOwnPropertyDescriptor(realm.Node.prototype, 'ownerDocument')!.get!.call(source.canvas) as Document;
    const outputDoc = Object.getOwnPropertyDescriptor(realm.Node.prototype, 'ownerDocument')!.get!.call(output.container);
    return width === source.width && height === source.height && !Object.getOwnPropertyDescriptor(realm.Document.prototype, 'hidden')!.get!.call(doc) &&
      outputDoc === doc && sourceOwners.get(source.canvas) === source && containerOwners.get(output.container) === output;
  }
  function releaseSource(source: Source): void {
    if (!source.alive && source.outputs.size === 0) { sources.delete(source); if (sourceOwners.get(source.canvas) === source) sourceOwners.delete(source.canvas); }
  }
  function finish(output: Output): void {
    if (output.state !== 'stopped' || !output.setupDone || output.tasks.size || output.encodeBusy || output.decodeBusy) return;
    if (outputs.get(output.id) === output) outputs.delete(output.id);
    if (containerOwners.get(output.container) === output) containerOwners.delete(output.container);
    output.source.outputs.delete(output); releaseSource(output.source); output.resolveClosed();
  }
  function clearScreen(output: Output): void {
    for (const canvas of [output.screen, output.stage, output.sampling]) if (canvas) try { canvas.width = 1; canvas.height = 1; if (canvas === output.screen) canvas.remove(); } catch { cleanupFailures++; }
  }
  function retire(output: Output, reason: Failure): void {
    if (output.state !== 'stopped') { output.state = 'stopped'; output.reason = reason; output.generation++; output.resolveReady(false); }
    output.bank = undefined; output.input = undefined; output.delivery = undefined;
    for (const remove of output.detach.splice(0)) try { remove(); } catch { cleanupFailures++; }
    if (output.timer !== undefined) { output.source.realm.clearTimeout(output.timer); output.timer = undefined; }
    output.route?.stop(reason);
    if (output.sourceEndpoint) runtime.unregister(output.sourceEndpoint); if (output.sinkEndpoint) runtime.unregister(output.sinkEndpoint);
    for (const codec of [output.encoder, output.decoder]) try { if (codec && codec.state !== 'closed') codec.close(); } catch { cleanupFailures++; }
    clearScreen(output); finish(output);
  }
  function listen(output: Output, selected: AbortSignal): boolean {
    if (output.signals.includes(selected)) return true;
    if (output.signals.length >= LIMITS.ownerSignals) return false;
    output.signals.push(selected); const callback = () => retire(output, 'denied');
    output.detach.push(() => removeEvent.call(selected, 'abort', callback)); addEvent.call(selected, 'abort', callback, { once: true });
    return basic(output) && signalsCurrent(output);
  }
  function authorize(output: Output): boolean {
    if (!basic(output) || !output.sourceRequest || !output.sinkRequest) return false;
    let a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined;
    try {
      a = fields(authorizeSource(output.sourceRequest), ['request', 'grant', 'signal']); if (!basic(output) || !signalsCurrent(output)) return false;
      b = fields(authorizeSink(output.sinkRequest), ['request', 'grant', 'signal']);
    } catch { return false; }
    if (!basic(output) || !signalsCurrent(output) || !a || !b || a.request !== output.sourceRequest || b.request !== output.sinkRequest ||
      !signal(a.signal) || !signal(b.signal) || !active(a.signal) || !active(b.signal)) return false;
    const at = clock(); if (!basic(output) || !signalsCurrent(output) || !active(a.signal) || !active(b.signal)) return false;
    const grant = intersectMediaRouteGrants(a.grant, b.grant, at); if (!grant || !listen(output, a.signal) || !listen(output, b.signal)) return false;
    output.grant = Object.freeze({ expiresAt: Math.min(output.ceiling, output.grant?.expiresAt ?? Infinity, grant.expiresAt),
      maxHz: Math.min(output.grant?.maxHz ?? Infinity, grant.maxHz!), maxAgeMs: Math.min(output.grant?.maxAgeMs ?? Infinity, grant.maxAgeMs) });
    return basic(output) && signalsCurrent(output) && at < output.grant.expiresAt && armExpiry(output);
  }
  function current(output: Output, context?: DeliveryContext, observation?: Observation, fresh = true): boolean {
    const generation = output.generation;
    if (!basic(output) || !signalsCurrent(output) || fresh && !authorize(output)) return false;
    let valid: boolean; try { valid = !context || context.isCurrent(); } catch { return false; }
    const at = clock();
    try { valid = valid && facts(output); } catch { return false; }
    return valid && basic(output) && generation === output.generation && signalsCurrent(output) && (!context || active(context.signal)) &&
      Number.isFinite(at) && at < output.ceiling && at < (output.grant?.expiresAt ?? Infinity) &&
      (output.state !== 'opening' || at < output.openingDeadline) && (!observation || observation.clockDomain === clockDomain && observation.timestamp <= at && at - observation.timestamp <= output.grant!.maxAgeMs);
  }
  async function issued<T>(output: Output, issue: () => Promise<T>): Promise<T> {
    let complete!: () => void; const task = new Promise<void>(resolve => { complete = resolve; }); output.tasks.add(task);
    try { return await issue(); } finally { output.tasks.delete(task); complete(); finish(output); }
  }
  async function probe(output: Output, issue: () => Promise<{ supported?: boolean }>): Promise<boolean> {
    if (++probes > LIMITS.probes || pendingProbes >= LIMITS.pendingProbes) throw Error('Probe quota');
    pendingProbes++;
    try { const result = await issued(output, issue); return result.supported === true; } finally { pendingProbes--; }
  }
  function armExpiry(output: Output): boolean {
    const at = clock(); if (!basic(output) || !signalsCurrent(output) || !output.grant || at >= output.grant.expiresAt) return false;
    const deadline = Math.min(output.ceiling, output.grant.expiresAt, output.state === 'opening' ? output.openingDeadline : Infinity);
    if (output.timer !== undefined && output.timerDeadline === deadline) return true;
    if (output.timer !== undefined) output.source.realm.clearTimeout(output.timer);
    const token = output.source.realm.setTimeout(() => retire(output, 'expired'), Math.max(0, deadline - at));
    if (!basic(output) || !signalsCurrent(output)) { output.source.realm.clearTimeout(token); return false; }
    output.timer = token; output.timerDeadline = deadline; return true;
  }
  const runtime = createDeviceRuntime({ now: clock, clockDomain, maxRoutes: 2, maxSubscribers: 2, maxRegistrations: 4, maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 1,
    authorize(request) {
      const output = [...outputs.values()].find(value => value.sinkEndpoint?.id === request.sink.registrationId);
      if (!output || !output.sourceEndpoint || request.principalId !== output.principal || request.applicationId !== applicationId || request.sessionId !== sessionId ||
        request.source.registrationId !== output.sourceEndpoint.id || request.source.deviceId !== output.source.id || request.sink.deviceId !== output.id ||
        request.source.capabilityId !== 'frame' || request.sink.capabilityId !== 'frame' || request.source.descriptorRevision !== 1 || request.sink.descriptorRevision !== 1 ||
        request.source.schemaVersion !== 1 || request.sink.schemaVersion !== 1 || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || !current(output)) return;
      output.authorization = request; return output.grant;
    } });
  function pressure(output: Output): void { output.dropped++; output.pressure++; output.good = 0; output.needKey = true; }
  function changeTier(output: Output): void {
    if (output.encodeBusy || output.decodeBusy || !current(output) || !output.encoder || !output.decoder || !output.codec) return;
    const at = clock(); if (!current(output) || at - output.changeAt < 500) return;
    const next = output.tier === 0 && output.pressure >= 4 ? 1 : output.tier === 1 && output.good >= 8 ? 0 : output.tier;
    if (next === output.tier) return;
    if (output.changes >= LIMITS.adaptations) { retire(output, 'quota'); return; }
    const tier = APPLICATION_VIDEO_CODEC_TIERS[next]!;
    output.generation++; output.tier = next; output.changes++; output.changeAt = at; output.bank = undefined; output.input = undefined; output.needKey = true;
    output.pressure = output.good = 0;
    try {
      output.encoder.reset(); if (!current(output)) { retire(output, 'denied'); return; }
      output.decoder.reset(); if (!current(output)) { retire(output, 'denied'); return; }
      output.encoder.configure(encoderConfig(output.codec, tier)); if (!current(output)) { retire(output, 'denied'); return; }
      output.decoder.configure(decoderConfig(output.codec, tier)); if (!current(output)) { retire(output, 'denied'); return; }
      for (const canvas of [output.screen, output.stage, output.sampling]) if (canvas) { canvas.width = tier.width; if (!current(output)) { retire(output, 'denied'); return; } canvas.height = tier.height; }
    } catch { retire(output, 'failed'); }
  }
  function encoded(output: Output, chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    const record = output.input, realm = output.source.realm;
    if (!record || !current(output) || record.generation !== output.generation) return;
    try {
      const length = Object.getOwnPropertyDescriptor(realm.EncodedVideoChunk.prototype, 'byteLength')!.get!.call(chunk) as number;
      const timestamp = Object.getOwnPropertyDescriptor(realm.EncodedVideoChunk.prototype, 'timestamp')!.get!.call(chunk) as number;
      const type = Object.getOwnPropertyDescriptor(realm.EncodedVideoChunk.prototype, 'type')!.get!.call(chunk) as EncodedVideoChunkType;
      if (!Number.isInteger(length) || length < 1 || length > LIMITS.chunkBytes || timestamp !== record.timestamp) { pressure(output); return; }
      const config = metadata && Object.getOwnPropertyDescriptor(metadata, 'decoderConfig');
      if (config && !('value' in config)) throw Error('Codec metadata');
      const descriptionField = config?.value && Object.getOwnPropertyDescriptor(config.value, 'description');
      if (descriptionField && !('value' in descriptionField)) throw Error('Codec metadata');
      const description = smallDescription(descriptionField?.value);
      const copiedBytes = length + (description?.byteLength ?? 0);
      if (copiedBytes > LIMITS.chunkBytes) { pressure(output); return; }
      const at = clock(); if (!current(output) || record.generation !== output.generation) return;
      output.budget = Math.min(LIMITS.chunkBytes, output.budget + Math.max(0, at - output.budgetAt) * LIMITS.bytesPerSecond / 1000); output.budgetAt = at;
      if (copiedBytes > output.budget || totalBytes + copiedBytes > LIMITS.bytesLifetime) { pressure(output); return; }
      if (output.needKey && type !== 'key') { pressure(output); return; }
      const bytes = new Uint8Array(length); realm.EncodedVideoChunk.prototype.copyTo.call(chunk, bytes);
      if (!current(output) || record.generation !== output.generation) return;
      record.produced = true;
      totalBytes += copiedBytes; output.encodedBytes += copiedBytes; output.budget -= copiedBytes;
      if (output.bank) { pressure(output); if (type !== 'key') { output.bank = undefined; return; } }
      output.bank = { ...record, bytes, type, ...(description ? { description } : {}) }; output.needKey = false;
      const published = runtime.publish(output.sourceEndpoint!, record.sequence, { sequence: record.sequence, timestamp: record.at, clockDomain,
        provenance: { profile: APPLICATION_VIDEO_CODEC_PROFILE, codec: output.codec!, tier: record.tier, clock: 'caller-raster-snapshot' } });
      if (!published.ok || !current(output)) { output.bank = undefined; pressure(output); }
      runtime.flush();
    } catch { retire(output, 'failed'); }
  }
  function decoded(output: Output, frame: VideoFrame): void {
    const delivery = output.delivery, realm = output.source.realm;
    try {
      if (!delivery || delivery.record.generation !== output.generation || !current(output, delivery.context, delivery.observation)) return;
      const tier = APPLICATION_VIDEO_CODEC_TIERS[delivery.record.tier]!;
      const width = Object.getOwnPropertyDescriptor(realm.VideoFrame.prototype, 'displayWidth')!.get!.call(frame) as number;
      const height = Object.getOwnPropertyDescriptor(realm.VideoFrame.prototype, 'displayHeight')!.get!.call(frame) as number;
      const timestamp = Object.getOwnPropertyDescriptor(realm.VideoFrame.prototype, 'timestamp')!.get!.call(frame) as number;
      if (width !== tier.width || height !== tier.height || timestamp !== delivery.record.timestamp) { retire(output, 'failed'); return; }
      output.stageContext!.clearRect(0, 0, tier.width, tier.height);
      if (!current(output, delivery.context, delivery.observation)) { retire(output, 'denied'); return; }
      output.stageContext!.drawImage(frame, 0, 0, tier.width, tier.height);
      if (!current(output, delivery.context, delivery.observation)) { retire(output, 'denied'); return; }
      output.screenContext!.clearRect(0, 0, tier.width, tier.height);
      if (!current(output, delivery.context, delivery.observation)) { retire(output, 'denied'); return; }
      output.screenContext!.drawImage(output.stage!, 0, 0);
      if (!current(output, delivery.context, delivery.observation)) { retire(output, 'denied'); return; }
      output.frames++; output.good++;
    } catch { retire(output, 'failed'); }
    finally { try { realm.VideoFrame.prototype.close.call(frame); } catch { cleanupFailures++; } }
  }
  async function apply(output: Output, observation: Observation, context: DeliveryContext): Promise<void> {
    const bank = output.bank;
    if (!bank || output.decodeBusy || bank.sequence !== observation.value || bank.generation !== output.generation || !current(output, context, observation) || !output.decoder || !output.codec) return;
    output.bank = undefined; output.decodeBusy = true; output.delivery = { record: bank, observation, context };
    try {
      if (bank.bytes.byteLength > LIMITS.chunkBytes || (bank.description?.byteLength ?? 0) > LIMITS.descriptionBytes) throw Error('Decode quota');
      if (bank.type === 'key' && bank.description) { output.decoder.reset(); if (!current(output, context, observation)) return; output.decoder.configure(decoderConfig(output.codec, APPLICATION_VIDEO_CODEC_TIERS[bank.tier]!, bank.description)); }
      if (!current(output, context, observation)) return;
      const native = new output.source.realm.EncodedVideoChunk({ type: bank.type, timestamp: bank.timestamp, data: bank.bytes });
      if (!current(output, context, observation)) return;
      output.decoder.decode(native);
      await issued(output, () => output.decoder!.flush());
      if (!current(output, context, observation)) { if (basic(output)) retire(output, 'denied'); return; }
    } catch { if (basic(output)) { pressure(output); try { output.decoder?.reset(); if (current(output) && output.codec) output.decoder?.configure(decoderConfig(output.codec, APPLICATION_VIDEO_CODEC_TIERS[output.tier]!)); } catch { retire(output, 'failed'); } } }
    finally { output.delivery = undefined; output.decodeBusy = false; finish(output); }
  }
  async function open(output: Output): Promise<void> {
    try {
      const realm = output.source.realm;
      if (![realm.VideoEncoder, realm.VideoDecoder, realm.VideoFrame, realm.EncodedVideoChunk].every(value => typeof value === 'function')) { retire(output, 'unsupported'); return; }
      for (const offered of output.offered) {
        let supported = true;
        for (const tier of APPLICATION_VIDEO_CODEC_TIERS) {
          const encoder = await probe(output, () => realm.VideoEncoder.isConfigSupported(encoderConfig(offered, tier)));
          if (!current(output, undefined, undefined, false)) { retire(output, 'cancelled'); return; }
          const decoder = await probe(output, () => realm.VideoDecoder.isConfigSupported(decoderConfig(offered, tier)));
          if (!current(output, undefined, undefined, false)) { retire(output, 'cancelled'); return; }
          supported = supported && encoder && decoder;
        }
        if (supported) { output.codec = offered; break; }
      }
      if (!output.codec) { retire(output, 'unsupported'); return; }
      const sourceRef = Object.freeze({ registrationId: output.sourceEndpoint!.id, deviceId: output.source.id, capabilityId: 'frame', descriptorRevision: 1, schemaVersion: 1 });
      const sinkRef = Object.freeze({ registrationId: output.sinkEndpoint!.id, deviceId: output.id, capabilityId: 'frame', descriptorRevision: 1, schemaVersion: 1 });
      const base: Omit<BrowserVideoCodecGrantRequest, 'role' | 'ownerPrincipalId'> = { profile: APPLICATION_VIDEO_CODEC_PROFILE, applicationId, sessionId, recipientPrincipalId: output.principal,
        sourceOwnerPrincipalId: output.source.principal, sinkOwnerPrincipalId: output.principal, sourceId: output.source.id, outputId: output.id,
        source: sourceRef, sink: sinkRef, sourceOperation: 'subscribe' as const, sinkOperation: 'write' as const,
        codec: output.codec, frameDependency: 'independent-keyframes' as const, tiers: APPLICATION_VIDEO_CODEC_TIERS, maxChunkBytes: 65536 as const, maxBytesPerSecond: 131072 as const };
      output.sourceRequest = Object.freeze({ ...base, role: 'source' as const, ownerPrincipalId: output.source.principal });
      output.sinkRequest = Object.freeze({ ...base, role: 'sink' as const, ownerPrincipalId: output.principal });
      if (!current(output)) { retire(output, 'denied'); return; }
      const tier = APPLICATION_VIDEO_CODEC_TIERS[0]!;
      const manifest = parseMediaManifest({ schemaVersion: 1, id: 'video:codec-plan', tracks: [
        { type: 'track', id: output.source.id, media: 'video', direction: 'capture', codecs: [output.codec], video: { widthPx: { min: 160, max: 320 }, heightPx: { min: 90, max: 180 }, frameRateHz: { min: 10, max: 20 } } }],
        renderTargets: [{ type: 'render-target', id: output.id, media: 'video', geometry: { widthPx: tier.width, heightPx: tier.height, pixelRatio: 1 } }] });
      if (!planMediaBinding(manifest, output.source.id, output.id, { source: { resourceId: output.source.id, registrationId: sourceRef.registrationId, state: 'available', codecs: [output.codec], video: { widthPx: tier.width, heightPx: tier.height, frameRateHz: tier.frameRate } },
        target: { resourceId: output.id, registrationId: sinkRef.registrationId, state: 'available', codecs: [output.codec], geometry: { widthPx: tier.width, heightPx: tier.height, pixelRatio: 1 } } }).ok || !current(output)) { retire(output, 'unsupported'); return; }
      output.route = runtime.route({ from: output.sourceEndpoint!, to: output.sinkEndpoint!, principalId: output.principal, applicationId, sessionId, sourceOperation: 'subscribe', leaseMs: 1000, queueCapacity: 1 });
      if (!current(output)) { retire(output, 'denied'); return; }
      output.route.onClose(() => { if (basic(output)) retire(output, 'unavailable'); });
      if (!output.route.prepare().ok || !current(output)) { retire(output, 'denied'); return; }
      output.encoder = new realm.VideoEncoder({ output: (chunk, metadata) => encoded(output, chunk, metadata), error: () => retire(output, 'failed') });
      if (!current(output)) { retire(output, 'denied'); return; }
      output.decoder = new realm.VideoDecoder({ output: frame => decoded(output, frame), error: () => retire(output, 'failed') });
      if (!current(output)) { retire(output, 'denied'); return; }
      output.encoder.configure(encoderConfig(output.codec, tier)); if (!current(output)) { retire(output, 'denied'); return; }
      output.decoder.configure(decoderConfig(output.codec, tier)); if (!current(output)) { retire(output, 'denied'); return; }
      for (const name of ['screen', 'stage', 'sampling'] as const) {
        output[name] = output.source.canvas.ownerDocument.createElement('canvas'); if (!current(output)) { retire(output, 'denied'); return; }
        output[name]!.width = tier.width; output[name]!.height = tier.height;
        const context = output[name]!.getContext('2d'); if (!context || !current(output)) { retire(output, 'unsupported'); return; }
        if (name === 'screen') output.screenContext = context; else if (name === 'stage') output.stageContext = context; else output.samplingContext = context;
      }
      output.screen!.setAttribute('role', 'img'); output.screen!.setAttribute('aria-label', output.label); if (!current(output)) { retire(output, 'denied'); return; }
      output.container.append(output.screen!); if (!current(output)) { retire(output, 'denied'); return; }
      if (!output.route.activate().ok || !current(output)) { retire(output, 'denied'); return; }
      output.state = 'active'; if (!armExpiry(output) || !current(output)) { retire(output, 'denied'); return; }
      output.resolveReady(true);
    } catch { if (basic(output)) retire(output, 'failed'); }
    finally { output.setupDone = true; if (output.state === 'stopped') retire(output, output.reason ?? 'failed'); finish(output); }
  }
  function shutdown(reason: Failure): void {
    closed = true;
    for (const output of [...outputs.values()]) retire(output, reason);
    for (const source of [...sources]) { source.alive = false; releaseSource(source); }
    runtime?.close();
  }
  const ownerEnded = () => shutdown('denied'); addEvent.call(owner, 'abort', ownerEnded, { once: true });
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    shutdown('closed'); removeEvent.call(owner, 'abort', ownerEnded);
    closePromise = Promise.all([...outputs.values()].map(output => output.closed)).then(() => {}); return closePromise;
  }
  return Object.freeze({
    registerSource(value: BrowserApplicationVideoCodecSourceOptions): BrowserApplicationVideoCodecSource | undefined {
      if (closed || registering || sources.size >= LIMITS.sources) return;
      registering = true;
      try {
        const copied = fields(value, ['sourceId', 'ownerPrincipalId', 'canvas']); if (!copied || !resourceId(copied.sourceId) || !id(copied.ownerPrincipalId)) return;
        const at = clock(); if (!Number.isFinite(at) || closed || !active(owner)) return;
        const canvas = copied.canvas as HTMLCanvasElement, realm = canvas?.ownerDocument?.defaultView as Realm | null;
        if (!realm || !(canvas instanceof realm.HTMLCanvasElement) || sourceOwners.has(canvas) || canvas.ownerDocument.hidden || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) ||
          canvas.width < 1 || canvas.height < 1 || canvas.width > 640 || canvas.height > 360 || canvas.width * canvas.height > LIMITS.pixels || closed || !active(owner)) return;
        const handle = Object.freeze({}), source: Source = { handle, id: copied.sourceId, principal: copied.ownerPrincipalId, canvas, realm,
          width: canvas.width, height: canvas.height, alive: true, outputs: new Set() };
        if (closed || !active(owner)) return;
        sourceOwners.set(canvas, source); sources.add(source); handles.set(handle, source); return handle;
      } finally { registering = false; }
    },
    bind(value: BrowserApplicationVideoCodecBindOptions): BrowserApplicationVideoCodecBinding {
      if (closed || !active(owner)) return denied('closed');
      if (++bindAttempts > LIMITS.bindAttempts || outputs.size + pendingBindings >= LIMITS.outputs) return denied('capacity');
      pendingBindings++;
      try {
      const copied = fields(value, ['source', 'outputId', 'ownerPrincipalId', 'container', 'label', 'codecs', 'ownerSignal']);
      const source = copied?.source && typeof copied.source === 'object' ? handles.get(copied.source as BrowserApplicationVideoCodecSource) : undefined;
      const offered = copied && codecs(copied.codecs);
      if (!copied || !source?.alive || !resourceId(copied.outputId) || copied.outputId === source.id || !id(copied.ownerPrincipalId) || !signal(copied.ownerSignal) || !active(copied.ownerSignal) ||
        typeof copied.label !== 'string' || copied.label.length < 1 || copied.label.length > 128 || [...copied.label].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !offered ||
        !(copied.container instanceof source.realm.HTMLElement) || copied.container.ownerDocument !== source.canvas.ownerDocument || containerOwners.has(copied.container) || outputs.has(copied.outputId)) return denied('invalid');
      if (closed || !active(owner)) return denied('closed');
      let resolveReady!: (ready: boolean) => void, resolveClosed!: () => void;
      const ready = new Promise<boolean>(resolve => { resolveReady = resolve; }), settled = new Promise<void>(resolve => { resolveClosed = resolve; });
      const output: Output = { source, id: copied.outputId, principal: copied.ownerPrincipalId, ownerSignal: copied.ownerSignal, container: copied.container, label: copied.label, offered,
        state: 'opening', generation: 1, tier: 0, signals: [], detach: [], tasks: new Set(), setupDone: false, ceiling: Infinity, openingDeadline: Infinity,
        encodeBusy: false, decodeBusy: false, needKey: true, sequence: 0, lastCapture: -Infinity, frames: 0, dropped: 0, pressure: 0, good: 0, changes: 0, changeAt: 0,
        encodedBytes: 0, budgetAt: 0, budget: LIMITS.chunkBytes, ready, resolveReady, closed: settled, resolveClosed };
      outputs.set(output.id, output); source.outputs.add(output); containerOwners.set(output.container, output);
      const stopped = () => retire(output, 'cancelled'); output.detach.push(() => removeEvent.call(output.ownerSignal, 'abort', stopped)); addEvent.call(output.ownerSignal, 'abort', stopped, { once: true });
      const at = clock(); output.ceiling = at + LIMITS.lifetimeMs; output.openingDeadline = at + LIMITS.openMs; output.budgetAt = output.changeAt = at;
      try {
        if (!current(output, undefined, undefined, false)) { output.setupDone = true; retire(output, 'cancelled'); }
        else {
          output.timer = source.realm.setTimeout(() => retire(output, 'expired'), LIMITS.openMs); output.timerDeadline = output.openingDeadline;
          if (!current(output, undefined, undefined, false)) { output.setupDone = true; retire(output, 'cancelled'); }
          else {
          output.sourceEndpoint = runtime.registerSource({ device: descriptor(source.id), capability: 'frame' });
          output.sinkEndpoint = runtime.registerSink({ device: descriptor(output.id, true), capability: 'frame', apply: (observation, context) => apply(output, observation, context), release() { output.bank = undefined; clearScreen(output); } });
          runtime.setReadiness(output.sourceEndpoint, 'available'); runtime.setReadiness(output.sinkEndpoint, 'available');
          if (!current(output, undefined, undefined, false)) { output.setupDone = true; retire(output, 'cancelled'); } else void open(output);
          }
        }
      } catch { output.setupDone = true; retire(output, 'failed'); }
      return Object.freeze({ ready, closed: settled, status: () => Object.freeze({ state: output.state, reason: output.reason, generation: output.generation,
        codec: output.codec, tier: output.tier, expiresAt: output.grant?.expiresAt, frames: output.frames, encodedBytes: output.encodedBytes, dropped: output.dropped, adaptations: output.changes, pendingNative: output.tasks.size }),
        renew() { if (output.state !== 'active' || !current(output) || !output.route?.renew(output.principal).ok || !current(output) || !armExpiry(output)) { if (basic(output)) retire(output, 'denied'); return false; } return true; }, stop() { retire(output, 'stopped'); } });
      } finally { pendingBindings--; }
    },
    capture(handle: BrowserApplicationVideoCodecSource): boolean {
      if (closed || !active(owner)) return false;
      if (++captureAttempts > LIMITS.attempts) { shutdown('quota'); return false; }
      const source = handle && typeof handle === 'object' ? handles.get(handle) : undefined; if (!source?.alive) return false;
      let admitted = false;
      for (const output of [...source.outputs]) {
        if (output.state !== 'active') continue;
        if (!current(output)) { retire(output, 'denied'); continue; }
        changeTier(output); if (!current(output)) continue;
        const at = clock(), tier = APPLICATION_VIDEO_CODEC_TIERS[output.tier]!;
        if (!current(output)) { retire(output, 'denied'); continue; }
        if (at - output.lastCapture < 1000 / Math.min(tier.frameRate, output.grant!.maxHz!)) continue;
        if (output.encodeBusy || output.decodeBusy) { pressure(output); continue; }
        if (++encodes > LIMITS.encodes || output.sequence >= 256) { retire(output, 'quota'); continue; }
        output.encodeBusy = true; output.lastCapture = at;
        const record: FrameRecord = { sequence: ++output.sequence, timestamp: Math.round(at * 1000), at, generation: output.generation, tier: output.tier }; output.input = record;
        let frame: VideoFrame | undefined;
        try {
          if (!output.route?.renew(output.principal).ok || !current(output)) { retire(output, 'denied'); continue; }
          output.samplingContext!.drawImage(source.canvas, 0, 0, tier.width, tier.height);
          if (!current(output) || record.generation !== output.generation) { retire(output, 'denied'); continue; }
          frame = new source.realm.VideoFrame(output.sampling!, { timestamp: record.timestamp });
          if (!current(output) || record.generation !== output.generation) { retire(output, 'denied'); continue; }
          // Each admitted frame is independently decodable. Per-frame flush is
          // the observed settlement boundary; inter-frame streaming is outside
          // this selected profile rather than retaining an open native queue.
          output.encoder!.encode(frame, { keyFrame: true }); admitted = true;
          const task = issued(output, () => output.encoder!.flush()).then(() => {
            if (basic(output) && output.input === record && !record.produced) pressure(output);
          }, () => { if (basic(output)) pressure(output); }).finally(() => { if (output.input === record) output.input = undefined; output.encodeBusy = false; finish(output); });
          void task;
        } catch { retire(output, 'failed'); }
        finally {
          if (frame) try { source.realm.VideoFrame.prototype.close.call(frame); } catch { cleanupFailures++; }
          if (!output.tasks.size) { output.encodeBusy = false; finish(output); }
        }
      }
      runtime.flush(); return admitted;
    },
    revokeSource(handle: BrowserApplicationVideoCodecSource): boolean { const source = handle && typeof handle === 'object' ? handles.get(handle) : undefined; if (!source?.alive) return false;
      source.alive = false; for (const output of [...source.outputs]) retire(output, 'denied'); releaseSource(source); return true; },
    revokeOutput(outputId: string): boolean { const output = outputs.get(outputId); if (!output || output.state === 'stopped') return false; retire(output, 'denied'); return true; },
    status: () => Object.freeze({ closed, sources: [...sources].filter(source => source.alive).length, outputs: outputs.size,
      pendingNative: [...outputs.values()].reduce((count, output) => count + output.tasks.size, 0), probes, attempts: captureAttempts, cleanupFailures }),
    close,
  });
}
