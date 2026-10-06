import assert from 'node:assert/strict';
import { createHttpsCoordinator, createCoordinatorFetcher, createPrivateDirectoryClient, createScopedAgentIpc,
  SCOPED_AGENT_IPC_SOURCE_SHA256 } from '@101/hub-server';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '@101/pairing';
import { createDeviceRuntime, createCapabilityInventory, parseDeviceDescriptor } from '@101/connect';

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const isAborted = signal => Reflect.apply(aborted, signal, []);
const live = signal => { try { return !isAborted(signal); } catch { return false; } };
let gatewaySequence = 0;

/** One owned software gateway projects one genuinely qualified child RSS resource.
 * Host configuration and separate grants are supplied explicitly. No router,
 * vendor label, directory listing or identity filter supplies live resource proof. */
export function createOwnedNodeAgentGateway(options) {
  for (const signal of [options.ownerSignal, options.registrationSignal, options.readSignal, options.qualificationSignal, options.visibilitySignal])
    assert.equal(live(signal), true, 'Actual current owner approvals are required');
  const sequence = ++gatewaySequence, runtimeClock = `gateway-host:${process.pid}:${sequence}`;
  const scope = Object.freeze({ principalId: options.ownerId, applicationId: 'owned-gateway-consumer', sessionId: `gateway-${sequence}` });
  const owner = new AbortController(), nativeApprovals = [], resources = [];
  let runtime, source, inventory, agentObservation, currentSample, agentHandle, coordinator, hostDirectory, peerDirectory,
    hostCaller, peerCaller, started, stopping, closed = false, rawQualificationReads = 0, qualifiedRoutes = 0;
  const lifetime = AbortSignal.any([options.ownerSignal, owner.signal]);
  const current = () => !closed && live(lifetime) && live(options.registrationSignal) && live(options.qualificationSignal) && live(options.visibilitySignal);
  const watch = (signal, callback) => {
    Reflect.apply(EventTarget.prototype.addEventListener, signal, ['abort', callback, { once: true }]);
    return () => Reflect.apply(EventTarget.prototype.removeEventListener, signal, ['abort', callback]);
  };
  const cleanupListeners = [];
  function retireResource() {
    if (source) { runtime?.setReadiness(source, 'unavailable'); runtime?.unregister(source); source = undefined; }
    inventory?.close(); inventory = undefined;
    runtime?.close();
  }
  function stopNetwork() {
    hostDirectory?.close(); peerDirectory?.close(); hostCaller?.close(); peerCaller?.close();
    return coordinator?.stop() ?? Promise.resolve();
  }
  const agent = createScopedAgentIpc({ ownerId: options.ownerId, signal: lifetime,
    authorizeRegistration(request) {
      if (!current() || !live(options.registrationSignal) || request.resourceId !== 'rss' || request.operation !== 'read' || request.version !== 1) return;
      nativeApprovals.push(request.action); return { request, signal: options.registrationSignal, expiresAt: performance.now() + 8000 };
    },
    authorizeRead(request) {
      if (!current() || !live(options.readSignal) || request.epoch !== agentObservation?.epoch || request.version !== 1) return;
      nativeApprovals.push(request.action); return { request, signal: options.readSignal, expiresAt: performance.now() + 1500 };
    },
    onAgent(observation) { agentObservation = observation; },
    onRetire(observation) {
      if (agentObservation?.epoch !== observation.epoch) return;
      retireResource(); void stopNetwork();
    } });
  function descriptor(id, sink = false) {
    return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Owned Node agent RSS resource', revision: 1,
      adapter: { id: 'example:owned-native-gateway', version: '1.0.0' }, runtime: { platform: 'node' },
      capabilities: [{ id: 'rss', semantic: 'example:owned-process-rss', schemaVersion: 1, kind: 'property',
        value: { type: 'scalar', unit: 'By', min: 1, max: Number.MAX_SAFE_INTEGER }, permissions: [sink ? 'write' : 'read'],
        ...(sink ? { ownership: { mode: 'observe' } } : {}), delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 } }] });
  }
  async function start() {
    assert.ok(current() && !started, 'Gateway start is explicit and single-use'); started = true;
    const native = await agent.start({ purpose: 'project-own-rss', version: 1 }); assert.ok(native.ok && current()); agentHandle = native.value;
    const read = await agent.readRss(agentHandle, { purpose: 'qualify-own-rss', signal: options.readSignal }); assert.ok(read.ok && current());
    currentSample = read.value; rawQualificationReads++;
    assert.ok(Number.isSafeInteger(currentSample.rssBytes) && currentSample.rssBytes > 0);
    assert.equal(currentSample.sourceTime.clockId, `agent-rss:${agentObservation.pid}:${agentObservation.epoch}`);
    assert.notEqual(currentSample.sourceTime.clockId, currentSample.receiptClockId);
    const device = descriptor(`owned-agent-p${agentObservation.pid}-e${agentObservation.epoch}`);
    runtime = createDeviceRuntime({ clockDomain: runtimeClock, now: () => performance.now(), maxPendingDeliveries: 1,
      authorize(request) {
        if (!current() || !source || request.source.registrationId !== source.id || request.source.deviceId !== device.id ||
          request.source.capabilityId !== 'rss' || request.source.descriptorRevision !== 1 || request.sourceOperation !== 'read' || request.sinkOperation !== 'write') return;
        if (inventory?.matches(request) && live(options.qualificationSignal)) return { expiresAt: performance.now() + 1000, maxAgeMs: 1000, maxHz: 10 };
        if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId) return;
        const approval = options.authorizeResource?.(request);
        if (!current() || !approval || approval.request !== request || !live(approval.signal) || !Number.isFinite(approval.expiresAt) ||
          approval.expiresAt <= performance.now() || approval.expiresAt > performance.now() + 1000) return;
        return { expiresAt: approval.expiresAt, maxAgeMs: 1000, maxHz: 10 };
      } });
    source = runtime.registerSource({ device, capability: 'rss' });
    runtime.setReadiness(source, 'available', currentSample.receivedAt + 1000);
    assert.ok(runtime.publish(source, currentSample.rssBytes, { timestamp: currentSample.receivedAt, clockDomain: runtimeClock,
      quality: currentSample.quality, provenance: { sourceTime: currentSample.sourceTime, sourceQuality: currentSample.quality,
        nativeReceiptClockId: currentSample.receiptClockId, nativeReceivedAt: currentSample.receivedAt,
        reviewedChildSha256: SCOPED_AGENT_IPC_SOURCE_SHA256 } }).ok);
    inventory = createCapabilityInventory({ runtime, scope, resources: [{ id: 'own-rss', sourceHandle: source, device, capability: 'rss' }],
      selected: [{ id: 'own-rss', operation: 'read' }], clockDomain: runtimeClock, now: () => performance.now(), probeMs: 1000, maxAgeMs: 1000 });
    assert.ok(inventory.start().ok); runtime.flush();
    const proof = inventory.snapshot().rows[0]; assert.equal(proof.state, 'supported'); assert.ok(current()); qualifiedRoutes++;
    resources.push(device.id);
    // Metadata is provisioned only after actual native -> current routed read qualification.
    coordinator = createHttpsCoordinator({ ...options.coordinator, directoryResources: [{ principalId: options.host.principalId,
      deviceId: options.host.deviceId, descriptor: device, capabilityIds: ['rss'] }] });
    const endpoint = await coordinator.start(); assert.ok(current() && live(options.visibilitySignal));
    const credential = selected => ({ endpoint, origin: options.origin, caCertificatePem: options.coordinator.clientCaCertificatePem,
      certificatePem: selected.certificatePem, privateKeyPem: selected.privateKeyPem });
    hostCaller = createCoordinatorFetcher(credential(options.host)); peerCaller = createCoordinatorFetcher(credential(options.peer));
    const session = await createHttpSignalingSession(endpoint, `GATEWAY-${sequence}-OWNED101`, { fetcher: hostCaller.fetch }); assert.ok(current());
    const signaling = new HttpControllerSignalingClient(session.ticket, peerCaller.fetch);
    const lease = await signaling.join({ deviceId: options.peer.deviceId, label: 'Display label is not authority', capabilities: { touch: true } }); assert.ok(current());
    hostDirectory = createPrivateDirectoryClient({ ...credential(options.host), sessionId: session.ticket.sessionId, role: 'host', token: session.hostToken });
    peerDirectory = createPrivateDirectoryClient({ ...credential(options.peer), sessionId: session.ticket.sessionId, role: 'peer', token: lease.peerToken, peerId: lease.peerId });
    cleanupListeners.push(watch(options.visibilitySignal, () => { void stopNetwork(); }), watch(options.qualificationSignal, () => { retireResource(); void stopNetwork(); }));
    const lifetimeSignal = AbortSignal.any([lifetime, options.visibilitySignal, options.qualificationSignal]);
    assert.ok(current() && live(lifetimeSignal));
    // Expiry uses trusted host receipt/qualification age; child capture time is not reinterpreted.
    const advertisedUntil = Math.min(Date.now() + 500, Date.now() + Math.floor(proof.proof.expiresAt - performance.now()));
    assert.ok(advertisedUntil > Date.now());
    await hostDirectory.enroll(device.id, advertisedUntil, lifetimeSignal); assert.ok(current() && live(lifetimeSignal));
    const before = await peerDirectory.list(lifetimeSignal); assert.equal(before.resources.length, 0);
    await hostDirectory.allow(lease.peerId, [device.id], advertisedUntil, lifetimeSignal); assert.ok(current() && live(lifetimeSignal));
    return Object.freeze({ endpoint, sessionId: session.ticket.sessionId, peerId: lease.peerId, token: lease.peerToken,
      resourceId: device.id, advertisedUntil, runtime, source, device, scope,
      sinkDescriptor: descriptor(`owned-viewer-${sequence}`, true),
      async revokeVisibility() { await hostDirectory.revoke(lease.peerId, lifetime); },
      sameActualSample(observation) { return observation.value === currentSample.rssBytes && observation.quality === 'valid' &&
        observation.provenance.sourceTime.clockId === currentSample.sourceTime.clockId && observation.provenance.sourceTime.at === currentSample.sourceTime.at &&
        observation.provenance.sourceQuality === currentSample.quality && observation.provenance.nativeReceivedAt === currentSample.receivedAt; },
      async crash() {
        process.kill(agentObservation.pid, 'SIGKILL');
        const deadline = performance.now() + 2500;
        while (agent.status().phase === 'ready') {
          assert.ok(performance.now() < deadline, 'Actual native child exit must retire its epoch');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(source, undefined); await agent.stop(); await stopNetwork();
      },
    });
  }
  async function close() {
    if (stopping) return stopping;
    closed = true; owner.abort(); retireResource(); for (const cleanup of cleanupListeners) cleanup();
    stopping = Promise.all([stopNetwork(), agent.close()]).then(() => undefined); return stopping;
  }
  return Object.freeze({ start, close, status: () => Object.freeze({ native: agent.status(), rawQualificationReads, qualifiedRoutes,
    nativeApprovals: Object.freeze([...nativeApprovals]), resourceIds: Object.freeze([...resources]), sourceCurrent: source !== undefined }) });
}
