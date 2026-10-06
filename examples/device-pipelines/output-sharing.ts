import { createApplicationViews, createBrowserApplicationAudio, createBrowserCameraProvider, createBrowserOutputSharing, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { BrowserApplicationAudio, BrowserApplicationAudioBinding, BrowserCameraEnvironment, BrowserOutputSharing, BrowserOutputSharingSource,
  DeliveryContext, DeviceRuntime, EndpointHandle, OutputSharingKind, OutputSharingPolicy, OutputSharingPolicyRequest, OutputSharingResourceRequest } from '@101/connect';

export interface OutputSharingExampleOptions {
  readonly ownerSignal: AbortSignal; readonly now?: () => number;
  /** Trusted software observer seams. They cannot establish resource permission. */
  readonly beforeApproval?: (request: OutputSharingPolicyRequest | OutputSharingResourceRequest) => void;
  readonly beforeUpstream?: () => void;
}
export type OutputSharingExampleConsent = 'native-audio' | 'native-camera' | 'upstream' | 'policy-audio' | 'policy-camera' | 'policy-application' |
  'source-audio-a' | 'source-audio-b' | 'source-camera' | 'source-app-a' | 'source-app-b' | 'sink-audio' | 'sink-camera' | 'sink-application';
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const live = (signal: AbortSignal): boolean => abortGetter.call(signal) === false;

/** Actual existing application-audio/camera/application-view producers, independent resource grants and
 * explicit policies. All native inputs are owned software fixtures. No devices, speakers, capture-time,
 * hardware camera controls, encoded delivery or malicious same-origin isolation is qualified. */
export function createOutputSharingExample(container: HTMLElement, options: OutputSharingExampleOptions) {
  const now = options.now ?? (() => performance.now()), owner = options.ownerSignal, own = new AbortController();
  const consentNames: OutputSharingExampleConsent[] = ['native-audio', 'native-camera', 'upstream', 'policy-audio', 'policy-camera', 'policy-application',
    'source-audio-a', 'source-audio-b', 'source-camera', 'source-app-a', 'source-app-b', 'sink-audio', 'sink-camera', 'sink-application'];
  const consent = new Map<OutputSharingExampleConsent, AbortController>();
  const nativeContexts: AudioContext[] = [], nativeNodes: AudioNode[] = [], oscillators: OscillatorNode[] = [], nativeStreams: MediaStream[] = [], audioBuses: BrowserApplicationAudio[] = [], bindings: BrowserApplicationAudioBinding[] = [];
  const registered: EndpointHandle[] = [], sections: HTMLElement[] = [], sourceSignals = new Map<string, AbortController>(), upstreamContexts = new Map<string, DeliveryContext>();
  let runtime: DeviceRuntime | undefined, bus: BrowserOutputSharing | undefined, camera: ReturnType<typeof createBrowserCameraProvider> | undefined, views: ReturnType<typeof createApplicationViews> | undefined;
  let opened = false, stopped = false, busy = false, opening: Promise<boolean> | undefined, closePromise: Promise<void> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let cameraProducerTimer: ReturnType<typeof setInterval> | undefined, cameraProducerDraws = 0;
  let cameraProducer: HTMLCanvasElement | undefined, cameraPaint: CanvasRenderingContext2D | null = null, frames = 0, engineTurns = 0, cameraBlue = false, viewAuthorizations = 0;
  let projectionPublications = 0, projectionPublicationReason: string | undefined;
  const appPrivate = 7711; let cameraSupported = false;
  let fixedExpiry = 0, reason: string | undefined, denyReview = false; const revisions = { audio: 0, camera: 0, application: 0 };
  function current() { if (stopped || !live(owner) || !live(own.signal)) return false; const at = now(); return !stopped && live(owner) && live(own.signal) && Number.isFinite(at) && at < fixedExpiry; }
  function allowed(name: OutputSharingExampleConsent) { const value = consent.get(name); return !!value && live(value.signal) && !stopped && live(owner) && live(own.signal); }
  function checked(request: OutputSharingPolicyRequest | OutputSharingResourceRequest) { options.beforeApproval?.(request); return current(); }
  function clearCameraProducerTimer() { if (cameraProducerTimer !== undefined) clearInterval(cameraProducerTimer); cameraProducerTimer = undefined; }
  function drawCamera() {
    try {
      if (!current() || !allowed('native-camera') || cameraProducerDraws >= 64 || !cameraPaint || !cameraProducer) { clearCameraProducerTimer(); return; }
      cameraProducerDraws++; cameraPaint.fillStyle = cameraBlue ? '#0000ff' : '#ff0000'; cameraPaint.fillRect(0, 0, 64, 48);
    } catch { clearCameraProducerTimer(); void stop(); }
  }
  function section(label: string) { const element = container.ownerDocument.createElement('section'); element.setAttribute('aria-label', label); sections.push(element); container.append(element); return element; }
  function nativeSourceSignal(id: string) { const signal = new AbortController(); sourceSignals.set(id, signal); return signal; }
  function policy(kind: OutputSharingKind, mode: OutputSharingPolicy['mode'], replacement = false): OutputSharingPolicy {
    if (kind === 'audio') { const inputs = [{ slotId: 'a' as const, sourceId: 'audio-a', principalId: 'recipient' }, { slotId: 'b' as const, sourceId: 'audio-b', principalId: 'recipient' }];
      if (mode === 'exclusive') return { kind, mode, inputs: [replacement ? inputs[1]! : inputs[0]!] };
      if (mode === 'duck') return { kind, mode, foreground: replacement ? 'b' : 'a', inputs };
      return { kind, mode: 'mix', inputs }; }
    if (kind === 'camera') return { kind, mode: 'observers', inputs: [{ slotId: 'a', sourceId: 'camera', principalId: 'observer-a' }, { slotId: 'b', sourceId: 'camera', principalId: 'observer-b' }] };
    return { kind, mode: mode === 'regions' ? 'regions' : 'layers', inputs: [{ slotId: 'a', sourceId: replacement ? 'app-b' : 'app-a', principalId: 'display-a' }, { slotId: 'b', sourceId: replacement ? 'app-a' : 'app-b', principalId: 'display-b' }] };
  }
  async function start(): Promise<boolean> {
    if (opening) return opening; if (stopped || opened || busy || !live(owner)) return false;
    // Explicit fixture producer permission is separate from output policy and route permission.
    if (!allowed('native-audio') || !allowed('native-camera') || !allowed('upstream')) { reason = 'producer-consent-required'; return false; }
    if (typeof AudioContext === 'undefined') { reason = 'unsupported'; return false; }
    cameraSupported = typeof HTMLCanvasElement.prototype.captureStream === 'function' && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
    busy = true; fixedExpiry = now() + 10000;
    let complete!: (value: boolean) => void; opening = new Promise<boolean>(resolve => { complete = resolve; });
    void (async () => {
      try {
        runtime = createDeviceRuntime({ now, clockDomain: 'sharing-host-retrieval', maxRegistrations: 24, maxRoutes: 16, maxSubscribers: 16, maxPendingDeliveries: 2,
          authorize(request) {
            if (!current()) return;
            if (request.applicationId === 'sharing-example' && request.sessionId === 'sharing-session' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write' &&
                request.principalId === 'upstream-recipient' && request.source.deviceId.startsWith('app:sharing-tone-') && request.sink.deviceId.startsWith('app:sharing-private-') && allowed('native-audio'))
              return { expiresAt: fixedExpiry, maxHz: 20, maxAgeMs: 250 };
            return bus?.controller.authorizeRoute(request);
          } });
        const sources: BrowserOutputSharingSource[] = [];
        for (const [index, label] of ['a', 'b'].entries()) {
          if (!current() || !allowed('native-audio')) throw Error('native-audio-revoked');
          const context = new AudioContext({ sampleRate: 48000 }); nativeContexts.push(context); const oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
          oscillator.frequency.value = index === 0 ? 480 : 960; gain.gain.value = index === 0 ? .2 : .4; oscillator.connect(gain); gain.connect(output); oscillator.start();
          oscillators.push(oscillator); nativeNodes.push(gain, output); nativeStreams.push(output.stream); await context.resume();
          if (!current() || !allowed('native-audio') || context.state !== 'running' || context.sampleRate !== 48000) throw Error('native-audio-unavailable');
          const nativeOwner = consent.get('native-audio')!;
          const audio = createBrowserApplicationAudio({ runtime, ownerSignal: own.signal, applicationId: 'sharing-example', sessionId: 'sharing-session', now,
            authorizeSource(request) { if (!current() || !allowed('native-audio') || request.ownerPrincipalId !== 'native-producer-' + label || request.recipientPrincipalId !== 'upstream-recipient') return;
              return { request, signal: nativeOwner.signal, grant: { expiresAt: fixedExpiry, maxHz: 20, maxAgeMs: 250 } }; },
            authorizeOutput(request) { if (!current() || !allowed('native-audio') || request.ownerPrincipalId !== 'upstream-recipient') return;
              return { request, signal: nativeOwner.signal, grant: { expiresAt: fixedExpiry, maxHz: 20, maxAgeMs: 250 } }; } }); audioBuses.push(audio);
          const source = audio.registerSource({ sourceId: 'app:sharing-tone-' + label, ownerPrincipalId: 'native-producer-' + label, producerNode: output, stream: output.stream });
          const resource = source && audio.resources(source); if (!source || !resource) throw Error('actual-native-audio-registration');
          const binding = audio.bind({ source, outputId: 'app:sharing-private-' + label, ownerPrincipalId: 'upstream-recipient', purpose: 'explicit-policy-input', signal: own.signal }); bindings.push(binding);
          if (!await binding.ready || !current() || !binding.output()) throw Error('actual-private-audio-route');
          const signal = nativeSourceSignal('audio-' + label);
          sources.push({ id: 'audio-' + label, ownerId: 'source-audio-' + label, kind: 'audio', signal: signal.signal, device: resource.device, handle: resource.audio, capability: 'audio', audio: () => binding.output(),
            upstream() { const observedBeforeCallout = binding.status().state === 'active' && allowed('native-audio');
              options.beforeUpstream?.(); return observedBeforeCallout && allowed('native-audio') && live(signal.signal); } });
        }
        if (cameraSupported) {
        if (!current() || !allowed('native-camera')) throw Error('native-camera-revoked');
        cameraProducer = container.ownerDocument.createElement('canvas'); cameraProducer.width = 64; cameraProducer.height = 48; cameraPaint = cameraProducer.getContext('2d');
        if (!cameraPaint) throw Error('native-camera-raster'); drawCamera();
        const stream = cameraProducer.captureStream(10); nativeStreams.push(stream); const track = stream.getVideoTracks()[0]; if (!track) throw Error('native-camera-track');
        // An actual decoded first frame requires producer work during activation, before caller tick is available.
        cameraProducerTimer = setInterval(drawCamera, 100);
        const selection = track.getSettings().deviceId ?? 'owned-sharing-canvas', captureConsent = consent.get('native-camera')!;
        const environment: BrowserCameraEnvironment = { fixtureKind: 'owned-canvas-fixture', enumerateDevices: async () => [{ kind: 'videoinput', deviceId: selection }],
          async getUserMedia(constraints) { if (!current() || !allowed('native-camera') || JSON.stringify(constraints) !== JSON.stringify({ video: { deviceId: { exact: selection }, width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 10, max: 15 } }, audio: false })) throw Error('owned-exact-camera-selection'); return stream; },
          createVideo: () => container.ownerDocument.createElement('video'), createCanvas: () => container.ownerDocument.createElement('canvas'), MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData,
          target: window, document, mediaDevicesTarget: new EventTarget(), hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext };
        camera = createBrowserCameraProvider({ runtime, ownerSignal: own.signal, now, scope: { principalId: 'native-camera-owner', applicationId: 'sharing-example', sessionId: 'sharing-session' }, environment,
          authorizeCapture(request) { if (!current() || !allowed('native-camera')) return; return { request, expiresAt: fixedExpiry, signal: captureConsent.signal }; } });
        const inventory = await camera.inspect(); if (!current() || !inventory.ok || inventory.value.length !== 1) throw Error('owned-camera-selection');
        const activation = await camera.start(inventory.value[0]!.selection, { purpose: 'read-only-policy-observers' }); if (!current() || !activation.ok) throw Error('actual-camera-provider-start:' + (activation.ok ? 'cancelled' : activation.reason));
        const cameraSignal = nativeSourceSignal('camera'); sources.push({ id: 'camera', ownerId: 'source-camera', kind: 'camera', signal: cameraSignal.signal, device: activation.value.device, handle: activation.value.source, capability: 'camera-frame' });
        }
        const value = { type: 'record' as const, fields: { shade: { type: 'scalar' as const, unit: '1', min: 0, max: 255 }, alpha: { type: 'scalar' as const, unit: '1', min: 0, max: 1 } } };
        for (const label of ['a', 'b']) { const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'app:sharing-view-' + label, label: 'Reviewed projected view', revision: 1,
          adapter: { id: 'connect:application-views', version: '1.0.0' }, runtime: { platform: 'browser-local' }, capabilities: [{ id: 'view', semantic: 'connect:application-view', schemaVersion: 1,
            kind: 'sample', value, delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['subscribe'] }] });
          const handle = runtime.registerSource({ device, capability: 'view' }); registered.push(handle); runtime.setReadiness(handle, 'available');
          const signal = nativeSourceSignal('app-' + label); sources.push({ id: 'app-' + label, ownerId: 'source-app-' + label, kind: 'application', signal: signal.signal, device, handle, capability: 'view',
            upstream() { options.beforeUpstream?.(); const context = upstreamContexts.get(label); return !!context && live(context.signal) && context.isCurrent() && allowed('upstream'); } }); }
        views = createApplicationViews({ applicationId: 'sharing-example', sessionId: 'sharing-session', now, clockDomain: 'sharing-application-turn',
          engine: { step() { return { frame: ++engineTurns, private: appPrivate, first: 64, second: 192 }; }, stop() {} },
          views: [{ id: 'a', value, project: state => ({ shade: (state as { first: number }).first, alpha: 1 }) }, { id: 'b', value, project: state => ({ shade: (state as { second: number }).second, alpha: .5 }) }],
          authorize(request) { if (!current() || !allowed('upstream') || request.principalId !== 'projection-owner' || request.applicationId !== 'sharing-example' || request.sessionId !== 'sharing-session' || !['a', 'b'].includes(request.viewId)) return;
            viewAuthorizations++; return { expiresAt: fixedExpiry, maxHz: 20, maxAgeMs: 250 }; } });
        for (const label of ['a', 'b']) { const handle = sources.find(source => source.id === 'app-' + label)!.handle;
          const attached = views.attach({ viewId: label, outputId: 'sharing-' + label, principalId: 'projection-owner', apply(observation, context) {
            if (!current() || !allowed('upstream') || !context.isCurrent() || !live(context.signal)) return; upstreamContexts.set(label, context);
            if (observation.clockDomain !== 'sharing-application-turn' || !Number.isSafeInteger(observation.sequence) || observation.sequence < 0 ||
                !Number.isFinite(observation.timestamp) || observation.timestamp < 0 || observation.timestamp > Number.MAX_SAFE_INTEGER ||
                !['valid', 'unavailable', 'stale'].includes(observation.quality)) return;
            // A new local retrieval observation, with the original projection clock retained as unmapped provenance.
            // Neither the projection timestamp nor sequence is converted into this runtime's host clock/domain.
            const published = runtime!.publish(handle, observation.value, { quality: observation.quality, provenance: {
              kind: 'trusted-application-projection', sourceClockDomain: observation.clockDomain, sourceTimestamp: observation.timestamp,
              sourceSequence: observation.sequence, sourceQuality: observation.quality, clockMappingEstablished: false, captureTimeKnown: false,
              timestampMeaning: 'local-host-retrieval' } });
            projectionPublications++; if (!published.ok) projectionPublicationReason = published.reason;
          }, release() { upstreamContexts.delete(label); sourceSignals.get('app-' + label)?.abort(); } }); if (!attached.ok) throw Error('actual-authorized-application-view'); }
        if (!current()) throw Error('cancelled-before-output');
        const cameraContainer = cameraSupported ? section('Camera observers') : undefined, appContainer = section('Application layers or regions');
        bus = createBrowserOutputSharing({ runtime, ownerSignal: own.signal, applicationId: 'sharing-example', sessionId: 'sharing-session', now, sources,
          destinations: [{ id: 'audio', ownerId: 'output-owner', kind: 'audio' }, ...(cameraContainer ? [{ id: 'camera', ownerId: 'output-owner', kind: 'camera' as const, container: cameraContainer }] : []), { id: 'application', ownerId: 'output-owner', kind: 'application', container: appContainer }],
          authorizePolicy(request) { if (!checked(request) || request.ownerId !== 'output-owner' || request.applicationId !== 'sharing-example' || request.sessionId !== 'sharing-session') return;
            if (denyReview) { denyReview = false; return; }
            const flag = ('policy-' + request.destinationId) as OutputSharingExampleConsent, signal = consent.get(flag)?.signal; if (!allowed(flag) || !signal) return; return { request, expiresAt: fixedExpiry, signal }; },
          authorizeSource(request) { if (!checked(request) || request.side !== 'source' || request.route.sourceOperation !== 'subscribe' || request.route.sinkOperation !== 'write') return;
            const flag = request.ownerId as OutputSharingExampleConsent, signal = consent.get(flag)?.signal; if (!allowed(flag) || !signal) return; return { request, expiresAt: fixedExpiry, maxHz: 5, maxAgeMs: 250, signal }; },
          authorizeSink(request) { if (!checked(request) || request.side !== 'sink' || request.ownerId !== 'output-owner') return;
            const flag = ('sink-' + request.destinationId) as OutputSharingExampleConsent, signal = consent.get(flag)?.signal; if (!allowed(flag) || !signal) return; return { request, expiresAt: fixedExpiry, maxHz: 5, maxAgeMs: 250, signal }; } });
        if (!current()) throw Error('cancelled-after-output'); opened = true; reason = undefined;
        expiry = setTimeout(() => { expiry = undefined; void stop(); }, Math.max(1, fixedExpiry - now())); return true;
      } catch (error) { reason = error instanceof Error ? error.message : 'fixture-failed'; await cleanup(); return false; }
      finally { busy = false; }
    })().then(complete, () => complete(false)); return opening;
  }
  function change(kind: OutputSharingKind, mode: OutputSharingPolicy['mode'], replacement = false) {
    if (!current() || !bus) return false; const result = bus.select(kind, revisions[kind], policy(kind, mode, replacement)); if (!result.ok) return false;
    revisions[kind] = result.value; return bus.start(kind);
  }
  function tick() { if (!current() || !runtime || ++frames > 64) return false;
    views?.tick(); runtime.flush(); return true; }
  async function cleanup() {
    clearCameraProducerTimer();
    if (expiry !== undefined) clearTimeout(expiry); expiry = undefined; own.abort();
    if (bus) await bus.close(); views?.stop(); if (camera) await camera.close(); for (const audio of audioBuses) await audio.close();
    for (const oscillator of oscillators.splice(0)) { try { oscillator.stop(); oscillator.disconnect(); } catch { /* Caller-owned fixture may already be stopped. */ } }
    for (const node of nativeNodes.splice(0)) node.disconnect(); for (const stream of nativeStreams) stream.getTracks().forEach(track => track.stop());
    for (const context of nativeContexts) if (context.state !== 'closed') await context.close(); for (const handle of registered.splice(0)) runtime?.unregister(handle); runtime?.close();
    cameraPaint = null; if (cameraProducer) cameraProducer.width = cameraProducer.height = 1; for (const element of sections.splice(0)) element.remove();
  }
  async function stop() { if (closePromise) return closePromise; stopped = true; own.abort();
    closePromise = (async () => { if (opening) await opening; await cleanup(); })(); return closePromise; }
  const abort = () => { void stop(); }; EventTarget.prototype.addEventListener.call(owner, 'abort', abort, { once: true });
  return Object.freeze({ start, change, tick,
    denyNextPolicyReview() { denyReview = true; },
    setConsent(name: OutputSharingExampleConsent, value: boolean) { if (!consentNames.includes(name) || stopped) return false; const previous = consent.get(name);
      if (!value) { previous?.abort(); consent.delete(name); if (name === 'native-audio' || name === 'native-camera' || name === 'upstream') void stop(); }
      else if (!previous || !live(previous.signal)) consent.set(name, new AbortController()); return true; },
    setCameraBlue(value: boolean) { cameraBlue = value; }, output: () => bus?.output('audio'),
    conflict(kind: OutputSharingKind) { if (!bus) return false; const existing = bus.controller.plan(kind); if (!existing) return false;
      const input = existing.policy.inputs[0]!; return bus.select(kind, existing.revision, { ...existing.policy, inputs: [input, input] } as OutputSharingPolicy).ok; },
    revokeObserver(slot: 'a' | 'b') { const route = bus?.controller.plan('camera'); if (!route) return false;
      // Select a reviewed plan for the retained observer. Capture owner and producer remain unchanged.
      const inputs = route.policy.inputs.filter(input => input.slotId !== slot); if (!inputs.length) return false;
      const result = bus!.select('camera', route.revision, { kind: 'camera', mode: 'observers', inputs }); if (!result.ok) return false; revisions.camera = result.value; return bus!.start('camera'); },
    snapshot() { return { opened, stopped, reason, frames, engineTurns, viewAuthorizations, projectionPublications, projectionPublicationReason, cameraSupported, borrowedPrivateValueExposed: false, sharing: bus?.snapshot() ?? null,
      producerContexts: nativeContexts.map(context => context.state), producerTracks: nativeStreams.map(stream => stream.getTracks().map(track => track.readyState)),
      camera: camera?.snapshot() ?? null, cameraProducerDraws, cameraProducerTimers: cameraProducerTimer === undefined ? 0 : 1,
      audio: audioBuses.map(audio => audio.snapshot()), revisions: { ...revisions }, expiryTimers: expiry === undefined ? 0 : 1,
      provenance: { nativeCaptureClock: 'unknown', audioCaptureClock: 'unknown', hardwareInput: false, speakerOutput: false, maliciousHostIsolation: false } }; },
    async stop() { EventTarget.prototype.removeEventListener.call(owner, 'abort', abort); await stop(); } });
}
