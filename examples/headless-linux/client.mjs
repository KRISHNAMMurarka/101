import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, createProfileConnector, createTrustedConnectorProfileRegistry, parseDeviceDescriptor } from '@101/connect';
import { createNodeMemoryProfile, NODE_MEMORY_REVIEWED_SHA256 } from './profile.mjs';
import { createHeadlessNodeStdioPort } from './process-port.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(check, reason) { const deadline = performance.now() + 1500;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await new Promise(resolve => setTimeout(resolve, 5)); } }
const retain = (list, value) => { list.push(value); if (list.length > 32) list.shift(); };
const cgroup = name => readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();

/** Software RSS and owned sampling only. The selected container must be provisioned independently. Importing is inert. */
export async function runLinuxHeadlessClient() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64'); assert.equal(process.getuid(), 65534);
  assert.equal(cgroup('memory.max'), '268435456'); assert.equal(cgroup('memory.swap.max'), '0'); assert.equal(cgroup('pids.max'), '32');
  assert.equal(cgroup('cpu.max'), '50000 100000');
  const inputs = JSON.parse(readFileSync(new URL('./inputs.json', import.meta.url))), source = readFileSync(new URL('./producer.mjs', import.meta.url));
  for (const name of ['producer.mjs', 'profile.mjs', 'process-port.mjs', 'client.mjs']) assert.equal(hash(readFileSync(new URL('./' + name, import.meta.url))), inputs.inputPins[name]);
  assert.equal(hash(source), NODE_MEMORY_REVIEWED_SHA256);
  const reviewed = await import('data:text/javascript;base64,' + source.toString('base64'));
  const manifest = createNodeMemoryProfile(), registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source, factory: reviewed.createNodeMemoryDecoder });
  const binding = registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 });
  const sessions = [], checks = [];
  async function session(index, previous) {
    const samples = [], states = [], observed = [], sources = new Map(), approved = new Set(), scope = { principalId: 'headless-owner', applicationId: 'linux-node-rss', sessionId: 'fresh-' + index };
    let port, connector, commandRoute, memoryRoute, stateRoute, capture, latestBytes, faults = 0;
    const hostClock = 'linux-client-receipt:' + process.pid + ':' + index;
    const key = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId, request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
    const runtime = createDeviceRuntime({ clockDomain: hostClock, now: () => performance.now(), maxRoutes: 4, maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 2,
      authorize: request => approved.has(key(request)) ? { expiresAt: performance.now() + 5000, maxAgeMs: 1000, maxHz: 20 } : undefined });
    port = createHeadlessNodeStdioPort({ source,
      onChunk(bytes) { latestBytes = new Uint8Array(bytes); for (let at = 0; at < bytes.byteLength; at += 8192) if (!connector.push(capture, bytes.subarray(at, at + 8192)).ok) faults++; },
      onDisconnect() { approved.clear(); if (commandRoute) runtime.revoke(commandRoute); connector?.stop(); },
    });
    connector = createProfileConnector({ binding, observedIdentity: { backendId: 'node-memory', wireVersion: 1, clockId: port.clockId }, now: () => performance.now(),
      onSample(frame) {
        if (frame.resourceId === 'enabled' && frame.quality === 'valid') retain(observed, frame.value);
        const endpoint = sources.get(frame.resourceId); if (!endpoint) return;
        if (frame.quality !== 'valid') { runtime.setReadiness(endpoint, 'unavailable'); return; }
        runtime.setReadiness(endpoint, 'available', frame.receivedAt + 1000);
        const resource = manifest.resources.find(value => value.capability.id === frame.resourceId);
        runtime.publish(endpoint, frame.value, { sequence: frame.sequence, timestamp: frame.receivedAt, clockDomain: hostClock, quality: frame.quality,
          ...(resource.capability.delivery.mode === 'reliable' ? { operationId: String(frame.sequence), deadline: frame.receivedAt + 1000 } : {}),
          provenance: { sourceTime: frame.sourceTime, quality: frame.quality, calibration: frame.calibration, profile: { id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 } } });
        runtime.flush();
      },
      onUnavailable(id) { const endpoint = sources.get(id); if (endpoint) runtime.setReadiness(endpoint, 'unavailable'); },
      write: (bytes, context) => port.write(bytes, context),
    });
    const descriptor = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-linux-node-' + index, label: 'Owned Linux software memory', revision: 1,
      adapter: { id: manifest.id, version: manifest.version }, runtime: { platform: 'linux-node-container' }, capabilities: manifest.resources.map(value => value.capability) });
    for (const resource of manifest.resources.filter(value => value.direction === 'source')) sources.set(resource.capability.id, runtime.registerSource({ device: descriptor, capability: resource.capability.id }));
    const sink = runtime.registerSink({ device: descriptor, capability: 'sampling', apply: (observation, context) => connector.apply('sampling', observation, context),
      release: (reason, context) => connector.release('sampling', reason, context) });
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'linux-client-' + index, label: 'Explicit local Linux client', revision: 1,
      adapter: { id: 'example:linux-client', version: '1.0.0' }, runtime: { platform: 'linux-node-container' }, capabilities: [
        { ...manifest.resources[2].capability, id: 'control', kind: 'event', permissions: ['subscribe'], ownership: undefined },
        { ...manifest.resources[0].capability, id: 'memory', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } },
        { ...manifest.resources[1].capability, id: 'state', permissions: ['write'], ownership: { mode: 'observe' } },
      ].map(value => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))) });
    const control = runtime.registerSource({ device, capability: 'control' });
    const memory = runtime.registerSink({ device, capability: 'memory', apply(observation, context) {
      if (context.isCurrent() && !context.signal.aborted) retain(samples, { rssBytes: observation.value, sourceTime: observation.provenance.sourceTime,
        receipt: { clockId: observation.clockDomain, at: observation.timestamp }, quality: observation.quality, calibration: observation.provenance.calibration });
    }, release() {} });
    const state = runtime.registerSink({ device, capability: 'state', apply(observation, context) { if (context.isCurrent() && !context.signal.aborted) retain(states, observation.value); }, release() {} });
    for (const endpoint of [control, sink, memory, state]) runtime.setReadiness(endpoint, 'available');
    const route = (from, to, operation, approve) => {
      if (approve) approved.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, 'subscribe', operation]));
      return runtime.route({ from, to, ...scope, queueCapacity: 1 });
    };
    const started = connector.start(); assert.ok(started.ok); capture = started.value;
    try {
      await until(() => observed.at(-1) === false, 'actual initial disabled software producer');
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(port.write(new TextEncoder().encode('{"wireVersion":1,"kind":"command","resourceId":"sampling","commandId":"1","value":true}\n'), { signal: cancelled.signal, isCurrent: () => false }));
      assert.equal(port.status().writes, 0); assert.equal(port.status().inFlightWrites, 0);
      const denied = route(control, sink, 'invoke', false); assert.equal(denied.start().ok, false);
      const deniedRead = route(sources.get('resident'), memory, 'write', false); assert.equal(deniedRead.start().ok, false);
      assert.equal(runtime.publish(control, true, { operationId: '1', deadline: performance.now() + 1000 }).ok, false); runtime.flush();
      assert.equal(port.status().writes, 0); assert.equal(samples.length, 0); assert.equal(observed.at(-1), false);
      if (previous) { assert.notEqual(port.clockId, previous.clockId); assert.equal(connector.push(previous.capture, previous.bytes).ok, false); assert.equal(connector.status().active, true); }
      memoryRoute = route(sources.get('resident'), memory, 'write', true); assert.ok(memoryRoute.start().ok);
      stateRoute = route(sources.get('enabled'), state, 'write', true); assert.ok(stateRoute.start().ok);
      commandRoute = route(control, sink, 'invoke', true); assert.ok(commandRoute.start().ok);
      assert.ok(runtime.publish(control, true, { operationId: '1', deadline: performance.now() + 1000 }).ok); runtime.flush();
      await until(() => commandRoute.operations().some(value => value.effectEvidence === 'observed') && samples.length > 0 && states.includes(true), 'actual typed RSS, ACK and separately observed enabled state');
      const enabled = commandRoute.operations().find(value => value.effectEvidence === 'observed');
      assert.ok(samples.every(value => Number.isSafeInteger(value.rssBytes) && value.rssBytes > 0 && value.quality === 'valid' && value.calibration.unit === 'By' && value.calibration.revision === 1 && value.sourceTime.clockId === port.clockId && value.receipt.clockId === hostClock));
      assert.ok(samples.some(value => !Number.isInteger(value.sourceTime.at)));
      runtime.revoke(commandRoute);
      await until(() => { runtime.flush(); return observed.at(-1) === false && states.at(-1) === false && port.status().inFlightWrites === 0; }, 'declared safe software state observed after explicit route revoke');
      commandRoute = route(control, sink, 'invoke', true); assert.ok(commandRoute.start().ok);
      assert.ok(runtime.publish(control, true, { operationId: '2', deadline: performance.now() + 1000 }).ok); runtime.flush();
      assert.equal(port.status().inFlightWrites, 1); const before = port.status(); port.terminateOwned();
      assert.equal(port.status().inFlightWrites, 1, 'logical termination retains native callback reservation');
      assert.equal(connector.push(capture, latestBytes).ok, false); await port.close();
      assert.equal(port.status().inFlightWrites, 0); assert.equal(port.status().writes, port.status().settledWrites);
      assert.equal(commandRoute.status().state, 'closed'); assert.equal(commandRoute.status().reason, 'revoked'); assert.equal(faults, 0);
      const result = { clockId: port.clockId, samples, enabled: { handlerResult: enabled.handlerResult, effectEvidence: enabled.effectEvidence }, beforeTermination: before, afterTermination: port.status() };
      sessions.push(result); checks.push('denied-source-and-command-' + index, 'actual-target-ack-and-observed-state-' + index, 'explicit-revoke-safe-state-' + index, 'raw-reservation-through-disconnect-' + index);
      return { clockId: port.clockId, capture, bytes: latestBytes };
    } finally { commandRoute?.stop(); memoryRoute?.stop(); stateRoute?.stop(); connector.close(); runtime.close(); await port.close(); }
  }
  const previous = await session(1); await session(2, previous); checks.push('fresh-target-identity-and-separate-new-approval', 'old-capture-rejected');
  let guardSeen = false, getterReads = 0, shadowObserved = false, guardedTail = '';
  const shadowSource = new Uint8Array(source); Object.defineProperty(shadowSource, 'length', { value: 1 });
  const guarded = createHeadlessNodeStdioPort({ source: shadowSource, onChunk(chunk) {
    guardSeen = true; guardedTail += Buffer.from(chunk).toString('utf8'); assert.ok(guardedTail.length <= 8192);
    for (let newline; (newline = guardedTail.indexOf('\n')) >= 0;) {
      const frame = JSON.parse(guardedTail.slice(0, newline)); guardedTail = guardedTail.slice(newline + 1);
      if (frame.kind === 'reading' && frame.enabled === true) shadowObserved = true;
    }
  }, onDisconnect() {} });
  try {
    await until(() => guardSeen, 'actual owned producer for port currentness checks');
    const signal = new AbortController().signal, bytes = new TextEncoder().encode('{"wireVersion":1,"kind":"command","resourceId":"sampling","commandId":"1","value":true}\n');
    await assert.rejects(guarded.write(bytes, { signal, get isCurrent() { getterReads++; return () => true; } }));
    await assert.rejects(guarded.write(bytes, new Proxy({}, { getOwnPropertyDescriptor() { throw Error('descriptor'); } })));
    await assert.rejects(guarded.write(new Uint8Array(1025), { signal, isCurrent: () => true }));
    const oversized = new TextEncoder().encode(Buffer.from(bytes).toString('utf8').trimEnd() + ' '.repeat(1100) + '\n');
    Object.defineProperty(oversized, 'byteLength', { value: 1 });
    await assert.rejects(guarded.write(oversized, { signal, isCurrent: () => true }));
    assert.equal(guarded.status().writes, 0);
    const shadowLength = new Uint8Array(bytes); Object.defineProperty(shadowLength, 'length', { value: 2048 });
    await guarded.write(shadowLength, { signal, isCurrent: () => true });
    await until(() => shadowObserved, 'native copy uses actual typed-array bytes despite a shadow length');
    assert.equal(guarded.status().writes, 1); assert.equal(guarded.status().settledWrites, 1);
    checks.push('intrinsic-command-byte-limit-before-dispatch', 'intrinsic-source-and-command-snapshot');
    let nested;
    await assert.rejects(guarded.write(bytes, { signal, isCurrent() { nested = guarded.write(bytes, { signal, isCurrent: () => true }); nested.catch(() => {}); return false; } }));
    await assert.rejects(nested);
    await assert.rejects(guarded.write(bytes, { signal, isCurrent() { guarded.close(); return true; } }));
    await guarded.close(); assert.equal(getterReads, 0); assert.equal(guarded.status().writes, 1); assert.equal(guarded.status().inFlightWrites, 0);
    checks.push('closed-own-data-context', 'one-reservation-before-reentrant-callback', 'write-byte-cap-before-native-dispatch', 'close-during-currentness-prevents-dispatch');
  } finally { await guarded.close(); }
  const negative = [];
  for (const kind of ['malformed', 'replay', 'overlimit']) {
    const child = spawn(process.execPath, ['--max-old-space-size=32', '--input-type=module', '--eval', source.toString('utf8') + '\nrunProducer();'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
    let outputBytes = 0, stderrBytes = 0; child.stdout.on('data', bytes => { outputBytes += bytes.byteLength; }); child.stderr.on('data', bytes => { stderrBytes += bytes.byteLength; }); child.stdin.on('error', () => {});
    const closed = new Promise(resolve => child.once('close', code => resolve(code))), timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    try {
      const frame = JSON.stringify({ wireVersion: 1, kind: 'command', resourceId: 'sampling', commandId: '1', value: true }) + '\n';
      child.stdin.end(kind === 'malformed' ? '{\n' : kind === 'replay' ? frame + frame : 'x'.repeat(4097) + '\n');
      const code = await closed; assert.equal(code, 64); assert.equal(stderrBytes, 0); assert.ok(outputBytes <= 4096); negative.push({ kind, exitCode: code, outputBytes });
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
  }
  const resolutions = Object.fromEntries(['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'].map(name => ['@101/' + name, import.meta.resolve('@101/' + name)]));
  assert.ok(Object.values(resolutions).every(value => /^file:\/\/\/input\/node_modules\/@101\/[^/]+\/dist\/index\.js$/.test(value)));
  return { result: 'pass', profile: 'linux-node-rss/1', platform: process.platform, arch: process.arch, node: process.version, kernel: release(), uid: process.getuid(),
    cgroup: { memoryMax: Number(cgroup('memory.max')), memorySwapMax: Number(cgroup('memory.swap.max')), memoryCurrent: Number(cgroup('memory.current')), memoryPeak: Number(cgroup('memory.peak')), pidsMax: Number(cgroup('pids.max')), cpuMax: cgroup('cpu.max'), memoryEvents: cgroup('memory.events') },
    sourceSha256: hash(source), publicEsmResolutions: resolutions, sessions, checks, producerNegatives: negative,
    limits: { lifetimeMs: 10000, retainedRowsPerSession: 32, pendingNativeWrites: 1, routeQueue: 1, pendingRuntimeDeliveries: 2, rawChunkBytes: 65536, frameBytes: 4096, commandBytes: 1024 },
    exclusions: ['physical-sensor', 'MCU', 'gateway-distribution', 'remote-transport-authentication', 'malicious-host-JavaScript-isolation', 'undo-of-issued-effect', 'cross-clock-source-freshness-mapping'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runLinuxHeadlessClient()));
