import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createCapabilityInventory, createDeviceRuntime, createProfileConnector, createTrustedConnectorProfileRegistry,
  parseDeviceDescriptor } from '@101/connect';
import { createNodeMemoryProfile, NODE_MEMORY_REVIEWED_SHA256 } from './node-memory-profile.ts';

async function sourceBytes() {
  const file = await open(new URL('./node-memory-producer.mjs', import.meta.url), 'r');
  try {
    const buffer = Buffer.alloc(1048577); let size = 0;
    for (let turn = 0; turn < 256; turn++) {
      const read = await file.read(buffer, size, buffer.length - size, size); size += read.bytesRead;
      assert.ok(size <= 1048576, 'reviewed-source-size');
      if (!read.bytesRead) {
        const bytes = buffer.subarray(0, size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), NODE_MEMORY_REVIEWED_SHA256); return bytes;
      }
    }
    throw Error('reviewed-source-work');
  } finally { await file.close(); }
}
async function until(check, reason, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await new Promise(resolve => setTimeout(resolve, 5)); }
}

/** Two disposable local children, no write/command probe. Original child source
 * stamps remain producer provenance; host receipt clock measures local freshness. */
export async function runLiveInventoryExample() {
  const source = await sourceBytes();
  const reviewed = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const registry = createTrustedConnectorProfileRegistry(), manifest = createNodeMemoryProfile(); let factories = 0;
  await registry.registerTrusted({ manifest, source, factory() { factories++; return reviewed.createNodeMemoryDecoder(); } });
  const pin = Object.freeze({ id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 });
  const binding = registry.resolve(pin);
  const scenarios = [];
  for (const mode of ['quiet-expiry', 'child-loss']) {
    const ageMs = mode === 'quiet-expiry' ? 100 : 500;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `${source.toString('utf8')}\nrunProducer();`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let childClosed = false, faults = 0, wireBytes = 0, allowed = false, inventory, connector;
    const childDone = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
    child.on('error', () => { faults++; }); child.stdin.on('error', () => { if (!childClosed) faults++; });
    child.stderr.on('data', () => { faults++; });
    child.once('exit', () => connector?.stop('owned-child-lost'));
    const sourceClock = `node-rss:${child.pid}`, receiptClock = `inventory-host:${process.pid}:${mode}`;
    const samples = [], steps = [], bytes = [];
    const runtime = createDeviceRuntime({ clockDomain: receiptClock, now: () => performance.now(), authorize(request) {
      if (allowed && inventory?.matches(request)) return { expiresAt: performance.now() + 2000, maxAgeMs: ageMs, maxHz: 20 };
    } });
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: `owned-node:${child.pid}`, label: 'Camera vendor label supplies no sensors', revision: 1,
      adapter: { id: manifest.id, version: manifest.version }, runtime: { platform: 'node-process' }, capabilities: manifest.resources.map(resource => resource.capability) });
    const sources = new Map(manifest.resources.filter(resource => resource.direction === 'source').map(resource => [resource.capability.id,
      runtime.registerSource({ device, capability: resource.capability.id })]));
    function visible(action) {
      assert.ok(steps.length < 8); const state = inventory.snapshot();
      steps.push({ action, activeRoutes: state.activeRoutes, timerArmed: state.timerArmed, rows: state.rows });
    }
    try {
      inventory = createCapabilityInventory({ runtime, clockDomain: receiptClock, now: () => performance.now(), probeMs: 2000, maxAgeMs: ageMs,
        scope: { principalId: 'owned-node-operator', applicationId: 'live-inventory-example', sessionId: mode },
        resources: manifest.resources.map(resource => ({ id: resource.capability.id, device, capability: resource.capability.id,
          ...(sources.has(resource.capability.id) ? { sourceHandle: sources.get(resource.capability.id) } : {}) })),
        selected: [{ id: 'resident', operation: 'subscribe' }, { id: 'enabled', operation: 'subscribe' },
          { id: 'camera-from-vendor-label', operation: 'subscribe' }, { id: 'sampling', operation: 'subscribe' }, { id: 'resident', operation: 'read' }] });
      assert.equal(factories, scenarios.length); visible('Inert declarations');
      for (const handle of sources.values()) runtime.setReadiness(handle, 'available');
      assert.ok(inventory.start().ok); assert.equal(inventory.snapshot().activeRoutes, 0);
      assert.ok(inventory.snapshot().rows.slice(0, 2).every(row => row.reason === 'access-denied')); visible('Separate route grant denied');
      allowed = true; const startedInventory = inventory.start(); assert.ok(startedInventory.ok);
      assert.equal(startedInventory.value.admitted, 2); assert.ok(inventory.snapshot().rows.every(row => row.state !== 'supported')); visible('Granted routes wait for actual data');
      connector = createProfileConnector({ binding, observedIdentity: { backendId: 'node-memory', wireVersion: 1, clockId: sourceClock }, now: () => performance.now(),
        onSample(frame) {
          assert.ok(samples.length < 8); samples.push(frame);
          const handle = sources.get(frame.resourceId); if (!handle) return;
          if (frame.quality !== 'valid') { runtime.setReadiness(handle, 'unavailable'); return; }
          runtime.setReadiness(handle, 'available', frame.receivedAt + 1000);
          const resource = manifest.resources.find(resource => resource.capability.id === frame.resourceId);
          const result = runtime.publish(handle, frame.value, { sequence: frame.sequence, timestamp: frame.receivedAt,
            clockDomain: receiptClock, quality: frame.quality,
            provenance: { profile: pin, sourceTime: frame.sourceTime, calibration: frame.calibration, producerQuality: frame.quality },
            ...(resource.capability.delivery.mode === 'reliable' ? { operationId: String(frame.sequence), deadline: frame.receivedAt + ageMs } : {}) });
          assert.ok(result.ok, `actual-${frame.resourceId}-delivery`); runtime.flush();
        },
        onUnavailable(id) { const handle = sources.get(id); if (handle) runtime.setReadiness(handle, 'unavailable'); },
      });
      const capture = connector.start(); assert.ok(capture.ok); assert.equal(factories, scenarios.length + 1);
      child.stdout.on('data', chunk => {
        wireBytes += chunk.byteLength;
        if (wireBytes > 4096 || childClosed) { faults++; connector.stop('owned-byte-bound'); return; }
        bytes.push(Buffer.from(chunk));
        if (!connector.push(capture.value, chunk).ok) faults++;
      });
      await until(() => inventory.snapshot().rows.slice(0, 2).every(row => row.state === 'supported'), 'actual Node RSS/boolean qualification');
      const supported = inventory.snapshot(); visible('Actual routed adapter data');
      assert.equal(samples.length, 2);
      const wire = JSON.parse(Buffer.concat(bytes).toString('utf8').trim());
      assert.equal(wire.kind, 'reading'); assert.ok(Number.isSafeInteger(wire.rssBytes) && wire.rssBytes > 0);
      assert.equal(wire.enabled, false); assert.equal(wire.sequence, 1); assert.equal(wire.clockId, sourceClock);
      for (const row of supported.rows.slice(0, 2)) {
        const sample = samples.find(sample => sample.resourceId === row.id), proof = row.proof;
        assert.equal(proof.sequence, wire.sequence); assert.equal(proof.clockDomain, receiptClock);
        assert.equal(proof.timestamp, sample.receivedAt); assert.deepEqual(proof.provenance.sourceTime, { clockId: sourceClock, at: wire.at });
        assert.equal(proof.provenance.producerQuality, wire.quality); assert.equal(proof.quality, 'valid');
        assert.ok(proof.expiresAt <= sample.receivedAt + ageMs); assert.equal(Object.hasOwn(proof, 'value'), false);
      }
      assert.deepEqual(supported.rows.slice(2).map(row => row.state), ['unsupported', 'unsupported', 'unsupported']);
      if (mode === 'child-loss') {
        child.stdin.end(); await childDone;
        assert.ok(inventory.snapshot().rows.slice(0, 2).every(row => row.state === 'unavailable' && !row.proof)); visible('Actual child exit retires routed support');
      } else {
        await until(() => inventory.snapshot().rows.slice(0, 2).every(row => row.state === 'expired'), 'quiet owned expiry timer');
        assert.equal(samples.length, 2); assert.equal(childClosed, false); visible('Quiet proof expires without new data');
      }
      assert.equal(inventory.snapshot().activeRoutes, 0); assert.equal(inventory.snapshot().timerArmed, false);
      inventory.stop(); connector.close(); assert.equal(connector.push(capture.value, new Uint8Array()).ok, false);
      assert.equal(faults, 0);
      scenarios.push({ mode, ownedChildPid: child.pid, wireBytes, wireSha256: createHash('sha256').update(Buffer.concat(bytes)).digest('hex'),
        originalWire: wire, samples, steps, terminal: inventory.snapshot(),
        checks: { inertBeforeGrant: true, noSupportBeforeActualData: true, actualCurrentPublicRoutes: true,
          reviewedDecoderAndGenuineRssProducer: true, originalProducerStampQualityCalibration: true, receiptClockSeparate: true,
          vendorLabelCannotInventCapability: true, commandReadAndUnknownUnsupported: true, boundedProofNoValues: true,
          quietExpiryOrActualChildLoss: true, stoppedCaptureCannotRestore: true, noCommandOrPhysicalProbe: true, ownedRouteAndTimerCleanup: true } });
    } finally {
      inventory?.close(); connector?.close(); runtime.close(); child.stdin.end();
      if (!childClosed) {
        const terminate = setTimeout(() => child.kill('SIGTERM'), 250), kill = setTimeout(() => child.kill('SIGKILL'), 750);
        await childDone; clearTimeout(terminate); clearTimeout(kill);
      }
    }
  }
  return { kind: 'actual-node-rss-live-capability-inventory', sourceSha256: NODE_MEMORY_REVIEWED_SHA256,
    publicEsm: import.meta.resolve('@101/connect'), factories, scenarios,
    checks: { twoRealChildrenNoSimulatedPositiveFrames: true, twoActualProfileResources: true, noCommandWrites: true,
      quietExpiryAndActualChildLoss: true, allScenariosPassed: scenarios.every(item => Object.values(item.checks).every(Boolean)) },
    limits: { sourceBytes: 1048576, sourceReadTurns: 256, wireBytesPerChild: 4096, samplesPerChild: 8, stepsPerChild: 8,
      scope: 'Owned Node RSS and enabled-state source only. No authentication, physical/OS peripheral qualification, command/write qualification or general hardware compatibility.' } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runLiveInventoryExample()));
