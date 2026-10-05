import type { WebSocketPort } from './ports.ts';
export type { WebSocketPort } from './ports.ts';
export type WebSocketState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
export type WebSocketLane = 'reliable' | 'disposable';
export type WebSocketData = string | ArrayBuffer | Uint8Array;
export const WSS_SUBPROTOCOL = '101-resource-wss-1';
export interface WebSocketLimits {
  maxMessageBytes: number; reliableBufferLimit: number; latestBufferLimit: number;
}
export interface WebSocketSessionBinding {
  readonly kind: 'wss'; readonly generation: number; readonly initiator: boolean;
  readonly endpoint: string; readonly subprotocol: typeof WSS_SUBPROTOCOL;
  readonly clientHello: string; readonly serverHello: string;
  readonly limits: Readonly<WebSocketLimits>; readonly connectionTag: string;
}
type Common = { endpoint: string; now: () => number; limits?: Partial<WebSocketLimits> };
export type SecureWebSocketOptions = Common & (
  | { side: 'client'; createSocket?: (endpoint: string, subprotocol: string) => WebSocketPort; socket?: never }
  // The trusted host accepts this port only from its own TLS listener. A port is
  // an adapter boundary, not evidence of TLS or a resource authorization grant.
  | { side: 'server'; socket: WebSocketPort; createSocket?: never }
);
interface Hello {
  protocol: 'connect-wss'; version: 1; type: 'hello'; endpoint: string;
  side: 'client' | 'server'; nonce: string; delivery: 'ordered-bounded/1'; limits: WebSocketLimits;
}
interface Confirm { protocol: 'connect-wss'; version: 1; type: 'confirm'; digest: string }
const HEADER = 39, CONTROL_BYTES = 4096, HANDSHAKE_MS = 5000;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
function hex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
function validHex(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function fields(input: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid WSS configuration');
  const keys = Reflect.ownKeys(input), result: Record<string, unknown> = Object.create(null);
  if (keys.length > allowed.length) throw new TypeError('Invalid WSS configuration');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !property?.enumerable || !Object.hasOwn(property, 'value')) throw new TypeError('Invalid WSS configuration');
    result[key] = property.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError('Invalid WSS configuration');
  return result;
}
function endpoint(input: unknown): string {
  if (typeof input !== 'string' || input.length > 1024 || input.trim() !== input || /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%(?:8[0-9a-f]|9[0-9a-f])/i.test(input) || Array.from(input).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159 || character === '\\')) throw new TypeError('Invalid secure WebSocket endpoint');
  let url: URL;
  try { url = new URL(input); } catch { throw new TypeError('Invalid secure WebSocket endpoint'); }
  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#')) throw new TypeError('Invalid secure WebSocket endpoint');
  return url.href;
}
function limits(input: unknown = {}): Readonly<WebSocketLimits> {
  const value = fields(input, ['maxMessageBytes', 'reliableBufferLimit', 'latestBufferLimit']);
  const result = { maxMessageBytes: value.maxMessageBytes ?? 68 * 1024,
    reliableBufferLimit: value.reliableBufferLimit ?? 128 * 1024, latestBufferLimit: value.latestBufferLimit ?? 16 * 1024 };
  for (const [key, maximum] of [['maxMessageBytes', 128 * 1024], ['reliableBufferLimit', 256 * 1024], ['latestBufferLimit', 64 * 1024]] as const) {
    const number = result[key]; if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 256 || number > maximum) throw new TypeError('Invalid WSS byte limits');
  }
  if ((result.latestBufferLimit as number) >= (result.reliableBufferLimit as number) || (result.maxMessageBytes as number) + HEADER > (result.reliableBufferLimit as number)) throw new TypeError('Invalid WSS byte limits');
  return Object.freeze(result as WebSocketLimits);
}
function hello(input: unknown): Hello {
  const value = fields(input, ['protocol', 'version', 'type', 'endpoint', 'side', 'nonce', 'delivery', 'limits'],
    ['protocol', 'version', 'type', 'endpoint', 'side', 'nonce', 'delivery', 'limits']);
  if (value.protocol !== 'connect-wss' || value.version !== 1 || value.type !== 'hello' || value.side !== 'client' && value.side !== 'server' ||
    !validHex(value.nonce) || value.delivery !== 'ordered-bounded/1' || endpoint(value.endpoint) !== value.endpoint) throw new TypeError('Invalid WSS negotiation');
  const advertised = fields(value.limits, ['maxMessageBytes', 'reliableBufferLimit', 'latestBufferLimit'], ['maxMessageBytes', 'reliableBufferLimit', 'latestBufferLimit']);
  return Object.freeze({ protocol: 'connect-wss', version: 1, type: 'hello', endpoint: value.endpoint as string, side: value.side,
    nonce: value.nonce, delivery: 'ordered-bounded/1', limits: limits(advertised) });
}
function time(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function increment(value: number): number { return Math.min(value + 1, Number.MAX_SAFE_INTEGER); }

/** Direct WSS lanes. Resource queues, source clocks and age rejection remain in the resource binder. */
export class SecureWebSocketTransport {
  readonly #options: SecureWebSocketOptions; readonly #endpoint: string; readonly #limits: Readonly<WebSocketLimits>;
  readonly #data = new Set<(lane: WebSocketLane, data: string | ArrayBuffer) => void>();
  readonly #states = new Set<(state: WebSocketState) => void>();
  #state: WebSocketState = 'idle'; #reason = 'idle'; #socket?: WebSocketPort; #generation = 0;
  #binding?: WebSocketSessionBinding; #tag?: Uint8Array; #local?: Hello; #remote?: Hello;
  #digest?: string; #remoteDigest?: string; #confirmSent = false; #building = false; #controls = 0;
  #startedAt = 0; #lastNow = -Infinity; #timer?: ReturnType<typeof setTimeout>;
  #sent = 0; #received = 0; #dropped = 0; #retiring = false; #readingClock = false;
  constructor(options: SecureWebSocketOptions) {
    const value = fields(options, ['endpoint', 'side', 'now', 'limits', 'createSocket', 'socket'], ['endpoint', 'side', 'now']);
    this.#endpoint = endpoint(value.endpoint); this.#limits = limits(value.limits);
    if (value.side !== 'client' && value.side !== 'server' || typeof value.now !== 'function' ||
      value.side === 'client' && (value.socket !== undefined || value.createSocket !== undefined && typeof value.createSocket !== 'function') ||
      value.side === 'server' && (!value.socket || value.createSocket !== undefined)) throw new TypeError('Invalid WSS configuration');
    this.#options = Object.freeze({ ...value, endpoint: this.#endpoint, limits: this.#limits }) as SecureWebSocketOptions;
  }
  get state(): WebSocketState { return this.#state; }
  sessionBinding(): WebSocketSessionBinding | undefined { return this.#binding; }
  isCurrentSession(binding: unknown): binding is WebSocketSessionBinding {
    return !!this.#binding && binding === this.#binding && this.#binding.generation === this.#generation && this.#state === 'connected' && this.#socket?.readyState === 1;
  }
  isOpen(lane: WebSocketLane): boolean { return (lane === 'reliable' || lane === 'disposable') && this.isCurrentSession(this.#binding); }
  onData(listener: (lane: WebSocketLane, data: string | ArrayBuffer) => void): () => void { this.#data.add(listener); return () => { this.#data.delete(listener); }; }
  onStateChange(listener: (state: WebSocketState) => void): () => void {
    this.#states.add(listener); try { listener(this.#state); } catch { /* Observer only. */ }
    return () => { this.#states.delete(listener); };
  }
  status(): Readonly<{ reason: string; pending: number; bufferedBytes: number; sent: number; received: number; dropped: number }> {
    let bufferedBytes = 0; try { const value = this.#socket?.bufferedAmount ?? 0; bufferedBytes = Number.isSafeInteger(value) && value >= 0 ? value : this.#limits.reliableBufferLimit; } catch { /* Fixed conservative bound. */ }
    return Object.freeze({ reason: this.#reason, pending: 0, bufferedBytes, sent: this.#sent, received: this.#received, dropped: this.#dropped });
  }
  private clock(): number | undefined {
    if (this.#readingClock) { this.retire('clock-unavailable', 'failed'); return; }
    this.#readingClock = true;
    try {
      const now = this.#options.now(); if (!time(now) || now < this.#lastNow) throw new Error(); this.#lastNow = now;
      if (this.#socket && this.#state === 'connecting' && now - this.#startedAt >= HANDSHAKE_MS) { this.retire('negotiation-timeout', 'failed'); return; }
      return now;
    } catch { this.retire('clock-unavailable', 'failed'); return; }
    finally { this.#readingClock = false; }
  }
  private current(socket: WebSocketPort, generation: number): boolean { return this.#socket === socket && this.#generation === generation; }
  async connect(): Promise<void> {
    if (this.#socket || this.#retiring || this.#readingClock) return;
    const generation = ++this.#generation;
    const now = this.clock(); if (now === undefined || this.#generation !== generation) return;
    try {
      const socket: WebSocketPort = this.#options.side === 'server' ? this.#options.socket : (this.#options.createSocket ?? ((url, protocol) => new WebSocket(url, protocol)))(this.#endpoint, WSS_SUBPROTOCOL);
      if (this.#generation !== generation) { socket.close(); return; }
      this.#socket = socket; this.#startedAt = now; this.#reason = 'negotiating'; this.setState('connecting');
      if (!this.current(socket, generation)) return;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { if (this.current(socket, generation)) this.open(socket, generation); };
      socket.onmessage = event => { if (this.current(socket, generation)) this.receive(event.data, socket, generation); };
      socket.onclose = () => { if (this.current(socket, generation)) this.retire('transport-ended', 'disconnected'); };
      socket.onerror = () => { if (this.current(socket, generation)) this.retire('socket-unavailable', 'failed'); };
      this.#timer = setTimeout(() => { if (this.current(socket, generation) && this.#state !== 'connected') this.retire('negotiation-timeout', 'failed'); }, HANDSHAKE_MS);
      if (socket.readyState === 1) this.open(socket, generation);
      else if (socket.readyState !== 0) this.retire('socket-unavailable', 'failed');
    } catch { this.retire('socket-unavailable', 'failed'); }
  }
  private open(socket: WebSocketPort, generation: number): void {
    if (!this.current(socket, generation) || this.#local) return;
    try {
      if (socket.protocol !== WSS_SUBPROTOCOL) throw new Error();
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(32));
      this.#local = Object.freeze({ protocol: 'connect-wss', version: 1, type: 'hello', endpoint: this.#endpoint,
        side: this.#options.side, nonce: hex(nonce), delivery: 'ordered-bounded/1', limits: this.#limits });
      if (!this.sendControl(this.#local)) throw new Error(); this.advance(socket, generation);
    } catch { this.retire('invalid-negotiation', 'failed'); }
  }
  private sendControl(packet: Hello | Confirm): boolean {
    const socket = this.#socket; if (!socket || socket.readyState !== 1) return false;
    try {
      const text = JSON.stringify(packet), bytes = encoder.encode(text).length, buffered = socket.bufferedAmount;
      if (bytes > CONTROL_BYTES || !Number.isSafeInteger(buffered) || buffered < 0 || buffered + bytes > this.#limits.reliableBufferLimit) return false;
      socket.send(text); return this.#socket === socket;
    } catch { return false; }
  }
  private receive(data: unknown, socket: WebSocketPort, generation: number): void {
    if (this.clock() === undefined || !this.current(socket, generation)) return;
    if (typeof data === 'string') {
      try {
        if (data.length > CONTROL_BYTES || encoder.encode(data).length > CONTROL_BYTES || ++this.#controls > 8) throw new Error();
        const value = JSON.parse(data);
        if (value?.type === 'hello') {
          const remote = hello(value);
          if (remote.endpoint !== this.#endpoint || remote.side === this.#options.side || this.#remote && JSON.stringify(this.#remote) !== JSON.stringify(remote)) throw new Error();
          this.#remote = remote;
        } else {
          const confirm = fields(value, ['protocol', 'version', 'type', 'digest'], ['protocol', 'version', 'type', 'digest']);
          if (confirm.protocol !== 'connect-wss' || confirm.version !== 1 || confirm.type !== 'confirm' || !validHex(confirm.digest) ||
            this.#remoteDigest !== undefined && this.#remoteDigest !== confirm.digest) throw new Error();
          this.#remoteDigest = confirm.digest;
        }
        this.advance(socket, generation);
      } catch { this.retire('invalid-negotiation', 'failed'); }
      return;
    }
    if (!(data instanceof ArrayBuffer) || !this.isCurrentSession(this.#binding) || data.byteLength < HEADER || data.byteLength > this.#binding!.limits.maxMessageBytes + HEADER) {
      this.#dropped = increment(this.#dropped); return;
    }
    const frame = new Uint8Array(data);
    if (frame[0] !== 49 || frame[1] !== 48 || frame[2] !== 49 || frame[3] !== 87 || frame[4] !== 1 || frame[5]! > 1 || frame[6]! > 1 ||
      this.#tag!.some((byte, index) => frame[index + 7] !== byte)) { this.#dropped = increment(this.#dropped); return; }
    try {
      const payload = frame.slice(HEADER), value = frame[6] === 0 ? decoder.decode(payload) : payload.buffer;
      this.#received = increment(this.#received);
      for (const listener of this.#data) { if (!this.current(socket, generation) || !this.isCurrentSession(this.#binding)) break; try { listener(frame[5] === 0 ? 'reliable' : 'disposable', value); } catch { /* Observer only. */ } }
    } catch { this.#dropped = increment(this.#dropped); }
  }
  private advance(socket: WebSocketPort, generation: number): void {
    if (!this.current(socket, generation) || !this.#local || !this.#remote) return;
    if (!this.#digest && !this.#building) {
      this.#building = true;
      void this.build(socket, generation).catch(() => { if (this.current(socket, generation)) this.retire('invalid-negotiation', 'failed'); }); return;
    }
    if (!this.#digest) return;
    if (this.#remoteDigest !== undefined && this.#remoteDigest !== this.#digest) { this.retire('conflicting-negotiation', 'failed'); return; }
    if (!this.#confirmSent) this.#confirmSent = this.sendControl({ protocol: 'connect-wss', version: 1, type: 'confirm', digest: this.#digest });
    if (!this.current(socket, generation)) return;
    if (this.#confirmSent && this.#remoteDigest === this.#digest) {
      if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
      this.#reason = 'negotiated'; this.setState('connected');
    }
  }
  private async build(socket: WebSocketPort, generation: number): Promise<void> {
    const local = this.#local!, remote = this.#remote!;
    if (local.nonce === remote.nonce) throw new Error();
    const selected = limits({ maxMessageBytes: Math.min(local.limits.maxMessageBytes, remote.limits.maxMessageBytes),
      reliableBufferLimit: Math.min(local.limits.reliableBufferLimit, remote.limits.reliableBufferLimit), latestBufferLimit: Math.min(local.limits.latestBufferLimit, remote.limits.latestBufferLimit) });
    const clientHello = JSON.stringify(local.side === 'client' ? local : remote), serverHello = JSON.stringify(local.side === 'server' ? local : remote);
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(['101.wss-session/1', clientHello, serverHello, selected]))));
    if (!this.current(socket, generation) || this.clock() === undefined || !this.current(socket, generation)) return;
    this.#tag = digest; this.#digest = hex(digest);
    this.#binding = Object.freeze({ kind: 'wss', generation, initiator: local.side === 'client', endpoint: this.#endpoint,
      subprotocol: WSS_SUBPROTOCOL, clientHello, serverHello, limits: selected, connectionTag: this.#digest });
    this.advance(socket, generation);
  }
  send(lane: WebSocketLane, data: WebSocketData): boolean {
    if (!this.isOpen(lane) || this.clock() === undefined || !this.isOpen(lane)) return false;
    const socket = this.#socket!, generation = this.#generation, binding = this.#binding!;
    try {
      if (typeof data !== 'string' && !(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return false;
      if (typeof data === 'string' && data.length > binding.limits.maxMessageBytes) return false;
      const length = typeof data === 'string' ? encoder.encode(data).length : data.byteLength;
      const buffered = socket.bufferedAmount, cap = lane === 'reliable' ? binding.limits.reliableBufferLimit : binding.limits.latestBufferLimit;
      if (!Number.isSafeInteger(buffered) || buffered < 0 || length > binding.limits.maxMessageBytes || length + HEADER + buffered > cap || !this.current(socket, generation)) return false;
      const payload = typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
      const frame = new Uint8Array(HEADER + length); frame.set([49, 48, 49, 87, 1, lane === 'reliable' ? 0 : 1, typeof data === 'string' ? 0 : 1]);
      frame.set(this.#tag!, 7); frame.set(payload, HEADER); socket.send(frame);
      if (!this.current(socket, generation)) return false;
      this.#sent = increment(this.#sent); return true;
    } catch { this.retire('socket-unavailable', 'failed'); return false; }
  }
  tick(): void {
    const now = this.clock(); if (now === undefined || !this.#socket) return;
    if (this.#state === 'connecting' && now - this.#startedAt >= HANDSHAKE_MS) { this.retire('negotiation-timeout', 'failed'); return; }
    if (this.#socket.readyState !== 0 && this.#socket.readyState !== 1) { this.retire('transport-ended', 'disconnected'); return; }
    if (this.#state === 'connecting') this.advance(this.#socket, this.#generation);
  }
  async disconnect(): Promise<void> { this.retire('revoked', 'disconnected'); }
  private setState(state: WebSocketState): void {
    if (state === this.#state) return; this.#state = state;
    for (const listener of this.#states) { if (this.#state !== state) break; try { listener(state); } catch { /* Observer only. */ } }
  }
  private retire(reason: string, state: WebSocketState): void {
    if (this.#retiring) return;
    this.#retiring = true;
    const socket = this.#socket; ++this.#generation; this.#socket = undefined; this.#binding = undefined; this.#tag = undefined;
    this.#local = this.#remote = undefined; this.#digest = this.#remoteDigest = undefined; this.#confirmSent = this.#building = false; this.#controls = 0;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    if (socket) { try { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); } catch { /* Authority already retired. */ } }
    this.#reason = reason;
    try { this.setState(state); } finally { this.#retiring = false; }
  }
}
