import { parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import { intersectMediaRouteGrants } from '@101/device-runtime';
import type { Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation, ResourceReference, RouteGrant } from '@101/device-runtime';

export const BROWSER_APPLICATION_AUDIO_LIMITS = Object.freeze({ sources: 1, outputs: 2, attempts: 64, rawPending: 1,
  lifetimeMs: 30000, openMs: 5000, maxHz: 20, maxAgeMs: 250, polls: 600, samples: 256, sampleRateHz: 48000, channels: 2,
  registrations: 4, routes: 2, latest: 1, ownerSignalsPerOutput: 8, listeners: 32, pollTimers: 1, expiryTimers: 1 });
type Failure = 'invalid' | 'denied' | 'unsupported' | 'unavailable' | 'busy' | 'capacity' | 'quota' | 'cancelled' | 'expired' | 'lost' | 'hidden' | 'unfocused' | 'failed' | 'closed' | 'stopped';
export interface BrowserApplicationAudioOwnerRequest {
  readonly role: 'source' | 'output'; readonly operation: 'route-private-audio';
  readonly ownerPrincipalId: string; readonly recipientPrincipalId: string; readonly sourceOwnerPrincipalId: string;
  readonly applicationId: string; readonly sessionId: string; readonly sourceId: string; readonly outputId: string; readonly purpose: string;
  readonly sourceGeneration: number; readonly source: Readonly<ResourceReference>; readonly sink: Readonly<ResourceReference>;
  readonly sourceOperation: 'subscribe'; readonly sinkOperation: 'write';
  readonly format: Readonly<{ kind: 'native-private-stream'; sampleRateHz: 48000; channels: 2 }>;
}
/** Only the exact issued request and genuine current AbortSignal establish this audio owner decision. */
export interface BrowserApplicationAudioOwnerGrant { readonly request: BrowserApplicationAudioOwnerRequest; readonly signal: AbortSignal; readonly grant: RouteGrant }
export interface BrowserApplicationAudioSource { readonly browserApplicationAudioSource?: never }
export interface BrowserApplicationAudioSourceOptions { readonly sourceId: string; readonly ownerPrincipalId: string; readonly producerNode: MediaStreamAudioDestinationNode; readonly stream: MediaStream }
export interface BrowserApplicationAudioBindOptions {
  readonly source: BrowserApplicationAudioSource; readonly outputId: string; readonly ownerPrincipalId: string; readonly purpose: string; readonly signal: AbortSignal;
}
/** Explicit trusted same-realm software seam. Native-shaped doubles do not qualify audio.
 * Owned browser fixture streams are digital application producers, never microphone hardware. */
export interface BrowserApplicationAudioEnvironment {
  readonly fixtureKind: 'owned-application-audio' | 'software-fixture';
  readonly createAudioContext: () => AudioContext; readonly createMediaStream: (tracks: MediaStreamTrack[]) => MediaStream;
  readonly AudioContext: typeof AudioContext; readonly MediaStream: typeof MediaStream; readonly MediaStreamTrack: typeof MediaStreamTrack; readonly MediaStreamAudioDestinationNode: typeof MediaStreamAudioDestinationNode;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly hidden: () => boolean; readonly focused: () => boolean;
}
export interface BrowserApplicationAudioOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal; readonly applicationId: string; readonly sessionId: string; readonly now: () => number;
  readonly authorizeSource: (request: BrowserApplicationAudioOwnerRequest) => BrowserApplicationAudioOwnerGrant | undefined;
  readonly authorizeOutput: (request: BrowserApplicationAudioOwnerRequest) => BrowserApplicationAudioOwnerGrant | undefined;
  readonly environment?: BrowserApplicationAudioEnvironment;
}
export interface BrowserApplicationAudioStatus {
  readonly state: 'opening' | 'active' | 'stopped'; readonly reason?: Failure; readonly generation: number;
  readonly expiresAt?: number; readonly volume: number; readonly muted: boolean;
}
export interface BrowserApplicationAudioBinding {
  readonly ready: Promise<boolean>; status(): Readonly<BrowserApplicationAudioStatus>;
  /** Current approved private stream only; the caller must retain its independent output consumer lifecycle. */
  output(): MediaStream | undefined;
  setVolume(value: number): boolean; setMuted(value: boolean): boolean;
  /** Fresh decisions may narrow, never extend, this opening's deadline. */
  renew(): boolean; stop(): void;
}
export interface BrowserApplicationAudioControllerStatus {
  readonly closed: boolean; readonly sources: number; readonly activeOutputs: number; readonly openingOutputs: number;
  readonly rawPending: number; readonly cleanupPending: number; readonly cleanupFailures: number; readonly attempts: number;
  readonly listeners: number; readonly polls: number; readonly pollArmed: boolean; readonly expiryArmed: boolean;
}
export interface BrowserApplicationAudio {
  registerSource(options: BrowserApplicationAudioSourceOptions): BrowserApplicationAudioSource | undefined;
  resources(source: BrowserApplicationAudioSource): Readonly<{ device: DeviceDescriptor; audio: EndpointHandle; levels: EndpointHandle }> | undefined;
  bind(options: BrowserApplicationAudioBindOptions): BrowserApplicationAudioBinding;
  revokeSource(source: BrowserApplicationAudioSource): boolean; revokeOutput(outputId: string): boolean;
  sweep(): void; snapshot(): Readonly<BrowserApplicationAudioControllerStatus>; close(): Promise<void>;
}
interface Source {
  handle: BrowserApplicationAudioSource; id: string; principal: string; producerNode: MediaStreamAudioDestinationNode; producerContext: AudioContext; stream: MediaStream; track: MediaStreamTrack; generation: number;
  device: DeviceDescriptor; audio?: EndpointHandle; levels?: EndpointHandle; alive: boolean; capture?: Capture;
}
interface Capture {
  source: Source; sourceGeneration: number; generation: number; startedAt: number; deadline: number; retired: boolean; setupDone: boolean; cleanupDone: boolean;
  ready: boolean; stream?: MediaStream; clone?: MediaStreamTrack; context?: AudioContext; node?: MediaStreamAudioSourceNode; analyser?: AnalyserNode;
  detach: (() => void)[]; closedContext: boolean; stoppedTracks: Set<MediaStreamTrack>; disconnected: Set<AudioNode>; polls: number; sequence: number;
}
interface Output {
  id: string; principal: string; purpose: string; signal: AbortSignal; source: Source; generation: number;
  state: BrowserApplicationAudioStatus['state']; reason?: Failure; endpoint?: EndpointHandle; route?: Connection; routeDetach?: () => void;
  sourceRequest?: BrowserApplicationAudioOwnerRequest; outputRequest?: BrowserApplicationAudioOwnerRequest;
  signals: AbortSignal[]; grant?: Readonly<RouteGrant>; deadline: number; openingDeadline: number; capture?: Capture;
  node?: MediaStreamAudioDestinationNode; gain?: GainNode; tracks: MediaStreamTrack[]; connected: boolean; edgeAttempted: boolean; context?: DeliveryContext;
  detach: (() => void)[]; volume: number; muted: boolean; ready: Promise<boolean>; resolve: (value: boolean) => void;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const resourceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 112;
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return;
    const keys = Reflect.ownKeys(input), result: Record<string, unknown> = Object.create(null);
    if (keys.length > required.length + optional.length || required.some(key => !keys.includes(key))) return;
    for (const key of keys) {
      if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return; }
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function signal(value: unknown): value is AbortSignal { try { abortedGetter.call(value); return true; } catch { return false; } }
function aborted(value: AbortSignal): boolean { return abortedGetter.call(value) as boolean; }
const no = (reason: Failure): BrowserApplicationAudioBinding => Object.freeze({ ready: Promise.resolve(false),
  status: () => Object.freeze({ state: 'stopped' as const, reason, generation: 0, volume: 1, muted: false }),
  output: () => undefined, setVolume: () => false, setMuted: () => false, renew: () => false, stop() {} });
const fixed = (unit: string, value: number) => ({ type: 'scalar', unit, min: value, max: value });
function descriptor(sourceId: string, output = false): DeviceDescriptor {
  const audio = { id: 'audio', semantic: 'app:private-audio-gate/1', schemaVersion: 1, kind: 'sample',
    value: { type: 'record', fields: { running: { type: 'boolean' }, generation: { type: 'scalar', unit: '1', min: 1, max: Number.MAX_SAFE_INTEGER }, sampleRateHz: fixed('Hz', 48000), channels: fixed('1', 2) } },
    delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: [output ? 'write' : 'subscribe'], ...(output ? { ownership: { mode: 'exclusive' } } : {}) };
  return parseDeviceDescriptor({ schemaVersion: 1, id: sourceId, label: output ? 'Private application audio output' : 'Application audio source', revision: 1,
    adapter: { id: 'connect:application-audio', version: '1.0.0' }, runtime: { platform: 'browser-local' }, capabilities: output ? [audio] : [audio, {
      id: 'levels', semantic: 'app:audio-envelope/1', schemaVersion: 1, kind: 'sample', value: { type: 'record', fields: {
        rms: { type: 'scalar', unit: '1', min: 0, max: 1 }, peak: { type: 'scalar', unit: '1', min: 0, max: 1 }, sampleCount: fixed('1', 256), sampleRateHz: fixed('Hz', 48000) } },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['subscribe'] }] });
}
function environment(): BrowserApplicationAudioEnvironment | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof AudioContext === 'undefined' || typeof MediaStream === 'undefined' || typeof MediaStreamTrack === 'undefined' || typeof MediaStreamAudioDestinationNode === 'undefined') return;
  return { fixtureKind: 'owned-application-audio', createAudioContext: () => new AudioContext({ sampleRate: 48000 }), createMediaStream: tracks => new MediaStream(tracks),
    AudioContext, MediaStream, MediaStreamTrack, MediaStreamAudioDestinationNode, target: window, document, hidden: () => document.hidden, focused: () => document.hasFocus() };
}

/** Selected native-private-stream/1, exactly 48kHz/two-channel native destination-node graph configuration.
 * Missing emitted-track PCM channel metadata stays unknown; no PCM channel proof. This is a local native graph,
 * not an encoded PCM transport or a capture/codec/hardware qualification. Construction
 * is inert. Borrowed application tracks/producer contexts remain owned by the caller.
 * One owned routing-context lifecycle reservation survives resume AND close settlement.
 * Host wrappers/code are trusted: cleanup failures stay explicit, never a sandbox claim. */
export function createBrowserApplicationAudio(input: BrowserApplicationAudioOptions): BrowserApplicationAudio {
  const options = fields(input, ['runtime', 'ownerSignal', 'applicationId', 'sessionId', 'now', 'authorizeSource', 'authorizeOutput'], ['environment']);
  if (!options || !options.runtime || typeof options.runtime !== 'object' || !signal(options.ownerSignal) || !id(options.applicationId) || !id(options.sessionId) ||
      typeof options.now !== 'function' || typeof options.authorizeSource !== 'function' || typeof options.authorizeOutput !== 'function') throw new TypeError('Explicit runtime and audio owner approvals required');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, applicationId = options.applicationId, sessionId = options.sessionId;
  const readNow = options.now as () => number, sourceAuthorize = options.authorizeSource as BrowserApplicationAudioOptions['authorizeSource'], outputAuthorize = options.authorizeOutput as BrowserApplicationAudioOptions['authorizeOutput'];
  const supplied = options.environment === undefined ? environment() : options.environment;
  const copiedEnvironment = supplied === undefined ? undefined : fields(supplied, ['fixtureKind', 'createAudioContext', 'createMediaStream', 'AudioContext', 'MediaStream', 'MediaStreamTrack', 'MediaStreamAudioDestinationNode', 'target', 'document', 'hidden', 'focused']);
  if (supplied !== undefined && (!copiedEnvironment || !['owned-application-audio', 'software-fixture'].includes(copiedEnvironment.fixtureKind as string) ||
      !['createAudioContext', 'createMediaStream', 'AudioContext', 'MediaStream', 'MediaStreamTrack', 'MediaStreamAudioDestinationNode', 'hidden', 'focused'].every(key => typeof copiedEnvironment[key] === 'function'))) throw new TypeError('Explicit cooperative native realm required');
  const env = copiedEnvironment ? Object.freeze({ ...copiedEnvironment }) as unknown as BrowserApplicationAudioEnvironment : undefined;
  const sources = new Set<Source>(), handles = new WeakMap<BrowserApplicationAudioSource, Source>(), outputs = new Map<string, Output>(), captures = new Set<Capture>();
  const nativeTasks = new Set<Promise<void>>(), globalDetach: (() => void)[] = [], samples = new Float32Array(256);
  let closed = false, revision = 0, generation = 0, captureEpoch = 0, previousAt = -Infinity, attempts = 0, registering = false, setupPending = false, cleanupFailures = 0, listeners = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined, lastPoll = -Infinity;
  function basic(output: Output): boolean { return !closed && output.state !== 'stopped' && outputs.get(output.id) === output && output.source.alive && sources.has(output.source); }
  function rawPending(): boolean { return setupPending || [...captures].some(c => !c.setupDone || c.retired && !c.cleanupDone); }
  function clock(): number {
    if (closed) return NaN;
    if (aborted(owner)) { shutdown('denied'); return NaN; }
    let at: number; try { at = readNow(); } catch { shutdown('invalid'); return NaN; }
    if (closed) return NaN;
    if (aborted(owner)) { shutdown('denied'); return NaN; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER || at < previousAt) { shutdown('invalid'); return NaN; }
    previousAt = at; return at;
  }
  function visibility(): boolean {
    if (!env) return false;
    const pin = revision; let visible = false;
    try { visible = !env.hidden() && env.focused(); } catch { shutdown('invalid'); }
    return !closed && pin === revision && visible;
  }
  function current(output: Output, at = clock()): boolean {
    if (!basic(output) || !Number.isFinite(at) || aborted(owner) || aborted(output.signal) || output.signals.some(aborted)) return false;
    if (!sourceFacts(output.source) || !basic(output)) return false;
    if (output.state === 'active' && !outputFacts(output)) return false;
    return at < output.deadline && (output.state !== 'opening' || at < output.openingDeadline) && (!output.grant || at < output.grant.expiresAt);
  }
  function nativeCurrent(capture: Capture): boolean {
    return !closed && !capture.retired && capture.source.alive && capture.source.capture === capture && capture.source.generation === capture.sourceGeneration;
  }
  function finish(capture: Capture): void { if (capture.retired && capture.setupDone && capture.cleanupDone) captures.delete(capture); }
  function trackTask(promise: Promise<void>): void { nativeTasks.add(promise); void promise.finally(() => { nativeTasks.delete(promise); }); }
  function detachAll(list: (() => void)[]): void { for (const remove of list.splice(0)) try { remove(); } catch { cleanupFailures++; } }
  function listen(list: (() => void)[], target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, type: string, callback: EventListener, check: () => boolean, intrinsic = false): void {
    let installed = true;
    const remove = (force = false) => {
      if (!installed && !force) return;
      if (installed) { installed = false; listeners--; }
      try { if (intrinsic) EventTarget.prototype.removeEventListener.call(target, type, callback); else target.removeEventListener(type, callback); } catch { cleanupFailures++; }
    };
    // Reserve exact removal before a wrapper may install, call back, or throw.
    listeners++; list.push(remove);
    try { if (intrinsic) EventTarget.prototype.addEventListener.call(target, type, callback); else target.addEventListener(type, callback); }
    catch { remove(true); throw new Error('Owned listener installation failed'); }
    // A wrapper may retire first, then install before returning: remove again.
    if (!check()) remove(true);
  }
  function stopTrack(capture: Capture, track: MediaStreamTrack): void {
    if (capture.stoppedTracks.has(track)) return; capture.stoppedTracks.add(track);
    try { track.stop(); } catch { cleanupFailures++; }
  }
  function disconnect(capture: Capture, node: AudioNode | undefined, force = false): void {
    if (!node || !force && capture.disconnected.has(node)) return; capture.disconnected.add(node);
    try { node.disconnect(); } catch { cleanupFailures++; }
  }
  function retireCapture(capture: Capture): void {
    capture.retired = true; capture.ready = false;
    if (capture.source.capture === capture) capture.source.capture = undefined;
    detachAll(capture.detach); disconnect(capture, capture.node, true); disconnect(capture, capture.analyser, true);
    if (capture.clone) stopTrack(capture, capture.clone);
    if (capture.context && !capture.closedContext) {
      capture.closedContext = true; capture.cleanupDone = false;
      let returned: Promise<void>;
      try { returned = capture.context.close(); }
      catch { cleanupFailures++; capture.cleanupDone = true; finish(capture); return; }
      const cleanup = Promise.resolve(returned).then(() => { capture.cleanupDone = true; finish(capture); }, () => { cleanupFailures++; capture.cleanupDone = true; finish(capture); });
      trackTask(cleanup);
    } else if (!capture.context) capture.cleanupDone = true;
    finish(capture);
  }
  function clearTimers(): void { if (pollTimer !== undefined) clearTimeout(pollTimer); if (expiryTimer !== undefined) clearTimeout(expiryTimer); pollTimer = undefined; expiryTimer = undefined; }
  function retireOutput(output: Output, reason: Failure, afterNativeCall = false): void {
    if (output.state === 'stopped') {
      if (!afterNativeCall) return;
      const capture = output.capture;
      if (capture) {
        if (output.edgeAttempted && output.gain && !capture.retired) try { capture.node?.disconnect(output.gain); } catch { cleanupFailures++; }
        disconnect(capture, output.gain, true); disconnect(capture, output.node, true);
        if (output.node && !output.tracks.length) try { output.tracks = output.node.stream.getTracks(); } catch { cleanupFailures++; }
        for (const track of output.tracks) stopTrack(capture, track);
        if (capture.retired) retireCapture(capture);
      }
      return;
    }
    output.state = 'stopped'; output.reason = reason; outputs.delete(output.id); output.context = undefined; output.resolve(false);
    detachAll(output.detach); output.routeDetach?.(); output.routeDetach = undefined;
    const capture = output.capture;
    if (capture && output.connected && output.gain) {
      output.connected = false; try { capture.node?.disconnect(output.gain); } catch { cleanupFailures++; }
    }
    if (capture) {
      disconnect(capture, output.gain); disconnect(capture, output.node);
      for (const track of output.tracks) stopTrack(capture, track);
    } else for (const track of output.tracks) try { track.stop(); } catch { cleanupFailures++; }
    output.route?.stop(reason); if (output.endpoint) runtime.unregister(output.endpoint);
    if (capture && ![...outputs.values()].some(o => o.capture === capture)) {
      retireCapture(capture);
      if (capture.source.audio) runtime.setReadiness(capture.source.audio, sourceFacts(capture.source) ? 'available' : 'unavailable');
      if (capture.source.levels) runtime.setReadiness(capture.source.levels, 'unavailable');
    }
    arm();
  }
  function removeSource(source: Source, reason: Failure): void {
    if (!source.alive) return; source.alive = false; sources.delete(source);
    for (const output of [...outputs.values()]) if (output.source === source) retireOutput(output, reason);
    if (source.capture) retireCapture(source.capture);
    if (source.audio) runtime.unregister(source.audio); if (source.levels) runtime.unregister(source.levels);
  }
  function shutdown(reason: Failure): void {
    if (closed) return; closed = true; revision++; clearTimers(); detachAll(globalDetach);
    for (const source of [...sources]) removeSource(source, reason);
    for (const capture of captures) retireCapture(capture);
  }
  function lifecycle(): void {
    if (!env || globalDetach.length) return;
    const pin = revision, valid = () => !closed && revision === pin;
    listen(globalDetach, owner, 'abort', () => shutdown('denied'), valid, true);
    if (!valid()) return;
    listen(globalDetach, env.target, 'blur', () => { for (const o of [...outputs.values()]) retireOutput(o, 'unfocused'); }, valid);
    if (!valid()) return;
    listen(globalDetach, env.target, 'pagehide', () => { for (const o of [...outputs.values()]) retireOutput(o, 'hidden'); }, valid);
    if (!valid()) return;
    listen(globalDetach, env.document, 'visibilitychange', () => { if (!visibility()) for (const o of [...outputs.values()]) retireOutput(o, 'hidden'); }, valid);
  }
  function nativeTrack(track: unknown): track is MediaStreamTrack {
    if (!env || !(track instanceof env.MediaStreamTrack)) return false;
    if (track.kind !== 'audio' || track.readyState !== 'live' || track.muted) return false;
    const settings = track.getSettings();
    return (settings.sampleRate === undefined || settings.sampleRate === 48000) && (settings.channelCount === undefined || settings.channelCount === 2);
  }
  function sourceFacts(source: Source): boolean {
    if (!source.alive || !env) return false;
    if (aborted(owner)) { shutdown('denied'); return false; }
    try {
      const tracks = source.stream.getTracks();
      const valid = source.producerNode instanceof env.MediaStreamAudioDestinationNode && source.producerNode.context === source.producerContext &&
        source.producerContext instanceof env.AudioContext && source.producerContext.state === 'running' && source.producerContext.sampleRate === 48000 &&
        source.producerNode.channelCount === 2 && source.producerNode.stream === source.stream && tracks.length === 1 && tracks[0] === source.track && nativeTrack(source.track);
      if (aborted(owner)) { shutdown('denied'); return false; }
      return valid && source.alive && !closed;
    } catch { return false; }
  }
  function narrowed(old: Readonly<RouteGrant> | undefined, next: RouteGrant): Readonly<RouteGrant> {
    return Object.freeze({ expiresAt: Math.min(old?.expiresAt ?? Infinity, next.expiresAt), maxAgeMs: Math.min(old?.maxAgeMs ?? 250, next.maxAgeMs, 250), maxHz: Math.min(old?.maxHz ?? 20, next.maxHz ?? 20, 20) });
  }
  function ownerDecision(value: unknown, request: BrowserApplicationAudioOwnerRequest): { signal: AbortSignal; grant: RouteGrant } | undefined {
    const copied = fields(value, ['request', 'signal', 'grant']);
    if (!copied || copied.request !== request || !signal(copied.signal) || aborted(copied.signal)) return;
    const at = clock(); const grant = intersectMediaRouteGrants(copied.grant, copied.grant, at);
    if (grant && !closed && !aborted(copied.signal)) return { signal: copied.signal, grant };
  }
  function consent(output: Output): boolean {
    if (!output.sourceRequest || !output.outputRequest || !current(output)) return false;
    let source, sink;
    try {
      source = ownerDecision(sourceAuthorize(output.sourceRequest), output.sourceRequest); if (!current(output) || !source) return false;
      sink = ownerDecision(outputAuthorize(output.outputRequest), output.outputRequest); if (!current(output) || !sink) return false;
    } catch { return false; }
    const at = clock(); if (!current(output, at) || aborted(source.signal) || aborted(sink.signal)) return false;
    const grant = intersectMediaRouteGrants(source.grant, sink.grant, at); if (!grant) return false;
    output.grant = narrowed(output.grant, grant); output.deadline = Math.min(output.deadline, output.grant.expiresAt);
    for (const currentSignal of [source.signal, sink.signal]) {
      if (output.signals.includes(currentSignal)) continue;
      if (output.signals.length >= 8) return false;
      output.signals.push(currentSignal); listen(output.detach, currentSignal, 'abort', () => retireOutput(output, 'denied'), () => basic(output), true);
      if (!current(output)) return false;
    }
    return current(output);
  }
  function healthy(capture: Capture): boolean {
    if (!nativeCurrent(capture) || !capture.ready || !capture.context || !capture.clone) return false;
    const valid = capture.context.state === 'running' && capture.context.sampleRate === 48000 && nativeTrack(capture.clone) && sourceFacts(capture.source);
    return valid && nativeCurrent(capture);
  }
  function outputFacts(output: Output): boolean {
    const capture = output.capture, node = output.node;
    if (!capture || !node || !env) return false;
    try {
      const tracks = node.stream.getTracks();
      return node instanceof env.MediaStreamAudioDestinationNode && node.context === capture.context && node.context.sampleRate === 48000 && node.channelCount === 2 &&
        tracks.length === 1 && tracks[0] === output.tracks[0] && nativeTrack(tracks[0]) && basic(output) && nativeCurrent(capture);
    } catch { return false; }
  }
  function grantCurrent(output: Output): boolean {
    if (!current(output) || !output.route || output.route.status().state !== 'active') return false;
    const limits = output.route.limits(); if (!limits || !current(output)) return false;
    output.deadline = Math.min(output.deadline, limits.expiresAt);
    return current(output);
  }
  function apply(output: Output, observation: Observation, delivery: DeliveryContext): void {
    const capture = output.capture, value = fields(observation.value, ['running', 'generation', 'sampleRateHz', 'channels']);
    if (!capture || !value || value.running !== true || value.generation !== capture.generation || value.sampleRateHz !== 48000 || value.channels !== 2 ||
        observation.source.registrationId !== output.source.audio?.id || observation.source.capabilityId !== 'audio' || observation.clockDomain !== runtime.clockDomain ||
        !current(output) || !healthy(capture) || !outputFacts(output) || !grantCurrent(output) || !delivery.isCurrent() || aborted(delivery.signal) || !visibility()) return;
    if (!current(output) || !nativeCurrent(capture) || !delivery.isCurrent()) return;
    output.context = delivery;
    if (!output.connected) {
      output.connected = true; output.edgeAttempted = true;
      try { capture.node!.connect(output.gain!); } catch { retireOutput(output, 'failed'); return; }
      if (!current(output) || !nativeCurrent(capture) || !delivery.isCurrent()) { retireOutput(output, 'cancelled', true); return; }
    }
    output.state = 'active'; output.resolve(true);
  }
  function poll(): void {
    const at = clock(); if (closed || !Number.isFinite(at)) return;
    for (const output of [...outputs.values()]) {
      if (!sourceFacts(output.source) || output.state === 'active' && !outputFacts(output)) retireOutput(output, 'lost');
      else if (!current(output, at)) retireOutput(output, at >= output.deadline || output.state === 'opening' && at >= output.openingDeadline ? 'expired' : 'denied');
    }
    if (!outputs.size || !visibility()) { if (!closed) for (const o of [...outputs.values()]) retireOutput(o, 'hidden'); return; }
    if (at - lastPoll < 50) return;
    lastPoll = at;
    for (const capture of [...captures]) {
      if (capture.retired || !capture.ready) continue;
      if (at >= capture.deadline || capture.polls >= 600) { for (const o of [...outputs.values()]) if (o.capture === capture) retireOutput(o, 'expired'); continue; }
      if (!healthy(capture)) { for (const o of [...outputs.values()]) if (o.capture === capture) retireOutput(o, 'lost'); continue; }
      for (const output of [...outputs.values()]) if (output.capture === capture && output.state === 'active' && (!grantCurrent(output) || !output.context?.isCurrent())) retireOutput(output, 'unavailable');
      if (!nativeCurrent(capture) || ![...outputs.values()].some(o => o.capture === capture)) continue;
      capture.polls++; capture.sequence++;
      const retrievedAt = clock(); if (!Number.isFinite(retrievedAt) || !nativeCurrent(capture)) continue;
      const contextTimeSeconds = capture.context!.currentTime;
      if (!Number.isFinite(contextTimeSeconds) || contextTimeSeconds < 0 || !nativeCurrent(capture)) { for (const o of [...outputs.values()]) if (o.capture === capture) retireOutput(o, 'invalid'); continue; }
      runtime.publish(capture.source.audio!, { running: true, generation: capture.generation, sampleRateHz: 48000, channels: 2 }, {
        sequence: capture.sequence, timestamp: retrievedAt, clockDomain: runtime.clockDomain,
        provenance: { timing: 'javascript-native-state-retrieval', routingContextTimeSeconds: contextTimeSeconds, routingContextGeneration: capture.generation, captureTimeKnown: false, clockMappingEstablished: false } });
      if (!nativeCurrent(capture)) continue;
      try { capture.analyser!.getFloatTimeDomainData(samples); } catch { for (const o of [...outputs.values()]) if (o.capture === capture) retireOutput(o, 'failed'); continue; }
      const after = clock(); if (!nativeCurrent(capture) || !Number.isFinite(after)) continue;
      let sum = 0, peak = 0, valid = true;
      for (const sample of samples) { if (!Number.isFinite(sample) || sample < -1 || sample > 1) { valid = false; break; } sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      if (!valid) { for (const o of [...outputs.values()]) if (o.capture === capture) retireOutput(o, 'failed'); continue; }
      runtime.publish(capture.source.levels!, { rms: Math.sqrt(sum / 256), peak, sampleCount: 256, sampleRateHz: 48000 }, {
        sequence: capture.sequence, timestamp: after, clockDomain: runtime.clockDomain, provenance: { timing: 'javascript-analyser-retrieval', routingContextTimeSeconds: contextTimeSeconds,
          routingContextGeneration: capture.generation, factoryKind: env!.fixtureKind, captureTimeKnown: false, clockMappingEstablished: false } });
      if (nativeCurrent(capture)) runtime.flush();
    }
  }
  function arm(): void {
    clearTimers(); if (closed || !outputs.size) return;
    const pin = revision, at = clock(); if (closed || pin !== revision || !Number.isFinite(at)) return;
    const next = Math.min(...[...outputs.values()].map(o => o.state === 'opening' ? Math.min(o.deadline, o.openingDeadline) : o.deadline), ...[...captures].filter(c => !c.retired).map(c => c.deadline));
    const expires = setTimeout(() => { expiryTimer = undefined; sweep(); }, Math.max(0, next - at));
    if (closed || revision !== pin || !outputs.size) { clearTimeout(expires); return; } expiryTimer = expires;
    if ([...captures].some(c => c.ready && !c.retired)) {
      const timer = setTimeout(() => { pollTimer = undefined; sweep(); }, 50);
      if (closed || revision !== pin || !outputs.size) clearTimeout(timer); else pollTimer = timer;
    }
  }
  function sweep(): void { poll(); arm(); }
  async function setup(output: Output): Promise<void> {
    let capture: Capture | undefined;
    try {
      if (!consent(output) || !current(output)) { retireOutput(output, 'denied'); return; }
      output.route = runtime.route({ from: output.source.audio!, to: output.endpoint!, principalId: output.principal, applicationId, sessionId,
        sourceOperation: 'subscribe', leaseMs: 30000, constraints: output.grant });
      if (!current(output)) { output.route.stop('cancelled'); retireOutput(output, 'cancelled'); return; }
      output.routeDetach = output.route.onClose(() => retireOutput(output, 'unavailable'));
      if (!current(output)) { output.routeDetach(); output.routeDetach = undefined; return; }
      const started = output.route.start(); if (!current(output) || !started.ok) { retireOutput(output, 'denied'); return; }
      capture = output.source.capture;
      if (!capture) {
        const at = clock(); if (!current(output, at)) { retireOutput(output, 'cancelled'); return; }
        capture = { source: output.source, sourceGeneration: output.source.generation, generation: ++captureEpoch, startedAt: at, deadline: at + 30000, retired: false,
          setupDone: false, cleanupDone: true, ready: false, detach: [], closedContext: false, stoppedTracks: new Set(), disconnected: new Set(), polls: 0, sequence: 0 };
        output.source.capture = capture; captures.add(capture); output.capture = capture; arm();
        capture.clone = output.source.track.clone(); if (!current(output) || !nativeCurrent(capture)) { retireCapture(capture); return; }
        if (!nativeTrack(capture.clone)) { retireOutput(output, 'unsupported'); return; }
        capture.stream = env!.createMediaStream([capture.clone]); if (!current(output) || !nativeCurrent(capture)) { retireCapture(capture); return; }
        if (!(capture.stream instanceof env!.MediaStream) || capture.stream.getTracks().length !== 1 || capture.stream.getTracks()[0] !== capture.clone) { retireOutput(output, 'unsupported'); return; }
        capture.context = env!.createAudioContext(); if (!current(output) || !nativeCurrent(capture)) { retireCapture(capture); return; }
        if (!(capture.context instanceof env!.AudioContext) || capture.context.sampleRate !== 48000) { retireOutput(output, 'unsupported'); return; }
        const active = capture, nativeContext = active.context!, nativeStream = active.stream!;
        for (const track of [active.source.track, active.clone!]) for (const event of ['ended', 'mute']) {
          listen(active.detach, track, event, () => { for (const o of [...outputs.values()]) if (o.capture === active) retireOutput(o, 'lost'); }, () => nativeCurrent(active));
          if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        }
        listen(active.detach, nativeContext, 'statechange', () => { if (active.ready && nativeContext.state !== 'running') for (const o of [...outputs.values()]) if (o.capture === active) retireOutput(o, 'lost'); }, () => nativeCurrent(active));
        if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        listen(active.detach, active.source.producerContext, 'statechange', () => { if (!sourceFacts(active.source)) for (const o of [...outputs.values()]) if (o.capture === active) retireOutput(o, 'lost'); }, () => nativeCurrent(active));
        if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        active.node = nativeContext.createMediaStreamSource(nativeStream); if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        active.analyser = nativeContext.createAnalyser(); if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        active.analyser.fftSize = 256; if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        active.node.connect(active.analyser); if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; }
        if (nativeContext.state === 'suspended') { await nativeContext.resume(); if (!current(output) || !nativeCurrent(active)) { retireCapture(active); return; } }
        if (nativeContext.state !== 'running') { retireOutput(output, 'unavailable'); return; }
        active.ready = true;
        if (!runtime.setReadiness(output.source.levels!, 'available', active.deadline).ok || !current(output) || !nativeCurrent(active)) { retireOutput(output, 'cancelled'); return; }
      } else output.capture = capture;
      if (!healthy(capture) || !current(output)) { retireOutput(output, 'lost'); return; }
      output.deadline = Math.min(output.deadline, capture.deadline);
      output.gain = capture.context!.createGain(); if (!current(output) || !nativeCurrent(capture)) { retireOutput(output, 'cancelled', true); return; }
      output.node = capture.context!.createMediaStreamDestination(); if (!current(output) || !nativeCurrent(capture)) { retireOutput(output, 'cancelled', true); return; }
      // Retain the genuine native destination defaults; requested settings are not observed facts.
      output.tracks = output.node.stream.getTracks(); if (!current(output) || !nativeCurrent(capture)) { retireOutput(output, 'cancelled', true); return; }
      if (!(output.node instanceof env!.MediaStreamAudioDestinationNode) || output.node.context !== capture.context || output.node.context.sampleRate !== 48000 || output.node.channelCount !== 2 || output.tracks.length !== 1 || !nativeTrack(output.tracks[0]) || !current(output)) { retireOutput(output, 'unsupported'); return; }
      for (const type of ['ended', 'mute']) {
        listen(output.detach, output.tracks[0]!, type, () => retireOutput(output, 'lost'), () => basic(output));
        if (!current(output)) { retireOutput(output, 'cancelled'); return; }
      }
      output.gain.gain.value = output.volume;
      output.gain.connect(output.node); if (!current(output) || !nativeCurrent(capture)) { retireOutput(output, 'cancelled', true); return; }
      lastPoll = -Infinity; poll();
      if (basic(output) && output.state !== 'active') retireOutput(output, 'unavailable');
    } catch { retireOutput(output, 'failed', true); }
    finally {
      if (capture && !capture.setupDone) { capture.setupDone = true; if (capture.retired) retireCapture(capture); finish(capture); }
      setupPending = false; arm();
    }
  }
  const controller: BrowserApplicationAudio = {
    registerSource(input) {
      if (closed || registering || sources.size || aborted(owner) || !env) return;
      registering = true;
      try {
      const copied = fields(input, ['sourceId', 'ownerPrincipalId', 'producerNode', 'stream']);
      if (!copied || !resourceId(copied.sourceId) || !id(copied.ownerPrincipalId) || !(copied.stream instanceof env.MediaStream) || !(copied.producerNode instanceof env.MediaStreamAudioDestinationNode)) return;
      const at = clock(), pin = revision; if (!Number.isFinite(at) || closed) return;
      const source: Source = { handle: Object.freeze({}), id: copied.sourceId, principal: copied.ownerPrincipalId, producerNode: copied.producerNode, producerContext: copied.producerNode.context as AudioContext, stream: copied.stream, track: undefined as unknown as MediaStreamTrack,
        generation: ++generation, device: descriptor(copied.sourceId), alive: true };
      sources.add(source); handles.set(source.handle, source);
      try {
        const tracks = source.stream.getTracks(); if (closed || revision !== pin || !source.alive || tracks.length !== 1 || !nativeTrack(tracks[0])) { removeSource(source, 'unsupported'); return; }
        source.track = tracks[0]; if (!sourceFacts(source)) { removeSource(source, 'unsupported'); return; } lifecycle(); if (closed || revision !== pin || !source.alive || !visibility()) { removeSource(source, 'hidden'); return; }
        source.audio = runtime.registerSource({ device: source.device, capability: 'audio' }); if (closed || revision !== pin || !source.alive) { runtime.unregister(source.audio); return; }
        source.levels = runtime.registerSource({ device: source.device, capability: 'levels' }); if (closed || revision !== pin || !source.alive) { runtime.unregister(source.levels); runtime.unregister(source.audio); return; }
        if (!runtime.setReadiness(source.audio, 'available').ok || closed || revision !== pin || !source.alive) { removeSource(source, 'cancelled'); return; }
        runtime.setReadiness(source.levels, 'unavailable'); if (closed || revision !== pin || !source.alive) { removeSource(source, 'cancelled'); return; }
        return source.handle;
      } catch { removeSource(source, 'failed'); return; }
      } catch { return; } finally { registering = false; }
    },
    resources(handle) { const source = handles.get(handle); if (!source || !source.alive || closed || !source.audio || !source.levels) return; return Object.freeze({ device: source.device, audio: source.audio, levels: source.levels }); },
    bind(input) {
      if (closed || aborted(owner)) return no('closed');
      if (rawPending()) return no('busy');
      if (outputs.size >= 2) return no('capacity');
      if (attempts >= 64) return no('quota');
      setupPending = true;
      const copied = fields(input, ['source', 'outputId', 'ownerPrincipalId', 'purpose', 'signal']);
      if (!copied || !resourceId(copied.outputId) || !id(copied.ownerPrincipalId) || !id(copied.purpose) || !signal(copied.signal) || aborted(copied.signal)) { setupPending = false; return no('invalid'); }
      const source = handles.get(copied.source as BrowserApplicationAudioSource); if (closed || !source || !source.alive || !source.audio || !source.levels || outputs.has(copied.outputId)) { setupPending = false; return no('invalid'); }
      attempts++;
      let resolve!: (value: boolean) => void; const ready = new Promise<boolean>(yes => { resolve = yes; });
      const output: Output = { id: copied.outputId, principal: copied.ownerPrincipalId, purpose: copied.purpose, signal: copied.signal, source, generation: source.generation,
        state: 'opening', signals: [], deadline: Infinity, openingDeadline: Infinity, tracks: [], connected: false, edgeAttempted: false, detach: [], volume: 1, muted: false, ready, resolve };
      outputs.set(output.id, output);
      const binding: BrowserApplicationAudioBinding = Object.freeze({ ready,
        status: () => Object.freeze({ state: output.state, reason: output.reason, generation: output.generation, expiresAt: Number.isFinite(output.deadline) ? output.deadline : undefined, volume: output.volume, muted: output.muted }),
        output() { if (!current(output) || output.state !== 'active' || !grantCurrent(output) || !output.context?.isCurrent() || !output.capture || !healthy(output.capture)) { if (basic(output)) retireOutput(output, 'unavailable'); return; } return output.node?.stream; },
        setVolume(value: number) { if (!Number.isFinite(value) || value < 0 || value > 1 || !current(output) || output.state !== 'active' || !output.context?.isCurrent() || !output.gain) return false;
          output.volume = value; output.gain.gain.value = output.muted ? 0 : value; if (!current(output)) { retireOutput(output, 'cancelled'); return false; } return true; },
        setMuted(value: boolean) { if (typeof value !== 'boolean' || !current(output) || output.state !== 'active' || !output.context?.isCurrent() || !output.gain) return false;
          output.muted = value; output.gain.gain.value = value ? 0 : output.volume; if (!current(output)) { retireOutput(output, 'cancelled'); return false; } return true; },
        renew() { if (rawPending()) return false; setupPending = true;
          try { if (!current(output) || !consent(output) || !grantCurrent(output)) { retireOutput(output, 'denied'); return false; } arm(); return current(output); }
          finally { setupPending = false; } }, stop() { retireOutput(output, 'stopped'); } });
      try {
        const at = clock(); if (!current(output, at) || !visibility()) { retireOutput(output, 'hidden'); setupPending = false; return binding; }
        output.deadline = at + 30000; output.openingDeadline = at + 5000;
        listen(output.detach, output.signal, 'abort', () => retireOutput(output, 'cancelled'), () => basic(output), true);
        if (!current(output)) { retireOutput(output, 'cancelled'); setupPending = false; return binding; }
        output.endpoint = runtime.registerSink({ device: descriptor(output.id, true), capability: 'audio', apply: (observation, delivery) => apply(output, observation, delivery), release: () => retireOutput(output, 'unavailable') });
        if (!current(output)) { runtime.unregister(output.endpoint); retireOutput(output, 'cancelled'); setupPending = false; return binding; }
        runtime.setReadiness(output.endpoint, 'available'); if (!current(output)) { retireOutput(output, 'cancelled'); setupPending = false; return binding; }
        const base = { operation: 'route-private-audio' as const, recipientPrincipalId: output.principal, sourceOwnerPrincipalId: source.principal, applicationId, sessionId,
          sourceId: source.id, outputId: output.id, purpose: output.purpose, sourceGeneration: source.generation,
          source: Object.freeze({ registrationId: source.audio.id, deviceId: source.id, capabilityId: 'audio', descriptorRevision: 1, schemaVersion: 1 }),
          sink: Object.freeze({ registrationId: output.endpoint.id, deviceId: output.id, capabilityId: 'audio', descriptorRevision: 1, schemaVersion: 1 }),
          sourceOperation: 'subscribe' as const, sinkOperation: 'write' as const, format: Object.freeze({ kind: 'native-private-stream' as const, sampleRateHz: 48000 as const, channels: 2 as const }) };
        output.sourceRequest = Object.freeze({ ...base, role: 'source', ownerPrincipalId: source.principal });
        output.outputRequest = Object.freeze({ ...base, role: 'output', ownerPrincipalId: output.principal });
        // close() must see this reservation before setup can reenter through a native factory.
        let settled!: () => void; const work = new Promise<void>(done => { settled = done; });
        trackTask(work); void setup(output).then(settled, settled); return binding;
      } catch { retireOutput(output, 'failed'); setupPending = false; return binding; }
    },
    revokeSource(handle) { const source = handles.get(handle); if (!source || !source.alive) return false; removeSource(source, 'denied'); return true; },
    revokeOutput(outputId) { const output = outputs.get(outputId); if (!output) return false; retireOutput(output, 'denied'); return true; }, sweep,
    snapshot: () => Object.freeze({ closed, sources: sources.size, activeOutputs: [...outputs.values()].filter(o => o.state === 'active').length,
      openingOutputs: [...outputs.values()].filter(o => o.state === 'opening').length, rawPending: rawPending() ? 1 : 0,
      cleanupPending: [...captures].filter(c => c.retired && !c.cleanupDone).length, cleanupFailures, attempts, listeners,
      polls: [...captures].reduce((count, c) => count + c.polls, 0), pollArmed: pollTimer !== undefined, expiryArmed: expiryTimer !== undefined }),
    async close() { shutdown('closed'); while (nativeTasks.size) await Promise.all([...nativeTasks]); }
  };
  return Object.freeze(controller);
}
