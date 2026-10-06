import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, createProfileResolutionController, createTrustedConnectorProfileRegistry, parseDeviceDescriptor } from '@101/connect';
import { createNodeMemoryProfile, NODE_MEMORY_REVIEWED_SHA256 } from './node-memory-profile.ts';

async function sourceBytes() {
  const file = await open(new URL('./node-memory-producer.mjs', import.meta.url), 'r');
  try {
    const buffer = Buffer.alloc(1048577); let size = 0;
    for (let turn = 0; turn < 256; turn++) {
      const read = await file.read(buffer, size, buffer.length - size, size); size += read.bytesRead;
      if (size > 1048576) throw Error('reviewed-source-size');
      if (!read.bytesRead) {
        const bytes = buffer.subarray(0, size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), NODE_MEMORY_REVIEWED_SHA256);
        return bytes;
      }
    }
    throw Error('reviewed-source-work');
  } finally { await file.close(); }
}
async function until(check, reason, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await new Promise(resolve => setTimeout(resolve, 5)); }
}

/** Scripted explicit review decisions for one owned local Node process. Selection is
 * semantic configuration only; the distinct host callback must still grant each route. */
export async function runManualProfileResolutionExample() {
  const source = await sourceBytes();
  const reviewed = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const registry = createTrustedConnectorProfileRegistry(), manifest = createNodeMemoryProfile(); let factories = 0;
  await registry.registerTrusted({ manifest, source, factory() { factories++; return reviewed.createNodeMemoryDecoder(); } });
  const pin = Object.freeze({ id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 });
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `${source.toString('utf8')}\nrunProducer();`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let childClosed = false, faults = 0;
  const childDone = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
  child.on('error', () => { faults++; }); child.stdin.on('error', () => { if (!childClosed) faults++; });
  child.stderr.on('data', () => { faults++; });
  const clockId = `node-rss:${child.pid}`, hostClock = `profile-host:${process.pid}`, candidateId = `owned-node:${child.pid}`;
  const scope = Object.freeze({ kind: 'local', id: 'manual-node-profile-resolution' });
  const observedIdentity = Object.freeze({ backendId: 'node-memory', wireVersion: 1, clockId });
  const at = Math.floor(performance.now()), expiresAt = at + 2000;
  const candidate = { schemaVersion: 1, id: candidateId, scope, expiresAt,
    recovery: { action: 'review-identity', hint: 'Select the reviewed Node memory profile.' },
    evidence: [{ stage: 'observed', kind: 'observation', candidateId, scope, receiptId: `owned:child-${child.pid}`, at, expiresAt }] };
  const resolution = createProfileResolutionController({ registry, profiles: [pin], scope, now: () => performance.now(),
    verifyObservation(value, evidence, facts) {
      return !childClosed && value.id === candidateId && value.scope.kind === 'local' && value.scope.id === scope.id &&
        evidence.receiptId === candidate.evidence[0].receiptId && evidence.at === at && evidence.expiresAt === expiresAt &&
        facts.backendId === 'node-memory' && facts.wireVersion === 1 && facts.clockId === clockId;
    } });
  const steps = [], readings = [], samples = []; let monitorAllowed = false, commandAllowed = false, writes = 0, cleanups = 0;
  let resident, monitor, control, samplingSink, connector, capture, monitorRoute, commandRoute;
  function visible(action) {
    const state = resolution.snapshot();
    assert.ok(steps.length < 16);
    steps.push({ action, state: state.state, outcome: state.outcome,
      current: state.current?.profile ?? null, semantics: state.current?.resources.map(resource => ({ id: resource.capability.id,
        semantic: resource.capability.semantic, direction: resource.direction, value: resource.capability.value, calibration: resource.calibration })) ?? [],
      pending: state.pending?.profile ?? null });
  }
  const runtime = createDeviceRuntime({ clockDomain: hostClock, now: () => performance.now(), authorize(request) {
    if (request.principalId !== 'owned-node-operator' || request.applicationId !== 'manual-profile-example' || request.sessionId !== 'local-process' || request.sourceOperation !== 'subscribe') return;
    const monitoring = monitorAllowed && request.source.registrationId === resident?.id && request.sink.registrationId === monitor?.id && request.sinkOperation === 'write';
    const command = commandAllowed && request.source.registrationId === control?.id && request.sink.registrationId === samplingSink?.id && request.sinkOperation === 'invoke';
    if (monitoring || command) return { expiresAt: Math.min(expiresAt, performance.now() + 1000), maxAgeMs: 1000, ...(monitoring ? { maxHz: 20 } : {}) };
  } });
  const routeScope = { principalId: 'owned-node-operator', applicationId: 'manual-profile-example', sessionId: 'local-process' };
  try {
    const observed = resolution.observe({ candidate, observedIdentity }); assert.ok(observed.ok); visible('Observe owned process');
    assert.equal(resolution.snapshot().state, 'unknown'); assert.equal(factories, 0);
    assert.equal(resolution.request(observed.value, { ...pin, version: '9.0.0' }).ok, false); visible('Unsupported profile remains visible');
    const discarded = resolution.request(observed.value, pin); assert.ok(discarded.ok); visible('Review exact pinned semantics');
    assert.equal(factories, 0); assert.ok(resolution.cancel(discarded.value).ok); visible('Cancel inert review');
    const review = resolution.request(observed.value, pin); assert.ok(review.ok);
    const approved = resolution.decide(review.value, true); assert.ok(approved.ok && approved.value); visible('Choose reviewed profile');
    assert.equal(factories, 0);
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: candidateId, label: 'Owned Node process', revision: 1,
      adapter: { id: manifest.id, version: manifest.version }, runtime: { platform: 'node-process' }, capabilities: manifest.resources.map(resource => resource.capability) });
    resident = runtime.registerSource({ device, capability: 'resident' });
    const residentCapability = manifest.resources[0].capability, samplingCapability = manifest.resources[2].capability;
    const monitorDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-node-monitor', label: 'Local memory monitor', revision: 1,
      adapter: { id: 'example:manual-monitor', version: '1.0.0' }, runtime: { platform: 'node-caller' }, capabilities: [
        { ...residentCapability, id: 'memory', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } }] });
    monitor = runtime.registerSink({ device: monitorDevice, capability: 'memory', apply(observation, context) {
      if (!context.isCurrent() || context.signal.aborted) return;
      readings.push({ value: observation.value, quality: observation.quality, sourceTime: observation.provenance.sourceTime,
        calibration: observation.provenance.calibration, receipt: { clockId: observation.clockDomain, at: observation.timestamp } });
      if (readings.length > 32) readings.shift();
    }, release() {} });
    const controlDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-node-control', label: 'Local sampling selection', revision: 1,
      adapter: { id: 'example:manual-control', version: '1.0.0' }, runtime: { platform: 'node-caller' }, capabilities: [
        { id: 'enabled', semantic: samplingCapability.semantic, schemaVersion: 1, kind: 'event', value: samplingCapability.value,
          delivery: samplingCapability.delivery, permissions: ['subscribe'] }] });
    control = runtime.registerSource({ device: controlDevice, capability: 'enabled' });
    const created = resolution.createConnector(approved.value, {
      onSample(frame) {
        samples.push({ resourceId: frame.resourceId, sourceTime: frame.sourceTime, receivedAt: frame.receivedAt, quality: frame.quality });
        if (samples.length > 32) samples.shift();
        if (frame.resourceId !== 'resident') return;
        if (frame.quality !== 'valid') { runtime.setReadiness(resident, 'unavailable'); return; }
        runtime.setReadiness(resident, 'available', Math.min(expiresAt, frame.receivedAt + 1000));
        runtime.publish(resident, frame.value, { sequence: frame.sequence, timestamp: frame.receivedAt, clockDomain: hostClock,
          quality: frame.quality, provenance: { profile: pin, sourceTime: frame.sourceTime, calibration: frame.calibration } }); runtime.flush();
      },
      onUnavailable(id) { if (id === 'resident') runtime.setReadiness(resident, 'unavailable'); },
      write(bytes, context) {
        if (!context.isCurrent() || context.signal.aborted || !child.stdin.writable) return;
        writes++; if (context.cleanup) cleanups++;
        return new Promise((resolve, reject) => {
          if (!context.isCurrent() || context.signal.aborted || !child.stdin.writable) return resolve();
          child.stdin.write(bytes, error => error ? reject(Error('owned-child-write')) : resolve());
        });
      },
    }); assert.ok(created.ok); connector = created.value; assert.equal(factories, 0);
    samplingSink = runtime.registerSink({ device, capability: 'sampling', apply: (observation, context) => connector.apply('sampling', observation, context),
      release: (reason, context) => connector.release('sampling', reason, context) });
    for (const handle of [monitor, control, samplingSink]) runtime.setReadiness(handle, 'available');
    const started = connector.start(); assert.ok(started.ok); capture = started.value; assert.equal(factories, 1);
    child.stdout.on('data', bytes => {
      if (bytes.byteLength > 65536) { faults++; resolution.clear(); return; }
      if (connector.status().closed) return;
      for (let offset = 0; offset < bytes.byteLength; offset += 8192) if (!connector.push(capture, bytes.subarray(offset, offset + 8192)).ok) faults++;
    });
    await until(() => samples.length >= 2, 'actual initial Node RSS reading');
    const deniedMonitor = runtime.route({ from: resident, to: monitor, ...routeScope }), deniedCommand = runtime.route({ from: control, to: samplingSink, ...routeScope });
    assert.equal(deniedMonitor.start().ok, false); assert.equal(deniedCommand.start().ok, false);
    assert.equal(writes, 0); assert.equal(readings.length, 0); visible('Profile choice supplies no resource grant');
    monitorAllowed = true; monitorRoute = runtime.route({ from: resident, to: monitor, ...routeScope }); assert.ok(monitorRoute.start().ok);
    commandAllowed = true; commandRoute = runtime.route({ from: control, to: samplingSink, ...routeScope }); assert.ok(commandRoute.start().ok);
    assert.ok(runtime.publish(control, true, { operationId: '1', deadline: performance.now() + 1000 }).ok); runtime.flush();
    await until(() => readings.length >= 3 && commandRoute.operations()[0]?.effectEvidence === 'observed', 'separately granted real Node sample and command');
    assert.ok(readings.every(reading => Number.isSafeInteger(reading.value) && reading.value > 0 && reading.quality === 'valid' &&
      reading.sourceTime.clockId === clockId && reading.receipt.clockId === hostClock && reading.calibration.revision === 1 && reading.calibration.unit === 'By'));
    const beforeCancel = readings.length, cancelled = resolution.request(observed.value, pin); assert.ok(cancelled.ok); assert.ok(resolution.cancel(cancelled.value).ok);
    assert.equal(resolution.isCurrent(approved.value), true); assert.equal(connector.status().active, true);
    await until(() => readings.length > beforeCancel, 'cancel retains live current profile'); visible('Cancel keeps current valid profile');
    assert.equal(resolution.request(observed.value, { ...pin, codeSha256: '0'.repeat(64) }).ok, false);
    assert.equal(resolution.isCurrent(approved.value), true); visible('Unsupported review keeps current valid profile');
    const replacing = resolution.request(observed.value, pin); assert.ok(replacing.ok);
    const next = resolution.decide(replacing.value, true); assert.ok(next.ok && next.value);
    assert.equal(connector.status().closed, true); assert.equal(connector.push(capture, new Uint8Array()).ok, false);
    assert.equal(resolution.isCurrent(approved.value), false); assert.equal(cleanups, 1);
    assert.equal(monitorRoute.status().state, 'closed'); commandRoute.stop(); visible('Explicit replacement retires prior connector');
    const replacement = resolution.createConnector(next.value, { onSample() {}, onUnavailable() {} }); assert.ok(replacement.ok);
    await until(() => resolution.snapshot().state === 'expired', 'quiet owned expiry timer', 2500);
    assert.equal(replacement.value.status().closed, true); assert.equal(resolution.isCurrent(next.value), false);
    assert.equal(resolution.snapshot().timerArmed, false); visible('Expiry retires the current choice');
    assert.equal(faults, 0);
    resolution.close(); assert.equal(resolution.snapshot().state, 'closed'); visible('Close clears local resolution');
    return { kind: 'actual-node-rss-explicit-profile-resolution', sourceSha256: NODE_MEMORY_REVIEWED_SHA256, publicEsm: import.meta.resolve('@101/connect'),
      steps, readings, samples, factories, writes, cleanups,
      checks: { fixedVerifiedFactoryAndChildBytes: true, unknownWithoutAutomaticSemantics: true, unsupportedVisible: true, reviewInertUntilExplicitStart: true,
        separateResourceGrants: true, actualRssProducerAndObservedCommand: true, sourceTimeCalibrationAndQualityPreserved: true,
        cancelAndUnsupportedRetainCurrent: true, replacementClosesPreviousBeforeCreation: true, retiredCaptureRejected: true,
        existingA01CleanupOnly: true, quietExpiryClosesOwnedConnector: true, permanentClose: true },
      limits: { retainedReadings: 32, retainedSamples: 32, visibleSteps: 16, observationMs: 2000,
        scope: 'Owned local Node process; scripted explicit review, not human/OS chooser or physical gateway qualification',
        cleanup: 'A01 bounded best-effort dispatch, not a physical rollback claim' } };
  } finally {
    commandRoute?.stop(); monitorRoute?.stop(); resolution.close(); runtime.close();
    child.stdin.end();
    if (!childClosed) {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 250), kill = setTimeout(() => child.kill('SIGKILL'), 750);
      await childDone; clearTimeout(terminate); clearTimeout(kill);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runManualProfileResolutionExample()));
