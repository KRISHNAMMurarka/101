import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { connect as connectTls, checkServerIdentity } from 'node:tls';
import { X509Certificate, randomBytes, createHash } from 'node:crypto';
import { existsSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createEphemeralWebIdentity, authenticatedPeerScope, createDeviceRuntime, PointerResourceProvider,
  RemoteResourceReceiver, pointerSourceDescriptor, decodePacket, encodePacket, WSS_SUBPROTOCOL } from '@101/connect';
import { createSecureWebSocketPeer } from '@101/connect/examples/secure-websocket';
import { createCoordinatorFixtures } from '../../tools/qa-https-coordinator.mjs';

const ws = createRequire(import.meta.url)('ws'), now = performance.now.bind(performance);
const origin = 'https://owned-wire-replay.example', headerBytes = 39;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener, setBytes = Uint8Array.prototype.set;
const active = signal => { try { return nativeAborted.call(signal) === false; } catch { return false; } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let fixtureReserved = false;
function bytesOf(value, limit = 4096) {
  if (typeof value === 'string') throw Error('Expected native framed binary.');
  const view = value instanceof ArrayBuffer ? new Uint8Array(value, 0, arrayLength.call(value)) : value;
  const length = typedLength.call(view); if (!Number.isSafeInteger(length) || length < headerBytes || length > limit) throw Error('Native frame size refused.');
  const result = new Uint8Array(length); setBytes.call(result, view); return result;
}
function decodeFrame(frame) {
  if (!frame || frame.length < headerBytes || frame[0] !== 49 || frame[1] !== 48 || frame[2] !== 49 || frame[3] !== 87 || frame[4] !== 1 || frame[5] > 1 || frame[6] > 1) return;
  const lane = frame[5] === 0 ? 'reliable' : 'disposable', body = frame.slice(headerBytes);
  const data = frame[6] === 0 ? new TextDecoder('utf8', { fatal: true }).decode(body) : body.buffer;
  const decoded = decodePacket(data, lane); return decoded && { ...decoded, lane };
}
function reframe(frame, packet, codec) {
  const encoded = encodePacket(packet, codec), body = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : new Uint8Array(encoded);
  if (body.length + headerBytes > 4096) throw Error('Derived frame size refused.');
  const result = new Uint8Array(headerBytes + body.length); setBytes.call(result, frame.subarray(0, headerBytes)); result[6] = typeof encoded === 'string' ? 0 : 1; setBytes.call(result, body, headerBytes); return result;
}
async function until(condition, signal, limit = 3000) {
  const deadline = now() + limit;
  while (!condition()) { if (!active(signal) || now() >= deadline) throw Error('Owned native wire wait retired.'); await new Promise(resolve => setTimeout(resolve, 5)); }
  if (!active(signal)) throw Error('Owned native wire owner retired.');
}

/** Fixed native loopback fixture; only its fresh credentials/endpoints. Captures
 * are private immutable snapshots of actual public SDK socket.send arguments.
 * Replaying them emits NEW TLS records. This is not TLS/IP ciphertext replay. */
export async function createNodeWireReplayFixture(signal) {
  if (fixtureReserved) throw Error('Wire native fixture already active.'); fixtureReserved = true;
  if (!active(signal)) { fixtureReserved = false; throw Error('Wire native signal invalid.'); }
  let fixture, deadline = Infinity, lifetime, stopping, generations = 0, issuedSockets = 0, replayAttempts = 0, captureCount = 0, pendingCallbacks = 0, peakCallbacks = 0;
  const owner = new AbortController(), pairs = new Set(), sockets = new Map(), previous = new Map(), capturedHashes = [], modes = ['baseline', 'connection-recovery', 'source-revoke', 'sink-revoke'];
  const current = () => { if (!active(signal) || !active(owner.signal) || now() >= deadline) throw Error('Wire native fixture retired.'); };
  function track(socket, pairSockets) {
    if (++issuedSockets > 128) { socket.destroy(); throw Error('Wire native socket lifetime quota.'); }
    let finish; const done = new Promise(resolve => { finish = resolve; }); sockets.set(socket, done); pairSockets?.set(socket, done);
    socket.once('close', () => { sockets.delete(socket); pairSockets?.delete(socket); finish(); });
    if (!active(owner.signal)) socket.destroy(); return socket;
  }
  function close() {
    if (stopping) return stopping; owner.abort(); clearTimeout(lifetime);
    stopping = (async () => {
      await Promise.allSettled([...pairs].map(pair => pair.close()));
      for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]);
      assert.equal(pairs.size, 0); assert.equal(sockets.size, 0); assert.equal(pendingCallbacks, 0);
      const directory = fixture?.directory; fixture?.close(); assert.ok(!directory || !existsSync(directory));
      removeEvent.call(signal, 'abort', cancelled); fixtureReserved = false;
      return { nativeContexts: 0, pendingWrites: 0, temporaryCredentialsRemoved: true, issuedNativeSockets: issuedSockets };
    })(); void stopping.catch(() => {}); return stopping;
  }
  const cancelled = () => { void close(); }; addEvent.call(signal, 'abort', cancelled, { once: true });
  try {
    fixture = createCoordinatorFixtures(); chmodSync(fixture.directory, 0o700); assert.equal(statSync(fixture.directory).mode & 0o777, 0o700);
    for (const name of ['ca', 'server', 'wrong-host', 'expired-server', 'host-a', 'host-b', 'peer-a', 'peer-b', 'other', 'unknown', 'expired-client']) {
      const path = join(fixture.directory, name + '.key'); chmodSync(path, 0o600); assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    // Fixed synchronous provisioning precedes this bounded logical native run.
    deadline = now() + 15000; lifetime = setTimeout(() => { void close(); }, 15000); current();
    return { async open(mode) {
      current(); if (!modes.includes(mode) || pairs.size || ++generations > 4) throw Error('Wire native pair quota.');
      const epoch = randomBytes(16).toString('hex'), applicationId = 'wire-replay', sessionId = 'wire-replay-' + generations;
      const localOwner = new AbortController(), identities = await Promise.all([createEphemeralWebIdentity(), createEphemeralWebIdentity()]); current();
      const ports = [], peers = [], pairSockets = new Map(), bank = new Map(), stopFrames = []; let armed, server, wss, endpoint, timer, retiring, binding, accepted = false;
      function pairCurrent() { current(); if (!active(localOwner.signal) || retiring) throw Error('Wire native pair retired.'); }
      function port(socket, direction) {
        let raw = 0, closed = false, finish; const done = new Promise(resolve => { finish = resolve; });
        function complete() { if (closed && raw === 0) { socket.removeListener('open', opened); socket.removeListener('close', ended); socket.removeListener('error', failed); socket.removeListener('message', message); finish(); } }
        function capture(data) {
          if (typeof data === 'string') return;
          const frame = bytesOf(data), decoded = decodeFrame(frame); if (!decoded) return;
          if (decoded.packet.type === 'stop') { if (stopFrames.length >= 32) throw Error('Wire stop capture quota.'); stopFrames.push({ slot: decoded.packet.slot, reason: decoded.packet.reason }); }
          if (!armed || armed.direction !== direction) return;
          const kind = decoded.packet.type === 'bind' ? 'bind' : decoded.packet.type === 'event' ? 'contact' : decoded.packet.type === 'sample' ? decoded.codec === 'normalized-pointer/1' ? 'position' : 'counter' : undefined;
          if (kind !== armed.kind) return;
          if (++captureCount > 32) throw Error('Wire captured frame lifetime quota.');
          const record = Object.freeze({ frame, digest: hash(frame), decoded, direction }); bank.set(kind, record); capturedHashes.push(record.digest); armed = undefined;
        }
        function issue(data, captureProducer) {
          pairCurrent(); if (pendingCallbacks >= 8) throw Error('Wire pending native callback quota.');
          pendingCallbacks++; raw++; peakCallbacks = Math.max(peakCallbacks, pendingCallbacks);
          let finishWrite, rejectWrite, called = false;
          const settled = new Promise((resolve, reject) => { finishWrite = resolve; rejectWrite = reject; }); void settled.catch(() => {});
          const callback = error => { if (called) return; called = true; pendingCallbacks--; raw--; complete(); if (error) { value.onerror?.({}); rejectWrite(Error('Owned native write failed.')); } else finishWrite(); };
          try { if (captureProducer) capture(data); socket.send(data, callback); } catch (error) { callback(error); throw error; }
          return settled;
        }
        const value = { get readyState() { return socket.readyState; }, get protocol() { return socket.protocol; }, get bufferedAmount() { return socket.bufferedAmount; },
          get binaryType() { return socket.binaryType; }, set binaryType(v) { socket.binaryType = v; }, onopen: null, onclose: null, onerror: null, onmessage: null,
          send(data) { void issue(data, true); }, replay(data) { return issue(data, false); }, close() { socket.terminate(); }, done, raw: () => raw, direction };
        const opened = () => value.onopen?.({}), ended = () => { closed = true; value.onclose?.({}); complete(); }, failed = () => value.onerror?.({});
        const message = (data, binary) => value.onmessage?.({ data: binary ? data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer : data.toString() });
        socket.binaryType = 'arraybuffer'; socket.on('open', opened); socket.on('close', ended); socket.on('error', failed); socket.on('message', message); ports.push(value); return value;
      }
      const pair = { epoch, applicationId, sessionId,
        sourcePeer: /** @type {import('@101/connect').ResourcePeer | undefined} */ (undefined),
        receiverPeer: /** @type {import('@101/connect').ResourcePeer | undefined} */ (undefined),
        close() {
          if (retiring) return retiring; localOwner.abort(); clearInterval(timer); peers.forEach(peer => peer.stop()); ports.forEach(value => value.close());
          retiring = (async () => {
            if (binding) await binding.catch(() => {}); for (const socket of pairSockets.keys()) socket.destroy();
            await Promise.all(ports.map(value => value.done)); await Promise.all([...pairSockets.values()]);
            if (wss) await new Promise(resolve => wss.close(resolve)); if (server?.listening) await new Promise(resolve => server.close(resolve));
            for (const [kind, record] of bank) previous.set(kind, record); assert.equal(pairSockets.size, 0); assert.equal(ports.reduce((total, value) => total + value.raw(), 0), 0); pairs.delete(pair);
          })(); void retiring.catch(() => {}); return retiring;
        },
        arm(kind) { pairCurrent(); if (!['position', 'contact', 'counter', 'bind'].includes(kind) || armed) throw Error('Wire arm invalid.'); armed = { kind, direction: kind === 'bind' ? 'receiver' : 'source' }; },
        captured(kind) { const record = bank.get(kind); return record && { sha256: record.digest, bytes: record.frame.length, codec: record.decoded.codec, sequence: record.decoded.packet.sequence }; },
        snapshot() { return { nativeSockets: pairSockets.size, pendingNativeCallbacks: ports.reduce((total, value) => total + value.raw(), 0), stopFrames: stopFrames.slice() }; },
        /** @returns {import('./wire-replay.ts').WireReplayBoundary} */
        boundary(sourceOwner, sinkOwner) {
          return { path: 'direct-wss', scenario: mode, arm: kind => pair.arm(kind), captured: kind => pair.captured(kind),
            async replay(kind, mutation) {
              pairCurrent(); if (++replayAttempts > 64) throw Error('Wire replay attempt lifetime quota.');
              const old = mutation === 'old-connection' || mutation === 'old-epoch', record = (old ? previous : bank).get(kind);
              if (!record || hash(record.frame) !== record.digest) throw Error('Wire capture missing or mutated.');
              let frame = bytesOf(record.frame); const packet = record.decoded.packet;
              if (mutation === 'lower-sequence') frame = reframe(frame, { ...packet, sequence: Math.max(1, packet.sequence - 1), capturedAt: now() }, record.decoded.codec);
              else if (mutation === 'old-operation') { const capturedAt = now(); frame = reframe(frame, { ...packet, sequence: packet.sequence + 1, capturedAt, deadline: capturedAt + 100 }, record.decoded.codec); }
              else if (mutation === 'wrong-profile') { if (record.decoded.codec !== 'normalized-pointer/1') throw Error('Wire profile fixture wrong.');
                frame = reframe(frame, { ...packet, sequence: packet.sequence + 100, capturedAt: now() }, record.decoded.codec); frame[headerBytes + 3] = 2; }
              else if (mutation === 'wrong-codec') frame = reframe(frame, { ...packet, sequence: packet.sequence + 100, capturedAt: now() }, 'json/1');
              else if (mutation === 'schema' || mutation === 'descriptor') frame = reframe(frame, { ...packet, slot: mutation === 'schema' ? 126 : 125,
                ...(mutation === 'schema' ? { schemaVersion: packet.schemaVersion + 1 } : { descriptorRevision: packet.descriptorRevision + 1 }) }, 'json/1');
              else if (mutation === 'expired-capture') frame = reframe(frame, { ...packet, sequence: packet.sequence + 100 }, record.decoded.codec);
              else if (mutation === 'expired-deadline') { const capturedAt = now() - 20;
                frame = reframe(frame, { ...packet, sequence: packet.sequence + 100, operationId: String(Number(packet.operationId) + 100), capturedAt, deadline: capturedAt + 10 }, record.decoded.codec); }
              else if (mutation === 'late-sequence') { const capturedAt = now();
                frame = reframe(frame, { ...packet, sequence: packet.sequence + 100, capturedAt,
                  ...(packet.type === 'event' ? { operationId: String(Number(packet.operationId) + 100), deadline: capturedAt + 100 } : {}) }, record.decoded.codec); }
              else if (mutation === 'old-epoch') {
                const currentRecord = bank.get(kind); if (!currentRecord) throw Error('Wire current envelope missing.');
                frame = reframe(frame, { ...packet, sequence: packet.sequence + 100, capturedAt: now() }, record.decoded.codec);
                setBytes.call(frame, currentRecord.frame.subarray(0, headerBytes));
              } else if (mutation !== 'unchanged' && mutation !== 'old-connection') throw Error('Wire mutation invalid.');
              const direction = kind === 'bind' ? 'receiver' : 'source', selected = ports.find(value => value.direction === direction);
              if (!selected) throw Error('Wire native sender missing.'); const sentHash = hash(frame);
              await selected.replay(frame); pairCurrent(); assert.equal(hash(record.frame), record.digest); assert.equal(hash(frame), sentHash);
              return { admitted: true, unchanged: mutation === 'unchanged' || mutation === 'old-connection', sha256: sentHash, bytes: frame.length };
            }, revoke(role) { if (role === 'source') sourceOwner.abort(); else if (role === 'sink') sinkOwner.abort(); else throw Error('Wire owner invalid.'); },
            close: () => pair.close(), snapshot: () => pair.snapshot() };
        } };
      pairs.add(pair);
      try {
        server = createServer({ cert: fixture.server.certificatePem, key: fixture.server.privateKeyPem, ca: fixture.ca, requestCert: true,
          rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }); server.maxConnections = 8;
        server.on('connection', socket => track(socket, pairSockets));
        wss = new ws.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8192 });
        const clientPin = new X509Certificate(fixture.clients[0].certificatePem).fingerprint256;
        server.on('upgrade', (request, socket, head) => {
          if (!active(localOwner.signal) || !active(owner.signal) || !active(signal) || now() >= deadline || accepted || request.url !== '/owned-wire-replay' ||
            !request.socket.authorized || request.socket.getProtocol() !== 'TLSv1.3' || request.socket.getPeerCertificate().fingerprint256 !== clientPin ||
            request.headers.origin !== origin || request.headers['sec-websocket-protocol'] !== WSS_SUBPROTOCOL) { socket.destroy(); return; }
          accepted = true;
          wss.handleUpgrade(request, socket, head, socket => {
            if (!active(localOwner.signal) || !active(owner.signal) || !active(signal)) { socket.terminate(); return; }
            const receiver = createSecureWebSocketPeer({ transport: { side: 'server', socket: port(socket, 'receiver'), endpoint, now,
              limits: { maxMessageBytes: 4096, reliableBufferLimit: 8192, latestBufferLimit: 4096 } }, identity: identities[1], epoch, applicationId, sessionId,
              role: 'receiver', expectedRemoteKeyId: identities[0].keyId, now }); peers.push(receiver); void receiver.start();
          });
        });
        binding = new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); }); void binding.catch(() => {});
        pairCurrent(); server.listen(0, '127.0.0.1'); await binding; pairCurrent(); endpoint = 'wss://127.0.0.1:' + server.address().port + '/owned-wire-replay';
        const serverPin = new X509Certificate(fixture.server.certificatePem).fingerprint256;
        const source = createSecureWebSocketPeer({ transport: { side: 'client', endpoint, now,
          limits: { maxMessageBytes: 4096, reliableBufferLimit: 8192, latestBufferLimit: 4096 }, createSocket() {
            pairCurrent(); const socket = new ws.WebSocket(endpoint, WSS_SUBPROTOCOL, { ca: fixture.ca, cert: fixture.clients[0].certificatePem, key: fixture.clients[0].privateKeyPem,
              minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true, perMessageDeflate: false, followRedirects: false, agent: undefined, handshakeTimeout: 3000,
              headers: { Origin: origin }, checkServerIdentity(host, cert) {
                return checkServerIdentity(host, cert) ?? (cert.fingerprint256 !== serverPin || !active(localOwner.signal) || !active(owner.signal) || !active(signal) || now() >= deadline ? Error('Owned wire server identity retired.') : undefined);
              }, createConnection(options) { pairCurrent(); return track(connectTls({ ...options, path: undefined, servername: '' }), pairSockets); } });
            return port(socket, 'source');
          } }, identity: identities[0], epoch, applicationId, sessionId, role: 'source', expectedRemoteKeyId: identities[1].keyId, now });
        peers.push(source); timer = setInterval(() => peers.forEach(peer => peer.tick()), 5); await source.start(); pairCurrent();
        await until(() => peers.length === 2 && peers.every(value => !!authenticatedPeerScope(value.peer)), localOwner.signal);
        pair.sourcePeer = source.peer; pair.receiverPeer = peers.find(value => value !== source).peer; pairCurrent(); return pair;
      } catch (error) { await pair.close(); throw error; }
    }, close, snapshot() { return { nativeSockets: sockets.size, pairs: pairs.size, captureCount, replayAttempts, pendingNativeCallbacks: pendingCallbacks,
      peakPendingNativeCallbacks: peakCallbacks, capturedHashes: capturedHashes.slice(), issuedNativeSockets: issuedSockets }; } };
  } catch (error) { await close(); throw error; }
}

/** Genuine native feature-prefix control, independent of the new runner leaf. */
export async function runWireReplayProducerPrefix(signal) {
  const fixture = await createNodeWireReplayFixture(signal); let pair, runtime, provider, receiver, timer; const effects = []; let contact = false;
  try {
    pair = await fixture.open('baseline'); const source = pointerSourceDescriptor('owned-software-wire-prefix'), handles = new Map();
    const sink = { ...source, id: 'owned-wire-prefix-target', capabilities: source.capabilities.map(capability => ({ ...capability,
      kind: capability.id === 'contact' ? 'command' : 'property', permissions: [capability.id === 'contact' ? 'invoke' : 'write'], ownership: { mode: 'exclusive' } })) };
    runtime = createDeviceRuntime({ now, clockDomain: 'wire-prefix-target', maxRoutes: 2, maxRegistrations: 4, maxSubscribers: 2, maxPendingDeliveries: 2,
      authorize(request) { if (active(signal) && request.principalId === sink.id && request.applicationId === pair.applicationId && request.sessionId === pair.sessionId &&
        request.source.deviceId === source.id && request.source.descriptorRevision === 1 && request.source.schemaVersion === 1 && request.sink.deviceId === sink.id &&
        request.sink.registrationId === handles.get(request.sink.capabilityId)?.id && request.source.capabilityId === request.sink.capabilityId &&
        request.sourceOperation === 'subscribe' && request.sinkOperation === (request.sink.capabilityId === 'contact' ? 'invoke' : 'write')) return { expiresAt: now() + 3000, maxAgeMs: 100, maxHz: 60 }; } });
    for (const capability of sink.capabilities) { const handle = runtime.registerSink({ device: sink, capability: capability.id,
      apply(observation, context) { if (!context.isCurrent() || !active(context.signal) || !active(signal)) return;
        if (capability.id === 'contact') { contact = observation.value; effects.push(contact); } }, release() { if (capability.id === 'contact') contact = false; } }); handles.set(capability.id, handle); runtime.setReadiness(handle, 'available'); }
    provider = new PointerResourceProvider({ peer: pair.sourcePeer, epoch: pair.epoch, clockId: 'wire-prefix-source', now, platform: 'owned-software-wire-prefix', available: () => active(signal) });
    receiver = new RemoteResourceReceiver({ peer: pair.receiverPeer, epoch: pair.epoch, runtime, clockId: 'wire-prefix-target', now, principalId: sink.id, applicationId: pair.applicationId, sessionId: pair.sessionId });
    timer = setInterval(() => { provider.tick(); receiver.tick(); }, 5); await until(() => !!receiver.description() && receiver.status().clockReady, signal);
    for (const capability of sink.capabilities) assert.ok(receiver.approve({ capability: capability.id, sink: handles.get(capability.id), sinkDevice: sink, sinkCapability: capability.id,
      codec: capability.id === 'contact' ? 'json/1' : 'normalized-pointer/1', leaseMs: 1000, grant: { expiresAt: now() + 3000, maxAgeMs: 100, maxHz: 60 } }));
    await until(() => !!provider.driver() && effects.length > 0, signal); const baseline = effects.length;
    pair.arm('contact'); provider.driver().setContact(true); await until(() => contact && !!pair.captured('contact'), signal);
    provider.driver().setContact(false); await until(() => !contact && effects.length === baseline + 2, signal);
    const capture = pair.captured('contact'); assert.deepEqual(effects.slice(baseline), [true, false]);
    return { result: 'pass', actualDirectWssAuthenticated: true, actualReliableEffects: effects.slice(baseline), capturedNativeFrame: true,
      nativeFrameSha256: capture.sha256, nativeFrameBytes: capture.bytes, tlsCiphertextReplay: false, physicalQualification: false };
  } finally { clearInterval(timer); provider?.stop(); receiver?.stop(); runtime?.close(); await pair?.close(); const cleanup = await fixture.close(); assert.equal(cleanup.nativeContexts, 0); }
}

export async function runNodeWireReplayQualification(signal) {
  const { runWireReplayQualification, WIRE_REPLAY_PROFILE } = await import('./wire-replay.ts');
  const fixture = await createNodeWireReplayFixture(signal), trials = []; let pair, cleanup, snapshot;
  try {
    // Each retirement is followed by actual new identities/epoch/owner approvals.
    // The final recovery pair covers the preceding sink revocation as well.
    for (const mode of ['baseline', 'source-revoke', 'sink-revoke', 'connection-recovery']) {
      pair = await fixture.open(mode); const sourceOwner = new AbortController(), sinkOwner = new AbortController();
      try { trials.push(await runWireReplayQualification({ sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch,
        sourceOwnerSignal: sourceOwner.signal, sinkOwnerSignal: sinkOwner.signal, signal, now, boundary: pair.boundary(sourceOwner, sinkOwner) })); }
      finally { sourceOwner.abort(); sinkOwner.abort(); await pair.close(); pair = undefined; }
    }
  } finally { await pair?.close(); snapshot = fixture.snapshot(); cleanup = await fixture.close(); }
  const checks = trials.flatMap(trial => trial.checks); assert.ok(checks.length <= 32);
  const result = { result: 'pass', profile: WIRE_REPLAY_PROFILE, trials, checks, actualGenerations: trials.length, captureCount: snapshot.captureCount,
    replayAttempts: snapshot.replayAttempts, peakPendingNativeCallbacks: snapshot.peakPendingNativeCallbacks, capturedNativeFrameHashes: snapshot.capturedHashes,
    cleanup, applicationFrameReplay: true, tlsCiphertextReplay: false, actualIpLoss: false, physicalQualification: false,
    sourceClock: 'wire-source-performance', targetClock: 'wire-target-performance', installedHubClaim: false };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384); return result;
}
