import { parseDeviceDescriptor, parseSignalValue, schemasCompatible, snapshotJson, RemoteClockMap } from '@101/device-model';
import type { DeviceCapability, DeviceDescriptor, SignalValue } from '@101/device-model';
import type { Connection, DeviceRuntime, EndpointHandle, RouteGrant } from '@101/device-runtime';
import { decodePacket, encodePacket } from './wire.ts';
import type { WireCodec, WireControl, WireValue } from './wire.ts';

type Lane = 'reliable' | 'disposable';
type PeerState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
type StopReason = Extract<WireControl, { type: 'stop' }>['reason'];
export interface ResourcePeer {
  readonly state: PeerState;
  isOpen(lane: Lane): boolean;
  send(lane: Lane, data: string | ArrayBuffer | Uint8Array): boolean;
  onData(listener: (lane: Lane, data: string | ArrayBuffer) => void): () => void;
  onStateChange(listener: (state: PeerState) => void): () => void;
}
interface CommonOptions {
  peer: ResourcePeer; epoch: string; clockId: string; now: () => number; onStatus?: (status: string) => void;
}
export interface RemoteReceiverOptions extends CommonOptions {
  runtime: DeviceRuntime; principalId: string; applicationId: string; sessionId: string;
}
export interface RemoteApproval {
  capability: string; sink: EndpointHandle; sinkDevice: unknown; sinkCapability: string;
  grant: RouteGrant; codec?: WireCodec; leaseMs?: number;
}
export interface RemotePublisherOptions extends CommonOptions {
  device: unknown; available: (capability: string) => boolean;
}
const CODECS: readonly WireCodec[] = Object.freeze(['json/1', 'normalized-pointer/1']);
const envelope = (epoch: string) => ({ protocol: 'connect' as const, version: 1 as const, epoch });
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value &&
    !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; });
}
function time(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function common(options: CommonOptions): void {
  if (typeof options.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(options.epoch) || !identifier(options.clockId) ||
    typeof options.now !== 'function' || !time(options.now())) throw new TypeError('Invalid enrolled peer clock or epoch');
}
function normalized(capability: DeviceCapability): boolean {
  const schema = capability.value;
  return capability.schemaVersion === 1 && capability.delivery.mode === 'latest' && schema.type === 'vector' &&
    schema.components.length === 2 && schema.components[0] === 'x' && schema.components[1] === 'y' &&
    schema.unit === '1' && schema.frame === 'surface-normalized' && schema.min === 0 && schema.max === 1;
}
function limit(capability: DeviceCapability): { maxAgeMs: number; maxHz: number } {
  return { maxAgeMs: capability.delivery.maxAgeMs, maxHz: capability.delivery.mode === 'latest' ? capability.delivery.maxHz : 1000 };
}
function grant(input: unknown, now: number): RouteGrant | undefined {
  try {
    const value = snapshotJson(input);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['expiresAt', 'maxHz', 'maxAgeMs'].includes(key))) return;
    if (!time(value.expiresAt) || value.expiresAt <= now || typeof value.maxAgeMs !== 'number' || value.maxAgeMs < 1 || value.maxAgeMs > 60000 ||
      (value.maxHz !== undefined && (typeof value.maxHz !== 'number' || value.maxHz < 1 || value.maxHz > 1000))) return;
    return value as unknown as RouteGrant;
  } catch { return; }
}
function notify(listener: CommonOptions['onStatus'], status: string): void { try { listener?.(status); } catch { /* Observer cannot acquire authority. */ } }
interface ReceiveSlot {
  slot: number; source: EndpointHandle; connection: Connection; capability: DeviceCapability;
  codec: WireCodec; maxHz: number; maxAgeMs: number; ready: boolean; lastSequence: number; lastOperation: number;
  lastReceivedAt: number; grantExpiresAt: number;
}

/** Incoming packets address approved private slots, never embedded registration handles. */
export class RemoteResourceReceiver {
  readonly #peer: ResourcePeer;
  private readonly runtime: DeviceRuntime;
  private readonly epoch: string;
  private readonly clockId: string;
  private readonly now: () => number;
  private readonly identity: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  private readonly onStatus?: CommonOptions['onStatus'];
  private readonly slots = new Map<number, ReceiveSlot>();
  private readonly detach: (() => void)[] = [];
  private described?: Extract<WireControl, { type: 'describe' }>;
  private clock?: RemoteClockMap;
  private clockReady = false;
  private pendingClock?: { id: number; sentAt: number };
  private clockIdSequence = 0;
  private lastProbe = -Infinity;
  private previousTime = -Infinity;
  private nextSlot = 0;
  private stopped = false;
  private reason = 'waiting';

  constructor(options: RemoteReceiverOptions) {
    common(options);
    if (![options.principalId, options.applicationId, options.sessionId].every(identifier) || options.runtime.clockDomain !== options.clockId)
      throw new TypeError('Invalid host scope or runtime clock');
    this.#peer = options.peer; this.runtime = options.runtime; this.epoch = options.epoch; this.clockId = options.clockId;
    this.now = options.now; this.onStatus = options.onStatus;
    this.identity = Object.freeze({ principalId: options.principalId, applicationId: options.applicationId, sessionId: options.sessionId });
    this.ownSubscription(this.#peer.onData((lane, data) => { this.receive(lane, data); }));
    if (!this.stopped) this.ownSubscription(this.#peer.onStateChange(state => { if (state === 'failed' || state === 'disconnected') this.stop('unavailable'); }));
    if (this.#peer.state === 'failed' || this.#peer.state === 'disconnected') this.stop('unavailable');
  }
  private ownSubscription(detach: () => void): void { if (this.stopped) detach(); else this.detach.push(detach); }
  private localTime(): number | undefined {
    try { const result = this.now(); if (!time(result) || result < this.previousTime) throw new RangeError(); this.previousTime = result; return result; }
    catch { this.stop('unavailable'); return; }
  }
  private report(reason: string): void { this.reason = reason; notify(this.onStatus, reason); }
  private control(packet: WireControl): boolean {
    if (this.stopped) return false;
    try { return this.#peer.send('reliable', encodePacket(packet)); } catch { return false; }
  }
  description(): Readonly<DeviceDescriptor> | undefined { return this.described?.device; }
  status(): Readonly<{ active: number; pending: number; stopped: boolean; reason: string; clockReady: boolean }> {
    return Object.freeze({ active: [...this.slots.values()].filter(slot => slot.ready).length,
      pending: [...this.slots.values()].filter(slot => !slot.ready).length, stopped: this.stopped, reason: this.reason, clockReady: this.clockReady });
  }
  approve(options: RemoteApproval): number | undefined {
    if (this.stopped || !this.described || this.nextSlot >= 128) return;
    const now = this.localTime(); if (now === undefined) return;
    const ownerGrant = grant(options.grant, now); if (!ownerGrant) return;
    const capability = this.described.device.capabilities.find(value => value.id === options.capability);
    let sink: DeviceCapability | undefined;
    try { sink = parseDeviceDescriptor(options.sinkDevice).capabilities.find(value => value.id === options.sinkCapability); } catch { return; }
    const codec = options.codec ?? 'json/1';
    if (!capability || !sink || !capability.permissions.some(value => value === 'subscribe' || value === 'read') ||
      !schemasCompatible(capability, sink) || capability.delivery.mode !== sink.delivery.mode ||
      !this.described.codecs.includes(codec) || (codec === 'normalized-pointer/1' && !normalized(capability))) return;
    const sourceLimits = limit(capability), sinkLimits = limit(sink);
    const maxHz = Math.min(sourceLimits.maxHz, sinkLimits.maxHz, ownerGrant.maxHz ?? 1000);
    const maxAgeMs = Math.min(sourceLimits.maxAgeMs, sinkLimits.maxAgeMs, ownerGrant.maxAgeMs);
    let source: EndpointHandle | undefined;
    try {
      source = this.runtime.registerSource({ device: this.described.device, capability: capability.id });
      const connection = this.runtime.route({ from: source, to: options.sink, ...this.identity, leaseMs: options.leaseMs, constraints: ownerGrant });
      const slot = ++this.nextSlot;
      const entry: ReceiveSlot = { slot, source, connection, capability, codec, maxHz, maxAgeMs, ready: false,
        lastSequence: 0, lastOperation: 0, lastReceivedAt: now, grantExpiresAt: ownerGrant.expiresAt };
      this.slots.set(slot, entry);
      if (!this.control({ ...envelope(this.epoch), type: 'bind', slot, capability: capability.id, descriptorRevision: this.described.device.revision,
        schemaVersion: capability.schemaVersion, codec, maxHz, maxAgeMs })) this.remove(slot, 'overload');
      return !this.stopped && this.slots.get(slot) === entry ? slot : undefined;
    } catch { if (source) this.runtime.unregister(source); this.report('incompatible'); return; }
  }
  private remove(slot: number, reason: StopReason, send = true): void {
    const entry = this.slots.get(slot); if (!entry) return;
    this.slots.delete(slot); entry.connection.stop(reason); this.runtime.unregister(entry.source);
    if (send) this.control({ ...envelope(this.epoch), type: 'stop', slot, reason });
    this.report(reason);
  }
  private loseClock(): void {
    this.clockReady = false; this.clock?.reset();
    for (const entry of [...this.slots.values()]) this.remove(entry.slot, 'unavailable');
    this.report('clock-unavailable');
  }
  private receive(lane: Lane, data: string | ArrayBuffer): void {
    if (this.stopped) return;
    const decoded = decodePacket(data, lane); if (!decoded || decoded.packet.epoch !== this.epoch) return;
    const packet = decoded.packet, now = this.localTime(); if (now === undefined || this.stopped) return;
    if (packet.type === 'describe') {
      if (this.described) {
        if (JSON.stringify(this.described) !== JSON.stringify(packet)) this.stop('incompatible');
        return;
      }
      try { this.clock = new RemoteClockMap({ localClockId: this.clockId, remoteClockId: packet.clockId }); }
      catch { this.stop('incompatible'); return; }
      this.described = packet; this.report('ready-to-select'); return;
    }
    if (!this.described) return;
    if (packet.type === 'clock') {
      const pending = this.pendingClock;
      if (!pending || packet.id !== pending.id || packet.sentAt !== pending.sentAt || packet.remoteReceivedAt === undefined || packet.remoteSentAt === undefined || now - pending.sentAt > 200) return;
      this.pendingClock = undefined;
      const observed = this.clock!.observe({ localSentAt: pending.sentAt, remoteReceivedAt: packet.remoteReceivedAt, remoteSentAt: packet.remoteSentAt, localReceivedAt: now });
      this.clockReady = observed && this.clock!.translate(packet.remoteSentAt, now) !== undefined;
      if (!this.clockReady) this.loseClock();
      return;
    }
    if (packet.type === 'bind') return;
    const entry = this.slots.get(packet.slot); if (!entry) return;
    if (packet.type === 'stop') { this.remove(packet.slot, packet.reason, false); return; }
    if (now >= entry.grantExpiresAt || now - entry.lastReceivedAt > entry.maxAgeMs) { this.remove(entry.slot, 'expired'); return; }
    if (packet.type === 'ready') {
      if (entry.ready || packet.maxHz !== entry.maxHz || packet.maxAgeMs !== entry.maxAgeMs) { this.remove(packet.slot, 'incompatible'); return; }
      this.runtime.setReadiness(entry.source, 'available');
      const started = entry.connection.start(), limits = entry.connection.limits();
      if (this.stopped || this.slots.get(entry.slot) !== entry) return;
      if (!started.ok || !limits || limits.maxHz !== entry.maxHz || limits.maxAgeMs !== entry.maxAgeMs || limits.expiresAt > entry.grantExpiresAt) {
        this.remove(entry.slot, 'incompatible'); return;
      }
      entry.ready = true; entry.lastReceivedAt = now; this.report('active'); return;
    }
    if (!entry.ready || entry.connection.status().state !== 'active' || decoded.codec !== entry.codec && packet.type === 'sample' ||
      packet.type !== (entry.capability.delivery.mode === 'latest' ? 'sample' : 'event') || packet.sequence <= entry.lastSequence) return;
    const translated = this.clock?.translate(packet.capturedAt, now);
    if (!translated) { this.loseClock(); return; }
    if (translated.earliest > now || now - translated.earliest > entry.maxAgeMs) return;
    let value: SignalValue;
    try { value = parseSignalValue(packet.value, entry.capability.value); } catch { return; }
    let deadline: number | undefined;
    if (packet.type === 'event') {
      if (Number(packet.operationId) <= entry.lastOperation || packet.deadline > packet.capturedAt + entry.maxAgeMs) return;
      const expiry = this.clock?.translate(packet.deadline, now);
      if (!expiry || expiry.earliest <= now) return;
      deadline = Math.min(expiry.earliest, translated.earliest + entry.maxAgeMs);
    }
    const result = this.runtime.publish(entry.source, value, { sequence: packet.sequence, timestamp: translated.earliest, clockDomain: this.clockId,
      provenance: { remoteClockId: this.described.clockId, localClockId: this.clockId, remoteCapturedAt: packet.capturedAt,
        receivedAt: now, captureLatest: Math.min(translated.latest, now), uncertaintyMs: translated.uncertaintyMs },
      ...(packet.type === 'event' ? { operationId: packet.operationId, deadline } : {}) });
    if (this.stopped || this.slots.get(entry.slot) !== entry) return;
    if (!result.ok || result.value.accepted === 0) { this.remove(entry.slot, 'overload'); return; }
    entry.lastSequence = packet.sequence; if (packet.type === 'event') entry.lastOperation = Number(packet.operationId);
    entry.lastReceivedAt = now;
  }
  tick(): void {
    if (this.stopped) return;
    const now = this.localTime(); if (now === undefined) return;
    for (const entry of [...this.slots.values()]) {
      if (now >= entry.grantExpiresAt || now - entry.lastReceivedAt > entry.maxAgeMs || entry.ready && !entry.connection.renew(this.identity.principalId).ok)
        this.remove(entry.slot, 'expired');
    }
    if (this.stopped) return;
    if (this.pendingClock && now - this.pendingClock.sentAt > 200) { this.pendingClock = undefined; this.loseClock(); }
    if (this.described && !this.pendingClock && now - this.lastProbe >= 1000) {
      if (this.clockIdSequence >= 0xffffffff) { this.stop('expired'); return; }
      const pending = { id: ++this.clockIdSequence, sentAt: now }; this.pendingClock = pending; this.lastProbe = now;
      if (!this.control({ ...envelope(this.epoch), type: 'clock', ...pending })) { this.pendingClock = undefined; this.loseClock(); }
    }
    if (!this.stopped) this.runtime.flush();
  }
  stop(reason: StopReason = 'stopped'): void {
    if (this.stopped) return;
    // Revoke callbacks and registrations before notifying potentially reentrant observers.
    this.stopped = true;
    for (const detach of this.detach.splice(0)) detach();
    for (const entry of [...this.slots.values()]) {
      this.slots.delete(entry.slot); entry.connection.stop(reason); this.runtime.unregister(entry.source);
      try { this.#peer.send('reliable', encodePacket({ ...envelope(this.epoch), type: 'stop', slot: entry.slot, reason })); } catch { /* Local release already happened. */ }
    }
    this.described = undefined; this.clock?.reset(); this.clock = undefined; this.clockReady = false; this.pendingClock = undefined; this.report(reason);
  }
}

interface PublishSlot {
  slot: number; capability: DeviceCapability; codec: WireCodec; maxHz: number; maxAgeMs: number;
  sequence: number; operation: number; lastSentAt: number; pending?: WireValue; queue: WireValue[];
}
/** Provider permission and descriptor policy gate every outgoing bound resource. */
export class RemoteResourcePublisher {
  readonly #peer: ResourcePeer;
  private readonly device: Readonly<DeviceDescriptor>;
  private readonly epoch: string;
  private readonly clockId: string;
  private readonly now: () => number;
  private readonly available: RemotePublisherOptions['available'];
  private readonly onStatus?: CommonOptions['onStatus'];
  private readonly slots = new Map<number, PublishSlot>();
  private readonly detach: (() => void)[] = [];
  private previousTime = -Infinity;
  private lastClockRequest = -Infinity;
  private slotWatermark = 0;
  private started = false;
  private stopped = false;
  private reason = 'idle';
  constructor(options: RemotePublisherOptions) {
    common(options); if (typeof options.available !== 'function') throw new TypeError('Provider readiness is required');
    this.device = parseDeviceDescriptor(options.device); this.#peer = options.peer; this.epoch = options.epoch; this.clockId = options.clockId;
    this.now = options.now; this.available = options.available; this.onStatus = options.onStatus;
    this.ownSubscription(this.#peer.onData((lane, data) => { this.receive(lane, data); }));
    if (!this.stopped) this.ownSubscription(this.#peer.onStateChange(state => { if (state === 'failed' || state === 'disconnected') this.stop('unavailable'); }));
    if (this.#peer.state === 'failed' || this.#peer.state === 'disconnected') this.stop('unavailable');
  }
  private ownSubscription(detach: () => void): void { if (this.stopped) detach(); else this.detach.push(detach); }
  private localTime(): number | undefined {
    try { const result = this.now(); if (!time(result) || result < this.previousTime) throw new RangeError(); this.previousTime = result; return result; }
    catch { this.stop('unavailable'); return; }
  }
  private ready(capability: string): boolean { try { return this.available(capability) === true && !this.stopped; } catch { return false; } }
  private report(reason: string): void { this.reason = reason; notify(this.onStatus, reason); }
  private control(packet: WireControl): boolean { if (this.stopped) return false; try { return this.#peer.send('reliable', encodePacket(packet)); } catch { return false; } }
  status(): Readonly<{ active: number; pending: number; stopped: boolean; reason: string }> {
    return Object.freeze({ active: this.slots.size, pending: [...this.slots.values()].reduce((total, slot) => total + (slot.pending ? 1 : 0) + slot.queue.length, 0), stopped: this.stopped, reason: this.reason });
  }
  start(): boolean {
    if (this.started || this.stopped) return false;
    this.started = true;
    if (!this.control({ ...envelope(this.epoch), type: 'describe', clockId: this.clockId, device: this.device, codecs: CODECS })) { this.stop('overload'); return false; }
    this.report('ready-to-select'); return !this.stopped;
  }
  private remove(slot: number, reason: StopReason, send = true): void {
    if (!this.slots.delete(slot)) return;
    if (send) this.control({ ...envelope(this.epoch), type: 'stop', slot, reason });
    this.report(reason);
  }
  private receive(lane: Lane, data: string | ArrayBuffer): void {
    if (!this.started || this.stopped) return;
    const decoded = decodePacket(data, lane); if (!decoded || decoded.packet.epoch !== this.epoch) return;
    const packet = decoded.packet, now = this.localTime(); if (now === undefined || this.stopped) return;
    if (packet.type === 'clock') {
      if (packet.remoteReceivedAt !== undefined || now - this.lastClockRequest < 50) return;
      this.lastClockRequest = now;
      const sentAt = this.localTime(); if (sentAt === undefined) return;
      if (!this.control({ ...packet, remoteReceivedAt: now, remoteSentAt: sentAt })) this.stop('overload');
      return;
    }
    if (packet.type === 'stop') { this.remove(packet.slot, packet.reason, false); return; }
    if (packet.type !== 'bind') return;
    const capability = this.device.capabilities.find(value => value.id === packet.capability);
    const actual = capability && limit(capability);
    if (packet.slot <= this.slotWatermark || this.slots.size >= 128 || !capability || !actual || this.device.revision !== packet.descriptorRevision ||
      capability.schemaVersion !== packet.schemaVersion || !capability.permissions.some(value => value === 'read' || value === 'subscribe') ||
      packet.maxAgeMs > actual.maxAgeMs || packet.maxHz > actual.maxHz || !CODECS.includes(packet.codec) ||
      packet.codec === 'normalized-pointer/1' && !normalized(capability) || !this.ready(capability.id)) {
      this.control({ ...envelope(this.epoch), type: 'stop', slot: packet.slot, reason: 'incompatible' }); return;
    }
    this.slotWatermark = packet.slot;
    const entry: PublishSlot = { slot: packet.slot, capability, codec: packet.codec, maxHz: packet.maxHz, maxAgeMs: packet.maxAgeMs,
      sequence: 0, operation: 0, lastSentAt: -Infinity, queue: [] };
    this.slots.set(entry.slot, entry);
    if (!this.control({ ...envelope(this.epoch), type: 'ready', slot: entry.slot, maxHz: entry.maxHz, maxAgeMs: entry.maxAgeMs })) this.remove(entry.slot, 'overload');
    if (!this.stopped && this.slots.get(entry.slot) === entry) this.report('active');
  }
  publish(capability: string, input: unknown, options: { capturedAt?: number; deadline?: number } = {}): boolean {
    if (this.stopped || !this.started) return false;
    const now = this.localTime(); if (now === undefined) return false;
    const entries = [...this.slots.values()].filter(slot => slot.capability.id === capability); if (!entries.length) return false;
    let value: SignalValue, capturedAt: number;
    try {
      const copied = snapshotJson(options);
      if (!copied || typeof copied !== 'object' || Array.isArray(copied) || Object.keys(copied).some(key => !['capturedAt', 'deadline'].includes(key))) return false;
      capturedAt = copied.capturedAt === undefined ? now : copied.capturedAt as number;
      if (!time(capturedAt) || capturedAt > now) return false;
      value = parseSignalValue(input, entries[0].capability.value);
      options = copied as { capturedAt?: number; deadline?: number };
    } catch { return false; }
    let admitted = true;
    for (const entry of entries) {
      if (this.stopped || this.slots.get(entry.slot) !== entry) { admitted = false; continue; }
      if (!this.ready(entry.capability.id)) { this.remove(entry.slot, 'unavailable'); admitted = false; continue; }
      if (now - capturedAt > entry.maxAgeMs || entry.sequence >= 0xffffffff || entry.operation >= Number.MAX_SAFE_INTEGER) { admitted = false; continue; }
      const base = { ...envelope(this.epoch), slot: entry.slot, sequence: entry.sequence + 1, capturedAt, value };
      let packet: WireValue;
      if (entry.capability.delivery.mode === 'latest') {
        if (options.deadline !== undefined) { admitted = false; continue; }
        packet = { ...base, type: 'sample' };
      } else {
        const deadline = options.deadline ?? capturedAt + entry.maxAgeMs;
        if (!time(deadline) || deadline <= now || deadline > capturedAt + entry.maxAgeMs) { admitted = false; continue; }
        packet = { ...base, type: 'event', operationId: String(entry.operation + 1), deadline };
      }
      entry.sequence++; if (packet.type === 'event') entry.operation++;
      if (packet.type === 'sample') {
        entry.pending = packet;
        if (!this.flushSlot(entry, now)) admitted = false;
      } else {
        if (entry.queue.length >= 64) { this.remove(entry.slot, 'overload'); admitted = false; continue; }
        entry.queue.push(packet);
        if (!this.flushSlot(entry, now)) admitted = false;
      }
    }
    return admitted;
  }
  private sendValue(entry: PublishSlot, packet: WireValue, now: number): boolean {
    try {
      const accepted = this.#peer.send(packet.type === 'sample' ? 'disposable' : 'reliable', encodePacket(packet, packet.type === 'event' ? 'json/1' : entry.codec));
      if (accepted && !this.stopped && this.slots.get(entry.slot) === entry) { entry.lastSentAt = now; return true; }
    } catch { /* Invalid/oversized producer output cannot be dispatched. */ }
    return false;
  }
  private flushSlot(entry: PublishSlot, now: number): boolean {
    if (entry.capability.delivery.mode === 'reliable') {
      const next = entry.queue[0]; if (!next) return true;
      if (next.type !== 'event' || next.deadline <= now) { this.remove(entry.slot, 'expired'); return false; }
      if (now - entry.lastSentAt < 1000 / entry.maxHz) return true;
      if (!this.sendValue(entry, next, now)) { this.remove(entry.slot, 'overload'); return false; }
      if (entry.queue[0] === next) entry.queue.shift();
      return true;
    }
    const pending = entry.pending; if (!pending) return true;
    if (now - pending.capturedAt > entry.maxAgeMs) { entry.pending = undefined; return false; }
    if (now - entry.lastSentAt < 1000 / entry.maxHz) return false;
    if (!this.sendValue(entry, pending, now)) return false;
    // A synchronous subscriber may publish a newer replacement while send runs.
    if (entry.pending === pending) entry.pending = undefined;
    return true;
  }
  tick(): void {
    if (this.stopped) return;
    const now = this.localTime(); if (now === undefined) return;
    for (const entry of [...this.slots.values()]) {
      if (!this.ready(entry.capability.id)) this.remove(entry.slot, 'unavailable');
      else this.flushSlot(entry, now);
    }
  }
  stop(reason: StopReason = 'stopped'): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const detach of this.detach.splice(0)) detach();
    const slots = [...this.slots.values()]; this.slots.clear();
    for (const entry of slots) try { this.#peer.send('reliable', encodePacket({ ...envelope(this.epoch), type: 'stop', slot: entry.slot, reason })); }
    catch { /* Receiver deadman still releases held state. */ }
    this.report(reason);
  }
}
