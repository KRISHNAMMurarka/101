import { parseDeviceDescriptor, parseMediaManifest, planMediaBinding } from '@101/device-model';
import { createDeviceRuntime, intersectMediaRouteGrants } from '@101/device-runtime';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation, ResourceReference, RouteGrant } from '@101/device-runtime';

export interface BrowserMediaGrantRequest {
  readonly role: 'source' | 'sink'; readonly ownerPrincipalId: string; readonly recipientPrincipalId: string;
  readonly applicationId: string; readonly sessionId: string; readonly sourceId: string; readonly outputId: string;
  readonly sourceOwnerPrincipalId: string; readonly sinkOwnerPrincipalId: string;
  readonly source: Readonly<ResourceReference>; readonly sink: Readonly<ResourceReference>;
  readonly sourceOperation: 'subscribe'; readonly sinkOperation: 'write';
}
/** The exact issued request binds this ephemeral owner decision; copied requests are rejected. */
export interface BrowserMediaOwnerGrant { readonly request: Readonly<BrowserMediaGrantRequest>; readonly grant: RouteGrant }
export interface BrowserApplicationMediaOptions {
  readonly applicationId: string; readonly sessionId: string; readonly clockDomain: string; readonly now: () => number;
  readonly authorizeSource: (request: Readonly<BrowserMediaGrantRequest>) => BrowserMediaOwnerGrant | undefined;
  readonly authorizeSink: (request: Readonly<BrowserMediaGrantRequest>) => BrowserMediaOwnerGrant | undefined;
}
export interface BrowserApplicationMediaSource { readonly id: string }
export interface BrowserApplicationMediaSourceOptions {
  readonly sourceId: string; readonly ownerPrincipalId: string; readonly canvas: HTMLCanvasElement; readonly maxHz: number;
}
export interface BrowserApplicationMediaBindOptions {
  readonly source: BrowserApplicationMediaSource; readonly outputId: string; readonly ownerPrincipalId: string;
  readonly container: HTMLElement; readonly label: string; readonly signal?: AbortSignal;
}
export interface BrowserApplicationMediaStatus {
  readonly state: 'opening' | 'active' | 'stopped'; readonly frames: number;
  /** Immutable opening grant ceiling, narrowed by subsequent current owner decisions. */
  readonly expiresAt?: number;
  readonly reason?: 'invalid' | 'denied' | 'capacity' | 'unsupported' | 'failed' | 'expired' | 'unavailable' | 'cancelled' | 'closed';
}
export interface BrowserApplicationMediaBinding {
  readonly ready: Promise<boolean>; status(): Readonly<BrowserApplicationMediaStatus>;
  /** Fresh approval and lease check within the opening deadline; a later lifetime needs a new bind. */
  renew(): boolean; stop(): void;
}
export interface BrowserApplicationMedia {
  registerSource(options: BrowserApplicationMediaSourceOptions): BrowserApplicationMediaSource | undefined;
  bind(options: BrowserApplicationMediaBindOptions): BrowserApplicationMediaBinding;
  revokeSource(source: BrowserApplicationMediaSource): number;
  revokeOutput(outputId: string): boolean;
  status(): Readonly<{ closed: boolean; sources: number; outputs: number; captures: number; pending: number }>;
  close(): void;
}
type Reason = NonNullable<BrowserApplicationMediaStatus['reason']>;
type BrowserWindow = Window & typeof globalThis;
interface Source {
  handle: BrowserApplicationMediaSource; id: string; principal: string; canvas: HTMLCanvasElement; window: BrowserWindow;
  width: number; height: number; maxHz: number; endpoint: EndpointHandle; generation: number; outputs: Set<Output>;
  capture?: Capture; attempt?: Attempt; detach: () => void;
}
interface Attempt {
  generation: number; abort: AbortController; promise: Promise<Capture | undefined>; stream?: MediaStream;
  tracks?: MediaStreamTrack[]; video?: HTMLVideoElement; detach: (() => void)[]; timer?: number; released: boolean;
}
interface Capture {
  attempt: Attempt; video: HTMLVideoElement; track: MediaStreamTrack; frameRate: number; sequence: number;
  frame?: number; heartbeat?: number; startedAt: number; lastPublished: number;
}
interface Output {
  id: string; principal: string; source: Source; container: HTMLElement; label: string; endpoint: EndpointHandle; route: Connection;
  state: BrowserApplicationMediaStatus['state']; reason?: Reason; frames: number; grant?: RouteGrant;
  request?: AuthorizationRequest; detach?: () => void; abortDetach?: () => void; timer?: number; timerExpiresAt?: number;
  canvas?: HTMLCanvasElement; staging?: HTMLCanvasElement; screen?: CanvasRenderingContext2D; paint?: CanvasRenderingContext2D;
  lastRendered: number; ready: Promise<boolean>; resolveReady: (ready: boolean) => void;
}
const sourceOwners = new WeakMap<HTMLCanvasElement, Source>();
const containerOwners = new WeakMap<HTMLElement, Output>();
class UnsupportedMedia extends Error {}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const resourceId = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return;
    const keys = Reflect.ownKeys(input), result: Record<string, unknown> = Object.create(null);
    if (keys.length > required.length + optional.length || required.some(key => !keys.includes(key))) return;
    for (const key of keys) {
      if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return;
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return;
      result[key] = property.value;
    }
    return result;
  } catch { return; }
}
const no = (reason: Reason): BrowserApplicationMediaBinding => Object.freeze({ ready: Promise.resolve(false),
  status: () => Object.freeze({ state: 'stopped' as const, frames: 0, reason }), renew: () => false, stop() {} });

/**
 * local-application-video/1: two sources, four independently approved outputs per controller.
 * Latest delivery <=30Hz; each SDK backing <=1,048,576 pixels; two unsettled native opens,
 * a 2s opening deadline and 30s capture ceiling. Browser-native buffering remains opaque.
 * Host code/grants are cooperative isolation, never a same-origin sandbox. Source canvases
 * stay borrowed; only SDK-created tracks, videos, output/staging canvases and callbacks retire.
 */
export function createBrowserApplicationMedia(input: BrowserApplicationMediaOptions): BrowserApplicationMedia {
  const options = fields(input, ['applicationId', 'sessionId', 'clockDomain', 'now', 'authorizeSource', 'authorizeSink']);
  if (!options || !identifier(options.applicationId) || !identifier(options.sessionId) || !identifier(options.clockDomain) ||
      typeof options.now !== 'function' || typeof options.authorizeSource !== 'function' || typeof options.authorizeSink !== 'function')
    throw new TypeError('Explicit application, clock and two owner authorizers are required');
  const applicationId = options.applicationId, sessionId = options.sessionId, clockDomain = options.clockDomain;
  const readNow = options.now as () => number, sourceAuthorize = options.authorizeSource as BrowserApplicationMediaOptions['authorizeSource'];
  const sinkAuthorize = options.authorizeSink as BrowserApplicationMediaOptions['authorizeSink'];
  const sources = new Set<Source>(), handles = new WeakMap<BrowserApplicationMediaSource, Source>(), outputs = new Map<string, Output>();
  let closed = false, previousAt = -Infinity, pending = 0;
  function clock(): number {
    if (closed) return NaN;
    let at: number; try { at = readNow(); } catch { close(); return NaN; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER || at < previousAt) { close(); return NaN; }
    previousAt = at; return at;
  }
  function current(output: Output): boolean { return !closed && outputs.get(output.id) === output && output.state !== 'stopped'; }
  function decision(value: unknown, request: BrowserMediaGrantRequest): unknown {
    const copied = fields(value, ['request', 'grant']);
    return copied?.request === request ? copied.grant : undefined;
  }
  function consent(output: Output, request: AuthorizationRequest): RouteGrant | undefined {
    const at = clock(); if (!current(output) || !Number.isFinite(at)) return;
    const base = { applicationId, sessionId, sourceId: output.source.id, outputId: output.id,
      sourceOwnerPrincipalId: output.source.principal, sinkOwnerPrincipalId: output.principal, recipientPrincipalId: output.principal,
      source: Object.freeze({ ...request.source }), sink: Object.freeze({ ...request.sink }), sourceOperation: 'subscribe' as const, sinkOperation: 'write' as const };
    const sourceRequest = Object.freeze({ ...base, role: 'source' as const, ownerPrincipalId: output.source.principal });
    const sinkRequest = Object.freeze({ ...base, role: 'sink' as const, ownerPrincipalId: output.principal });
    let source, sink;
    try {
      source = decision(sourceAuthorize(sourceRequest), sourceRequest); if (!current(output)) return;
      sink = decision(sinkAuthorize(sinkRequest), sinkRequest); if (!current(output)) return;
    } catch { return; }
    const after = clock(); if (!current(output)) return;
    return intersectMediaRouteGrants(source, sink, after);
  }
  function descriptor(id: string, sink = false) {
    return parseDeviceDescriptor({ schemaVersion: 1, id, label: sink ? 'Application video output' : 'Application video source', revision: 1,
      adapter: { id: 'connect:application-media', version: '1.0.0' }, runtime: { platform: 'browser-local' }, capabilities: [{
        id: 'frame-ready', semantic: 'app:decoded-frame-ready/1', schemaVersion: 1, kind: 'sample',
        value: { type: 'scalar', unit: '1', min: 1, max: Number.MAX_SAFE_INTEGER },
        delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 1000 }, permissions: [sink ? 'write' : 'subscribe'],
        ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] });
  }
  const runtime: DeviceRuntime = createDeviceRuntime({ now: clock, clockDomain, maxRoutes: 4, maxSubscribers: 4, maxRegistrations: 6, maxPendingDeliveries: 8,
    authorize(request) {
      const output = [...outputs.values()].find(value => value.endpoint.id === request.sink.registrationId);
      if (!output || !current(output) || request.applicationId !== applicationId || request.sessionId !== sessionId ||
          request.principalId !== output.principal || request.source.registrationId !== output.source.endpoint.id ||
          request.source.deviceId !== output.source.id || request.sink.deviceId !== output.id ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
      const grant = consent(output, request); if (!grant || !current(output)) return;
      output.request = request; output.grant = narrowGrant(output.grant, grant); return output.grant;
    } });
  function clearOutput(output: Output): void {
    try { if (output.canvas) { output.canvas.width = 1; output.canvas.height = 1; output.canvas.remove(); } } catch { /* Only this owned element. */ }
    if (output.staging) { output.staging.width = 1; output.staging.height = 1; }
  }
  function removeOutput(output: Output, reason: Reason): void {
    if (outputs.get(output.id) !== output) return;
    outputs.delete(output.id); output.state = 'stopped'; output.reason = reason; output.resolveReady(false);
    output.source.outputs.delete(output); output.detach?.(); output.abortDetach?.();
    if (output.timer !== undefined) output.source.window.clearTimeout(output.timer);
    if (containerOwners.get(output.container) === output) containerOwners.delete(output.container);
    clearOutput(output); output.route.stop(reason); runtime.unregister(output.endpoint);
    if (!output.source.outputs.size) stopSource(output.source, reason);
  }
  function cleanup(source: Source, attempt: Attempt): void {
    attempt.abort.abort(); if (attempt.timer !== undefined) source.window.clearTimeout(attempt.timer);
    for (const detach of attempt.detach.splice(0)) { try { detach(); } catch { /* Owned subscription. */ } }
    try { attempt.video?.pause(); if (attempt.video) { attempt.video.srcObject = null; attempt.video.remove(); } } catch { /* No visible caller element. */ }
    for (const track of attempt.tracks ?? []) { try { track.stop(); } catch { /* All SDK-owned tracks are retired independently. */ } }
  }
  function stopSource(source: Source, reason: Reason): void {
    const capture = source.capture, attempt = source.attempt;
    source.generation++; source.capture = undefined; source.attempt = undefined;
    if (capture?.frame !== undefined) capture.video.cancelVideoFrameCallback(capture.frame);
    if (capture?.heartbeat !== undefined) source.window.cancelAnimationFrame(capture.heartbeat);
    if (capture) cleanup(source, capture.attempt); if (attempt && attempt !== capture?.attempt) cleanup(source, attempt);
    for (const output of [...source.outputs]) removeOutput(output, reason);
  }
  function close(): void {
    if (closed) return; closed = true;
    for (const source of sources) {
      stopSource(source, 'closed'); source.detach();
      if (sourceOwners.get(source.canvas) === source) sourceOwners.delete(source.canvas);
    }
    sources.clear(); runtime?.close();
  }
  function healthy(source: Source, capture: Capture): boolean {
    return !closed && source.capture === capture && source.generation === capture.attempt.generation &&
      !capture.attempt.abort.signal.aborted && capture.track.readyState === 'live' && !capture.track.muted &&
      source.canvas.width === source.width && source.canvas.height === source.height && !source.canvas.ownerDocument.hidden;
  }
  function narrowGrant(previous: RouteGrant | undefined, next: RouteGrant): RouteGrant {
    return Object.freeze({ expiresAt: Math.min(previous?.expiresAt ?? Infinity, next.expiresAt),
      maxHz: Math.min(previous?.maxHz ?? Infinity, next.maxHz!), maxAgeMs: Math.min(previous?.maxAgeMs ?? Infinity, next.maxAgeMs) });
  }
  function armExpiry(output: Output): boolean {
    const at = clock(); if (!current(output) || !output.grant || !Number.isFinite(at)) return false;
    const active = output.route.status().state === 'active';
    const limits = active ? output.route.limits() : undefined;
    if (!current(output) || active && !limits) return false;
    const expiresAt = Math.min(output.grant.expiresAt, limits?.expiresAt ?? Infinity,
      output.source.capture ? output.source.capture.startedAt + 30000 : Infinity);
    if (at >= expiresAt) { removeOutput(output, 'expired'); return false; }
    if (output.timer !== undefined && output.timerExpiresAt === expiresAt) return true;
    if (output.timer !== undefined) output.source.window.clearTimeout(output.timer);
    output.timer = undefined;
    const timer = output.source.window.setTimeout(() => removeOutput(output, 'expired'), expiresAt - at);
    if (!current(output)) { output.source.window.clearTimeout(timer); return false; }
    output.timer = timer; output.timerExpiresAt = expiresAt; return true;
  }
  function grantCurrent(output: Output): boolean {
    const at = clock(); if (!current(output) || !output.request || !output.grant || at >= output.grant.expiresAt) return false;
    const grant = consent(output, output.request); if (!grant || !current(output)) return false;
    // Fresh decisions may narrow this binding, but cannot extend its original runtime grant.
    output.grant = narrowGrant(output.grant, grant);
    return at < output.grant.expiresAt && armExpiry(output);
  }
  function recent(output: Output, observation: Observation, at: number): boolean {
    return current(output) && !!output.grant && observation.clockDomain === clockDomain &&
      observation.timestamp <= at && at - observation.timestamp <= output.grant.maxAgeMs;
  }
  function renderCurrent(output: Output, capture: Capture, context: DeliveryContext): boolean {
    return current(output) && output.state === 'active' && !context.signal.aborted && context.isCurrent() &&
      grantCurrent(output) && healthy(output.source, capture);
  }
  function render(output: Output, observation: Observation, context: DeliveryContext): void {
    const capture = output.source.capture;
    if (!capture || !renderCurrent(output, capture, context)) { if (current(output)) removeOutput(output, 'denied'); return; }
    const at = clock(); if (!recent(output, observation, at) || at - output.lastRendered < 1000 / output.grant!.maxHz! - 0.01) return;
    try { output.paint!.clearRect(0, 0, output.source.width, output.source.height); output.paint!.drawImage(capture.video, 0, 0, output.source.width, output.source.height); }
    catch { removeOutput(output, 'failed'); return; }
    if (!renderCurrent(output, capture, context)) {
      if (current(output)) removeOutput(output, 'denied'); return;
    }
    if (!recent(output, observation, clock())) return;
    try {
      output.screen!.clearRect(0, 0, output.source.width, output.source.height);
      if (!renderCurrent(output, capture, context)) { if (current(output)) removeOutput(output, 'denied'); return; }
      if (!recent(output, observation, clock())) return;
      output.screen!.drawImage(output.staging!, 0, 0);
    }
    catch { removeOutput(output, 'failed'); return; }
    if (!current(output) || !healthy(output.source, capture) || context.signal.aborted || !context.isCurrent()) {
      if (current(output)) removeOutput(output, 'unavailable'); else clearOutput(output); return;
    }
    const renderedAt = clock(); if (!recent(output, observation, renderedAt)) {
      if (current(output)) removeOutput(output, 'unavailable'); else clearOutput(output); return;
    }
    output.lastRendered = renderedAt; output.frames++;
  }
  function schedule(source: Source, capture: Capture): void {
    const video = capture.video;
    const nextFrame = () => {
      if (!healthy(source, capture)) { if (source.capture === capture) stopSource(source, 'unavailable'); return; }
      capture.frame = video.requestVideoFrameCallback(() => {
        capture.frame = undefined;
        if (!healthy(source, capture)) { if (source.capture === capture) stopSource(source, 'unavailable'); return; }
        const at = clock(); if (!healthy(source, capture)) return;
        if (at - capture.startedAt >= 30000 || capture.sequence >= Number.MAX_SAFE_INTEGER) { stopSource(source, 'expired'); return; }
        if (at - capture.lastPublished >= 1000 / Math.min(30, capture.frameRate) - 0.01) {
          capture.lastPublished = at; const sequence = ++capture.sequence;
          // Timestamp is SDK decoded-frame receipt, never a camera capture-time or synchronization claim.
          runtime.publish(source.endpoint, sequence, { sequence, timestamp: at, clockDomain }); runtime.flush();
        }
        if (healthy(source, capture)) nextFrame();
      });
    };
    const heartbeat = () => {
      capture.heartbeat = undefined;
      if (!healthy(source, capture)) { if (source.capture === capture) stopSource(source, 'unavailable'); return; }
      const at = clock(); if (!healthy(source, capture)) return;
      if (at - capture.startedAt >= 30000) { stopSource(source, 'expired'); return; }
      runtime.flush(); if (healthy(source, capture)) capture.heartbeat = source.window.requestAnimationFrame(heartbeat);
    };
    nextFrame(); if (healthy(source, capture)) capture.heartbeat = source.window.requestAnimationFrame(heartbeat);
  }
  async function open(source: Source, attempt: Attempt, requestedHz: number): Promise<Capture | undefined> {
    const owned = () => !closed && source.attempt === attempt && source.generation === attempt.generation && source.outputs.size > 0 && !attempt.abort.signal.aborted;
    let hasPlay = false;
    const release = () => { if (!attempt.released) { attempt.released = true; pending--; } };
    try {
      const stream = source.canvas.captureStream(requestedHz); attempt.stream = stream; attempt.tracks = stream.getTracks();
      if (!owned()) { cleanup(source, attempt); release(); return; }
      if (!(stream instanceof source.window.MediaStream) || attempt.tracks.length !== 1 ||
          !(attempt.tracks[0] instanceof source.window.MediaStreamTrack) || attempt.tracks[0].kind !== 'video' || attempt.tracks[0].readyState !== 'live')
        throw new UnsupportedMedia('Unsupported application video producer');
      const video = source.canvas.ownerDocument.createElement('video'); attempt.video = video;
      if (typeof video.requestVideoFrameCallback !== 'function' || typeof video.cancelVideoFrameCallback !== 'function') throw new UnsupportedMedia('Unsupported native decoded frames');
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      const track = attempt.tracks[0];
      const ended = () => { if (source.attempt === attempt || source.capture?.attempt === attempt) stopSource(source, 'unavailable'); };
      for (const name of ['ended', 'mute']) { track.addEventListener(name, ended); attempt.detach.push(() => track.removeEventListener(name, ended)); }
      if (!owned()) { cleanup(source, attempt); release(); return; }
      const playing = Promise.resolve(video.play()); hasPlay = true;
      void playing.then(release, release);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        attempt.abort.signal.addEventListener('abort', abort, { once: true });
        attempt.detach.push(() => attempt.abort.signal.removeEventListener('abort', abort));
        attempt.timer = source.window.setTimeout(() => reject(new Error('open-deadline')), 2000);
        playing.then(resolve, reject);
        if (attempt.abort.signal.aborted) abort();
      });
      if (!owned()) { cleanup(source, attempt); return; }
      if (attempt.timer !== undefined) source.window.clearTimeout(attempt.timer);
      const settings = track.getSettings();
      if (track.readyState !== 'live' || track.muted || settings.width !== source.width || settings.height !== source.height ||
          typeof settings.frameRate !== 'number' || !Number.isFinite(settings.frameRate) || settings.frameRate < 1 || settings.frameRate > requestedHz ||
          video.videoWidth !== source.width || video.videoHeight !== source.height) throw new UnsupportedMedia('Missing or incompatible native format');
      const capture: Capture = { attempt, video, track, frameRate: settings.frameRate, sequence: 0, startedAt: clock(), lastPublished: -Infinity };
      if (!owned()) { cleanup(source, attempt); return; }
      source.capture = capture; source.attempt = undefined; schedule(source, capture); return capture;
    } catch (error) {
      if (source.attempt === attempt) stopSource(source, error instanceof UnsupportedMedia ? 'unsupported' : 'failed'); else cleanup(source, attempt);
      return;
    } finally { if (!hasPlay) release(); }
  }
  function captureFor(output: Output): Promise<Capture | undefined> {
    const source = output.source;
    if (source.capture) return Promise.resolve(source.capture);
    if (source.attempt) return source.attempt.promise;
    if (pending >= 2) { removeOutput(output, 'capacity'); return Promise.resolve(undefined); }
    pending++;
    const attempt: Attempt = { generation: ++source.generation, abort: new AbortController(), detach: [], released: false, promise: Promise.resolve(undefined) };
    source.attempt = attempt; attempt.promise = open(source, attempt, Math.min(source.maxHz, output.grant!.maxHz!)); return attempt.promise;
  }
  function compatible(output: Output, capture: Capture): boolean {
    const source = output.source, geometry = { widthPx: source.width, heightPx: source.height, pixelRatio: 1 };
    const video = { widthPx: { min: source.width, max: source.width }, heightPx: { min: source.height, max: source.height }, frameRateHz: { min: 1, max: source.maxHz } };
    const manifest = parseMediaManifest({ schemaVersion: 1, id: 'media:local-application-video',
      tracks: [{ type: 'track', id: source.id, media: 'video', direction: 'capture', codecs: ['video/raw'], video }],
      renderTargets: [{ type: 'render-target', id: output.id, media: 'video', geometry }] });
    return planMediaBinding(manifest, source.id, output.id, {
      source: { resourceId: source.id, registrationId: source.endpoint.id, state: 'available', codecs: ['video/raw'],
        video: { widthPx: source.width, heightPx: source.height, frameRateHz: capture.frameRate } },
      target: { resourceId: output.id, registrationId: output.endpoint.id, state: 'available', codecs: ['video/raw'], geometry } }).ok;
  }
  async function activate(output: Output): Promise<void> {
    const capture = await captureFor(output);
    if (!current(output)) return;
    if (!capture || !healthy(output.source, capture) || !compatible(output, capture)) { removeOutput(output, 'unsupported'); return; }
    if (!grantCurrent(output)) { if (current(output)) removeOutput(output, 'denied'); return; }
    if (!output.route.activate().ok || !current(output) || !grantCurrent(output)) { if (current(output)) removeOutput(output, 'denied'); return; }
    const document = output.container.ownerDocument;
    const canvas = document.createElement('canvas'); output.canvas = canvas;
    if (!current(output)) { clearOutput(output); return; }
    const staging = document.createElement('canvas'); output.staging = staging;
    if (!current(output)) { clearOutput(output); return; }
    canvas.width = staging.width = output.source.width; canvas.height = staging.height = output.source.height;
    output.screen = canvas.getContext('2d') ?? undefined; output.paint = staging.getContext('2d') ?? undefined;
    if (!current(output)) { clearOutput(output); return; }
    if (!output.screen || !output.paint) { removeOutput(output, 'unsupported'); return; }
    if (!grantCurrent(output)) { if (current(output)) removeOutput(output, 'denied'); return; }
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', output.label);
    canvas.style.maxWidth = '100%'; canvas.style.height = 'auto'; canvas.style.display = 'block';
    output.state = 'active'; output.container.appendChild(canvas);
    if (!current(output) || !healthy(output.source, capture) || !grantCurrent(output)) { clearOutput(output); if (current(output)) removeOutput(output, 'denied'); return; }
    output.resolveReady(true);
  }
  return Object.freeze({
    registerSource(input: BrowserApplicationMediaSourceOptions): BrowserApplicationMediaSource | undefined {
      const at = clock(); if (closed || !Number.isFinite(at) || sources.size >= 2) return;
      const value = fields(input, ['sourceId', 'ownerPrincipalId', 'canvas', 'maxHz']);
      if (!value || !resourceId(value.sourceId) || !identifier(value.ownerPrincipalId) || typeof value.maxHz !== 'number' ||
          !Number.isFinite(value.maxHz) || value.maxHz < 1 || value.maxHz > 30 || typeof HTMLCanvasElement !== 'function' || !(value.canvas instanceof HTMLCanvasElement)) return;
      const canvas = value.canvas, window = canvas.ownerDocument.defaultView as BrowserWindow | null;
      if (!window || canvas.ownerDocument.hidden || typeof canvas.captureStream !== 'function' || sourceOwners.has(canvas) ||
          canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 1048576 || [...sources].some(source => source.id === value.sourceId)) return;
      const endpoint = runtime.registerSource({ device: descriptor(value.sourceId), capability: 'frame-ready' });
      runtime.setReadiness(endpoint, 'available');
      const handle = Object.freeze({ id: value.sourceId });
      const source: Source = { handle, id: value.sourceId, principal: value.ownerPrincipalId, canvas, window,
        width: canvas.width, height: canvas.height, maxHz: value.maxHz, endpoint, generation: 0, outputs: new Set(), detach: () => {} };
      sources.add(source); handles.set(handle, source); sourceOwners.set(canvas, source);
      const hidden = () => { if (canvas.ownerDocument.hidden) stopSource(source, 'unavailable'); };
      canvas.ownerDocument.addEventListener('visibilitychange', hidden); source.detach = () => canvas.ownerDocument.removeEventListener('visibilitychange', hidden);
      if (closed || !sources.has(source)) source.detach();
      return !closed && sources.has(source) ? handle : undefined;
    },
    bind(input: BrowserApplicationMediaBindOptions): BrowserApplicationMediaBinding {
      const at = clock(); if (closed || !Number.isFinite(at)) return no('closed');
      const value = fields(input, ['source', 'outputId', 'ownerPrincipalId', 'container', 'label'], ['signal']);
      const source = value && typeof value.source === 'object' && value.source ? handles.get(value.source as BrowserApplicationMediaSource) : undefined;
      if (!value || !source || !sources.has(source) || !resourceId(value.outputId) || value.outputId === source.id || !identifier(value.ownerPrincipalId) ||
          typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 256 ||
          !(value.container instanceof source.window.HTMLElement) || value.container.ownerDocument !== source.canvas.ownerDocument ||
          value.container === source.canvas || (value.signal !== undefined && !(value.signal instanceof source.window.AbortSignal))) return no('invalid');
      if (value.signal instanceof source.window.AbortSignal && value.signal.aborted) return no('cancelled');
      if (outputs.has(value.outputId) || outputs.size >= 4 || containerOwners.has(value.container)) return no('capacity');
      const endpoint = runtime.registerSink({ device: descriptor(value.outputId, true), capability: 'frame-ready',
        apply: (observation, context) => render(output, observation, context), release: () => { if (current(output)) removeOutput(output, 'unavailable'); } });
      runtime.setReadiness(endpoint, 'available');
      const route = runtime.route({ from: source.endpoint, to: endpoint, principalId: value.ownerPrincipalId, applicationId, sessionId, queueCapacity: 1, leaseMs: 30000 });
      let resolveReady!: (ready: boolean) => void;
      const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
      const output: Output = { id: value.outputId, principal: value.ownerPrincipalId, source, container: value.container, label: value.label, endpoint, route,
        state: 'opening', frames: 0, ready, resolveReady, lastRendered: -Infinity };
      outputs.set(output.id, output); source.outputs.add(output); containerOwners.set(output.container, output);
      const handle: BrowserApplicationMediaBinding = Object.freeze({ ready, status: () => Object.freeze({ state: output.state, frames: output.frames,
        ...(output.grant ? { expiresAt: output.grant.expiresAt } : {}), ...(output.reason ? { reason: output.reason } : {}) }),
        renew() { if (!current(output) || output.state !== 'active' || !grantCurrent(output) || !route.renew(output.principal).ok || !current(output) || !armExpiry(output)) { if (current(output)) removeOutput(output, 'denied'); return false; } return true; },
        stop: () => removeOutput(output, 'cancelled') });
      output.detach = route.onClose(() => { if (current(output)) removeOutput(output, 'unavailable'); });
      if (!current(output)) output.detach();
      if (value.signal instanceof source.window.AbortSignal) {
        const signal = value.signal, abort = () => removeOutput(output, 'cancelled');
        signal.addEventListener('abort', abort, { once: true }); output.abortDetach = () => signal.removeEventListener('abort', abort);
        if (!current(output)) output.abortDetach();
        if (signal.aborted) abort();
      }
      if (!current(output) || !route.prepare().ok || !current(output) || !output.grant) { if (current(output)) removeOutput(output, 'denied'); return handle; }
      if (!armExpiry(output)) { if (current(output)) removeOutput(output, 'expired'); return handle; }
      void activate(output).catch(() => { if (current(output)) removeOutput(output, 'failed'); });
      return handle;
    },
    revokeSource(handle: BrowserApplicationMediaSource): number { const source = handles.get(handle); if (!source || closed) return 0; const count = source.outputs.size; stopSource(source, 'denied'); return count; },
    revokeOutput(id: string): boolean { const output = outputs.get(id); if (!output) return false; removeOutput(output, 'denied'); return true; },
    status() { clock(); return Object.freeze({ closed, sources: sources.size, outputs: outputs.size,
      captures: [...sources].filter(source => source.capture !== undefined).length, pending }); },
    close,
  });
}
