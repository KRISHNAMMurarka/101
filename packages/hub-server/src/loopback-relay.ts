import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { createSecureContext, checkServerIdentity, connect as connectTls, type ConnectionOptions, type PeerCertificate } from 'node:tls';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { SecureWebSocketTransport, AuthenticatedResourcePeer, createEphemeralWebIdentity, webEndpointCrypto, WSS_SUBPROTOCOL, authenticatedPeerScope } from '@101/connect';
import type { EndpointIdentity, WebSocketPort, ResourcePeer } from '@101/connect';

export const AUTHENTICATED_LOOPBACK_RELAY_PROFILE = 'authenticated-loopback-gateway/1';
export const AUTHENTICATED_LOOPBACK_RELAY_LIMITS = Object.freeze({ enrollments: 8, pairs: 4, connections: 12,
  lifetimeAttempts: 16, pendingAllocations: 1, credentialTtlMs: 15000, serviceLifetimeMs: 15000,
  pairWaitMs: 3000, handshakeMs: 3000, messageBytes: 8192, queuedMessagesPerLeg: 4,
  rawWritesPerLeg: 1, bufferedBytesPerLeg: 16384, pairTrafficBytes: 262144 });
// ws8.21's installed native surface; no ambient declarations, injected module or
// arbitrary endpoint/socket factory. Callback completion is native write
// settlement, not recipient processing or undo of an already issued effect.
interface NativeSocket extends EventEmitter {
  readonly readyState: number; readonly protocol: string; readonly bufferedAmount: number; binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer, options: { binary: boolean }, done: (error?: Error) => void): void;
  close(code?: number, reason?: string): void; terminate(): void;
}
interface NativeServer extends EventEmitter {
  readonly clients: Set<NativeSocket>;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, accept: (socket: NativeSocket) => void): void;
  close(done: () => void): void;
}
const library = createRequire(import.meta.url)('ws') as {
  WebSocket: new (endpoint: string, protocol: string, options: object) => NativeSocket;
  WebSocketServer: new (options: object) => NativeServer;
};
const wallNow = Date.now.bind(Date), monotonic = performance.now.bind(performance);
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const copyBytes = Uint8Array.prototype.set;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
function signalCurrent(signal: unknown): signal is AbortSignal { try { return nativeAborted.call(signal) === false; } catch { return false; } }
function listen(signal: AbortSignal, callback: () => void): () => void {
  addEvent.call(signal, 'abort', callback, { once: true }); return () => removeEvent.call(signal, 'abort', callback);
}
function object(input: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw Error('Relay configuration invalid');
  const keys = Reflect.ownKeys(input), result: Record<string, unknown> = Object.create(null);
  if (keys.length > allowed.length) throw Error('Relay configuration invalid');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !property?.enumerable || !('value' in property)) throw Error('Relay configuration invalid');
    result[key] = property.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw Error('Relay configuration invalid'); return result;
}
function id(input: unknown): string { if (typeof input !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(input)) throw Error('Relay configuration invalid'); return input; }
function keyId(input: unknown): string { if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) throw Error('Relay configuration invalid'); return input; }
function pem(input: unknown): string { if (typeof input !== 'string' || input.length < 64 || input.length > 16384) throw Error('Relay identity invalid'); return input; }
function unsafeUrlCharacters(input: string): boolean {
  for (let index = 0; index < input.length; index++) { const code = input.charCodeAt(index); if (code <= 32 || code >= 127 && code <= 159 || code === 92) return true; } return false;
}
function origin(input: unknown): string {
  if (typeof input !== 'string' || input.length > 256 || unsafeUrlCharacters(input)) throw Error('Relay origin invalid');
  const url = new URL(input); if (url.protocol !== 'https:' || url.origin !== input || url.username || url.password) throw Error('Relay origin invalid'); return input;
}
function validCertificate(cert: X509Certificate): boolean { const at = wallNow(); return Number.isFinite(at) && Date.parse(cert.validFrom) <= at && at < Date.parse(cert.validTo); }
function certificate(input: string, ca: boolean): X509Certificate { const cert = new X509Certificate(input); if (cert.ca !== ca || !validCertificate(cert)) throw Error('Relay identity invalid'); return cert; }
function issued(cert: X509Certificate, ca: X509Certificate, purpose: 'client' | 'server'): void {
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey) || !cert.keyUsage?.includes(purpose === 'server' ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.2')) throw Error('Relay identity invalid');
}
function snapshot(input: unknown): { data: string | Uint8Array<ArrayBuffer>; bytes: number; binary: boolean } {
  if (typeof input === 'string') { if (input.length > 8192) throw Error('Relay message quota'); const data = encoder.encode(input); if (data.byteLength > 8192) throw Error('Relay message quota'); return { data: input, bytes: data.byteLength, binary: false }; }
  let source: Uint8Array;
  if (input instanceof ArrayBuffer) { const length = arrayLength.call(input); if (length > 8192) throw Error('Relay message quota'); source = new Uint8Array(input); }
  else if (input instanceof Uint8Array) source = input;
  else throw Error('Relay message invalid');
  const length = typedLength.call(source); if (!Number.isSafeInteger(length) || length > 8192) throw Error('Relay message quota');
  const data = new Uint8Array(length); copyBytes.call(data, source); return { data, bytes: length, binary: true };
}
// The ws request can emit logical close before its native TLS/TCP socket closes.
// Reserve before construction; seal only after the fixed native factory returns
// (or throws). Logical retirement never releases an actually issued socket.
class NativeSocketLifetime {
  private socket?: Duplex; private sealed = false; private closed = false; private closing = false;
  private finishClose!: () => void; readonly settled = new Promise<void>(resolve => { this.finishClose = resolve; });
  capture(socket: Duplex): void {
    this.socket = socket; socket.once('close', () => { this.closed = true; this.finish(); });
    if (this.closing) socket.destroy();
  }
  seal(): void { this.sealed = true; this.finish(); }
  close(): void { this.closing = true; this.socket?.destroy(); }
  private finish(): void { if (this.sealed && (!this.socket || this.closed)) this.finishClose(); }
}
interface RawMetrics { issued: number; settled: number; uncertain: number; peakQueued: number; peakRaw: number; bytes: number }
class NativePort implements WebSocketPort {
  onopen: ((event: unknown) => void) | null = null; onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null;
  private readonly queue: ReturnType<typeof snapshot>[] = []; private raw?: ReturnType<typeof snapshot>;
  private closing = false; private closed = false; private nativeClosed = false; private closeTimer?: ReturnType<typeof setTimeout>;
  private finishClose!: () => void; readonly settled: Promise<void>; readonly metric: RawMetrics = { issued: 0, settled: 0, uncertain: 0, peakQueued: 0, peakRaw: 0, bytes: 0 };
  readonly native: NativeSocket; private readonly current: () => boolean; private readonly failure: () => void; private readonly lifetime: NativeSocketLifetime;
  constructor(native: NativeSocket, current: () => boolean, failure: () => void, lifetime: NativeSocketLifetime) {
    this.native=native;this.current=current;this.failure=failure;this.lifetime=lifetime;
    void lifetime.settled.then(() => { this.nativeClosed = true; this.finish(); });
    this.settled = new Promise(resolve => { this.finishClose = resolve; }); native.binaryType = 'arraybuffer';
    native.on('open', this.open); native.on('message', this.message); native.on('close', this.end); native.on('error', this.error);
  }
  get readyState(): number { return this.native.readyState; } get protocol(): string { return this.native.protocol; }
  get binaryType(): string { return this.native.binaryType; } set binaryType(value: string) { this.native.binaryType = value; }
  get bufferedAmount(): number { return this.native.bufferedAmount + this.queuedBytes + (this.raw?.bytes ?? 0); }
  get queuedBytes(): number { return this.queue.reduce((total, row) => total + row.bytes, 0); }
  get queued(): number { return this.queue.length; } get pendingRaw(): number { return Number(this.raw !== undefined); }
  get timerCount(): number { return Number(this.closeTimer !== undefined); }
  private open = () => { if (this.current() && !this.closing) this.onopen?.({}); else this.close(); };
  private error = () => { if (!this.closing) { this.onerror?.({}); this.failure(); } };
  private message = (input: unknown, binary: boolean) => {
    if (!this.current() || this.closing) return;
    try { const copy = snapshot(input); const data = binary ? (copy.data as Uint8Array<ArrayBuffer>).buffer : typeof copy.data === 'string' ? copy.data : decoder.decode(copy.data);
      if (this.current() && !this.closing) this.onmessage?.({ data });
    } catch { this.failure(); }
  };
  private end = () => { this.closed = true; this.queue.length = 0; if (this.closeTimer) clearTimeout(this.closeTimer); this.closeTimer = undefined;
    this.lifetime.close(); this.onclose?.({}); this.finish(); };
  private finish(): void {
    if (!this.closed || !this.nativeClosed || this.raw) return;
    this.native.removeListener('open', this.open); this.native.removeListener('message', this.message); this.native.removeListener('close', this.end); this.native.removeListener('error', this.error);
    this.onopen = this.onclose = this.onerror = this.onmessage = null; this.finishClose();
  }
  send(input: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    if (this.closing || !this.current() || this.native.readyState !== 1 || this.queue.length >= 4) throw Error('Relay unavailable');
    const row = snapshot(input); if (this.bufferedAmount + row.bytes > 16384 || !this.current()) throw Error('Relay queue quota');
    this.queue.push(row); this.metric.peakQueued = Math.max(this.metric.peakQueued, this.queue.length); this.pump();
  }
  private pump(): void {
    if (this.raw || this.closing) return;
    if (!this.current()) { this.failure(); return; } const row = this.queue.shift(); if (!row) return;
    if (this.native.bufferedAmount + row.bytes > 16384) { this.failure(); return; }
    this.raw = row; this.metric.issued++; this.metric.bytes += row.bytes; this.metric.peakRaw = 1;
    let completed = false;
    const done = (error?: Error) => {
      if (completed) return; completed = true; this.raw = undefined; this.metric.settled++;
      if (this.closing || !this.current()) this.metric.uncertain++;
      if (error && !this.closing) this.failure(); else if (!this.closing) this.pump(); this.finish();
    };
    try { this.native.send(row.data, { binary: row.binary }, done); } catch { done(Error('Relay native write failed')); this.failure(); }
  }
  close(): void {
    if (this.closing) return; this.closing = true; this.queue.length = 0;
    if (this.native.readyState === 3) { this.closed = true; this.lifetime.close(); this.finish(); return; }
    this.closeTimer = setTimeout(() => { this.native.terminate(); this.lifetime.close(); }, 250);
    try { if (this.native.readyState === 0) { this.native.terminate(); this.lifetime.close(); } else this.native.close(1008, 'relay-ended'); } catch { this.native.terminate(); }
  }
}
export interface RelayEnrollment { readonly principalId: string; readonly deviceId: string; readonly certificatePem: string; readonly endpointKeyId: string }
export interface AuthenticatedLoopbackRelayOptions { readonly serverCertificatePem: string; readonly serverPrivateKeyPem: string; readonly clientCaCertificatePem: string;
  readonly origin: string; readonly enrollments: readonly RelayEnrollment[]; readonly signal: AbortSignal }
export interface RelayPairRequest { readonly selectedPath: 'authenticated-loopback-relay'; readonly applicationId: string; readonly sessionId: string; readonly epoch: string;
  readonly sourcePrincipalId: string; readonly receiverPrincipalId: string; readonly ttlMs: number }
export interface RelayApprovalRequest { readonly operation: 'relay-forward'; readonly pairId: string; readonly role: 'source' | 'receiver'; readonly principalId: string; readonly remotePrincipalId: string;
  readonly applicationId: string; readonly sessionId: string; readonly epoch: string; readonly endpoint: string; readonly gatewayKeyId: string;
  readonly gatewayCertificateFingerprint: string; readonly sourceCertificateFingerprint: string; readonly receiverCertificateFingerprint: string;
  readonly expiresAt: number; readonly plaintextGateway: true; readonly purpose: 'resource-data' }
export interface RelayApproval { readonly request: RelayApprovalRequest; readonly expiresAt: number; readonly signal: AbortSignal }
export type RelayAuthorize = (request: RelayApprovalRequest) => RelayApproval | undefined;
export interface RelayCredential { readonly endpoint: string; readonly origin: string; readonly token: string; readonly pairId: string; readonly expiresAt: number; readonly role: 'source' | 'receiver';
  readonly applicationId: string; readonly sessionId: string; readonly epoch: string; readonly gatewayKeyId: string; readonly gatewayCertificateFingerprint: string;
  readonly principalId: string; readonly deviceId: string; readonly certificateFingerprint: string; readonly endpointKeyId: string; readonly plaintextGateway: true }
interface Enrollment { principalId: string; deviceId: string; certificate: X509Certificate; endpointKeyId: string }
interface Pair { id: string; key: string; request: RelayPairRequest; expiresAt: number; deadline: number; waitingUntil: number; grants: readonly RelayApproval[];
  credentials: readonly RelayCredential[]; claimed: boolean[]; ports: NativePort[]; peers: AuthenticatedResourcePeer[]; transports: SecureWebSocketTransport[];
  detach: (() => void)[]; retiring: boolean; ready: boolean; bytes: number; closed: Promise<void>; finish: () => void }
export function createAuthenticatedLoopbackRelay(input: AuthenticatedLoopbackRelayOptions) {
  const value = object(input, ['serverCertificatePem', 'serverPrivateKeyPem', 'clientCaCertificatePem', 'origin', 'enrollments', 'signal']);
  const certPem = pem(value.serverCertificatePem), keyPem = pem(value.serverPrivateKeyPem), caPem = pem(value.clientCaCertificatePem);
  const ca = certificate(caPem, true), cert = certificate(certPem, false); issued(cert, ca, 'server');
  if (!cert.checkIP('127.0.0.1') || !cert.checkPrivateKey(createPrivateKey(keyPem))) throw Error('Relay identity invalid');
  createSecureContext({ cert: certPem, key: keyPem, ca: caPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  const allowedOrigin = origin(value.origin), owner = value.signal; if (!signalCurrent(owner)) throw Error('Relay owner unavailable');
  if (!Array.isArray(value.enrollments) || value.enrollments.length < 2 || value.enrollments.length > 8) throw Error('Relay enrollment invalid');
  const enrolled = new Map<string, Enrollment>(), principals = new Map<string, Enrollment>(), keys = new Set<string>(), devices = new Set<string>();
  for (const entry of value.enrollments) {
    const fields = object(entry, ['principalId', 'deviceId', 'certificatePem', 'endpointKeyId']);
    const actor: Enrollment = { principalId: id(fields.principalId), deviceId: id(fields.deviceId), certificate: certificate(pem(fields.certificatePem), false), endpointKeyId: keyId(fields.endpointKeyId) };
    issued(actor.certificate, ca, 'client');
    if (enrolled.has(actor.certificate.fingerprint256) || principals.has(actor.principalId) || keys.has(actor.endpointKeyId) || devices.has(actor.deviceId)) throw Error('Relay enrollment invalid');
    enrolled.set(actor.certificate.fingerprint256, actor); principals.set(actor.principalId, actor); keys.add(actor.endpointKeyId); devices.add(actor.deviceId);
  }
  let phase: 'prepared' | 'starting' | 'active' | 'stopping' | 'stopped' = 'prepared', endpoint: string | undefined, identity: EndpointIdentity | undefined;
  let server: Server | undefined, wss: NativeServer | undefined, starting: Promise<string> | undefined, stopping: Promise<void> | undefined;
  let generation = 0, attempts = 0, allocating = false, lifetime = Infinity, totalBytes = 0, retired = 0;
  let timer: ReturnType<typeof setInterval> | undefined; const sockets = new Set<Duplex>(), pairs = new Map<string, Pair>(), tokens = new Map<string, { pair: Pair; index: number }>();
  let removeOwner = () => {};
  const alive = () => (phase === 'starting' || phase === 'active') && signalCurrent(owner) && monotonic() < lifetime && validCertificate(cert) && validCertificate(ca);
  function pairCurrent(pair: Pair): boolean { return alive() && !pair.retiring && wallNow() < pair.expiresAt && monotonic() < pair.deadline && pair.grants.every(grant => signalCurrent(grant.signal) && wallNow() < grant.expiresAt) && pair.credentials.every(credential => { const actor = enrolled.get(credential.certificateFingerprint); return !!actor && validCertificate(actor.certificate); }); }
  function retire(pair: Pair): void {
    if (pair.retiring) return; pair.retiring = true; for (const credential of pair.credentials) tokens.delete(credential.token);
    pair.detach.splice(0).forEach(detach => detach()); pair.peers.forEach(peer => peer.stop()); pair.ports.forEach(port => port.close());
    void Promise.all(pair.ports.map(port => port.settled)).then(() => { pairs.delete(pair.id); retired++; pair.finish(); });
  }
  async function stop(): Promise<void> {
    if (stopping) return stopping; phase = 'stopping'; generation++; tokens.clear(); removeOwner(); if (timer) clearInterval(timer); timer = undefined;
    for (const pair of pairs.values()) retire(pair); for (const socket of sockets) socket.destroy();
    const ownedServer = server, ownedWss = wss;
    stopping = (async () => {
      await Promise.all([...pairs.values()].map(pair => pair.closed));
      if (starting) await starting.catch(() => {});
      if (ownedWss) await new Promise<void>(resolve => ownedWss.close(() => resolve()));
      if (ownedServer) await new Promise<void>(resolve => ownedServer.close(() => resolve()));
      endpoint = undefined; identity = undefined; phase = 'stopped';
    })(); return stopping;
  }
  function tick(): void {
    if (!alive()) { void stop(); return; }
    for (const pair of pairs.values()) {
      if (!pairCurrent(pair) || pair.claimed.some(claimed => !claimed) && monotonic() >= pair.waitingUntil) { retire(pair); continue; }
      pair.transports.forEach(transport => transport.tick()); pair.peers.forEach(peer => peer.tick());
      if (!pairCurrent(pair) || pair.peers.some(peer => peer.status().phase === 'stopped')) { retire(pair); continue; }
      if (pair.peers[0] && pair.peers[1]) {
        const statuses = pair.peers.map(peer => peer.status());
        if (statuses.every(status => status.phase === 'awaiting-enrollment')) {
          if (statuses.some((status, index) => status.remoteKeyId !== pair.credentials[index]!.endpointKeyId)) { retire(pair); continue; }
          for (let index = 0; index < 2; index++) {
            if (!pairCurrent(pair) || !pair.peers[index]!.confirmEnrollment(statuses[index]!.comparisonDigest!)) { retire(pair); break; }
          }
        }
      }
      if (!pair.ready && pair.peers[0] && pair.peers[1] && pair.peers.every(peer => !!authenticatedPeerScope(peer))) {
        for (let index = 0; index < 2; index++) {
          const scope = authenticatedPeerScope(pair.peers[index]!);
          if (!scope || !pairCurrent(pair) || !pair.peers[index]!.send('reliable', JSON.stringify({ protocol: '101-relay-ready', version: 1, type: 'ready', pairId: pair.id,
            epoch: pair.request.epoch, applicationId: pair.request.applicationId, sessionId: pair.request.sessionId, role: pair.credentials[index]!.role,
            transcriptDigest: scope.transcriptDigest, selectedPath: 'authenticated-loopback-relay', plaintextGateway: true }))) { retire(pair); break; }
        }
        if (pairCurrent(pair)) pair.ready = true;
      }
    }
  }
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const deny = () => { socket.destroy(); };
    try {
      const tls = request.socket as TLSSocket, fingerprint = tls.getPeerCertificate().fingerprint256;
      const actor = fingerprint ? enrolled.get(fingerprint) : undefined;
      if (!alive() || phase !== 'active' || !actor || !validCertificate(actor.certificate) || !tls.authorized || tls.getProtocol() !== 'TLSv1.3' || request.method !== 'GET' || request.url !== '/v1/relay' ||
        request.headers.origin !== allowedOrigin || request.headers['sec-websocket-protocol'] !== WSS_SUBPROTOCOL || head.byteLength > 8192 || request.rawHeaders.length > 48) return deny();
      const names = request.rawHeaders.filter((_field, index) => index % 2 === 0).map(name => name.toLowerCase());
      if (new Set(names).size !== names.length || names.some(name => !['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'origin', 'authorization'].includes(name))) return deny();
      const authorization = request.headers.authorization; if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return deny();
      const admitted = tokens.get(authorization.slice(7)); if (!admitted) return deny(); const { pair, index } = admitted, credential = pair.credentials[index]!;
      if (!pairCurrent(pair) || pair.claimed[index] || actor.principalId !== credential.principalId || actor.certificate.fingerprint256 !== credential.certificateFingerprint) return deny();
      pair.claimed[index] = true; tokens.delete(credential.token);
      wss!.handleUpgrade(request, socket, head, native => {
        if (!pairCurrent(pair)) { native.terminate(); return; }
        const lifetime = new NativeSocketLifetime(); lifetime.capture(request.socket); lifetime.seal();
        const port = new NativePort(native, () => pairCurrent(pair), () => retire(pair), lifetime); pair.ports[index] = port;
        const transport = new SecureWebSocketTransport({ side: 'server', socket: port, endpoint: endpoint!, now: monotonic,
          limits: { maxMessageBytes: 4096, reliableBufferLimit: 16384, latestBufferLimit: 8192 } });
        const peer = new AuthenticatedResourcePeer({ transport, identity: identity!, crypto: webEndpointCrypto, epoch: pair.request.epoch,
          applicationId: pair.request.applicationId, sessionId: pair.request.sessionId, role: index === 0 ? 'receiver' : 'source', now: monotonic, timeoutMs: 3000 });
        pair.transports[index] = transport; pair.peers[index] = peer;
        pair.detach.push(peer.onStateChange(state => { if (state === 'failed' || state === 'disconnected') retire(pair); }));
        pair.detach.push(peer.onData((lane, data) => {
          if (!pairCurrent(pair) || !pair.ready) { retire(pair); return; }
          const destination = pair.peers[index === 0 ? 1 : 0];
          try { const size = snapshot(data).bytes; if (pair.bytes + size > 262144 || !destination?.isOpen(lane)) { retire(pair); return; }
            pair.bytes += size; totalBytes += size; if (!pairCurrent(pair) || !destination.send(lane, data)) retire(pair);
          } catch { retire(pair); }
        }));
        void transport.connect().then(() => { if (!pairCurrent(pair)) retire(pair); }).catch(() => retire(pair));
      });
    } catch { deny(); }
  }
  function start(): Promise<string> {
    if (!signalCurrent(owner) || phase === 'stopping' || phase === 'stopped') return Promise.reject(Error('Relay owner retired'));
    if (starting) return starting; if (phase !== 'prepared') return Promise.reject(Error('Relay owner retired'));
    phase = 'starting'; const epoch = ++generation; lifetime = monotonic() + 15000;
    starting = (async () => {
      identity = await createEphemeralWebIdentity(); if (!alive() || epoch !== generation) throw Error('Relay owner retired');
      server = createServer({ cert: certPem, key: keyPem, ca: caPem, requestCert: true, rejectUnauthorized: true,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', maxHeaderSize: 4096 }, (_request, response) => { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); });
      server.maxHeadersCount = 24; server.headersTimeout = 3000; server.requestTimeout = 3000; server.timeout = 3000;
      wss = new library.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8192,
        handleProtocols: (protocols: Set<string>) => protocols.has(WSS_SUBPROTOCOL) ? WSS_SUBPROTOCOL : false });
      server.on('connection', socket => { if (!alive() || sockets.size >= 12) { socket.destroy(); return; } sockets.add(socket); socket.once('close', () => sockets.delete(socket)); (socket as Socket).setTimeout(3000, () => socket.destroy()); });
      server.on('upgrade', upgrade); server.on('error', () => { void stop(); });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', reject); resolve(); }); });
      if (!alive() || epoch !== generation) { throw Error('Relay owner retired'); }
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Relay unavailable');
      endpoint = 'wss://127.0.0.1:' + address.port + '/v1/relay'; phase = 'active'; timer = setInterval(tick, 5); return endpoint;
    })(); void starting.catch(() => { void stop(); }); return starting;
  }
  function issuePair(inputRequest: RelayPairRequest, authorize: RelayAuthorize): Readonly<{ pairId: string; source: RelayCredential; receiver: RelayCredential }> {
    if (allocating || phase !== 'active' || !alive() || pairs.size >= 4 || attempts >= 16 || typeof authorize !== 'function') throw Error('Relay allocation unavailable');
    allocating = true; attempts++;
    try {
      const values = object(inputRequest, ['selectedPath', 'applicationId', 'sessionId', 'epoch', 'sourcePrincipalId', 'receiverPrincipalId', 'ttlMs']);
      if (values.selectedPath !== 'authenticated-loopback-relay' || typeof values.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(values.epoch) ||
        typeof values.ttlMs !== 'number' || !Number.isSafeInteger(values.ttlMs) || values.ttlMs < 500 || values.ttlMs > 15000) throw Error('Relay selection invalid');
      const request: RelayPairRequest = Object.freeze({ selectedPath: 'authenticated-loopback-relay', applicationId: id(values.applicationId), sessionId: id(values.sessionId), epoch: values.epoch,
        sourcePrincipalId: id(values.sourcePrincipalId), receiverPrincipalId: id(values.receiverPrincipalId), ttlMs: values.ttlMs });
      const actors = [principals.get(request.sourcePrincipalId), principals.get(request.receiverPrincipalId)];
      if (!actors[0] || !actors[1] || actors[0] === actors[1] || actors.some(actor => !validCertificate(actor!.certificate))) throw Error('Relay allocation denied');
      const key = JSON.stringify([request.applicationId, request.sessionId, request.epoch, request.sourcePrincipalId, request.receiverPrincipalId]);
      if ([...pairs.values()].some(pair => pair.key === key)) throw Error('Relay allocation busy');
      const pairId = randomBytes(16).toString('hex');
      const at = wallNow(), deadline = Math.min(monotonic() + request.ttlMs, lifetime), expiresAt = at + (deadline - monotonic());
      const grants: RelayApproval[] = [];
      for (let index = 0; index < 2; index++) {
        const approvalRequest: RelayApprovalRequest = Object.freeze({ operation: 'relay-forward', pairId, role: index === 0 ? 'source' : 'receiver', principalId: actors[index]!.principalId,
          remotePrincipalId: actors[index === 0 ? 1 : 0]!.principalId, applicationId: request.applicationId, sessionId: request.sessionId, epoch: request.epoch,
          endpoint: endpoint!, gatewayKeyId: identity!.keyId, gatewayCertificateFingerprint: cert.fingerprint256,
          sourceCertificateFingerprint: actors[0]!.certificate.fingerprint256, receiverCertificateFingerprint: actors[1]!.certificate.fingerprint256,
          expiresAt, plaintextGateway: true, purpose: 'resource-data' });
        const grant = object(authorize(approvalRequest), ['request', 'expiresAt', 'signal']);
        if (grant.request !== approvalRequest || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= wallNow() || grant.expiresAt > expiresAt || !signalCurrent(grant.signal)) throw Error('Relay allocation denied');
        grants.push(Object.freeze({ request: approvalRequest, expiresAt: grant.expiresAt, signal: grant.signal }));
      }
      if (!alive() || grants.some(grant => !signalCurrent(grant.signal) || wallNow() >= grant.expiresAt)) throw Error('Relay allocation denied');
      const until = Math.min(expiresAt, ...grants.map(grant => grant.expiresAt)), credentials: RelayCredential[] = actors.map((actor, index) => Object.freeze({
        endpoint: endpoint!, origin: allowedOrigin, pairId, token: randomBytes(32).toString('base64url'), expiresAt: until, role: index === 0 ? 'source' : 'receiver',
        applicationId: request.applicationId, sessionId: request.sessionId, epoch: request.epoch, gatewayKeyId: identity!.keyId, gatewayCertificateFingerprint: cert.fingerprint256,
        principalId: actor!.principalId, deviceId: actor!.deviceId, certificateFingerprint: actor!.certificate.fingerprint256, endpointKeyId: actor!.endpointKeyId, plaintextGateway: true }));
      let finish!: () => void; const closed = new Promise<void>(resolve => { finish = resolve; });
      const pair: Pair = { id: pairId, key, request, expiresAt: until, deadline: Math.min(deadline, monotonic() + until - wallNow()), waitingUntil: monotonic() + 3000,
        grants, credentials, claimed: [false, false], ports: [], peers: [], transports: [], detach: [], retiring: false, ready: false, bytes: 0, closed, finish };
      pairs.set(pair.id, pair); for (const credential of credentials) tokens.set(credential.token, { pair, index: credential.role === 'source' ? 0 : 1 });
      for (const grant of grants) pair.detach.push(listen(grant.signal, () => retire(pair)));
      if (!pairCurrent(pair)) { retire(pair); throw Error('Relay allocation denied'); }
      return Object.freeze({ pairId: pair.id, source: credentials[0]!, receiver: credentials[1]! });
    } finally { allocating = false; }
  }
  removeOwner = listen(owner, () => { void stop(); }); if (!signalCurrent(owner)) void stop();
  return Object.freeze({ start, issuePair, revokePair(pairId: string): Promise<void> { const pair = pairs.get(pairId); if (!pair) return Promise.resolve(); retire(pair); return pair.closed; }, stop,
    snapshot() { const ports = [...pairs.values()].flatMap(pair => pair.ports); return Object.freeze({ profile: AUTHENTICATED_LOOPBACK_RELAY_PROFILE, phase, selectedPath: 'authenticated-loopback-relay', plaintextGateway: true,
      endpoint, pairs: pairs.size, attempts, allocating, nativeConnections: sockets.size, pendingRaw: ports.reduce((sum, port) => sum + port.pendingRaw, 0),
      queuedMessages: ports.reduce((sum, port) => sum + port.queued, 0), queuedBytes: ports.reduce((sum, port) => sum + port.queuedBytes, 0),
      retiredPairs: retired, applicationBytes: totalBytes, timers: Number(timer !== undefined) + ports.reduce((sum, port) => sum + port.timerCount, 0), limits: AUTHENTICATED_LOOPBACK_RELAY_LIMITS }); } });
}
export interface AuthenticatedRelayClientOptions { readonly credential: RelayCredential; readonly caCertificatePem: string; readonly certificatePem: string;
  readonly privateKeyPem: string; readonly identity: EndpointIdentity; readonly signal: AbortSignal }
export interface AuthenticatedRelayClient { readonly peer: ResourcePeer; readonly selectedPath: 'authenticated-loopback-relay';
  readonly selection: Readonly<{ profile: string; selectedPath: 'authenticated-loopback-relay'; pairId: string; epoch: string; endpoint: string; gatewayKeyId: string; gatewayCertificateFingerprint: string; transcriptDigest: string; plaintextGateway: true }>; stop(): Promise<void>;
  status(): Readonly<{ active: boolean; pendingRaw: number; queued: number; issued: number; settled: number; uncertain: number }> }
/** Explicit provisioned Node WSS client. Both gateway legs are enrolled separately;
 * the trusted gateway terminates plaintext. Connect both roles concurrently; this
 * promise waits for both gateway legs before exposing a peer. Waiting never grants
 * a resource. A missing role retires the allocation within the bounded deadline. */
export async function connectAuthenticatedRelay(input: AuthenticatedRelayClientOptions): Promise<AuthenticatedRelayClient> {
  const value = object(input, ['credential', 'caCertificatePem', 'certificatePem', 'privateKeyPem', 'identity', 'signal']);
  const fields = object(value.credential, ['endpoint', 'origin', 'token', 'pairId', 'expiresAt', 'role', 'applicationId', 'sessionId', 'epoch', 'gatewayKeyId', 'gatewayCertificateFingerprint',
    'principalId', 'deviceId', 'certificateFingerprint', 'endpointKeyId', 'plaintextGateway']);
  if (typeof fields.endpoint !== 'string' || fields.endpoint.length > 256 || unsafeUrlCharacters(fields.endpoint)) throw Error('Relay credential invalid');
  const url = new URL(fields.endpoint);
  if (url.protocol !== 'wss:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1/relay' || url.href !== fields.endpoint || url.username || url.password || url.search || url.hash) throw Error('Relay credential invalid');
  if (typeof fields.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(fields.token) || typeof fields.expiresAt !== 'number' || !Number.isFinite(fields.expiresAt) || fields.expiresAt <= wallNow() || fields.expiresAt - wallNow() > 15000 ||
    typeof fields.pairId !== 'string' || !/^[0-9a-f]{32}$/.test(fields.pairId) || fields.role !== 'source' && fields.role !== 'receiver' || fields.plaintextGateway !== true || typeof fields.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(fields.epoch)) throw Error('Relay credential invalid');
  id(fields.applicationId); id(fields.sessionId); id(fields.principalId); id(fields.deviceId); keyId(fields.gatewayKeyId); keyId(fields.endpointKeyId); origin(fields.origin);
  const caPem = pem(value.caCertificatePem), certPem = pem(value.certificatePem), keyPem = pem(value.privateKeyPem), ca = certificate(caPem, true), cert = certificate(certPem, false);
  issued(cert, ca, 'client'); if (!cert.checkPrivateKey(createPrivateKey(keyPem)) || cert.fingerprint256 !== fields.certificateFingerprint) throw Error('Relay identity invalid');
  const identity = value.identity as EndpointIdentity, signal = value.signal;
  if (!identity || identity.keyId !== fields.endpointKeyId || !signalCurrent(signal)) throw Error('Relay owner unavailable');
  const lifetime = new NativeSocketLifetime();
  const deadline = monotonic() + fields.expiresAt - wallNow(); let retired = false, port: NativePort | undefined, peer: AuthenticatedResourcePeer | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let detach = () => {}, detachPeer = () => {}, detachReady = () => {}, detachUpgrade = () => {}, done!: () => void, reject!: (error: Error) => void; const connected = new Promise<void>((resolve, fail) => { done = resolve; reject = fail; }); void connected.catch(() => {});
  const current = () => !retired && signalCurrent(signal) && wallNow() < (fields.expiresAt as number) && monotonic() < deadline && validCertificate(cert) && validCertificate(ca);
  const stop = async () => { if (!retired) { retired = true; detach(); detachPeer(); detachReady(); detachUpgrade(); if (timer) clearInterval(timer); timer = undefined; peer?.stop(); port?.close(); reject(Error('Relay unavailable')); } port?.close(); lifetime.close(); await Promise.all([port?.settled, lifetime.settled]); };
  try {
    detach = listen(signal, () => { void stop(); }); if (!current()) throw Error('Relay owner unavailable');
    let native: NativeSocket;
    try { native = new library.WebSocket(fields.endpoint, WSS_SUBPROTOCOL, { ca: caPem, cert: certPem, key: keyPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true,
      followRedirects: false, agent: undefined,
      // Node uses this fixed factory directly without an Agent or TLS cache.
      // agent:false would create an Agent and bypass the socket capture.
      createConnection(options: ConnectionOptions): TLSSocket {
        // Match ws8.21 tlsConnect: an HTTP path is never a Unix socket path,
        // and this exact selected IP endpoint has no DNS SNI hostname.
        const socket = connectTls({ ...options, path: undefined, servername: '' });
        lifetime.capture(socket); return socket;
      }, perMessageDeflate: false, maxPayload: 8192, handshakeTimeout: 3000,
      // Preserve Node's hostname/CA verification and require the exact current
      // pinned gateway before HTTPS can transmit the bearer. Fresh connections
      // avoid ambient agent TLS-session reuse bypassing this identity boundary.
      checkServerIdentity(hostname: string, remote: PeerCertificate): Error | undefined {
        const failed = checkServerIdentity(hostname, remote);
        if (failed) return failed;
        if (remote.fingerprint256 !== fields.gatewayCertificateFingerprint || !current()) return Error('Relay identity invalid');
        return undefined;
      },
      headers: { Origin: fields.origin, Authorization: 'Bearer ' + fields.token } });
    } finally { lifetime.seal(); }
    port = new NativePort(native, current, () => { void stop(); }, lifetime);
    if (!current()) throw Error('Relay owner unavailable');
    const upgraded = (response: IncomingMessage) => { const tls = response.socket as TLSSocket; if (!current() || !tls.authorized || tls.getProtocol() !== 'TLSv1.3' || tls.getPeerCertificate().fingerprint256 !== fields.gatewayCertificateFingerprint) void stop(); };
    native.once('upgrade', upgraded); detachUpgrade = () => native.removeListener('upgrade', upgraded);
    const transport = new SecureWebSocketTransport({ side: 'client', endpoint: fields.endpoint, now: monotonic, createSocket: () => port!,
      limits: { maxMessageBytes: 4096, reliableBufferLimit: 16384, latestBufferLimit: 8192 } });
    peer = new AuthenticatedResourcePeer({ transport, identity, crypto: webEndpointCrypto, epoch: fields.epoch,
      applicationId: fields.applicationId as string, sessionId: fields.sessionId as string, role: fields.role, now: monotonic, timeoutMs: 3000, expectedRemoteKeyId: fields.gatewayKeyId as string });
    detachPeer = peer.onStateChange(state => { if (state === 'failed' || state === 'disconnected') void stop(); });
    detachReady = peer.onData((lane, data) => {
      try {
        if (!current() || lane !== 'reliable' || typeof data !== 'string' || data.length > 2048 || encoder.encode(data).length > 2048) throw Error();
        const ready = object(JSON.parse(data), ['protocol', 'version', 'type', 'pairId', 'epoch', 'applicationId', 'sessionId', 'role', 'transcriptDigest', 'selectedPath', 'plaintextGateway']);
        const scope = authenticatedPeerScope(peer!);
        if (!scope || ready.protocol !== '101-relay-ready' || ready.version !== 1 || ready.type !== 'ready' || ready.pairId !== fields.pairId || ready.epoch !== fields.epoch ||
          ready.applicationId !== fields.applicationId || ready.sessionId !== fields.sessionId || ready.role !== fields.role || ready.transcriptDigest !== scope.transcriptDigest ||
          ready.selectedPath !== 'authenticated-loopback-relay' || ready.plaintextGateway !== true || !current()) throw Error();
        detachReady(); detachReady = () => {}; if (!current()) throw Error(); done();
      } catch { void stop(); }
    });
    await transport.connect(); if (!current()) throw Error('Relay unavailable');
    const began = monotonic(); timer = setInterval(() => { if (!current() || monotonic() - began > 3000 && peer!.state !== 'connected') { void stop(); return; } transport.tick(); peer!.tick(); }, 5);
    await connected; detachReady(); detachReady = () => {}; if (!current()) throw Error('Relay unavailable');
    const scope=authenticatedPeerScope(peer);if(!scope||!current())throw Error('Relay unavailable');
    return Object.freeze({ peer, selectedPath: 'authenticated-loopback-relay', stop,
      selection: Object.freeze({profile:AUTHENTICATED_LOOPBACK_RELAY_PROFILE,selectedPath:'authenticated-loopback-relay',pairId:fields.pairId,epoch:fields.epoch,endpoint:fields.endpoint,gatewayKeyId:fields.gatewayKeyId as string,
        gatewayCertificateFingerprint:fields.gatewayCertificateFingerprint as string,transcriptDigest:scope.transcriptDigest,plaintextGateway:true}),
      status: () => Object.freeze({ active: current() && peer!.state === 'connected', pendingRaw: port!.pendingRaw, queued: port!.queued,
        issued: port!.metric.issued, settled: port!.metric.settled, uncertain: port!.metric.uncertain }) });
  } catch { lifetime.seal(); await stop(); throw Error('Relay unavailable'); }
}
