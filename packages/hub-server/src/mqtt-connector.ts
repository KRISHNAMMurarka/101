import { createProfileConnector } from '@101/connect';
import type { ConnectorCaptureHandle, ConnectorProfileRequest, ConnectorProfileSample, ConnectorWriteContext, DeliveryContext, Observation,
  ProfileConnector, ReviewedConnectorProfileBinding } from '@101/connect';
import { connect as mqttConnect } from 'mqtt';
import type { IClientOptions, ISubscriptionGrant, MqttClient } from 'mqtt';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export const MQTT_CONNECTOR_LIMITS = Object.freeze({ topics: 16, topicBytes: 256, payloadBytes: 8192,
  profileBytes: 16384, connectionApprovalMs: 30000, connectTimeoutMs: 5000, maxMessages: 256,
  maxPendingPublishes: 4, maxAttempts: 32, maxExpirySeconds: 30 });

export interface MqttTopicBinding { readonly topic: string; readonly resourceId: string; readonly direction: 'sample' | 'ack' | 'command';
  readonly qos: 0 | 1; readonly maxAgeMs: number; readonly expirySeconds: number }
export interface MqttConnectionTopic extends MqttTopicBinding { readonly deadlineMs: number }
export interface MqttConnectorProfile { readonly schemaVersion: 1; readonly id: string; readonly version: string;
  readonly decoder: ConnectorProfileRequest; readonly topics: readonly MqttTopicBinding[]; readonly maxPayloadBytes: number;
  readonly maxMessages: number; readonly maxPendingPublishes: number }
export interface MqttConnectionRequest { readonly action: 'connect'; readonly endpoint: string; readonly clientId: string;
  readonly profileId: string; readonly profileVersion: string; readonly decoder: ConnectorProfileRequest;
  readonly clockId: string; readonly sourceClockRelation: 'same-process-monotonic'; readonly topics: readonly MqttConnectionTopic[];
  readonly maxPayloadBytes: number; readonly maxMessages: number; readonly maxPendingPublishes: number }
export interface MqttConnectionApproval { readonly request: MqttConnectionRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface MqttConnectorOptions { readonly endpoint: string; readonly profile: unknown; readonly binding: ReviewedConnectorProfileBinding;
  readonly clockId: string; readonly sourceClockRelation: 'same-process-monotonic';
  readonly username?: string; readonly password?: string; readonly now?: () => number;
  readonly authorizeConnection: (request: MqttConnectionRequest) => MqttConnectionApproval | undefined;
  readonly onSample: (sample: ConnectorProfileSample) => void;
  readonly onUnavailable: (resourceId: string) => void }
export interface MqttConnector {
  connect(input: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
  apply(resourceId: string, observation: Observation, context: DeliveryContext): Promise<void>;
  release(resourceId: string, reason: string, context: Readonly<{ routeId: string }>): void;
  close(): Promise<void>;
  status(): Readonly<{ state: 'idle' | 'connecting' | 'connected' | 'closed'; connected: boolean; topics: number;
    messages: number; duplicateMessages: number; rejectedMessages: number; attempts: number; rawPending: number; reason: string }>;
}

function invalid(): never { throw new TypeError('Invalid MQTT connector input'); }
function data(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== required.length + optional.filter(key => Object.hasOwn(input, key)).length ||
    required.some(key => !Object.hasOwn(input, key)) || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor?.enumerable || !('value' in descriptor)) invalid(); result[key] = descriptor.value; }
  return result;
}
function text(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.length || input.length > max || input.trim() !== input ||
    [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return input;
}
function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) invalid(); return input;
}
function hash(input: unknown): string { const value = text(input, 64); if (!/^[0-9a-f]{64}$/.test(value)) invalid(); return value; }
function loopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === 'localhost.' || normalized === '::1' ||
    isIP(normalized) === 4 && normalized.startsWith('127.');
}
function endpoint(input: unknown): string {
  const value = text(input, 2048); let url: URL;
  try { url = new URL(value); } catch { invalid(); }
  if (url.username || url.password || url.hash || url.search || !['', '/'].includes(url.pathname) || !url.port ||
    !['mqtt:', 'mqtts:'].includes(url.protocol) || (url.protocol === 'mqtt:' && !loopback(url.hostname)) ||
    (url.protocol === 'mqtts:' && loopback(url.hostname))) invalid();
  return url.toString();
}
function mqttTopic(input: unknown): string {
  const value = text(input, MQTT_CONNECTOR_LIMITS.topicBytes);
  if (value.includes('+') || value.includes('#') || value.includes('\0') || new TextEncoder().encode(value).length > MQTT_CONNECTOR_LIMITS.topicBytes) invalid();
  return value;
}
export function parseMqttConnectorProfile(input: unknown): Readonly<MqttConnectorProfile> {
  const value = data(input, ['schemaVersion', 'id', 'version', 'decoder', 'topics', 'maxPayloadBytes', 'maxMessages', 'maxPendingPublishes']);
  if (value.schemaVersion !== 1) invalid();
  const id = text(value.id, 128), version = text(value.version, 64);
  if (!/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) invalid();
  const decoderData = data(value.decoder, ['id', 'version', 'codeSha256']);
  const decoder = Object.freeze({ id: text(decoderData.id, 128), version: text(decoderData.version, 64), codeSha256: hash(decoderData.codeSha256) });
  if (!/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(decoder.id) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(decoder.version)) invalid();
  if (!Array.isArray(value.topics) || Object.getPrototypeOf(value.topics) !== Array.prototype || value.topics.length < 2 ||
    value.topics.length > MQTT_CONNECTOR_LIMITS.topics || Reflect.ownKeys(value.topics).length !== value.topics.length + 1) invalid();
  const topics = value.topics.map((entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.topics, String(index)); if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    const row = data(descriptor.value, ['topic', 'resourceId', 'direction', 'qos', 'maxAgeMs', 'expirySeconds']);
    if (!['sample', 'ack', 'command'].includes(String(row.direction))) invalid();
    return Object.freeze({ topic: mqttTopic(row.topic), resourceId: text(row.resourceId, 128), direction: row.direction as MqttTopicBinding['direction'],
      qos: integer(row.qos, 0, 1) as 0 | 1, maxAgeMs: integer(row.maxAgeMs, 1, 30000),
      expirySeconds: integer(row.expirySeconds, 1, MQTT_CONNECTOR_LIMITS.maxExpirySeconds) });
  });
  const names = new Set<string>();
  for (const topic of topics) { if (names.has(topic.topic)) invalid(); names.add(topic.topic); }
  const directions = new Map<string, Set<string>>();
  for (const topic of topics) { let set = directions.get(topic.resourceId); if (!set) { set = new Set(); directions.set(topic.resourceId, set); } if (set.has(topic.direction)) invalid(); set.add(topic.direction); }
  const maxPayloadBytes = integer(value.maxPayloadBytes, 64, MQTT_CONNECTOR_LIMITS.payloadBytes);
  const maxMessages = integer(value.maxMessages, 1, MQTT_CONNECTOR_LIMITS.maxMessages);
  const maxPendingPublishes = integer(value.maxPendingPublishes, 1, MQTT_CONNECTOR_LIMITS.maxPendingPublishes);
  const serialized = JSON.stringify({ schemaVersion: 1, id, version, decoder, topics, maxPayloadBytes, maxMessages, maxPendingPublishes });
  if (new TextEncoder().encode(serialized).length > MQTT_CONNECTOR_LIMITS.profileBytes) invalid();
  return Object.freeze({ schemaVersion: 1, id, version, decoder, topics: Object.freeze(topics), maxPayloadBytes, maxMessages, maxPendingPublishes });
}

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
function isAborted(signal: AbortSignal): boolean { return Reflect.apply(abortedGetter, signal, []) as boolean; }
function genuineSignal(input: unknown): input is AbortSignal { try { isAborted(input as AbortSignal); return true; } catch { return false; } }
const encoder = new TextEncoder();
function parseLine(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 10 || bytes.subarray(0, bytes.length - 1).includes(10)) invalid();
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - 1)));
  return data(parsed, ['wireVersion', 'kind', 'resourceId', 'commandId', 'value']);
}
function payloadOutput(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength < 2 || bytes.byteLength > MQTT_CONNECTOR_LIMITS.payloadBytes || bytes.includes(10) || bytes.includes(13)) invalid();
  const out = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!out || typeof out !== 'object' || Array.isArray(out)) invalid();
  const kind = Object.getOwnPropertyDescriptor(out, 'kind')?.value;
  const resourceId = Object.getOwnPropertyDescriptor(out, 'resourceId')?.value;
  if (typeof resourceId !== 'string') invalid();
  return { kind, resourceId };
}
/** One explicitly approved, clean MQTT5 session for one reviewed exact-topic profile. */
export function createMqttConnector(options: MqttConnectorOptions): MqttConnector {
  const profile = parseMqttConnectorProfile(options.profile), target = endpoint(options.endpoint);
  if (typeof options.authorizeConnection !== 'function' || typeof options.onSample !== 'function' || typeof options.onUnavailable !== 'function') invalid();
  const binding = options.binding, username = options.username === undefined ? undefined : text(options.username, 128);
  const password = options.password === undefined ? undefined : text(options.password, 256);
  if (options.sourceClockRelation !== 'same-process-monotonic') invalid();
  const clockId = text(options.clockId, 128), authorizeConnection = options.authorizeConnection, onSample = options.onSample, onUnavailable = options.onUnavailable;
  if (binding.manifest.id !== profile.id || binding.manifest.version !== profile.version ||
    binding.manifest.decoder.id !== profile.decoder.id || binding.manifest.decoder.version !== profile.decoder.version ||
    binding.manifest.decoder.codeSha256 !== profile.decoder.codeSha256) invalid();
  const declared = new Map(binding.manifest.resources.map(resource => [resource.capability.id, resource]));
  for (const topic of profile.topics) {
    const resource = declared.get(topic.resourceId); if (!resource) invalid();
    if (topic.direction === 'command' && (resource.direction !== 'sink' || !resource.command)) invalid();
    if (topic.direction === 'ack' && (resource.direction !== 'sink' || !resource.command)) invalid();
    if (topic.direction === 'sample' && resource.direction !== 'source') invalid();
    if (topic.direction === 'sample' && topic.maxAgeMs > resource.capability.delivery.maxAgeMs) invalid();
  }
  if (!profile.topics.some(topic => topic.direction === 'command') || !profile.topics.some(topic => topic.direction === 'sample') ||
    !profile.topics.some(topic => topic.direction === 'ack')) invalid();
  const now = options.now ?? (() => performance.now()); if (typeof now !== 'function') invalid();
  const topicsByName = new Map(profile.topics.map(topic => [topic.topic, topic]));
  const approvedTopics = Object.freeze(profile.topics.map(topic => Object.freeze({ ...topic,
    deadlineMs: topic.direction === 'command'
      ? Math.min(topic.maxAgeMs, declared.get(topic.resourceId)!.command!.deadlineMs, binding.manifest.budgets.callbackTimeoutMs)
      : topic.maxAgeMs })));
  let state: 'idle' | 'connecting' | 'connected' | 'closed' = 'idle', closed = false, epoch = 0, client: MqttClient | undefined;
  let core: ProfileConnector | undefined, capture: ConnectorCaptureHandle | undefined, connected = false, reason = 'inactive';
  let teardown: Promise<void> | undefined, approvalDeadline = 0, ownerSignal: AbortSignal | undefined, grantSignal: AbortSignal | undefined;
  let messages = 0, receivedMessages = 0, duplicateMessages = 0, rejectedMessages = 0, attempts = 0, rawPending = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const commandIds = new Set<string>();
  const pendingRaw = new Set<(retired?: boolean) => void>();
  const seenPackets = new Map<string, string>();
  const handlers: { signal: AbortSignal; listener: () => void }[] = [];
  const nowValue = () => { const value = now(); if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('clock'); return value; };
  const live = (run: number) => {
    if (closed || !connected || state !== 'connected' || epoch !== run || !client) return false;
    try {
      const at = nowValue();
      if (closed || !connected || state !== 'connected' || epoch !== run || !client ||
        isAborted(ownerSignal!) || isAborted(grantSignal!) || at >= approvalDeadline) {
        failSession('expired-or-revoked'); return false;
      }
    } catch { failSession('clock'); return false; }
    return true;
  };
  function unwatch(): void { for (const item of handlers.splice(0)) Reflect.apply(removeEvent, item.signal, ['abort', item.listener]); if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = undefined; }
  function watch(signal: AbortSignal, listener: () => void): void { Reflect.apply(addEvent, signal, ['abort', listener, { once: true }]); handlers.push({ signal, listener }); if (isAborted(signal)) listener(); }
  function failSession(code: string): void {
    if (closed || state === 'closed') return;
    reason = code; connected = false; state = 'closed'; epoch++;
    if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = undefined;
    try { core?.stop(code); } catch { /* fixed failure state */ }
    void finishClient(true).catch(() => { /* close() observes the same teardown failure */ });
  }
  function finishClient(force: boolean): Promise<void> {
    if (teardown) return teardown;
    const active = client;
    teardown = Promise.resolve().then(async () => {
      try {
        if (active) {
          try { await active.endAsync(force); }
          catch {
            const stream = active.stream;
            if (!stream) throw new Error('transport-retirement-unconfirmed');
            await new Promise<void>((resolve, reject) => {
              if ((stream as { closed?: boolean }).closed === true) return resolve();
              stream.once('close', resolve);
              try { stream.destroy(); } catch (error) { reject(error); }
            });
          }
        }
        if (client === active) client = undefined;
        for (const settle of [...pendingRaw]) settle(true);
      } finally { unwatch(); }
    });
    return teardown;
  }
  function makeCore(run: number): ProfileConnector {
    return createProfileConnector({ binding, observedIdentity: { backendId: 'mqtt5', wireVersion: 1, clockId }, now,
      onSample(sample) { if (live(run)) onSample(sample); }, onUnavailable(id) { onUnavailable(id); },
      write(bytes, context) { return publishCommand(run, bytes, context); } });
  }
  async function publishCommand(run: number, bytes: Uint8Array, context: ConnectorWriteContext): Promise<void> {
    if (!context.isCurrent() || !live(run) || context.signal.aborted || !client || attempts >= MQTT_CONNECTOR_LIMITS.maxAttempts ||
      rawPending >= profile.maxPendingPublishes) throw new Error('publish-unavailable');
    const envelope = parseLine(bytes), resourceId = text(envelope.resourceId, 128), commandId = text(envelope.commandId, 16);
    if (envelope.wireVersion !== 1 || envelope.kind !== 'command' || !/^[1-9][0-9]{0,15}$/.test(commandId)) invalid();
    const binding = profile.topics.find(topic => topic.direction === 'command' && topic.resourceId === resourceId);
    if (!binding || commandIds.has(commandId)) throw new Error('command-rejected');
    const active = client;
    let timer: ReturnType<typeof setTimeout> | undefined, detach = () => {};
    await new Promise<void>((resolve, reject) => {
      let logicalSettled = false, rawSettled = false;
      const logical = (error?: Error) => {
        if (logicalSettled) return;
        logicalSettled = true; if (timer) clearTimeout(timer); detach();
        if (error) reject(error); else resolve();
      };
      const settleRaw = (retired = false) => {
        if (rawSettled) return;
        rawSettled = true; pendingRaw.delete(settleRaw); rawPending--;
        if (retired && !logicalSettled) logical(new Error('publish-retired'));
      };
      const cancel = () => logical(new Error('publish-cancelled'));
      try {
        if (!context.isCurrent() || !live(run) || active !== client || context.signal.aborted) return logical(new Error('publish-stale'));
        const resource = declared.get(resourceId);
        const issuedAt = nowValue();
        if (typeof context.deadline !== 'number' || !Number.isFinite(context.deadline) || context.deadline <= issuedAt) {
          return logical(new Error('publish-expired'));
        }
        const expiresAt = Math.min(context.deadline, issuedAt + binding.maxAgeMs,
          issuedAt + binding.expirySeconds * 1000, issuedAt + (resource?.command?.deadlineMs ?? binding.maxAgeMs));
        const message = encoder.encode(JSON.stringify({ commandId, value: envelope.value, expiresAt }));
        if (message.byteLength > profile.maxPayloadBytes) return logical(new Error('publish-size'));
        commandIds.add(commandId); attempts++; rawPending++; pendingRaw.add(settleRaw);
        context.signal.addEventListener('abort', cancel, { once: true }); detach = () => context.signal.removeEventListener('abort', cancel);
        timer = setTimeout(() => logical(new Error('publish-timeout')), Math.max(1, Math.min(5000, binding.expirySeconds * 1000)));
        if (!context.isCurrent() || !live(run) || active !== client || context.signal.aborted) {
          settleRaw(); commandIds.delete(commandId);
          return logical(new Error('publish-stale'));
        }
        active.publish(binding.topic, Buffer.from(message), { qos: binding.qos, retain: false, properties: { messageExpiryInterval: binding.expirySeconds } }, error => {
          settleRaw();
          if (error || !context.isCurrent() || !live(run) || active !== client || context.signal.aborted) return logical(new Error('publish-failed'));
          logical();
        });
      } catch {
        logical(new Error('publish-failed'));
      }
    });
  }
  function onMessage(run: number, topicName: string, payload: Buffer, packet: { qos: number; retain: boolean; dup?: boolean; messageId?: number; properties?: { messageExpiryInterval?: number } }): void {
    if (!live(run)) return;
    if (receivedMessages >= profile.maxMessages) { failSession('message-limit'); return; }
    receivedMessages++;
    const binding = topicsByName.get(topicName);
    try {
      if (!binding || binding.direction === 'command' || packet.retain !== false || packet.qos > binding.qos ||
        !Number.isInteger(packet.properties?.messageExpiryInterval) || packet.properties!.messageExpiryInterval! < 1 ||
        packet.properties!.messageExpiryInterval! > binding.expirySeconds || payload.byteLength > profile.maxPayloadBytes ||
        messages >= profile.maxMessages || !core || !capture) throw new Error('message-policy');
      const payloadBytes = new Uint8Array(payload);
      const decodedValue: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
      if (packet.qos === 1 && packet.dup === true) {
        if (!Number.isInteger(packet.messageId) || !packet.messageId) throw new Error('duplicate-without-id');
        const key = `${topicName}\0${packet.messageId}`;
        const fingerprint = Buffer.from(payloadBytes).toString('base64');
        const previous = seenPackets.get(key);
        if (previous !== undefined) {
          if (previous !== fingerprint) throw new Error('duplicate-packet-conflict');
          duplicateMessages++; return;
        }
      }
      const output = payloadOutput(payloadBytes);
      if (output.resourceId !== binding.resourceId || binding.direction === 'sample' && output.kind !== 'sample' || binding.direction === 'ack' && output.kind !== 'ack') throw new Error('topic-resource-mismatch');
      const timeFields = data(decodedValue, binding.direction === 'sample'
        ? ['kind', 'resourceId', 'value', 'sequence', 'sourceTime', 'quality', 'calibration']
        : ['kind', 'resourceId', 'commandId', 'sequence', 'sourceTime']);
      const sourceTime = data(timeFields.sourceTime, ['clockId', 'at']);
      const nowAt = nowValue();
      if (nowAt >= approvalDeadline || isAborted(ownerSignal!) || isAborted(grantSignal!)) { failSession('expired-or-revoked'); return; }
      if (sourceTime.clockId !== clockId || typeof sourceTime.at !== 'number' || !Number.isFinite(sourceTime.at) || sourceTime.at < 0 ||
        sourceTime.at > nowAt || nowAt - sourceTime.at > binding.maxAgeMs) throw new Error('message-stale');
      messages++;
      if (packet.qos === 1 && Number.isInteger(packet.messageId) && packet.messageId) {
        seenPackets.set(`${topicName}\0${packet.messageId}`, Buffer.from(payloadBytes).toString('base64'));
        while (seenPackets.size > 64) seenPackets.delete(seenPackets.keys().next().value!);
      }
      const frame = new Uint8Array(payloadBytes.byteLength + 1); frame.set(payloadBytes); frame[frame.length - 1] = 10;
      if (!core.push(capture, frame).ok) { rejectedMessages++; failSession('decode-rejected'); return; }
    } catch { rejectedMessages++; }
  }
  function status() { return Object.freeze({ state, connected, topics: profile.topics.length, messages, receivedMessages, duplicateMessages,
    rejectedMessages, attempts, rawPending, reason }); }
  async function connect(input: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
    if (closed || state !== 'idle') return Object.freeze({ ok: false, reason: closed ? 'closed' : 'busy' });
    state = 'connecting'; reason = 'connecting'; const run = ++epoch;
    let request: MqttConnectionRequest | undefined, approval: Record<string, unknown> | undefined;
    try {
      const requestInput = data(input, ['purpose', 'signal']);
      if (!genuineSignal(requestInput.signal) || isAborted(requestInput.signal)) throw new Error('request-invalid');
      text(requestInput.purpose, 128);
      const parsedEndpoint = new URL(target), clientId = `101-${randomUUID()}`;
      request = Object.freeze({ action: 'connect', endpoint: target, clientId, profileId: profile.id, profileVersion: profile.version,
        decoder: profile.decoder, clockId, sourceClockRelation: 'same-process-monotonic', topics: approvedTopics,
        maxPayloadBytes: profile.maxPayloadBytes, maxMessages: profile.maxMessages, maxPendingPublishes: profile.maxPendingPublishes });
      try { approval = data(authorizeConnection(request), ['request', 'signal', 'expiresAt']); } catch { approval = undefined; }
      const at = nowValue();
      if (state !== 'connecting' || epoch !== run || !genuineSignal(requestInput.signal) || isAborted(requestInput.signal) || !approval ||
        approval.request !== request || !genuineSignal(approval.signal) || isAborted(approval.signal) ||
        typeof approval.expiresAt !== 'number' || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= at ||
        approval.expiresAt > at + MQTT_CONNECTOR_LIMITS.connectionApprovalMs) throw new Error('approval-denied');
      approvalDeadline = approval.expiresAt; ownerSignal = requestInput.signal; grantSignal = approval.signal;
      watch(requestInput.signal, () => failSession('cancelled')); watch(approval.signal, () => failSession('revoked'));
      expiryTimer = setTimeout(() => failSession('expired'), Math.max(1, approval.expiresAt - at));
      if (state !== 'connecting' || epoch !== run || isAborted(requestInput.signal) || isAborted(approval.signal) || nowValue() >= approval.expiresAt) throw new Error('connection-stale');
      const mqttOptions: IClientOptions = { protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0, receiveMaximum: profile.maxPendingPublishes,
        maximumPacketSize: profile.maxPayloadBytes + 1024 }, reconnectPeriod: 0, resubscribe: false, queueQoSZero: false,
        reconnectOnConnackError: false, connectTimeout: MQTT_CONNECTOR_LIMITS.connectTimeoutMs, keepalive: 15, clientId };
      if (parsedEndpoint.protocol === 'mqtts:') mqttOptions.rejectUnauthorized = true;
      if (username !== undefined) mqttOptions.username = username;
      if (password !== undefined) mqttOptions.password = password;
      const active = mqttConnect(target, mqttOptions); client = active;
      const connectPromise = new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); active.off('connect', onConnect); active.off('error', onError); active.off('close', onClose); };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('connect-failed')); };
        const onClose = () => { cleanup(); reject(new Error('connect-closed')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('connect-timeout')); }, MQTT_CONNECTOR_LIMITS.connectTimeoutMs + 100);
        active.once('connect', onConnect); active.once('error', onError); active.once('close', onClose);
      });
      active.on('error', () => { if (state === 'connected') failSession('transport-error'); });
      active.on('close', () => { if (state === 'connected') failSession('transport-closed'); });
      active.on('message', (topicName, payload, packet) => onMessage(run, topicName, payload, packet));
      await connectPromise;
      if (state !== 'connecting' || epoch !== run || active !== client || isAborted(ownerSignal) || isAborted(grantSignal) || nowValue() >= approvalDeadline) throw new Error('connection-stale');
      const inbound = profile.topics.filter(topic => topic.direction !== 'command');
      const grants: ISubscriptionGrant[] = await active.subscribeAsync(Object.fromEntries(inbound.map(topic => [topic.topic, { qos: topic.qos }])));
      if (state !== 'connecting' || epoch !== run || active !== client || isAborted(ownerSignal) || isAborted(grantSignal) ||
        nowValue() >= approvalDeadline || grants.length !== inbound.length ||
        grants.some(grant => { const expected = inbound.find(topic => topic.topic === grant.topic); return !expected || grant.qos === 128 || grant.qos > expected.qos; })) throw new Error('subscribe-failed');
      core = makeCore(run); const started = core.start(); if (!started.ok) throw new Error('profile-start-failed'); capture = started.value;
      if (state !== 'connecting' || epoch !== run || active !== client || isAborted(ownerSignal) || isAborted(grantSignal) ||
        nowValue() >= approvalDeadline) throw new Error('connection-stale');
      connected = true; state = 'connected'; reason = 'connected';
      return Object.freeze({ ok: true });
    } catch {
      reason = closed ? 'closed' : reason === 'expired' || reason === 'revoked' || reason === 'cancelled' ? reason : 'connect-failed';
      state = 'closed'; epoch++;
      connected = false;
      try { core?.close(); } catch { /* fixed failure state */ }
      await finishClient(true);
      return Object.freeze({ ok: false, reason });
    }
  }
  return Object.freeze({ connect,
    apply(resourceId: string, observation: Observation, context: DeliveryContext) {
      if (!live(epoch) || !core) return Promise.resolve(); return core.apply(resourceId, observation, context);
    },
    release(resourceId: string, why: string, context: Readonly<{ routeId: string }>) { core?.release(resourceId, why, context); },
    async close() {
      if (closed) { await finishClient(true); return; }
      closed = true; connected = false; state = 'closed'; reason = 'closed'; epoch++;
      if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = undefined;
      try { core?.close(); } catch { /* fixed failure state */ }
      core = undefined; capture = undefined;
      await finishClient(true);
    }, status,
  });
}
