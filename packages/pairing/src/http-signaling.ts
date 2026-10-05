import { CAPABILITY_NAMES, decodePairingTicket, encodePairingTicket, type PairingTicket } from '@101/protocol';
import type { ControllerLease, ControllerOfferSignal, ControllerSignalingClient, CreatedSignalingSession, HostPeerSignal, HostSignalingClient, PairingDevice } from './index.ts';

export const HTTP_SIGNALING_LIMITS = Object.freeze({ pendingRequests: 4, deadlineMs: 2500, burst: 128, requestsPerSecond: 32, requestBytes: 1_048_576, responseBytes: 1_048_576, responseChunks: 4096, peers: 64, signalCharacters: 400_000 });
export interface HttpSignalingOptions { readonly now?: () => number }
export interface HttpSignalingSessionOptions extends HttpSignalingOptions {
  readonly hostName?: string;
  readonly ttlMs?: number;
  readonly advertisedEndpoint?: string;
  readonly hostToken?: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}

export class SignalingRequestError extends Error {
  readonly status: number;
  constructor(status: number) { super(`101 signaling request failed (${status})`); this.status = status; }
}
class BoundaryError extends Error {}
function fail(message = 'Invalid signaling data'): never { throw new BoundaryError(message); }
function own(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.length) fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function text(input: unknown, maximum: number): string {
  if (typeof input !== 'string' || !input || input.length > maximum || /\p{Cc}/u.test(input)) fail();
  return input;
}
function id(input: unknown, maximum = 128): string {
  const value = text(input, maximum);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) fail();
  return value;
}
function peerPathId(input: unknown): string {
  const value = id(input);
  if (value === '.' || value === '..') fail('Invalid signaling peer path');
  return value;
}
function session(input: unknown): string {
  const value = text(input, 128);
  if (!/^[A-Z0-9-]{4,128}$/i.test(value)) fail();
  return value;
}
function token(input: unknown): string {
  const value = text(input, 256);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) fail();
  return value;
}
function integer(input: unknown, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) fail();
  return input;
}
function clock(value: unknown): number { return integer(value); }
function origin(input: unknown): string {
  const value = text(input, 2048);
  if (/[\p{Cc} %\\]/u.test(value) || !/^[a-z]+:\/\/[^/?#]+\/?$/i.test(value)) fail('Invalid signaling endpoint');
  let url: URL;
  try { url = new URL(value); } catch { fail('Invalid signaling endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/') fail('Invalid signaling endpoint');
  return url.origin;
}
function code(input: unknown): string {
  const value = text(input, HTTP_SIGNALING_LIMITS.signalCharacters);
  if (value.length < 8 || !value.startsWith('101')) fail('Invalid signaling code');
  return value;
}
function freshTicket(input: unknown, now: number): Readonly<PairingTicket> {
  try { return decodePairingTicket(encodePairingTicket(input as PairingTicket), now); } catch { fail('Invalid signaling ticket'); }
}
function live(ticket: Readonly<PairingTicket>, now: number) { if (ticket.expiresAt <= now || ticket.expiresAt - now > 86_400_000) fail('Signaling ticket expired'); }
function device(input: unknown): PairingDevice {
  const value = own(input, ['deviceId', 'label', 'capabilities']);
  const capabilityValues = own(value.capabilities, CAPABILITY_NAMES);
  const capabilities: PairingDevice['capabilities'] = {};
  for (const key of CAPABILITY_NAMES) {
    if (capabilityValues[key] === undefined) continue;
    if (typeof capabilityValues[key] !== 'boolean') fail();
    capabilities[key] = capabilityValues[key];
  }
  return Object.freeze({ deviceId: id(value.deviceId), label: text(value.label, 128), capabilities: Object.freeze(capabilities) });
}
function lease(input: unknown, ticket: Readonly<PairingTicket>, now: number): Readonly<ControllerLease> {
  const value = own(input, ['peerId', 'peerToken', 'generation', 'expiresAt']);
  live(ticket, now);
  if (value.expiresAt !== ticket.expiresAt) fail('Signaling lease scope mismatch');
  return Object.freeze({ peerId: peerPathId(value.peerId), peerToken: token(value.peerToken), generation: integer(value.generation, 1), expiresAt: ticket.expiresAt });
}
export function assertSignalingPeerCount(input: unknown): asserts input is readonly HostPeerSignal[] {
  if (!Array.isArray(input) || input.length > HTTP_SIGNALING_LIMITS.peers) fail('Signaling peer capacity exceeded');
}
function peers(input: unknown): readonly HostPeerSignal[] {
  assertSignalingPeerCount(input);
  const ids = new Set<string>();
  const result = input.map(item => {
    const value = own(item, ['peerId', 'deviceId', 'generation', 'answer', 'lastSeenAt']);
    const peerId = peerPathId(value.peerId);
    if (ids.has(peerId)) fail('Duplicate signaling peer');
    ids.add(peerId);
    return Object.freeze({ peerId, deviceId: id(value.deviceId), generation: integer(value.generation, 1), ...(value.answer === undefined ? {} : { answer: code(value.answer) }), lastSeenAt: integer(value.lastSeenAt) });
  });
  return Object.freeze(result);
}

interface Job {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly rejected: Promise<never>;
  reject(reason: Error): void;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  failure?: Error;
  deadlineAt?: number;
}
interface RequestSpec<T> {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly token?: string;
  readonly body?: unknown;
  readonly empty?: boolean;
  readonly parse: (value: unknown, now: number) => T;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}

class Caller {
  private readonly fetcher: typeof fetch;
  private readonly trustedNow: () => number;
  private readonly pending = new Set<Job>();
  private epoch = 0;
  private closed = false;
  private lastNow: number | undefined;
  private creditAt: number | undefined;
  private credits: number = HTTP_SIGNALING_LIMITS.burst;
  constructor(fetcher: typeof fetch, options: HttpSignalingOptions = {}) {
    const value = own(options, ['now']);
    if (typeof fetcher !== 'function' || (value.now !== undefined && typeof value.now !== 'function')) fail('Invalid signaling caller');
    this.fetcher = fetcher; this.trustedNow = value.now as (() => number) | undefined ?? Date.now;
  }
  now(): number {
    let value: number;
    try { value = clock(this.trustedNow()); } catch { this.cancelPending(); fail('Invalid signaling clock'); }
    if (this.lastNow !== undefined && value < this.lastNow) { this.cancelPending(); fail('Signaling clock moved backwards'); }
    this.lastNow = value;
    return value;
  }
  cancelPending() {
    this.epoch++;
    for (const job of this.pending) this.abort(job, new BoundaryError('Signaling request cancelled'));
  }
  close() { this.closed = true; this.cancelPending(); }
  private abort(job: Job, reason: Error) {
    if (job.failure) return;
    job.failure = reason;
    job.reject(reason);
    job.controller.abort();
    void job.reader?.cancel().catch(() => undefined);
  }
  private current(job: Job) { if (this.closed || job.epoch !== this.epoch || job.failure) throw job.failure ?? new BoundaryError('Signaling request cancelled'); }
  private at(job: Job) {
    const now = this.now(); this.current(job);
    if (job.deadlineAt !== undefined && now >= job.deadlineAt) this.abort(job, new BoundaryError('Signaling request timed out'));
    this.current(job); return now;
  }
  async request<T>(build: (now: number) => RequestSpec<T>): Promise<T> {
    if (this.closed || this.pending.size >= HTTP_SIGNALING_LIMITS.pendingRequests) fail('Signaling request capacity exceeded or caller closed');
    let reject!: (reason: Error) => void;
    const rejected = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    // Reservation precedes trusted clock, argument conversion and fetch callbacks.
    const job: Job = { epoch: this.epoch, controller: new AbortController(), rejected, reject };
    this.pending.add(job);
    void rejected.catch(() => undefined);
    const timer = setTimeout(() => this.abort(job, new BoundaryError('Signaling request timed out')), HTTP_SIGNALING_LIMITS.deadlineMs);
    let detach: (() => void) | undefined;
    try {
      const now = this.now(); this.current(job);
      if (now > Number.MAX_SAFE_INTEGER - HTTP_SIGNALING_LIMITS.deadlineMs) fail('Invalid signaling clock');
      job.deadlineAt = now + HTTP_SIGNALING_LIMITS.deadlineMs;
      this.credits = Math.min(HTTP_SIGNALING_LIMITS.burst, this.credits + (now - (this.creditAt ?? now)) * HTTP_SIGNALING_LIMITS.requestsPerSecond / 1000);
      this.creditAt = now;
      if (this.credits < 1) fail('Signaling request rate exceeded');
      this.credits--;
      const spec = build(now); this.current(job);
      const target = new URL(spec.url);
      if (target.href !== spec.url || target.username || target.password || target.hash || target.search || !['http:', 'https:'].includes(target.protocol)) fail('Invalid signaling request destination');
      const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
      if (body !== undefined && new TextEncoder().encode(body).byteLength > HTTP_SIGNALING_LIMITS.requestBytes) fail('Signaling request too large');
      this.current(job);
      if (spec.signal !== undefined) {
        if (!(spec.signal instanceof AbortSignal)) fail('Invalid signaling cancellation');
        const abort = () => this.abort(job, new BoundaryError('Signaling request cancelled'));
        if (spec.signal.aborted) abort(); else { spec.signal.addEventListener('abort', abort, { once: true }); detach = () => spec.signal?.removeEventListener('abort', abort); }
      }
      this.current(job);
      this.at(job);
      const fetching = Promise.resolve((spec.fetcher ?? this.fetcher)(spec.url, { method: spec.method, headers: {
        ...(spec.token === undefined ? {} : { Authorization: `Bearer ${spec.token}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body }), redirect: 'manual', credentials: 'omit', signal: job.controller.signal }));
      void fetching.then(response => { if (job.failure) void response.body?.cancel().catch(() => undefined); }).catch(() => undefined);
      const response = await Promise.race([fetching, rejected]);
      this.current(job);
      const receivedAt = this.at(job);
      const status = response.status;
      if (!Number.isInteger(status) || status < 100 || status > 599 || response.redirected || (response.url && response.url !== spec.url) || response.type === 'opaqueredirect') fail('Signaling response destination mismatch');
      if (status < 200 || status >= 300) throw new SignalingRequestError(status);
      if (spec.empty) {
        if (status !== 204) fail('Invalid signaling acknowledgement');
        this.current(job);
        const result = spec.parse(undefined, receivedAt);
        this.current(job);
        return result;
      }
      if (status !== 200 && status !== 201) fail('Invalid signaling response status');
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d{1,9}$/.test(contentLength) || Number(contentLength) > HTTP_SIGNALING_LIMITS.responseBytes)) fail('Signaling response too large');
      if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) fail('Invalid signaling response body');
      job.reader = response.body.getReader(); this.current(job);
      const chunks: Uint8Array[] = []; let length = 0, reads = 0;
      while (true) {
        const next = await Promise.race([job.reader.read(), rejected]); this.current(job);
        this.at(job);
        if (next.done) break;
        if (++reads > HTTP_SIGNALING_LIMITS.responseChunks) fail('Signaling response work limit exceeded');
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > HTTP_SIGNALING_LIMITS.responseBytes - length) fail('Signaling response too large');
        length += next.value.byteLength; chunks.push(next.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const result = spec.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), this.at(job));
      this.current(job);
      return result;
    } catch (error) {
      if (error instanceof BoundaryError || error instanceof SignalingRequestError) throw error;
      return fail('Signaling request failed');
    } finally {
      clearTimeout(timer); detach?.(); this.pending.delete(job);
      this.abort(job, new BoundaryError('Signaling request finished'));
    }
  }
}

export class HttpHostSignalingClient implements HostSignalingClient {
  readonly #endpoint: string;
  readonly #sessionId: string;
  readonly #hostToken: string;
  readonly #caller: Caller;
  constructor(endpoint: string, sessionId: string, hostToken: string, fetcher: typeof fetch = fetch, options: HttpSignalingOptions = {}) {
    this.#endpoint = origin(endpoint); this.#sessionId = session(sessionId); this.#hostToken = token(hostToken); this.#caller = new Caller(fetcher, options); Object.freeze(this);
  }
  cancelPending() { this.#caller.cancelPending(); }
  close() { this.#caller.close(); }
  listPeers(): Promise<readonly HostPeerSignal[]> { return this.#caller.request(() => ({ url: this.url('peers'), method: 'GET', token: this.#hostToken, parse: peers })); }
  publishOffer(peerId: string, generation: number, offer: string): Promise<void> {
    return this.#caller.request(() => ({ url: this.url(`peers/${encodeURIComponent(peerPathId(peerId))}/offer`), method: 'PUT', token: this.#hostToken, body: { generation: integer(generation, 1), offer: code(offer) }, empty: true, parse: () => undefined }));
  }
  resetPeer(peerId: string): Promise<void> { return this.#caller.request(() => ({ url: this.url(`peers/${encodeURIComponent(peerPathId(peerId))}/reconnect`), method: 'POST', token: this.#hostToken, empty: true, parse: () => undefined })); }
  private url(path: string) { return `${this.#endpoint}/v1/sessions/${encodeURIComponent(this.#sessionId)}/host/${path}`; }
}

export class HttpControllerSignalingClient implements ControllerSignalingClient {
  readonly #ticket: Readonly<PairingTicket>;
  readonly #caller: Caller;
  constructor(ticket: PairingTicket, fetcher: typeof fetch = fetch, options: HttpSignalingOptions = {}) {
    this.#caller = new Caller(fetcher, options); this.#ticket = freshTicket(ticket, this.#caller.now()); Object.freeze(this);
  }
  cancelPending() { this.#caller.cancelPending(); }
  close() { this.#caller.close(); }
  join(input: PairingDevice): Promise<ControllerLease> {
    return this.#caller.request(now => { live(this.#ticket, now); return { url: this.url('peers'), method: 'POST', token: this.#ticket.joinToken, body: device(input), parse: (value, at) => lease(value, this.#ticket, at) }; });
  }
  getOffer(input: ControllerLease): Promise<ControllerOfferSignal> {
    return this.#caller.request(now => {
      const selected = lease(input, this.#ticket, now);
      return { url: this.url(`peers/${encodeURIComponent(selected.peerId)}/offer`), method: 'GET', token: selected.peerToken, parse: (input, at) => {
        const value = own(input, ['generation', 'offer', 'expiresAt']); live(this.#ticket, at);
        if (value.expiresAt !== this.#ticket.expiresAt) fail('Signaling offer scope mismatch');
        const generation = integer(value.generation, 1);
        if (generation < selected.generation) fail('Stale signaling generation');
        return Object.freeze({ generation, expiresAt: this.#ticket.expiresAt, ...(value.offer === undefined ? {} : { offer: code(value.offer) }) });
      } };
    });
  }
  publishAnswer(input: ControllerLease, generation: number, answer: string): Promise<void> {
    return this.#caller.request(now => { const selected = lease(input, this.#ticket, now); return { url: this.url(`peers/${encodeURIComponent(selected.peerId)}/answer`), method: 'PUT', token: selected.peerToken, body: { generation: integer(generation, selected.generation), answer: code(answer) }, empty: true, parse: () => undefined }; });
  }
  requestReconnect(input: ControllerLease): Promise<ControllerLease> {
    return this.#caller.request(now => { const selected = lease(input, this.#ticket, now); return { url: this.url(`peers/${encodeURIComponent(selected.peerId)}/reconnect`), method: 'POST', token: selected.peerToken, parse: (value, at) => {
      const next = lease(value, this.#ticket, at);
      if (next.peerId !== selected.peerId || next.peerToken !== selected.peerToken || next.generation <= selected.generation) fail('Signaling reconnect scope mismatch');
      return next;
    } }; });
  }
  leave(input: ControllerLease): Promise<void> { return this.#caller.request(now => { const selected = lease(input, this.#ticket, now); return { url: this.url(`peers/${encodeURIComponent(selected.peerId)}`), method: 'DELETE', token: selected.peerToken, empty: true, parse: () => undefined }; }); }
  private url(path: string) { return `${this.#ticket.endpoint}/v1/sessions/${encodeURIComponent(this.#ticket.sessionId)}/${path}`; }
}

// Standalone session creation shares a finite process-local request budget. Its
// caller supplies an AbortSignal; this budget stores no endpoint authority.
const sessionCaller = new Caller(fetch);
export function createHttpSignalingSession(endpoint: string, sessionId: string, options: HttpSignalingSessionOptions = {}): Promise<CreatedSignalingSession> {
  return sessionCaller.request(now => {
    const value = own(options, ['hostName', 'ttlMs', 'advertisedEndpoint', 'hostToken', 'fetcher', 'signal', 'now']);
    const selectedEndpoint = origin(endpoint), selectedSession = session(sessionId);
    const advertisedEndpoint = value.advertisedEndpoint === undefined ? selectedEndpoint : origin(value.advertisedEndpoint);
    if (value.ttlMs !== undefined) integer(value.ttlMs);
    if (value.fetcher !== undefined && typeof value.fetcher !== 'function') fail('Invalid signaling caller');
    if (value.now !== undefined && typeof value.now !== 'function') fail('Invalid signaling clock');
    const selectedNow = value.now === undefined ? now : clock((value.now as () => number)());
    return { url: `${selectedEndpoint}/v1/sessions`, method: 'POST', ...(value.hostToken === undefined ? {} : { token: token(value.hostToken) }), body: {
      sessionId: selectedSession, ...(value.hostName === undefined ? {} : { hostName: text(value.hostName, 128) }), ...(value.ttlMs === undefined ? {} : { ttlMs: value.ttlMs }), endpoint: advertisedEndpoint,
    }, fetcher: value.fetcher as typeof fetch | undefined, signal: value.signal as AbortSignal | undefined, parse: (input, at) => {
      const record = own(input, ['ticket', 'hostToken']);
      const currentNow = value.now === undefined ? at : clock((value.now as () => number)());
      if (currentNow < selectedNow) fail('Signaling clock moved backwards');
      const ticket = freshTicket(record.ticket, currentNow);
      if (ticket.sessionId !== selectedSession || ticket.endpoint !== advertisedEndpoint) fail('Signaling session scope mismatch');
      return Object.freeze({ ticket, hostToken: token(record.hostToken) });
    } };
  });
}
