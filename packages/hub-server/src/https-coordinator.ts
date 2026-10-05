import { createServer, Agent, request as httpsRequest, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createPrivateKey, timingSafeEqual, X509Certificate } from "node:crypto";
import { createSecureContext, type TLSSocket } from "node:tls";
import { LocalSignalingBroker, type CreatedSignalingSession, type HostPeerSignal } from "@101/pairing";
import { CAPABILITY_NAMES, type DeviceCapabilities } from "@101/protocol";

/** Selected provisioned Node-client profile. These are server admission ceilings, not resource grants. */
export const HTTPS_COORDINATOR_LIMITS = Object.freeze({
  enrollments: 64, origins: 16, connections: 32, sessions: 16, sessionsPerPrincipal: 4,
  peersPerSession: 8, peersPerPrincipal: 16, requestsPerSecond: 32, callerPendingRequests: 4,
  requestBytes: 401_024, responseBytes: 401_024, signalCharacters: 400_000,
  sessionTtlMs: 600_000, requestTimeoutMs: 5_000, headersTimeoutMs: 3_000,
});
export interface CoordinatorEnrollment {
  readonly principalId: string;
  readonly deviceId: string;
  readonly certificatePem: string;
}
export interface HttpsCoordinatorOptions {
  readonly serverCertificatePem: string;
  readonly serverPrivateKeyPem: string;
  readonly clientCaCertificatePem: string;
  readonly allowedOrigins: readonly string[];
  readonly enrollments: readonly CoordinatorEnrollment[];
  /** The selected local profile always binds 127.0.0.1. Zero requests an ephemeral port. */
  readonly port?: number;
}
export interface CoordinatorFetcherOptions {
  readonly endpoint: string;
  readonly origin: string;
  readonly caCertificatePem: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}
interface Enrollment { principalId: string; deviceId: string; certificate: X509Certificate; }
interface Session { principalId: string; created: CreatedSignalingSession; peers: Map<string, { principalId: string; token: string }>; }
class Rejection extends Error {
  readonly status: number;
  constructor(status: number) { super("Coordinator request rejected"); this.status = status; }
}

/**
 * Native TLS authenticates the channel; the enrollment snapshot binds it to a principal.
 * Invitation/role bearers authorize only private rendezvous. Device-resource consent stays separate.
 * Ephemeral authority is destroyed by stop; this profile has no account or enrollment lifecycle API.
 */
export function createHttpsCoordinator(options: HttpsCoordinatorOptions) {
  const values = ownData(options, ["serverCertificatePem", "serverPrivateKeyPem", "clientCaCertificatePem", "allowedOrigins", "enrollments", "port"]);
  const certPem = pem(values.serverCertificatePem);
  const keyPem = pem(values.serverPrivateKeyPem);
  const caPem = pem(values.clientCaCertificatePem);
  const ca = certificate(caPem, true);
  const certificateValue = certificate(certPem, false);
  validateIssued(certificateValue, ca, "serverAuth");
  if (!certificateValue.checkIP("127.0.0.1") || !certificateValue.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("Invalid coordinator TLS configuration");
  createSecureContext({ cert: certPem, key: keyPem, ca: caPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
  const port = values.port ?? 0;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid coordinator port");
  const origins = new Set(boundedArray(values.allowedOrigins, HTTPS_COORDINATOR_LIMITS.origins).map(canonicalOrigin));
  if (!origins.size || origins.size !== (values.allowedOrigins as unknown[]).length) throw new Error("Invalid coordinator origins");
  const enrolled = new Map<string, Enrollment>();
  const principals = new Set<string>();
  const devices = new Set<string>();
  for (const entry of boundedArray(values.enrollments, HTTPS_COORDINATOR_LIMITS.enrollments)) {
    const value = ownData(entry, ["principalId", "deviceId", "certificatePem"]);
    const principalId = identifier(value.principalId);
    const deviceId = identifier(value.deviceId);
    const cert = certificate(pem(value.certificatePem), false);
    validateIssued(cert, ca, "clientAuth");
    if (enrolled.has(cert.fingerprint256) || principals.has(principalId) || devices.has(deviceId)) throw new Error("Duplicate coordinator enrollment");
    enrolled.set(cert.fingerprint256, { principalId, deviceId, certificate: cert });
    principals.add(principalId); devices.add(deviceId);
  }
  if (!enrolled.size) throw new Error("Missing coordinator enrollment");
  const sessions = new Map<string, Session>();
  const broker = new LocalSignalingBroker();
  const rates = new Map<string, { second: number; count: number }>();
  const sockets = new Set<Duplex>();
  let server: Server | undefined;
  let endpoint: string | undefined;
  let starting: Promise<string> | undefined;
  let binding = Promise.resolve();
  let rejectStart: ((cause: Error) => void) | undefined;
  let stopping: Promise<void> | undefined;
  let closed = false;

  function retireExpired() {
    for (const id of broker.expire()) sessions.delete(id);
    for (const [id, session] of sessions) {
      const livePeers = new Set(broker.listPeers(id, session.created.hostToken).map((peer) => peer.peerId));
      for (const peerId of session.peers.keys()) if (!livePeers.has(peerId)) session.peers.delete(peerId);
    }
  }
  function sessionFor(id: string, identity: Enrollment, host: boolean, peerId?: string): Session {
    const session = sessions.get(id);
    if (!session || (host ? session.principalId !== identity.principalId : session.peers.get(peerId ?? "")?.principalId !== identity.principalId)) throw new Rejection(404);
    return session;
  }
  function authenticate(incoming: IncomingMessage): Enrollment {
    const socket = incoming.socket as TLSSocket;
    const peer = socket.getPeerCertificate();
    const identity = peer.fingerprint256 ? enrolled.get(peer.fingerprint256) : undefined;
    if (closed || !socket.authorized || socket.getProtocol() !== "TLSv1.3" || !identity || !validAt(identity.certificate) || !validAt(certificateValue) || !validAt(ca)) throw new Rejection(401);
    return identity;
  }
  function rate(identity: Enrollment) {
    const second = Math.floor(Date.now() / 1000);
    let bucket = rates.get(identity.principalId);
    if (!bucket || bucket.second !== second) { bucket = { second, count: 0 }; rates.set(identity.principalId, bucket); }
    if (++bucket.count > HTTPS_COORDINATOR_LIMITS.requestsPerSecond) throw new Rejection(429);
  }
  async function handle(incoming: IncomingMessage, outgoing: ServerResponse) {
    outgoing.setHeader("Cache-Control", "no-store");
    try {
      const identity = authenticate(incoming);
      const origin = incoming.headers.origin;
      if (typeof origin !== "string" || !origins.has(origin)) throw new Rejection(403);
      outgoing.setHeader("Access-Control-Allow-Origin", origin);
      outgoing.setHeader("Vary", "Origin");
      outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      outgoing.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      rate(identity);
      // No proxy headers, arbitrary endpoint or URL normalization may select another namespace.
      if (!incoming.url || incoming.url.length > 512 || !/^\/v1\/(?:health|sessions(?:\/[A-Za-z0-9._-]+)*)$/.test(incoming.url)) throw new Rejection(404);
      const parts = incoming.url.split("/");
      if (incoming.method === "OPTIONS") return finish(outgoing, 204);
      if (incoming.method === "GET" && incoming.url === "/v1/health") return finish(outgoing, 200, { service: "101-https-coordinator", version: 1 });
      const body = ["POST", "PUT"].includes(incoming.method ?? "") ? await readBody(incoming) : undefined;
      if (closed || !endpoint || incoming.aborted || incoming.socket.destroyed || outgoing.destroyed) throw new Rejection(503);
      // Certificate validity and origin/authentication are rechecked after asynchronous body input.
      authenticate(incoming);
      retireExpired();
      if (incoming.method === "POST" && incoming.url === "/v1/sessions") {
        const value = objectBody(body, ["sessionId", "hostName", "ttlMs", "endpoint"]);
        const sessionId = sessionIdentifier(value.sessionId);
        const hostName = value.hostName === undefined ? undefined : label(value.hostName);
        const ttlMs = value.ttlMs ?? HTTPS_COORDINATOR_LIMITS.sessionTtlMs;
        if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > HTTPS_COORDINATOR_LIMITS.sessionTtlMs || (value.endpoint !== undefined && value.endpoint !== endpoint)) throw new Rejection(400);
        const existing = sessions.get(sessionId);
        if (existing) {
          if (existing.principalId !== identity.principalId) throw new Rejection(404);
          const token = bearer(incoming);
          const created = broker.resumeSession(sessionId, token, { endpoint, hostName });
          existing.created = created;
          return finish(outgoing, 201, created);
        }
        if (sessions.size >= HTTPS_COORDINATOR_LIMITS.sessions || [...sessions.values()].filter((item) => item.principalId === identity.principalId).length >= HTTPS_COORDINATOR_LIMITS.sessionsPerPrincipal) throw new Rejection(429);
        const created = broker.createSession({ sessionId, endpoint, hostName, ttlMs });
        sessions.set(sessionId, { principalId: identity.principalId, created, peers: new Map() });
        return finish(outgoing, 201, created);
      }
      if (parts[2] !== "sessions" || !parts[3]) throw new Rejection(404);
      const id = sessionIdentifier(parts[3]);
      const token = bearer(incoming);
      if (incoming.method === "POST" && parts.length === 5 && parts[4] === "peers") {
        const session = sessions.get(id);
        // Invitation validity is checked by the broker before any new lease exists.
        if (!session || !sameToken(session.created.ticket.joinToken, token)) throw new Rejection(404);
        const device = objectBody(body, ["deviceId", "label", "capabilities"]);
        if (device.deviceId !== identity.deviceId) throw new Rejection(400);
        const capabilities = objectBody(device.capabilities, [...CAPABILITY_NAMES]) as DeviceCapabilities;
        if (Object.values(capabilities).some((value) => typeof value !== "boolean")) throw new Rejection(400);
        const deviceLabel = label(device.label);
        const ownerPeers = [...sessions.values()].reduce((count, item) => count + [...item.peers.values()].filter((lease) => lease.principalId === identity.principalId).length, 0);
        if (session.peers.size >= HTTPS_COORDINATOR_LIMITS.peersPerSession || ownerPeers >= HTTPS_COORDINATOR_LIMITS.peersPerPrincipal) throw new Rejection(429);
        // Reserve the complete future row before broker.join creates any lease.
        assertHostListFits([...broker.listPeers(id, session.created.hostToken), { peerId: "peer-" + "x".repeat(16), deviceId: identity.deviceId, generation: 1, lastSeenAt: Date.now() }]);
        const lease = broker.join(session.created.ticket, token, { deviceId: identity.deviceId, label: deviceLabel, capabilities });
        session.peers.set(lease.peerId, { principalId: identity.principalId, token: lease.peerToken });
        return finish(outgoing, 201, lease);
      }
      if (parts[4] === "host") {
        const session = sessionFor(id, identity, true);
        if (!sameToken(session.created.hostToken, token)) throw new Rejection(404);
        if (parts[5] !== "peers") throw new Rejection(404);
        if (incoming.method === "GET" && parts.length === 6) return finish(outgoing, 200, broker.listPeers(id, token));
        if (incoming.method === "PUT" && parts.length === 8 && parts[7] === "offer") {
          const value = signalBody(body, "offer");
          responseBody({ generation: Number.MAX_SAFE_INTEGER, offer: value.code, expiresAt: Number.MIN_SAFE_INTEGER });
          broker.publishOffer(id, token, parts[6]!, value.generation, value.code);
          return finish(outgoing, 204);
        }
        if (incoming.method === "POST" && parts.length === 8 && parts[7] === "reconnect") {
          emptyBody(body);
          broker.requestReconnect(id, parts[6]!, token, true);
          return finish(outgoing, 204);
        }
      } else if (parts[4] === "peers" && parts[5]) {
        const peerId = parts[5];
        const session = sessionFor(id, identity, false, peerId);
        if (!sameToken(session.peers.get(peerId)!.token, token)) throw new Rejection(404);
        if (incoming.method === "GET" && parts.length === 7 && parts[6] === "offer") return finish(outgoing, 200, broker.getOffer(id, peerId, token));
        if (incoming.method === "PUT" && parts.length === 7 && parts[6] === "answer") {
          const value = signalBody(body, "answer");
          // Exact escaped UTF8 plus complete metadata; no rejected answer is retained.
          assertHostListFits(broker.listPeers(id, session.created.hostToken).map((peer) => peer.peerId === peerId ? { ...peer, answer: value.code } : peer));
          broker.publishAnswer(id, peerId, token, value.generation, value.code);
          return finish(outgoing, 204);
        }
        if (incoming.method === "POST" && parts.length === 7 && parts[6] === "reconnect") {
          emptyBody(body);
          return finish(outgoing, 200, broker.requestReconnect(id, peerId, token));
        }
        if (incoming.method === "DELETE" && parts.length === 6) {
          broker.leave(id, peerId, token); session.peers.delete(peerId);
          return finish(outgoing, 204);
        }
      }
      throw new Rejection(404);
    } catch (cause) {
      const status = cause instanceof Rejection ? cause.status : 404;
      finish(outgoing, status, { error: status === 404 ? "Not found" : "Request rejected" });
    }
  }
  return {
    get url() { if (!endpoint || closed) throw new Error("Start coordinator; closed coordinators cannot restart"); return endpoint; },
    start(): Promise<string> {
      if (closed) return Promise.reject(new Error("Coordinator closed"));
      if (endpoint) return Promise.resolve(endpoint);
      if (starting) return starting;
      const active = createServer({ key: keyPem, cert: certPem, ca: caPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true, handshakeTimeout: 3000, maxHeaderSize: 4096, connectionsCheckingInterval: 1000 }, (incoming, outgoing) => { void handle(incoming, outgoing); });
      server = active;
      active.requestTimeout = HTTPS_COORDINATOR_LIMITS.requestTimeoutMs;
      active.headersTimeout = HTTPS_COORDINATOR_LIMITS.headersTimeoutMs;
      active.keepAliveTimeout = 1000;
      active.maxRequestsPerSocket = 64;
      active.maxConnections = HTTPS_COORDINATOR_LIMITS.connections;
      active.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      active.on("tlsClientError", (_cause, socket) => socket.destroy());
      active.on("clientError", (_cause, socket) => socket.destroy());
      let bound: () => void;
      binding = new Promise<void>((resolve) => { bound = resolve; });
      starting = new Promise<string>((resolve, reject) => {
        rejectStart = reject;
        active.once("error", (cause) => { bound(); reject(cause); });
        active.listen(port, "127.0.0.1", () => {
          bound();
          rejectStart = undefined;
          const address = active.address();
          if (closed || !address || typeof address === "string") { reject(new Error("Coordinator closed")); return; }
          endpoint = `https://127.0.0.1:${address.port}`;
          resolve(endpoint);
        });
      }).catch(async () => { await stop(); throw new Error("Coordinator startup rejected"); });
      return starting;
    },
    stop,
  };
  function stop(): Promise<void> {
    if (stopping) return stopping;
    closed = true;
    rejectStart?.(new Error("Coordinator closed"));
    rejectStart = undefined;
    endpoint = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const id of broker.expire()) sessions.delete(id);
    for (const [id, session] of sessions) {
      try { broker.removeSession(id, session.created.hostToken); } catch { /* Expiry already removed broker authority. */ }
    }
    sessions.clear(); rates.clear(); enrolled.clear();
    const active = server;
    server = undefined;
    if (!active) return Promise.resolve();
    stopping = binding.then(() => new Promise<void>((resolve) => { active.close(() => resolve()); active.closeAllConnections(); }));
    return stopping;
  }
}

/** A Node-only, bounded, same-origin mTLS fetch subset for the existing pairing clients. */
export function createCoordinatorFetcher(options: CoordinatorFetcherOptions): { fetch: typeof fetch; close(): void } {
  const values = ownData(options, ["endpoint", "origin", "caCertificatePem", "certificatePem", "privateKeyPem"]);
  const endpoint = canonicalOrigin(values.endpoint);
  const url = new URL(endpoint);
  if (url.hostname !== "127.0.0.1" || !url.port) throw new Error("Coordinator caller requires loopback HTTPS");
  const origin = canonicalOrigin(values.origin);
  const caPem = pem(values.caCertificatePem);
  const certPem = pem(values.certificatePem);
  const keyPem = pem(values.privateKeyPem);
  const ca = certificate(caPem, true);
  const cert = certificate(certPem, false);
  validateIssued(cert, ca, "clientAuth");
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("Invalid caller TLS configuration");
  const agent = new Agent({ ca: caPem, cert: certPem, key: keyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true, keepAlive: true, maxSockets: 4, maxTotalSockets: 4, maxFreeSockets: 1 });
  const pending = new Set<ReturnType<typeof httpsRequest>>();
  let closed = false;
  let reserved = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    if (reserved >= HTTPS_COORDINATOR_LIMITS.callerPendingRequests) throw new Error("Coordinator caller pending capacity exceeded");
    // Reserve before URL, init and header conversions can invoke caller code.
    reserved++;
    try {
      if (closed || !validAt(cert) || !validAt(ca)) throw new Error("Coordinator caller closed or expired");
      if (typeof input !== "string" && !(input instanceof URL)) throw new Error("Coordinator caller requires a URL");
      const target = new URL(input);
      if (target.origin !== endpoint || target.username || target.password || target.hash || target.search || !target.pathname.startsWith("/v1/")) throw new Error("Coordinator caller rejects destination");
      const requestValues = ownData(init, ["method", "headers", "body", "signal", "redirect"]);
      if (requestValues.redirect !== undefined && requestValues.redirect !== "manual") throw new Error("Coordinator caller rejects redirects");
      const method = requestValues.method ?? "GET";
      if (typeof method !== "string" || !["GET", "POST", "PUT", "DELETE", "OPTIONS"].includes(method)) throw new Error("Coordinator caller rejects method");
      const headers = new Headers(requestValues.headers as HeadersInit | undefined);
      for (const [name] of headers) if (!["content-type", "authorization"].includes(name)) throw new Error("Coordinator caller rejects headers");
      if (headers.get("content-type") && headers.get("content-type") !== "application/json") throw new Error("Coordinator caller rejects content type");
      headers.set("Origin", origin);
      const body = requestValues.body;
      if (body !== undefined && (typeof body !== "string" || Buffer.byteLength(body) > HTTPS_COORDINATOR_LIMITS.requestBytes)) throw new Error("Coordinator caller rejects body");
      const signal = requestValues.signal as AbortSignal | undefined;
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("Coordinator caller rejects signal");
      if (signal?.aborted) throw new Error("Coordinator caller aborted");
      const wireHeaders = Object.fromEntries(headers);
      if (closed || !validAt(cert) || !validAt(ca)) throw new Error("Coordinator caller closed or expired");
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = httpsRequest(target, { method, agent, headers: wireHeaders, signal }, (incoming) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > HTTPS_COORDINATOR_LIMITS.responseBytes) outgoing.destroy(new Error("Coordinator response too large")); else chunks.push(chunk); });
          incoming.once("error", () => reject(new Error("Coordinator response failed")));
          incoming.once("end", () => {
            if (closed || !incoming.complete) { reject(new Error("Coordinator caller closed")); return; }
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
          });
        });
        pending.add(outgoing);
        outgoing.once("close", () => pending.delete(outgoing));
        outgoing.once("error", () => reject(new Error("Coordinator HTTPS request failed")));
        outgoing.setTimeout(HTTPS_COORDINATOR_LIMITS.requestTimeoutMs, () => outgoing.destroy(new Error("Coordinator request timeout")));
        if (closed || !validAt(cert) || !validAt(ca)) { outgoing.destroy(new Error("Coordinator caller closed or expired")); return; }
        outgoing.end(body as string | undefined);
      });
    } finally { reserved--; }
  };
  return { fetch: fetcher, close() { closed = true; for (const outgoing of pending) outgoing.destroy(); pending.clear(); agent.destroy(); } };
}

function ownData(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid coordinator configuration");
  if (Object.getOwnPropertySymbols(input).length || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Invalid coordinator configuration");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output: Record<string, unknown> = Object.create(null);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!allowed.includes(name) || !("value" in descriptor)) throw new Error("Invalid coordinator configuration");
    output[name] = descriptor.value;
  }
  return output;
}
function boundedArray(value: unknown, count: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > count || Object.keys(value).length !== value.length) throw new Error("Invalid coordinator list");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_item, index) => { const descriptor = descriptors[String(index)]; if (!descriptor || !("value" in descriptor)) throw new Error("Invalid coordinator list"); return descriptor.value; });
}
function pem(value: unknown): string {
  if (typeof value !== "string" || value.length < 64 || value.length > 16_384) throw new Error("Invalid coordinator TLS configuration");
  return value;
}
function certificate(value: string, ca: boolean): X509Certificate {
  const cert = new X509Certificate(value);
  if (cert.ca !== ca || !validAt(cert)) throw new Error("Invalid coordinator certificate");
  return cert;
}
function validAt(cert: X509Certificate): boolean { const now = Date.now(); return Number.isFinite(now) && Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo); }
function validateIssued(cert: X509Certificate, ca: X509Certificate, purpose: "serverAuth" | "clientAuth") {
  const oid = purpose === "serverAuth" ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2";
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey) || !cert.keyUsage?.includes(oid)) throw new Error("Invalid coordinator certificate issuer or purpose");
}
function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new Error("Invalid coordinator origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== value) throw new Error("Invalid coordinator origin");
  return url.origin;
}
function identifier(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error("Invalid coordinator identity"); return value; }
function sessionIdentifier(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9-]{4,128}$/.test(value)) throw new Rejection(400); return value; }
function label(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 128 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Rejection(400); return value; }
function objectBody(value: unknown, fields: readonly string[]): Record<string, unknown> { try { return ownData(value, fields); } catch { throw new Rejection(400); } }
function emptyBody(body: unknown) { if (body !== undefined && Object.keys(objectBody(body, [])).length) throw new Rejection(400); }
function signalBody(body: unknown, type: "offer" | "answer") {
  const value = objectBody(body, ["generation", type]);
  const code = value[type];
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1 || typeof code !== "string" || !code.startsWith("101") || code.length < 8 || code.length > HTTPS_COORDINATOR_LIMITS.signalCharacters) throw new Rejection(400);
  return { generation: value.generation, code };
}
function sameToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected); const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value || !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(value)) throw new Rejection(404);
  return value.slice(7);
}
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const finish = (cause?: Rejection) => { if (settled) return; settled = true; if (cause) reject(cause); else { try { resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); } catch { reject(new Rejection(400)); } } };
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > HTTPS_COORDINATOR_LIMITS.requestBytes) { chunks.length = 0; finish(new Rejection(413)); } else if (!settled) chunks.push(chunk); });
    request.once("end", () => finish());
    request.once("aborted", () => finish(new Rejection(400)));
    request.once("error", () => finish(new Rejection(400)));
    const length = request.headers["content-length"];
    if (length && Number(length) > HTTPS_COORDINATOR_LIMITS.requestBytes) finish(new Rejection(413));
    const type = request.headers["content-type"];
    if (type !== undefined && type !== "application/json") finish(new Rejection(400));
  });
}
function assertHostListFits(peers: readonly HostPeerSignal[]) {
  // Generation and lastSeenAt can grow without an answer replacement. Reserve
  // their complete safe-integer JSON widths, including a signed timestamp.
  responseBody(peers.map((peer) => ({ ...peer, generation: Number.MAX_SAFE_INTEGER, lastSeenAt: Number.MIN_SAFE_INTEGER })));
}
function responseBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > HTTPS_COORDINATOR_LIMITS.responseBytes) throw new Rejection(429);
  return body;
}
function finish(response: ServerResponse, status: number, value?: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  if (value === undefined) response.end();
  else { response.setHeader("Content-Type", "application/json"); response.end(responseBody(value)); }
}
