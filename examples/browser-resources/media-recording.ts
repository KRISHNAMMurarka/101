import { createBrowserCameraProvider, createDeviceRuntime, createIndexedDbOwnerDataStorage,
  createMediaRecording, parseDeviceDescriptor } from '@101/connect';
import type { BrowserCameraEnvironment, BrowserCameraFrame, DeliveryContext, MediaRecordingCaptureHandle,
  DeviceDescriptor, MediaRecording, MediaRecordingFrame, MediaRecordingOptions, MediaRecordingPlaybackFrame,
  MediaRecordingSource, MediaRecordingSourceContext, Observation, OwnerDataStorage } from '@101/connect';

/** This standalone caller uses only public SDK contracts. Its producer is an owned
 * digital Canvas stream, never a user camera, default getUserMedia or hardware claim.
 * Playback is explicitly pulled/seeked; every new live output route needs its own grant.
 */
export async function runOwnedMediaRecordingFixture() {
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function' ||
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function' || !globalThis.indexedDB)
    return { kind: 'owned-native-canvas-local-recording', result: 'unsupported', physicalCapture: false };
  const captureDeadline = performance.now() + 7000;
  // The recording API uses trusted host UTC; pin a narrower corresponding local
  // authority end once. This is not a source/hardware clock mapping or renewal.
  const recordingCaptureDeadline = Date.now() + Math.max(0, Math.floor(captureDeadline - performance.now()));
  function captureCurrent() { if (performance.now() >= captureDeadline) throw new Error('Absolute owned capture deadline7000ms reached'); }
  async function captureAwait<T>(work: () => Promise<T>): Promise<T> {
    captureCurrent(); const result = await work(); captureCurrent(); return result;
  }
  const producer = document.createElement('canvas'), output = document.createElement('canvas');
  producer.width = 32; producer.height = 24; output.width = 8; output.height = 8;
  const paint = producer.getContext('2d'), display = output.getContext('2d');
  if (!paint || !display) throw new Error('Owned raster canvas unavailable');
  let channel = 0, producerFrames = 0;
  const draw = () => { if (++producerFrames > 80) return; paint.fillStyle = ['#ff0000', '#00ff00', '#0000ff'][channel]!; paint.fillRect(0, 0, 32, 24); };
  draw(); const stream = producer.captureStream(10), track = stream.getVideoTracks()[0];
  if (!track) throw new Error('Owned digital video unavailable');
  const timer = setInterval(draw, 100), owner = new AbortController(), cameraConsent = new AbortController();
  const recordingConsent = new AbortController(), playbackConsent = new AbortController(), quietConsent = new AbortController();
  const databaseName = 'recording-fixture-' + crypto.randomUUID(), ownerId = 'recording-fixture-owner';
  const storage = createIndexedDbOwnerDataStorage({ databaseName });
  let captureAllowed = false, playbackAllowed = false, quietAllowed = false, outputRoutesAllowed = false, nativeOpens = 0, approvals = 0, liveDelivered = 0, admitted = 0;
  let recordTarget = 0, committed = 0, quotaRefusals = 0, captureFailure: string | undefined, flushing: Promise<void> | undefined;
  let playbackLife: Readonly<{ signal: AbortSignal; expiresAt: number }> | undefined;
  let handle: MediaRecordingCaptureHandle | undefined, latest: Observation | undefined, latestContext: DeliveryContext | undefined;
  const admittedFacts: { sequence: number; timestamp: number; clockDomain: string; quality: string; decodedMediaTime?: number }[] = [];
  let recording = createMediaRecording({ ownerId, ownerSignal: owner.signal, storage, trustedNow: Date.now, authorize });
  let reopenedStorage: ReturnType<typeof createIndexedDbOwnerDataStorage> | undefined;
  function authorize(request: Parameters<MediaRecordingOptions['authorize']>[0]) {
    approvals++;
    if (request.ownerId !== ownerId || request.action === 'capture' && !captureAllowed || request.action === 'playback' &&
      !(request.destinationId === 'owned-quiet-player' ? quietAllowed : playbackAllowed)) return undefined;
    if (request.action === 'capture' && performance.now() >= captureDeadline) return undefined;
    return { request, signal: request.action === 'playback' ? request.destinationId === 'owned-quiet-player' ? quietConsent.signal : playbackConsent.signal : recordingConsent.signal,
      expiresAt: request.action === 'capture' ? Math.min(request.expiresAt, recordingCaptureDeadline) : request.expiresAt };
  }
  const scope = { principalId: 'recording-fixture-owner', applicationId: 'recording-fixture-app', sessionId: 'recording-fixture-session' };
  const selectedId = track.getSettings().deviceId ?? 'owned-recording-canvas';
  const live = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'recording-javascript-decoded-retrieval', maxPendingDeliveries: 1,
    authorize(request) {
      if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
        request.source.capabilityId !== 'camera-frame' || request.sink.capabilityId !== 'camera-frame' || request.sink.deviceId !== 'recording-fixture:input' ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return undefined;
      if (performance.now() >= captureDeadline) return undefined;
      return { expiresAt: captureDeadline, maxHz: 10, maxAgeMs: 250 };
    } });
  const environment: BrowserCameraEnvironment = { fixtureKind: 'owned-canvas-fixture',
    enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: selectedId }]),
    getUserMedia(constraints) { nativeOpens++;
      if (constraints.audio !== false || typeof constraints.video !== 'object' ||
        typeof constraints.video.deviceId !== 'object' || Array.isArray(constraints.video.deviceId) || constraints.video.deviceId.exact !== selectedId) throw new Error('Exact owned canvas selector required');
      return Promise.resolve(stream);
    }, createVideo: () => document.createElement('video'), createCanvas: () => document.createElement('canvas'),
    MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData, target: window, document, mediaDevicesTarget: new EventTarget(),
    hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext };
  const camera = createBrowserCameraProvider({ runtime: live, ownerSignal: owner.signal, scope, now: () => performance.now(), environment,
    authorizeCapture(request) { if (performance.now() >= captureDeadline) return undefined;
      return { request, signal: cameraConsent.signal, expiresAt: captureDeadline }; } });
  const playback = createDeviceRuntime({ now: Date.now, clockDomain: 'recording-host-emission', maxPendingDeliveries: 1,
    authorize(request) {
      if (!outputRoutesAllowed || !playbackLife || playbackLife.signal.aborted || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
        request.source.deviceId !== 'recording-fixture:playback' || request.sink.deviceId !== 'recording-fixture:output' ||
        request.source.capabilityId !== 'camera-frame' || request.sink.capabilityId !== 'camera-frame' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return undefined;
      return { expiresAt: Math.min(Date.now() + 7000, playbackLife.expiresAt), maxHz: 10, maxAgeMs: 250 };
    } });
  let input: ReturnType<typeof live.registerSink> | undefined, inputRoute: ReturnType<typeof live.route> | undefined;
  let playbackSource: ReturnType<typeof playback.registerSource> | undefined, outputSink: ReturnType<typeof playback.registerSink> | undefined;
  let outputRoute: ReturnType<typeof playback.route> | undefined, outputReleased = 0, outputDelivered = 0;
  let latestOutput: Observation | undefined, latestOutputContext: DeliveryContext | undefined;
  let clipId = '', proof: object | undefined;
  const deadline = () => Date.now() + 7000;
  function selectedSource(observation: Observation): MediaRecordingSource { return { ...observation.source,
    applicationId: scope.applicationId, sessionId: scope.sessionId, clockId: observation.clockDomain }; }
  function accept(observation: Observation, context: DeliveryContext) {
    if (context.signal.aborted || !context.isCurrent()) return;
    latest = observation; latestContext = context; liveDelivered++;
    if (!handle || admitted >= recordTarget || !color(observation, channel)) return;
    const frame = observation.value as unknown as BrowserCameraFrame;
    const result = recording.enqueue(handle, { bytes: Uint8Array.from(frame.rows.flat()), sequence: observation.sequence,
      sourceTime: { clockId: observation.clockDomain, at: observation.timestamp }, quality: observation.quality,
      ...(typeof observation.provenance?.mediaTimeSeconds === 'number' ? { decodedMediaTime: observation.provenance.mediaTimeSeconds } : {}) },
      { source: selectedSource(observation), signal: context.signal, isCurrent: () => context.isCurrent() });
    if (result.ok) { admitted++; if (admittedFacts.length < 34) admittedFacts.push({ sequence: observation.sequence,
      timestamp: observation.timestamp, clockDomain: observation.clockDomain, quality: observation.quality,
      ...(typeof observation.provenance?.mediaTimeSeconds === 'number' ? { decodedMediaTime: observation.provenance.mediaTimeSeconds } : {}) }); kickFlush(); }
  }
  // Storage is not awaited by live input. Commit the actual current observation
  // promptly, retaining its original delivery signal and clock rather than replay.
  function kickFlush() {
    if (flushing || captureFailure || !recording.status().pendingFrames) return;
    flushing = recording.flush().then(result => {
      if (result.ok) committed += result.value.committed;
      else if (result.reason === 'quota' && committed === 32) quotaRefusals++;
      else captureFailure = result.reason;
    }).finally(() => { flushing = undefined; if (!captureFailure) kickFlush(); });
  }
  function color(observation: Observation | undefined, channel: number) {
    const frame = observation?.value as unknown as BrowserCameraFrame | undefined;
    return !!frame && frame.rows.every(row => row.every((byte, index) => index % 4 === channel || index % 4 === 3 ? byte >= 240 : byte <= 16));
  }
  async function until(phase: string, predicate: () => boolean) {
    const diagnostic = () => JSON.stringify({ phase, producerDrawCalls: producerFrames, selectedColorChannel: channel,
      nativeOpens, liveDelivered, admitted, committed, recordTarget, quotaRefusals, captureFailure,
      camera: camera.snapshot(), recording: recording.status(), inputRoute: inputRoute?.status(),
      latest: latest ? { source: latest.source, sequence: latest.sequence, clockDomain: latest.clockDomain,
        timestamp: latest.timestamp, quality: latest.quality, pixel: (latest.value as unknown as BrowserCameraFrame).rows[0]?.slice(0, 4) } : undefined });
    const end = performance.now() + 2000;
    captureCurrent();
    while (!predicate() && performance.now() < end) { if (captureFailure) throw new Error('Actual routed frame commit failed: ' + diagnostic());
      await captureAwait(() => new Promise(resolve => setTimeout(resolve, 20))); captureCurrent(); live.flush(); captureCurrent(); }
    captureCurrent();
    if (!predicate()) throw new Error('Owned recording raster condition did not settle: ' + diagnostic());
  }
  async function publishFrame(frame: MediaRecordingPlaybackFrame) {
    if (!playbackSource || !playbackLife || playbackLife.signal.aborted) throw new Error('Playback source not approved');
    const rows = Array.from({ length: 8 }, (_, row) => Array.from(frame.frame.bytes.subarray(row * 32, row * 32 + 32)));
    const before = outputDelivered;
    const result = playback.publish(playbackSource, { format: 'rgba8', width: 8, height: 8, rows },
      { timestamp: frame.playback.at, clockDomain: frame.playback.clockId, provenance: {
        recordingIndex: frame.frame.index, seekEpoch: frame.playback.seekEpoch, originalSourceClock: frame.frame.sourceTime.clockId,
        originalSourceTime: frame.frame.sourceTime.at, originalSequence: frame.frame.sequence, originalQuality: frame.frame.quality,
        captureTimeKnown: false, clockMappingEstablished: false, playbackNotLiveCapture: true,
      } });
    if (!result.ok) throw new Error('Current playback route unavailable'); playback.flush();
    const until = performance.now() + 1000;
    while (outputDelivered === before && performance.now() < until) { await new Promise(resolve => setTimeout(resolve, 20)); playback.flush(); }
    if (outputDelivered === before) throw new Error('Current private playback pixels unavailable');
  }
  try {
    const inventory = await captureAwait(() => camera.inspect()); if (!inventory.ok || inventory.value.length !== 1) throw new Error('Owned inventory unavailable');
    const started = await captureAwait(() => camera.start(inventory.value[0]!.selection, { purpose: 'owned-digital-recording' }));
    if (!started.ok) throw new Error('Owned capture unavailable: ' + started.reason);
    const cameraDevice = started.value.device;
    const sinkDevice = parseDeviceDescriptor({ ...cameraDevice, id: 'recording-fixture:input', capabilities: cameraDevice.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
    input = live.registerSink({ device: sinkDevice, capability: 'camera-frame', apply: accept, release() { latest = undefined; latestContext = undefined; } });
    live.setReadiness(input, 'available'); inputRoute = live.route({ from: started.value.source, to: input, ...scope, leaseMs: 7000 });
    if (!inputRoute.start().ok) throw new Error('Independent live route denied');
    await until('initial-native-red', () => color(latest, 0));
    const review = await captureAwait(() => recording.listReviewed({ purpose: 'owner-review', expiresAt: deadline() }));
    if (!review.ok || review.value.length !== 0) throw new Error('Live route automatically recorded');
    if (!latest || !latestContext || latestContext.signal.aborted) throw new Error('No current actual routed source');
    const captureRequest = { source: selectedSource(latest), purpose: 'owner-digital-recording', expiresAt: recordingCaptureDeadline, retentionMs: 60000 };
    const denied = await captureAwait(() => recording.requestCapture(captureRequest)); if (denied.ok || denied.reason !== 'denied') throw new Error('Capture decline not preserved');
    captureAllowed = true; const approved = await captureAwait(() => recording.requestCapture(captureRequest));
    if (!approved.ok) throw new Error('Recording approval unavailable'); handle = approved.value.handle; clipId = approved.value.clipId;
    recordTarget = 8; await until('red-8', () => admitted === 8 && committed === 8 && !flushing);
    const redObservation = latest!;
    channel = 1; recordTarget = 16; draw(); await until('green-16', () => admitted === 16 && committed === 16 && !flushing);
    recordTarget = 24; await until('green-24', () => admitted === 24 && committed === 24 && !flushing);
    const greenObservation = latest!;
    channel = 2; recordTarget = 33; draw(); await until('blue-33-quota', () => admitted === 33 && committed === 32 && quotaRefusals === 1 && !flushing);
    const blueObservation = latest!; recording.revoke(handle); handle = undefined;
    // Frame33 is an actual new routed capture. Empty consented clips qualify
    // the durable clip quota without pretending128 native frames were acquired.
    const emptyClips: string[] = [];
    for (let index = 0; index < 3; index++) {
      const emptyClip = await captureAwait(() => recording.requestCapture(captureRequest));
      if (!emptyClip.ok) throw new Error('Durable empty clip setup unavailable');
      emptyClips.push(emptyClip.value.clipId); recording.revoke(emptyClip.value.handle);
    }
    const clipQuota = await captureAwait(() => recording.requestCapture(captureRequest));
    if (clipQuota.ok || clipQuota.reason !== 'quota' || recording.status().captures !== 0) throw new Error('Durable four-clip quota not enforced');
    const quotaFixtureCleanup = await captureAwait(() => recording.deleteReviewed({ clipId: emptyClips[0]!, purpose: 'empty-quota-slot-delete', expiresAt: deadline() }));
    if (!quotaFixtureCleanup.ok || quotaFixtureCleanup.value.removed !== 1) throw new Error('Owned quota slot cleanup unavailable');
    const ttl = await captureAwait(() => recording.requestCapture({ ...captureRequest, retentionMs: 1500 }));
    if (!ttl.ok) throw new Error('Short-retention native capture unavailable');
    handle = ttl.value.handle; recordTarget = 34; await until('ttl-34', () => admitted === 34 && committed === 33 && !flushing);
    recording.revoke(handle); handle = undefined;
    await captureAwait(() => camera.close()); inputRoute.stop('owned-capture-finished'); clearInterval(timer); captureCurrent();
    const captureElapsedMs = performance.now() - (captureDeadline - 7000);
    // Establish the fresh short-lived player immediately. No restart, exports,
    // unrelated owner work or primary player can race its purge/epoch change.
    quietAllowed = true;
    const quiet = await runQuietRetirement(recording, ttl.value.clipId, cameraDevice, scope);
    const ttlSweep = await recording.sweep();
    if (!ttlSweep.ok || ttlSweep.value.removed !== 1) throw new Error('Native expired clip was not purged on next execution');
    const ttlMissing = await recording.requestPlayback({ clipId: ttl.value.clipId, destinationId: 'owned-quiet-player', purpose: 'expired-playback', expiresAt: deadline() });
    if (ttlMissing.ok || ttlMissing.reason !== 'not-found') throw new Error('Expired native clip restored playback');
    const beforeRestart = recording.status(); await recording.close(); storage.close();
    reopenedStorage = createIndexedDbOwnerDataStorage({ databaseName });
    recording = createMediaRecording({ ownerId, ownerSignal: owner.signal, storage: reopenedStorage, trustedNow: Date.now, authorize });
    const afterRestart = recording.status();
    if (afterRestart.captures !== 0 || afterRestart.players !== 0 || afterRestart.pendingFrames !== 0) throw new Error('Restart restored authority');
    const otherOwner = new AbortController(), otherConsent = new AbortController();
    const otherStorage = createIndexedDbOwnerDataStorage({ databaseName });
    const other = createMediaRecording({ ownerId: 'recording-other-owner', ownerSignal: otherOwner.signal, storage: otherStorage,
      trustedNow: Date.now, authorize(request) { return { request, signal: otherConsent.signal, expiresAt: request.expiresAt }; } });
    let isolation: object;
    try {
      const isolated = await other.listReviewed({ purpose: 'other-owner-review', expiresAt: deadline() });
      const foreign = await other.requestPlayback({ clipId, destinationId: 'other-player', purpose: 'other-playback', expiresAt: deadline() });
      if (!isolated.ok || isolated.value.length || foreign.ok || foreign.reason !== 'not-found') throw new Error('Native owner isolation failed');
      const ownClip = await other.requestCapture({ ...captureRequest, expiresAt: deadline() });
      if (!ownClip.ok) throw new Error('Other independently approved owner unavailable'); other.revoke(ownClip.value.handle);
      const ownDeletion = await other.deleteReviewed({ purpose: 'other-owner-delete', expiresAt: deadline() });
      const incumbent = await recording.listReviewed({ purpose: 'incumbent-review', expiresAt: deadline() });
      if (!ownDeletion.ok || ownDeletion.value.removed !== 1 || !incumbent.ok || incumbent.value.find(item => item.clipId === clipId)?.frameCount !== 32)
        throw new Error('Other owner deletion altered incumbent pixels');
      isolation = { empty: isolated.value.length, foreign, ownDeletion, incumbentFrames: 32 };
    } finally { otherOwner.abort(); otherConsent.abort(); await other.close(); otherStorage.close(); }
    const deniedPlayback = await recording.requestPlayback({ clipId, destinationId: 'owned-canvas-player', purpose: 'owner-playback', expiresAt: deadline() });
    if (deniedPlayback.ok || deniedPlayback.reason !== 'denied') throw new Error('Fresh playback decline not enforced');
    playbackAllowed = true;
    const player = await recording.requestPlayback({ clipId, destinationId: 'owned-canvas-player', purpose: 'owner-playback', expiresAt: deadline() });
    if (!player.ok) throw new Error('Fresh playback approval unavailable');
    const lifetime = recording.playbackLifetime(player.value); if (!lifetime.ok) throw new Error('Current selected playback lifetime unavailable');
    playbackLife = lifetime.value;
    const stopPlayback = () => { outputRoute?.stop('recording-consent-retired');
      if (playbackSource) playback.unregister(playbackSource); if (outputSink) playback.unregister(outputSink); };
    playbackLife.signal.addEventListener('abort', stopPlayback, { once: true });
    try {
    if (playbackLife.signal.aborted) throw new Error('Playback retired before registration');
    const sourceDevice = parseDeviceDescriptor({ ...cameraDevice, id: 'recording-fixture:playback', label: 'Owned recorded raster',
      adapter: { id: 'app:local-recording', version: '1.0.0' }, runtime: { platform: 'browser-local-recording' } });
    const outputDevice = parseDeviceDescriptor({ ...sourceDevice, id: 'recording-fixture:output', capabilities: sourceDevice.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
    playbackSource = playback.registerSource({ device: sourceDevice, capability: 'camera-frame' });
    if (playbackLife.signal.aborted) { stopPlayback(); throw new Error('Playback retired during registration'); }
    outputSink = playback.registerSink({ device: outputDevice, capability: 'camera-frame', apply(observation, context) {
      if (!playbackLife || playbackLife.signal.aborted || context.signal.aborted || !context.isCurrent()) return;
      const frame = observation.value as unknown as BrowserCameraFrame, image = new ImageData(Uint8ClampedArray.from(frame.rows.flat()), 8, 8);
      if (playbackLife.signal.aborted || context.signal.aborted || !context.isCurrent()) return;
      display.putImageData(image, 0, 0); outputDelivered++; latestOutput = observation; latestOutputContext = context;
    }, release() { display.clearRect(0, 0, 8, 8); outputReleased++; } });
    if (playbackLife.signal.aborted) { stopPlayback(); throw new Error('Playback retired during sink registration'); }
    playback.setReadiness(playbackSource, 'available'); playback.setReadiness(outputSink, 'available');
    const declinedRoute = playback.route({ from: playbackSource, to: outputSink, ...scope, leaseMs: 7000 });
    const deniedOutputStart = declinedRoute.start(), deniedOutputRoute = declinedRoute.status(), preApprovalOutputDelivered = outputDelivered;
    if (deniedOutputStart.ok || deniedOutputStart.reason !== 'denied' || deniedOutputRoute.state !== 'idle' ||
      deniedOutputRoute.reason !== 'denied' || deniedOutputRoute.pending !== 0 || preApprovalOutputDelivered !== 0)
      throw new Error('Playback consent invented resource approval');
    outputRoutesAllowed = true;
    outputRoute = playback.route({ from: playbackSource, to: outputSink, ...scope, leaseMs: 7000 });
    if (!outputRoute.start().ok) throw new Error('Independent playback source/sink approval denied');
      const pages = [];
      for (let index = 0; index < 32; index += 4) {
        const page = await recording.exportPage({ clipId, destinationId: 'owned-local-export', purpose: 'owner-export', expiresAt: deadline(), afterIndex: index, limit: 4 });
        if (!page.ok || page.value.frames.length !== 4) throw new Error('Bounded native export page unavailable');
        pages.push(page.value);
      }
      const first = await recording.pull(player.value); if (!first.ok) throw new Error('Owned red playback unavailable'); await publishFrame(first.value);
      const redPixels = Array.from(display.getImageData(0, 0, 8, 8).data);
      if (!recording.seek(player.value, 16).ok) throw new Error('Actual middle seek unavailable');
      const middle = await recording.pull(player.value); if (!middle.ok) throw new Error('Owned green playback unavailable'); await publishFrame(middle.value);
      const greenPixels = Array.from(display.getImageData(0, 0, 8, 8).data);
      if (!recording.seek(player.value, 31).ok) throw new Error('Actual end seek unavailable');
      const second = await recording.pull(player.value); if (!second.ok) throw new Error('Owned blue playback unavailable'); await publishFrame(second.value);
      const bluePixels = Array.from(display.getImageData(0, 0, 8, 8).data);
      const nativeBoundaries = await runNativeStoreBoundaries(databaseName, async () => {
        if (!recording.seek(player.value, 31).ok) throw new Error('Current observed replay source unavailable');
        const next = await recording.pull(player.value); if (!next.ok) throw new Error('Current observed replay frame unavailable');
        await publishFrame(next.value);
        if (!latestOutput || !latestOutputContext || !latestOutputContext.isCurrent()) throw new Error('Independent current playback route unavailable');
        const observation = latestOutput, context = latestOutputContext, frame = observation.value as unknown as BrowserCameraFrame;
        return { frame: { bytes: Uint8Array.from(frame.rows.flat()), sequence: observation.sequence,
          sourceTime: { clockId: observation.clockDomain, at: observation.timestamp }, quality: observation.quality },
          context: { source: selectedSource(observation), signal: context.signal, isCurrent: () => context.isCurrent() } };
      });
      playbackConsent.abort(); if (outputReleased < 1 || display.getImageData(0, 0, 8, 8).data.some(byte => byte !== 0)) throw new Error('Owned playback pixels not released');
      const deletion = await recording.deleteReviewed({ clipId, purpose: 'owner-delete', expiresAt: deadline() });
      const allDeletion = await recording.deleteReviewed({ purpose: 'remaining-owner-delete', expiresAt: deadline() });
      const empty = await recording.listReviewed({ purpose: 'owner-review', expiresAt: deadline() });
      if (!deletion.ok || deletion.value.removed !== 1 || !allDeletion.ok || allDeletion.value.removed !== 2 || !empty.ok || empty.value.length !== 0) throw new Error('Owned durable deletion unavailable');
      proof = { kind: 'owned-native-canvas-local-recording', result: 'pass', physicalCapture: false, nativeOpens, approvals, liveDelivered, admitted, committed, quotaRefusals, clipQuota, quotaFixtureCleanup,
        initialCapture: { monotonicDeadline: captureDeadline, recordingUtcDeadline: recordingCaptureDeadline, observedElapsedMs: captureElapsedMs, ceilingMs: 7000, renewed: false },
        automaticRecords: review.value.length, denied, deniedPlayback, beforeRestart, afterRestart,
        redObservation, greenObservation, blueObservation, admittedFacts, isolation, nativeBoundaries, quiet, ttlSweep, ttlMissing,
        first: { ...first.value, frame: { ...first.value.frame, bytes: Array.from(first.value.frame.bytes) } },
        middle: { ...middle.value, frame: { ...middle.value.frame, bytes: Array.from(middle.value.frame.bytes) } },
        second: { ...second.value, frame: { ...second.value.frame, bytes: Array.from(second.value.frame.bytes) } }, exportFrames: pages.reduce((count, page) => count + page.frames.length, 0), exportPages: pages.map(page => page.frames.length),
        redPixels, greenPixels, bluePixels, outputDelivered, outputReleased, deniedOutputStart, deniedOutputRoute, preApprovalOutputDelivered,
        deletion, allDeletion, unmanagedReturnedCopiesRecalled: false };
    } finally { playbackLife.signal.removeEventListener('abort', stopPlayback); }
  } finally {
    clearInterval(timer); owner.abort(); recordingConsent.abort(); playbackConsent.abort(); quietConsent.abort(); cameraConsent.abort();
    inputRoute?.stop('recording-close'); outputRoute?.stop('recording-close'); await camera.close();
    if (input) live.unregister(input); if (playbackSource) playback.unregister(playbackSource); if (outputSink) playback.unregister(outputSink);
    live.close(); playback.close(); await flushing; await recording.close(); storage.close(); reopenedStorage?.close();
    stream.getTracks().forEach(native => native.stop()); producer.width = 1; producer.height = 1; output.width = 1; output.height = 1;
    await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(databaseName), timeout = setTimeout(() => reject(new Error('Owned recording database cleanup unavailable')), 2000);
      deletion.onsuccess = () => { clearTimeout(timeout); resolve(); }; deletion.onerror = deletion.onblocked = () => { clearTimeout(timeout); reject(new Error('Owned recording database cleanup unavailable')); }; });
  }
  return { ...proof, cleanup: { recording: recording.status(), camera: camera.snapshot(), tracksEnded: stream.getTracks().every(native => native.readyState === 'ended'),
    producerWidth: producer.width, producerHeight: producer.height, outputWidth: output.width, outputHeight: output.height, databaseDeleted: true, producerTimers: 0 },
    scope: 'Real owned digital stream, native decoded RGBA and private IndexedDB only; explicit recording/playback/source/sink approvals. No physical capture, encoded media, capture freshness, clock mapping, autoplay, remote copies or external-copy deletion.' };
}

/** These scheduling and mutation callbacks wrap the real public native engine;
 * no in-memory store or fabricated successful transaction is substituted. The
 * source is a fresh, independently routed playback observation of retained
 * digital pixels, with its own truthful host emission sequence/time/quality.
 */
async function runNativeStoreBoundaries(databaseName: string,
  currentFrame: () => Promise<{ frame: MediaRecordingFrame; context: MediaRecordingSourceContext }>) {
  const owned: { controller: MediaRecording; owner: AbortController; capture: AbortController; review: AbortController;
    port: ReturnType<typeof createIndexedDbOwnerDataStorage> }[] = [];
  let releaseHeld = () => {};
  function fixture(ownerId: string, clock: () => number = Date.now,
    wrap?: (port: OwnerDataStorage) => OwnerDataStorage) {
    const owner = new AbortController(), capture = new AbortController(), review = new AbortController();
    const port = createIndexedDbOwnerDataStorage({ databaseName });
    const controller = createMediaRecording({ ownerId, ownerSignal: owner.signal, storage: wrap ? wrap(port) : port,
      trustedNow: clock, authorize(request) { return { request, signal: request.action === 'capture' ? capture.signal : review.signal, expiresAt: request.expiresAt }; } });
    const item = { controller, owner, capture, review, port }; owned.push(item); return item;
  }
  async function prepare(item: ReturnType<typeof fixture>, expiresAt: number) {
    const source = (await currentFrame()).context.source;
    const selected = await item.controller.requestCapture({ source, purpose: 'actual-native-boundary', expiresAt, retentionMs: 60000 });
    if (!selected.ok) throw new Error('Native boundary capture approval unavailable');
    const actual = await currentFrame();
    if (!item.controller.enqueue(selected.value.handle, actual.frame, actual.context).ok) throw new Error('Native boundary current replay rejected');
    return selected.value;
  }
  function hold(port: OwnerDataStorage) {
    let selected = false, retired = false, announce: () => void = () => {}, release: () => void = () => {};
    const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
      if (selected && !retired) { selected = false; announce(); await new Promise<void>(resolve => { release = resolve; }); }
      return port.transact(owner, mutation, guard);
    } };
    return { storage, enter() { selected = true; return new Promise<void>(resolve => { announce = resolve; }); },
      settle() { retired = true; selected = false; const done = release; release = () => {}; done(); } };
  }
  async function waitForEntry(entered: Promise<void>, actualFlush: ReturnType<MediaRecording['flush']>) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        entered.then(() => ({ entered: true as const })),
        actualFlush.then(result => ({ entered: false as const, result })),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Owned storage seam entry deadline1000ms')), 1000); }),
      ]);
      if (!result.entered) throw new Error('Flush settled before owned storage seam entry: ' + (result.result.ok ? 'complete' : result.result.reason));
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  let proof: object;
  try {
    let at = Date.now(), finalClock = false, clockTransitions = 0;
    const expiresAt = at + 1000;
    const clock = fixture('recording-native-clock-owner', () => at, port => ({ transact(owner, mutation, guard) {
      return port.transact(owner, current => { const next = mutation(current);
        if (finalClock) { at = expiresAt; clockTransitions++; } return next;
      }, guard);
    } }));
    await prepare(clock, expiresAt); finalClock = true;
    const expiredCommit = await clock.controller.flush(); finalClock = false;
    const clockReview = await clock.controller.listReviewed({ purpose: 'clock-boundary-review', expiresAt: at + 1000 });
    if (expiredCommit.ok || clockTransitions !== 1 || !clockReview.ok || clockReview.value.length !== 1 || clockReview.value[0]!.frameCount !== 0)
      throw new Error('Actual IndexedDB final consent deadline admitted pixels');

    let revokeAfterMutation = false, revocations = 0;
    const cancelled = fixture('recording-native-revoke-owner', Date.now, port => ({ transact(owner, mutation, guard) {
      return port.transact(owner, current => { const next = mutation(current);
        if (revokeAfterMutation) { revocations++; cancelled.capture.abort(); } return next;
      }, guard);
    } }));
    await prepare(cancelled, Date.now() + 1000); revokeAfterMutation = true;
    const revokedCommit = await cancelled.controller.flush(); revokeAfterMutation = false;
    const revokedReview = await cancelled.controller.listReviewed({ purpose: 'revoked-native-review', expiresAt: Date.now() + 1000 });
    if (revokedCommit.ok || revocations !== 1 || !revokedReview.ok || revokedReview.value[0]?.frameCount !== 0)
      throw new Error('Actual IndexedDB late capture revocation admitted pixels');

    let delayed: ReturnType<typeof hold> | undefined;
    const stale = fixture('recording-native-epoch-owner', Date.now, port => { delayed = hold(port); return delayed.storage; });
    const remover = fixture('recording-native-epoch-owner');
    await prepare(stale, Date.now() + 1000);
    const entered = delayed!.enter(); releaseHeld = () => delayed!.settle();
    const lateAppend = stale.controller.flush(); await waitForEntry(entered, lateAppend);
    const heldRaw = stale.controller.status().rawPending;
    const busy = await stale.controller.listReviewed({ purpose: 'held-native-review', expiresAt: Date.now() + 1000 });
    const deletion = await remover.controller.deleteReviewed({ purpose: 'independent-epoch-delete', expiresAt: Date.now() + 1000 });
    if (heldRaw !== 1 || busy.ok || busy.reason !== 'busy' || !deletion.ok || deletion.value.removed !== 1)
      throw new Error('Actual native deletion scheduling boundary unavailable');
    releaseHeld(); const lateResult = await lateAppend;
    const afterDelete = await remover.controller.listReviewed({ purpose: 'post-delete-review', expiresAt: Date.now() + 1000 });
    if (lateResult.ok || lateResult.reason !== 'epoch-changed' || !afterDelete.ok || afterDelete.value.length)
      throw new Error('Delayed actual IndexedDB append resurrected deleted pixels');

    let pending: ReturnType<typeof hold> | undefined;
    const stopped = fixture('recording-native-stop-owner', Date.now, port => { pending = hold(port); return pending.storage; });
    await prepare(stopped, Date.now() + 1000);
    const stoppedEntered = pending!.enter(); releaseHeld = () => pending!.settle();
    const stoppedAppend = stopped.controller.flush(); await waitForEntry(stoppedEntered, stoppedAppend); stopped.owner.abort();
    let closeSettled = false; const closing = stopped.controller.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    const cancelledRaw = stopped.controller.status().rawPending;
    const closeWasPending = !closeSettled;
    if (!closeWasPending || cancelledRaw !== 1) throw new Error('Logical cancel released an unsettled storage call');
    releaseHeld(); const stoppedResult = await stoppedAppend; await closing;
    const stopReader = fixture('recording-native-stop-owner');
    const stoppedReview = await stopReader.controller.listReviewed({ purpose: 'stopped-native-review', expiresAt: Date.now() + 1000 });
    if (stoppedResult.ok || !stoppedReview.ok || stoppedReview.value[0]?.frameCount !== 0)
      throw new Error('Cancelled actual native request committed pixels');
    proof = { storageEngine: 'actual-IndexedDB', source: 'current-SDK-routed-playback-of-owned-digital-native-pixels',
      schedulingSeam: 'owned caller delay before actual native engine; mutation hooks run inside actual native transaction',
      finalClock: { clockTransitions, expiredCommit, persistedFrames: clockReview.value[0]!.frameCount },
      revoke: { revocations, revokedCommit, persistedFrames: revokedReview.value[0]!.frameCount },
      deletionEpoch: { heldRaw, busy, deletion, lateResult, persistedClips: afterDelete.value.length },
      stop: { cancelledRaw, closeWasPending, closeSettled, stoppedResult, persistedFrames: stoppedReview.value[0]!.frameCount } };
  } finally {
    releaseHeld();
    for (const item of owned) { item.owner.abort(); item.capture.abort(); item.review.abort(); await item.controller.close(); item.port.close(); }
  }
  const cleanup = owned.map(item => item.controller.status());
  if (cleanup.some(item => item.rawPending || item.timers || item.listeners || item.captures || item.players)) throw new Error('Native boundary cleanup incomplete');
  return { ...proof, cleanup, nativePortsClosed: owned.length, heldRequests: 0 };
}

async function runQuietRetirement(recording: MediaRecording, clipId: string, device: DeviceDescriptor,
  scope: { principalId: string; applicationId: string; sessionId: string }) {
  const selected = await recording.requestPlayback({ clipId, destinationId: 'owned-quiet-player', purpose: 'quiet-retained-playback', expiresAt: Date.now() + 7000 });
  if (!selected.ok) throw new Error('Short-retained native clip already unavailable');
  const life = recording.playbackLifetime(selected.value); if (!life.ok) throw new Error('Native quiet playback lifetime unavailable');
  const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
  const paint = canvas.getContext('2d'); if (!paint) throw new Error('Quiet private output unavailable');
  let releases = 0, deliveries = 0, timeout: ReturnType<typeof setTimeout> | undefined;
  const runtime = createDeviceRuntime({ now: Date.now, clockDomain: 'recording-host-emission', maxPendingDeliveries: 1,
    authorize(request) {
      if (life.value.signal.aborted || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
        request.source.deviceId !== 'recording-fixture:quiet-source' || request.sink.deviceId !== 'recording-fixture:quiet-output' ||
        request.source.capabilityId !== 'camera-frame' || request.sink.capabilityId !== 'camera-frame' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return undefined;
      return { expiresAt: life.value.expiresAt, maxHz: 10, maxAgeMs: 250 };
    } });
  let source: ReturnType<typeof runtime.registerSource> | undefined, sink: ReturnType<typeof runtime.registerSink> | undefined;
  let route: ReturnType<typeof runtime.route> | undefined, resolveRetired: () => void = () => {};
  const stop = () => { route?.stop('quiet-retained-clip-expiry'); if (source) runtime.unregister(source); if (sink) runtime.unregister(sink); resolveRetired(); };
  life.value.signal.addEventListener('abort', stop, { once: true });
  try {
    if (life.value.signal.aborted) throw new Error('Quiet playback expired before registration');
    const sourceDevice = parseDeviceDescriptor({ ...device, id: 'recording-fixture:quiet-source' });
    const sinkDevice = parseDeviceDescriptor({ ...sourceDevice, id: 'recording-fixture:quiet-output', capabilities: sourceDevice.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
    source = runtime.registerSource({ device: sourceDevice, capability: 'camera-frame' });
    if (life.value.signal.aborted) { stop(); throw new Error('Quiet playback expired during source creation'); }
    sink = runtime.registerSink({ device: sinkDevice, capability: 'camera-frame', apply(observation, context) {
      if (life.value.signal.aborted || context.signal.aborted || !context.isCurrent()) return;
      const frame = observation.value as unknown as BrowserCameraFrame, image = new ImageData(Uint8ClampedArray.from(frame.rows.flat()), 8, 8);
      if (life.value.signal.aborted || context.signal.aborted || !context.isCurrent()) return; paint.putImageData(image, 0, 0); deliveries++;
    }, release() { paint.clearRect(0, 0, 8, 8); releases++; } });
    if (life.value.signal.aborted) { stop(); throw new Error('Quiet playback expired during sink creation'); }
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    route = runtime.route({ from: source, to: sink, ...scope, leaseMs: 7000 }); if (!route.start().ok) throw new Error('Quiet independent route denied');
    const pulled = await recording.pull(selected.value); if (!pulled.ok) throw new Error('Quiet actual retained frame unavailable');
    const frame = pulled.value.frame;
    if (!runtime.publish(source, { format: 'rgba8', width: 8, height: 8, rows: Array.from({ length: 8 }, (_, row) => Array.from(frame.bytes.subarray(row * 32, row * 32 + 32))) },
      { timestamp: pulled.value.playback.at, clockDomain: pulled.value.playback.clockId }).ok) throw new Error('Quiet retained publish denied');
    runtime.flush(); if (deliveries !== 1) throw new Error('Quiet private output did not receive actual retained pixels');
    const before = Array.from(paint.getImageData(0, 0, 8, 8).data);
    await new Promise<void>((resolve, reject) => { resolveRetired = resolve;
      timeout = setTimeout(() => reject(new Error('Quiet native expiry did not retire output')), 2000);
      if (life.value.signal.aborted) resolve(); });
    clearTimeout(timeout); timeout = undefined;
    const after = Array.from(paint.getImageData(0, 0, 8, 8).data);
    if (!life.value.signal.aborted || releases < 1 || after.some(byte => byte !== 0)) throw new Error('Quiet native clip expiry retained visible pixels');
    return { clipId, expiresAt: life.value.expiresAt, frameIndex: frame.index, frameHash: frame.sha256,
      retainedBytes: Array.from(frame.bytes), before, after, deliveries, releases, aborted: life.value.signal.aborted,
      trigger: 'owned consent/clip timer only; no intervening pull/sweep', hardware: false };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout); life.value.signal.removeEventListener('abort', stop); stop(); runtime.close();
    recording.revoke(selected.value); canvas.width = 1; canvas.height = 1;
  }
}
