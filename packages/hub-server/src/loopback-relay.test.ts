import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import { channel } from 'node:diagnostics_channel';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
interface NativeSocket extends EventEmitter { send(bytes:Uint8Array, options?:{binary:boolean}):void;terminate():void }
interface NativeServer extends EventEmitter { readonly clients:Set<NativeSocket>;close(done:()=>void):void; handleUpgrade(request:IncomingMessage, socket:Duplex, head:Buffer, callback:(native:NativeSocket)=>void):void }
const {WebSocket,WebSocketServer}=createRequire(import.meta.url)('ws') as {
 WebSocket:new(endpoint:string,options:object)=>NativeSocket;WebSocketServer:new(options:object)=>NativeServer;
};
import type { AuthenticatedRelayClient } from './loopback-relay.ts';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';

/** Missing-feature RED follows a real encrypted native producer exchange. */
test('actual native TLS WSS bytes require an explicit scoped relay allocator', async () => {
  const fixture = createCoordinatorFixtures(), rawSockets = new Set<TLSSocket>();
  const server = createServer({ cert: fixture.server.certificatePem, key: fixture.server.privateKeyPem,
    ca: fixture.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 8192 });
  server.on('secureConnection', socket => rawSockets.add(socket));
  wss.on('connection', (socket:NativeSocket) => socket.on('message', (bytes:Uint8Array, binary:boolean) => socket.send(bytes, { binary })));
  let client: NativeSocket | undefined;
  try {
    const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const owner = fixture.clients[0]!;
    client = new WebSocket('wss://127.0.0.1:' + address.port, { ca: fixture.ca, cert: owner.certificatePem,
      key: owner.privateKeyPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true, perMessageDeflate: false });
    await once(client, 'open'); const effect = once(client, 'message'); client.send(Buffer.from([49, 48, 49, 7]));
    const [bytes, binary] = await effect; assert.equal(binary, true); assert.deepEqual(bytes, Buffer.from([49, 48, 49, 7]));
    const authenticated = [...rawSockets][0]!; assert.equal(authenticated.authorized, true); assert.equal(authenticated.getProtocol(), 'TLSv1.3');
    let relay: typeof import('./loopback-relay.ts') | undefined;
    try { relay = await import('./loopback-relay.ts'); } catch { /* Absence is the intended feature regression. */ }
    assert.equal(typeof relay?.createAuthenticatedLoopbackRelay, 'function', 'Native encrypted WSS exists; scoped allocator/provider is missing');
  } finally {
    client?.terminate(); for (const socket of wss.clients) socket.terminate(); for (const socket of rawSockets) socket.destroy();
    await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
    fixture.close();
  }
});

test('two separately enrolled native TLS legs select a trusted gateway and forward authenticated bytes', async () => {
  const sdk = await import('@101/connect'), relay = await import('./loopback-relay.ts');
  const fixture = createCoordinatorFixtures(), identities = await Promise.all([sdk.createEphemeralWebIdentity(), sdk.createEphemeralWebIdentity()]);
  const owner = new AbortController(), sourceOwner = new AbortController(), receiverOwner = new AbortController();
  const credentials = [fixture.clients[0]!, fixture.clients[2]!];
  const gateway = relay.createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, origin: 'https://relay-ui.example', signal: owner.signal,
    enrollments: credentials.map((value, index) => ({ ...value, endpointKeyId: identities[index]!.keyId })).map(({ principalId, deviceId, certificatePem, endpointKeyId }) => ({ principalId, deviceId, certificatePem, endpointKeyId })) });
  const clients: AuthenticatedRelayClient[] = [];
  try {
    await gateway.start();
    const ticket = gateway.issuePair({ selectedPath: 'authenticated-loopback-relay', applicationId: 'load-app', sessionId: 'load-session', epoch: '1'.repeat(32),
      sourcePrincipalId: credentials[0]!.principalId, receiverPrincipalId: credentials[1]!.principalId, ttlMs: 5000 }, request => ({ request, expiresAt: request.expiresAt,
      signal: request.role === 'source' ? sourceOwner.signal : receiverOwner.signal }));
    const connect = (index: number) => relay.connectAuthenticatedRelay({ credential: index === 0 ? ticket.source : ticket.receiver, caCertificatePem: fixture.ca,
      certificatePem: credentials[index]!.certificatePem, privateKeyPem: credentials[index]!.privateKeyPem, identity: identities[index]!, signal: owner.signal });
    const receiverOpening = connect(1); await new Promise(resolve => setTimeout(resolve, 30)); const sourceOpening = connect(0);
    const [receiver, source] = await Promise.all([receiverOpening, sourceOpening]); clients.push(receiver, source);
    let received = ''; const detach = receiver.peer.onData((_lane, data) => { if (typeof data === 'string') received = data; });
    assert.equal(source.selectedPath, 'authenticated-loopback-relay'); assert.equal(source.peer.send('reliable', 'owned state=7'), true);
    for (let index = 0; index < 100 && !received; index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(received, 'owned state=7'); assert.ok(sdk.authenticatedPeerScope(source.peer)); assert.ok(sdk.authenticatedPeerScope(receiver.peer)); detach();
    sourceOwner.abort(); await gateway.revokePair(ticket.pairId);
    for (let index = 0; index < 100 && source.status().active; index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(source.status().active, false); assert.equal(gateway.snapshot().pairs, 0);
  } finally { owner.abort(); await Promise.all(clients.map(client => client.stop())); await gateway.stop(); fixture.close(); }
});

async function rig() {
  const sdk = await import('@101/connect'), relay = await import('./loopback-relay.ts'), fixture = createCoordinatorFixtures();
  const identities = await Promise.all(Array.from({ length: 4 }, () => sdk.createEphemeralWebIdentity()));
  const certificates = [fixture.clients[0]!, fixture.clients[2]!, fixture.clients[1]!, fixture.clients[3]!];
  const owner = new AbortController(), grants: AbortController[] = [], clients: AuthenticatedRelayClient[] = [];
  const opening: Promise<AuthenticatedRelayClient>[] = [];
  const gateway = relay.createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, origin: 'https://relay-ui.example', signal: owner.signal,
    enrollments: certificates.map((value, index) => ({ principalId: value.principalId, deviceId: value.deviceId, certificatePem: value.certificatePem, endpointKeyId: identities[index]!.keyId })) });
  await gateway.start();
  const request = (offset = 0, ttlMs = 4000) => ({ selectedPath: 'authenticated-loopback-relay' as const, applicationId: 'relay-test', sessionId: 'session-' + offset,
    epoch: String(offset + 1).repeat(32), sourcePrincipalId: certificates[offset]!.principalId, receiverPrincipalId: certificates[offset + 1]!.principalId, ttlMs });
  function issue(offset = 0, ttlMs = 4000) {
    const source = new AbortController(), receiver = new AbortController(); grants.push(source, receiver);
    const ticket = gateway.issuePair(request(offset, ttlMs), request => ({ request, expiresAt: request.expiresAt, signal: (request.role === 'source' ? source : receiver).signal }));
    return { ticket, source, receiver };
  }
  function connect(credential: import('./loopback-relay.ts').RelayCredential, index: number, signal = owner.signal) {
    const pending = relay.connectAuthenticatedRelay({ credential, caCertificatePem: fixture.ca, certificatePem: certificates[index]!.certificatePem,
      privateKeyPem: certificates[index]!.privateKeyPem, identity: identities[index]!, signal });
    opening.push(pending); void pending.then(value => clients.push(value), () => {}); return pending;
  }
  async function pair(offset = 0, ttlMs = 4000) { const issued = issue(offset, ttlMs); const values = await Promise.all([connect(issued.ticket.source, offset), connect(issued.ticket.receiver, offset + 1)]); return { ...issued, sourceClient: values[0]!, receiverClient: values[1]! }; }
  async function close() { owner.abort(); grants.forEach(value => value.abort()); await Promise.allSettled(opening); await Promise.all(clients.map(value => value.stop())); await gateway.stop(); fixture.close(); }
  return { relay, sdk, fixture, certificates, identities, gateway, request, issue, pair, connect, owner, close };
}
async function until(test: () => boolean, timeout = 1500) { const deadline = performance.now() + timeout; while (!test() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(test(), true); }

test('credential replay, certificate substitution, exact epoch scope and revocation fail closed', async () => {
  const fixture = await rig();
  try {
    const first = await fixture.pair();
    assert.equal(first.sourceClient.selection.plaintextGateway, true); assert.equal(first.sourceClient.selection.epoch, first.ticket.source.epoch);
    assert.match(first.sourceClient.selection.transcriptDigest, /^[a-f0-9]{64}$/);
    await assert.rejects(fixture.connect(first.ticket.source, 0));
    assert.equal(first.sourceClient.status().active, true, 'replay must not retire incumbent');
    const fresh = fixture.issue(2);
    await assert.rejects(fixture.connect(fresh.ticket.source, 0), 'wrong native certificate is denied before endpoint authorization');
    const wrongScope = fixture.connect({ ...fresh.ticket.source, sessionId: 'foreign-scope' }, 2);
    const receiver = fixture.connect(fresh.ticket.receiver, 3);
    await assert.rejects(wrongScope); await assert.rejects(receiver);
    assert.equal(first.sourceClient.status().active, true, 'foreign scope must not retire unrelated pair');
    first.receiver.abort(); await fixture.gateway.revokePair(first.ticket.pairId); await until(() => !first.sourceClient.status().active);
    await assert.rejects(fixture.connect(first.ticket.receiver, 1));
  } finally { await fixture.close(); }
});

test('approval reserves allocation before callouts and final native owner signals defeat cross revocation', async () => {
  const fixture = await rig();
  try {
    const source = new AbortController(), receiver = new AbortController(); let reentries = 0;
    assert.throws(() => fixture.gateway.issuePair(fixture.request(), request => {
      if (request.role === 'source') { assert.throws(() => fixture.gateway.issuePair(fixture.request(2), () => undefined)); reentries++; }
      else source.abort();
      return { request, expiresAt: request.expiresAt, signal: (request.role === 'source' ? source : receiver).signal };
    }));
    assert.equal(reentries, 1); assert.equal(fixture.gateway.snapshot().pairs, 0); assert.equal(fixture.gateway.snapshot().allocating, false);
    assert.throws(() => fixture.gateway.issuePair(fixture.request(), request => ({ request: { ...request }, expiresAt: request.expiresAt, signal: receiver.signal })));
    const spoof = new AbortController(); spoof.abort(); Object.defineProperty(spoof.signal, 'aborted', { value: false });
    assert.throws(() => fixture.gateway.issuePair(fixture.request(), request => ({ request, expiresAt: request.expiresAt, signal: spoof.signal })));
    const connected = await fixture.pair(); assert.equal(connected.sourceClient.status().active, true);
    assert.throws(() => fixture.gateway.issuePair(fixture.request(), () => undefined), 'live exact tuple is reserved');
  } finally { await fixture.close(); }
});

test('real issued write callback remains reserved through retire while another exact pair progresses', async () => {
  const fixture = await rig(), native = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeSocket & { _isServer?: boolean } } };
  const original = native.WebSocket.prototype.send; let held: (() => void) | undefined, settled = false;
  try {
    const blocked = await fixture.pair(), unrelated = await fixture.pair(2);
    native.WebSocket.prototype.send = function(data: Uint8Array, options?: { binary: boolean }, callback?: (error?: Error) => void) {
      const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
      if ((this as NativeSocket & { _isServer?: boolean })._isServer && bytes.includes(Buffer.from('held-native')) && callback && !held) {
        return (original as unknown as (this: NativeSocket, data: Uint8Array, options: object | undefined, callback: (error?: Error) => void) => void).call(this, data, options, error => { held = () => callback(error); });
      }
      return (original as unknown as (this: NativeSocket, data: Uint8Array, options: object | undefined, callback?: (error?: Error) => void) => void).call(this, data, options, callback);
    };
    assert.equal(blocked.sourceClient.peer.send('reliable', 'held-native'), true); await until(() => !!held);
    blocked.source.abort(); const retirement = fixture.gateway.revokePair(blocked.ticket.pairId).then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false); assert.equal(fixture.gateway.snapshot().pairs, 2); assert.equal(fixture.gateway.snapshot().pendingRaw, 1);
    let value = ''; const detach = unrelated.receiverClient.peer.onData((_lane, data) => { if (typeof data === 'string') value = data; });
    assert.equal(unrelated.sourceClient.peer.send('reliable', 'other-scope-current'), true); await until(() => value === 'other-scope-current'); detach();
    held!(); held = undefined; await retirement; assert.equal(fixture.gateway.snapshot().pairs, 1); assert.equal(fixture.gateway.snapshot().pendingRaw, 0);
  } finally { native.WebSocket.prototype.send = original; held?.(); await fixture.close(); }
});

test('credential expiry and owner stop close native resources and forbid restarting retired identity', async () => {
  const fixture = await rig();
  try {
    const pair = await fixture.pair(0, 500); await until(() => !pair.sourceClient.status().active && fixture.gateway.snapshot().pairs === 0);
    await assert.rejects(fixture.connect(pair.ticket.source, 0)); await fixture.gateway.stop();
    const snapshot = fixture.gateway.snapshot(); assert.equal(snapshot.phase, 'stopped'); assert.equal(snapshot.nativeConnections, 0); assert.equal(snapshot.pendingRaw, 0); assert.equal(snapshot.timers, 0);
    await assert.rejects(fixture.gateway.start());
    assert.equal(JSON.stringify(snapshot).includes(pair.ticket.source.token), false); assert.equal(JSON.stringify(snapshot).includes('PRIVATE KEY'), false);
  } finally { await fixture.close(); }
});

test('slow native recipient and held callback are bounded to its pair without starving a second pair', async () => {
  const fixture = await rig(), native = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeSocket & { _isServer?: boolean } } };
  const original = native.WebSocket.prototype.send; let recipient: (NativeSocket & { pause(): void; resume(): void }) | undefined, held: (() => void) | undefined;
  try {
    const slow = await fixture.pair(), independent = await fixture.pair(2);
    native.WebSocket.prototype.send = function(data: Uint8Array, options?: { binary: boolean }, callback?: (error?: Error) => void) {
      const bytes = Buffer.from(data);
      if (!(this as NativeSocket & { _isServer?: boolean })._isServer && bytes.includes(Buffer.from('capture-recipient'))) recipient = this as NativeSocket & { pause(): void; resume(): void };
      const call = original as unknown as (this: NativeSocket, data: Uint8Array, options: object | undefined, callback?: (error?: Error) => void) => void;
      if ((this as NativeSocket & { _isServer?: boolean })._isServer && bytes.includes(Buffer.from('slow-pressure')) && callback && !held) return call.call(this, data, options, error => { held = () => callback(error); });
      return call.call(this, data, options, callback);
    };
    assert.equal(slow.receiverClient.peer.send('reliable', 'capture-recipient'), true); await until(() => !!recipient); recipient!.pause();
    const payload = 'slow-pressure' + 'x'.repeat(3000); assert.equal(slow.sourceClient.peer.send('reliable', payload), true); await until(() => !!held);
    let observedQueue = 0;
    for (let index = 0; index < 12 && slow.sourceClient.status().active; index++) {
      slow.sourceClient.peer.send('reliable', payload); await new Promise(resolve => setTimeout(resolve, 5)); observedQueue = Math.max(observedQueue, fixture.gateway.snapshot().queuedMessages);
      assert.ok(fixture.gateway.snapshot().queuedMessages <= 4); assert.ok(fixture.gateway.snapshot().queuedBytes <= 16384);
    }
    await until(() => !slow.sourceClient.status().active); assert.ok(observedQueue > 0); assert.equal(fixture.gateway.snapshot().pendingRaw, 1);
    let received = ''; const detach = independent.receiverClient.peer.onData((_lane, data) => { if (typeof data === 'string') received = data; });
    assert.equal(independent.sourceClient.peer.send('reliable', 'independent-current'), true); await until(() => received === 'independent-current'); detach();
    recipient!.resume(); held!(); held = undefined; await fixture.gateway.revokePair(slow.ticket.pairId);
    assert.equal(independent.sourceClient.status().active, true); assert.equal(fixture.gateway.snapshot().pairs, 1);
  } finally { native.WebSocket.prototype.send = original; recipient?.resume(); held?.(); await fixture.close(); }
});

test('abort during actual start cannot return a listener or resurrect its owner', async () => {
  const relay = await import('./loopback-relay.ts'), sdk = await import('@101/connect'), fixture = createCoordinatorFixtures();
  const identities = await Promise.all([sdk.createEphemeralWebIdentity(), sdk.createEphemeralWebIdentity()]), owner = new AbortController();
  const gateway = relay.createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, origin: 'https://owned.example', signal: owner.signal, enrollments: [fixture.clients[0]!, fixture.clients[2]!].map((value, index) =>
      ({ principalId: value.principalId, deviceId: value.deviceId, certificatePem: value.certificatePem, endpointKeyId: identities[index]!.keyId })) });
  try { const starting = gateway.start(); owner.abort(); await assert.rejects(starting); await gateway.stop(); await assert.rejects(gateway.start());
    const state = gateway.snapshot(); assert.equal(state.phase, 'stopped'); assert.equal(state.nativeConnections, 0); assert.equal(state.timers, 0); assert.equal(state.endpoint, undefined);
  } finally { await gateway.stop(); fixture.close(); }
});


test('actual native origin and certificate substitution deny without consuming the valid ticket; fresh gateway drops old bearer', async () => {
  const setup = await rig(), Native = createRequire(import.meta.url)('ws') as { WebSocket: new (url: string, protocol: string, options: object) => NativeSocket };
  const sockets: NativeSocket[] = []; let replacement: ReturnType<typeof setup.relay.createAuthenticatedLoopbackRelay> | undefined;
  const raw = async (credential: import('./loopback-relay.ts').RelayCredential, index: number | undefined, origin = credential.origin) => {
    const cert = index === undefined ? undefined : setup.certificates[index]!;
    const socket = new Native.WebSocket(credential.endpoint, setup.sdk.WSS_SUBPROTOCOL, { ca: setup.fixture.ca, cert: cert?.certificatePem, key: cert?.privateKeyPem,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true, followRedirects: false, perMessageDeflate: false, handshakeTimeout: 1000,
      headers: { Origin: origin, Authorization: 'Bearer ' + credential.token } }); sockets.push(socket);
    let opened = false; socket.on('open', () => { opened = true; socket.terminate(); }); socket.on('error', () => {}); await new Promise<void>(resolve => socket.once('close', () => resolve())); return opened;
  };
  try {
    const issued = setup.issue();
    assert.equal(await raw(issued.ticket.source, 0, 'https://foreign.example'), false);
    assert.equal(await raw(issued.ticket.source, 2), false); assert.equal(await raw(issued.ticket.source, undefined), false);
    const [source, receiver] = await Promise.all([setup.connect(issued.ticket.source, 0), setup.connect(issued.ticket.receiver, 1)]);
    assert.equal(source.status().active, true); assert.equal(receiver.status().active, true);
    await setup.gateway.stop(); await Promise.all([source.stop(), receiver.stop()]);
    replacement = setup.relay.createAuthenticatedLoopbackRelay({ serverCertificatePem: setup.fixture.server.certificatePem, serverPrivateKeyPem: setup.fixture.server.privateKeyPem,
      clientCaCertificatePem: setup.fixture.ca, origin: 'https://relay-ui.example', signal: setup.owner.signal, enrollments: setup.certificates.map((value, index) =>
        ({ principalId: value.principalId, deviceId: value.deviceId, certificatePem: value.certificatePem, endpointKeyId: setup.identities[index]!.keyId })) });
    const endpoint = await replacement.start(), grants = new AbortController();
    const fresh = replacement.issuePair(setup.request(), request => ({ request, expiresAt: request.expiresAt, signal: grants.signal }));
    assert.notEqual(fresh.source.gatewayKeyId, issued.ticket.source.gatewayKeyId); assert.notEqual(fresh.source.token, issued.ticket.source.token);
    assert.equal(await raw({ ...issued.ticket.source, endpoint }, 0), false, 'fresh actual gateway admits no prior bearer');
    const freshClients = await Promise.all([setup.connect(fresh.source, 0), setup.connect(fresh.receiver, 1)]);
    assert.equal(freshClients[0]!.status().active, true); assert.equal(freshClients[1]!.status().active, true);
    grants.abort(); await replacement.stop(); await Promise.all(freshClients.map(value => value.stop()));
  } finally { sockets.forEach(value => value.terminate()); await replacement?.stop(); await setup.close(); }
});

test('public path is not exposed before both actual gateway authentication finishes settle', async () => {
  const fixture = await rig(), native = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeSocket & { _isServer?: boolean } } };
  const original = native.WebSocket.prototype.send; const receiverNatives = new WeakSet<NativeSocket>(); let release: (() => void) | undefined;
  let receiverReady = false, sourceReady = false;
  try {
    native.WebSocket.prototype.send = function(data: Uint8Array, options?: { binary: boolean }, callback?: (error?: Error) => void) {
      const bytes = Buffer.from(data), server = (this as NativeSocket & { _isServer?: boolean })._isServer;
      if (!server && bytes.includes(Buffer.from('"role":"receiver"'))) receiverNatives.add(this);
      const call = () => (original as unknown as (this: NativeSocket, data: Uint8Array, options: object | undefined, callback?: (error?: Error) => void) => void).call(this, data, options, callback);
      if (receiverNatives.has(this) && bytes.includes(Buffer.from('"type":"finish"')) && !release) { release = call; return; }
      call();
    };
    const ticket = fixture.issue(); const receiver = fixture.connect(ticket.ticket.receiver, 1).then(client => { receiverReady = true; return client; });
    await new Promise(resolve => setTimeout(resolve, 20)); const source = fixture.connect(ticket.ticket.source, 0).then(client => { sourceReady = true; return client; });
    void receiver.catch(() => {}); void source.catch(() => {}); await until(() => !!release); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(receiverReady, false, 'own authenticated leg is not a fully selected two-leg path'); assert.equal(sourceReady, false);
    release!(); release = undefined; const values = await Promise.all([source, receiver]);
    let result = ''; const detach = values[1].peer.onData((_lane, data) => { if (typeof data === 'string') result = data; });
    assert.equal(values[0].peer.send('reliable', 'first-effect-after-full-path'), true); await until(() => result === 'first-effect-after-full-path'); detach();
  } finally { native.WebSocket.prototype.send = original; release?.(); await fixture.close(); }
});


test('missing role expires without exposing a peer or preserving a reusable credential', async () => {
  const fixture = await rig();
  try { const issued = fixture.issue(0, 500); let exposed = false;
    const pending = fixture.connect(issued.ticket.source, 0).then(value => { exposed = true; return value; });
    await assert.rejects(pending); assert.equal(exposed, false); await fixture.gateway.revokePair(issued.ticket.pairId);
    assert.equal(fixture.gateway.snapshot().pairs, 0); assert.equal(fixture.gateway.snapshot().pendingRaw, 0); await assert.rejects(fixture.connect(issued.ticket.receiver, 1));
  } finally { await fixture.close(); }
});

test('owner retirement during held real finish waits for raw callback and exposes no selected path', async () => {
  const fixture = await rig(), native = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeSocket & { _isServer?: boolean } } };
  const original = native.WebSocket.prototype.send; const receiverNatives = new WeakSet<NativeSocket>(); let release: (() => void) | undefined, settled = 0, exposed = 0;
  try {
    native.WebSocket.prototype.send = function(data: Uint8Array, options?: { binary: boolean }, callback?: (error?: Error) => void) {
      const bytes = Buffer.from(data), server = (this as NativeSocket & { _isServer?: boolean })._isServer;
      if (!server && bytes.includes(Buffer.from('"role":"receiver"'))) receiverNatives.add(this);
      const call = () => (original as unknown as (this: NativeSocket, data: Uint8Array, options: object | undefined, callback?: (error?: Error) => void) => void).call(this, data, options, callback);
      if (receiverNatives.has(this) && bytes.includes(Buffer.from('"type":"finish"')) && !release) { release = call; return; } call();
    };
    const issued = fixture.issue();
    const openings = [fixture.connect(issued.ticket.source, 0), fixture.connect(issued.ticket.receiver, 1)].map(promise => promise.then(value => { exposed++; return value; }).finally(() => { settled++; }));
    openings.forEach(promise => { void promise.catch(() => {}); }); await until(() => !!release);
    issued.source.abort(); await fixture.gateway.revokePair(issued.ticket.pairId); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(exposed, 0); assert.ok(settled < 2, 'client helper retains actual unsettled native finish reservation');
    release!(); release = undefined; const result = await Promise.allSettled(openings); assert.ok(result.every(value => value.status === 'rejected')); assert.equal(settled, 2);
    assert.equal(fixture.gateway.snapshot().pairs, 0); assert.equal(fixture.gateway.snapshot().pendingRaw, 0);
  } finally { native.WebSocket.prototype.send = original; release?.(); await fixture.close(); }
});


test('same CA and valid hostname cannot receive bearer before exact gateway certificate pin', async () => {
  const setup = await rig(), nativeSockets = new Set<Duplex>(), clientSockets = new Set<Socket>();
  const nativeClient = channel('net.client.socket');
  const observeClient = (message: unknown) => { const socket = (message as { socket: Socket }).socket; clientSockets.add(socket); socket.once('close', () => clientSockets.delete(socket)); };
  nativeClient.subscribe(observeClient); let server: ReturnType<typeof createServer> | undefined, wss: NativeServer | undefined;
  let upgrades = 0, observedBearer = false;
  try {
    const issued = setup.issue(), file = (name: string) => join(setup.fixture.directory, name);
    const run = (args: string[]) => execFileSync('openssl', args, { timeout: 10000, stdio: 'pipe' });
    run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', file('pin-other.key'), '-out', file('pin-other.csr'), '-subj', '/CN=owned wrong gateway']);
    writeFileSync(file('pin-other.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    run(['x509', '-req', '-in', file('pin-other.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAserial', file('ca.srl'), '-days', '1', '-sha256', '-extfile', file('pin-other.ext'), '-out', file('pin-other.pem')]);
    const alternate = readFileSync(file('pin-other.pem'), 'utf8'); assert.notEqual(new X509Certificate(alternate).fingerprint256, issued.ticket.source.gatewayCertificateFingerprint);
    server = createServer({ cert: alternate, key: readFileSync(file('pin-other.key'), 'utf8'), ca: setup.fixture.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
    server.on('connection', socket => { nativeSockets.add(socket); socket.once('close', () => nativeSockets.delete(socket)); });
    wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8192 });
    server.on('upgrade', (request, socket, head) => {
      upgrades++; observedBearer ||= request.headers.authorization === 'Bearer ' + issued.ticket.source.token;
      assert.equal((request.socket as TLSSocket).authorized, true); assert.equal((request.socket as TLSSocket).getProtocol(), 'TLSv1.3');
      wss!.handleUpgrade(request, socket, head, native => native.on('error', () => {}));
    });
    const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening; const address = server.address(); assert.ok(address && typeof address !== 'string');
    await assert.rejects(setup.connect({ ...issued.ticket.source, endpoint: 'wss://127.0.0.1:' + address.port + '/v1/relay' }, 0));
    assert.equal(clientSockets.size, 0, 'helper rejection must retain native ownership until actual TLS/TCP close without fixture wait');
    assert.equal(observedBearer, false, 'no bearer reaches same-CA different pinned server'); assert.equal(upgrades, 0, 'failure occurs before HTTP upgrade dispatch');
    // Even an exact pin supplied for this certificate must not bypass Node's
    // existing hostname verification of the selected127.0.0.1 endpoint.
    server.setSecureContext({ cert: setup.fixture.wrongHost.certificatePem, key: setup.fixture.wrongHost.privateKeyPem, ca: setup.fixture.ca, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
    await assert.rejects(setup.connect({ ...issued.ticket.source, endpoint: 'wss://127.0.0.1:' + address.port + '/v1/relay',
      gatewayCertificateFingerprint: new X509Certificate(setup.fixture.wrongHost.certificatePem).fingerprint256 }, 0));
    assert.equal(clientSockets.size, 0, 'native hostname rejection also awaits actual TLS/TCP close');
    assert.equal(observedBearer, false, 'exact pin cannot bypass hostname verification'); assert.equal(upgrades, 0);
  } finally { const rawClosing = [...nativeSockets, ...clientSockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
    for (const native of wss?.clients ?? []) native.terminate(); for (const socket of [...nativeSockets, ...clientSockets]) socket.destroy();
    await Promise.all(rawClosing); if (wss) await new Promise<void>(resolve => wss!.close(resolve)); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    const directory = setup.fixture.directory; await setup.close(); nativeClient.unsubscribe(observeClient); assert.equal(nativeSockets.size, 0); assert.equal(clientSockets.size, 0); assert.equal(existsSync(directory), false);
  }
});

test('owner cancellation during actual TLS socket issue retains raw ownership through rejection', async () => {
  const setup = await rig(), owner = new AbortController(), nativeSockets = new Set<Socket>(), nativeClient = channel('net.client.socket');
  let issued = 0;
  const observeClient = (message: unknown) => {
    const socket = (message as { socket: Socket }).socket; nativeSockets.add(socket); issued++;
    socket.once('close', () => nativeSockets.delete(socket)); owner.abort();
  };
  nativeClient.subscribe(observeClient);
  try {
    const pair = setup.issue(); await assert.rejects(setup.connect(pair.ticket.source, 0, owner.signal));
    assert.equal(issued, 1, 'cancellation follows actual native socket issue');
    assert.equal(nativeSockets.size, 0, 'reentrant cancellation waits native close before helper rejection');
  } finally {
    nativeClient.unsubscribe(observeClient);
    const closing = [...nativeSockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
    for (const socket of nativeSockets) socket.destroy(); await Promise.all(closing); await setup.close();
  }
});


test('valid native mTLS cannot substitute for the pinned gateway endpoint key', async t => {
  const fixture = await rig(), nativeClient = channel('net.client.socket'), nativeSockets = new Set<Socket>();
  const tls: { authorized: boolean; protocol: string | null; certificateMatches: boolean }[] = [];
  const freshOwners = [new AbortController(), new AbortController()];
  const directory = fixture.fixture.directory;
  let observing = false, exposed = 0, attempted = 0, stage = 'incumbent', detached = () => {};
  let expectedCertificate = '';
  const observeClient = (message: unknown) => {
    if (!observing) return;
    const socket = (message as { socket: TLSSocket }).socket; nativeSockets.add(socket); attempted++;
    socket.once('secureConnect', () => tls.push({ authorized: socket.authorized, protocol: socket.getProtocol(),
      certificateMatches: socket.getPeerCertificate().fingerprint256 === expectedCertificate }));
    socket.once('close', () => nativeSockets.delete(socket));
  };
  nativeClient.subscribe(observeClient);
  try {
    const incumbent = await fixture.pair(); let incumbentValue = '';
    detached = incumbent.receiverClient.peer.onData((_lane, data) => { if (typeof data === 'string') incumbentValue = data; });
    assert.equal(incumbent.sourceClient.peer.send('reliable', 'incumbent-before-key-failure'), true);
    await until(() => incumbentValue === 'incumbent-before-key-failure');
    const failed = fixture.issue(2), wrongGatewayKey = fixture.identities[0]!.keyId;
    assert.notEqual(wrongGatewayKey, failed.ticket.source.gatewayKeyId);
    const wrong = { ...failed.ticket.source, gatewayKeyId: wrongGatewayKey };
    const { gatewayKeyId: expected, ...expectedTlsAndScope } = failed.ticket.source;
    const { gatewayKeyId: substituted, ...actualTlsAndScope } = wrong;
    assert.notEqual(substituted, expected); assert.deepEqual(actualTlsAndScope, expectedTlsAndScope);
    expectedCertificate = failed.ticket.source.gatewayCertificateFingerprint;
    stage = 'wrong-gateway-key-after-valid-TLS'; observing = true;
    const source = fixture.connect(wrong, 2).then(value => { exposed++; return value; });
    const receiver = fixture.connect(failed.ticket.receiver, 3).then(value => { exposed++; return value; });
    await Promise.all([assert.rejects(source), assert.rejects(receiver)]); observing = false;
    assert.equal(exposed, 0, 'Neither candidate helper may expose a selected public peer');
    assert.equal(attempted, 2); assert.equal(tls.length, 2);
    for (const observed of tls) { assert.equal(observed.authorized, true); assert.equal(observed.protocol, 'TLSv1.3'); assert.equal(observed.certificateMatches, true); }
    assert.equal(nativeSockets.size, 0, 'Rejected helpers join their actual TLS/TCP close before rejection');
    await until(() => fixture.gateway.snapshot().pairs === 1);
    assert.equal(incumbent.sourceClient.status().active, true); assert.equal(incumbent.receiverClient.status().active, true);
    assert.equal(incumbent.sourceClient.peer.send('reliable', 'incumbent-after-key-failure'), true);
    await until(() => incumbentValue === 'incumbent-after-key-failure');
    stage = 'fresh-explicit-approval-correct-pin';
    const fresh = fixture.gateway.issuePair({ ...fixture.request(2), sessionId: 'fresh-correct-key', epoch: '4'.repeat(32) },
      request => ({ request, expiresAt: request.expiresAt, signal: freshOwners[request.role === 'source' ? 0 : 1]!.signal }));
    assert.notEqual(fresh.pairId, failed.ticket.pairId); assert.notEqual(fresh.source.token, failed.ticket.source.token);
    assert.notEqual(fresh.source.epoch, failed.ticket.source.epoch); assert.equal(fresh.source.gatewayKeyId, expected);
    const [freshSource, freshReceiver] = await Promise.all([fixture.connect(fresh.source, 2), fixture.connect(fresh.receiver, 3)]);
    let freshValue = ''; const detachFresh = freshReceiver.peer.onData((_lane, data) => { if (typeof data === 'string') freshValue = data; });
    try {
      assert.equal(freshSource.peer.send('reliable', 'fresh-correct-key-effect'), true);
      await until(() => freshValue === 'fresh-correct-key-effect');
      assert.ok(fixture.sdk.authenticatedPeerScope(freshSource.peer)); assert.ok(fixture.sdk.authenticatedPeerScope(freshReceiver.peer));
      assert.equal(incumbentValue, 'incumbent-after-key-failure'); assert.equal(incumbent.sourceClient.status().active, true);
    } finally { detachFresh(); }
    stage = 'complete';
  } finally {
    observing = false; nativeClient.unsubscribe(observeClient); detached(); freshOwners.forEach(owner => owner.abort());
    const closing = [...nativeSockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
    for (const socket of nativeSockets) socket.destroy(); await Promise.all(closing); await fixture.close();
    const final = fixture.gateway.snapshot();
    t.diagnostic(JSON.stringify({ kind: 'S04-native-gateway-key-pin', stage, attemptedNativeSockets: attempted, tls, exposedCandidatePeers: exposed,
      ownedFixtureDirectory: directory, fixtureRemoved: !existsSync(directory), final: { pairs: final.pairs, nativeConnections: final.nativeConnections,
        pendingRaw: final.pendingRaw, queuedMessages: final.queuedMessages, timers: final.timers } }));
    assert.equal(nativeSockets.size, 0); assert.equal(final.pairs, 0); assert.equal(final.nativeConnections, 0);
    assert.equal(final.pendingRaw, 0); assert.equal(final.timers, 0); assert.equal(existsSync(directory), false);
  }
});
