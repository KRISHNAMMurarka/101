import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RemoteClockMap } from '@101/device-model';
import type { RemoteClockTranslation } from '@101/device-model';

const MAX_FRAME_BYTES = 2048;
const LIMITS = Object.freeze({ maxRttMs: 200, maxUncertaintyMs: 25, maxDriftPpm: 100,
  mappingAgeMs: 5000, sourceAgeMs: 1000, commandLeadMs: 3000 });

export interface MqttClockTopics { readonly ping: string; readonly pong: string; readonly source: string;
  readonly ack: string; readonly command: string }
export interface MqttClockApprovalRequest { readonly action: 'mqtt-remote-clock'; readonly producerId: string;
  readonly localClockId: string; readonly producerClockId: string; readonly keyId: string;
  readonly clientId: string; readonly sessionNonce: string;
  readonly sourceResourceId: string; readonly commandResourceId: string;
  readonly topics: readonly Readonly<{ topic: string; direction: 'publish' | 'subscribe'; qos: 1 }>[];
  readonly limits: typeof LIMITS }
export interface MqttClockApproval { readonly request: MqttClockApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface MqttClockOptions { readonly producerId: string; readonly localClockId: string;
  readonly producerClockId: string; readonly keyId: string; readonly clientId: string; readonly sessionNonce: string;
  readonly key: Uint8Array; readonly topics: MqttClockTopics; readonly sourceResourceId: string; readonly commandResourceId: string;
  readonly now: () => number; readonly authorize: (request: MqttClockApprovalRequest) => MqttClockApproval | undefined }
export interface MqttClockPacket { readonly qos: number; readonly retain: boolean;
  readonly properties?: Readonly<{ messageExpiryInterval?: number }> }
export interface MqttClockPublish { readonly topic: string; readonly payload: Buffer; readonly qos: 1;
  readonly retain: false; readonly messageExpiryInterval: number }
export interface QualifiedMqttClockSource { readonly kind: 'sample' | 'ack'; readonly resourceId: string;
  readonly sequence: number; readonly value?: unknown; readonly commandId?: string; readonly producerId: string;
  readonly keyId: string; readonly sourceTime: Readonly<{ clockId: string; at: number }>;
  readonly translatedAt: RemoteClockTranslation; readonly receivedAt: number }
export interface MqttClockAuthority {
  readonly approvalRequest: MqttClockApprovalRequest;
  activate(ownerSignal: AbortSignal): boolean;
  beginPing(): MqttClockPublish | undefined;
  acceptPong(topic: string, payload: Uint8Array, packet: MqttClockPacket): boolean;
  qualifySource(topic: string, payload: Uint8Array, packet: MqttClockPacket): QualifiedMqttClockSource | undefined;
  prepareCommand(commandId: string, value: boolean, originalDeadlineLocal: number): MqttClockPublish | undefined;
  status(): Readonly<{ active: boolean; mapped: boolean; pendingPing: boolean }>;
  close(): void;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function name(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new TypeError('Invalid MQTT clock identity');
  return value;
}
function exactTopic(value: unknown): string {
  const topic = name(value, 256);
  if (topic.includes('+') || topic.includes('#') || new TextEncoder().encode(topic).length > 256) throw new TypeError('Invalid MQTT clock topic');
  return topic;
}
function keyCopy(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError('Invalid MQTT clock key');
  return Buffer.from(value);
}
function safeJson(body: Record<string, unknown>): string {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.hasOwn(body, 'mac')) throw new TypeError('Invalid signed MQTT frame');
  const json = JSON.stringify(body);
  if (!json || Buffer.byteLength(json) > MAX_FRAME_BYTES - 80) throw new TypeError('MQTT clock frame too large');
  return json;
}
/** Authentication proves possession of the enrolled key, never physical sensor authorship. */
export function signMqttClockFrame(body: Record<string, unknown>, key: Uint8Array): Buffer {
  const copy = keyCopy(key), json = safeJson(body);
  const mac = createHmac('sha256', copy).update(json).digest('hex');
  return Buffer.from(JSON.stringify({ ...body, mac }));
}
export function verifyMqttClockFrame(payload: Uint8Array, key: Uint8Array): Record<string, unknown> | undefined {
  try {
    if (!(payload instanceof Uint8Array) || payload.byteLength < 80 || payload.byteLength > MAX_FRAME_BYTES) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return undefined;
    const row = parsed as Record<string, unknown>, mac = row.mac;
    if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return undefined;
    const body = { ...row }; delete body.mac;
    const expected = createHmac('sha256', keyCopy(key)).update(safeJson(body)).digest();
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) return undefined;
    return body;
  } catch { return undefined; }
}
function hasFields(row: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(row);
  return keys.length === fields.length && fields.every(field => Object.hasOwn(row, field));
}
function packetAllowed(packet: MqttClockPacket): boolean {
  try {
    const qos = packet?.qos, retain = packet?.retain, expiry = packet?.properties?.messageExpiryInterval;
    return qos === 1 && retain === false && Number.isInteger(expiry) && expiry! >= 1 && expiry! <= 5;
  } catch { return false; }
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function isAborted(signal: AbortSignal): boolean { return Reflect.apply(abortedGetter, signal, []) as boolean; }
function genuineSignal(signal: unknown): signal is AbortSignal {
  try { return typeof isAborted(signal as AbortSignal) === 'boolean'; }
  catch { return false; }
}

/** Approved one-producer clock and source authority for an existing MQTT5 client. */
export function createMqttClockAuthority(options: MqttClockOptions): MqttClockAuthority {
  const producerId = name(options.producerId), localClockId = name(options.localClockId);
  const producerClockId = name(options.producerClockId), keyId = name(options.keyId);
  const clientId = name(options.clientId), sessionNonce = name(options.sessionNonce, 32);
  if (!/^[0-9a-f]{32}$/.test(sessionNonce)) throw new TypeError('Invalid MQTT clock session');
  const sourceResourceId = name(options.sourceResourceId), commandResourceId = name(options.commandResourceId);
  if (typeof options.now !== 'function' || typeof options.authorize !== 'function') throw new TypeError('Invalid MQTT clock options');
  const key = keyCopy(options.key), now = options.now, authorize = options.authorize;
  const topics = Object.freeze({ ping: exactTopic(options.topics.ping), pong: exactTopic(options.topics.pong),
    source: exactTopic(options.topics.source), ack: exactTopic(options.topics.ack), command: exactTopic(options.topics.command) });
  if (new Set(Object.values(topics)).size !== 5) throw new TypeError('Duplicate MQTT clock topic');
  const request = Object.freeze({ action: 'mqtt-remote-clock' as const, producerId, localClockId, producerClockId, keyId,
    clientId, sessionNonce,
    sourceResourceId, commandResourceId, topics: Object.freeze([
      Object.freeze({ topic: topics.ping, direction: 'publish' as const, qos: 1 as const }),
      Object.freeze({ topic: topics.pong, direction: 'subscribe' as const, qos: 1 as const }),
      Object.freeze({ topic: topics.source, direction: 'subscribe' as const, qos: 1 as const }),
      Object.freeze({ topic: topics.ack, direction: 'subscribe' as const, qos: 1 as const }),
      Object.freeze({ topic: topics.command, direction: 'publish' as const, qos: 1 as const }),
    ]), limits: LIMITS });
  const map = new RemoteClockMap({ localClockId, remoteClockId: producerClockId,
    maxRttMs: LIMITS.maxRttMs, maxUncertaintyMs: LIMITS.maxUncertaintyMs,
    maxDriftPpm: LIMITS.maxDriftPpm, maxAgeMs: LIMITS.mappingAgeMs });
  let active = false, finished = false, ownerSignal: AbortSignal | undefined, grantSignal: AbortSignal | undefined, approvalDeadline = 0;
  let pending: { nonce: string; sentAt: number; deadline: number } | undefined;
  let reference: { remoteSentAt: number; localReceivedAt: number } | undefined;
  const sequences = new Map<string, number>();
  const issued = new Map<string, string>(), usedCommandIds = new Set<string>();
  function localNow(): number { const value = now(); if (!timestamp(value)) throw new Error('Invalid MQTT clock'); return value; }
  function close(): void { active = false; finished = true; pending = undefined; reference = undefined; map.reset();
    sequences.clear(); issued.clear(); usedCommandIds.clear(); }
  function live(): number | undefined {
    if (!active || finished) return undefined;
    try {
      const at = localNow();
      if (!active || finished || !genuineSignal(ownerSignal) || !genuineSignal(grantSignal) ||
        isAborted(ownerSignal) || isAborted(grantSignal) || at >= approvalDeadline) {
        close(); return undefined;
      }
      return at;
    } catch { close(); return undefined; }
  }
  function identity(row: Record<string, unknown>): boolean {
    return row.schemaVersion === 1 && row.producerId === producerId && row.clockId === producerClockId && row.keyId === keyId &&
      row.clientId === clientId && row.sessionNonce === sessionNonce;
  }
  return Object.freeze({ approvalRequest: request,
    activate(signal: AbortSignal): boolean {
      if (finished || active || !genuineSignal(signal) || isAborted(signal)) return false;
      try {
        const approved = authorize(request), selectedRequest = approved?.request;
        const selectedSignal = approved?.signal, selectedDeadline = approved?.expiresAt, at = localNow();
        if (finished || active || selectedRequest !== request || !genuineSignal(selectedSignal) || isAborted(selectedSignal) ||
          !timestamp(selectedDeadline) || selectedDeadline <= at || selectedDeadline > at + 30000 || isAborted(signal)) return false;
        ownerSignal = signal; grantSignal = selectedSignal; approvalDeadline = selectedDeadline; active = true;
        return live() !== undefined;
      } catch { return false; }
    },
    beginPing(): MqttClockPublish | undefined {
      const at = live(); if (at === undefined) return undefined;
      if (pending && at < pending.deadline) return undefined;
      if (pending) { pending = undefined; reference = undefined; map.reset(); }
      const deadline = Math.min(at + LIMITS.maxRttMs, approvalDeadline);
      if (deadline <= at) return undefined;
      const nonce = randomBytes(16).toString('hex'); pending = { nonce, sentAt: at, deadline };
      const payload = signMqttClockFrame({ schemaVersion: 1, kind: 'clock-ping', producerId, clockId: producerClockId,
        keyId, clientId, sessionNonce, nonce, sentAt: at, expiresAt: deadline }, key);
      const checkedAt = live();
      if (checkedAt === undefined || checkedAt >= deadline) { pending = undefined; return undefined; }
      return Object.freeze({ topic: topics.ping, payload, qos: 1, retain: false, messageExpiryInterval: 1 });
    },
    acceptPong(topic: string, payload: Uint8Array, packet: MqttClockPacket): boolean {
      const at = live(), exchange = pending;
      if (at === undefined || !exchange || topic !== topics.pong || !packetAllowed(packet)) return false;
      if (at > exchange.deadline) { pending = undefined; reference = undefined; map.reset(); return false; }
      const row = verifyMqttClockFrame(payload, key);
      if (!row || !hasFields(row, ['schemaVersion', 'kind', 'producerId', 'clockId', 'keyId', 'clientId', 'sessionNonce', 'nonce', 'receivedAt', 'sentAt']) ||
        !identity(row) || row.kind !== 'clock-pong' || row.nonce !== exchange.nonce ||
        !timestamp(row.receivedAt) || !timestamp(row.sentAt)) return false;
      pending = undefined;
      if (!map.observe({ localSentAt: exchange.sentAt, remoteReceivedAt: row.receivedAt,
        remoteSentAt: row.sentAt, localReceivedAt: at })) { reference = undefined; return false; }
      const checkedAt = live();
      if (checkedAt === undefined || checkedAt > exchange.deadline) { reference = undefined; map.reset(); return false; }
      reference = { remoteSentAt: row.sentAt, localReceivedAt: at };
      return true;
    },
    qualifySource(topic: string, payload: Uint8Array, packet: MqttClockPacket): QualifiedMqttClockSource | undefined {
      const at = live();
      if (at === undefined || !packetAllowed(packet) || (topic !== topics.source && topic !== topics.ack)) return undefined;
      const row = verifyMqttClockFrame(payload, key);
      if (!row || !identity(row) || !timestamp(row.sourceAt) || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1 ||
        row.resourceId !== (topic === topics.source ? sourceResourceId : commandResourceId)) return undefined;
      const sample = topic === topics.source;
      if (sample ? row.kind !== 'sample' || !hasFields(row, ['schemaVersion', 'kind', 'producerId', 'clockId', 'keyId', 'clientId', 'sessionNonce', 'resourceId', 'sequence', 'sourceAt', 'value'])
        : row.kind !== 'ack' || !hasFields(row, ['schemaVersion', 'kind', 'producerId', 'clockId', 'keyId', 'clientId', 'sessionNonce', 'resourceId', 'commandId', 'commandNonce', 'sequence', 'sourceAt']) ||
          typeof row.commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(row.commandId) ||
          typeof row.commandNonce !== 'string' || issued.get(row.commandId) !== row.commandNonce) return undefined;
      const checkedAt = live();
      if (checkedAt === undefined) return undefined;
      const translatedAt = map.translate(row.sourceAt, checkedAt);
      if (!translatedAt || translatedAt.earliest < checkedAt - LIMITS.sourceAgeMs || translatedAt.latest > checkedAt) return undefined;
      const sequenceKey = `${row.kind}:${row.resourceId}`, last = sequences.get(sequenceKey) ?? 0;
      if ((row.sequence as number) <= last) return undefined;
      sequences.set(sequenceKey, row.sequence as number);
      if (!sample) issued.delete(row.commandId as string);
      return Object.freeze({ kind: row.kind as 'sample' | 'ack', resourceId: row.resourceId as string,
        sequence: row.sequence as number, ...(sample ? { value: row.value } : { commandId: row.commandId as string }), producerId, keyId,
        sourceTime: Object.freeze({ clockId: producerClockId, at: row.sourceAt }), translatedAt, receivedAt: checkedAt });
    },
    prepareCommand(commandId: string, value: boolean, originalDeadlineLocal: number): MqttClockPublish | undefined {
      const at = live(), anchor = reference;
      if (at === undefined || !anchor || typeof commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(commandId) ||
        usedCommandIds.has(commandId) || usedCommandIds.size >= 32 ||
        typeof value !== 'boolean' || !timestamp(originalDeadlineLocal) || originalDeadlineLocal <= at ||
        originalDeadlineLocal > at + LIMITS.commandLeadMs ||
        originalDeadlineLocal > anchor.localReceivedAt + LIMITS.mappingAgeMs) return undefined;
      const translated = map.translate(anchor.remoteSentAt, at);
      if (!translated) return undefined;
      const remaining = originalDeadlineLocal - translated.latest;
      if (remaining <= 0) return undefined;
      const expiresAtRemote = anchor.remoteSentAt + remaining * (1 - LIMITS.maxDriftPpm / 1000000);
      if (!timestamp(expiresAtRemote) || expiresAtRemote <= anchor.remoteSentAt) return undefined;
      const commandNonce = randomBytes(16).toString('hex');
      const payload = signMqttClockFrame({ schemaVersion: 1, kind: 'command', producerId, clockId: producerClockId, keyId,
        clientId, sessionNonce, resourceId: commandResourceId, commandId, commandNonce, value, originalDeadlineLocal, expiresAtRemote }, key);
      const checkedAt = live();
      if (checkedAt === undefined || checkedAt >= originalDeadlineLocal) return undefined;
      issued.set(commandId, commandNonce); usedCommandIds.add(commandId);
      return Object.freeze({ topic: topics.command, payload, qos: 1, retain: false,
        messageExpiryInterval: Math.max(1, Math.ceil((originalDeadlineLocal - checkedAt) / 1000)) });
    },
    status() { return Object.freeze({ active: live() !== undefined, mapped: reference !== undefined, pendingPing: pending !== undefined }); },
    close,
  });
}
