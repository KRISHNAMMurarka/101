import type { PeerConnectionPort, PeerDataChannelPort } from './ports.ts';
export type PeerState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
export type PeerLane = 'reliable' | 'disposable';
export type PeerData = string | ArrayBuffer | Uint8Array;
export interface PeerSessionBinding {
  readonly generation: number;
  /** The SDP offerer; distinct from which endpoint creates the data channels. */
  readonly initiator: boolean;
  readonly offer: Readonly<{ type: 'offer'; sdp: string }>;
  readonly answer: Readonly<{ type: 'answer'; sdp: string }>;
}
export interface PeerTransportOptions {
  initiator: boolean;
  iceServers?: RTCIceServer[];
  channels?: { reliable: string; disposable: string };
  reliableBufferLimit?: number;
  disposableBufferLimit?: number;
  maxMessageBytes?: number;
  createPeer?: (configuration: RTCConfiguration) => PeerConnectionPort;
}

/** Raw, game-independent peer. Payload parsing and resource authority belong to the caller. */
export class PeerDataTransport {
  private peer?: PeerConnectionPort;
  private generation = 0;
  private lifecycle?: AbortController;
  private readonly channels: Partial<Record<PeerLane, PeerDataChannelPort>> = {};
  private readonly dataListeners = new Set<(lane: PeerLane, data: string | ArrayBuffer) => void>();
  private readonly stateListeners = new Set<(state: PeerState) => void>();
  private currentState: PeerState = 'idle';
  private readonly options: PeerTransportOptions;
  private readonly names: { reliable: string; disposable: string };
  private readonly limits: Record<PeerLane, number>;
  private readonly maxMessageBytes: number;
  private negotiation: 'none' | 'offering' | 'offered' | 'answering' | 'complete' = 'none';
  private negotiatedOffer?: Readonly<{ type: 'offer'; sdp: string }>;
  #binding?: PeerSessionBinding;

  constructor(options: PeerTransportOptions) {
    this.options = options;
    this.names = { ...(options.channels ?? { reliable: 'connect-control-1', disposable: 'connect-samples-1' }) };
    if (!this.names.reliable || !this.names.disposable || this.names.reliable === this.names.disposable ||
      Object.values(this.names).some(name => name.length > 128)) throw new Error('Invalid peer channel names');
    this.limits = { reliable: options.reliableBufferLimit ?? 262144, disposable: options.disposableBufferLimit ?? 65536 };
    this.maxMessageBytes = options.maxMessageBytes ?? 262144;
    if (Object.values(this.limits).some(limit => limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) ||
      !Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1 || this.maxMessageBytes > 1048576)
      throw new Error('Invalid peer byte limits');
  }

  get state(): PeerState { return this.currentState; }

  /** Only this transport can issue a proof of its successfully applied SDP pair. */
  sessionBinding(): PeerSessionBinding | undefined { return this.#binding; }
  isCurrentSession(binding: unknown): binding is PeerSessionBinding {
    const owned = this.#binding;
    return !!owned && owned === binding && !!this.peer && owned.generation === this.generation &&
      this.currentState !== 'failed' && this.currentState !== 'disconnected';
  }

  async connect(): Promise<void> {
    if (this.peer) return;
    const createPeer: NonNullable<PeerTransportOptions['createPeer']> = this.options.createPeer ?? (configuration => new RTCPeerConnection(configuration));
    const peer = createPeer({ iceServers: this.options.iceServers ?? [] });
    const generation = ++this.generation;
    this.peer = peer;
    this.lifecycle = new AbortController();
    try {
      this.setState('connecting');
      if (!this.isCurrent(peer, generation)) return;
      peer.onconnectionstatechange = () => {
        if (!this.isCurrent(peer, generation)) return;
        const state = peer.connectionState;
        if (state === 'connected') this.setState('connected');
        else if (state === 'failed') this.setState('failed');
        else if (state === 'disconnected' || state === 'closed') this.setState('disconnected');
      };
      peer.ondatachannel = event => {
        if (!this.isCurrent(peer, generation)) { event.channel.close(); return; }
        const lane = event.channel.label === this.names.reliable ? 'reliable'
          : event.channel.label === this.names.disposable ? 'disposable' : undefined;
        if (!lane || this.channels[lane] || !this.matchesDelivery(lane, event.channel)) { event.channel.close(); return; }
        this.attach(lane, event.channel, peer, generation);
      };
      if (this.options.initiator) {
        this.attach('reliable', peer.createDataChannel(this.names.reliable, { ordered: true }), peer, generation);
        this.attach('disposable', peer.createDataChannel(this.names.disposable, { ordered: false, maxRetransmits: 0 }), peer, generation);
      }
    } catch (cause) {
      if (this.isCurrent(peer, generation)) {
        const disconnected = this.disconnect();
        const disposedGeneration = this.generation;
        await disconnected;
        if (!this.peer && this.generation === disposedGeneration) this.setState('failed');
      }
      throw cause;
    }
  }

  async disconnect(): Promise<void> {
    const peer = this.peer;
    this.peer = undefined;
    this.generation += 1;
    this.#binding = undefined; this.negotiatedOffer = undefined; this.negotiation = 'none';
    this.lifecycle?.abort(); this.lifecycle = undefined;
    if (peer) { peer.ondatachannel = null; peer.onconnectionstatechange = null; }
    for (const lane of ['reliable', 'disposable'] as const) {
      const channel = this.channels[lane]; delete this.channels[lane];
      if (channel) { channel.onmessage = null; channel.onclose = null; channel.onerror = null; channel.close(); }
    }
    peer?.close();
    this.setState('disconnected');
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const expectedGeneration = this.peer ? this.generation : this.generation + 1;
    await this.connect();
    const { peer, generation, signal } = this.transaction();
    if (generation !== expectedGeneration) throw new Error('Peer disconnected before negotiation (stale generation)');
    if (this.negotiation !== 'none') throw new Error('A negotiation already owns this peer generation');
    this.negotiation = 'offering';
    try {
      const offer = await peer.createOffer(); this.checkCurrent(peer, generation);
      await peer.setLocalDescription(offer); this.checkCurrent(peer, generation);
      await this.gather(peer, signal); this.checkCurrent(peer, generation);
      const complete = this.copyDescription(this.localDescription(peer), 'offer');
      this.negotiatedOffer = Object.freeze(complete); this.negotiation = 'offered';
      return { ...complete };
    } catch (cause) { await this.retireFailedNegotiation(peer, generation); throw cause; }
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const acceptedOffer = this.copyDescription(offer, 'offer');
    const expectedGeneration = this.peer ? this.generation : this.generation + 1;
    await this.connect();
    const { peer, generation, signal } = this.transaction();
    if (generation !== expectedGeneration) throw new Error('Peer disconnected before negotiation (stale generation)');
    if (this.negotiation !== 'none') throw new Error('A negotiation already owns this peer generation');
    this.negotiation = 'answering';
    try {
      await peer.setRemoteDescription({ ...acceptedOffer }); this.checkCurrent(peer, generation);
      const answer = await peer.createAnswer(); this.checkCurrent(peer, generation);
      await peer.setLocalDescription(answer); this.checkCurrent(peer, generation);
      await this.gather(peer, signal); this.checkCurrent(peer, generation);
      const complete = this.copyDescription(this.localDescription(peer), 'answer');
      this.#binding = Object.freeze({ generation, initiator: false,
        offer: Object.freeze(acceptedOffer), answer: Object.freeze(complete) });
      this.negotiation = 'complete';
      return { ...complete };
    } catch (cause) { await this.retireFailedNegotiation(peer, generation); throw cause; }
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const acceptedAnswer = this.copyDescription(answer, 'answer');
    const { peer, generation } = this.transaction();
    if (this.negotiation !== 'offered' || !this.negotiatedOffer) throw new Error('No pending completed offer negotiation');
    this.negotiation = 'answering';
    const offer = this.negotiatedOffer;
    try {
      await peer.setRemoteDescription({ ...acceptedAnswer }); this.checkCurrent(peer, generation);
      this.#binding = Object.freeze({ generation, initiator: true, offer, answer: Object.freeze(acceptedAnswer) });
      this.negotiation = 'complete';
    } catch (cause) { await this.retireFailedNegotiation(peer, generation); throw cause; }
  }

  /** Admission only. Finite defaults bound the native channel buffer, with no hidden app queue. */
  send(lane: PeerLane, data: PeerData): boolean {
    const channel = this.channels[lane];
    if (channel?.readyState !== 'open') return false;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (bytes > this.maxMessageBytes || channel.bufferedAmount + bytes > this.limits[lane]) return false;
    try {
      if (typeof data === 'string') channel.send(data);
      else if (data instanceof Uint8Array) channel.send(data as Uint8Array<ArrayBuffer>);
      else channel.send(data);
      return true;
    } catch { return false; }
  }

  bufferedAmount(lane: PeerLane): number { return this.channels[lane]?.bufferedAmount ?? 0; }
  isOpen(lane: PeerLane): boolean { return this.channels[lane]?.readyState === 'open'; }
  onData(listener: (lane: PeerLane, data: string | ArrayBuffer) => void): () => void {
    this.dataListeners.add(listener); return () => this.dataListeners.delete(listener);
  }
  onStateChange(listener: (state: PeerState) => void): () => void {
    this.stateListeners.add(listener);
    try { listener(this.currentState); } catch { /* A view cannot interrupt peer ownership. */ }
    return () => this.stateListeners.delete(listener);
  }
  async stats(): Promise<RTCStatsReport | undefined> { return this.peer?.getStats(); }

  private attach(lane: PeerLane, channel: PeerDataChannelPort, peer: PeerConnectionPort, generation: number): void {
    if (!this.matchesDelivery(lane, channel)) { channel.close(); throw new Error('Incompatible peer channel delivery'); }
    this.channels[lane] = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 16384;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!this.isCurrent(peer, generation) || this.channels[lane] !== channel) return;
      const data = event.data;
      if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) return;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
      if (bytes > this.maxMessageBytes) return;
      for (const listener of this.dataListeners) {
        if (!this.isCurrent(peer, generation)) break;
        try { listener(lane, data); } catch { /* One decoder cannot interrupt other scoped consumers. */ }
      }
    };
    channel.onclose = () => { if (this.isCurrent(peer, generation)) this.setState('disconnected'); };
    channel.onerror = () => { if (this.isCurrent(peer, generation)) this.setState('failed'); };
  }

  private transaction(): { peer: PeerConnectionPort; generation: number; signal: AbortSignal } {
    if (!this.peer || !this.lifecycle) throw new Error('Peer is disconnected; connect before exchanging descriptions');
    return { peer: this.peer, generation: this.generation, signal: this.lifecycle.signal };
  }
  private matchesDelivery(lane: PeerLane, channel: PeerDataChannelPort): boolean {
    return channel.maxPacketLifeTime === null && (lane === 'reliable'
      ? channel.ordered && channel.maxRetransmits === null
      : !channel.ordered && channel.maxRetransmits === 0);
  }
  private isCurrent(peer: PeerConnectionPort, generation: number): boolean { return this.peer === peer && this.generation === generation; }
  private checkCurrent(peer: PeerConnectionPort, generation: number): void {
    if (!this.isCurrent(peer, generation)) throw new Error('Peer disconnected during negotiation (stale generation)');
  }
  private copyDescription<T extends 'offer' | 'answer'>(description: RTCSessionDescriptionInit, type: T): { type: T; sdp: string } {
    const actualType = description.type, sdp = description.sdp;
    if (actualType !== type || typeof sdp !== 'string' || !sdp || sdp.length > 256000 || new TextEncoder().encode(sdp).length > 256000)
      throw new Error(`Expected a bounded WebRTC ${type} description`);
    return { type, sdp };
  }
  private async retireFailedNegotiation(peer: PeerConnectionPort, generation: number): Promise<void> {
    if (!this.isCurrent(peer, generation)) return;
    const closed = this.disconnect(), retiredGeneration = this.generation;
    await closed;
    if (!this.peer && this.generation === retiredGeneration) this.setState('failed');
  }
  private localDescription(peer: PeerConnectionPort): RTCSessionDescriptionInit {
    if (!peer.localDescription?.sdp) throw new Error('WebRTC did not produce pairing data');
    return { type: peer.localDescription.type, sdp: peer.localDescription.sdp };
  }
  private async gather(peer: PeerConnectionPort, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Peer disconnected during ICE gathering');
    if (peer.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('ICE gathering did not complete before timeout')); }, 5000);
      function cleanup() {
        clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', onChange);
        signal.removeEventListener('abort', onAbort);
      }
      function finish() { cleanup(); resolve(); }
      function onChange() { if (peer.iceGatheringState === 'complete') finish(); }
      function onAbort() { cleanup(); reject(new Error('Peer disconnected during ICE gathering')); }
      peer.addEventListener('icegatheringstatechange', onChange);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  private setState(state: PeerState): void {
    if (this.currentState === state) return;
    if (state === 'failed' || state === 'disconnected') this.#binding = undefined;
    this.currentState = state;
    for (const listener of this.stateListeners) {
      if (this.currentState !== state) break;
      try { listener(state); } catch { /* Diagnostics/views cannot interrupt lifecycle cleanup. */ }
    }
  }
}
