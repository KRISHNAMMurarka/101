import { Agent, request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import { createHash, createPrivateKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { parsePrivateDirectorySnapshot, privateDirectoryCandidates, PRIVATE_DIRECTORY_LIMITS } from '@101/device-model';
import type { DiscoveryCandidate, PrivateDirectorySnapshot } from '@101/device-model';
import type { CoordinatorFetcherOptions } from './https-coordinator.ts';

export const GATEWAY_INVENTORY_PROFILE = 'authorized-node-agent-gateway-inventory/1' as const;
export const GATEWAY_INVENTORY_LIMITS = Object.freeze({ pending: 1, attempts: 64, burst: 4, refillMs: 1000,
  deadlineMs: 2500, grantMs: 5000, responseBytes: PRIVATE_DIRECTORY_LIMITS.responseBytes, chunks: 128,
  resources: PRIVATE_DIRECTORY_LIMITS.resourcesPerSession, capabilities: PRIVATE_DIRECTORY_LIMITS.capabilitiesPerResource,
  advertisedTtlMs: PRIVATE_DIRECTORY_LIMITS.ttlMs });
export interface GatewayInventoryApprovalRequest {
  readonly action: 'list'; readonly method: 'GET'; readonly profile: typeof GATEWAY_INVENTORY_PROFILE;
  readonly ownerId: string; readonly gatewayId: string; readonly endpoint: string;
  readonly serverCertificateSha256: string; readonly clientCertificateSha256: string;
  readonly sessionId: string; readonly peerId: string; readonly purpose: string;
}
/** Approval expiry uses the host performance.now() domain, separately from directory wall-clock expiry. */
export interface GatewayInventoryApproval {
  readonly request: GatewayInventoryApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number;
}
export interface GatewayInventoryOptions extends CoordinatorFetcherOptions {
  readonly ownerId: string; readonly gatewayId: string; readonly serverCertificateSha256: string;
  readonly sessionId: string; readonly peerId: string; readonly token: string; readonly signal: AbortSignal;
  readonly authorizeInventory: (request: GatewayInventoryApprovalRequest) => GatewayInventoryApproval | undefined;
}
export type GatewayInventoryFailure = 'invalid' | 'denied' | 'busy' | 'closed' | 'cancelled' | 'expired' |
  'rate' | 'quota' | 'unavailable' | 'invalid-response';
export interface GatewayInventorySnapshot {
  readonly gatewayId: string; readonly snapshot: PrivateDirectorySnapshot; readonly candidates: readonly DiscoveryCandidate[];
}
export type GatewayInventoryResult = Readonly<{ ok: true; value: GatewayInventorySnapshot }> |
  Readonly<{ ok: false; reason: GatewayInventoryFailure }>;
export interface GatewayInventoryConnector {
  list(request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<GatewayInventoryResult>;
  cancelPending(): void; close(): Promise<void>;
  status(): Readonly<{ profile: typeof GATEWAY_INVENTORY_PROFILE; closed: boolean; pending: boolean; rawPending: number;
    attempts: number; networkRequests: number; completed: number; timers: number }>;
}

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
function isAborted(signal: AbortSignal): boolean { return Reflect.apply(aborted, signal, []) as boolean; }
function actualSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return;
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(properties).length !== keys.length || Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(properties)) { if (!descriptor.enumerable || !('value' in descriptor)) return; result[key] = descriptor.value; }
  return result;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const purpose = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value &&
  [...value].every(character => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const failure = (reason: GatewayInventoryFailure): GatewayInventoryResult => Object.freeze({ ok: false, reason });
interface Pending {
  epoch: number; deadline: number; grant?: GatewayInventoryApproval; signal?: AbortSignal; reason?: GatewayInventoryFailure;
  agent?: Agent; outgoing?: ClientRequest; incoming?: IncomingMessage; socket?: Duplex;
  requestClosed: boolean; incomingClosed: boolean; socketClosed: boolean; ended: boolean;
  timer?: ReturnType<typeof setTimeout>; done: Promise<void>; finish: () => void; removals: (() => void)[];
}

/** Explicit read-only software gateway profile. No scan, fallback, URL selection,
 * metadata cache or resource grant. Synchronous host callbacks are trusted code
 * and cannot be preempted. Returned hints are inert and cannot be recalled. */
export function createGatewayInventoryConnector(input: GatewayInventoryOptions): GatewayInventoryConnector {
  const option = fields(input, ['endpoint', 'origin', 'caCertificatePem', 'certificatePem', 'privateKeyPem', 'ownerId', 'gatewayId',
    'serverCertificateSha256', 'sessionId', 'peerId', 'token', 'signal', 'authorizeInventory']);
  if (!option || ![option.ownerId, option.gatewayId, option.sessionId, option.peerId].every(identifier) || !actualSignal(option.signal) ||
    typeof option.authorizeInventory !== 'function' || typeof option.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(option.token) ||
    typeof option.serverCertificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(option.serverCertificateSha256)) throw new TypeError('Invalid gateway inventory configuration');
  const selected = Object.freeze(option), owner = selected.signal as AbortSignal, authorize = selected.authorizeInventory as GatewayInventoryOptions['authorizeInventory'];
  function origin(value: unknown): string {
    if (typeof value !== 'string' || value.length > 256) throw new TypeError('Invalid gateway inventory origin');
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value) throw new TypeError('Invalid gateway inventory origin');
    return value;
  }
  const endpoint = origin(selected.endpoint), selectedOrigin = origin(selected.origin), url = new URL(endpoint);
  if (url.hostname !== '127.0.0.1' || !url.port) throw new TypeError('Gateway inventory requires selected loopback HTTPS');
  function pem(value: unknown): string { if (typeof value !== 'string' || value.length < 64 || value.length > 16384) throw new TypeError('Invalid gateway inventory credentials'); return value; }
  const caPem = pem(selected.caCertificatePem), certPem = pem(selected.certificatePem), keyPem = pem(selected.privateKeyPem);
  const ca = new X509Certificate(caPem), cert = new X509Certificate(certPem), serverPin = Buffer.from(selected.serverCertificateSha256 as string, 'hex');
  if (!ca.ca || cert.ca || !cert.checkIssued(ca) || !cert.verify(ca.publicKey) || !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
    !cert.checkPrivateKey(createPrivateKey(keyPem))) throw new TypeError('Invalid gateway inventory credentials');
  const destination = endpoint + `/v1/sessions/${selected.sessionId}/peers/${selected.peerId}/directory`;
  let closed = isAborted(owner), epoch = 0, pending: Pending | undefined, attempts = 0, networkRequests = 0, completed = 0;
  let lastClock = -1, lastWall = -1, refillAt = -1;
  let tokens: number = GATEWAY_INVENTORY_LIMITS.burst;
  function watch(signal: AbortSignal, callback: () => void): () => void {
    Reflect.apply(add, signal, ['abort', callback, { once: true }]);
    return () => { Reflect.apply(remove, signal, ['abort', callback]); };
  }
  function cancel(record: Pending, reason: GatewayInventoryFailure): void {
    record.reason ??= reason;
    record.outgoing?.destroy(); record.incoming?.destroy(); record.socket?.destroy(); record.agent?.destroy();
  }
  function cancelPending(): void { epoch++; if (pending) cancel(pending, 'cancelled'); }
  let removeOwner: (() => void) | undefined;
  function close(): Promise<void> {
    if (!closed) { closed = true; epoch++; removeOwner?.(); removeOwner = undefined; if (pending) cancel(pending, 'closed'); }
    return pending?.done ?? Promise.resolve();
  }
  function time(): { clock: number; wall: number } | undefined {
    let clock: number, wall: number;
    try { clock = performance.now(); wall = Date.now(); } catch { void close(); return; }
    if (closed || !Number.isFinite(clock) || clock < 0 || clock > Number.MAX_SAFE_INTEGER - 5000 || clock < lastClock ||
      !Number.isSafeInteger(wall) || wall < 0 || wall < lastWall ||
      wall < Date.parse(ca.validFrom) || wall >= Date.parse(ca.validTo) || wall < Date.parse(cert.validFrom) || wall >= Date.parse(cert.validTo)) { void close(); return; }
    lastClock = clock; lastWall = wall; return { clock, wall };
  }
  function current(record: Pending): boolean {
    return !closed && pending === record && record.epoch === epoch && !record.reason && !isAborted(owner) &&
      (!record.signal || !isAborted(record.signal)) && (!record.grant || !isAborted(record.grant.signal));
  }
  function check(record: Pending): boolean {
    const at = time();
    if (!current(record)) return false;
    if (!at || at.clock >= record.deadline || record.grant && at.clock >= record.grant.expiresAt) { cancel(record, 'expired'); return false; }
    return true;
  }
  function reason(record: Pending): GatewayInventoryFailure { return closed ? 'closed' : record.reason ?? 'cancelled'; }
  if (!closed) removeOwner = watch(owner, () => { void close(); });

  async function nativeRead(record: Pending): Promise<Buffer | undefined> {
    let bytes: Buffer | undefined;
    await new Promise<void>(resolve => {
      const settled = () => { if (record.requestClosed && (!record.incoming || record.incomingClosed) && (!record.socket || record.socketClosed)) resolve(); };
      class OwnedAgent extends Agent {
        override createConnection(...args: Parameters<Agent['createConnection']>): ReturnType<Agent['createConnection']> {
          const socket = super.createConnection(...args);
          if (socket) {
            // The request's socket event is asynchronous and may never arrive
            // after immediate cancellation. Own native creation independently.
            record.socket = socket;
            socket.once('close', () => { record.socketClosed = true; settled(); });
          }
          return socket;
        }
      }
      let agent: Agent;
      let outgoing: ClientRequest;
      try {
        agent = new OwnedAgent({ ca: caPem, cert: certPem, key: keyPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true,
          keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 0,
          checkServerIdentity(host, peer) {
            const ordinary = checkServerIdentity(host, peer);
            if (ordinary || !check(record) || !peer.raw || !timingSafeEqual(Buffer.from(hash(peer.raw), 'hex'), serverPin)) return new Error('Gateway identity rejected');
          } });
        record.agent = agent;
        outgoing = httpsRequest(destination, { agent, method: 'GET', headers: { Origin: selectedOrigin,
          Authorization: `Bearer ${selected.token}` } }, incoming => {
          record.incoming = incoming;
          incoming.once('close', () => { record.incomingClosed = true; if (!record.ended && !record.reason) cancel(record, 'unavailable'); settled(); });
          incoming.once('error', () => { cancel(record, 'unavailable'); });
          if (!check(record)) { cancel(record, reason(record)); return; }
          if (incoming.statusCode !== 200) { cancel(record, [401, 403, 404].includes(incoming.statusCode ?? 0) ? 'denied' : incoming.statusCode === 429 ? 'rate' : 'invalid-response'); return; }
          if (incoming.headers['content-type'] !== 'application/json') { cancel(record, 'invalid-response'); return; }
          const declaredLength = incoming.headers['content-length'];
          if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > GATEWAY_INVENTORY_LIMITS.responseBytes)) { cancel(record, 'invalid-response'); return; }
          const chunks: Buffer[] = []; let size = 0, turns = 0;
          incoming.on('data', (chunk: Buffer) => {
            if (!check(record)) { cancel(record, reason(record)); return; }
            size += chunk.byteLength;
            if (++turns > GATEWAY_INVENTORY_LIMITS.chunks || size > GATEWAY_INVENTORY_LIMITS.responseBytes) { cancel(record, 'invalid-response'); return; }
            chunks.push(chunk);
          });
          incoming.once('end', () => {
            record.ended = true;
            if (check(record) && incoming.complete) bytes = Buffer.concat(chunks, size); else cancel(record, reason(record));
            agent.destroy();
          });
        });
      } catch { record.requestClosed = true; cancel(record, 'unavailable'); settled(); return; }
      record.outgoing = outgoing; networkRequests++;
      outgoing.once('error', () => { cancel(record, 'unavailable'); });
      outgoing.once('close', () => { record.requestClosed = true; if (!record.ended && !record.reason) cancel(record, 'unavailable'); settled(); });
      if (!check(record)) cancel(record, reason(record)); else outgoing.end();
    });
    return bytes;
  }

  async function list(raw: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<GatewayInventoryResult> {
    if (closed) return failure('closed');
    if (pending) return failure('busy');
    if (attempts >= GATEWAY_INVENTORY_LIMITS.attempts) return failure('quota');
    let finish!: () => void;
    const record: Pending = { epoch, deadline: Infinity, requestClosed: false, incomingClosed: false, socketClosed: false,
      ended: false, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(), removals: [] };
    pending = record; attempts++;
    try {
      const value = fields(raw, ['purpose', 'signal']);
      if (!current(record)) return failure(reason(record));
      if (!value || !purpose(value.purpose) || !actualSignal(value.signal)) return failure('invalid');
      record.signal = value.signal;
      if (!current(record)) return failure(reason(record));
      const at = time(); if (!at || !current(record)) return failure(reason(record));
      record.deadline = at.clock + GATEWAY_INVENTORY_LIMITS.deadlineMs;
      if (refillAt < 0) refillAt = at.clock;
      const refill = Math.floor((at.clock - refillAt) / GATEWAY_INVENTORY_LIMITS.refillMs);
      if (refill) { tokens = Math.min(GATEWAY_INVENTORY_LIMITS.burst, tokens + refill); refillAt += refill * GATEWAY_INVENTORY_LIMITS.refillMs; }
      if (!tokens) return failure('rate'); tokens--;
      const request: GatewayInventoryApprovalRequest = Object.freeze({ action: 'list', method: 'GET', profile: GATEWAY_INVENTORY_PROFILE,
        ownerId: selected.ownerId as string, gatewayId: selected.gatewayId as string, endpoint, serverCertificateSha256: selected.serverCertificateSha256 as string,
        clientCertificateSha256: hash(cert.raw), sessionId: selected.sessionId as string, peerId: selected.peerId as string, purpose: value.purpose });
      let approval: Record<string, unknown> | undefined;
      try { approval = fields(authorize(request), ['request', 'signal', 'expiresAt']); } catch { /* fixed denial */ }
      if (!check(record)) return failure(reason(record));
      const after = time(); if (!after || !current(record)) return failure(reason(record));
      if (!approval || approval.request !== request || !actualSignal(approval.signal) || isAborted(approval.signal) ||
        typeof approval.expiresAt !== 'number' || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= after.clock ||
        approval.expiresAt > after.clock + GATEWAY_INVENTORY_LIMITS.grantMs) return failure('denied');
      record.grant = Object.freeze({ request, signal: approval.signal, expiresAt: approval.expiresAt });
      record.removals.push(watch(record.signal, () => { cancel(record, 'cancelled'); }), watch(record.grant.signal, () => { cancel(record, 'cancelled'); }));
      if (!check(record)) return failure(reason(record));
      record.timer = setTimeout(() => { record.timer = undefined; cancel(record, 'expired'); }, Math.max(1, Math.min(record.deadline, record.grant.expiresAt) - after.clock));
      if (!check(record)) return failure(reason(record));
      const bytes = await nativeRead(record);
      if (!check(record) || !bytes) return failure(record.reason ?? reason(record));
      let snapshot: PrivateDirectorySnapshot;
      try { snapshot = parsePrivateDirectorySnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { return failure('invalid-response'); }
      const finalTime = time(); if (!finalTime || !current(record) || !check(record)) return failure(reason(record));
      if (snapshot.scope.id !== selected.sessionId || snapshot.issuedAt > finalTime.wall) return failure('invalid-response');
      if (snapshot.expiresAt <= finalTime.wall) return failure('expired');
      const candidates = privateDirectoryCandidates(snapshot, `gateway-inventory-${attempts}`);
      if (!check(record)) return failure(reason(record));
      completed++;
      return Object.freeze({ ok: true, value: Object.freeze({ gatewayId: selected.gatewayId as string, snapshot, candidates }) });
    } catch { return failure(record.reason ?? (closed ? 'closed' : 'invalid')); }
    finally {
      if (record.timer !== undefined) clearTimeout(record.timer);
      record.timer = undefined; for (const unwatch of record.removals) unwatch(); record.removals.length = 0;
      record.agent?.destroy(); if (pending === record) pending = undefined; record.finish();
    }
  }
  return Object.freeze({ list, cancelPending, close, status: () => Object.freeze({ profile: GATEWAY_INVENTORY_PROFILE, closed,
    pending: pending !== undefined, rawPending: Number(pending?.outgoing !== undefined || pending?.socket !== undefined), attempts, networkRequests, completed, timers: Number(pending?.timer !== undefined) }) });
}
