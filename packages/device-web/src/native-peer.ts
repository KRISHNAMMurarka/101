import type { PeerConnectionPort, PeerDataChannelPort } from '@101/transport-webrtc';

const MAX_PENDING_MESSAGES = 256;

type Callback<T> = { handle(event: T): void }['handle'];
export interface NativeDescription { readonly type: string | null; readonly sdp: string }
/** Minimal injected surface of react-native-webrtc 124; no native runtime import. */
export interface NativeChannelProducer {
  readonly id?: number | null; readonly label: string; readonly ordered: boolean;
  readonly maxPacketLifeTime?: number; readonly maxRetransmits?: number;
  readonly readyState: string; readonly bufferedAmount: number;
  binaryType: string; bufferedAmountLowThreshold: number;
  onmessage: Callback<{data: unknown}> | null;
  onclose: Callback<unknown> | null; onerror: Callback<unknown> | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}
export interface NativePeerProducer {
  readonly connectionState: string; readonly iceGatheringState: string;
  readonly localDescription: NativeDescription | null;
  onconnectionstatechange: Callback<unknown> | null;
  ondatachannel: Callback<{channel: NativeChannelProducer}> | null;
  createDataChannel(label: string, options: RTCDataChannelInit): NativeChannelProducer;
  createOffer(): Promise<NativeDescription>; createAnswer(): Promise<NativeDescription>;
  setLocalDescription(description: NativeDescription): Promise<void>;
  setRemoteDescription(description: NativeDescription): Promise<void>;
  onicegatheringstatechange: Callback<unknown> | null;
  getStats(): Promise<RTCStatsReport>;
  close(): void;
}
export interface NativePeerPortOptions {
  /** Android exposes -1; the iOS uint16 getter exposes its wrapped value 65535. */
  unsetDeliveryLimit?: -1 | 65535;
}
function deliveryLimit(value: number | undefined, unset: -1 | 65535, localOmitted: boolean): number | null {
  // An iOS finite 65535 and an unset limit share the getter representation. Only
  // our own omitted creation option disambiguates it; incoming metadata cannot.
  return value === -1 || value === unset && unset === 65535 && localOmitted ? null : typeof value === 'number' ? value : NaN;
}
function description(value: NativeDescription): {type: RTCSdpType; sdp: string} {
  const type = value.type;
  if ((type !== 'offer' && type !== 'answer' && type !== 'pranswer' && type !== 'rollback') || typeof value.sdp !== 'string')
    throw new Error('Invalid native session description');
  return {type, sdp:value.sdp};
}
class NativeChannelPort implements PeerDataChannelPort {
  private disposed = false;
  private submitted = 0;
  private credited = 0;
  private submittedMessages = 0;
  private creditedMessages = 0;
  private readonly pendingEnds = new Map<number, number>();
  private statsId?: string;
  private channelId?: number;
  readonly canCredit: boolean;
  onmessage: PeerDataChannelPort['onmessage'] = null;
  onclose: PeerDataChannelPort['onclose'] = null;
  onerror: PeerDataChannelPort['onerror'] = null;
  private readonly producer: NativeChannelProducer;
  private readonly onDisposed: () => void;
  private readonly unset: -1 | 65535;
  private readonly creation?: Pick<RTCDataChannelInit, 'maxPacketLifeTime' | 'maxRetransmits'>;
  constructor(producer: NativeChannelProducer, onDisposed: () => void, unset: -1 | 65535,
    creation?: Pick<RTCDataChannelInit, 'maxPacketLifeTime' | 'maxRetransmits'>) {
    this.producer = producer; this.onDisposed = onDisposed; this.unset = unset; this.creation = creation;
    this.canCredit = creation !== undefined;
    producer.onmessage = event => { if (!this.disposed) this.onmessage?.({data:event.data}); };
    producer.onerror = event => { if (!this.disposed) this.onerror?.(event); };
    producer.onclose = event => {
      if (this.disposed) return;
      const callback = this.onclose; this.dispose(); callback?.(event);
    };
  }
  get label() { return this.producer.label; }
  get ordered() { return this.producer.ordered; }
  get maxPacketLifeTime() { return deliveryLimit(this.producer.maxPacketLifeTime, this.unset, this.creation !== undefined && this.creation.maxPacketLifeTime === undefined); }
  get maxRetransmits() { return deliveryLimit(this.producer.maxRetransmits, this.unset, this.creation !== undefined && this.creation.maxRetransmits === undefined); }
  get readyState() { return this.disposed ? 'closed' : this.producer.readyState; }
  get bufferedAmount() {
    const native = this.producer.bufferedAmount;
    return Number.isSafeInteger(native) && native >= 0 ? Math.max(native, this.submitted - this.credited) : Infinity;
  }
  identity(): number | undefined {
    const id = this.producer.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || this.channelId !== undefined && id !== this.channelId) return undefined;
    return id;
  }
  credit(value: Record<string, unknown>): void {
    const id = this.identity();
    const bytes = value.bytesSent; const messages = value.messagesSent;
    if (!this.canCredit || this.disposed || id === undefined || value.dataChannelIdentifier !== id || value.label !== this.label ||
      value.type !== 'data-channel' || typeof value.id !== 'string' || !value.id || this.statsId !== undefined && value.id !== this.statsId ||
      typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < this.credited || bytes > this.submitted ||
      typeof messages !== 'number' || !Number.isSafeInteger(messages) || messages < this.creditedMessages || messages > this.submittedMessages ||
      bytes > this.credited && messages === this.creditedMessages) return;
    // Native send is FIFO per channel. A report must describe an actual submitted prefix;
    // empty messages advance the count without bytes, while nonempty messages cannot do so.
    const expectedBytes = messages === this.creditedMessages ? this.credited : this.pendingEnds.get(messages);
    if (bytes !== expectedBytes) return;
    this.channelId = id; this.statsId = value.id; this.credited = bytes; this.creditedMessages = messages;
    for (const count of this.pendingEnds.keys()) if (count <= messages) this.pendingEnds.delete(count);
  }
  get binaryType() { return this.producer.binaryType; }
  set binaryType(value: string) { if (!this.disposed) this.producer.binaryType = value; }
  get bufferedAmountLowThreshold() { return this.producer.bufferedAmountLowThreshold; }
  set bufferedAmountLowThreshold(value: number) { if (!this.disposed) this.producer.bufferedAmountLowThreshold = value; }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    if (this.disposed) throw new Error('Native channel is closed');
    if (this.submittedMessages - this.creditedMessages >= MAX_PENDING_MESSAGES) throw new Error('Native pending-message bound reached');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (!Number.isSafeInteger(this.submitted + bytes) || !Number.isSafeInteger(this.submittedMessages + 1)) throw new Error('Native byte accounting exhausted');
    // Reserve before crossing the asynchronous native bridge; even a throw may have posted data.
    this.submitted += bytes; this.submittedMessages++;
    this.pendingEnds.set(this.submittedMessages, this.submitted);
    this.producer.send(data);
  }
  private dispose() {
    this.disposed = true;
    this.onmessage = null; this.onclose = null; this.onerror = null;
    this.producer.onmessage = null; this.producer.onclose = null; this.producer.onerror = null;
    this.onDisposed();
  }
  close() { if (this.disposed) return; this.dispose(); this.producer.close(); }
}

/**
 * Exclusively owns the injected native peer/channels. Native sources initiate their channels:
 * Android incoming metadata cannot qualify disposable delivery. Call getStats from an owned
 * loop to retire measured SCTP handoffs; absent stats retains bytes and the 256-message bound.
 */
export function createNativePeerPort(
  producer: NativePeerProducer,
  makeDescription: (value: {type: RTCSdpType; sdp: string}) => NativeDescription,
  options: NativePeerPortOptions = {},
): PeerConnectionPort {
  const unset = options.unsetDeliveryLimit ?? -1;
  if (unset !== -1 && unset !== 65535) throw new Error('Invalid native delivery sentinel');
  let disposed = false;
  const channels = new Map<NativeChannelProducer, NativeChannelPort>();
  const identities = new Map<number, NativeChannelPort | null>();
  const statsOwners = new Map<string, NativeChannelPort>();
  const listeners = new Set<() => void>();
  const onIce = () => {
    for (const listener of listeners) {
      if (disposed) break;
      listener();
    }
  };
  const active = () => { if (disposed) throw new Error('Native peer is closed'); };
  const wrap = (channel: NativeChannelProducer, creation?: Pick<RTCDataChannelInit, 'maxPacketLifeTime' | 'maxRetransmits'>) => {
    let port = channels.get(channel);
    if (!port) {
      if (typeof channel.ordered !== 'boolean') { channel.close(); throw new Error('Incompatible native channel delivery'); }
      port = new NativeChannelPort(channel, () => {
        const id = port?.identity(); if (id !== undefined) identities.set(id,null);
        channels.delete(channel);
      }, unset, creation); channels.set(channel,port);
    }
    return port;
  };
  const convert = (value: RTCSessionDescriptionInit) => {
    if (typeof value.sdp !== 'string') throw new Error('Invalid native session description');
    return makeDescription(description({type:value.type, sdp:value.sdp}));
  };
  const port: PeerConnectionPort = {
    get connectionState() { return disposed ? 'closed' : producer.connectionState; },
    get iceGatheringState() { return producer.iceGatheringState; },
    get localDescription() { return producer.localDescription ? description(producer.localDescription) : null; },
    onconnectionstatechange:null, ondatachannel:null,
    createDataChannel(label, options) {
      active(); const creation = { maxPacketLifeTime: options.maxPacketLifeTime, maxRetransmits: options.maxRetransmits };
      return wrap(producer.createDataChannel(label,options), creation);
    },
    async createOffer() { active(); const value=await producer.createOffer(); active(); return description(value); },
    async createAnswer() { active(); const value=await producer.createAnswer(); active(); return description(value); },
    async setLocalDescription(value) { active(); await producer.setLocalDescription(convert(value)); active(); },
    async setRemoteDescription(value) { active(); await producer.setRemoteDescription(convert(value)); active(); },
    async getStats() {
      active(); const value=await producer.getStats(); active();
      const rows: Record<string, unknown>[] = [];
      value.forEach((row: unknown, key: string) => {
        if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
          const record = row as Record<string, unknown>;
          if (record.type === 'data-channel' && record.id === key) rows.push(record);
        }
      });
      // Register all identities before applying any credit: duplicate native ids fail closed.
      for (const channel of channels.values()) {
        if (!channel.canCredit) continue;
        const id = channel.identity(); if (id === undefined) continue;
        if (identities.has(id) && identities.get(id) !== channel) identities.set(id,null);
        else identities.set(id,channel);
      }
      for (const channel of channels.values()) {
        if (!channel.canCredit) continue;
        const id = channel.identity(); if (id === undefined || identities.get(id) !== channel) continue;
        const matching = rows.filter(row => row.dataChannelIdentifier === id && row.label === channel.label);
        if (matching.length !== 1) continue;
        const row = matching[0]!;
        if (typeof row.id !== 'string' || statsOwners.has(row.id) && statsOwners.get(row.id) !== channel) continue;
        // Never transfer a report identity to a different owned channel, including after close.
        statsOwners.set(row.id,channel); channel.credit(row);
      }
      return value;
    },
    addEventListener(_type, listener) {
      active(); listeners.add(listener); producer.onicegatheringstatechange = onIce;
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener); if (!listeners.size) producer.onicegatheringstatechange = null;
    },
    close() {
      if (disposed) return; disposed=true;
      port.onconnectionstatechange=null; port.ondatachannel=null;
      producer.onconnectionstatechange=null; producer.ondatachannel=null;
      producer.onicegatheringstatechange=null; listeners.clear();
      for (const channel of channels.values()) channel.close();
      channels.clear(); producer.close();
    },
  };
  producer.onconnectionstatechange=event=>{if (!disposed) port.onconnectionstatechange?.(event);};
  producer.ondatachannel=event=>{
    if (disposed) {event.channel.close(); return;}
    if (!port.ondatachannel) {event.channel.close(); return;}
    port.ondatachannel({channel:wrap(event.channel)});
  };
  return port;
}
