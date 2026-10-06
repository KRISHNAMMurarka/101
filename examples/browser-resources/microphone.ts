import { createBrowserMicrophoneProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserMicrophoneCaptureGrant, BrowserMicrophoneCaptureRequest, BrowserMicrophoneEnvironment, Observation } from '@101/connect';

export function createBrowserMicrophonePipeline(options: { ownerSignal: AbortSignal;
  authorizeCapture: (request: BrowserMicrophoneCaptureRequest) => BrowserMicrophoneCaptureGrant | undefined;
  authorizeRoutes: Authorize; now?: () => number; environment?: BrowserMicrophoneEnvironment }) {
  const now = options.now ?? (() => performance.now()), scope = { principalId: 'microphone-owner', applicationId: 'microphone-example', sessionId: 'microphone-session' };
  const runtime = createDeviceRuntime({ now, clockDomain: 'microphone-javascript-retrieval', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserMicrophoneProvider({ runtime, now, ownerSignal: options.ownerSignal, scope, authorizeCapture: options.authorizeCapture,
    ...(options.environment ? { environment: options.environment } : {}) });
  let latest: Observation | undefined, delivered = 0, released = 0;
  const routes: ReturnType<typeof runtime.route>[] = [], sinks: ReturnType<typeof runtime.registerSink>[] = [];
  return { provider,
    async activate(selection: Parameters<typeof provider.start>[0], purpose: string) {
      const started = await provider.start(selection, { purpose }); if (!started.ok) return started;
      const device = parseDeviceDescriptor({ ...started.value.device, id: started.value.device.id + ':consumer', capabilities: started.value.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
      const sink = runtime.registerSink({ device, capability: 'envelope', apply(observation, context) { if (!context.signal.aborted && context.isCurrent()) { latest = observation; delivered++; } }, release() { latest = undefined; released++; } }); sinks.push(sink);
      runtime.setReadiness(sink, 'available'); const route = runtime.route({ from: started.value.source, to: sink, ...scope, leaseMs: 5000 }); routes.push(route);
      const admitted = route.start(); if (!admitted.ok) { provider.stop(); runtime.unregister(sink); return { ok: false as const, reason: 'denied' as const }; }
      return started;
    }, tick() { runtime.flush(); }, state() { return { latest, delivered, released }; },
    async close() { await provider.close(); for (const route of routes.splice(0)) route.stop('microphone-close'); for (const sink of sinks.splice(0)) runtime.unregister(sink); runtime.close(); } };
}

/** No user microphone acquisition. Policy readback and native constraint/permission
 * rejection are distinct; unknown supported features keep the default inert. */
export async function checkBrowserMicrophoneWithoutDevice() {
  type NativePolicy = { allowsFeature(name: string): boolean; features?: () => string[] };
  const policy = document as Document & { permissionsPolicy?: NativePolicy; featurePolicy?: NativePolicy };
  let policyFeatureRecognized = false, policyDenied = false;
  try {
    const nativePolicy = policy.permissionsPolicy ?? policy.featurePolicy, supported = nativePolicy?.features?.();
    policyFeatureRecognized = Array.isArray(supported) && supported.length <= 128 && supported.every(feature => typeof feature === 'string') && supported.includes('microphone');
    policyDenied = policyFeatureRecognized && nativePolicy?.allowsFeature('microphone') === false;
  } catch { /* Unknown features do not establish enforced native policy. */ }
  const owner = new AbortController(); let captureApprovals = 0;
  const pipeline = createBrowserMicrophonePipeline({ ownerSignal: owner.signal, authorizeRoutes: () => undefined,
    authorizeCapture() { captureApprovals++; return undefined; } });
  const initial = pipeline.provider.snapshot(), forged = await pipeline.provider.start({}, { purpose: 'no-issued-device' });
  const native = { mediaDevicesAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function', policyFeatureRecognized, policyDenied,
    defaultNativeOpens: 0, nativeDenied: false, nativePolicyDenialQualified: false, nativeRejection: 'not-issued' };
  try {
    // This is an actual negative native API check only. No issued SDK selection is invented.
    if (policyDenied && native.mediaDevicesAvailable) {
      native.defaultNativeOpens++;
      let unexpected: MediaStream | undefined, fulfilled = false;
      try { unexpected = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: 'owned-policy-negative-no-device' } }, video: false }); fulfilled = true; }
      catch (error) {
        native.nativeRejection = 'unclassified';
        if (error instanceof DOMException) {
          if (error.name === 'OverconstrainedError') native.nativeRejection = 'constraints';
          else if (error.name === 'NotFoundError') native.nativeRejection = 'device-unavailable';
          else if (['NotAllowedError', 'SecurityError'].includes(error.name)) {
            native.nativeRejection = 'permission'; native.nativeDenied = true; native.nativePolicyDenialQualified = true;
          }
        }
      }
      finally { unexpected?.getTracks().forEach(track => track.stop()); }
      if (fulfilled) throw new Error('Native capture unexpectedly succeeded');
    }
  } finally { owner.abort(); await pipeline.close(); }
  return { kind: 'actual-native-availability-policy-readback', physicalMicrophoneQualification: false, native, initial, forged, captureApprovals, final: pipeline.provider.snapshot(), positiveHardwareEvidence: false };
}

/** Genuine owned native Web Audio signal, not a physical microphone or acoustic proof.
 * Call from a gesture on the disposable owned headless page. No speaker destination. */
export async function runOwnedBrowserAudioFixture() {
  if (typeof AudioContext !== 'function' || typeof MediaStream !== 'function') return { kind: 'owned-native-audio-fixture', result: 'unsupported', positiveHardwareEvidence: false };
  const producer = new AudioContext(), owner = new AbortController(), capture = new AbortController();
  const oscillator = producer.createOscillator(), gain = producer.createGain(), destination = producer.createMediaStreamDestination();
  oscillator.frequency.value = 440; gain.gain.value = 0.25; oscillator.connect(gain); gain.connect(destination); oscillator.start();
  let opens = 0, approvals = 0, consumerContexts = 0, consumerContext: AudioContext | undefined;
  const selectedId = destination.stream.getAudioTracks()[0]!.getSettings().deviceId ?? 'owned-native-audio-destination';
  const environment: BrowserMicrophoneEnvironment = { fixtureKind: 'owned-audio-fixture',
    enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', deviceId: selectedId }]),
    getUserMedia(constraints) { opens++; if (JSON.stringify(constraints) !== JSON.stringify({ audio: { deviceId: { exact: selectedId } }, video: false })) throw new Error('Exact owned source selection required'); return Promise.resolve(destination.stream); },
    createAudioContext() { consumerContexts++; consumerContext = new AudioContext(); return consumerContext; }, MediaStream, AudioContext,
    target: window, document, mediaDevicesTarget: new EventTarget(), hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext };
  const pipeline = createBrowserMicrophonePipeline({ ownerSignal: owner.signal, environment,
    authorizeCapture(request) { approvals++; return { request, signal: capture.signal, expiresAt: performance.now() + 5000 }; },
    authorizeRoutes(request) { if (request.principalId === 'microphone-owner' && request.applicationId === 'microphone-example' && request.sessionId === 'microphone-session' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: performance.now() + 5000, maxAgeMs: 250, maxHz: 20 }; } });
  const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function until(predicate: () => boolean) { const deadline = performance.now() + 2000; while (!predicate() && performance.now() < deadline) { await wait(20); pipeline.tick(); } if (!predicate()) throw new Error('Owned native envelope did not reach expected state'); }
  let tone: ReturnType<typeof pipeline.state>, silence: ReturnType<typeof pipeline.state>, retired: ReturnType<typeof pipeline.state>;
  try {
    await producer.resume(); const inventory = await pipeline.provider.inspect(); if (!inventory.ok || inventory.value.length !== 1) throw new Error('Owned native inventory unavailable');
    const started = await pipeline.activate(inventory.value[0]!.selection, 'owned-native-audio-envelope'); if (!started.ok) throw new Error('Owned native capture unavailable: ' + started.reason);
    await until(() => Number((pipeline.state().latest?.value as { rms?: number } | undefined)?.rms) > 0.05); tone = pipeline.state();
    gain.gain.value = 0; await until(() => pipeline.state().delivered > tone.delivered && Number((pipeline.state().latest?.value as { peak?: number } | undefined)?.peak) < 0.001); silence = pipeline.state();
    capture.abort(); retired = pipeline.state(); if (retired.latest !== undefined || retired.released < 1) throw new Error('Granted sink was not released');
  } finally {
    owner.abort(); await pipeline.close(); oscillator.stop(); oscillator.disconnect(); gain.disconnect(); destination.disconnect(); destination.stream.getTracks().forEach(track => track.stop()); await producer.close();
  }
  return { kind: 'owned-native-audio-fixture', result: 'pass', positiveHardwareEvidence: false, opens, approvals, consumerContexts,
    producerSampleRate: producer.sampleRate, tone: tone!, silence: silence!, retired: retired!,
    cleanup: { provider: pipeline.provider.snapshot(), producerState: producer.state, consumerState: consumerContext?.state, tracksEnded: destination.stream.getTracks().every(track => track.readyState === 'ended') },
    scope: 'Actual native oscillator/audio-destination and analyser digital amplitude only; no physical microphone, acoustic calibration, playback, capture clock or mapping.' };
}
