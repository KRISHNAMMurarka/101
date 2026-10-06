import { createBrowserScreenPreviewProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserScreenPreviewCaptureGrant, BrowserScreenPreviewCaptureRequest, BrowserScreenPreviewEnvironment,
  BrowserScreenPreviewFacts, BrowserScreenPreviewFrame, Observation } from '@101/connect';

export interface BrowserScreenPreviewPipelineOptions {
  readonly ownerSignal: AbortSignal;
  readonly authorizeCapture: (request: BrowserScreenPreviewCaptureRequest) => BrowserScreenPreviewCaptureGrant | undefined;
  readonly authorizeRoutes: Authorize; readonly now?: () => number; readonly environment?: BrowserScreenPreviewEnvironment;
  /** Caller-owned exact 8x8 display. This is a downsized preview, not HD/full capture. */
  readonly preview: HTMLCanvasElement;
}
export function createBrowserScreenPreviewPipeline(options: BrowserScreenPreviewPipelineOptions) {
  if (options.preview.width !== 8 || options.preview.height !== 8) throw new TypeError('Declare an exact downsized 8x8 preview');
  const paint = options.preview.getContext('2d'); if (!paint) throw new TypeError('Preview raster unavailable');
  const now = options.now ?? (() => performance.now()), scope = { principalId: 'screen-owner', applicationId: 'screen-example', sessionId: 'screen-session' };
  const runtime = createDeviceRuntime({ now, clockDomain: 'screen-javascript-retrieval', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserScreenPreviewProvider({ runtime, now, ownerSignal: options.ownerSignal, scope, authorizeCapture: options.authorizeCapture, ...(options.environment ? { environment: options.environment } : {}) });
  let latest: Observation | undefined, delivered = 0, released = 0, closed = false, closing: Promise<void> | undefined;
  let route: ReturnType<typeof runtime.route> | undefined, sink: ReturnType<typeof runtime.registerSink> | undefined;
  function release() { latest = undefined; paint!.clearRect(0, 0, 8, 8); released++; }
  function detach() { route?.stop('screen-preview-stop'); route = undefined; if (sink) { runtime.unregister(sink); sink = undefined; } }
  return { provider,
    async activate(purpose: string) {
      if (closed || options.ownerSignal.aborted) return { ok: false as const, reason: 'closed' as const };
      if (provider.snapshot().activeSources || provider.snapshot().rawPending) return { ok: false as const, reason: 'busy' as const };
      detach(); const started = await provider.start({ purpose }); if (!started.ok) return started;
      if (closed || options.ownerSignal.aborted || provider.snapshot().activeSources !== 1) { provider.stop(); return { ok: false as const, reason: 'cancelled' as const }; }
      const device = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':preview', capabilities: started.value.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
      sink = runtime.registerSink({ device, capability: 'screen-preview', apply(observation, context) {
        if (context.signal.aborted || !context.isCurrent()) return;
        const frame = observation.value as unknown as BrowserScreenPreviewFrame, bytes = new Uint8ClampedArray(256);
        for (let row = 0; row < 8; row++) bytes.set(frame.rows[row]!, row * 32);
        const image = new ImageData(bytes, 8, 8); if (context.signal.aborted || !context.isCurrent()) { bytes.fill(0); return; }
        paint!.putImageData(image, 0, 0); bytes.fill(0); if (context.signal.aborted || !context.isCurrent()) { release(); return; }
        latest = observation; delivered++;
      }, release }); runtime.setReadiness(sink, 'available');
      route = runtime.route({ from: started.value.source, to: sink, ...scope, leaseMs: 10000 });
      if (!route.start().ok) { provider.stop(); detach(); return { ok: false as const, reason: 'denied' as const }; } return started;
    }, tick() { runtime.flush(); }, stop() { provider.stop(); detach(); }, state() { return { latest, delivered, released }; },
    close(): Promise<void> {
      if (closing) return closing; let resolve!: () => void; closing = new Promise<void>(done => { resolve = done; }); closed = true;
      const pending = provider.close(); detach(); runtime.close(); void pending.then(resolve); return closing;
    } };
}

/** Native API and policy readback only; no chooser, OS screen capture or permission enforcement proof. */
export async function checkBrowserScreenPreviewWithoutCapture() {
  type Policy = { features?: () => string[]; allowsFeature(name: string): boolean };
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };
  let recognized = false, denied: boolean | undefined;
  try { const policy = doc.permissionsPolicy ?? doc.featurePolicy, features = policy?.features?.(); recognized = Array.isArray(features) && features.length <= 128 && features.every(item => typeof item === 'string') && features.includes('display-capture'); if (recognized) denied = policy!.allowsFeature('display-capture') === false; } catch { /* Unknown readback, no chooser. */ }
  const owner = new AbortController(), runtime = createDeviceRuntime({ now: () => performance.now(), authorize: () => undefined }); let approvals = 0;
  const provider = createBrowserScreenPreviewProvider({ runtime, now: () => performance.now(), ownerSignal: owner.signal,
    scope: { principalId: 'screen-negative', applicationId: 'screen-negative', sessionId: 'screen-negative' }, authorizeCapture() { approvals++; return undefined; } });
  const initial = provider.snapshot(); let invalid;
  try { invalid = await provider.start({ purpose: 'invalid purpose' }); }
  finally { owner.abort(); await provider.close(); runtime.close(); }
  return { kind: 'actual-native-display-api-policy-readback', nativeScreenCaptureQualified: false, positiveHardwareEvidence: false,
    native: { displayMediaAvailable: typeof navigator.mediaDevices?.getDisplayMedia === 'function', policyFeatureRecognized: recognized, policyDeniedReadback: denied, defaultNativeOpens: 0, nativePolicyDenialQualified: false }, initial, invalid, captureApprovals: approvals, final: provider.snapshot() };
}

/** Owned canvas→native captureStream→decoded video→downsized typed screen semantic.
 * The explicit digital display factory is not an OS screen/chooser or native permission positive. */
export async function runOwnedBrowserScreenPreviewFixture() {
  if (typeof HTMLCanvasElement !== 'function' || typeof HTMLCanvasElement.prototype.captureStream !== 'function' || typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function') return { kind: 'owned-native-canvas-screen-fixture', result: 'unsupported', positiveHardwareEvidence: false };
  const producer = document.createElement('canvas'), preview = document.createElement('canvas'); producer.width = 64; producer.height = 48; preview.width = 8; preview.height = 8;
  const paint = producer.getContext('2d'), readback = preview.getContext('2d'); if (!paint || !readback) throw new Error('Owned native canvas unavailable');
  let blue = false, producerFrames = 0;
  const draw = () => { if (++producerFrames > 80) return; paint.fillStyle = blue ? '#0000ff' : '#ff0000'; paint.fillRect(0, 0, producer.width, producer.height); }; draw();
  const stream = producer.captureStream(10), track = stream.getVideoTracks()[0]; if (!track) throw new Error('Owned native video track unavailable');
  const timer = setInterval(draw, 100), owner = new AbortController(), capture = new AbortController();
  let opens = 0, approvals = 0, videos = 0, sampledCanvas: HTMLCanvasElement | undefined, video: HTMLVideoElement | undefined;
  const environment: BrowserScreenPreviewEnvironment = { fixtureKind: 'owned-canvas-fixture',
    getDisplayMedia(constraints) { opens++; if (JSON.stringify(constraints) !== JSON.stringify({ video: true, audio: false })) throw new Error('Fixed video-only display options required'); return Promise.resolve(stream); },
    createVideo() { videos++; video = document.createElement('video'); return video; }, createCanvas() { sampledCanvas = document.createElement('canvas'); return sampledCanvas; }, MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData,
    target: window, document, hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext, userActivation: () => navigator.userActivation?.isActive === true };
  const pipeline = createBrowserScreenPreviewPipeline({ ownerSignal: owner.signal, environment, preview,
    authorizeCapture(request) { approvals++; return { request, signal: capture.signal, expiresAt: performance.now() + 10000 }; },
    authorizeRoutes(request) { if (request.principalId === 'screen-owner' && request.applicationId === 'screen-example' && request.sessionId === 'screen-session' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: performance.now() + 10000, maxAgeMs: 250, maxHz: 10 }; } });
  function color(channel: number) { const frame = pipeline.state().latest?.value as unknown as BrowserScreenPreviewFrame | undefined;
    return frame && frame.rows.every(row => row.every((value, index) => index % 4 === channel ? value >= 240 : index % 4 === 3 ? value >= 240 : value <= 16)); }
  function rendered(channel: number) { return Array.from(readback!.getImageData(0, 0, 8, 8).data).every((value, index) => index % 4 === channel || index % 4 === 3 ? value >= 240 : value <= 16); }
  async function until(predicate: () => boolean) { const deadline = performance.now() + 2000; while (!predicate() && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); pipeline.tick(); } if (performance.now() >= deadline || !predicate()) throw new Error('Owned downsized raster did not reach expected state'); }
  let red: ReturnType<typeof pipeline.state>, changed: ReturnType<typeof pipeline.state>, retired: ReturnType<typeof pipeline.state>, facts: BrowserScreenPreviewFacts | undefined;
  try {
    const started = await pipeline.activate('owned-native-canvas-screen-preview'); if (!started.ok) throw new Error('Owned display factory unavailable: ' + started.reason); facts = started.value.facts;
    await until(() => color(0) === true && rendered(0)); red = pipeline.state(); blue = true; draw();
    await until(() => pipeline.state().delivered > red.delivered && color(2) === true && rendered(2)); changed = pipeline.state();
    // Native canvas stream changes dimensions. Provider must retire before replacement-size pixels enter its old scope.
    producer.width = 80; producer.height = 60; draw();
    await until(() => pipeline.provider.snapshot().activeSources === 0); retired = pipeline.state();
    if (pipeline.provider.snapshot().reason !== 'changed' || retired.latest !== undefined || retired.released < 1 || Array.from(readback.getImageData(0, 0, 8, 8).data).some(value => value !== 0)) throw new Error('Resize did not retire the exact downsized preview');
  } finally { clearInterval(timer); owner.abort(); await pipeline.close(); stream.getTracks().forEach(native => native.stop()); producer.width = 1; producer.height = 1; producer.remove(); preview.remove(); }
  return { kind: 'owned-native-canvas-screen-fixture', result: 'pass', positiveHardwareEvidence: false, nativeScreenCaptureQualified: false, opens, approvals, videos, producerFrames, facts,
    renderer: { declaredDownsized: true, width: 8, height: 8, retainsFullCaptureRaster: false }, red: red!, changed: changed!, retired: retired!,
    cleanup: { provider: pipeline.provider.snapshot(), tracksEnded: stream.getTracks().every(native => native.readyState === 'ended'), videoDetached: video?.srcObject === null, videoConnected: video?.isConnected === true,
      sampledWidth: sampledCanvas?.width, sampledHeight: sampledCanvas?.height, producerWidth: producer.width, producerHeight: producer.height, previewConnected: preview.isConnected },
    scope: 'Actual owned digital captureStream, native video decode and downsized Canvas2D RGBA8 plus resize release through separately granted SDK route. No OS display chooser, selected monitor positive, native permission enforcement, HD streaming, cursor/input mapping, capture freshness or clock mapping.' };
}
