import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { connect as connectTls, checkServerIdentity } from 'node:tls';
import { X509Certificate, randomBytes } from 'node:crypto';
import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createAuthenticatedLoopbackRelay, connectAuthenticatedRelay } from '@101/hub-server';
import { createEphemeralWebIdentity, authenticatedPeerScope, createDeviceRuntime, PointerResourceProvider,
  RemoteResourceReceiver, pointerSourceDescriptor, WSS_SUBPROTOCOL } from '@101/connect';
import { createSecureWebSocketPeer } from '@101/connect/examples/secure-websocket';
import { createCoordinatorFixtures } from '../../tools/qa-https-coordinator.mjs';

const ws = createRequire(import.meta.url)('ws');
const now = performance.now.bind(performance), origin = 'https://owned-runtime-recovery.example';
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const active = signal => { try { return nativeAborted.call(signal) === false; } catch { return false; } };
let pathReserved = false;
async function until(condition, signal, timeout = 3000) {
  const deadline = now() + timeout;
  while (!condition()) { if (!active(signal) || now() >= deadline) throw Error('Recovery native wait retired.'); await new Promise(resolve => setTimeout(resolve, 5)); }
  if (!active(signal)) throw Error('Recovery owner retired.');
}

/** Fixed native fixture port. Closure requires actual TLS socket close AND every
 * actually issued ws send callback; logical SDK cancellation is insufficient. */
function nativePort(socket, ports) {
  let raw = 0, closed = false, finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const port = { get readyState() { return socket.readyState; }, get protocol() { return socket.protocol; },
    get bufferedAmount() { return socket.bufferedAmount; }, get binaryType() { return socket.binaryType; }, set binaryType(value) { socket.binaryType = value; },
    onopen: null, onclose: null, onerror: null, onmessage: null, raw: () => raw, settled,
    send(data) { raw++; try { socket.send(data, error => { raw--; if (error) port.onerror?.({}); complete(); }); } catch (error) { raw--; complete(); throw error; } },
    close() { socket.terminate(); } };
  function complete() { if (!closed || raw) return; socket.removeListener('open', opened); socket.removeListener('close', ended); socket.removeListener('error', failed); socket.removeListener('message', message); finish(); }
  const opened = () => port.onopen?.({}), ended = () => { closed = true; port.onclose?.({}); complete(); }, failed = () => port.onerror?.({});
  const message = (data, binary) => port.onmessage?.({ data: binary ? data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer : data.toString() });
  socket.binaryType = 'arraybuffer'; socket.on('open', opened); socket.on('close', ended); socket.on('error', failed); socket.on('message', message); ports.push(port); return port;
}

/** Only newly owned fixed certificates, loopback endpoints and reviewed native
 * modules. No caller URL/config/key/worker path. Selected gateway trusts plaintext. */
export async function createNodeRecoveryPath(path, signal) {
  if (pathReserved) throw Error('Recovery native path already active.'); pathReserved = true;
  if (!['direct-wss', 'authenticated-loopback-relay'].includes(path) || !active(signal)) { pathReserved = false; throw Error('Recovery native path invalid.'); }
  let fixture, deadline, lifetime, stopping, pairs = 0, issued = 0;
  const owner = new AbortController(), bundles = new Set(), rawSockets = new Map();
  const track = socket => { if (++issued > 128) { socket.destroy(); throw Error('Recovery native socket quota.'); }
    const closed = new Promise(resolve => socket.once('close', () => { rawSockets.delete(socket); resolve(); })); rawSockets.set(socket, closed); if (!active(owner.signal)) socket.destroy(); return socket; };
  const current = () => { if (!active(signal) || !active(owner.signal) || now() >= deadline) throw Error('Recovery native path retired.'); };
  function close() {
    if (stopping) return stopping; owner.abort(); clearTimeout(lifetime);
    stopping = (async () => { await Promise.all([...bundles].map(value => value.close()));
      for (const socket of rawSockets.keys()) socket.destroy(); await Promise.all([...rawSockets.values()]);
      assert.equal(rawSockets.size, 0); assert.equal(bundles.size, 0);
      const directory = fixture?.directory; fixture?.close(); assert.ok(!directory || !existsSync(directory));
      removeEvent.call(signal, 'abort', cancelled); pathReserved = false;
      return { nativeContexts: 0, pendingWrites: 0, temporaryCredentialsRemoved: true, issuedNativeSockets: issued };
    })(); void stopping.catch(() => {}); return stopping;
  }
  const cancelled = () => { void close(); }; addEvent.call(signal, 'abort', cancelled, { once: true });
  try {
    fixture = createCoordinatorFixtures();
    for (const name of ['ca', 'server', 'wrong-host', 'expired-server', 'host-a', 'host-b', 'peer-a', 'peer-b', 'other', 'unknown', 'expired-client']) chmodSync(join(fixture.directory, name + '.key'), 0o600);
    deadline = now() + 15000; lifetime = setTimeout(() => { void close(); }, 15000); current();
    return { path, async open() {
      current(); if (++pairs > 4 || bundles.size) throw Error('Recovery native generation quota.');
      const epoch = randomBytes(16).toString('hex'), sessionId = 'recovery-' + path + '-' + pairs, applicationId = 'runtime-recovery';
      const identities = await Promise.all([createEphemeralWebIdentity(), createEphemeralWebIdentity()]); current();
      const localOwner = new AbortController(), ports = [], auth = [], acceptedSockets = new Map(), openings = new Set(); let gateway, server, wss, timer, retiring, bind;
      const bundle = { epoch, applicationId, sessionId, generation: pairs, path,
        sourcePeer: /** @type {import('@101/connect').ResourcePeer | undefined} */ (undefined),
        receiverPeer: /** @type {import('@101/connect').ResourcePeer | undefined} */ (undefined),
        async disconnect() { localOwner.abort(); auth.forEach(value => value.stop()); ports.forEach(value => value.close()); if (gateway) await gateway.stop(); },
        close() { if (retiring) return retiring; localOwner.abort(); clearInterval(timer); auth.forEach(value => value.stop()); ports.forEach(value => value.close());
          retiring = (async () => { if (gateway) await gateway.stop(); await Promise.allSettled([...openings]);
            await Promise.all(auth.filter(value => value.selection).map(value => value.stop()));
            for (const socket of acceptedSockets.keys()) socket.destroy(); await Promise.all([...acceptedSockets.values()]);
            await Promise.all(ports.map(value => value.settled));
            if (bind) await bind.catch(() => {}); if (wss) await new Promise(resolve => wss.close(resolve)); if (server) await new Promise(resolve => server.close(resolve));
            for (const socket of rawSockets.keys()) socket.destroy(); await Promise.all([...rawSockets.values()]);
            assert.equal(acceptedSockets.size, 0); assert.equal(ports.reduce((sum, value) => sum + value.raw(), 0), 0); bundles.delete(bundle);
          })(); void retiring.catch(() => {}); return retiring; },
        snapshot() { return { current: active(localOwner.signal), rawWrites: ports.reduce((sum, value) => sum + value.raw(), 0), nativeConnections: acceptedSockets.size }; } };
      bundles.add(bundle);
      try {
        if (path === 'authenticated-loopback-relay') {
          gateway = createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
            clientCaCertificatePem: fixture.ca, origin, signal: localOwner.signal, enrollments: [fixture.clients[0], fixture.clients[2]].map((client, index) =>
              ({ principalId: client.principalId, deviceId: client.deviceId, certificatePem: client.certificatePem, endpointKeyId: identities[index].keyId })) });
          await gateway.start(); current(); const permit = new AbortController();
          const credential = gateway.issuePair({ selectedPath: path, applicationId, sessionId, epoch, sourcePrincipalId: fixture.clients[0].principalId,
            receiverPrincipalId: fixture.clients[2].principalId, ttlMs: Math.max(1, Math.min(10000, Math.floor(deadline - now()))) }, request =>
            active(localOwner.signal) && active(owner.signal) ? { request, expiresAt: request.expiresAt, signal: permit.signal } : undefined);
          const connecting = []; for (const [index, client] of [fixture.clients[0], fixture.clients[2]].entries()) {
            current(); const pending = connectAuthenticatedRelay({ credential: index ? credential.receiver : credential.source, caCertificatePem: fixture.ca,
              certificatePem: client.certificatePem, privateKeyPem: client.privateKeyPem, identity: identities[index], signal: localOwner.signal }); openings.add(pending);
            void pending.then(value => { auth.push(value); if (retiring) void value.stop(); }, () => {}); connecting.push(pending);
          }
          // Both actual openings remain owned even if one branch rejects early.
          const opened = await Promise.allSettled(connecting);
          if (opened.some(result => result.status === 'rejected')) throw Error('Recovery relay opening failed.');
          bundle.sourcePeer = opened[0].value.peer; bundle.receiverPeer = opened[1].value.peer; bundle.selection = opened[0].value.selection;
        } else {
          server = createServer({ cert: fixture.server.certificatePem, key: fixture.server.privateKeyPem, ca: fixture.ca, requestCert: true, rejectUnauthorized: true,
            minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
          server.on('connection', socket => { const closed = new Promise(resolve => socket.once('close', () => { acceptedSockets.delete(socket); resolve(); })); acceptedSockets.set(socket, closed); });
          wss = new ws.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8192 }); let endpoint;
          server.on('upgrade', (request, socket, head) => {
            if (!active(localOwner.signal) || !active(owner.signal) || !request.socket.authorized || request.socket.getProtocol() !== 'TLSv1.3' || request.url !== '/owned-recovery' ||
              request.headers.origin !== origin || request.headers['sec-websocket-protocol'] !== WSS_SUBPROTOCOL || auth.length > 1) { socket.destroy(); return; }
            wss.handleUpgrade(request, socket, head, native => { const port = nativePort(native, ports);
              const peer = createSecureWebSocketPeer({ transport: { side: 'server', socket: port, endpoint, now, limits: { maxMessageBytes: 8192, reliableBufferLimit: 16384, latestBufferLimit: 8192 } }, identity: identities[1],
                epoch, applicationId, sessionId, role: 'receiver', expectedRemoteKeyId: identities[0].keyId, now }); auth.push(peer); void peer.start(); });
          });
          let bound, bindFailed; bind = new Promise((resolve, reject) => { bound = resolve; bindFailed = reject; }); void bind.catch(() => {});
          server.once('error', bindFailed); server.once('listening', bound); server.listen(0, '127.0.0.1'); await bind; current();
          endpoint = 'wss://127.0.0.1:' + server.address().port + '/owned-recovery'; const expected = new X509Certificate(fixture.server.certificatePem).fingerprint256;
          const source = createSecureWebSocketPeer({ transport: { side: 'client', endpoint, now, limits: { maxMessageBytes: 8192, reliableBufferLimit: 16384, latestBufferLimit: 8192 }, createSocket() {
            current(); const socket = new ws.WebSocket(endpoint, WSS_SUBPROTOCOL, { ca: fixture.ca, cert: fixture.clients[0].certificatePem, key: fixture.clients[0].privateKeyPem,
              minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true, perMessageDeflate: false, followRedirects: false, agent: undefined, handshakeTimeout: 3000,
              headers: { Origin: origin }, checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ?? (cert.fingerprint256 !== expected || !active(localOwner.signal) || !active(owner.signal) ? Error('Recovery native identity retired.') : undefined); },
              createConnection(options) { return track(connectTls({ ...options, path: undefined, servername: '' })); } }); return nativePort(socket, ports);
          } }, identity: identities[0], epoch, applicationId, sessionId, role: 'source', expectedRemoteKeyId: identities[1].keyId, now }); auth.push(source);
          timer = setInterval(() => auth.forEach(value => value.tick()), 5); await source.start();
          await until(() => auth.length === 2 && auth.every(value => value.peer.state === 'connected'), owner.signal); current();
          bundle.sourcePeer = source.peer; bundle.receiverPeer = auth.find(value => value !== source).peer; bundle.selection = { selectedPath: 'direct-wss', plaintextGateway: false };
        }
        current(); assert.equal(authenticatedPeerScope(bundle.sourcePeer).epoch, epoch); assert.equal(authenticatedPeerScope(bundle.receiverPeer).epoch, epoch); return bundle;
      } catch (error) { await bundle.close(); throw error; }
    }, close, snapshot() { return { paths: bundles.size, nativeSockets: rawSockets.size, issuedNativeSockets: issued, retired: !active(owner.signal) }; } };
  } catch (error) { await close(); throw error; }
}

/** Baseline uses only already implemented public SDK effects. The runner feature
 * assertion is separate, so an unavailable native producer cannot count as RED. */
export async function runMissingFeatureProducerPrefix(signal) {
  const path = await createNodeRecoveryPath('direct-wss', signal); let pair, provider, receiver, runtime, timer;
  let contact = false, position, releases = 0; const edges = [];
  try {
    pair = await path.open(); const sourceDevice = pointerSourceDescriptor('owned-node-generated-pointer');
    const sinkDevice = { ...sourceDevice, id: 'owned-recovery-prefix-target', capabilities: sourceDevice.capabilities.map(value =>
      ({ ...value, kind: value.id === 'contact' ? 'command' : 'property', permissions: [value.id === 'contact' ? 'invoke' : 'write'], ownership: { mode: 'exclusive' } })) };
    const handles = new Map(); runtime = createDeviceRuntime({ now, clockDomain: 'recovery-prefix-clock', maxRoutes: 2, maxSubscribers: 2, maxRegistrations: 4, maxPendingDeliveries: 2,
      authorize(request) { if (active(signal) && request.principalId === 'owned-recovery-target' && request.applicationId === pair.applicationId && request.sessionId === pair.sessionId &&
        request.source.deviceId === sourceDevice.id && request.sink.deviceId === sinkDevice.id && request.sink.registrationId === handles.get(request.sink.capabilityId)?.id &&
        request.sourceOperation === 'subscribe' && request.sinkOperation === (request.sink.capabilityId === 'contact' ? 'invoke' : 'write')) return { expiresAt: now() + 3000, maxAgeMs: 100, maxHz: 60 }; } });
    for (const capability of sinkDevice.capabilities) { const handle = runtime.registerSink({ device: sinkDevice, capability: capability.id,
      apply(observation, context) { if (!context.isCurrent() || !active(context.signal) || !active(signal)) return;
        if (capability.id === 'contact') { contact = observation.value; edges.push(contact); } else position = observation.value; },
      release() { if (capability.id === 'contact') contact = false; else position = undefined; releases++; } }); handles.set(capability.id, handle); runtime.setReadiness(handle, 'available'); }
    provider = new PointerResourceProvider({ peer: pair.sourcePeer, epoch: pair.epoch, clockId: 'recovery-prefix-source', now, platform: 'owned-node-generated-pointer', available: () => active(signal) });
    receiver = new RemoteResourceReceiver({ peer: pair.receiverPeer, epoch: pair.epoch, runtime, clockId: 'recovery-prefix-clock', now,
      principalId: 'owned-recovery-target', applicationId: pair.applicationId, sessionId: pair.sessionId });
    timer = setInterval(() => { provider.tick(); receiver.tick(); }, 5); await until(() => !!receiver.description(), signal);
    for (const capability of sinkDevice.capabilities) assert.ok(receiver.approve({ capability: capability.id, sink: handles.get(capability.id), sinkDevice, sinkCapability: capability.id,
      codec: capability.id === 'position' ? 'normalized-pointer/1' : 'json/1', leaseMs: 1000, grant: { expiresAt: now() + 3000, maxAgeMs: 100, maxHz: 60 } }));
    await until(() => !!provider.driver() && edges.length > 0, signal); assert.equal(edges[0], false); const explicitStart = edges.length;
    provider.driver().nudge(0.2, 0.1); provider.driver().setContact(true);
    await until(() => position && contact === true, signal); provider.driver().setContact(false); await until(() => contact === false && edges.length > explicitStart + 1, signal);
    const explicit = edges.slice(explicitStart); assert.equal(explicit[0], true); assert.equal(explicit.at(-1), false);
    await pair.disconnect(); await until(() => receiver.status().active === 0 && !position && !contact && releases >= 2, signal);
    return { nativePrefix: 'pass', actualDirectTlsAuthenticated: true, actualLatestEffect: true, initialReliableEffect: false,
      actualReliableInvokeEdges: explicit, actualAllReliableEffects: edges, actualRelease: releases, physicalInput: false };
  } finally { clearInterval(timer); provider?.stop(); receiver?.stop(); runtime?.close(); await pair?.close(); const cleanup = await path.close(); assert.equal(cleanup.nativeContexts, 0); }
}

export async function runNodeRuntimeRecoveryQualification(pathName, signal, onStage) {
  const { runRuntimeRecoveryQualification } = await import('./runtime-recovery.ts');
  const path = await createNodeRecoveryPath(pathName, signal), trials = []; let previous, currentPacket, pair;
  try {
    for (const mode of ['owner-revoke', 'lease-expiry', 'native-loss', 'recovery']) {
      pair = await path.open(); const sourceOwner = new AbortController(), sinkOwner = new AbortController(); currentPacket = undefined;
      try {
        const proof = await runRuntimeRecoveryQualification({ sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch,
          sourceOwnerSignal: sourceOwner.signal, sinkOwnerSignal: sinkOwner.signal, signal, now, mode,
          impairment: { path: pathName, disconnect: () => pair.disconnect(), close: () => pair.close(), revokeOwner: () => sinkOwner.abort(),
            remember(data) { currentPacket = data; }, replayPrevious(peer) { return previous !== undefined && peer.send('disposable', previous); },
            onStage: stage => onStage?.({ path: pathName, mode, stage }) } });
        assert.equal(proof.result, 'pass'); if (mode === 'native-loss') previous = currentPacket;
        trials.push(proof);
      } finally { sourceOwner.abort(); sinkOwner.abort(); await pair.close(); pair = undefined; }
    }
  } finally { await pair?.close(); const cleanup = await path.close(); assert.equal(cleanup.nativeContexts, 0); }
  return { result: 'pass', path: pathName, trials, actualGenerations: 4, cleanup: { nativeContexts: 0, rawWrites: 0, temporaryCredentialsRemoved: true },
    gatewayPlaintextTrust: pathName === 'authenticated-loopback-relay', sourceClock: 'recovery-source-monotonic',
    receiverClock: 'recovery-target-monotonic', originClock: 'node-performance.now', physicalInput: false, actualIpLoss: false };
}
