import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareOperatorStartup, createCoordinatorFetcher, createPrivateDirectoryClient,
  createAuthenticatedLoopbackRelay, connectAuthenticatedRelay } from '@101/hub-server';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '@101/pairing';
import { createDeviceRuntime, createEphemeralWebIdentity, RemoteResourcePublisher,
  RemoteResourceReceiver, parseDeviceDescriptor } from '@101/connect';
import { createCoordinatorFixtures } from '../../tools/qa-https-coordinator.mjs';

export const DISPOSABLE_STACK_PROFILE = 'disposable-coordinator-directory-gateway/1';
export const DISPOSABLE_STACK_LIMITS = Object.freeze({ concurrentRuns: 1, controllerGenerations: 2,
  serviceLifetimeMs: 15000, pendingRelayClients: 4, liveRelayClients: 4, nativeSocketAttempts: 128,
  relayPairsPerGeneration: 4, checks: 32, events: 8, receiptBytes: 16384, waitTurns: 2000,
  individualWaitMs: 1500, latestHz: 30, maxAgeMs: 500, runtimeRoutes: 1, runtimeRegistrations: 2, runtimeRaw: 1 });
const now = performance.now.bind(performance), wall = Date.now.bind(Date);
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const encoder = new TextEncoder();
let reserved = false;
const origin = 'https://disposable-stack.example', applicationId = 'disposable-stack';
function signalCurrent(signal) { try { return aborted.call(signal) === false; } catch { return false; } }
function ownedOptions(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw Error('Disposable stack options invalid.');
  const result = Object.create(null), keys = Reflect.ownKeys(input);
  if (keys.length > 3) throw Error('Disposable stack options invalid.');
  for (const key of keys) {
    const entry = Object.getOwnPropertyDescriptor(input, key);
    if (!['mode', 'signal', 'onEvent'].includes(key) || !entry?.enumerable || !('value' in entry)) throw Error('Disposable stack options invalid.');
    result[key] = entry.value;
  }
  if (!['exercise', 'serve'].includes(result.mode) || !Object.hasOwn(result, 'signal')) throw Error('Select exercise or serve with a native cancellation signal.');
  try { aborted.call(result.signal); } catch { throw Error('Disposable stack signal invalid.'); }
  if (result.onEvent !== undefined && typeof result.onEvent !== 'function') throw Error('Disposable stack observer invalid.');
  return result;
}
function bounded(value) { if (encoder.encode(JSON.stringify(value)).byteLength > DISPOSABLE_STACK_LIMITS.receiptBytes) throw Error('Disposable stack receipt quota.'); return Object.freeze(value); }
function scalar(id = 'stack-state') {
  return parseDeviceDescriptor({ schemaVersion: 1, id, revision: 1, label: 'Generated integer state', adapter: { id: 'example:stack-integer', version: '1.0.0' },
    runtime: { platform: 'node-software' }, capabilities: [{ id: 'state', schemaVersion: 1, semantic: 'example:integer-state', kind: 'sample',
      value: { type: 'scalar', unit: '1', min: 0, max: 255 }, permissions: ['subscribe'], delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 500 } }] });
}

/** Owned disposable Node software composition. Observer completion retains the
 * one-run reservation; service expiry retires native contexts even while an
 * observer promise is unresolved. Provisioning has existing finite per-OpenSSL bounds; the 15s budget
 * covers native service ownership, not total synchronous provisioning wall time.
 * The gateway is trusted with plaintext. Metadata visibility and relay admission
 * grant no source subscription or sink write authority. No caller paths/credentials. */
export async function runDisposableStack(input) {
  if (reserved) throw Error('Disposable stack already active.'); reserved = true;
  let options, fixture, serviceTimer, reason, failure, cleanupFailure, cleanupPromise, cleanupSettled = false, serviceDeadline = Infinity, serviceStartedAt, serviceStoppedAt;
  let events = 0, turns = 0, effects = 0, releases = 0, routeApprovals = 0, generation = 0, issuedSockets = 0;
  const checks = [], endpoints = [], stacks = [], sockets = new Map(), opening = new Set(), relayClients = new Set(), delays = new Set();
  const owner = new AbortController(), operationScope = new AsyncLocalStorage(), scopeToken = Object.freeze({}), nativeClients = channel('net.client.socket');
  const native = work => operationScope.run(scopeToken, work);
  const observeNative = message => {
    if (operationScope.getStore() !== scopeToken) return;
    const socket = message.socket;
    issuedSockets++;
    const closed = new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); }));
    sockets.set(socket, closed);
    if (issuedSockets > DISPOSABLE_STACK_LIMITS.nativeSocketAttempts || !signalCurrent(owner.signal)) { cancel('cancelled'); socket.destroy(); }
  };
  const live = () => signalCurrent(owner.signal) && signalCurrent(options?.signal) && now() < serviceDeadline;
  function current() { if (!live()) { if (!reason) cancel(now() >= serviceDeadline ? 'expired' : 'cancelled'); throw Error('Disposable stack retired.'); } }
  function stopStack(stack) {
    if (stack.stopping) return stack.stopping;
    stack.owner.abort(); stack.resources.forEach(close => close()); stack.directories.forEach(value => value.close()); stack.fetchers.forEach(value => value.close());
    stack.stopping = Promise.all([stack.gateway.stop(), stack.startup.stop()]); void stack.stopping.catch(() => {}); return stack.stopping;
  }
  function cancel(value = 'cancelled') {
    reason ??= value; owner.abort(); delays.forEach(wake => wake()); void cleanupOwned();
  }
  function cleanupOwned() {
    if (cleanupPromise) return cleanupPromise;
    owner.abort(); delays.forEach(wake => wake());
    cleanupPromise = (async () => {
      const controllers = await Promise.allSettled(stacks.map(stopStack)); await Promise.allSettled([...opening]);
      const clients = await Promise.allSettled([...relayClients].map(value => value.stop())); relayClients.clear();
      for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]); nativeClients.unsubscribe(observeNative); operationScope.disable();
      if (controllers.some(value => value.status === 'rejected') || clients.some(value => value.status === 'rejected') || sockets.size || opening.size || relayClients.size || delays.size ||
        stacks.some(value => value.startup.snapshot().phase !== 'stopped' || value.gateway.snapshot().phase !== 'stopped')) throw Error('Disposable stack cleanup incomplete.');
      serviceStoppedAt = now();
      const directory = fixture?.directory; fixture?.close(); if (directory && existsSync(directory)) throw Error('Disposable stack temporary identity remains.');
      cleanupSettled = true;
    })(); void cleanupPromise.catch(() => {}); return cleanupPromise;
  }
  async function wait(ms) {
    await new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); removeEvent.call(owner.signal, 'abort', finish); delays.delete(finish); resolve(); };
      delays.add(finish); addEvent.call(owner.signal, 'abort', finish, { once: true }); timer = setTimeout(finish, ms);
      if (!signalCurrent(owner.signal)) finish();
    }); current();
  }
  async function call(work) { current(); const value = await native(work); current(); return value; }
  async function spin(test, tick = () => {}) {
    const deadline = Math.min(serviceDeadline, now() + DISPOSABLE_STACK_LIMITS.individualWaitMs);
    while (!test()) { current(); if (now() >= deadline || ++turns > DISPOSABLE_STACK_LIMITS.waitTurns) throw Error('Disposable stack wait deadline.'); tick(); current(); await wait(5); }
    current();
  }
  function check(condition, label) { current(); if (!condition || checks.length >= DISPOSABLE_STACK_LIMITS.checks) throw Error('Disposable stack check failed.'); checks.push(label); }
  async function emit(event) {
    if (++events > DISPOSABLE_STACK_LIMITS.events) throw Error('Disposable stack event quota.');
    const value = bounded(event);
    if (options?.onEvent) await options.onEvent(value);
  }
  function credential(endpoint, identity) { return { endpoint, origin, caCertificatePem: fixture.ca, certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem }; }
  async function createStack() {
    current(); if (++generation > DISPOSABLE_STACK_LIMITS.controllerGenerations) throw Error('Disposable stack generation quota.');
    const identities = await call(() => Promise.all([createEphemeralWebIdentity(), createEphemeralWebIdentity()]));
    const source = fixture.clients[0], receiver = fixture.clients[2], sourceDevice = scalar(), hiddenDevice = scalar('stack-hidden');
    const prepared = prepareOperatorStartup({ schemaVersion: 1, profile: 'operator-loopback-startup/1',
      identity: { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca,
        enrollments: [source, receiver].map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
      origins: [origin], listener: { host: '127.0.0.1', port: 0 }, directory: { resources: [sourceDevice, hiddenDevice].map(descriptor =>
        ({ principalId: source.principalId, deviceId: source.deviceId, descriptor, capabilityIds: ['state'] })) },
      storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } });
    if (!prepared.ok) throw Error('Disposable stack startup validation failed.'); current();
    const localOwner = new AbortController(), gateway = createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem,
      serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca, origin, signal: localOwner.signal,
      enrollments: [source, receiver].map((value, index) => ({ principalId: value.principalId, deviceId: value.deviceId,
        certificatePem: value.certificatePem, endpointKeyId: identities[index].keyId })) });
    const stack = { startup: prepared.controller, gateway, owner: localOwner, identities, source, receiver, sourceDevice,
      directories: [], fetchers: [], resources: [], stopping: undefined, pairCount: 0, sessionId: 'STACK-' + randomBytes(8).toString('hex') };
    stacks.push(stack);
    if (serviceStartedAt === undefined) { serviceStartedAt = now(); serviceDeadline = serviceStartedAt + DISPOSABLE_STACK_LIMITS.serviceLifetimeMs;
      serviceTimer = setTimeout(() => cancel('expired'), Math.max(1, serviceDeadline - now())); }
    // Reserve both controllers before starting either; a rejected branch cannot
    // orphan the other native bind or create a replacement owner after cancellation.
    const [coordinator, relayEndpoint] = await call(() => Promise.all([stack.startup.start(), gateway.start()]));
    if (!coordinator.ok) throw Error('Disposable stack native startup failed.');
    stack.endpoint = coordinator.endpoint; stack.relayEndpoint = relayEndpoint; endpoints.push(coordinator.endpoint, relayEndpoint);
    await emit({ event: 'ready', profile: DISPOSABLE_STACK_PROFILE, generation, coordinator: coordinator.endpoint, gateway: relayEndpoint,
      remainingServiceMs: Math.max(0, Math.floor(serviceDeadline - now())), storage: 'ephemeral', gatewayPlaintextTrust: true, grants: 0 }); current();
    check(stack.startup.snapshot().phase === 'running' && gateway.snapshot().phase === 'active', 'both native components simultaneously current');
    return stack;
  }
  function fetcher(stack, identity) { const value = createCoordinatorFetcher(credential(stack.endpoint, identity)); stack.fetchers.push(value); return value; }
  async function signalingAndDirectory(stack) {
    const host = fetcher(stack, stack.source), peer = fetcher(stack, stack.receiver);
    check((await call(() => host.fetch(stack.endpoint + '/v1/health'))).status === 200, 'native mTLS coordinator health while gateway active');
    const session = await call(() => createHttpSignalingSession(stack.endpoint, stack.sessionId, { fetcher: host.fetch }));
    const peerClient = new HttpControllerSignalingClient(session.ticket, peer.fetch), lease = await call(() => peerClient.join({ deviceId: stack.receiver.deviceId, label: 'Owned software peer', capabilities: {} }));
    const hostDirectory = createPrivateDirectoryClient({ ...credential(stack.endpoint, stack.source), sessionId: stack.sessionId, role: 'host', token: session.hostToken });
    const peerDirectory = createPrivateDirectoryClient({ ...credential(stack.endpoint, stack.receiver), sessionId: stack.sessionId, role: 'peer', peerId: lease.peerId, token: lease.peerToken });
    stack.directories.push(hostDirectory, peerDirectory); stack.hostDirectory = hostDirectory; stack.peerDirectory = peerDirectory; stack.session = session;
    check((await call(() => peerDirectory.list(owner.signal))).resources.length === 0, 'rendezvous membership and configured catalog grant no visibility');
    const expiry = wall() + Math.min(10000, Math.floor(serviceDeadline - now()));
    await call(() => hostDirectory.enroll(stack.sourceDevice.id, expiry, owner.signal)); await call(() => hostDirectory.enroll('stack-hidden', expiry, owner.signal));
    await call(() => hostDirectory.allow(lease.peerId, [stack.sourceDevice.id], expiry, owner.signal));
    const visible = await call(() => peerDirectory.list(owner.signal));
    check(visible.resources.length === 1 && visible.resources[0].id === stack.sourceDevice.id, 'separate current host directory approval exposes only selected software resource');
    return session;
  }
  function issue(stack, name, allow = true) {
    current(); if (++stack.pairCount > DISPOSABLE_STACK_LIMITS.relayPairsPerGeneration) throw Error('Disposable stack pair quota.');
    const source = new AbortController(), receiver = new AbortController(), epoch = randomBytes(16).toString('hex');
    const ticket = stack.gateway.issuePair({ selectedPath: 'authenticated-loopback-relay', applicationId, sessionId: stack.sessionId, epoch,
      sourcePrincipalId: stack.source.principalId, receiverPrincipalId: stack.receiver.principalId,
      ttlMs: Math.max(1, Math.min(10000, Math.floor(serviceDeadline - now()))) }, request => {
      if (!allow || !live() || request.applicationId !== applicationId || request.sessionId !== stack.sessionId || request.epoch !== epoch) return;
      return { request, expiresAt: request.expiresAt, signal: (request.role === 'source' ? source : receiver).signal };
    }); return { ticket, source, receiver, epoch, name };
  }
  function connect(stack, token, index) {
    current(); if (opening.size >= DISPOSABLE_STACK_LIMITS.pendingRelayClients || relayClients.size >= DISPOSABLE_STACK_LIMITS.liveRelayClients) throw Error('Disposable stack client quota.');
    const identity = index === 0 ? stack.source : stack.receiver;
    const pending = native(() => connectAuthenticatedRelay({ credential: token, caCertificatePem: fixture.ca, certificatePem: identity.certificatePem,
      privateKeyPem: identity.privateKeyPem, identity: stack.identities[index], signal: owner.signal }));
    opening.add(pending); void pending.then(value => { relayClients.add(value); if (!live()) void value.stop(); }, () => {}).finally(() => opening.delete(pending));
    return pending;
  }
  async function resourceExercise(stack, name, sourceAllowed, sinkAllowed, revokeSink = false) {
    const issued = issue(stack, name), [source, target] = await call(() => Promise.all([connect(stack, issued.ticket.source, 0), connect(stack, issued.ticket.receiver, 1)]));
    const publication = new AbortController(), sinkOwner = new AbortController(); if (!sourceAllowed) publication.abort(); if (!sinkAllowed) sinkOwner.abort();
    const sourceDevice = stack.sourceDevice, sinkDevice = parseDeviceDescriptor({ ...sourceDevice, id: 'stack-output', capabilities: sourceDevice.capabilities.map(value =>
      ({ ...value, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) });
    let latest, registration; const deadline = Math.min(serviceDeadline, now() + 3000);
    const runtime = createDeviceRuntime({ now, clockDomain: 'node-application-monotonic', maxRoutes: 1, maxSubscribers: 1, maxRegistrations: 2, maxPendingDeliveries: 1,
      authorize(request) {
        if (!live() || !signalCurrent(sinkOwner.signal) || request.principalId !== stack.receiver.principalId || request.applicationId !== applicationId || request.sessionId !== stack.sessionId ||
          request.source.deviceId !== sourceDevice.id || request.source.capabilityId !== 'state' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
          request.sink.registrationId !== sink.id || request.sink.deviceId !== sinkDevice.id || request.sink.capabilityId !== 'state' || registration && request.source.registrationId !== registration) return;
        registration = request.source.registrationId; routeApprovals++; return { expiresAt: deadline, maxHz: 30, maxAgeMs: 500 };
      } });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'state', apply(observation, context) {
      if (!live() || !signalCurrent(publication.signal) || !signalCurrent(sinkOwner.signal) || !context.isCurrent() || !signalCurrent(context.signal)) return;
      if (typeof observation.value !== 'number' || !Number.isInteger(observation.value) || observation.source.registrationId !== registration || observation.quality !== 'valid' ||
        observation.clockDomain !== 'node-application-monotonic' || observation.timestamp > now()) throw Error('Disposable stack typed observation invalid.');
      if (!live() || !signalCurrent(publication.signal) || !signalCurrent(sinkOwner.signal) || !signalCurrent(context.signal)) return;
      latest = observation.value; effects++;
    }, release() { latest = undefined; releases++; } }); runtime.setReadiness(sink, 'available');
    const receiver = new RemoteResourceReceiver({ peer: target.peer, epoch: issued.epoch, runtime, now, clockId: 'node-application-monotonic',
      principalId: stack.receiver.principalId, applicationId, sessionId: stack.sessionId });
    const publisher = new RemoteResourcePublisher({ peer: source.peer, epoch: issued.epoch, clockId: 'node-source-monotonic', now, device: sourceDevice,
      available: capability => capability === 'state' && live() && signalCurrent(publication.signal) });
    const sourceAbort = () => publisher.stop('stopped'), sinkAbort = () => receiver.stop('stopped');
    addEvent.call(publication.signal, 'abort', sourceAbort, { once: true }); addEvent.call(sinkOwner.signal, 'abort', sinkAbort, { once: true });
    let closed = false;
    const close = () => { if (closed) return; closed = true; removeEvent.call(publication.signal, 'abort', sourceAbort); removeEvent.call(sinkOwner.signal, 'abort', sinkAbort); publisher.stop(); receiver.stop(); runtime.close(); };
    stack.resources.push(close); const tick = () => { receiver.tick(); publisher.tick(); }, before = effects;
    try {
      check(publisher.start(), 'separate current authenticated relay resource publication'); await spin(() => !!receiver.description(), tick);
      receiver.approve({ capability: 'state', sink, sinkDevice, sinkCapability: 'state', codec: 'json/1', leaseMs: 1000, grant: { expiresAt: deadline, maxHz: 30, maxAgeMs: 500 } }); current();
      if (!sourceAllowed || !sinkAllowed) {
        await spin(() => receiver.status().active === 0 && (publisher.status().active === 0 || publisher.status().stopped), tick);
        const accepted = publisher.publish('state', 11, { capturedAt: now() }); for (let turn = 0; turn < 10; turn++) { tick(); await wait(5); }
        check(!accepted && effects === before, sourceAllowed ? 'sink write denial causes zero new typed effects' : 'source subscribe denial causes zero new typed effects');
      } else {
        await spin(() => publisher.isBound('state') && receiver.status().clockReady && receiver.status().active === 1, tick);
        check(publisher.publish('state', 17, { capturedAt: now() }), 'explicit source+sink owners admit software integer'); await spin(() => latest === 17, tick);
        if (name === 'source-revoke') {
          await call(() => stack.hostDirectory.remove(sourceDevice.id, owner.signal)); check((await call(() => stack.peerDirectory.list(owner.signal))).resources.length === 0, 'metadata withdrawal removes visibility');
          await wait(35); check(publisher.publish('state', 23, { capturedAt: now() }), 'metadata withdrawal alone does not revoke independently current resource owners'); await spin(() => latest === 23, tick);
        }
        const priorRelease = releases; if (revokeSink) sinkOwner.abort(); else publication.abort();
        await spin(() => receiver.status().active === 0 && latest === undefined && releases > priorRelease, tick);
        await wait(35); publisher.publish('state', 99, { capturedAt: now() }); tick(); await wait(10);
        check(latest === undefined && effects === before + (name === 'source-revoke' ? 2 : 1), revokeSink ? 'separate sink owner revocation releases actual route and fences late samples' : 'source owner withdrawal releases actual route and fences late samples');
      }
      return { credential: issued.ticket.source, selectedPath: source.selection.selectedPath, gatewayKeyId: source.selection.gatewayKeyId };
    } finally {
      close(); issued.source.abort(); issued.receiver.abort(); await stack.gateway.revokePair(issued.ticket.pairId); await Promise.all([source.stop(), target.stop()]); relayClients.delete(source); relayClients.delete(target);
    }
  }
  async function retire(stack) {
    await stopStack(stack); await Promise.allSettled([...opening]); await Promise.all([...relayClients].map(value => value.stop())); relayClients.clear();
    for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]);
    const snapshot = stack.gateway.snapshot(); check(stack.startup.snapshot().phase === 'stopped' && snapshot.phase === 'stopped' && snapshot.nativeConnections === 0 && snapshot.pendingRaw === 0 && snapshot.timers === 0 && snapshot.pairs === 0 && sockets.size === 0,
      'actual component and owned client raw retirement settled');
  }
  let detach = () => {};
  try {
    options = ownedOptions(input); const onAbort = () => cancel('cancelled'); addEvent.call(options.signal, 'abort', onAbort, { once: true }); detach = () => removeEvent.call(options.signal, 'abort', onAbort);
    if (!signalCurrent(options.signal)) cancel('cancelled'); current();
    fixture = createCoordinatorFixtures(); current();
    const fixtureNames = readdirSync(fixture.directory); if (fixtureNames.length > 64) throw Error('Disposable stack fixture quota.');
    for (const name of ['ca', 'server', 'wrong-host', 'expired-server', 'host-a', 'host-b', 'peer-a', 'peer-b', 'other', 'unknown', 'expired-client'])
      chmodSync(join(fixture.directory, name + '.key'), 0o600);
    current(); nativeClients.subscribe(observeNative);
    const initial = await createStack();
    if (options.mode === 'serve') { while (live()) await wait(Math.min(100, Math.max(1, serviceDeadline - now()))); }
    else {
      await signalingAndDirectory(initial);
      const before = issuedSockets; let denied = false;
      // A denied pair never mints credentials or dispatches a native relay client.
      try { initial.gateway.issuePair({ selectedPath: 'authenticated-loopback-relay', applicationId, sessionId: initial.sessionId, epoch: '0'.repeat(32),
        sourcePrincipalId: initial.source.principalId, receiverPrincipalId: initial.receiver.principalId, ttlMs: 1000 }, () => undefined); } catch { denied = true; }
      check(denied && issuedSockets === before && effects === 0, 'relay admission denial issues no native client or typed effect');
      await resourceExercise(initial, 'source-denied', false, true); await resourceExercise(initial, 'sink-denied', true, false);
      await resourceExercise(initial, 'source-revoke', true, true); const old = await resourceExercise(initial, 'sink-revoke', true, true, true);
      const previous = initial.session.hostToken; await retire(initial); current();
      const replacement = await createStack(), freshHost = fetcher(replacement, replacement.source);
      const freshSession = await call(() => createHttpSignalingSession(replacement.endpoint, initial.sessionId, { fetcher: freshHost.fetch }));
      check(freshSession.hostToken !== previous && (await call(() => freshHost.fetch(replacement.endpoint + '/v1/sessions/' + initial.sessionId + '/host/peers', { headers: { Authorization: 'Bearer ' + previous } }))).status === 404,
        'fresh controller restores no old coordinator bearer authority');
      let oldDenied = false; try { await call(() => connect(replacement, { ...old.credential, endpoint: replacement.relayEndpoint }, 0)); } catch { current(); oldDenied = true; }
      check(oldDenied && replacement.gateway.snapshot().pairs === 0, 'fresh gateway restores no prior relay bearer or pair');
      await signalingAndDirectory(replacement); const recovered = await resourceExercise(replacement, 'recovery', true, true);
      check(recovered.gatewayKeyId !== old.gatewayKeyId && recovered.selectedPath === 'authenticated-loopback-relay', 'fresh gateway identity and fresh explicit owners recover typed service');
      await retire(replacement);
    }
  } catch (error) { if (!reason) failure = error; }
  finally {
    detach(); clearTimeout(serviceTimer); serviceTimer = undefined; owner.abort(); delays.forEach(wake => wake());
    try {
      await cleanupOwned();
      const removed = { event: 'removed', profile: DISPOSABLE_STACK_PROFILE, reason: reason ?? (failure ? 'failed' : 'completed'), endpoints: Object.freeze([...endpoints]),
        temporaryCredentialsRemoved: true, nativeContexts: 0, pendingClients: 0, timers: 0 };
      await emit(removed);
      if (options && !signalCurrent(options.signal)) reason ??= 'cancelled';
      if (now() >= serviceDeadline) reason ??= 'expired';
    } catch (error) { cleanupFailure = error; }
  }
  try {
    if (cleanupFailure) throw Error('Disposable stack cleanup failed.'); if (failure) throw Error('Disposable stack exercise failed.');
    const receipt = bounded({ profile: DISPOSABLE_STACK_PROFILE, result: reason ?? 'pass', checks: Object.freeze(checks), actualControllerGenerations: stacks.length, attemptedControllerGenerations: generation,
      actualSoftwareEffects: effects, sinkReleases: releases, exactRouteApprovals: routeApprovals, actualNativeSocketAttempts: issuedSockets, observedWaitTurns: turns,
      serviceOwnedMs: serviceStartedAt === undefined ? 0 : Math.max(0, serviceStoppedAt - serviceStartedAt), sourceClock: 'node-source-monotonic', gatewayPlaintextTrust: true,
      resourceGrantsFromConfigurationOrMetadataOrRelay: false, cleanup: { nativeContexts: 0, pendingClients: 0, timers: 0, temporaryCredentialsRemoved: true }, physicalQualification: false });
    return receipt;
  } finally { if (cleanupSettled) reserved = false; }
}
