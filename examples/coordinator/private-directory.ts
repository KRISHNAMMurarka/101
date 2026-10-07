import { createHttpsCoordinator, createCoordinatorFetcher, createPrivateDirectoryClient } from '@101/hub-server';
import type { HttpsCoordinatorOptions } from '@101/hub-server';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '@101/pairing';
import { pointerSourceDescriptor, parseDeviceDescriptor, parsePrivateDirectorySnapshot, privateDirectoryCandidates, assessDiscoveryCandidate, createDeviceRuntime } from '@101/connect';
import type { DeliveryContext } from '@101/connect';

interface Credential { readonly certificatePem: string; readonly privateKeyPem: string; readonly principalId: string; readonly deviceId: string; }
/** Actual Node mTLS directory plus an independently authorized local SDK observation route. No physical input/effect claim. */
export async function runPrivateDirectoryExample(options: { coordinator: HttpsCoordinatorOptions; origin: string; host: Credential; peer: Credential }) {
  const resource = parseDeviceDescriptor({ ...pointerSourceDescriptor('node'), id: options.peer.deviceId, label: 'Reviewed local surface',
    metadata: { privateOwnerNote: 'excluded-from-directory' } });
  const coordinator = createHttpsCoordinator(options.coordinator);
  let hostCaller: ReturnType<typeof createCoordinatorFetcher> | undefined, peerCaller: ReturnType<typeof createCoordinatorFetcher> | undefined;
  let hostDirectory: ReturnType<typeof createPrivateDirectoryClient> | undefined, peerDirectory: ReturnType<typeof createPrivateDirectoryClient> | undefined;
  let runtime: ReturnType<typeof createDeviceRuntime> | undefined;
  try {
    const endpoint = await coordinator.start();
    const credential = (owner: Credential) => ({ endpoint, origin: options.origin, caCertificatePem: options.coordinator.clientCaCertificatePem,
      certificatePem: owner.certificatePem, privateKeyPem: owner.privateKeyPem });
    hostCaller = createCoordinatorFetcher(credential(options.host)); peerCaller = createCoordinatorFetcher(credential(options.peer));
    const session = await createHttpSignalingSession(endpoint, 'DIRECTORY-EXAMPLE101', { fetcher: hostCaller.fetch });
    const peer = new HttpControllerSignalingClient(session.ticket, peerCaller.fetch);
    const lease = await peer.join({ deviceId: options.peer.deviceId, label: 'Display label gives no identity', capabilities: { touch: true } });
    hostDirectory = createPrivateDirectoryClient({ ...credential(options.host), sessionId: session.ticket.sessionId, role: 'host', token: session.hostToken });
    peerDirectory = createPrivateDirectoryClient({ ...credential(options.peer), sessionId: session.ticket.sessionId, role: 'peer', token: lease.peerToken, peerId: lease.peerId });
    const before = await peerDirectory.list();
    if (before.resources.length !== 0) throw new Error('Join unexpectedly granted metadata visibility');
    const expiry = Date.now() + 5000;
    await peerDirectory.publish({ generation: lease.generation, descriptor: resource, capabilityIds: ['position'], expiresAt: expiry, consent: true });
    if ((await peerDirectory.list()).resources.length !== 0) throw new Error('Publication unexpectedly granted metadata visibility');
    await hostDirectory.allow(lease.peerId, [resource.id], expiry);
    const received = parsePrivateDirectorySnapshot(await peerDirectory.list());
    if (received.resources.length !== 1 || received.resources[0]!.id !== resource.id || received.resources[0]!.revision !== resource.revision ||
      received.resources[0]!.capabilities.length !== 1 || received.resources[0]!.capabilities[0]!.id !== 'position') throw new Error('Unexpected directory projection');
    const candidate = privateDirectoryCandidates(received, 'local-host-review')[0]!;
    // This caller deliberately supplies no resource/endpoint receipt authority.
    const hintState = assessDiscoveryCandidate(candidate, received.scope, received.issuedAt, () => false).state;
    let now = 1000, approved = false, hold = false, finishLate: (() => void) | undefined, lateContext: DeliveryContext | undefined;
    const outputs: unknown[] = [];
    const sinkDevice = parseDeviceDescriptor({ ...resource, id: 'reviewed-local-consumer', label: 'Local application consumer', capabilities: resource.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'] })) });
    runtime = createDeviceRuntime({ now: () => now, clockDomain: 'directory-local-example', authorize(request) {
      if (!approved || request.principalId !== options.peer.principalId || request.applicationId !== 'directory-local-example' || request.sessionId !== session.ticket.sessionId ||
        request.source.registrationId !== source.id || request.sink.registrationId !== sink.id || request.source.deviceId !== resource.id || request.sink.deviceId !== sinkDevice.id ||
        request.source.capabilityId !== 'position' || request.sink.capabilityId !== 'position' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
        request.source.descriptorRevision !== resource.revision || request.sink.descriptorRevision !== sinkDevice.revision) return;
      return { expiresAt: now + 5000, maxAgeMs: 1000, maxHz: 60 };
    } });
    const source = runtime.registerSource({ device: resource, capability: 'position' });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'position', apply(observation, context) {
      if (!hold) { if (!context.signal.aborted && context.isCurrent()) outputs.push(observation.value); return; }
      lateContext = context;
      return new Promise<void>(resolve => { finishLate = () => { if (!context.signal.aborted && context.isCurrent()) outputs.push(observation.value); resolve(); }; });
    }, release() {} });
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    const request = { from: source, to: sink, principalId: options.peer.principalId, applicationId: 'directory-local-example', sessionId: session.ticket.sessionId };
    const denied = runtime.route(request).start();
    if (denied.ok) throw new Error('Directory metadata unexpectedly authorized a resource route');
    // Separate explicit local source/destination approval, bound to actual registrations above.
    approved = true; const route = runtime.route(request);
    if (!route.start().ok) throw new Error('Explicit resource approval failed');
    runtime.publish(source, { x: 0.25, y: 0.5 }); runtime.flush();
    if (outputs.length !== 1) throw new Error('Local approved observation did not arrive');
    hold = true; now += 20; runtime.publish(source, { x: 0.5, y: 0.5 }); runtime.flush();
    now += 20; runtime.publish(source, { x: 0.75, y: 0.5 });
    if (!finishLate || !lateContext) throw new Error('Expected owned pending local observation');
    await hostDirectory.revoke(lease.peerId);
    if ((await peerDirectory.list()).resources.length !== 0) throw new Error('Metadata revoke left a visible resource');
    // Metadata visibility and resource authority have separate revocations; the caller explicitly performs both.
    approved = false; runtime.revoke(route); finishLate(); await Promise.resolve(); runtime.flush();
    if (!lateContext.signal.aborted || outputs.length !== 1 || route.status().pending !== 0) throw new Error('Explicit resource revoke failed to fence queued/late work');
    return Object.freeze({ profile: received.profile, directoryRows: received.resources.length, joinGrantedRows: before.resources.length,
      hintState, metadataGrantedResourceRoute: denied.ok, localApprovedObservations: outputs.length,
      resourceRevokeFencedLateAndQueued: lateContext.signal.aborted && route.status().pending === 0, excludedPrivateMetadata: !JSON.stringify(received).includes('excluded-from-directory') });
  } finally { runtime?.close(); hostDirectory?.close(); peerDirectory?.close(); hostCaller?.close(); peerCaller?.close(); await coordinator.stop(); }
}
