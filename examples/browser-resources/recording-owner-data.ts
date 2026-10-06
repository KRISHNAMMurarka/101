import { createBrowserCameraProvider, createDeviceRuntime, createIndexedDbOwnerDataStorage,
  createRecordingOwnerData, parseDeviceDescriptor, verifyAssetContent } from '@101/connect';
import type { BrowserCameraEnvironment, BrowserCameraFrame, DeliveryContext, DeviceDescriptor, MediaRecordingCaptureHandle,
  Observation, OwnerDataStorage, RecordingOwnerDataController, RecordingOwnerDataOptions, RecordingOwnerDataPort,
  RecordingOwnerDataScope } from '@101/connect';

/** Independent public SDK caller. Its native pixels come from an owned digital
 * Canvas stream, never from user hardware. Only registered owner-local copies
 * are deleted; caller-retained or previously transmitted bytes remain outside scope. */
export async function runOwnedRecordingOwnerDataFixture() {
  if (!globalThis.indexedDB || typeof HTMLCanvasElement.prototype.captureStream !== 'function' ||
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function')
    return { kind: 'owned-native-recording-owner-data', result: 'unsupported', physicalCapture: false };
  function requireValue<T>(value: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>): T {
    if (!value.ok) throw new Error('Owned managed operation refused: ' + value.reason); return value.value;
  }
  const producer = document.createElement('canvas'), output = document.createElement('canvas');
  producer.width = 32; producer.height = 24; output.width = 8; output.height = 8;
  const paint = producer.getContext('2d'), display = output.getContext('2d');
  if (!paint || !display) throw new Error('Owned canvas unavailable');
  paint.fillStyle = '#ff0000'; paint.fillRect(0, 0, 32, 24);
  const stream = producer.captureStream(10), track = stream.getVideoTracks()[0];
  if (!track) throw new Error('Owned digital track unavailable');
  let producerTimers = 1;
  const drawTimer = setInterval(() => paint.fillRect(0, 0, 32, 24), 100);
  const databaseName = 'managed-recording-' + crypto.randomUUID(), ownerId = 'managed-recording-owner';
  const ports: ReturnType<typeof createIndexedDbOwnerDataStorage>[] = [], controllers: RecordingOwnerDataController[] = [];
  const producers: RecordingOwnerDataPort[] = [];
  const owner = new AbortController(), recordingConsent = new AbortController(), cameraConsent = new AbortController();
  const ownerConsent = new AbortController();
  let ownerAllowed = true, captureAllowed = false, playbackAllowed = false, outputAllowed = false, retirements = 0;
  let copied = 0, frames = 0, admitted = 0, nativeOpens = 0, liveDelivered = 0, outputDelivered = 0, outputReleased = 0;
  let latest: Observation | undefined, latestContext: DeliveryContext | undefined, handle: MediaRecordingCaptureHandle | undefined;
  let recordingPort: RecordingOwnerDataPort | undefined, inputRoute: ReturnType<ReturnType<typeof createDeviceRuntime>['route']> | undefined;
  let outputRoute: ReturnType<ReturnType<typeof createDeviceRuntime>['route']> | undefined;
  let flushing: Promise<void> | undefined, captureFailure = false, recordTarget = 0, timeOffset = 0;
  const now = () => Date.now() + timeOffset, deadline = () => now() + 10000;
  const scopes: RecordingOwnerDataScope[] = [];
  let delayNext = false, held = false, announce = () => {}, release = () => {};
  const base = createIndexedDbOwnerDataStorage({ databaseName }); ports.push(base);
  const delayed: OwnerDataStorage = { async transact(selectedOwner, mutation, guard) {
    if (delayNext) { delayNext = false; held = true; announce(); await new Promise<void>(resolve => { release = resolve; }); held = false; }
    return base.transact(selectedOwner, mutation, guard);
  } };
  function make(selectedOwner = ownerId, storage?: OwnerDataStorage, authorize?: RecordingOwnerDataOptions['authorize']) {
    let actual = storage;
    if (!actual) { const port = createIndexedDbOwnerDataStorage({ databaseName }); ports.push(port); actual = port; }
    const controller = createRecordingOwnerData({ ownerId: selectedOwner, ownerSignal: owner.signal, storage: actual, trustedNow: now,
      authorizeRecording(request) {
        if (request.action === 'capture' && !captureAllowed || request.action === 'playback' && !playbackAllowed) return undefined;
        return { request, signal: recordingConsent.signal, expiresAt: request.expiresAt };
      }, authorize: authorize ?? (scope => {
        if (scopes.length < 2048) scopes.push(scope);
        return ownerAllowed ? { scope, signal: ownerConsent.signal, expiresAt: scope.deadline, isCurrent: () => true } : undefined;
      }) }); controllers.push(controller); return controller;
  }
  const managed = make(ownerId, delayed);
  const scope = { principalId: 'managed-recording-principal', applicationId: 'managed-recording-app', sessionId: 'managed-recording-session' };
  const captureEnd = performance.now() + 7000;
  const live = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'managed-decoded-retrieval', maxPendingDeliveries: 1,
    authorize(request) {
      if (performance.now() >= captureEnd || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId ||
        request.sessionId !== scope.sessionId || request.source.capabilityId !== 'camera-frame' || request.sink.deviceId !== 'managed-recording:input' ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return undefined;
      return { expiresAt: captureEnd, maxHz: 10, maxAgeMs: 250 };
    } });
  const playback = createDeviceRuntime({ now, clockDomain: 'recording-host-emission', maxPendingDeliveries: 1,
    authorize(request) {
      if (!outputAllowed || !recordingPort || recordingPort.signal.aborted || request.principalId !== scope.principalId ||
        request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId || request.source.deviceId !== 'managed-recording:playback' ||
        request.sink.deviceId !== 'managed-recording:output' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return undefined;
      return { expiresAt: deadline(), maxHz: 10, maxAgeMs: 250 };
    } });
  const selectedId = track.getSettings().deviceId ?? 'owned-managed-canvas';
  const environment: BrowserCameraEnvironment = { fixtureKind: 'owned-canvas-fixture',
    enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: selectedId }]),
    getUserMedia(constraints) { nativeOpens++;
      if (constraints.audio !== false || typeof constraints.video !== 'object' || typeof constraints.video.deviceId !== 'object' ||
        Array.isArray(constraints.video.deviceId) || constraints.video.deviceId.exact !== selectedId) throw new Error('Owned exact selector required');
      return Promise.resolve(stream);
    }, createVideo: () => document.createElement('video'), createCanvas: () => document.createElement('canvas'),
    MediaStream, HTMLVideoElement, HTMLCanvasElement, ImageData, target: window, document, mediaDevicesTarget: new EventTarget(),
    hidden: () => document.hidden, focused: () => document.hasFocus(), secureContext: () => isSecureContext };
  const camera = createBrowserCameraProvider({ runtime: live, ownerSignal: owner.signal, scope, now: () => performance.now(), environment,
    authorizeCapture(request) { if (performance.now() >= captureEnd) return undefined;
      return { request, signal: cameraConsent.signal, expiresAt: captureEnd }; } });
  function source(observation: Observation) { return { ...observation.source, applicationId: scope.applicationId,
    sessionId: scope.sessionId, clockId: observation.clockDomain }; }
  function accept(observation: Observation, context: DeliveryContext) {
    if (context.signal.aborted || !context.isCurrent()) return;
    latest = observation; latestContext = context; liveDelivered++;
    if (!handle || !recordingPort || admitted >= recordTarget) return;
    const frame = observation.value as unknown as BrowserCameraFrame;
    const result = recordingPort.recording.enqueue(handle, { bytes: Uint8Array.from(frame.rows.flat()), sequence: observation.sequence,
      sourceTime: { clockId: observation.clockDomain, at: observation.timestamp }, quality: observation.quality,
      ...(typeof observation.provenance?.mediaTimeSeconds === 'number' ? { decodedMediaTime: observation.provenance.mediaTimeSeconds } : {}) },
      { source: source(observation), signal: context.signal, isCurrent: () => context.isCurrent() });
    if (!result.ok) { captureFailure = true; return; } admitted++;
    flushing = recordingPort.recording.flush().then(result => {
      if (result.ok) frames += result.value.committed; else if (!held) captureFailure = true;
    }).finally(() => { flushing = undefined; });
  }
  async function until(predicate: () => boolean, phase: string) {
    const end = performance.now() + 2000;
    while (!predicate() && performance.now() < end) { if (captureFailure) throw new Error('Owned capture failed: ' + phase);
      await new Promise(resolve => setTimeout(resolve, 20)); live.flush(); }
    if (!predicate()) throw new Error('Owned condition deadline: ' + phase);
  }
  function retire() { retirements++; outputRoute?.stop('managed-owned-port-retired'); inputRoute?.stop('managed-owned-port-retired'); display!.clearRect(0, 0, 8, 8); }
  async function open(controller: RecordingOwnerDataController, retireOwned = () => {}) {
    const port = requireValue(await controller.openRecording({ purpose: 'owner-recording', expiresAt: deadline(), retireOwned })); producers.push(port); return port;
  }
  let proof: object | undefined;
  try {
    const inventory = await camera.inspect(); if (!inventory.ok || inventory.value.length !== 1) throw new Error('Owned inventory unavailable');
    const started = await camera.start(inventory.value[0]!.selection, { purpose: 'owned-managed-recording' });
    if (!started.ok) throw new Error('Owned capture unavailable');
    const device = started.value.device;
    const sink = live.registerSink({ device: parseDeviceDescriptor({ ...device, id: 'managed-recording:input', capabilities: device.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) }), capability: 'camera-frame', apply: accept, release() { latestContext = undefined; } });
    live.setReadiness(sink, 'available'); inputRoute = live.route({ from: started.value.source, to: sink, ...scope });
    if (!inputRoute.start().ok) throw new Error('Independent input route denied'); await until(() => !!latest && !!latestContext, 'native-current-frame');
    ownerAllowed = false;
    const deniedOpen = await managed.openRecording({ purpose: 'owner-recording', expiresAt: deadline(), retireOwned: retire });
    if (deniedOpen.ok || deniedOpen.reason !== 'denied') throw new Error('Owner recording decline lost');
    ownerAllowed = true; recordingPort = await open(managed, retire);
    const automaticRecords = requireValue(await recordingPort.recording.listReviewed({ purpose: 'owner-review', expiresAt: deadline() })).length;
    const deniedCapture = await recordingPort.recording.requestCapture({ source: source(latest!), purpose: 'owner-recording', expiresAt: deadline(), retentionMs: 60000 });
    if (deniedCapture.ok || deniedCapture.reason !== 'denied' || automaticRecords) throw new Error('Explicit producer opt-in missing');
    captureAllowed = true;
    const capture = recordingPort.recording.requestCapture({ source: source(latest!), purpose: 'owner-recording', expiresAt: deadline(), retentionMs: 60000 });
    const clip = requireValue(await capture); handle = clip.handle; recordTarget = 2;
    await until(() => frames === 2 && !flushing, 'native-two-recorded-frames');
    const request = { clipId: clip.clipId, purpose: 'owner-portability', destinationId: 'owner-local-copy', expiresAt: deadline(), afterIndex: 0, limit: 4 };
    ownerAllowed = false; const deniedExport = await managed.exportPage(request); ownerAllowed = true;
    if (deniedExport.ok || deniedExport.reason !== 'denied') throw new Error('Export decline lost');
    const page = requireValue(await managed.exportPage(request));
    if (page.frames.length !== 2 || !await verifyAssetContent(page.frames[0]!.reference, page.frames[0]!.bytes)) throw new Error('Actual frame hash unavailable');
    const exportedKeys = Object.keys(page).sort(), frameKeys = Object.keys(page.frames[0]!).sort();
    const encoded = JSON.stringify(page);
    for (const excluded of [ownerId, selectedId, scope.principalId, scope.applicationId, scope.sessionId, 'registrationId', 'sourceContext', 'authorize'])
      if (encoded.includes(excluded)) throw new Error('Closed managed projection leaked private context');
    const fabricated = await managed.storeRegisteredExport({ ...page, token: 'PRIVATE_TOKEN' }, { purpose: request.purpose, destinationId: request.destinationId });
    const wrongDestination = await managed.storeRegisteredExport(page, { purpose: request.purpose, destinationId: 'forged-local-copy' });
    if (fabricated.ok || wrongDestination.ok) throw new Error('Fabricated managed copy accepted');
    copied = requireValue(await managed.storeRegisteredExport(page, { purpose: request.purpose, destinationId: request.destinationId })).copied;
    const replay = await managed.storeRegisteredExport(page, { purpose: request.purpose, destinationId: request.destinationId });
    if (copied !== 2 || replay.ok) throw new Error('Issued copy identity was replayable');
    playbackAllowed = true;
    const player = requireValue(await recordingPort.recording.requestPlayback({ clipId: clip.clipId, destinationId: 'owned-output', purpose: 'owner-playback', expiresAt: deadline() }));
    const played = requireValue(await recordingPort.recording.pull(player));
    const replayDevice = parseDeviceDescriptor({ ...device, id: 'managed-recording:playback' });
    const outputSource = playback.registerSource({ device: replayDevice, capability: 'camera-frame' });
    const outputSink = playback.registerSink({ device: parseDeviceDescriptor({ ...replayDevice, id: 'managed-recording:output', capabilities: replayDevice.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) }), capability: 'camera-frame',
      apply(observation, context) { if (recordingPort?.signal.aborted || context.signal.aborted || !context.isCurrent()) return;
        display.putImageData(new ImageData(Uint8ClampedArray.from((observation.value as unknown as BrowserCameraFrame).rows.flat()), 8, 8), 0, 0); outputDelivered++; },
      release() { display.clearRect(0, 0, 8, 8); outputReleased++; } });
    playback.setReadiness(outputSource, 'available'); playback.setReadiness(outputSink, 'available');
    outputRoute = playback.route({ from: outputSource, to: outputSink, ...scope });
    const deniedOutput = outputRoute.start(); if (deniedOutput.ok || outputDelivered) throw new Error('Independent output grant missing');
    outputAllowed = true; if (!outputRoute.start().ok) throw new Error('Owned output grant unavailable');
    if (!playback.publish(outputSource, { format: 'rgba8', width: 8, height: 8,
      rows: Array.from({ length: 8 }, (_, row) => Array.from(played.frame.bytes.subarray(row * 32, row * 32 + 32))) },
    { timestamp: played.playback.at, clockDomain: played.playback.clockId }).ok) throw new Error('Current playback publish denied');
    playback.flush(); if (outputDelivered !== 1) throw new Error('Owned output pixels unavailable');
    const beforePixels = Array.from(display.getImageData(0, 0, 8, 8).data);
    const exportedExpiry = page.expiresAt;
    // The delay is an owned scheduling seam BEFORE real IDB; no mock successful
    // transaction replaces the actual atomic engine or its final cancellation guard.
    const entered = new Promise<void>(resolve => { announce = resolve; }); delayNext = true; recordTarget = 3;
    await until(() => held, 'held-actual-producer-call'); await entered;
    const heldRaw = recordingPort.recording.status().rawPending;
    const right = make();
    const pending = requireValue(await right.beginDeletion({ clipIds: [clip.clipId], purpose: 'owner-remove' }));
    let closeSettled = false; const closing = recordingPort.close().then(() => { closeSettled = true; });
    await Promise.resolve(); const closeWasPending = !closeSettled;
    release(); release = () => {}; if (flushing) await flushing; await closing;
    if (heldRaw !== 1 || !closeWasPending || frames !== 2 || !recordingPort.signal.aborted) throw new Error('Held storage reservation retired early');
    handle = undefined; await camera.close(); inputRoute.stop('owned-native-complete'); clearInterval(drawTimer); producerTimers = 0;
    const afterPixels = Array.from(display.getImageData(0, 0, 8, 8).data);
    if (!retirements || !outputReleased || afterPixels.some(byte => byte !== 0)) throw new Error('Managed output retirement retained visible pixels');
    await right.close(); const restarted = make();
    ownerAllowed = false; const deniedResume = await restarted.resumeDeletionReviewed(pending.operationId); ownerAllowed = true;
    if (deniedResume.ok || deniedResume.reason !== 'denied') throw new Error('Restart revived a stage approval');
    let deletion = requireValue(await restarted.inspectDeletion());
    for (let stage = 0; stage < 5 && deletion?.state === 'pending'; stage++) deletion = requireValue(await restarted.resumeDeletionReviewed(pending.operationId));
    if (deletion?.state !== 'completed' || deletion.removed.clips !== 1 || deletion.removed.copyFrames !== 2) throw new Error('Reviewed native deletion incomplete');
    const audit = requireValue(await restarted.listAudit());
    if (audit.length !== 1 || audit[0]?.state !== 'completed' || audit[0]?.action !== 'deletion') throw new Error('Redacted native deletion audit unavailable');
    for (const excluded of [ownerId, request.destinationId, clip.clipId, selectedId, 'PRIVATE_', 'hex', 'reference'])
      if (JSON.stringify(audit).includes(excluded)) throw new Error('Native audit retained private values');
    const afterRestart = await open(restarted), restored = afterRestart.recording.status();
    const retained = requireValue(await afterRestart.recording.listReviewed({ purpose: 'owner-review', expiresAt: deadline() })).length;
    if (restored.captures || restored.players || restored.pendingFrames || retained) throw new Error('Restart revived data or live authority');
    await afterRestart.close();
    // Retention boundary uses a declared trusted host fixture offset, never a
    // source-clock mapping. Source time and original ingestion TTL remain fixed.
    const ttlOwner = make('managed-recording-ttl-owner'), ttlPort = await open(ttlOwner);
    const ttlClip = await recordPublicPixels(ttlPort, page.frames[0]!.bytes, now, 1000);
    const ttlPage = requireValue(await ttlOwner.exportPage({ ...request, clipId: ttlClip, expiresAt: deadline() }));
    requireValue(await ttlOwner.storeRegisteredExport(ttlPage, { purpose: request.purpose, destinationId: request.destinationId }));
    timeOffset += Math.max(0, ttlPage.expiresAt - now());
    const expiry = requireValue(await ttlOwner.sweep()), expiryAudit = requireValue(await ttlOwner.listAudit());
    if (expiry.clipsRemoved !== 1 || expiry.copyFramesRemoved !== 1 || expiryAudit.length !== 1 ||
      expiryAudit[0]!.expiresAt !== expiryAudit[0]!.at + 30 * 86400000) throw new Error('Original native TTL or30d audit changed');
    timeOffset += 30 * 86400000;
    requireValue(await ttlOwner.sweep()); const afterAuditRetention = requireValue(await ttlOwner.listAudit()).length;
    if (afterAuditRetention) throw new Error('Expired audit remained retained');
    const exportGrants = scopes.filter(value => value.action === 'export' && value.frameHashes.length);
    const copyGrants = scopes.filter(value => value.action === 'register-copy');
    const stageGrants = scopes.filter(value => value.action === 'resume-delete');
    if (!exportGrants.length || !copyGrants.length || stageGrants.length < 2 || exportGrants.some(value => value.afterIndex !== 0 || value.limit !== 4))
      throw new Error('Exact content or stage grants unavailable');
    proof = { kind: 'owned-native-recording-owner-data', result: 'pass', physicalCapture: false, nativeOpens, liveDelivered, admitted,
      committed: frames, copied, deniedOpen, deniedCapture, deniedExport, fabricated, wrongDestination, replay, automaticRecords,
      deniedOutput, outputDelivered, outputReleased, retirements, beforePixels, afterPixels, heldRaw, closeWasPending, closeSettled,
      schedulingSeam: 'owned caller delay before actual IndexedDB engine', storageEngine: 'actual-IndexedDB',
      sourceClock: page.frames[0]!.sourceTime, sourceQuality: page.frames[0]!.quality, frameHash: page.frames[0]!.reference.sha256,
      retainedBytes: Array.from(page.frames[0]!.bytes), exportedKeys, frameKeys, exportedExpiry, deniedResume, deletion, audit,
      afterRestart: { captures: restored.captures, players: restored.players, pendingFrames: restored.pendingFrames, retained },
      expiry, expiryAudit, afterAuditRetention, exactContentExportGrants: exportGrants.length, exactCopyGrants: copyGrants.length,
      freshStageGrants: stageGrants.length, unmanagedReturnedCopiesRecalled: false, futureLegacyStoresQualified: false };
  } finally {
    release(); clearInterval(drawTimer); producerTimers = 0; owner.abort(); cameraConsent.abort(); recordingConsent.abort(); ownerConsent.abort();
    await camera.close(); live.close(); playback.close();
    for (const controller of controllers) await controller.close();
    for (const port of producers) await port.close();
    for (const port of ports) port.close();
    for (const item of stream.getTracks()) item.stop();
    producer.width = 1; producer.height = 1; output.width = 1; output.height = 1;
    await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(databaseName);
      const timeout = setTimeout(() => reject(new Error('Owned database cleanup deadline')), 2000);
      deletion.onsuccess = () => { clearTimeout(timeout); resolve(); };
      deletion.onerror = deletion.onblocked = () => { clearTimeout(timeout); reject(new Error('Owned database cleanup refused')); }; });
  }
  const cleanup = producers.map(port => port.recording.status());
  if (cleanup.some(value => value.rawPending || value.captures || value.players || value.pendingFrames || value.pendingBytes || value.timers || value.listeners))
    throw new Error('Actual producer cleanup incomplete');
  return { ...proof, cleanup: { producers: cleanup, camera: camera.snapshot(), producerTimers, held,
    tracksEnded: stream.getTracks().every(item => item.readyState === 'ended'), databaseDeleted: true, producerWidth: producer.width,
    producerHeight: producer.height, outputWidth: output.width, outputHeight: output.height, nativePortsClosed: ports.length } };
}

async function recordPublicPixels(port: RecordingOwnerDataPort, pixels: Uint8Array, now: () => number, retentionMs: number) {
  const descriptor = parseDeviceDescriptor({ schemaVersion: 1, id: 'managed-owner-digital-source', label: 'Owned software pixels', revision: 1,
    adapter: { id: 'example:managed-owner-source', version: '1.0.0' }, runtime: { platform: 'owned-application' },
    capabilities: [{ id: 'rgba-frame', semantic: 'example:rgba-frame', schemaVersion: 1, kind: 'sample',
      value: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'array', minItems: 32, maxItems: 32,
        items: { type: 'scalar', unit: '1', min: 0, max: 255 } } }, delivery: { mode: 'latest', maxHz: 100, maxAgeMs: 100 }, permissions: ['subscribe'] }] });
  const runtime = createDeviceRuntime({ now, clockDomain: 'managed-application-host-source', authorize: () => ({ expiresAt: now() + 1000, maxHz: 100, maxAgeMs: 100 }) });
  const scope = { principalId: 'ttl-owner', applicationId: 'managed-ttl-application', sessionId: 'managed-ttl-session' };
  const source = runtime.registerSource({ device: descriptor, capability: 'rgba-frame' });
  const facts = { deviceId: descriptor.id, capabilityId: 'rgba-frame', registrationId: source.id,
    applicationId: scope.applicationId, sessionId: scope.sessionId, clockId: runtime.clockDomain };
  const capture = await port.recording.requestCapture({ source: facts, purpose: 'owner-retained-software-frame', expiresAt: now() + 1000, retentionMs });
  if (!capture.ok) { runtime.close(); throw new Error('Owned software capture refused'); }
  let admitted = false;
  const sink = runtime.registerSink({ device: parseDeviceDescriptor({ ...descriptor, id: 'managed-owner-digital-sink', capabilities: descriptor.capabilities.map(capability =>
    ({ ...capability, kind: 'property', permissions: ['write'] })) }) as DeviceDescriptor, capability: 'rgba-frame',
    apply(observation, context) { admitted = port.recording.enqueue(capture.value.handle, { bytes: Uint8Array.from((observation.value as readonly (readonly number[])[]).flat()),
      sourceTime: { clockId: observation.clockDomain, at: observation.timestamp }, sequence: observation.sequence, quality: observation.quality },
      { source: facts, signal: context.signal, isCurrent: () => context.isCurrent() }).ok; }, release() {} });
  try {
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    const route = runtime.route({ from: source, to: sink, ...scope }); if (!route.start().ok) throw new Error('Owned software route refused');
    if (!runtime.publish(source, Array.from({ length: 8 }, (_, row) => Array.from(pixels.subarray(row * 32, row * 32 + 32)))).ok) throw new Error('Owned software pixels refused');
    runtime.flush(); if (!admitted) throw new Error('Owned software route did not admit bytes');
    const flushed = await port.recording.flush(); if (!flushed.ok || flushed.value.committed !== 1) throw new Error('Actual owned software commit refused');
    port.recording.revoke(capture.value.handle); return capture.value.clipId;
  } finally { runtime.close(); }
}
