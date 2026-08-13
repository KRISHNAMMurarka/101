import {
  MultiplexLinkTransport,
  PROTOCOL_VERSION,
  WebRTCTransport,
  type ControlMessage,
  type DeviceCapabilities,
  type LinkMessage,
  type LinkState,
  type PairingTicket,
  type StatefulLinkTransport,
} from "@101/protocol";
import type { InputFrame } from "@101/input";

export interface PairingDevice {
  deviceId: string;
  label: string;
  capabilities: DeviceCapabilities;
}

export interface ControllerLease {
  peerId: string;
  peerToken: string;
  generation: number;
  expiresAt: number;
}

export interface HostPeerSignal {
  peerId: string;
  deviceId: string;
  generation: number;
  answer?: string;
  lastSeenAt: number;
}

export interface ControllerOfferSignal {
  generation: number;
  offer?: string;
  expiresAt: number;
}

export interface CreatedSignalingSession {
  ticket: PairingTicket;
  hostToken: string;
}

export interface HostSignalingClient {
  listPeers(): Promise<readonly HostPeerSignal[]>;
  publishOffer(peerId: string, generation: number, offer: string): Promise<void>;
  resetPeer(peerId: string): Promise<void>;
}

export interface ControllerSignalingClient {
  join(device: PairingDevice): Promise<ControllerLease>;
  getOffer(lease: ControllerLease): Promise<ControllerOfferSignal>;
  publishAnswer(lease: ControllerLease, generation: number, answer: string): Promise<void>;
  requestReconnect(lease: ControllerLease): Promise<ControllerLease>;
}

export interface NegotiatedLinkTransport extends StatefulLinkTransport {
  createOfferCode(): Promise<string>;
  acceptOfferCode(code: string): Promise<string>;
  acceptAnswerCode(code: string): Promise<void>;
}

export type NegotiatedTransportFactory = (initiator: boolean) => NegotiatedLinkTransport;

export interface SignalingSessionOptions {
  sessionId: string;
  endpoint: string;
  hostName?: string;
  ttlMs?: number;
  now?: number;
}

interface SignalingPeer {
  peerId: string;
  peerToken: string;
  device: PairingDevice;
  generation: number;
  offer?: string;
  answer?: string;
  lastSeenAt: number;
}

interface SignalingSession {
  ticket: PairingTicket;
  hostToken: string;
  peers: Map<string, SignalingPeer>;
}

export class LocalSignalingBroker {
  private readonly sessions = new Map<string, SignalingSession>();
  private readonly randomToken: () => string;
  private readonly now: () => number;

  constructor(options: { randomToken?: () => string; now?: () => number } = {}) {
    this.randomToken = options.randomToken ?? secureToken;
    this.now = options.now ?? Date.now;
  }

  createSession(options: SignalingSessionOptions) {
    if (this.sessions.has(options.sessionId)) throw new Error(`Signaling session ${options.sessionId} already exists`);
    const now = options.now ?? this.now();
    const ticket: PairingTicket = {
      version: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      endpoint: options.endpoint,
      joinToken: this.randomToken(),
      expiresAt: now + (options.ttlMs ?? 4 * 60 * 60 * 1_000),
      ...(options.hostName ? { hostName: options.hostName } : {}),
      transport: "webrtc",
    };
    const hostToken = this.randomToken();
    this.sessions.set(options.sessionId, { ticket, hostToken, peers: new Map() });
    return { ticket, hostToken };
  }

  removeSession(sessionId: string, hostToken: string) {
    const session = this.hostSession(sessionId, hostToken);
    return this.sessions.delete(session.ticket.sessionId);
  }

  join(ticket: PairingTicket, joinToken: string, device: PairingDevice): ControllerLease {
    const session = this.liveSession(ticket.sessionId);
    if (!constantEqual(session.ticket.joinToken, joinToken) || !constantEqual(ticket.joinToken, joinToken)) throw new Error("Pairing authorization failed");
    validateDevice(device);
    const previous = [...session.peers.values()].find((peer) => peer.device.deviceId === device.deviceId);
    if (previous) session.peers.delete(previous.peerId);
    const peerId = `peer-${this.randomToken().slice(0, 16)}`;
    const peer: SignalingPeer = {
      peerId,
      peerToken: this.randomToken(),
      device: { ...device, capabilities: { ...device.capabilities } },
      generation: (previous?.generation ?? 0) + 1,
      lastSeenAt: this.now(),
    };
    session.peers.set(peerId, peer);
    return lease(peer, session.ticket.expiresAt);
  }

  listPeers(sessionId: string, hostToken: string): HostPeerSignal[] {
    const session = this.hostSession(sessionId, hostToken);
    return [...session.peers.values()].map((peer) => ({
      peerId: peer.peerId,
      deviceId: peer.device.deviceId,
      generation: peer.generation,
      ...(peer.answer ? { answer: peer.answer } : {}),
      lastSeenAt: peer.lastSeenAt,
    }));
  }

  publishOffer(sessionId: string, hostToken: string, peerId: string, generation: number, offer: string) {
    const peer = this.hostPeer(sessionId, hostToken, peerId);
    if (peer.generation !== generation) throw new Error("Stale signaling generation");
    peer.offer = pairingCode(offer, "offer");
    peer.answer = undefined;
  }

  getOffer(sessionId: string, peerId: string, peerToken: string): ControllerOfferSignal {
    const { session, peer } = this.controllerPeer(sessionId, peerId, peerToken);
    peer.lastSeenAt = this.now();
    return { generation: peer.generation, ...(peer.offer ? { offer: peer.offer } : {}), expiresAt: session.ticket.expiresAt };
  }

  publishAnswer(sessionId: string, peerId: string, peerToken: string, generation: number, answer: string) {
    const { peer } = this.controllerPeer(sessionId, peerId, peerToken);
    if (peer.generation !== generation || !peer.offer) throw new Error("Stale signaling generation");
    peer.answer = pairingCode(answer, "answer");
    peer.lastSeenAt = this.now();
  }

  requestReconnect(sessionId: string, peerId: string, token: string, asHost = false): ControllerLease {
    const session = this.liveSession(sessionId);
    const peer = session.peers.get(peerId);
    if (!peer || !(asHost ? constantEqual(session.hostToken, token) : constantEqual(peer.peerToken, token))) throw new Error("Pairing authorization failed");
    peer.generation += 1;
    peer.offer = undefined;
    peer.answer = undefined;
    peer.lastSeenAt = this.now();
    return lease(peer, session.ticket.expiresAt);
  }

  expire() {
    const now = this.now();
    const expired: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.ticket.expiresAt > now) continue;
      expired.push(sessionId);
      this.sessions.delete(sessionId);
    }
    return expired;
  }

  private liveSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown signaling session");
    if (session.ticket.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      throw new Error("Signaling session expired");
    }
    return session;
  }

  private hostSession(sessionId: string, hostToken: string) {
    const session = this.liveSession(sessionId);
    if (!constantEqual(session.hostToken, hostToken)) throw new Error("Pairing authorization failed");
    return session;
  }

  private hostPeer(sessionId: string, hostToken: string, peerId: string) {
    const peer = this.hostSession(sessionId, hostToken).peers.get(peerId);
    if (!peer) throw new Error("Unknown signaling peer");
    return peer;
  }

  private controllerPeer(sessionId: string, peerId: string, peerToken: string) {
    const session = this.liveSession(sessionId);
    const peer = session.peers.get(peerId);
    if (!peer || !constantEqual(peer.peerToken, peerToken)) throw new Error("Pairing authorization failed");
    return { session, peer };
  }
}

export class BrokerHostSignalingClient implements HostSignalingClient {
  private readonly broker: LocalSignalingBroker;
  private readonly sessionId: string;
  private readonly hostToken: string;
  constructor(broker: LocalSignalingBroker, sessionId: string, hostToken: string) {
    this.broker = broker;
    this.sessionId = sessionId;
    this.hostToken = hostToken;
  }
  async listPeers() { return this.broker.listPeers(this.sessionId, this.hostToken); }
  async publishOffer(peerId: string, generation: number, offer: string) { this.broker.publishOffer(this.sessionId, this.hostToken, peerId, generation, offer); }
  async resetPeer(peerId: string) { this.broker.requestReconnect(this.sessionId, peerId, this.hostToken, true); }
}

export class BrokerControllerSignalingClient implements ControllerSignalingClient {
  private readonly broker: LocalSignalingBroker;
  private readonly ticket: PairingTicket;
  constructor(broker: LocalSignalingBroker, ticket: PairingTicket) {
    this.broker = broker;
    this.ticket = ticket;
  }
  async join(device: PairingDevice) { return this.broker.join(this.ticket, this.ticket.joinToken, device); }
  async getOffer(value: ControllerLease) { return this.broker.getOffer(this.ticket.sessionId, value.peerId, value.peerToken); }
  async publishAnswer(value: ControllerLease, generation: number, answer: string) { this.broker.publishAnswer(this.ticket.sessionId, value.peerId, value.peerToken, generation, answer); }
  async requestReconnect(value: ControllerLease) { return this.broker.requestReconnect(this.ticket.sessionId, value.peerId, value.peerToken); }
}

export class HttpHostSignalingClient implements HostSignalingClient {
  private readonly endpoint: string;
  private readonly sessionId: string;
  private readonly hostToken: string;
  private readonly fetcher: typeof fetch;
  constructor(endpoint: string, sessionId: string, hostToken: string, fetcher: typeof fetch = fetch) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.sessionId = sessionId;
    this.hostToken = hostToken;
    this.fetcher = fetcher;
  }
  async listPeers() { return requestJson<HostPeerSignal[]>(this.fetcher, this.url("peers"), this.hostToken); }
  async publishOffer(peerId: string, generation: number, offer: string) { await requestJson(this.fetcher, this.url(`peers/${encodeURIComponent(peerId)}/offer`), this.hostToken, "PUT", { generation, offer }); }
  async resetPeer(peerId: string) { await requestJson(this.fetcher, this.url(`peers/${encodeURIComponent(peerId)}/reconnect`), this.hostToken, "POST"); }
  private url(path: string) { return `${this.endpoint}/v1/sessions/${encodeURIComponent(this.sessionId)}/host/${path}`; }
}

export class HttpControllerSignalingClient implements ControllerSignalingClient {
  private readonly ticket: PairingTicket;
  private readonly fetcher: typeof fetch;
  constructor(ticket: PairingTicket, fetcher: typeof fetch = fetch) {
    this.ticket = ticket;
    this.fetcher = fetcher;
  }
  async join(device: PairingDevice) { return requestJson<ControllerLease>(this.fetcher, this.url("peers"), this.ticket.joinToken, "POST", device); }
  async getOffer(value: ControllerLease) { return requestJson<ControllerOfferSignal>(this.fetcher, this.url(`peers/${encodeURIComponent(value.peerId)}/offer`), value.peerToken); }
  async publishAnswer(value: ControllerLease, generation: number, answer: string) { await requestJson(this.fetcher, this.url(`peers/${encodeURIComponent(value.peerId)}/answer`), value.peerToken, "PUT", { generation, answer }); }
  async requestReconnect(value: ControllerLease) { return requestJson<ControllerLease>(this.fetcher, this.url(`peers/${encodeURIComponent(value.peerId)}/reconnect`), value.peerToken, "POST"); }
  private url(path: string) { return `${this.ticket.endpoint}/v1/sessions/${encodeURIComponent(this.ticket.sessionId)}/${path}`; }
}

export async function createHttpSignalingSession(endpoint: string, sessionId: string, options: { hostName?: string; ttlMs?: number; advertisedEndpoint?: string; fetcher?: typeof fetch } = {}) {
  const normalized = endpoint.replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${normalized}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, hostName: options.hostName, ttlMs: options.ttlMs, endpoint: options.advertisedEndpoint ?? normalized }),
  });
  if (!response.ok) throw new Error(`101 Hub session creation failed (${response.status})`);
  return response.json() as Promise<CreatedSignalingSession>;
}

export interface AutomaticPairingHostOptions {
  signaling: HostSignalingClient;
  transport: MultiplexLinkTransport;
  transportFactory?: NegotiatedTransportFactory;
  pollIntervalMs?: number;
}

export class AutomaticPairingHost {
  private readonly connections = new Map<string, { generation: number; transport: NegotiatedLinkTransport; accepted: boolean; removeState: () => void }>();
  private readonly factory: NegotiatedTransportFactory;
  private readonly pollIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private syncing?: Promise<void>;
  private active = false;
  private readonly options: AutomaticPairingHostOptions;

  constructor(options: AutomaticPairingHostOptions) {
    this.options = options;
    this.factory = options.transportFactory ?? ((initiator) => new WebRTCTransport({
      initiator,
      iceServers: [],
      pairingCompression: false,
    }));
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    await this.sync();
    this.timer = setInterval(() => void this.sync(), this.pollIntervalMs);
  }

  async stop() {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.connections.keys()].map((peerId) => this.drop(peerId)));
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.performSync().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async performSync() {
    const peers = await this.options.signaling.listPeers();
    const live = new Set(peers.map((peer) => peer.peerId));
    for (const peerId of this.connections.keys()) if (!live.has(peerId)) await this.drop(peerId);
    for (const peer of peers) {
      let connection = this.connections.get(peer.peerId);
      if (!connection || connection.generation !== peer.generation) {
        if (connection) await this.drop(peer.peerId);
        const transport = this.factory(true);
        await transport.connect();
        const offer = await transport.createOfferCode();
        const removeState = transport.onStateChange((state) => {
          if ((state === "failed" || state === "disconnected") && this.connections.get(peer.peerId)?.transport === transport && this.active) {
            void this.reconnect(peer.peerId);
          }
        });
        connection = { generation: peer.generation, transport, accepted: false, removeState };
        this.connections.set(peer.peerId, connection);
        await this.options.transport.add(`webrtc-${peer.peerId}`, transport);
        await this.options.signaling.publishOffer(peer.peerId, peer.generation, offer);
      }
      if (peer.answer && !connection.accepted) {
        await connection.transport.acceptAnswerCode(peer.answer);
        connection.accepted = true;
      }
    }
  }

  private async reconnect(peerId: string) {
    await this.drop(peerId);
    try { await this.options.signaling.resetPeer(peerId); } catch { /* The peer may already have left. */ }
  }

  private async drop(peerId: string) {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    this.connections.delete(peerId);
    connection.removeState();
    await this.options.transport.remove(`webrtc-${peerId}`);
  }
}

export interface SignaledLinkTransportOptions {
  signaling: ControllerSignalingClient;
  device: PairingDevice;
  transportFactory?: NegotiatedTransportFactory;
  pollIntervalMs?: number;
}

export class SignaledLinkTransport implements StatefulLinkTransport {
  private readonly listeners = new Set<(message: LinkMessage) => void>();
  private readonly stateListeners = new Set<(state: LinkState) => void>();
  private readonly factory: NegotiatedTransportFactory;
  private readonly pollIntervalMs: number;
  private lease?: ControllerLease;
  private generation = 0;
  private transport?: NegotiatedLinkTransport;
  private removeMessage?: () => void;
  private removeState?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private syncing?: Promise<void>;
  private active = false;
  private reconnecting = false;
  private currentState: LinkState = "idle";
  private readonly options: SignaledLinkTransportOptions;

  constructor(options: SignaledLinkTransportOptions) {
    this.options = options;
    this.factory = options.transportFactory ?? ((initiator) => new WebRTCTransport({
      initiator,
      iceServers: [],
      pairingCompression: false,
    }));
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
  }

  get state() { return this.currentState; }

  async connect() {
    if (this.active) return;
    this.active = true;
    this.setState("connecting");
    this.lease = await this.options.signaling.join(this.options.device);
    await this.sync();
    this.timer = setInterval(() => void this.sync(), this.pollIntervalMs);
  }

  async disconnect() {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.removeMessage?.();
    this.removeState?.();
    await this.transport?.disconnect();
    this.transport = undefined;
    this.setState("disconnected");
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.performSync().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  sendReliable(message: ControlMessage) { this.transport?.sendReliable(message); }
  sendRealtime(frame: InputFrame) { this.transport?.sendRealtime(frame); }
  onMessage(callback: (message: LinkMessage) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onStateChange(callback: (state: LinkState) => void) { this.stateListeners.add(callback); callback(this.currentState); return () => this.stateListeners.delete(callback); }

  private async performSync() {
    if (!this.active || !this.lease) return;
    const signal = await this.options.signaling.getOffer(this.lease);
    if (!signal.offer || signal.generation === this.generation) return;
    this.removeMessage?.();
    this.removeState?.();
    await this.transport?.disconnect();
    const transport = this.factory(false);
    this.transport = transport;
    this.removeMessage = transport.onMessage((message) => this.listeners.forEach((listener) => listener(message)));
    this.removeState = transport.onStateChange((state) => {
      this.setState(state);
      if ((state === "failed" || state === "disconnected") && this.active && this.transport === transport) void this.requestReconnect();
    });
    const answer = await transport.acceptOfferCode(signal.offer);
    await this.options.signaling.publishAnswer(this.lease, signal.generation, answer);
    this.generation = signal.generation;
  }

  private async requestReconnect() {
    if (this.reconnecting || !this.lease) return;
    this.reconnecting = true;
    try {
      this.lease = await this.options.signaling.requestReconnect(this.lease);
      this.generation = 0;
      this.setState("connecting");
    } finally {
      this.reconnecting = false;
    }
  }

  private setState(state: LinkState) {
    if (state === this.currentState) return;
    this.currentState = state;
    this.stateListeners.forEach((listener) => listener(state));
  }
}

async function requestJson<Value = unknown>(fetcher: typeof fetch, url: string, token: string, method = "GET", body?: unknown): Promise<Value> {
  const response = await fetcher(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`101 signaling request failed (${response.status})`);
  if (response.status === 204) return undefined as Value;
  return response.json() as Promise<Value>;
}

function validateDevice(device: PairingDevice) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(device.deviceId) || !device.label.trim() || device.label.length > 128) throw new Error("Invalid pairing device");
}

function lease(peer: SignalingPeer, expiresAt: number): ControllerLease {
  return { peerId: peer.peerId, peerToken: peer.peerToken, generation: peer.generation, expiresAt };
}

function pairingCode(value: string, type: "offer" | "answer") {
  if (value.length < 8 || value.length > 400_000 || !value.startsWith("101")) throw new Error(`Invalid WebRTC ${type} code`);
  return value;
}

function secureToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function constantEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
