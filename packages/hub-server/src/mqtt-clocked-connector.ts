import { createProfileConnector } from '@101/connect';
import type { ConnectorCaptureHandle, ConnectorProfileSample, ConnectorWriteContext, DeliveryContext, Observation,
  ProfileConnector, ReviewedConnectorProfileBinding } from '@101/connect';
import { connect as mqttConnect } from 'mqtt';
import type { IClientOptions, ISubscriptionGrant, MqttClient } from 'mqtt';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createMqttClockAuthority } from './mqtt-clock.ts';
import type { MqttClockApproval, MqttClockApprovalRequest, MqttClockTopics, QualifiedMqttClockSource } from './mqtt-clock.ts';

const LIMITS = Object.freeze({ connectionApprovalMs: 30000, connectTimeoutMs: 5000, maxMessages: 128,
  maxPayloadBytes: 2048, maxPendingPublishes: 4, maxAttempts: 32 });
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
function aborted(signal: AbortSignal): boolean { return Reflect.apply(abortedGetter, signal, []) as boolean; }
function signal(input: unknown): input is AbortSignal { try { return typeof aborted(input as AbortSignal) === 'boolean'; } catch { return false; } }
function name(input: unknown, max = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > max || input.trim() !== input ||
    [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new TypeError('mqtt-clocked-input');
  return input;
}
function endpoint(input: unknown): string {
  const value = name(input, 2048), url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = hostname === 'localhost' || hostname === 'localhost.' || hostname === '::1' ||
    isIP(hostname) === 4 && hostname.startsWith('127.');
  if (url.username || url.password || url.hash || url.search || !['', '/'].includes(url.pathname) || !url.port ||
    !['mqtt:', 'mqtts:'].includes(url.protocol) || url.protocol === 'mqtt:' && !local || url.protocol === 'mqtts:' && local)
    throw new TypeError('mqtt-clocked-endpoint');
  return url.toString();
}
function immutablePacket(input: { qos: number; retain: boolean; properties?: { messageExpiryInterval?: number } }) {
  try { return Object.freeze({ qos: input.qos, retain: input.retain,
    properties: Object.freeze({ messageExpiryInterval: input.properties?.messageExpiryInterval }) }); }
  catch { return Object.freeze({ qos: -1, retain: true }); }
}
export interface ClockedMqttTopicAuthority { readonly topic: string; readonly direction: 'publish' | 'subscribe';
  readonly resourceId: string; readonly qos: 1; readonly deadlineMs: number; readonly expirySeconds: number }
export interface ClockedMqttConnectionRequest { readonly action: 'connect-clocked'; readonly endpoint: string; readonly clientId: string;
  readonly sessionNonce: string;
  readonly producerId: string; readonly producerClockId: string; readonly localClockId: string; readonly keyId: string;
  readonly profileId: string; readonly profileVersion: string;
  readonly decoder: Readonly<{ id: string; version: string; codeSha256: string }>;
  readonly topics: readonly ClockedMqttTopicAuthority[]; readonly maxPayloadBytes: number;
  readonly maxMessages: number; readonly maxPendingPublishes: number; readonly clean: true; readonly mqttVersion: 5 }
export interface ClockedMqttConnectionApproval { readonly request: ClockedMqttConnectionRequest;
  readonly signal: AbortSignal; readonly expiresAt: number }
export interface ClockedMqttProvenance { readonly sourceTime: QualifiedMqttClockSource['sourceTime'];
  readonly translatedAt: QualifiedMqttClockSource['translatedAt']; readonly receivedAt: number;
  readonly producerId: string; readonly keyId: string }
export interface ClockedMqttConnectorOptions { readonly endpoint: string; readonly binding: ReviewedConnectorProfileBinding;
  readonly producerId: string; readonly producerClockId: string; readonly localClockId: string; readonly keyId: string;
  readonly key: Uint8Array; readonly topics: MqttClockTopics; readonly username?: string; readonly password?: string;
  readonly now?: () => number;
  readonly authorizeConnection: (request: ClockedMqttConnectionRequest) => ClockedMqttConnectionApproval | undefined;
  readonly authorizeClock: (request: MqttClockApprovalRequest) => MqttClockApproval | undefined;
  readonly onSample: (sample: ConnectorProfileSample, provenance: ClockedMqttProvenance) => void;
  readonly onUnavailable: (resourceId: string) => void }
export interface ClockedMqttConnector {
  connect(input: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
  synchronize(): Promise<boolean>;
  apply(resourceId: string, observation: Observation, context: DeliveryContext): Promise<void>;
  release(resourceId: string, reason: string, context: Readonly<{ routeId: string }>): void;
  close(): Promise<void>;
  status(): Readonly<{ state: 'idle' | 'connecting' | 'connected' | 'closed'; connected: boolean; mapped: boolean;
    messages: number; rejectedMessages: number; attempts: number; rawPending: number; brokerAccepted: number; reason: string }>;
}

/** One explicit signed-boolean producer, one clean MQTT5 session, one reviewed decoder. */
export function createClockedMqttConnector(options: ClockedMqttConnectorOptions): ClockedMqttConnector {
  const target = endpoint(options.endpoint), producerId = name(options.producerId), producerClockId = name(options.producerClockId);
  const localClockId = name(options.localClockId), keyId = name(options.keyId);
  const binding = options.binding, manifest = binding?.manifest;
  if (!manifest || !Object.isFrozen(binding) || typeof options.authorizeConnection !== 'function' ||
    typeof options.authorizeClock !== 'function' || typeof options.onSample !== 'function' ||
    typeof options.onUnavailable !== 'function') throw new TypeError('mqtt-clocked-binding');
  const resource = new Map(manifest.resources.map(row => [row.capability.id, row]));
  const source = resource.get('enabled'), command = resource.get('set-enabled');
  if (!source || source.direction !== 'source' || source.capability.value.type !== 'boolean' ||
    !command || command.direction !== 'sink' || command.capability.value.type !== 'boolean' || !command.command ||
    !command.command.idempotent || command.command.observedState !== 'enabled' || command.command.safeState !== false ||
    !manifest.identityFilters.some(row => row.field === 'clockId' && row.equals === producerClockId) ||
    !manifest.identityFilters.some(row => row.field === 'backendId' && row.equals === 'mqtt5') ||
    !manifest.identityFilters.some(row => row.field === 'wireVersion' && row.equals === 1)) throw new TypeError('mqtt-clocked-profile');
  const topics = Object.freeze({ ping: name(options.topics.ping, 256), pong: name(options.topics.pong, 256),
    source: name(options.topics.source, 256), ack: name(options.topics.ack, 256), command: name(options.topics.command, 256) });
  if (new Set(Object.values(topics)).size !== 5 || Object.values(topics).some(topic => topic.includes('+') || topic.includes('#') || Buffer.byteLength(topic) > 256))
    throw new TypeError('mqtt-clocked-topics');
  const now = options.now ?? (() => performance.now());
  if (typeof now !== 'function') throw new TypeError('mqtt-clocked-clock');
  const authorizeConnection = options.authorizeConnection, authorizeClock = options.authorizeClock;
  const onSample = options.onSample, onUnavailable = options.onUnavailable;
  const username = options.username === undefined ? undefined : name(options.username, 128);
  const password = options.password === undefined ? undefined : name(options.password, 256);
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) throw new TypeError('mqtt-clocked-key');
  const key = Buffer.from(options.key);
  const clientId = `101-${randomUUID()}`, sessionNonce = randomBytes(16).toString('hex');
  let clockGrantSignal: AbortSignal | undefined, clockDeadline = 0;
  const clock = createMqttClockAuthority({ producerId, producerClockId, localClockId, keyId, clientId, sessionNonce, key, topics,
    sourceResourceId: 'enabled', commandResourceId: 'set-enabled', now, authorize(request) {
      const granted = authorizeClock(request);
      if (!granted) return undefined;
      const selected = Object.freeze({ request: granted.request, signal: granted.signal, expiresAt: granted.expiresAt });
      clockGrantSignal = selected.signal; clockDeadline = selected.expiresAt;
      return selected;
    } });
  const authorityTopics = Object.freeze([
    { topic: topics.ping, direction: 'publish' as const, resourceId: 'clock', qos: 1 as const, deadlineMs: 200, expirySeconds: 1 },
    { topic: topics.pong, direction: 'subscribe' as const, resourceId: 'clock', qos: 1 as const, deadlineMs: 200, expirySeconds: 1 },
    { topic: topics.source, direction: 'subscribe' as const, resourceId: 'enabled', qos: 1 as const, deadlineMs: 1000, expirySeconds: 1 },
    { topic: topics.ack, direction: 'subscribe' as const, resourceId: 'set-enabled', qos: 1 as const, deadlineMs: 1000, expirySeconds: 1 },
    { topic: topics.command, direction: 'publish' as const, resourceId: 'set-enabled', qos: 1 as const,
      deadlineMs: Math.min(3000, command.command.deadlineMs, manifest.budgets.callbackTimeoutMs), expirySeconds: 3 },
  ].map(row => Object.freeze(row)));
  let state: 'idle' | 'connecting' | 'connected' | 'closed' = 'idle', connected = false, closed = false, epoch = 0;
  let reason = 'inactive', client: MqttClient | undefined, core: ProfileConnector | undefined, capture: ConnectorCaptureHandle | undefined;
  let teardown: Promise<void> | undefined, ownerSignal: AbortSignal | undefined, grantSignal: AbortSignal | undefined;
  let approvalDeadline = 0, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let messages = 0, rejectedMessages = 0, attempts = 0, rawPending = 0, brokerAccepted = 0;
  let pingRawInFlight = false, synchronizing: Promise<boolean> | undefined;
  let qualifiedDuringPush: QualifiedMqttClockSource | undefined;
  const commandIds = new Set<string>(), rawSettlers = new Set<(retired?: boolean) => void>();
  const handlers: { signal: AbortSignal; listener: () => void }[] = [];
  function time(): number { const at = now(); if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER) throw new Error('clock'); return at; }
  function current(run: number, requireConnected = true): boolean {
    if (closed || epoch !== run || state === 'closed' || requireConnected && !connected || !client) return false;
    try {
      const at = time();
      if (closed || epoch !== run || (state as string) === 'closed' || requireConnected && !connected || !client ||
        !signal(ownerSignal) || !signal(grantSignal) || aborted(ownerSignal) || aborted(grantSignal) || at >= approvalDeadline ||
        !clock.status().active) { fail('expired-or-revoked'); return false; }
      return !closed && epoch === run && (state as string) !== 'closed' && (!requireConnected || connected) && !!client;
    } catch { fail('clock'); return false; }
  }
  function unwatch(): void {
    for (const row of handlers.splice(0)) Reflect.apply(removeEvent, row.signal, ['abort', row.listener]);
    if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = undefined;
  }
  function watch(s: AbortSignal, listener: () => void): void {
    Reflect.apply(addEvent, s, ['abort', listener, { once: true }]); handlers.push({ signal: s, listener });
    if (aborted(s)) listener();
  }
  function fail(code: string): void {
    if (state === 'closed') return;
    reason = code; state = 'closed'; connected = false; epoch++; clock.close();
    try { core?.stop(code); } catch { /* fixed failure */ }
    void finishClient(true).catch(() => { /* close reports teardown */ });
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
        for (const settle of [...rawSettlers]) settle(true);
      } finally { unwatch(); }
    });
    return teardown;
  }
  function publishPing(run: number, active: MqttClient): Promise<void> {
    if (!current(run, false) || active !== client || pingRawInFlight ||
      attempts >= LIMITS.maxAttempts || rawPending >= LIMITS.maxPendingPublishes) return Promise.reject(new Error('ping-unavailable'));
    const ping = clock.beginPing();
    if (!ping || !current(run, false) || active !== client) return Promise.reject(new Error('ping-unavailable'));
    return new Promise<void>((resolve, reject) => {
      let logicalSettled = false, rawSettled = false, issued = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const logical = (error?: Error) => {
        if (logicalSettled) return;
        logicalSettled = true; if (timer) clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const settleRaw = (retired = false) => {
        if (rawSettled) return;
        rawSettled = true; pingRawInFlight = false; rawPending--; rawSettlers.delete(settleRaw);
        if (retired && !logicalSettled) logical(new Error('ping-retired'));
      };
      try {
        if (!current(run, false) || active !== client) return logical(new Error('ping-stale'));
        attempts++; rawPending++; pingRawInFlight = true; rawSettlers.add(settleRaw);
        timer = setTimeout(() => logical(new Error('ping-timeout')), 220);
        if (!current(run, false) || active !== client) { settleRaw(); return logical(new Error('ping-stale')); }
        issued = true;
        active.publish(ping.topic, ping.payload, { qos: 1, retain: false,
          properties: { messageExpiryInterval: ping.messageExpiryInterval } }, error => {
          settleRaw();
          if (error || !current(run, false) || active !== client) return logical(new Error('ping-failed'));
          logical();
        });
      } catch {
        if (!issued && !rawSettled && rawSettlers.has(settleRaw)) settleRaw();
        logical(new Error('ping-failed'));
      }
    });
  }
  async function publish(run: number, bytes: Uint8Array, context: ConnectorWriteContext): Promise<void> {
    if (!context.isCurrent() || !current(run) || aborted(context.signal) || !clock.status().mapped ||
      attempts >= LIMITS.maxAttempts || rawPending >= LIMITS.maxPendingPublishes) throw new Error('publish-unavailable');
    const row: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('command-frame');
    const item = row as Record<string, unknown>;
    if (bytes[bytes.length - 1] !== 10 || Object.keys(item).length !== 5 || item.wireVersion !== 1 || item.kind !== 'command' ||
      item.resourceId !== 'set-enabled' || typeof item.commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(item.commandId) ||
      typeof item.value !== 'boolean' || commandIds.has(item.commandId)) throw new Error('command-frame');
    const active = client!, commandId = item.commandId as string;
    await new Promise<void>((resolve, reject) => {
      let logicalSettled = false, rawSettled = false, issued = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => logical(new Error('publish-cancelled'));
      const detach = () => Reflect.apply(removeEvent, context.signal, ['abort', cancel]);
      const logical = (error?: Error) => {
        if (logicalSettled) return;
        logicalSettled = true; if (timer) clearTimeout(timer); detach();
        if (error) reject(error); else resolve();
      };
      const settleRaw = (retired = false) => {
        if (rawSettled) return;
        rawSettled = true; rawSettlers.delete(settleRaw); rawPending--;
        if (retired && !logicalSettled) logical(new Error('publish-retired'));
      };
      try {
        const at = time();
        if (!context.isCurrent() || !current(run) || active !== client || aborted(context.signal) ||
          !Number.isFinite(context.deadline) || context.deadline <= at) return logical(new Error('publish-stale'));
        const frame = clock.prepareCommand(commandId, item.value as boolean, context.deadline);
        if (!frame || frame.payload.byteLength > LIMITS.maxPayloadBytes || !context.isCurrent() || !current(run) ||
          active !== client || aborted(context.signal)) return logical(new Error('publish-stale'));
        commandIds.add(commandId); attempts++; rawPending++; rawSettlers.add(settleRaw);
        Reflect.apply(addEvent, context.signal, ['abort', cancel, { once: true }]);
        timer = setTimeout(() => logical(new Error('publish-timeout')), Math.min(5000, Math.max(1, context.deadline - at)));
        if (!context.isCurrent() || !current(run) || active !== client || aborted(context.signal)) {
          settleRaw(); commandIds.delete(commandId); return logical(new Error('publish-stale'));
        }
        issued = true;
        active.publish(frame.topic, frame.payload, { qos: 1, retain: false,
          properties: { messageExpiryInterval: frame.messageExpiryInterval } }, error => {
          settleRaw(); if (!error) brokerAccepted++;
          if (error || !context.isCurrent() || !current(run) || active !== client || aborted(context.signal))
            return logical(new Error('publish-failed'));
          logical();
        });
      } catch { if (!issued) { if (!rawSettled && rawSettlers.has(settleRaw)) { settleRaw(); commandIds.delete(commandId); } }
        logical(new Error('publish-failed')); }
    });
  }
  function onMessage(run: number, topic: string, payload: Buffer, mqttPacket: { qos: number; retain: boolean; properties?: { messageExpiryInterval?: number } }): void {
    if (!current(run, false)) return;
    if (++messages > LIMITS.maxMessages) return fail('message-limit');
    if (payload.byteLength > LIMITS.maxPayloadBytes) { rejectedMessages++; return; }
    const packet = immutablePacket(mqttPacket);
    if (topic === topics.pong) { if (!clock.acceptPong(topic, payload, packet)) rejectedMessages++; return; }
    if (!connected || !core || !capture) { rejectedMessages++; return; }
    const qualified = clock.qualifySource(topic, payload, packet);
    if (!qualified || !current(run)) { rejectedMessages++; return; }
    const frame = qualified.kind === 'sample'
      ? { kind: 'sample', resourceId: qualified.resourceId, value: qualified.value, sequence: qualified.sequence,
        sourceTime: qualified.sourceTime, quality: 'valid', calibration: null }
      : { kind: 'ack', resourceId: qualified.resourceId, commandId: qualified.commandId, sequence: qualified.sequence,
        sourceTime: qualified.sourceTime };
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (bytes.byteLength > LIMITS.maxPayloadBytes) { rejectedMessages++; return; }
    qualifiedDuringPush = qualified;
    try { if (!core.push(capture, bytes).ok) rejectedMessages++; }
    catch { rejectedMessages++; }
    finally { qualifiedDuringPush = undefined; }
  }
  function status() { return Object.freeze({ state, connected, mapped: clock.status().mapped, messages, rejectedMessages,
    attempts, rawPending, brokerAccepted, reason }); }
  function makeCore(run: number): ProfileConnector {
    return createProfileConnector({ binding, observedIdentity: { backendId: 'mqtt5', wireVersion: 1, clockId: producerClockId }, now,
      onSample(sample) {
        const row = qualifiedDuringPush;
        if (!row || !current(run) || row.kind !== 'sample' || row.resourceId !== sample.resourceId || row.sequence !== sample.sequence) return;
        const provenance = Object.freeze({ sourceTime: row.sourceTime, translatedAt: row.translatedAt,
          receivedAt: row.receivedAt, producerId: row.producerId, keyId: row.keyId });
        onSample(sample, provenance);
      }, onUnavailable, write: (bytes, context) => publish(run, bytes, context) });
  }
  async function connect(input: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
    if (state !== 'idle' || closed) return Object.freeze({ ok: false, reason: closed ? 'closed' : 'busy' });
    state = 'connecting'; reason = 'connecting'; const run = ++epoch;
    try {
      if (!input || !signal(input.signal) || aborted(input.signal)) throw new Error('request-invalid');
      name(input.purpose);
      const request = Object.freeze({ action: 'connect-clocked' as const, endpoint: target, clientId, sessionNonce,
        producerId, producerClockId,
        localClockId, keyId, profileId: manifest.id, profileVersion: manifest.version,
        decoder: Object.freeze({ id: manifest.decoder.id, version: manifest.decoder.version, codeSha256: manifest.decoder.codeSha256 }),
        topics: authorityTopics, maxPayloadBytes: LIMITS.maxPayloadBytes, maxMessages: LIMITS.maxMessages,
        maxPendingPublishes: LIMITS.maxPendingPublishes, clean: true as const, mqttVersion: 5 as const });
      const authorized = authorizeConnection(request);
      const selectedRequest = authorized?.request, selectedSignal = authorized?.signal, selectedDeadline = authorized?.expiresAt;
      const at = time();
      if (state !== 'connecting' || epoch !== run || selectedRequest !== request || !signal(selectedSignal) || aborted(selectedSignal) ||
        aborted(input.signal) || !Number.isFinite(selectedDeadline) || selectedDeadline! <= at ||
        selectedDeadline! > at + LIMITS.connectionApprovalMs) throw new Error('approval-denied');
      ownerSignal = input.signal; grantSignal = selectedSignal; approvalDeadline = selectedDeadline!;
      if (!clock.activate(input.signal) || !signal(clockGrantSignal) || !Number.isFinite(clockDeadline))
        throw new Error('clock-approval-denied');
      watch(input.signal, () => fail('cancelled')); watch(selectedSignal, () => fail('revoked'));
      watch(clockGrantSignal, () => fail('clock-revoked'));
      expiryTimer = setTimeout(() => fail('expired'), Math.max(1, Math.min(approvalDeadline, clockDeadline) - at));
      if (state !== 'connecting' || epoch !== run || aborted(input.signal) || aborted(selectedSignal) || time() >= approvalDeadline ||
        !clock.status().active) throw new Error('connection-stale');
      core = makeCore(run);
      if (state !== 'connecting' || epoch !== run || aborted(input.signal) || aborted(selectedSignal) || time() >= approvalDeadline ||
        !clock.status().active) throw new Error('connection-stale');
      const mqttOptions: IClientOptions = { protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0,
        receiveMaximum: LIMITS.maxPendingPublishes, maximumPacketSize: LIMITS.maxPayloadBytes + 1024 },
        reconnectPeriod: 0, resubscribe: false, queueQoSZero: false, reconnectOnConnackError: false,
        connectTimeout: LIMITS.connectTimeoutMs, keepalive: 15, clientId };
      if (new URL(target).protocol === 'mqtts:') mqttOptions.rejectUnauthorized = true;
      if (username !== undefined) mqttOptions.username = username;
      if (password !== undefined) mqttOptions.password = password;
      const active = mqttConnect(target, mqttOptions); client = active;
      const connectedPromise = new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); active.off('connect', onConnect); active.off('error', onError); active.off('close', onClose); };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('connect-failed')); };
        const onClose = () => { cleanup(); reject(new Error('connect-closed')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('connect-timeout')); }, LIMITS.connectTimeoutMs + 100);
        active.once('connect', onConnect); active.once('error', onError); active.once('close', onClose);
      });
      active.on('error', () => { if (state === 'connecting' || state === 'connected') fail('transport-error'); });
      active.on('close', () => { if (state === 'connecting' || state === 'connected') fail('transport-closed'); });
      active.on('message', (topic, payload, packet) => onMessage(run, topic, payload, packet));
      await connectedPromise;
      if (!current(run, false) || active !== client) throw new Error('connection-stale');
      const inbound = [topics.pong, topics.source, topics.ack];
      const grants: ISubscriptionGrant[] = await active.subscribeAsync(Object.fromEntries(inbound.map(topic => [topic, { qos: 1 }])));
      if (!current(run, false) || active !== client || grants.length !== inbound.length ||
        grants.some(row => !inbound.includes(row.topic) || row.qos !== 1)) throw new Error('subscribe-failed');
      const started = core.start(); if (!started.ok) throw new Error('profile-start-failed'); capture = started.value;
      if (!current(run, false)) throw new Error('connection-stale');
      await publishPing(run, active);
      const mapped = await new Promise<boolean>(resolve => {
        const deadline = time() + 220;
        const poll = () => {
          if (!current(run, false) || active !== client || time() > deadline) return resolve(false);
          if (clock.status().mapped) return resolve(true);
          setTimeout(poll, 5);
        }; poll();
      });
      if (!mapped || !current(run, false)) throw new Error('clock-unmapped');
      state = 'connected'; connected = true; reason = 'connected';
      return Object.freeze({ ok: true });
    } catch {
      reason = reason === 'revoked' || reason === 'cancelled' || reason === 'expired' ? reason : 'connect-failed';
      state = 'closed'; connected = false; epoch++; clock.close();
      try { core?.close(); } catch { /* fixed failure */ }
      await finishClient(true);
      return Object.freeze({ ok: false, reason });
    }
  }
  async function synchronize(): Promise<boolean> {
    if (synchronizing) return synchronizing;
    const run = epoch, active = client;
    if (!current(run) || !active || pingRawInFlight) return false;
    const work = (async () => {
      try {
        await publishPing(run, active);
        const deadline = time() + 220;
        while (time() < deadline && current(run)) {
          if (clock.status().mapped && !clock.status().pendingPing) return true;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      } catch { /* a timed-out raw publish retains its reservation until callback or close */ }
      return false;
    })();
    synchronizing = work;
    try { return await work; }
    finally { if (synchronizing === work) synchronizing = undefined; }
  }
  return Object.freeze({ connect, synchronize,
    apply(resourceId: string, observation: Observation, context: DeliveryContext) {
      if (!current(epoch) || !core) return Promise.resolve(); return core.apply(resourceId, observation, context);
    },
    release(resourceId: string, why: string, context: Readonly<{ routeId: string }>) { core?.release(resourceId, why, context); },
    async close() {
      if (closed) { await finishClient(true); return; }
      closed = true; connected = false; state = 'closed'; reason = 'closed'; epoch++; clock.close();
      try { core?.close(); } catch { /* fixed failure */ }
      core = undefined; capture = undefined;
      await finishClient(true);
    }, status,
  });
}
