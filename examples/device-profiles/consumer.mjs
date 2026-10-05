import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, createProfileConnector, createTrustedConnectorProfileRegistry, parseDeviceDescriptor } from '@101/connect';
import { createNodeMemoryProfile, NODE_MEMORY_REVIEWED_SHA256 } from './node-memory-profile.ts';

async function reviewedSource() {
  // A literal owned artifact location, never a path supplied by a manifest or wire peer.
  const file = await open(new URL('./node-memory-producer.mjs', import.meta.url), 'r');
  try {
    const bounded = Buffer.alloc(1048577); let size = 0;
    for (let count = 0; count < 256; count++) {
      const read = await file.read(bounded, size, bounded.length - size, size); size += read.bytesRead;
      if (size > 1048576) throw Error('reviewed-source-size');
      if (!read.bytesRead) {
        const source = bounded.subarray(0, size);
        if (createHash('sha256').update(source).digest('hex') !== NODE_MEMORY_REVIEWED_SHA256) throw Error('reviewed-source-pin');
        return source;
      }
    }
    throw Error('reviewed-source-work');
  } finally { await file.close(); }
}
async function until(check, reason, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error(reason);
}

/** Actual Node RSS producer + explicit public SDK registrations and separately scoped local grants. */
export async function runNodeMemoryConnectorExample() {
  const source = await reviewedSource();
  // Import the verified bytes themselves; a later filesystem change cannot replace the factory.
  const reviewed = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const manifest = createNodeMemoryProfile(), registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source, factory: reviewed.createNodeMemoryDecoder });
  const binding = registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 });
  // Only the reviewed fixed module and its explicit local entrypoint execute in the owned child.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `${source.toString('utf8')}\nrunProducer();`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let childClosed = false; const closedChild = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
  child.on('error', () => {}); child.stdin.on('error', () => {});
  try {
  const clockId = `node-rss:${child.pid}`, hostClockId = `host-receipt:${process.pid}`;
  let commandAllowed = false, monitoringAllowed = false, samplingEnabled, stall = false, inputFrames = 0, writes = 0;
  let control, samplingSink, resident, memorySink, stateSink, capture;
  const readings = [], stateReadings = [], observedStates = [], invalidations = [], stalledSignals = []; let faults = 0;
  const scope = { principalId: 'memory-owner', applicationId: 'node-memory-example', sessionId: 'local-memory' };
  const runtime = createDeviceRuntime({ clockDomain: hostClockId, now: () => performance.now(), authorize(request) {
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId || request.sourceOperation !== 'subscribe') return;
    const command = commandAllowed && request.source.registrationId === control?.id && request.sink.registrationId === samplingSink?.id && request.sinkOperation === 'invoke';
    const monitor = monitoringAllowed && request.source.registrationId === resident?.id && request.sink.registrationId === memorySink?.id && request.sinkOperation === 'write';
    const state = monitoringAllowed && request.source.registrationId === sourceResources.get('enabled')?.id && request.sink.registrationId === stateSink?.id && request.sinkOperation === 'write';
    if (command || monitor || state) return { expiresAt: performance.now() + 5000, maxAgeMs: 1000, ...(monitor ? { maxHz: 20 } : {}) };
  } });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-node-memory', label: 'Owned Node memory process', revision: 1,
    adapter: { id: manifest.id, version: manifest.version }, runtime: { platform: 'node-process' }, capabilities: manifest.resources.map(resource => resource.capability) });
  const sourceResources = new Map();
  const connector = createProfileConnector({ binding, observedIdentity: { backendId: 'node-memory', wireVersion: 1, clockId }, now: () => performance.now(),
    onSample(frame) {
      if (frame.resourceId === 'enabled' && frame.quality === 'valid') { samplingEnabled = frame.value; observedStates.push(frame.value); if (observedStates.length > 32) observedStates.shift(); }
      const endpoint = sourceResources.get(frame.resourceId); if (!endpoint) return;
      if (frame.quality !== 'valid') { runtime.setReadiness(endpoint, 'unavailable'); return; }
      runtime.setReadiness(endpoint, 'available', frame.receivedAt + 1000);
      const resource = manifest.resources.find(resource => resource.capability.id === frame.resourceId);
      // No fictitious cross-clock map: original source stamps are producer provenance.
      runtime.publish(endpoint, frame.value, { sequence: frame.sequence, timestamp: frame.receivedAt, clockDomain: hostClockId, quality: frame.quality,
        ...(resource.capability.delivery.mode === 'reliable' ? { operationId: String(frame.sequence), deadline: frame.receivedAt + resource.capability.delivery.maxAgeMs } : {}),
        provenance: { profile: { id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 },
          sourceTime: { ...frame.sourceTime }, quality: frame.quality, calibration: frame.calibration ? { ...frame.calibration } : null } });
      runtime.flush();
    },
    onUnavailable(id) { invalidations.push(id); if (invalidations.length > 32) invalidations.shift(); const endpoint = sourceResources.get(id); if (endpoint) runtime.setReadiness(endpoint, 'unavailable'); },
    write(bytes, context) {
      if (!context.isCurrent() || context.signal.aborted) return;
      if (stall && !context.cleanup) { stalledSignals.push(context.signal); return new Promise(() => {}); }
      writes++;
      return new Promise((resolve, reject) => {
        if (!context.isCurrent() || context.signal.aborted || !child.stdin.writable) { resolve(); return; }
        child.stdin.write(bytes, error => error ? reject(Error('owned-writer')) : resolve());
      });
    },
  });
  let commandRoute, memoryRoute, stateRoute;
  try {
  for (const resource of manifest.resources.filter(resource => resource.direction === 'source')) sourceResources.set(resource.capability.id, runtime.registerSource({ device, capability: resource.capability.id }));
  resident = sourceResources.get('resident');
  samplingSink = runtime.registerSink({ device, capability: 'sampling', apply: (value, context) => connector.apply('sampling', value, context),
    release: (reason, context) => connector.release('sampling', reason, context) });
  const sampling = manifest.resources.find(resource => resource.capability.id === 'sampling').capability;
  const controlDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'local-sampling-control', label: 'Local sampling control', revision: 1,
    adapter: { id: 'example:local-control', version: '1.0.0' }, runtime: { platform: 'node-caller' },
    capabilities: [{ id: 'enabled', semantic: sampling.semantic, schemaVersion: sampling.schemaVersion, kind: 'event',
      value: sampling.value, delivery: sampling.delivery, permissions: ['subscribe'] }] });
  control = runtime.registerSource({ device: controlDevice, capability: 'enabled' });
  const residentCapability = manifest.resources.find(resource => resource.capability.id === 'resident').capability;
  const monitorDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'local-memory-monitor', label: 'Local memory monitor', revision: 1,
    adapter: { id: 'example:local-memory-monitor', version: '1.0.0' }, runtime: { platform: 'node-caller' },
    capabilities: [{ ...residentCapability, id: 'memory', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } }] });
  memorySink = runtime.registerSink({ device: monitorDevice, capability: 'memory', apply(observation, context) {
    if (!context.isCurrent() || context.signal.aborted) return;
    readings.push({ value: observation.value, sourceTime: observation.provenance.sourceTime, quality: observation.provenance.quality,
      calibration: observation.provenance.calibration, receipt: { clockId: observation.clockDomain, at: observation.timestamp } });
    if (readings.length > 32) readings.shift();
  }, release() {} });
  const enabledCapability = manifest.resources.find(resource => resource.capability.id === 'enabled').capability;
  const stateDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'local-state-monitor', label: 'Local sampling state', revision: 1,
    adapter: { id: 'example:local-state-monitor', version: '1.0.0' }, runtime: { platform: 'node-caller' },
    capabilities: [{ ...enabledCapability, id: 'state', permissions: ['write'], ownership: { mode: 'observe' } }] });
  stateSink = runtime.registerSink({ device: stateDevice, capability: 'state', apply(observation, context) {
    if (context.isCurrent() && !context.signal.aborted) { stateReadings.push({ value: observation.value, sourceTime: observation.provenance.sourceTime }); if (stateReadings.length > 32) stateReadings.shift(); }
  }, release() {} });
  for (const endpoint of [control, samplingSink, memorySink, stateSink]) runtime.setReadiness(endpoint, 'available');
  const started = connector.start(); assert.ok(started.ok); capture = started.value;
  const denied = runtime.route({ from: control, to: samplingSink, ...scope }); assert.equal(denied.start().ok, false); assert.equal(writes, 0);
  child.stdout.on('data', chunk => {
    // Split a native stream chunk into bounded work turns; no queue grows behind a stalled writer.
    if (chunk.byteLength > 65536) { faults++; connector.stop(); child.stdin.end(); return; }
    for (let offset = 0; offset < chunk.byteLength; offset += 8192) { inputFrames++; if (!connector.push(capture, chunk.subarray(offset, offset + 8192)).ok) faults++; }
  });
  child.stderr.on('data', () => { faults++; });
  child.on('error', () => { faults++; connector.stop(); });
  child.on('exit', () => connector.stop());
  child.stdin.on('error', () => { faults++; connector.stop(); });
    await until(() => samplingEnabled === false, 'initial-owned-reading');
    monitoringAllowed = true; memoryRoute = runtime.route({ from: resident, to: memorySink, ...scope }); assert.ok(memoryRoute.start().ok);
    stateRoute = runtime.route({ from: sourceResources.get('enabled'), to: stateSink, ...scope }); assert.ok(stateRoute.start().ok);
    commandAllowed = true; commandRoute = runtime.route({ from: control, to: samplingSink, ...scope }); assert.ok(commandRoute.start().ok);
    assert.ok(runtime.publish(control, true, { operationId: '1', deadline: performance.now() + 1000 }).ok); runtime.flush();
    await until(() => commandRoute.operations()[0]?.effectEvidence === 'observed' && readings.length > 0 && stateReadings.some(reading => reading.value === true), 'actual-ack-and-public-observed-state');
    assert.equal(samplingEnabled, true); const enabledEvidence = commandRoute.operations()[0];
    const beforeStall = readings.length; stall = true;
    assert.ok(runtime.publish(control, false, { operationId: '2', deadline: performance.now() + 1000 }).ok); runtime.flush();
    await until(() => stalledSignals.length === 1 && readings.length >= beforeStall + 2, 'stalled-command-independent-live-rss');
    assert.equal(samplingEnabled, true); const duringStall = connector.status(); assert.equal(duringStall.pendingCommands, 1); assert.equal(duringStall.inFlightWrites, 1);
    runtime.revoke(commandRoute);
    assert.ok(stalledSignals[0].aborted); await until(() => samplingEnabled === false && stateReadings.at(-1)?.value === false, 'declared-safe-state-observed');
    const afterRevoke = connector.status(); assert.equal(afterRevoke.pendingCommands, 0);
    assert.equal(afterRevoke.inFlightWrites, 1, 'an ignored-abort callback keeps its capacity reservation');
    const raw = JSON.stringify(readings); assert.equal(raw.includes('credential-sentinel'), false);
    assert.ok(readings.every(reading => Number.isSafeInteger(reading.value) && reading.value > 0 && reading.quality === 'valid' &&
      reading.sourceTime.clockId === clockId && reading.receipt.clockId === hostClockId && reading.calibration.revision === 1 && reading.calibration.unit === 'By'));
    assert.ok(readings.some(reading => !Number.isInteger(reading.sourceTime.at)), 'original fractional source time survives');
    connector.stop(); const oldCapture = capture; const restarted = connector.start(); assert.ok(restarted.ok); capture = restarted.value;
    assert.equal(connector.push(oldCapture, new Uint8Array()).ok, false);
    connector.close(); assert.equal(connector.start().ok, false);
    assert.equal(faults, 0);
    return { kind: 'actual-node-rss', sourceSha256: NODE_MEMORY_REVIEWED_SHA256, profile: { id: manifest.id, version: manifest.version },
      readings, stateReadings, inputFrames, writes, enabledEvidence: { handlerResult: enabledEvidence.handlerResult, effectEvidence: enabledEvidence.effectEvidence },
      checks: { verifiedReviewedBytes: true, fixedFactoryAndProcess: true, separateObservedFacts: true, deniedBeforeGrant: true,
        actualTargetAckAndStateReading: true, reliableStateResourcePublicRoute: true, sourceClockPreserved: true, hostReceiptClockSeparate: true, calibrationAndQualityPreserved: true,
        stalledWriteDoesNotBlockLiveRss: true, finitePendingAndWriteReservations: true, revokedSignal: true, declaredSafeFalseObserved: true,
        oldCaptureRejected: true, closePermanent: true }, limits: { framing: manifest.framing, budgets: manifest.budgets,
        retainedReadings: 32, ignoredAbortWriteRemainsReserved: true, safeState: 'bounded-best-effort-no-physical-rollback-claim' } };
  } finally {
    commandRoute?.stop(); memoryRoute?.stop(); stateRoute?.stop(); connector.close(); runtime.close();
  }
  } finally {
    child.stdin.end();
    if (!childClosed) {
      const timer = setTimeout(() => child.kill('SIGTERM'), 250);
      const kill = setTimeout(() => child.kill('SIGKILL'), 750);
      await closedChild; clearTimeout(timer); clearTimeout(kill);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runNodeMemoryConnectorExample()));
