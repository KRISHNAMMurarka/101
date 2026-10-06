import { createAuthenticatedLoopbackRelay, connectAuthenticatedRelay, AUTHENTICATED_LOOPBACK_RELAY_PROFILE } from '@101/hub-server';
import { createDeviceRuntime, createEphemeralWebIdentity, RemoteResourcePublisher, RemoteResourceReceiver, parseDeviceDescriptor } from '@101/connect';
import type { AuthenticatedRelayClient } from '@101/hub-server';
import type { DeviceDescriptor } from '@101/connect';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

interface NativeCredential { readonly principalId: string; readonly deviceId: string; readonly certificatePem: string; readonly privateKeyPem: string }
export interface LoopbackRelayExampleOptions { readonly selectedPath: 'authenticated-loopback-relay'; readonly serverCertificatePem: string;
  readonly serverPrivateKeyPem: string; readonly clientCaCertificatePem: string; readonly source: NativeCredential; readonly receiver: NativeCredential; readonly signal: AbortSignal }
/** Disposable software integer producer and actual runtime sink. TLS/gateway
 * enrollment is distinct from publication consent and exact resource-route consent.
 * The gateway terminates plaintext; this is not an end-to-end private channel. */
export async function runLoopbackRelayExample(options: LoopbackRelayExampleOptions) {
  if (options.selectedPath !== 'authenticated-loopback-relay') throw Error('Select the authenticated loopback gateway explicitly.');
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  const current = () => { if (aborted.call(options.signal)) throw Error('Relay exercise cancelled.'); };
  current(); const identities = await Promise.all([createEphemeralWebIdentity(), createEphemeralWebIdentity()]); current();
  const owner = new AbortController(), clients: AuthenticatedRelayClient[] = [], opening: Promise<AuthenticatedRelayClient>[] = [];
  const resources: (() => void)[] = [], checks: string[] = [], selections: AuthenticatedRelayClient['selection'][] = [];
  const gateway = createAuthenticatedLoopbackRelay({ serverCertificatePem: options.serverCertificatePem, serverPrivateKeyPem: options.serverPrivateKeyPem,
    clientCaCertificatePem: options.clientCaCertificatePem, origin: 'https://owned-gateway.example', signal: owner.signal,
    enrollments: [options.source, options.receiver].map((value, index) => ({ principalId: value.principalId, deviceId: value.deviceId,
      certificatePem: value.certificatePem, endpointKeyId: identities[index]!.keyId })) });
  const abort = () => { owner.abort(); resources.forEach(close => close()); void gateway.stop(); };
  options.signal.addEventListener('abort', abort, { once: true });
  const began = performance.now(); let turns = 0, effects = 0, releases = 0, routeApprovals = 0;
  function check(condition: boolean, text: string) { current(); if (!condition) throw Error(text); if (checks.length >= 32) throw Error('Exercise check quota'); checks.push(text); }
  async function spin(test: () => boolean, tick: () => void = () => {}, budget = 1500) {
    const until = performance.now() + budget;
    while (!test()) { current(); if (performance.now() >= until || performance.now() - began > 12000 || ++turns > 2000) throw Error('Relay exercise deadline'); tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
    current();
  }
  try {
    await gateway.start(); current();
    async function exercise(name: string, sourceConsent: boolean, sinkConsent: boolean) {
      current(); const epoch = randomBytes(16).toString('hex'), relaySource = new AbortController(), relayReceiver = new AbortController();
      const publication = new AbortController(), resourceOwner = new AbortController(); if (!sourceConsent) publication.abort(); if (!sinkConsent) resourceOwner.abort();
      const ticket = gateway.issuePair({ selectedPath: options.selectedPath, applicationId: 'gateway-integer-example', sessionId: name, epoch,
        sourcePrincipalId: options.source.principalId, receiverPrincipalId: options.receiver.principalId, ttlMs: 5000 }, request => ({ request, expiresAt: request.expiresAt,
        signal: (request.role === 'source' ? relaySource : relayReceiver).signal }));
      const connect = (index: number) => {
        const value = index === 0 ? options.source : options.receiver;
        const promise = connectAuthenticatedRelay({ credential: index === 0 ? ticket.source : ticket.receiver, caCertificatePem: options.clientCaCertificatePem,
          certificatePem: value.certificatePem, privateKeyPem: value.privateKeyPem, identity: identities[index]!, signal: owner.signal });
        opening.push(promise); void promise.then(client => clients.push(client), () => {}); return promise;
      };
      const [source, target] = await Promise.all([connect(0), connect(1)]); current(); selections.push(source.selection, target.selection);
      const sourceDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-integer-source', revision: 1, label: 'Generated integer state',
        adapter: { id: 'example:owned-integer', version: '1.0.0' }, runtime: { platform: 'node-software' }, capabilities: [{ id: 'state', schemaVersion: 1,
          semantic: 'example:integer-state', kind: 'sample', value: { type: 'scalar', unit: '1', min: 0, max: 255 }, permissions: ['subscribe'],
          delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 500 } }] });
      const sinkDevice: DeviceDescriptor = { ...sourceDevice, id: 'owned-integer-output', label: 'Generated integer output', capabilities: sourceDevice.capabilities.map(value =>
        ({ ...value, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) };
      let latest: number | undefined, sourceRegistration: string | undefined;
      const now = () => performance.now(), deadline = now() + 3000;
      const runtime = createDeviceRuntime({ now, clockDomain: 'node-application-monotonic', maxRoutes: 1, maxSubscribers: 1, maxRegistrations: 2, maxPendingDeliveries: 1,
        authorize(request) {
          if (resourceOwner.signal.aborted || request.principalId !== options.receiver.principalId || request.applicationId !== 'gateway-integer-example' || request.sessionId !== name ||
            request.source.deviceId !== sourceDevice.id || request.source.capabilityId !== 'state' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
            request.sink.registrationId !== sinkRegistration || request.sink.deviceId !== sinkDevice.id || request.sink.capabilityId !== 'state' ||
            sourceRegistration && request.source.registrationId !== sourceRegistration) return;
          sourceRegistration = request.source.registrationId; routeApprovals++; return { expiresAt: deadline, maxHz: 30, maxAgeMs: 500 };
        } });
      const sink = runtime.registerSink({ device: sinkDevice, capability: 'state', apply(observation, context) {
        if (resourceOwner.signal.aborted || publication.signal.aborted || context.signal.aborted || !context.isCurrent()) return;
        if (typeof observation.value !== 'number' || !Number.isInteger(observation.value) || observation.source.registrationId !== sourceRegistration || observation.quality !== 'valid' ||
          observation.clockDomain !== 'node-application-monotonic' || observation.timestamp > now()) throw Error('Invalid generated observation');
        latest = observation.value; effects++;
      }, release() { latest = undefined; releases++; } }); const sinkRegistration = sink.id; runtime.setReadiness(sink, 'available');
      const receiver = new RemoteResourceReceiver({ peer: target.peer, epoch, runtime, now, clockId: 'node-application-monotonic', principalId: options.receiver.principalId,
        applicationId: 'gateway-integer-example', sessionId: name });
      const publisher = new RemoteResourcePublisher({ peer: source.peer, epoch, clockId: 'node-source-monotonic', now, device: sourceDevice,
        available: capability => capability === 'state' && !publication.signal.aborted });
      const close = () => { publisher.stop(); receiver.stop(); runtime.close(); }; resources.push(close);
      resourceOwner.signal.addEventListener('abort', () => receiver.stop('stopped'), { once: true });
      publication.signal.addEventListener('abort', () => publisher.stop('stopped'), { once: true });
      const tick = () => { receiver.tick(); publisher.tick(); };
      check(publisher.start(), name + ': separately authenticated resource source');
      await spin(() => !!receiver.description(), tick);
      const before = effects;
      receiver.approve({ capability: 'state', sink, sinkDevice, sinkCapability: 'state', codec: 'json/1', leaseMs: 1000,
        grant: { expiresAt: deadline, maxHz: 30, maxAgeMs: 500 } });
      if (!sourceConsent || !sinkConsent) {
        await spin(() => receiver.status().active === 0 && (publisher.status().active === 0 || publisher.status().stopped), tick);
        check(!publisher.publish('state', 11, { capturedAt: now() }), name + ': independent denied resource consent');
        for (let index = 0; index < 10; index++) { tick(); await new Promise(resolve => setTimeout(resolve, 5)); current(); }
        check(effects === before, name + ': zero new target effects');
      } else {
        await spin(() => publisher.isBound('state') && receiver.status().clockReady && receiver.status().active === 1, tick);
        let previousCapture = -Infinity;
        for (const value of [17, 23]) { await spin(() => now() - previousCapture >= 35, tick); previousCapture = now(); check(publisher.publish('state', value, { capturedAt: now() }), 'bounded generated integer admitted'); await spin(() => latest === value, tick); }
        check(effects === before + 2, 'actual separately authorized current typed integer effects');
        publication.abort(); await spin(() => receiver.status().active === 0 && latest === undefined, tick);
        check(!publisher.publish('state', 99, { capturedAt: now() }), 'source withdrawal fences new and queued samples');
        check(releases > 0, 'actual sink owner release after source withdrawal');
      }
      close(); await gateway.revokePair(ticket.pairId); await Promise.all([source.stop(), target.stop()]); current();
    }
    await exercise('source-denied', false, true); await exercise('sink-denied', true, false); await exercise('both-explicit', true, true);
    check(selections.every(value => value.plaintextGateway && value.profile === AUTHENTICATED_LOOPBACK_RELAY_PROFILE && /^[0-9a-f]{64}$/.test(value.transcriptDigest)), 'explicit gateway selection records actual two-leg authenticated transcripts');
    check(new Set(selections.map(value => value.transcriptDigest)).size === selections.length, 'each replacement leg has a fresh independent transcript');
    await gateway.stop(); current(); const stopped = gateway.snapshot();
    check(stopped.pairs === 0 && stopped.nativeConnections === 0 && stopped.pendingRaw === 0 && stopped.queuedMessages === 0 && stopped.timers === 0, 'actual gateway native sockets callbacks queues and timers closed');
    const receipt = Object.freeze({ profile: AUTHENTICATED_LOOPBACK_RELAY_PROFILE, selectedPath: options.selectedPath, plaintextGateway: true,
      endToEndPayloadProtection: false, resourceGrantsFromRelay: false, selection: Object.freeze(selections), checks: Object.freeze(checks),
      actualSoftwareEffects: effects, sinkReleases: releases, exactRouteApprovals: routeApprovals, sourceClock: 'node-source-monotonic',
      observedTurns: turns, cleanup: stopped, physicalQualification: false });
    if (JSON.stringify(receipt).length > 8192) throw Error('Relay receipt quota'); return receipt;
  } finally {
    options.signal.removeEventListener('abort', abort); owner.abort(); resources.forEach(close => close());
    await Promise.allSettled(opening); await Promise.all(clients.map(client => client.stop())); await gateway.stop();
  }
}
