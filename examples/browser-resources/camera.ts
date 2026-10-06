import { createBrowserCameraProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserCameraCaptureGrant, BrowserCameraCaptureRequest, BrowserCameraEnvironment, BrowserCameraFrame, Observation } from '@101/connect';

export function createBrowserCameraPipeline(options: { ownerSignal: AbortSignal;
  authorizeCapture: (request: BrowserCameraCaptureRequest) => BrowserCameraCaptureGrant | undefined;
  authorizeRoutes: Authorize; now?: () => number; environment?: BrowserCameraEnvironment }) {
  const now = options.now ?? (() => performance.now()), scope = { principalId: 'camera-owner', applicationId: 'camera-example', sessionId: 'camera-session' };
  const runtime = createDeviceRuntime({ now, clockDomain: 'camera-javascript-retrieval', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserCameraProvider({ runtime, now, ownerSignal: options.ownerSignal, scope, authorizeCapture: options.authorizeCapture, ...(options.environment ? { environment: options.environment } : {}) });
  let latest: Observation | undefined, delivered = 0, released = 0;
  const routes: ReturnType<typeof runtime.route>[] = [], sinks: ReturnType<typeof runtime.registerSink>[] = [];
  return { provider,
    async activate(selection: Parameters<typeof provider.start>[0], purpose: string) {
      const started = await provider.start(selection, { purpose }); if (!started.ok) return started;
      const device = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':consumer', capabilities: started.value.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
      const sink = runtime.registerSink({ device, capability: 'camera-frame', apply(observation, context) { if (!context.signal.aborted && context.isCurrent()) { latest = observation; delivered++; } }, release() { latest = undefined; released++; } }); sinks.push(sink);
      runtime.setReadiness(sink, 'available'); const route = runtime.route({ from: started.value.source, to: sink, ...scope, leaseMs: 5000 }); routes.push(route);
      if (!route.start().ok) { provider.stop(); runtime.unregister(sink); return { ok: false as const, reason: 'denied' as const }; } return started;
    }, tick() { runtime.flush(); }, state() { return { latest, delivered, released }; },
    async close() { await provider.close(); for (const route of routes.splice(0)) route.stop('camera-close'); for (const sink of sinks.splice(0)) runtime.unregister(sink); runtime.close(); } };
}

/** Availability and policy readback only. This function never calls getUserMedia,
 * presents a chooser, enumerates user devices or invents native policy enforcement. */
export async function checkBrowserCameraWithoutDevice() {
  type Policy = { features?: () => string[]; allowsFeature(name: string): boolean };
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };
  let recognized = false, denied: boolean | undefined;
  try { const policy = doc.permissionsPolicy ?? doc.featurePolicy, features = policy?.features?.(); recognized = Array.isArray(features) && features.length <= 128 && features.every(item => typeof item === 'string') && features.includes('camera'); if (recognized) denied = policy!.allowsFeature('camera') === false; } catch { /* Unqualified readback; no acquisition. */ }
  const owner = new AbortController(); let captureApprovals = 0;
  const pipeline = createBrowserCameraPipeline({ ownerSignal: owner.signal, authorizeRoutes: () => undefined, authorizeCapture() { captureApprovals++; return undefined; } });
  const initial = pipeline.provider.snapshot(); let forged;
  try { forged = await pipeline.provider.start({}, { purpose: 'no-issued-camera' }); }
  finally { owner.abort(); await pipeline.close(); }
  return { kind: 'actual-native-camera-availability-policy-readback', physicalCameraQualification: false, positiveHardwareEvidence: false,
    native: { mediaDevicesAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function', policyFeatureRecognized: recognized, policyDeniedReadback: denied, defaultNativeOpens: 0, nativePolicyDenialQualified: false },
    initial, forged, captureApprovals, final: pipeline.provider.snapshot() };
}

/** Actual owned Canvas→native stream→decoded video pixels. The factory is explicitly
 * a digital producer seam, not a physical camera, permission or sensor-clock proof. */
export async function runOwnedBrowserCameraFixture() {
  if (typeof HTMLCanvasElement !== 'function' || typeof HTMLCanvasElement.prototype.captureStream !== 'function' || typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function') return { kind: 'owned-native-canvas-camera-fixture', result: 'unsupported', positiveHardwareEvidence: false };
  const producer = document.createElement('canvas'); producer.width = 64; producer.height = 48;
  const paint = producer.getContext('2d'); if (!paint) throw new Error('Owned native canvas unavailable');
  let blue = false, producerFrames = 0;
  const draw = () => { if (++producerFrames > 80) return; paint.fillStyle = blue ? '#0000ff' : '#ff0000'; paint.fillRect(0, 0, 64, 48); }; draw();
  const stream = producer.captureStream(10), track = stream.getVideoTracks()[0]; if (!track) throw new Error('Owned native video track unavailable');
  const selectedId = track.getSettings().deviceId ?? 'owned-native-canvas-stream';
  const timer = setInterval(draw, 100), owner = new AbortController(), capture = new AbortController();
  let opens = 0, approvals = 0, videos = 0, sampledCanvas: HTMLCanvasElement | undefined, video: HTMLVideoElement | undefined;
  const environment: BrowserCameraEnvironment = { fixtureKind: 'owned-canvas-fixture',
    enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: selectedId }]),
    getUserMedia(constraints) { opens++; if (JSON.stringify(constraints) !== JSON.stringify({ video: { deviceId: { exact: selectedId }, width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 10, max: 15 } }, audio: false })) throw new Error('Exact owned canvas selection required'); return Promise.resolve(stream); },
    createVideo() { videos++; video = document.createElement('video'); return video; }, createCanvas() { sampledCanvas = document.createElement('canvas'); return sampledCanvas; }, MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData,
    target: window, document, mediaDevicesTarget: new EventTarget(), hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext };
  const pipeline = createBrowserCameraPipeline({ ownerSignal: owner.signal, environment,
    authorizeCapture(request) { approvals++; return { request, signal: capture.signal, expiresAt: performance.now() + 5000 }; },
    authorizeRoutes(request) { if (request.principalId === 'camera-owner' && request.applicationId === 'camera-example' && request.sessionId === 'camera-session' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: performance.now() + 5000, maxAgeMs: 250, maxHz: 10 }; } });
  function color(channel: number) { const frame = pipeline.state().latest?.value as unknown as BrowserCameraFrame | undefined; return frame && frame.rows.every(row => row.every((value, index) => index % 4 === channel ? value >= 240 : index % 4 === 3 ? value >= 240 : value <= 16)); }
  async function until(predicate: () => boolean) { const deadline = performance.now() + 2000; while (!predicate() && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); pipeline.tick(); } if (!predicate()) throw new Error('Owned decoded raster did not reach expected color'); }
  let red: ReturnType<typeof pipeline.state>, changed: ReturnType<typeof pipeline.state>, retired: ReturnType<typeof pipeline.state>;
  try {
    const inventory = await pipeline.provider.inspect(); if (!inventory.ok || inventory.value.length !== 1) throw new Error('Owned canvas inventory unavailable');
    const started = await pipeline.activate(inventory.value[0]!.selection, 'owned-native-canvas-raster'); if (!started.ok) throw new Error('Owned canvas capture unavailable: ' + started.reason);
    await until(() => color(0) === true); red = pipeline.state(); blue = true; draw();
    await until(() => pipeline.state().delivered > red.delivered && color(2) === true); changed = pipeline.state();
    capture.abort(); retired = pipeline.state(); if (retired.latest !== undefined || retired.released < 1) throw new Error('Granted raster sink was not released');
  } finally { clearInterval(timer); owner.abort(); await pipeline.close(); stream.getTracks().forEach(native => native.stop()); producer.width = 1; producer.height = 1; producer.remove(); }
  return { kind: 'owned-native-canvas-camera-fixture', result: 'pass', positiveHardwareEvidence: false, opens, approvals, videos, producerFrames,
    red: red!, changed: changed!, retired: retired!, cleanup: { provider: pipeline.provider.snapshot(), tracksEnded: stream.getTracks().every(native => native.readyState === 'ended'),
      videoDetached: video?.srcObject === null, videoConnected: video?.isConnected === true, sampledWidth: sampledCanvas?.width, sampledHeight: sampledCanvas?.height, producerWidth: producer.width, producerHeight: producer.height },
    scope: 'Actual native captureStream and decoded Canvas2D RGBA8 only. No physical camera, default acquisition, encoded media, native FPS, calibration, orientation, capture freshness or clock mapping.' };
}
