import { createBrowserApplicationAudio, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserApplicationAudioOptions, BrowserApplicationAudioEnvironment, Observation } from '@101/connect';

/** Ordinary SDK-only host caller. The borrowed stream is an explicit application producer;
 * source/output owner approvals and diagnostic/resource route grants remain independent. */
export function createPrivateApplicationAudioPipeline(options: {
  ownerSignal: AbortSignal; authorizeSource: BrowserApplicationAudioOptions['authorizeSource']; authorizeOutput: BrowserApplicationAudioOptions['authorizeOutput'];
  authorizeRoutes: Authorize; now?: () => number; environment?: BrowserApplicationAudioEnvironment;
}) {
  const now = options.now ?? (() => performance.now());
  const runtime = createDeviceRuntime({ now, clockDomain: 'application-audio-javascript-retrieval', authorize: options.authorizeRoutes,
    maxRegistrations: 5, maxRoutes: 3, maxSubscribers: 3, maxPendingDeliveries: 3 });
  const bus = createBrowserApplicationAudio({ runtime, ownerSignal: options.ownerSignal, applicationId: 'private-audio-example', sessionId: 'private-audio-session', now,
    authorizeSource: options.authorizeSource, authorizeOutput: options.authorizeOutput, ...(options.environment ? { environment: options.environment } : {}) });
  let latest: Observation | undefined, delivered = 0, released = 0;
  const diagnostics: { route: ReturnType<typeof runtime.route>; sink: ReturnType<typeof runtime.registerSink> }[] = [];
  return { bus,
    subscribeLevels(source: Parameters<typeof bus.resources>[0]) {
      if (diagnostics.length) return false;
      const resources = bus.resources(source); if (!resources) return false;
      const device = parseDeviceDescriptor({ ...resources.device, id: 'app:audio-levels', capabilities: resources.device.capabilities.filter(c => c.id === 'levels').map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
      const sink = runtime.registerSink({ device, capability: 'levels', apply(observation, context) { if (!context.signal.aborted && context.isCurrent()) { latest = observation; delivered++; } }, release() { latest = undefined; released++; } });
      runtime.setReadiness(sink, 'available'); const route = runtime.route({ from: resources.levels, to: sink, principalId: 'diagnostic-reader', applicationId: 'private-audio-example', sessionId: 'private-audio-session', leaseMs: 30000 });
      diagnostics.push({ sink, route }); const admitted = route.start(); if (!admitted.ok) { route.stop('denied'); runtime.unregister(sink); diagnostics.pop(); return false; } return true;
    }, levels: () => ({ latest, delivered, released }),
    async close() { await bus.close(); for (const { route, sink } of diagnostics.splice(0)) { route.stop('audio-close'); runtime.unregister(sink); } runtime.close(); }
  };
}

/** Actual default construction/availability only. No device acquisition or speaker output,
 * and a copied/forged source never reaches any native audio factory. */
export async function checkPrivateAudioWithoutProducer() {
  const owner = new AbortController(); let approvals = 0;
  const pipeline = createPrivateApplicationAudioPipeline({ ownerSignal: owner.signal, authorizeRoutes: () => undefined,
    authorizeSource() { approvals++; return undefined; }, authorizeOutput() { approvals++; return undefined; } });
  const initial = pipeline.bus.snapshot();
  const forged = pipeline.bus.bind({ source: {}, outputId: 'app:no-source', ownerPrincipalId: 'unapproved-recipient', purpose: 'inert-negative', signal: new AbortController().signal });
  const ready = await forged.ready; await pipeline.close();
  return { kind: 'actual-native-inert-availability', audioContextAvailable: typeof AudioContext === 'function', mediaStreamAvailable: typeof MediaStream === 'function',
    initial, forgedReady: ready, approvals, final: pipeline.bus.snapshot(), deviceAcquisitions: 0, speakerConnections: 0, hardwareEvidence: false };
}

/** Genuine native oscillator -> borrowed private stream -> SDK-approved native output ->
 * independent native analyser. All contexts stay disconnected from speakers. Call only
 * from an owned page gesture; 48kHz/two-channel destination-node graph is accepted from actual native facts.
 * Native analyser downmix is diagnostic; missing emitted track metadata stays unknown. */
export async function runOwnedPrivateApplicationAudioFixture() {
  const kind = 'owned-native-private-application-audio';
  if (typeof AudioContext !== 'function' || typeof MediaStream !== 'function' || typeof MediaStreamTrack !== 'function') return { kind, result: 'unsupported', hardwareEvidence: false, reason: 'native-api-unavailable' };
  const producer = new AudioContext({ sampleRate: 48000 }), oscillator = producer.createOscillator(), producerGain = producer.createGain(), producerOutput = producer.createMediaStreamDestination();
  oscillator.frequency.value = 440; producerGain.gain.value = 0.25;
  oscillator.connect(producerGain); producerGain.connect(producerOutput); oscillator.start();
  const owner = new AbortController(), sourceConsent = new AbortController(), outputConsentA = new AbortController(), outputConsentB = new AbortController();
  const routingContexts: AudioContext[] = [], clones: MediaStreamTrack[] = [], readers: { context: AudioContext; node: MediaStreamAudioSourceNode; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> }[] = [];
  let sourceApprovals = 0, outputApprovals = 0, audioRouteApprovals = 0, diagnosticApprovals = 0;
  const sourceTrack = producerOutput.stream.getAudioTracks()[0], settings = sourceTrack?.getSettings();
  const nativeSourceSettings = { sampleRateHz: settings?.sampleRate ?? null, channels: settings?.channelCount ?? null };
  const nativeGraphFacts = { sampleRateHz: producerOutput.context.sampleRate, channels: producerOutput.channelCount, contextCorrelated: producerOutput.context === producer, streamCorrelated: true };
  let pipeline: ReturnType<typeof createPrivateApplicationAudioPipeline> | undefined;
  const environment: BrowserApplicationAudioEnvironment = { fixtureKind: 'owned-application-audio',
    createAudioContext() { const context = new AudioContext({ sampleRate: 48000 }); routingContexts.push(context); return context; },
    createMediaStream(tracks) { clones.push(...tracks); return new MediaStream(tracks); }, AudioContext, MediaStream, MediaStreamTrack, MediaStreamAudioDestinationNode,
    target: window, document, hidden: () => document.hidden, focused: () => document.hasFocus() };
  const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  const fixedExpiry = performance.now() + 10000;
  async function until(predicate: () => boolean, phase: string) { const end = performance.now() + 1500; let reads = 0;
    while (!predicate() && performance.now() < end && reads++ < 75) await wait(20);
    if (!predicate()) throw new Error('Owned private audio phase failed: ' + phase); }
  function rms(reader: typeof readers[number]): number { reader.analyser.getFloatTimeDomainData(reader.samples); let total = 0; for (const value of reader.samples) { if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Native analyser range'); total += value * value; } return Math.sqrt(total / 256); }
  async function reader(stream: MediaStream) {
    const track = stream.getAudioTracks()[0], settings = track?.getSettings();
    if (stream.getTracks().length !== 1 || !track || track.kind !== 'audio' || track.readyState !== 'live' || settings?.sampleRate !== undefined && settings.sampleRate !== 48000 || settings?.channelCount !== undefined && settings.channelCount !== 2) throw new Error('Private output contradicts selected graph facts');
    const context = new AudioContext({ sampleRate: 48000 }), node = context.createMediaStreamSource(stream), analyser = context.createAnalyser(); analyser.fftSize = 256; node.connect(analyser);
    const value = { context, node, analyser, samples: new Float32Array(256) }; readers.push(value); await context.resume(); if (context.state !== 'running' || context.sampleRate !== 48000) throw new Error('Independent analyser unavailable'); return value;
  }
  let outcome: Record<string, unknown>;
  try {
    await producer.resume();
    if (producer.state !== 'running' || producer.sampleRate !== 48000 || producerOutput.context !== producer || producerOutput.channelCount !== 2 || producerOutput.stream.getTracks().length !== 1 || nativeSourceSettings.sampleRateHz !== null && nativeSourceSettings.sampleRateHz !== 48000 || nativeSourceSettings.channels !== null && nativeSourceSettings.channels !== 2) {
      outcome = { kind, result: 'unsupported', hardwareEvidence: false, reason: 'actual-native-format-unavailable', nativeSourceSettings: nativeSourceSettings ?? null, producerSampleRate: producer.sampleRate };
    } else {
      pipeline = createPrivateApplicationAudioPipeline({ ownerSignal: owner.signal, environment,
        authorizeSource(request) { sourceApprovals++;
          if (request.role !== 'source' || request.ownerPrincipalId !== 'application-producer' || request.operation !== 'route-private-audio' || request.sourceId !== 'app:owned-tone' || request.source.capabilityId !== 'audio' || request.sink.capabilityId !== 'audio' || request.format.sampleRateHz !== 48000 || request.format.channels !== 2 || !['recipient-a', 'recipient-b'].includes(request.recipientPrincipalId)) return;
          return { request, signal: sourceConsent.signal, grant: { expiresAt: fixedExpiry, maxAgeMs: 250, maxHz: 20 } }; },
        authorizeOutput(request) { outputApprovals++;
          if (request.role !== 'output' || request.operation !== 'route-private-audio' || !['recipient-a', 'recipient-b'].includes(request.ownerPrincipalId) || request.recipientPrincipalId !== request.ownerPrincipalId || request.applicationId !== 'private-audio-example' || request.sessionId !== 'private-audio-session') return;
          return { request, signal: request.ownerPrincipalId === 'recipient-a' ? outputConsentA.signal : outputConsentB.signal, grant: { expiresAt: fixedExpiry, maxAgeMs: 250, maxHz: 20 } }; },
        authorizeRoutes(request) {
          if (request.applicationId !== 'private-audio-example' || request.sessionId !== 'private-audio-session' || request.source.deviceId !== 'app:owned-tone' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
          if (request.source.capabilityId === 'audio' && request.sink.capabilityId === 'audio' && (request.principalId === 'recipient-a' && request.sink.deviceId === 'app:recipient-a' || request.principalId === 'recipient-b' && request.sink.deviceId === 'app:recipient-b')) audioRouteApprovals++;
          else if (request.source.capabilityId === 'levels' && request.sink.capabilityId === 'levels' && request.principalId === 'diagnostic-reader' && request.sink.deviceId === 'app:audio-levels') diagnosticApprovals++;
          else return;
          return { expiresAt: fixedExpiry, maxAgeMs: 250, maxHz: 20 };
        } });
      const source = pipeline.bus.registerSource({ sourceId: 'app:owned-tone', ownerPrincipalId: 'application-producer', producerNode: producerOutput, stream: producerOutput.stream }); if (!source) throw new Error('Actual selected application source registration failed');
      const denied = pipeline.bus.bind({ source, outputId: 'app:unapproved', ownerPrincipalId: 'unapproved', purpose: 'native-negative', signal: new AbortController().signal });
      if (await denied.ready || routingContexts.length) throw new Error('Unapproved recipient created native graph');
      const first = pipeline.bus.bind({ source, outputId: 'app:recipient-a', ownerPrincipalId: 'recipient-a', purpose: 'private-tone', signal: new AbortController().signal });
      if (!await first.ready || !first.output()) throw new Error('Native first recipient unavailable: ' + first.status().reason);
      const firstStream = first.output()!, readA = await reader(firstStream); await until(() => rms(readA) > 0.05, 'recipient-a-tone'); const toneA = rms(readA);
      const second = pipeline.bus.bind({ source, outputId: 'app:recipient-b', ownerPrincipalId: 'recipient-b', purpose: 'private-tone', signal: new AbortController().signal });
      if (!await second.ready || !second.output()) throw new Error('Native second recipient unavailable: ' + second.status().reason);
      const secondStream = second.output()!, readB = await reader(secondStream); await until(() => rms(readB) > 0.05, 'recipient-b-tone'); const toneB = rms(readB);
      if (!pipeline.subscribeLevels(source)) throw new Error('Independent diagnostic route denied');
      await until(() => Number((pipeline!.levels().latest?.value as { rms?: number } | undefined)?.rms) > 0.05, 'separate-diagnostics'); const diagnostics = pipeline.levels();
      if (!first.setMuted(true)) throw new Error('Current mute was rejected'); await until(() => rms(readA) < 0.001, 'recipient-a-mute'); const mutedA = rms(readA), unaffectedB = rms(readB);
      if (unaffectedB < 0.05) throw new Error('Muting one recipient changed the other');
      if (!first.setVolume(0.5) || !first.setMuted(false)) throw new Error('Current gain was rejected'); await until(() => rms(readA) > 0.04 && rms(readA) < 0.13, 'recipient-a-half-volume'); const halfA = rms(readA);
      const beforeRevoke = pipeline.bus.snapshot(); outputConsentA.abort();
      if (first.output() || firstStream.getTracks().some(track => track.readyState !== 'ended') || !second.output()) throw new Error('Recipient revoke did not isolate exact native output');
      await until(() => rms(readB) > 0.05, 'retained-recipient-b'); sourceConsent.abort(); await pipeline.bus.close();
      if (second.output() || secondStream.getTracks().some(track => track.readyState !== 'ended')) throw new Error('Source revoke retained private audio');
      const borrowedProducerStillRunning = producer.state === 'running' && sourceTrack!.readyState === 'live', levelsRetired = pipeline.levels();
      if (!borrowedProducerStillRunning || levelsRetired.latest !== undefined || levelsRetired.released < 1) throw new Error('Borrowed producer ownership or diagnostic teardown failed');
      outcome = { kind, result: 'pass', hardwareEvidence: false, deniedReady: false, toneA, toneB, mutedA, unaffectedB, halfA,
        sourceApprovals, outputApprovals, audioRouteApprovals, diagnosticApprovals, diagnostics, levelsRetired, borrowedProducerStillRunning,
        nativeSourceSettings, nativeGraphFacts, routingContexts: routingContexts.length, independentAnalyserContexts: readers.length, beforeRevoke,
        timing: 'JS native-state/analyser retrieval; separate routing context time, no capture clock or inter-context mapping',
        scope: 'Actual owned native application oscillator and verified two-channel destination-node graph configuration with downmixed native diagnostics; missing emitted PCM channel metadata remains unknown; no physical source, encoded PCM transport, network, acoustic calibration or speaker output.' };
    }
  } finally {
    owner.abort(); if (pipeline) await pipeline.close();
    for (const value of readers) { value.node.disconnect(); value.analyser.disconnect(); await value.context.close(); }
    oscillator.stop(); oscillator.disconnect(); producerGain.disconnect(); producerOutput.disconnect(); producerOutput.stream.getTracks().forEach(track => track.stop()); await producer.close();
  }
  return { ...outcome!, cleanup: { provider: pipeline?.bus.snapshot() ?? null, producerState: producer.state, readerStates: readers.map(reader => reader.context.state),
    routingStates: routingContexts.map(context => context.state), originalTracksEndedByCaller: producerOutput.stream.getTracks().every(track => track.readyState === 'ended'),
    clonedTracksEndedByAdapter: clones.every(track => track.readyState === 'ended') }, deviceAcquisitions: 0, speakerConnections: 0 };
}
