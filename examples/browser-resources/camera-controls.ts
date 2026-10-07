import { createBrowserCameraProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserCameraActivation, BrowserCameraCaptureGrant, BrowserCameraCaptureRequest, BrowserCameraControlGrant,
  BrowserCameraControlRequest, BrowserCameraEnvironment, BrowserCameraFrame, BrowserCameraOptions, Connection, Observation } from '@101/connect';

/** Independent selected-camera caller. Only the provider owns its private track.
 * Reported zoom facts/settings never establish optical effects. Runtime and provider
 * use the same host clock; native decoded media position remains separate. */
export function createBrowserCameraControls(options: { ownerSignal: AbortSignal; now?: () => number;
  authorizeCapture(request: BrowserCameraCaptureRequest): BrowserCameraCaptureGrant | undefined;
  authorizeControl(request: BrowserCameraControlRequest): BrowserCameraControlGrant | undefined;
  authorizeRoutes: Authorize; environment?: BrowserCameraEnvironment }) {
  const now = options.now ?? (() => performance.now()), scope = { principalId: 'camera-control-owner', applicationId: 'camera-controls-example', sessionId: 'camera-controls-session' };
  const runtime = createDeviceRuntime({ now, clockDomain: 'camera-controls-js-retrieval', authorize: options.authorizeRoutes,
    maxRegistrations: 4, maxRoutes: 2, maxPendingDeliveries: 2 });
  const routes = new Map<string, Connection>(), endpoints: ReturnType<typeof runtime.registerSource>[] = [];
  let activation: BrowserCameraActivation | undefined, command: ReturnType<typeof runtime.registerSource> | undefined, commandRoute: Connection | undefined;
  let latest: Observation | undefined, delivered = 0, released = 0, operation = 0;
  const controlDeliveryLimits: NonNullable<BrowserCameraOptions['controlDeliveryLimits']> = context => {
    const connection = routes.get(context.routeId), limits = connection?.limits();
    if (!connection || connection !== commandRoute || connection.status().state !== 'active' || !limits || !context.operationId) return;
    const record = connection.operations().find(item => item.id === context.operationId && item.handlerResult === 'running');
    if (!record) return;
    return Object.freeze({ context, expiresAt: Math.min(limits.expiresAt, record.deadline), maxAgeMs: Math.min(limits.maxAgeMs, 250), maxHz: Math.min(limits.maxHz, 2) });
  };
  const provider = createBrowserCameraProvider({ runtime, now, scope, ownerSignal: options.ownerSignal, authorizeCapture: options.authorizeCapture,
    authorizeControl: options.authorizeControl, controlDeliveryLimits, ...(options.environment ? { environment: options.environment } : {}) });
  return {
    provider,
    async activate(selection: Parameters<typeof provider.start>[0]) {
      const result = await provider.start(selection, { purpose: 'reviewed-camera-raster' }); if (!result.ok) return result;
      activation = result.value;
      const device = parseDeviceDescriptor({ ...activation.device, id: activation.device.id + ':display', capabilities: activation.device.capabilities.map(capability => ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
      const sink = runtime.registerSink({ device, capability: 'camera-frame', apply(observation, context) {
        if (context.isCurrent() && !context.signal.aborted) { latest = observation; delivered++; }
      }, release() { latest = undefined; released++; } }); endpoints.push(sink);
      runtime.setReadiness(sink, 'available');
      const route = runtime.route({ from: activation.source, to: sink, ...scope, leaseMs: 5000 }); routes.set(route.id, route);
      if (!route.start().ok) { provider.stop(); runtime.unregister(sink); activation = undefined; return { ok: false as const, reason: 'denied' as const }; }
      return result;
    },
    report() { return activation ? provider.inspectControls(activation) : { ok: false as const, reason: 'denied' as const }; },
    connectZoom() {
      if (!activation) return { ok: false as const, reason: 'denied' as const };
      const bound = provider.bindZoom(activation, { purpose: 'reviewed-camera-api-zoom' }); if (!bound.ok) return bound;
      const device = parseDeviceDescriptor({ ...bound.value.device, id: bound.value.device.id + ':command-source', capabilities: bound.value.device.capabilities.map(capability => ({ ...capability, kind: 'event' as const, permissions: ['subscribe'] })) });
      command = runtime.registerSource({ device, capability: 'camera-zoom' }); endpoints.push(command); runtime.setReadiness(command, 'available');
      commandRoute = runtime.route({ from: command, to: bound.value.sink, ...scope, leaseMs: Math.max(1, Math.floor(Math.min(5000, bound.value.expiresAt - now()))), queueCapacity: 1 });
      routes.set(commandRoute.id, commandRoute);
      if (!commandRoute.start().ok) { commandRoute.stop('denied'); runtime.unregister(command); command = undefined; commandRoute = undefined; return { ok: false as const, reason: 'denied' as const }; }
      return bound;
    },
    setZoom(value: number, deadline = now() + 250) {
      if (!command || !commandRoute || ++operation > 32) return { ok: false as const, reason: 'denied' as const };
      const result = runtime.publish(command, value, { operationId: String(operation), deadline }); runtime.flush(); return result;
    },
    tick() { runtime.flush(); }, state() { return { latest, delivered, released, control: provider.controlStatus() }; },
    async close() {
      provider.stop(); for (const route of routes.values()) route.stop('camera-controls-close');
      await provider.close(); for (const endpoint of endpoints) runtime.unregister(endpoint); endpoints.length = 0; routes.clear(); command = undefined; commandRoute = undefined; activation = undefined; runtime.close();
    }
  };
}

/** No enumeration, getUserMedia, chooser or applyConstraints. */
export async function checkCameraControlsWithoutDevice() {
  const owner = new AbortController(); let captureApprovals = 0, controlApprovals = 0;
  const caller = createBrowserCameraControls({ ownerSignal: owner.signal, authorizeRoutes: () => undefined,
    authorizeCapture() { captureApprovals++; return undefined; }, authorizeControl() { controlApprovals++; return undefined; } });
  const initial = caller.provider.snapshot(); let report, binding;
  try { report = caller.provider.inspectControls({} as BrowserCameraActivation); binding = caller.provider.bindZoom({} as BrowserCameraActivation, { purpose: 'no-issued-camera' }); }
  finally { owner.abort(); await caller.close(); }
  return { kind: 'inert-camera-controls-negative', positiveHardwareEvidence: false, nativeAcquisitions: 0, nativeConstraintCalls: 0,
    captureApprovals, controlApprovals, initial, report, binding, final: caller.provider.snapshot(), control: caller.provider.controlStatus() };
}

/** Genuine canvas stream/decoded pixels; no optical or native zoom positive. */
export async function runOwnedCameraControlsCanvas() {
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function' || typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function') return { kind: 'owned-native-canvas-no-zoom', result: 'unsupported', positiveHardwareEvidence: false };
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48; const paint = canvas.getContext('2d'); if (!paint) throw Error('Owned canvas context unavailable');
  let blue = false, frames = 0; const draw = () => { if (++frames <= 80) { paint.fillStyle = blue ? '#0000ff' : '#ff0000'; paint.fillRect(0, 0, 64, 48); } }; draw();
  const stream = canvas.captureStream(10), track = stream.getVideoTracks()[0]; if (!track) throw Error('Owned canvas track unavailable');
  const deviceId = track.getSettings().deviceId ?? 'owned-canvas-selected-id';
  let constraints = 0, captureApprovals = 0, controlApprovals = 0, video: HTMLVideoElement | undefined, sampled: HTMLCanvasElement | undefined;
  const nativeApply = track.applyConstraints.bind(track); track.applyConstraints = value => { constraints++; return nativeApply(value); };
  const owner = new AbortController(), capture = new AbortController(), control = new AbortController(), end = performance.now() + 5000;
  const timer = setInterval(draw, 100);
  const environment: BrowserCameraEnvironment = { fixtureKind: 'owned-canvas-fixture', enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId }]),
    getUserMedia(request) { if (request.audio !== false || JSON.stringify(request.video) !== JSON.stringify({ deviceId: { exact: deviceId }, width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 10, max: 15 } })) throw Error('Owned exact canvas request mismatch'); return Promise.resolve(stream); },
    createVideo() { return video = document.createElement('video'); }, createCanvas() { return sampled = document.createElement('canvas'); },
    MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData, target: window, document, mediaDevicesTarget: new EventTarget(), hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext };
  const caller = createBrowserCameraControls({ ownerSignal: owner.signal, environment, authorizeCapture(request) { captureApprovals++; return { request, signal: capture.signal, expiresAt: end }; },
    authorizeControl(request) { controlApprovals++; return { request, signal: control.signal, expiresAt: end }; }, authorizeRoutes(request) {
      if (request.principalId === 'camera-control-owner' && request.applicationId === 'camera-controls-example' && request.sessionId === 'camera-controls-session' && request.source.capabilityId === 'camera-frame' && request.sink.capabilityId === 'camera-frame' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 250, maxHz: 10 };
    } });
  function color(channel: number) { const frame = caller.state().latest?.value as unknown as BrowserCameraFrame | undefined; return frame?.rows.every(row => row.every((value, index) => index % 4 === channel || index % 4 === 3 ? value >= 240 : value <= 16)) === true; }
  async function until(predicate: () => boolean) { const stop = Math.min(end, performance.now() + 2000); while (!predicate() && performance.now() < stop) { await new Promise(resolve => setTimeout(resolve, 20)); caller.tick(); } if (!predicate()) throw Error('Owned canvas pixel deadline'); }
  let red: ReturnType<typeof caller.state> | undefined, changed, report, binding, retired;
  try {
    const inspected = await caller.provider.inspect(); if (!inspected.ok || inspected.value.length !== 1) throw Error('Owned canvas inventory');
    const active = await caller.activate(inspected.value[0]!.selection); if (!active.ok) throw Error('Owned canvas activation');
    await until(() => color(0)); const redState = caller.state(); red = redState; report = caller.report(); binding = caller.connectZoom();
    if (!report.ok || report.value.zoom.state !== 'unsupported' || binding.ok || binding.reason !== 'unsupported' || constraints !== 0 || controlApprovals !== 0) throw Error('Canvas must not establish native zoom support');
    blue = true; draw(); await until(() => caller.state().delivered > redState.delivered && color(2)); changed = caller.state(); capture.abort(); retired = caller.state();
  } finally {
    clearInterval(timer); owner.abort(); await caller.close(); stream.getTracks().forEach(native => native.stop()); track.applyConstraints = nativeApply; canvas.width = canvas.height = 1; canvas.remove();
  }
  return { kind: 'owned-native-canvas-no-zoom', result: 'pass', positiveHardwareEvidence: false, captureApprovals, controlApprovals, constraints, frames,
    report, binding, red, changed, retired, cleanup: { provider: caller.provider.snapshot(), control: caller.provider.controlStatus(), tracksEnded: stream.getTracks().every(native => native.readyState === 'ended'),
      videoDetached: video?.srcObject === null, videoConnected: video?.isConnected === true, sampledWidth: sampled?.width, sampledHeight: sampled?.height, producerWidth: canvas.width, producerHeight: canvas.height } };
}

/** Cooperative software port only. Genuine EventTarget and native-shaped getters/
 * returned promises exercise public command grants, never physical zoom. */
export async function runSoftwareCameraZoom() {
  class SoftwareTrack extends EventTarget {
    kind = 'video'; readyState = 'live'; muted = false; id = 'software-track'; setting = 1; calls: MediaTrackConstraints[] = []; held: Promise<void> | undefined;
    stop() { this.readyState = 'ended'; }
    getSettings() { return { deviceId: 'software-camera-selected-id', width: 64, height: 48, zoom: this.setting }; }
    getCapabilities() { return { zoom: { min: 1, max: 4, step: 0.5 } }; }
    applyConstraints(payload: MediaTrackConstraints) { this.calls.push(payload); const next = (payload.advanced?.[0] as { zoom: number }).zoom;
      if (JSON.stringify(payload) !== JSON.stringify({ advanced: [{ zoom: next }] })) throw Error('Only zoom allowed');
      return (this.held ?? Promise.resolve()).then(() => { this.setting = next; }); }
  }
  class SoftwareStream { track = new SoftwareTrack(); getTracks() { return [this.track]; } }
  class SoftwareVideo extends EventTarget {
    srcObject: unknown; muted = false; playsInline = false; readyState = 2; videoWidth = 64; videoHeight = 48; frames = 0; next = 0; pending = new Map<number, VideoFrameRequestCallback>();
    play() { return Promise.resolve(); } pause() {} remove() {}
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) { const id = ++this.next; this.pending.set(id, callback); return id; }
    cancelVideoFrameCallback(id: number) { this.pending.delete(id); }
    emit() { const next = this.pending.entries().next().value; if (!next) return; this.pending.delete(next[0]); next[1](performance.now(), { mediaTime: ++this.frames / 10, presentedFrames: this.frames, width: 64, height: 48, expectedDisplayTime: performance.now(), presentationTime: performance.now(), processingDuration: 0 }); }
  }
  class SoftwareImage { width = 8; height = 8; data = new Uint8ClampedArray(256); }
  class SoftwareCanvas { width = 0; height = 0; getContext() { return { drawImage() {}, getImageData: () => new SoftwareImage() }; } remove() {} }
  const stream = new SoftwareStream(), video = new SoftwareVideo(), canvas = new SoftwareCanvas(), owner = new AbortController(), capture = new AbortController(), control = new AbortController();
  let allowed = false, reviewed = 0; const end = performance.now() + 5000, target = new EventTarget(), doc = new EventTarget();
  const environment: BrowserCameraEnvironment = { fixtureKind: 'software-fixture', enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'software-camera-selected-id' }]),
    getUserMedia: () => Promise.resolve(stream as unknown as MediaStream), createVideo: () => video as unknown as HTMLVideoElement, createCanvas: () => canvas as unknown as HTMLCanvasElement,
    MediaStream: SoftwareStream as unknown as typeof MediaStream, HTMLVideoElement: SoftwareVideo as unknown as typeof HTMLVideoElement, HTMLCanvasElement: SoftwareCanvas as unknown as typeof HTMLCanvasElement, ImageData: SoftwareImage as unknown as typeof ImageData,
    target, document: doc, mediaDevicesTarget: new EventTarget(), hidden: () => false, focused: () => true, secureContext: () => true };
  const caller = createBrowserCameraControls({ ownerSignal: owner.signal, environment, authorizeCapture: request => ({ request, signal: capture.signal, expiresAt: end }),
    authorizeControl(request) { reviewed++; return allowed ? { request, signal: control.signal, expiresAt: end } : undefined; }, authorizeRoutes(request) {
      if (request.principalId !== 'camera-control-owner' || request.applicationId !== 'camera-controls-example' || request.sessionId !== 'camera-controls-session' || request.sourceOperation !== 'subscribe') return;
      if (request.source.capabilityId === 'camera-frame' && request.sink.capabilityId === 'camera-frame' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 250, maxHz: 10 };
      if (allowed && request.source.capabilityId === 'camera-zoom' && request.sink.capabilityId === 'camera-zoom' && request.sinkOperation === 'invoke') return { expiresAt: end, maxAgeMs: 250, maxHz: 2 };
    } });
  const timer = setInterval(() => { if (video.frames < 80) video.emit(); caller.tick(); }, 100);
  const issuedCount = () => stream.track.calls.length;
  let release: (() => void) | undefined, closed: Promise<void> | undefined; let denied, returned, pending, final;
  try {
    const inspected = await caller.provider.inspect(); if (!inspected.ok) throw Error('Software inventory');
    const active = await caller.activate(inspected.value[0]!.selection); if (!active.ok) throw Error('Software activation');
    denied = caller.connectZoom(); if (denied.ok || denied.reason !== 'denied' || issuedCount() !== 0 || caller.provider.snapshot().activeSources !== 1) throw Error('Decline must retain captured frame');
    allowed = true; const bound = caller.connectZoom(); if (!bound.ok) throw Error('Reviewed software zoom');
    if (!caller.setZoom(2.5).ok) throw Error('Actual SDK software command'); await new Promise(resolve => setTimeout(resolve, 20)); returned = caller.state();
    if (stream.track.setting !== 2.5 || returned.control.state !== 'api-returned' || issuedCount() !== 1) throw Error('Software setting not observed');
    caller.setZoom(1.25); caller.setZoom(5); caller.setZoom(NaN); if (issuedCount() !== 1) throw Error('Invalid scalar cannot issue');
    await new Promise(resolve => setTimeout(resolve, 500)); stream.track.held = new Promise<void>(yes => { release = yes; });
    if (!caller.setZoom(3).ok || issuedCount() !== 2) throw Error('Held software command');
    control.abort(); pending = caller.provider.controlStatus(); if (pending.rawPending !== 1 || pending.state !== 'uncertain' || caller.provider.snapshot().activeSources !== 0) throw Error('Issued revoke must retire capture and retain raw work');
    let settled = false; closed = caller.close().then(() => { settled = true; }); await new Promise(resolve => setTimeout(resolve, 20)); if (settled) throw Error('Logical close is not actual settlement');
    release!(); await closed; final = caller.state(); if (final.control.rawPending !== 0 || final.control.activeSinks !== 0) throw Error('Actual software settlement cleanup');
  } finally { clearInterval(timer); release?.(); owner.abort(); await (closed ?? caller.close()); }
  return { kind: 'cooperative-software-camera-zoom', result: 'pass', positiveHardwareEvidence: false, nativeZoomQualification: false,
    reviewed, denied, returned, pending, final, payloads: stream.track.calls, apiSetting: stream.track.setting,
    cleanup: { provider: caller.provider.snapshot(), control: caller.provider.controlStatus(), trackEnded: stream.track.readyState === 'ended', frameCallbacks: video.pending.size, producerTimers: 0 } };
}
