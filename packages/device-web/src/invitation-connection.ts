import { SecureWebSocketTransport } from '@101/transport-websocket';
import type { WebSocketPort } from '@101/transport-websocket';
import { AuthenticatedResourcePeer, authenticatedPeerScope } from './authenticated-peer.ts';
import { decodeReceiverInvitationInput, receiverInvitationCurrent } from './invitation.ts';
import type { ReceiverInvitation } from './invitation.ts';
import type { EndpointCrypto, EndpointIdentity } from './identity-types.ts';

export const INVITATION_CONNECTION_PROFILE = 'enrolled-invitation-connection/1';
export const INVITATION_CONNECTION_LIMITS = Object.freeze({ endpoints: 8, inputBytes: 4096, reviewsPerSecond: 8,
  attempts: 32, connectMs: 5000, grantMs: 60000, transitions: 64, tickMs: 20 });
export interface InvitationEndpoint {
  readonly id: string; readonly endpoint: string; readonly remoteKeyId: string; readonly expiresAt: number;
  /** Current independently provisioned enrollment, not a claim made by invitation input. */
  readonly isCurrent: () => boolean;
  /** Native/Node hosts may supply their actual TLS socket adapter. No successful fake backend is qualification. */
  readonly createSocket?: (endpoint: string, subprotocol: string) => WebSocketPort;
}
export interface InvitationReviewHandle { readonly kind: 'invitation-review' }
export interface InvitationConnectionHandle { readonly kind: 'invitation-connection' }
export interface InvitationConnectionScope {
  readonly ownerId: string; readonly endpointId: string; readonly endpoint: string; readonly remoteKeyId: string;
  readonly applicationId: string; readonly sessionId: string; readonly epoch: string; readonly role: 'source';
  readonly invitationExpiresAt: number; readonly deadline: number;
}
export interface InvitationConnectionGrant {
  readonly scope: InvitationConnectionScope; readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal;
}
export type InvitationConnectionFailure = 'invalid' | 'unsupported' | 'stale' | 'busy' | 'denied' | 'revoked' | 'expired' |
  'cancelled' | 'closed' | 'invalid-clock' | 'capacity' | 'unavailable' | 'wrong-endpoint';
export type InvitationConnectionResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: InvitationConnectionFailure }>;
export interface InvitationConnectionOptions {
  readonly ownerId: string; readonly identity: EndpointIdentity; readonly crypto: EndpointCrypto; readonly now: () => number;
  readonly endpoints: readonly InvitationEndpoint[];
  readonly authorizeConnect: (scope: InvitationConnectionScope) => InvitationConnectionGrant | undefined | Promise<InvitationConnectionGrant | undefined>;
}
export interface InvitationConnectionPreview {
  readonly endpointId: string; readonly endpoint: string; readonly remoteKeyId: string; readonly invitation: ReceiverInvitation;
  readonly source: 'manual' | 'link' | 'qr'; readonly backend: 'host-socket' | 'native-websocket' | 'unavailable';
}
export interface InvitationConnectionSnapshot {
  readonly state: 'unknown' | 'reviewing' | 'connecting' | 'connected' | 'unsupported' | 'expired' | 'interrupted' | 'closed';
  readonly outcome: string; readonly pending?: InvitationConnectionPreview; readonly current?: InvitationConnectionScope;
  readonly issuedAttempts: number; readonly unsettledAuthorizations: number; readonly socketReservations: number; readonly timerArmed: boolean;
  readonly transitions: readonly Readonly<{ sequence: number; event: string }>[];
}
export interface InvitationConnectionController {
  /** Manual JSON, copied fragment link and QR-decoded text are inert until explicitly reviewed and connected. */
  review(input: string, choice: { source: 'manual' | 'link' | 'qr'; endpointId: string }): InvitationConnectionResult<InvitationReviewHandle>;
  connect(review: InvitationReviewHandle): Promise<InvitationConnectionResult<InvitationConnectionHandle>>;
  cancel(review: InvitationReviewHandle): InvitationConnectionResult;
  /** Issued authenticated facade only. This does not supply registration, resource approval or runtime route grants. */
  connection(handle: InvitationConnectionHandle): AuthenticatedResourcePeer | undefined;
  disconnect(): void; sweep(): void; snapshot(): InvitationConnectionSnapshot; close(): void;
}
interface Review { readonly handle: InvitationReviewHandle; readonly target: InvitationEndpoint; readonly preview: InvitationConnectionPreview }
interface Attempt {
  readonly review: Review; readonly handle: InvitationConnectionHandle; readonly scope: InvitationConnectionScope;
  readonly abort: AbortController; readonly wallDeadline: number; wallExpiry: number;
  readonly finish: (result: InvitationConnectionResult<InvitationConnectionHandle>) => void;
  grant?: InvitationConnectionGrant; transport?: SecureWebSocketTransport; peer?: AuthenticatedResourcePeer;
  detach: (() => void)[]; completed: boolean;
}
class ConnectionError extends Error { readonly reason: InvitationConnectionFailure; constructor(reason: InvitationConnectionFailure) { super(reason); this.reason = reason; } }
function reject(reason: InvitationConnectionFailure): never { throw new ConnectionError(reason); }
const failure = (reason: InvitationConnectionFailure): InvitationConnectionResult<never> => Object.freeze({ ok: false, reason });
const success = <T = undefined>(value: T = undefined as T): InvitationConnectionResult<T> => Object.freeze({ ok: true, value });
function data(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject('invalid');
  const keys = Reflect.ownKeys(input), result: Record<string, unknown> = {};
  if (required.some(key => !Object.hasOwn(input, key))) reject('invalid');
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) reject('invalid');
    result[key] = descriptor.value;
  }
  return result;
}
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function sameScope(value: unknown, scope: InvitationConnectionScope): boolean {
  try { const copy = data(value, Object.keys(scope)); return Object.keys(scope).every(key => copy[key] === scope[key as keyof InvitationConnectionScope]); } catch { return false; }
}
const wallTime = () => performance.now();

/** A source-side owner for one independently enrolled WSS receiver. No fetching, discovery,
 * persistent authority, automatic reconnect or implicit resource grant. Imports/construction are inert.
 * Trusted synchronous callbacks and native socket methods are not sandboxed or preempted.
 * At most 32 provider/approval attempts can ever be issued; cancellation does not imply raw work settled. */
export function createInvitationConnectionController(input: InvitationConnectionOptions): InvitationConnectionController {
  const options = data(input, ['ownerId', 'identity', 'crypto', 'now', 'endpoints', 'authorizeConnect']);
  if (!id(options.ownerId) || typeof options.now !== 'function' || typeof options.authorizeConnect !== 'function' ||
    !options.identity || !options.crypto || !Array.isArray(options.endpoints) || Object.getPrototypeOf(options.endpoints) !== Array.prototype ||
    options.endpoints.length < 1 || options.endpoints.length > INVITATION_CONNECTION_LIMITS.endpoints ||
    Reflect.ownKeys(options.endpoints).length !== options.endpoints.length + 1) reject('invalid');
  const ownerId = options.ownerId, clock = options.now as () => number, authorize = options.authorizeConnect as InvitationConnectionOptions['authorizeConnect'];
  const identity = options.identity as EndpointIdentity, crypto = options.crypto as EndpointCrypto;
  const endpoints = new Map<string, InvitationEndpoint>();
  for (let index = 0; index < options.endpoints.length; index++) {
    const property = Object.getOwnPropertyDescriptor(options.endpoints, String(index)); if (!property || !('value' in property)) reject('invalid');
    const value = data(property.value, ['id', 'endpoint', 'remoteKeyId', 'expiresAt', 'isCurrent'], ['createSocket']);
    if (!id(value.id) || endpoints.has(value.id) || typeof value.endpoint !== 'string' || typeof value.remoteKeyId !== 'string' || !/^[0-9a-f]{64}$/.test(value.remoteKeyId) ||
      !integer(value.expiresAt) || typeof value.isCurrent !== 'function' || value.createSocket !== undefined && typeof value.createSocket !== 'function') reject('invalid');
    // Reuse the actual transport's closed endpoint validator without connecting or reading a clock.
    new SecureWebSocketTransport({ endpoint: value.endpoint, side: 'client', now: clock });
    endpoints.set(value.id, Object.freeze({ ...value, endpoint: new URL(value.endpoint).href }) as unknown as InvitationEndpoint);
  }
  let closed = false, readingClock = false, busy = false, lastNow = -1, issuedAttempts = 0, unsettled = 0;
  let review: Review | undefined, pending: Attempt | undefined, current: Attempt | undefined;
  let outcome = 'unknown', timer: ReturnType<typeof setTimeout> | undefined, sequence = 0, windowAt = -1, reviews = 0;
  const sockets = new Set<object>(), transitions: { sequence: number; event: string }[] = [];
  function event(value: string) { outcome = value; transitions.push(Object.freeze({ sequence: ++sequence, event: value }));
    if (transitions.length > INVITATION_CONNECTION_LIMITS.transitions) transitions.shift(); }
  function disarm() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function live(record: Attempt) { return !closed && !record.abort.signal.aborted && (pending === record || current === record); }
  function retire(record: Attempt, reason: InvitationConnectionFailure) {
    if (pending === record) pending = undefined; if (current === record) current = undefined;
    record.abort.abort(); for (const detach of record.detach.splice(0)) detach();
    record.peer?.stop(); if (!record.peer) void record.transport?.disconnect();
    if (!record.completed) { record.completed = true; record.finish(failure(reason)); }
  }
  function close() { if (closed) return; closed = true; review = undefined; disarm();
    if (pending) retire(pending, 'closed'); if (current) retire(current, 'closed'); event('closed'); }
  function time() {
    if (closed) reject('closed'); if (readingClock) { close(); reject('invalid-clock'); }
    readingClock = true;
    try { const value = clock(); if (closed) reject('closed');
      if (!integer(value) || value < lastNow || value > Number.MAX_SAFE_INTEGER - INVITATION_CONNECTION_LIMITS.grantMs) { close(); reject('invalid-clock'); }
      lastNow = value; return value;
    } catch (error) { if (!(error instanceof ConnectionError)) { close(); reject('invalid-clock'); } throw error; }
    finally { readingClock = false; }
  }
  function enrolled(target: InvitationEndpoint) {
    const at = time(); let yes = false; try { yes = target.isCurrent() === true; } catch { /* Current host enrollment required. */ }
    const after = time(); return yes && !closed && after < target.expiresAt && at <= after;
  }
  function guard(record: Attempt) {
    if (!live(record)) reject(closed ? 'closed' : 'cancelled');
    if (!enrolled(record.review.target) || !live(record)) reject('revoked');
    const at = time(); if (!receiverInvitationCurrent(record.review.preview.invitation, at)) reject('expired');
    if (wallTime() >= (current === record ? record.wallExpiry : record.wallDeadline)) reject('expired');
    const grant = record.grant;
    if (grant) {
      if (at >= grant.expiresAt || grant.signal?.aborted) reject(grant.signal?.aborted ? 'revoked' : 'expired');
      let yes = false; try { yes = grant.isCurrent() === true; } catch { /* Authority cannot be inferred. */ }
      const after = time();
      if (!yes || !live(record) || grant.signal?.aborted) reject(closed ? 'closed' : 'revoked');
      if (after >= grant.expiresAt || !receiverInvitationCurrent(record.review.preview.invitation, after)) reject('expired');
    }
    if (!live(record)) reject(closed ? 'closed' : 'cancelled');
  }
  function failed(record: Attempt, error: unknown) {
    if (!live(record)) return;
    const reason = error instanceof ConnectionError ? error.reason : 'unavailable'; retire(record, reason); event(reason);
  }
  function ownedSocket(record: Attempt, url: string, protocol: string): WebSocketPort {
    guard(record);
    const raw: WebSocketPort = record.review.target.createSocket ? record.review.target.createSocket(url, protocol) :
      typeof globalThis.WebSocket === 'function' ? new WebSocket(url, protocol) : reject('unsupported');
    const reservation = {}; sockets.add(reservation);
    let onopen: WebSocketPort['onopen'] = null, onclose: WebSocketPort['onclose'] = null;
    let onmessage: WebSocketPort['onmessage'] = null, onerror: WebSocketPort['onerror'] = null;
    function forward(callback: (() => void) | undefined) { try { guard(record); callback?.(); } catch (error) { failed(record, error); } }
    try {
      raw.onclose = value => { sockets.delete(reservation); onclose?.(value); };
      raw.onopen = value => forward(() => onopen?.(value)); raw.onmessage = value => forward(() => onmessage?.(value));
      raw.onerror = value => forward(() => onerror?.(value));
      guard(record);
    }
    catch (error) { try { raw.close(); if (raw.readyState === 3) sockets.delete(reservation); } catch { /* Reserved until real close, bounded lifetime. */ } throw error; }
    return {
      get readyState() { return raw.readyState; }, get protocol() { return raw.protocol; }, get bufferedAmount() { return raw.bufferedAmount; },
      get binaryType() { return raw.binaryType; }, set binaryType(value) { raw.binaryType = value; },
      get onopen() { return onopen; }, set onopen(value) { onopen = value; }, get onclose() { return onclose; }, set onclose(value) { onclose = value; },
      get onmessage() { return onmessage; }, set onmessage(value) { onmessage = value; }, get onerror() { return onerror; }, set onerror(value) { onerror = value; },
      send(value) { guard(record); raw.send(value); },
      close() { raw.close(); if (raw.readyState === 3) sockets.delete(reservation); },
    };
  }
  function matches(record: Attempt) {
    const proof = authenticatedPeerScope(record.peer);
    if (!proof) return false;
    return proof.epoch === record.scope.epoch && proof.applicationId === record.scope.applicationId && proof.sessionId === record.scope.sessionId &&
      proof.role === 'source' && proof.remoteKeyId === record.scope.remoteKeyId && proof.localKeyId === identity.keyId;
  }
  function sweep() {
    if (closed) return;
    try { const at = time();
      if (review && (at >= review.preview.invitation.expiresAt || !enrolled(review.target))) { review = undefined; event('expired'); }
      for (const record of [pending, current]) if (record) {
        try { guard(record); record.transport?.tick(); record.peer?.tick(); guard(record);
          if (record.peer && ['failed', 'disconnected'].includes(record.peer.state)) reject('unavailable');
          if (pending === record && record.peer?.state === 'connected') {
            if (!matches(record)) reject('wrong-endpoint'); guard(record);
            pending = undefined; current = record; record.completed = true; event('connected'); record.finish(success(record.handle));
          } else if (current === record && !matches(record)) reject('wrong-endpoint');
        } catch (error) { failed(record, error); }
      }
    } catch { /* Invalid clock/closure has already retired all authority. */ }
    arm();
  }
  function arm() {
    if (closed || timer !== undefined || !review && !pending && !current) return;
    const owned = setTimeout(() => { if (timer !== owned) return; timer = undefined; sweep(); }, INVITATION_CONNECTION_LIMITS.tickMs);
    if (closed || !review && !pending && !current) clearTimeout(owned); else timer = owned;
  }
  async function open(record: Attempt) {
    unsettled++;
    let received: unknown;
    try { guard(record); received = await authorize(record.scope); }
    catch (error) { failed(record, error); return; }
    finally { unsettled--; }
    if (!live(record)) return;
    try {
      guard(record); if (received === undefined) reject('denied');
      const value = data(received, ['scope', 'expiresAt', 'isCurrent'], ['signal']);
      if (!sameScope(value.scope, record.scope) || !integer(value.expiresAt) || value.expiresAt > record.scope.deadline || value.expiresAt <= time() ||
        typeof value.isCurrent !== 'function' || value.signal !== undefined && !(value.signal instanceof AbortSignal)) reject('denied');
      record.grant = Object.freeze({ scope: record.scope, expiresAt: value.expiresAt, isCurrent: value.isCurrent as () => boolean,
        ...(value.signal ? { signal: value.signal as AbortSignal } : {}) });
      record.wallExpiry = wallTime() + value.expiresAt - time();
      if (record.grant.signal) { const stop = () => failed(record, new ConnectionError('revoked')); record.grant.signal.addEventListener('abort', stop, { once: true });
        record.detach.push(() => record.grant?.signal?.removeEventListener('abort', stop)); }
      guard(record);
      // Explicit accepted transfer releases the incumbent before any replacement socket is issued.
      if (current) retire(current, 'cancelled'); guard(record);
      record.transport = new SecureWebSocketTransport({ endpoint: record.scope.endpoint, side: 'client', now: () => { guard(record); return time(); },
        createSocket: (url, protocol) => ownedSocket(record, url, protocol) });
      guard(record);
      record.peer = new AuthenticatedResourcePeer({ transport: record.transport, identity, crypto, epoch: record.scope.epoch,
        applicationId: record.scope.applicationId, sessionId: record.scope.sessionId, role: 'source', now: () => { guard(record); return time(); },
        timeoutMs: INVITATION_CONNECTION_LIMITS.connectMs, expectedRemoteKeyId: record.scope.remoteKeyId });
      guard(record); await record.transport.connect(); guard(record); sweep();
    } catch (error) { failed(record, error); }
  }
  function preview(target: InvitationEndpoint, invitation: ReceiverInvitation, source: InvitationConnectionPreview['source']): InvitationConnectionPreview {
    return Object.freeze({ endpointId: target.id, endpoint: target.endpoint, remoteKeyId: target.remoteKeyId, invitation, source,
      backend: target.createSocket ? 'host-socket' : typeof globalThis.WebSocket === 'function' ? 'native-websocket' : 'unavailable' });
  }
  const controller: InvitationConnectionController = {
    review(value, choice) {
      if (closed) return failure('closed'); if (busy) return failure('busy'); busy = true;
      try {
        if (pending) retire(pending, 'cancelled');
        const fields = data(choice, ['source', 'endpointId']), at = time();
        if (!['manual', 'link', 'qr'].includes(fields.source as string) || !id(fields.endpointId)) reject('invalid');
        if (windowAt < 0 || at - windowAt >= 1000) { windowAt = at; reviews = 0; }
        if (reviews >= INVITATION_CONNECTION_LIMITS.reviewsPerSecond) reject('capacity'); reviews++;
        const target = endpoints.get(fields.endpointId); if (!target || !enrolled(target)) reject('unsupported');
        const invitation = decodeReceiverInvitationInput(value, at);
        if (!receiverInvitationCurrent(invitation, time())) reject('expired');
        const next: Review = { handle: Object.freeze({ kind: 'invitation-review' }), target,
          preview: preview(target, invitation, fields.source as InvitationConnectionPreview['source']) };
        if (closed) reject('closed'); review = next; event('review'); arm(); return success(next.handle);
      } catch (error) { review = undefined; const reason = error instanceof ConnectionError ? error.reason : 'invalid'; if (!closed) event(reason); return failure(reason); }
      finally { busy = false; }
    },
    connect(handle) {
      if (closed) return Promise.resolve(failure('closed')); if (busy || pending) return Promise.resolve(failure('busy'));
      if (!review || review.handle !== handle) return Promise.resolve(failure('stale'));
      if (issuedAttempts >= INVITATION_CONNECTION_LIMITS.attempts) return Promise.resolve(failure('capacity'));
      busy = true;
      try {
        const selected = review, at = time(); if (!enrolled(selected.target) || review !== selected) reject('revoked');
        if (!receiverInvitationCurrent(selected.preview.invitation, time())) reject('expired');
        const scope: InvitationConnectionScope = Object.freeze({ ownerId, endpointId: selected.target.id, endpoint: selected.target.endpoint,
          remoteKeyId: selected.target.remoteKeyId, applicationId: selected.preview.invitation.applicationId, sessionId: selected.preview.invitation.sessionId,
          epoch: selected.preview.invitation.epoch, role: 'source', invitationExpiresAt: selected.preview.invitation.expiresAt,
          deadline: Math.min(selected.target.expiresAt, selected.preview.invitation.expiresAt, at + INVITATION_CONNECTION_LIMITS.grantMs) });
        let finish!: Attempt['finish']; const result = new Promise<InvitationConnectionResult<InvitationConnectionHandle>>(resolve => { finish = resolve; });
        const record: Attempt = { review: selected, handle: Object.freeze({ kind: 'invitation-connection' }), scope,
          abort: new AbortController(), wallDeadline: wallTime() + INVITATION_CONNECTION_LIMITS.connectMs, wallExpiry: Infinity,
          finish, detach: [], completed: false };
        review = undefined; pending = record; issuedAttempts++; event('connecting'); arm(); void open(record); return result;
      } catch (error) { return Promise.resolve(failure(error instanceof ConnectionError ? error.reason : 'invalid')); }
      finally { busy = false; }
    },
    cancel(handle) { if (closed) return failure('closed');
      if (review?.handle === handle) review = undefined; else if (pending?.review.handle === handle) retire(pending, 'cancelled'); else return failure('stale');
      event('cancelled'); if (!review && !pending && !current) disarm(); return success(); },
    connection(handle) { const record = current; if (!record || record.handle !== handle) return;
      try { guard(record); if (!matches(record)) reject('wrong-endpoint'); guard(record); return record.peer; } catch (error) { failed(record, error); return; } },
    disconnect() { review = undefined; if (pending) retire(pending, 'cancelled'); if (current) retire(current, 'cancelled'); disarm(); if (!closed) event('disconnected'); },
    sweep,
    snapshot() { return Object.freeze({ state: closed ? 'closed' : review ? 'reviewing' : pending ? 'connecting' : current ? 'connected' :
      outcome === 'unsupported' ? 'unsupported' : outcome === 'expired' ? 'expired' : ['unavailable', 'revoked', 'wrong-endpoint'].includes(outcome) ? 'interrupted' : 'unknown',
      outcome, ...(review ? { pending: review.preview } : {}), ...(current ? { current: current.scope } : {}), issuedAttempts,
      unsettledAuthorizations: unsettled, socketReservations: sockets.size, timerArmed: timer !== undefined,
      transitions: Object.freeze([...transitions]) }); },
    close,
  };
  return Object.freeze(controller);
}
