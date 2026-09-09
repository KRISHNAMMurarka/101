import {
  MultiplexLinkTransport,
  PAIRING_TICKET_VERSION,
  WebRTCTransport,
  type ControlMessage,
  type DeviceCapabilities,
  type LinkMessage,
  type LinkState,
  type PairingTicket,
  type RealtimeMessage,
  type StatefulLinkTransport,
} from "@101/protocol";

/** Ceiling for signaling retry backoff. Long enough to stop hammering, short enough to recover. */
const MAX_RETRY_BACKOFF_MS = 10_000;
export const SIGNALING_PEER_IDLE_MS = 30_000;
export const MAX_SIGNALING_PEERS = 64;
export const MAX_SIGNALING_SESSIONS = 128;

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
  leave(lease: ControllerLease): Promise<void>;
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
    const now = options.now ?? this.now();
    this.expireAt(now);
    validateSessionId(options.sessionId);
    if (this.sessions.has(options.sessionId)) throw new Error(`Signaling session ${options.sessionId} already exists`);
    if (this.sessions.size >= MAX_SIGNALING_SESSIONS) throw new Error("Signaling Hub has too many live sessions");
    const ticket: PairingTicket = {
      version: PAIRING_TICKET_VERSION,
      sessionId: options.sessionId,
      endpoint: options.endpoint,
      joinToken: this.randomToken(),
      expiresAt: now + signalingSessionTtl(options.ttlMs),
      ...(options.hostName ? { hostName: options.hostName } : {}),
      transport: "webrtc",
    };
    const hostToken = this.randomToken();
    this.sessions.set(options.sessionId, { ticket, hostToken, peers: new Map() });
    return { ticket, hostToken };
  }

  resumeSession(sessionId: string, hostToken: string, options: { endpoint?: string; hostName?: string } = {}) {
    const session = this.hostSession(sessionId, hostToken);
    const ticket: PairingTicket = {
      ...session.ticket,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.hostName ? { hostName: options.hostName } : {}),
    };
    const nextHostToken = this.randomToken();
    session.ticket = ticket;
    session.hostToken = nextHostToken;
    return { ticket, hostToken: nextHostToken };
  }

  removeSession(sessionId: string, hostToken: string) {
    const session = this.hostSession(sessionId, hostToken);
    return this.sessions.delete(session.ticket.sessionId);
  }

  join(ticket: PairingTicket, joinToken: string, device: PairingDevice): ControllerLease {
    const session = this.liveSession(ticket.sessionId);
    if (!constantEqual(session.ticket.joinToken, joinToken) || !constantEqual(ticket.joinToken, joinToken)) throw new Error("Pairing authorization failed");
    validateDevice(device);
    this.prunePeers(session);
    if (session.peers.size >= MAX_SIGNALING_PEERS) throw new Error("Signaling session is full");
    const peerId = `peer-${this.randomToken().slice(0, 16)}`;
    const peer: SignalingPeer = {
      peerId,
      peerToken: this.randomToken(),
      device: { ...device, capabilities: { ...device.capabilities } },
      generation: 1,
      lastSeenAt: this.now(),
    };
    session.peers.set(peerId, peer);
    return lease(peer, session.ticket.expiresAt);
  }

  listPeers(sessionId: string, hostToken: string): HostPeerSignal[] {
    const session = this.hostSession(sessionId, hostToken);
    this.prunePeers(session);
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
    this.prunePeers(session);
    const peer = session.peers.get(peerId);
    if (!peer || !(asHost ? constantEqual(session.hostToken, token) : constantEqual(peer.peerToken, token))) throw new Error("Pairing authorization failed");
    peer.generation += 1;
    peer.offer = undefined;
    peer.answer = undefined;
    if (!asHost) peer.lastSeenAt = this.now();
    return lease(peer, session.ticket.expiresAt);
  }

  leave(sessionId: string, peerId: string, peerToken: string) {
    const { session } = this.controllerPeer(sessionId, peerId, peerToken);
    session.peers.delete(peerId);
  }

  expire() {
    const now = this.now();
    return this.expireAt(now);
  }

  private expireAt(now: number) {
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
    const session = this.hostSession(sessionId, hostToken);
    this.prunePeers(session);
    const peer = session.peers.get(peerId);
    if (!peer) throw new Error("Unknown signaling peer");
    return peer;
  }

  private controllerPeer(sessionId: string, peerId: string, peerToken: string) {
    const session = this.liveSession(sessionId);
    this.prunePeers(session);
    const peer = session.peers.get(peerId);
    if (!peer) throw new Error("Unknown signaling peer");
    if (!constantEqual(peer.peerToken, peerToken)) throw new Error("Pairing authorization failed");
    return { session, peer };
  }

  private prunePeers(session: SignalingSession) {
    const cutoff = this.now() - SIGNALING_PEER_IDLE_MS;
    for (const [peerId, peer] of session.peers) if (peer.lastSeenAt <= cutoff) session.peers.delete(peerId);
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
  async leave(value: ControllerLease) { this.broker.leave(this.ticket.sessionId, value.peerId, value.peerToken); }
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
  async leave(value: ControllerLease) { await requestJson(this.fetcher, this.url(`peers/${encodeURIComponent(value.peerId)}`), value.peerToken, "DELETE"); }
  private url(path: string) { return `${this.ticket.endpoint}/v1/sessions/${encodeURIComponent(this.ticket.sessionId)}/${path}`; }
}

export async function createHttpSignalingSession(endpoint: string, sessionId: string, options: { hostName?: string; ttlMs?: number; advertisedEndpoint?: string; hostToken?: string; fetcher?: typeof fetch } = {}) {
  const normalized = endpoint.replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${normalized}/v1/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.hostToken ? { Authorization: `Bearer ${options.hostToken}` } : {}),
    },
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
  private readonly pendingResets = new Set<string>();
  private readonly resetting = new Map<string, Promise<void>>();
  private readonly reconnects = new Set<Promise<void>>();
  private readonly factory: NegotiatedTransportFactory;
  private readonly pollIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private syncing?: Promise<void>;
  private active = false;
  private lifecycleRevision = 0;
  private consecutiveFailures = 0;
  private retryAfter = 0;
  private readonly errorListeners = new Set<(error: Error) => void>();
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
    const revision = ++this.lifecycleRevision;
    try {
      await this.sync();
    } catch (error) {
      if (this.isCurrent(revision)) {
        this.active = false;
        this.lifecycleRevision += 1;
        await Promise.all([...this.connections.keys()].map((peerId) => this.drop(peerId).catch(() => undefined)));
        this.pendingResets.clear();
        this.consecutiveFailures = 0;
        this.retryAfter = 0;
      }
      throw error;
    }
    if (!this.isCurrent(revision)) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  async stop() {
    this.active = false;
    this.lifecycleRevision += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.syncing?.catch(() => undefined);
    await Promise.allSettled([...this.reconnects]);
    await Promise.allSettled([...this.resetting.values()]);
    await Promise.all([...this.connections.keys()].map((peerId) => this.drop(peerId)));
    this.pendingResets.clear();
    this.consecutiveFailures = 0;
    this.retryAfter = 0;
  }

  async sync() {
    if (this.syncing) return this.syncing;
    if (Date.now() < this.retryAfter) return;
    const pending = this.performSync();
    this.syncing = pending;
    try {
      await pending;
      if (this.active) this.noteReachable();
    } finally {
      if (this.syncing === pending) this.syncing = undefined;
    }
  }

  /** Signaling failures recovered by the host poller. */
  onError(callback: (error: Error) => void) { this.errorListeners.add(callback); return () => this.errorListeners.delete(callback); }
  /** Milliseconds until a failed host poll is allowed to retry. */
  get retryDelayMs() { return Math.max(0, this.retryAfter - Date.now()); }

  private async poll() {
    try {
      await this.sync();
    } catch (cause) {
      if (this.active) this.noteUnreachable(cause);
    }
  }

  private async performSync() {
    const revision = this.lifecycleRevision;
    if (!this.isCurrent(revision)) return;
    const peers = await this.options.signaling.listPeers();
    if (!this.isCurrent(revision)) return;
    const live = new Set(peers.map((peer) => peer.peerId));
    for (const peerId of this.pendingResets) if (!live.has(peerId)) this.pendingResets.delete(peerId);
    for (const peerId of this.connections.keys()) {
      if (!live.has(peerId)) await this.drop(peerId);
      if (!this.isCurrent(revision)) return;
    }
    let deferredError: unknown;
    for (const peer of peers) {
      if (!this.isCurrent(revision)) return;
      if (this.pendingResets.has(peer.peerId)) {
        try {
          await this.resetPeerGeneration(peer.peerId, revision);
        } catch (cause) {
          deferredError ??= cause;
        }
        continue;
      }
      let connection = this.connections.get(peer.peerId);
      if (!connection || connection.generation !== peer.generation) {
        if (connection) await this.drop(peer.peerId);
        if (!this.isCurrent(revision)) return;
        const transport = this.factory(true);
        let removeState: (() => void) | undefined;
        try {
          await transport.connect();
          if (!this.isCurrent(revision)) {
            await transport.disconnect();
            return;
          }
          const offer = await transport.createOfferCode();
          if (!this.isCurrent(revision)) {
            await transport.disconnect();
            return;
          }
          removeState = transport.onStateChange((state) => {
            if ((state === "failed" || state === "disconnected") && this.connections.get(peer.peerId)?.transport === transport && this.active) {
              this.startReconnect(peer.peerId);
            }
          });
          connection = { generation: peer.generation, transport, accepted: false, removeState };
          this.connections.set(peer.peerId, connection);
          await this.options.transport.add(`webrtc-${peer.peerId}`, transport, {
            wireDeviceId: peer.deviceId,
            routeDeviceId: `webrtc-${peer.peerId}`,
          });
          if (!this.isCurrent(revision)) {
            await this.drop(peer.peerId);
            return;
          }
          await this.options.signaling.publishOffer(peer.peerId, peer.generation, offer);
          if (!this.isCurrent(revision)) {
            await this.drop(peer.peerId);
            return;
          }
        } catch (error) {
          if (this.connections.get(peer.peerId)?.transport === transport) {
            await this.drop(peer.peerId).catch(() => undefined);
          } else {
            removeState?.();
            await transport.disconnect().catch(() => undefined);
          }
          throw error;
        }
      }
      if (peer.answer && !connection.accepted) {
        try {
          await connection.transport.acceptAnswerCode(peer.answer);
        } catch {
          await this.drop(peer.peerId).catch(() => undefined);
          if (!this.isCurrent(revision)) return;
          this.pendingResets.add(peer.peerId);
          try {
            await this.resetPeerGeneration(peer.peerId, revision);
          } catch (cause) {
            deferredError ??= cause;
          }
          continue;
        }
        if (!this.isCurrent(revision)) return;
        connection.accepted = true;
      }
    }
    if (deferredError) throw deferredError;
  }

  private isCurrent(revision: number) {
    return this.active && this.lifecycleRevision === revision;
  }

  private noteReachable() {
    this.consecutiveFailures = 0;
    this.retryAfter = 0;
  }

  private noteUnreachable(cause: unknown) {
    const first = this.consecutiveFailures === 0;
    this.consecutiveFailures += 1;
    const backoff = Math.min(MAX_RETRY_BACKOFF_MS, this.pollIntervalMs * 2 ** Math.min(this.consecutiveFailures, 6));
    this.retryAfter = Date.now() + backoff;
    if (!first) return;
    const error = toError(cause);
    this.errorListeners.forEach((listener) => {
      try { listener(error); } catch { /* Diagnostics must not break the recovery poller. */ }
    });
  }

  private async reconnect(peerId: string) {
    const revision = this.lifecycleRevision;
    this.pendingResets.add(peerId);
    try {
      await this.drop(peerId);
      if (!this.isCurrent(revision)) return;
      await this.resetPeerGeneration(peerId, revision);
    } catch {
      // Keep the reset intent. The normal poll retries it before publishing another offer.
    }
  }

  private startReconnect(peerId: string) {
    const operation = this.reconnect(peerId);
    this.reconnects.add(operation);
    void operation.then(
      () => { this.reconnects.delete(operation); },
      () => { this.reconnects.delete(operation); },
    );
  }

  private resetPeerGeneration(peerId: string, revision: number) {
    const existing = this.resetting.get(peerId);
    if (existing) return existing;
    const operation = this.performPeerReset(peerId, revision);
    this.resetting.set(peerId, operation);
    void operation.then(
      () => { if (this.resetting.get(peerId) === operation) this.resetting.delete(peerId); },
      () => { if (this.resetting.get(peerId) === operation) this.resetting.delete(peerId); },
    );
    return operation;
  }

  private async performPeerReset(peerId: string, revision: number) {
    try {
      await this.options.signaling.resetPeer(peerId);
    } catch (cause) {
      if (isMissingPeerError(cause)) {
        this.pendingResets.delete(peerId);
        return;
      }
      throw cause;
    }
    if (this.isCurrent(revision)) this.pendingResets.delete(peerId);
  }

  private async drop(peerId: string) {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    this.connections.delete(peerId);
    connection.removeState();
    const removed = await this.options.transport.remove(`webrtc-${peerId}`);
    if (!removed) await connection.transport.disconnect();
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
  private syncing?: Promise<Error | undefined>;
  private active = false;
  private lifecycleRevision = 0;
  private reconnecting = false;
  private reconnectPending = false;
  private rejoining = false;
  private consecutiveFailures = 0;
  private retryAfter = 0;
  private readonly errorListeners = new Set<(error: Error) => void>();
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
    const revision = ++this.lifecycleRevision;
    this.setState("connecting");
    let lease: ControllerLease;
    try {
      lease = await this.options.signaling.join(this.options.device);
    } catch (error) {
      // A failed first join owns no lease or transport. Release its lifecycle claim so a caller can
      // retry instead of hitting the `active` early return forever. Do not overwrite a deliberate
      // disconnect that may have won while the request was in flight.
      if (this.isCurrent(revision)) {
        this.active = false;
        this.lifecycleRevision += 1;
        this.setState("disconnected");
      }
      throw error;
    }
    if (!this.isCurrent(revision)) {
      await this.safeLeave(lease);
      return;
    }
    this.lease = lease;
    const syncError = await this.syncResult();
    if (syncError && this.isCurrent(revision) && this.lease === lease) {
      await this.rollbackInitialConnection(revision, lease);
      throw syncError;
    }
    if (!this.isCurrent(revision)) return;
    this.timer = setInterval(() => void this.sync(), this.pollIntervalMs);
  }

  async disconnect() {
    this.active = false;
    this.lifecycleRevision += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.syncing?.catch(() => undefined);
    this.removeMessage?.();
    this.removeMessage = undefined;
    this.removeState?.();
    this.removeState = undefined;
    await this.transport?.disconnect();
    this.transport = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (lease) await this.safeLeave(lease);
    this.generation = 0;
    this.reconnectPending = false;
    // A deliberate disconnect must not leave a backoff that delays the next connect.
    this.consecutiveFailures = 0;
    this.retryAfter = 0;
    this.setState("disconnected");
  }

  async sync() {
    await this.syncResult();
  }

  private syncResult() {
    if (this.syncing) return this.syncing;
    const revision = this.lifecycleRevision;
    const lease = this.lease;
    const pending = this.performSync().catch((cause: unknown) => {
      if (!this.isCurrent(revision) || this.lease !== lease) return undefined;
      const error = toError(cause);
      this.noteUnreachable(error);
      return error;
    });
    this.syncing = pending;
    void pending.then(
      () => { if (this.syncing === pending) this.syncing = undefined; },
      () => { if (this.syncing === pending) this.syncing = undefined; },
    );
    return pending;
  }

  sendReliable(message: ControlMessage) { this.transport?.sendReliable(message); }
  sendRealtime(message: RealtimeMessage) { this.transport?.sendRealtime(message); }
  onMessage(callback: (message: LinkMessage) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onStateChange(callback: (state: LinkState) => void) { this.stateListeners.add(callback); callback(this.currentState); return () => this.stateListeners.delete(callback); }
  /** Signaling failures the transport recovered from, so a UI can explain itself instead of crashing. */
  onError(callback: (error: Error) => void) { this.errorListeners.add(callback); return () => this.errorListeners.delete(callback); }
  /** Milliseconds until the next poll is allowed; 0 once the Hub is answering again. */
  get retryDelayMs() { return Math.max(0, this.retryAfter - Date.now()); }

  private async performSync(): Promise<Error | undefined> {
    const revision = this.lifecycleRevision;
    const lease = this.lease;
    if (!this.isCurrent(revision) || !lease) return;
    if (Date.now() < this.retryAfter) return;
    let signal: { offer?: string; generation: number };
    try {
      signal = await this.options.signaling.getOffer(lease);
      if (!this.isCurrent(revision) || this.lease !== lease) return;
      if (this.reconnectPending) {
        await this.requestReconnect();
        return;
      }
      this.noteReachable();
    } catch (cause) {
      if (isMissingPeerError(cause)) {
        await this.rejoinMissingLease(revision, lease);
        return;
      }
      // The poll runs on a timer, so this rejection has nowhere to go but the global handler.
      if (this.isCurrent(revision)) this.noteUnreachable(cause);
      return;
    }
    if (!signal.offer || signal.generation === this.generation) return;
    let transactionTransport: NegotiatedLinkTransport | undefined;
    try {
      this.removeMessage?.();
      this.removeMessage = undefined;
      this.removeState?.();
      this.removeState = undefined;
      const previous = this.transport;
      this.transport = undefined;
      await previous?.disconnect();
      if (!this.isCurrent(revision) || this.lease !== lease) return;
      const transport = this.factory(false);
      transactionTransport = transport;
      this.transport = transport;
      this.removeMessage = transport.onMessage((message) => this.listeners.forEach((listener) => listener(message)));
      this.removeState = transport.onStateChange((state) => {
        this.setState(state);
        if ((state === "failed" || state === "disconnected") && this.active && this.transport === transport) {
          this.reconnectPending = true;
          void this.requestReconnect();
        }
      });
      const answer = await transport.acceptOfferCode(signal.offer);
      if (!this.isCurrent(revision) || this.lease !== lease) return;
      await this.options.signaling.publishAnswer(lease, signal.generation, answer);
      if (!this.isCurrent(revision) || this.lease !== lease) return;
      this.generation = signal.generation;
      return;
    } catch (cause) {
      if (transactionTransport) await this.discardTransport(transactionTransport);
      // A disconnect or a newer connection invalidates the work instead of turning cancellation
      // into a user-visible signaling failure.
      if (!this.isCurrent(revision) || this.lease !== lease) return;
      const error = toError(cause);
      this.noteUnreachable(error);
      return error;
    }
  }

  private async rollbackInitialConnection(revision: number, lease: ControllerLease) {
    if (!this.isCurrent(revision) || this.lease !== lease) return;
    this.active = false;
    this.lifecycleRevision += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.removeMessage?.();
    this.removeMessage = undefined;
    this.removeState?.();
    this.removeState = undefined;
    const transport = this.transport;
    this.transport = undefined;
    await transport?.disconnect().catch(() => undefined);
    this.lease = undefined;
    await this.safeLeave(lease);
    this.generation = 0;
    this.reconnectPending = false;
    this.consecutiveFailures = 0;
    this.retryAfter = 0;
    this.setState("disconnected");
  }

  private async discardTransport(transport: NegotiatedLinkTransport) {
    if (this.transport === transport) {
      this.removeMessage?.();
      this.removeMessage = undefined;
      this.removeState?.();
      this.removeState = undefined;
      this.transport = undefined;
    }
    await transport.disconnect().catch(() => undefined);
  }

  private async requestReconnect() {
    const revision = this.lifecycleRevision;
    const lease = this.lease;
    if (this.reconnecting || !lease || !this.isCurrent(revision)) return;
    this.reconnecting = true;
    try {
      const replacement = await this.options.signaling.requestReconnect(lease);
      if (!this.isCurrent(revision) || this.lease !== lease) return;
      this.lease = replacement;
      this.generation = 0;
      this.reconnectPending = false;
      this.noteReachable();
      this.setState("connecting");
    } catch (cause) {
      if (isMissingPeerError(cause)) {
        await this.rejoinMissingLease(revision, lease);
        return;
      }
      // A Hub that has gone away is an ordinary connection state, not a crash. Losing this
      // rejection into the void previously surfaced as an unhandled-promise error on the device.
      this.noteUnreachable(cause);
    } finally {
      this.reconnecting = false;
    }
  }

  private async rejoinMissingLease(revision: number, staleLease: ControllerLease) {
    if (this.rejoining || !this.isCurrent(revision) || this.lease !== staleLease) return;
    this.rejoining = true;
    try {
      const replacement = await this.options.signaling.join(this.options.device);
      if (!this.isCurrent(revision) || this.lease !== staleLease) {
        await this.safeLeave(replacement);
        return;
      }
      this.removeMessage?.();
      this.removeMessage = undefined;
      this.removeState?.();
      this.removeState = undefined;
      const previous = this.transport;
      this.transport = undefined;
      await previous?.disconnect();
      if (!this.isCurrent(revision) || this.lease !== staleLease) {
        await this.safeLeave(replacement);
        return;
      }
      this.lease = replacement;
      this.generation = 0;
      this.reconnectPending = false;
      this.noteReachable();
      this.setState("connecting");
    } catch (cause) {
      if (this.isCurrent(revision)) this.noteUnreachable(cause);
    } finally {
      this.rejoining = false;
    }
  }

  private async safeLeave(lease: ControllerLease) {
    try { await this.options.signaling.leave(lease); } catch { /* Expiry and network loss already remove the lease. */ }
  }

  /**
   * Records that the Hub answered, clearing any backoff.
   */
  private noteReachable() {
    if (this.consecutiveFailures === 0) return;
    this.consecutiveFailures = 0;
    this.retryAfter = 0;
  }

  /**
   * Records that the Hub could not be reached.
   *
   * The polling loop runs several times a second, so an unreachable Hub used to raise an unhandled
   * rejection on every tick — roughly eighty per minute, each surfacing as an error toast. Failures
   * are now reported once through the error channel and the poll backs off, because hammering a Hub
   * that is not there helps nobody and hides the one message that matters.
   */
  private noteUnreachable(cause: unknown) {
    const first = this.consecutiveFailures === 0;
    this.consecutiveFailures += 1;
    const backoff = Math.min(MAX_RETRY_BACKOFF_MS, this.pollIntervalMs * 2 ** Math.min(this.consecutiveFailures, 6));
    this.retryAfter = Date.now() + backoff;
    if (this.currentState === "connected" || this.currentState === "connecting") this.setState("disconnected");
    // Report the first failure of a run only; the rest are the same fact repeated.
    if (first) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.errorListeners.forEach((listener) => {
        try { listener(error); } catch { /* Diagnostics must not interrupt signaling recovery. */ }
      });
    }
  }

  private setState(state: LinkState) {
    if (state === this.currentState) return;
    this.currentState = state;
    this.stateListeners.forEach((listener) => listener(state));
  }

  private isCurrent(revision: number) {
    return this.active && this.lifecycleRevision === revision;
  }
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function requestJson<Value = unknown>(fetcher: typeof fetch, url: string, token: string, method = "GET", body?: unknown): Promise<Value> {
  const response = await fetcher(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new SignalingRequestError(response.status);
  if (response.status === 204) return undefined as Value;
  return response.json() as Promise<Value>;
}

class SignalingRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`101 signaling request failed (${status})`);
    this.status = status;
  }
}

function isMissingPeerError(cause: unknown) {
  return cause instanceof SignalingRequestError
    ? cause.status === 404 || cause.status === 410
    : cause instanceof Error && /Unknown signaling peer|signaling request failed \((?:404|410)\)/.test(cause.message);
}

function validateDevice(device: PairingDevice) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(device.deviceId) || !device.label.trim() || device.label.length > 128) throw new Error("Invalid pairing device");
}

function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || !/^[A-Z0-9-]{4,128}$/i.test(sessionId)) throw new Error("Invalid signaling session id");
}

function signalingSessionTtl(value: number | undefined) {
  if (value === undefined) return 4 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid signaling session lifetime");
  return Math.min(24 * 60 * 60 * 1_000, Math.max(60_000, value));
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
