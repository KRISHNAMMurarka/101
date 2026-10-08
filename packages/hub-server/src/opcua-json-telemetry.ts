/** Selected read-only OPC UA Part14 JSON/MQTT software profile. Publisher names
 * and Good status are inert claims; loopback transport authenticates no target. */
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { connect as mqttConnect, type MqttClient } from 'mqtt';

export interface OpcUaJsonProfile {
  readonly id: string; readonly revision: number; readonly topic: string; readonly publisherId: string;
  readonly writerGroupName: string; readonly dataSetClassId: string; readonly dataSetWriterId: number;
  readonly metadataVersion: Readonly<{ major: number; minor: number }>;
  readonly field: Readonly<{ name: string; builtInType: 11; dataType: 'i=11'; valueRank: -1;
    engineeringUnits: Readonly<{ namespaceUri: 'http://www.opcfoundation.org/UA/units/un/cefact'; unitId: 4408652 }>;
    unit: 'Cel'; min: number; max: number }>;
  readonly receiveTimeoutMs: number;
}
export interface OpcUaJsonRecord {
  readonly severity: 'good' | 'uncertain' | 'bad'; readonly statusCode: number; readonly dataSetStatusCode: number;
  readonly sourceSequence: number; readonly missingMessages: number; readonly temperature?: number;
  readonly sourceTimestamp?: string; readonly serverTimestamp?: string; readonly sourcePicoseconds?: number; readonly serverPicoseconds?: number;
}
export interface OpcUaJsonDecoded { readonly messageId: string; readonly datasetTimestamp: string; readonly record: OpcUaJsonRecord }
export const OPCUA_JSON_LIMITS = Object.freeze({ messages: 256, payloadBytes: 8192, totalBytes: 1048576, sessionMs: 30000 } as const);
function invalid(): never { throw new TypeError('Invalid selected OPC UA JSON telemetry'); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value); if (keys.length > required.length + optional.length || required.some(key => !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) invalid();
    const field = Object.getOwnPropertyDescriptor(value, key); if (!field?.enumerable || !('value' in field)) invalid();
    result[key] = field.value;
  }
  return result;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return value;
}
function uint(value: unknown, max = 0xffffffff, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
}
function utc(value: unknown): string {
  const result = text(value, 32), match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?Z$/.exec(result);
  if (!match) invalid();
  const parts = match.slice(1, 7).map(Number), [year, month, day, hour, minute, second] = parts;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined || year < 1970) invalid();
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
    date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) invalid();
  return result;
}
export function parseOpcUaJsonProfile(input: unknown): Readonly<OpcUaJsonProfile> {
  const p = object(input, ['id','revision','topic','publisherId','writerGroupName','dataSetClassId','dataSetWriterId','metadataVersion','field','receiveTimeoutMs']);
  const version = object(p.metadataVersion, ['major','minor']);
  const field = object(p.field, ['name','builtInType','dataType','valueRank','engineeringUnits','unit','min','max']);
  const units = object(field.engineeringUnits, ['namespaceUri','unitId']);
  const topic = text(p.topic, 256), name = text(field.name, 64), guid = text(p.dataSetClassId, 36);
  if (/[+#]/.test(topic) || Buffer.byteLength(topic) > 256 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
    ['constructor','prototype','__proto__'].includes(name) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(guid) ||
    field.builtInType !== 11 || field.dataType !== 'i=11' || field.valueRank !== -1 || field.unit !== 'Cel' ||
    units.namespaceUri !== 'http://www.opcfoundation.org/UA/units/un/cefact' || units.unitId !== 4408652 ||
    typeof field.min !== 'number' || typeof field.max !== 'number' || !Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min >= field.max) invalid();
  return Object.freeze({ id: text(p.id), revision: uint(p.revision, 0x7fffffff, 1), topic, publisherId: text(p.publisherId),
    writerGroupName: text(p.writerGroupName), dataSetClassId: guid, dataSetWriterId: uint(p.dataSetWriterId, 65535, 1),
    metadataVersion: Object.freeze({ major: uint(version.major), minor: uint(version.minor) }),
    field: Object.freeze({ name, builtInType: 11, dataType: 'i=11', valueRank: -1,
      engineeringUnits: Object.freeze({ namespaceUri: 'http://www.opcfoundation.org/UA/units/un/cefact', unitId: 4408652 }),
      unit: 'Cel', min: field.min, max: field.max }), receiveTimeoutMs: uint(p.receiveTimeoutMs, 5000, 250) });
}
/** Validate every JSON object key before JSON.parse can discard duplicates. */
function json(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || types.isProxy(bytes)) invalid();
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
  const size = Reflect.apply(getter, bytes, []) as number; if (size < 1 || size > OPCUA_JSON_LIMITS.payloadBytes) invalid();
  const copied = new Uint8Array(size); Uint8Array.prototype.set.call(copied, bytes);
  let source: string; try { source = new TextDecoder('utf-8', { fatal: true }).decode(copied); } catch { invalid(); }
  let at = 0, nodes = 0;
  function whitespace() { while (/[\t\r\n ]/.test(source[at] ?? 'x')) at++; }
  function string(): string {
    const start = at++; if (source[start] !== '"') invalid();
    while (at < source.length) { const character = source[at++]; if (character === '\\') at++; else if (character === '"') {
      try { return JSON.parse(source.slice(start, at)) as string; } catch { invalid(); }
    } }
    invalid();
  }
  function value(depth: number): void {
    if (++nodes > 128 || depth > 8) invalid(); whitespace(); const character = source[at];
    if (character === '"') { string(); return; }
    if (character === '{') {
      at++; whitespace(); const keys = new Set<string>(); if (source[at] === '}') { at++; return; }
      for (;;) { whitespace(); const key = string(); if (keys.has(key) || ['__proto__','constructor','prototype'].includes(key)) invalid(); keys.add(key);
        whitespace(); if (source[at++] !== ':') invalid(); value(depth + 1); whitespace();
        const end = source[at++]; if (end === '}') return; if (end !== ',') invalid(); }
    }
    if (character === '[') { at++; whitespace(); if (source[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); whitespace(); const end = source[at++]; if (end === ']') return; if (end !== ',') invalid(); } }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!token) invalid(); at += token[0].length;
  }
  value(0); whitespace(); if (at !== source.length) invalid();
  try { return JSON.parse(source); } catch { invalid(); }
}
function status(input: unknown): number {
  if (input === undefined) return 0;
  const value = object(input, ['Code'], ['Symbol']); if (value.Symbol !== undefined) text(value.Symbol, 128); return uint(value.Code);
}
function severity(code: number): 0 | 1 | 2 { const value = Math.floor(code / 0x40000000); return value === 0 ? 0 : value === 1 ? 1 : 2; }
export function decodeOpcUaJsonTelemetry(bytes: Uint8Array, input: OpcUaJsonProfile): Readonly<OpcUaJsonDecoded> {
  const p = parseOpcUaJsonProfile(input), network = object(json(bytes), ['MessageId','MessageType','PublisherId','WriterGroupName','DataSetClassId','Messages']);
  if (network.MessageType !== 'ua-data' || network.PublisherId !== p.publisherId || network.WriterGroupName !== p.writerGroupName ||
    network.DataSetClassId !== p.dataSetClassId || !Array.isArray(network.Messages) || network.Messages.length !== 1) invalid();
  const message = object(network.Messages[0], ['DataSetWriterId','SequenceNumber','MetaDataVersion','Timestamp','MessageType','Payload'], ['Status']);
  const version = object(message.MetaDataVersion, ['MajorVersion','MinorVersion']);
  if (message.DataSetWriterId !== p.dataSetWriterId || version.MajorVersion !== p.metadataVersion.major || version.MinorVersion !== p.metadataVersion.minor || message.MessageType !== 'ua-keyframe') invalid();
  const payload = object(message.Payload, [p.field.name]), data = object(payload[p.field.name], ['Value'], ['Status','SourceTimestamp','ServerTimestamp','SourcePicoseconds','ServerPicoseconds']);
  const fieldStatus = status(data.Status), overallStatus = status(message.Status), rank = Math.max(severity(fieldStatus), severity(overallStatus));
  const stamps: { sourceTimestamp?: string; serverTimestamp?: string; sourcePicoseconds?: number; serverPicoseconds?: number } = {};
  if (data.SourceTimestamp !== undefined) stamps.sourceTimestamp = utc(data.SourceTimestamp);
  if (data.ServerTimestamp !== undefined) stamps.serverTimestamp = utc(data.ServerTimestamp);
  if (data.SourcePicoseconds !== undefined) { if (!stamps.sourceTimestamp) invalid(); stamps.sourcePicoseconds = uint(data.SourcePicoseconds, 9999); }
  if (data.ServerPicoseconds !== undefined) { if (!stamps.serverTimestamp) invalid(); stamps.serverPicoseconds = uint(data.ServerPicoseconds, 9999); }
  let temperature: number | undefined;
  if (data.Value !== null && (typeof data.Value !== 'number' || !Number.isFinite(data.Value) || data.Value < p.field.min || data.Value > p.field.max)) invalid();
  if (rank === 0 && (typeof data.Value !== 'number' || !stamps.sourceTimestamp)) invalid();
  if (rank !== 2 && typeof data.Value === 'number') temperature = data.Value;
  return Object.freeze({ messageId: text(network.MessageId), datasetTimestamp: utc(message.Timestamp),
    record: Object.freeze({ severity: rank === 0 ? 'good' : rank === 1 ? 'uncertain' : 'bad', statusCode: fieldStatus,
      dataSetStatusCode: overallStatus, sourceSequence: uint(message.SequenceNumber), missingMessages: 0, ...stamps,
      ...(temperature === undefined ? {} : { temperature }) }) });
}
export function opcUaSequenceGap(previous: number, incoming: number): number | undefined {
  uint(previous); uint(incoming); const distance = (incoming - previous - 1 + 0x100000000) % 0x100000000;
  return distance < 0x40000000 ? distance : undefined;
}

export interface OpcUaJsonApprovalRequest {
  readonly action: 'subscribe'; readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly endpoint: string; readonly purpose: string; readonly generation: number; readonly profile: Readonly<OpcUaJsonProfile>;
  readonly budgets: typeof OPCUA_JSON_LIMITS;
}
export interface OpcUaJsonApproval { readonly request: OpcUaJsonApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface OpcUaJsonReading extends OpcUaJsonDecoded {
  readonly localSequence: number; readonly receivedAt: number; readonly receiptClockId: string; readonly payloadSha256: string;
}
export interface OpcUaJsonOptions {
  readonly ownerSignal: AbortSignal; readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly endpoint: string; readonly profile: OpcUaJsonProfile;
  readonly authorize: (request: OpcUaJsonApprovalRequest) => OpcUaJsonApproval | undefined;
  readonly onReading: (reading: OpcUaJsonReading) => void; readonly onUnavailable: (reason: string) => void;
}
export interface OpcUaJsonConnector {
  start(request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'connecting' | 'ready' | 'retiring' | 'closed'; messages: number;
    receivedBytes: number; rejectedMessages: number; delivered: number; nativeClients: number; reason: string }>;
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
function aborted(signal: AbortSignal): boolean { return Reflect.apply(abortGetter, signal, []) as boolean; }
function genuineSignal(value: unknown): value is AbortSignal {
  try { if (!value || typeof value !== 'object' || types.isProxy(value)) return false; aborted(value as AbortSignal); return true; } catch { return false; }
}
export function createOpcUaJsonTelemetryConnector(input: OpcUaJsonOptions): OpcUaJsonConnector {
  const raw = object(input, ['ownerSignal','scope','endpoint','profile','authorize','onReading','onUnavailable']);
  const s = object(raw.scope, ['principalId','applicationId','sessionId']);
  const scope = Object.freeze({ principalId: text(s.principalId), applicationId: text(s.applicationId), sessionId: text(s.sessionId) });
  const profile = parseOpcUaJsonProfile(raw.profile), endpoint = text(raw.endpoint, 256);
  if (!/^mqtt:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(endpoint) || Number(endpoint.split(':').at(-1)) > 65535 ||
    !genuineSignal(raw.ownerSignal) || typeof raw.authorize !== 'function' || typeof raw.onReading !== 'function' || typeof raw.onUnavailable !== 'function') invalid();
  const owner = raw.ownerSignal, authorize = raw.authorize as OpcUaJsonOptions['authorize'];
  const onReading = raw.onReading as OpcUaJsonOptions['onReading'], onUnavailable = raw.onUnavailable as OpcUaJsonOptions['onUnavailable'];
  let phase: 'idle' | 'connecting' | 'ready' | 'retiring' | 'closed' = 'idle';
  let epoch = 0, reason = 'idle', messages = 0, receivedBytes = 0, rejectedMessages = 0, delivered = 0, nativeClients = 0;
  let client: MqttClient | undefined, retirement: Promise<void> | undefined, grant: AbortSignal | undefined, caller: AbortSignal | undefined;
  let expiresAt = 0, lastSequence: number | undefined, localSequence = 0;
  let cancelSubscription: (() => void) | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, receiveTimer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>(), detach: (() => void)[] = [];
  const failure = (code: string) => Object.freeze({ ok: false as const, reason: code });
  function watch(value: AbortSignal, code: string): void {
    const listener = () => { void retire(code).catch(() => {}); };
    Reflect.apply(add, value, ['abort', listener, { once: true }]);
    detach.push(() => Reflect.apply(remove, value, ['abort', listener]));
    if (aborted(value)) listener();
  }
  function current(run: number, ready = false): boolean {
    return epoch === run && phase === (ready ? 'ready' : 'connecting') && !aborted(owner) && !!caller && !aborted(caller) &&
      !!grant && !aborted(grant) && performance.now() < expiresAt;
  }
  function retire(code: string): Promise<void> {
    if (retirement) return retirement;
    phase = 'retiring'; reason = code; epoch++;
    if (expiryTimer) clearTimeout(expiryTimer); if (receiveTimer) clearTimeout(receiveTimer);
    for (const removeListener of detach.splice(0)) removeListener();
    const active = client;
    retirement = Promise.resolve().then(async () => {
      if (active) {
        const stream = active.stream;
        if (!stream) throw new Error('OPC UA transport retirement unconfirmed');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closedListener: (() => void) | undefined;
        const nativeClose = new Promise<void>(resolve => {
          if ((stream as { closed?: boolean }).closed === true) resolve();
          else { closedListener = resolve; stream.once('close', resolve); }
        });
        try {
          await Promise.race([Promise.all([active.endAsync(true), nativeClose]), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('OPC UA transport retirement unconfirmed')), 2000);
          })]);
          nativeClients = 0; client = undefined;
        } finally { if (timer) clearTimeout(timer); if (closedListener) stream.off('close', closedListener); }
      }
      phase = 'closed';
    });
    cancelSubscription?.();
    try { onUnavailable(code); } catch { /* Diagnostic callback cannot reactivate a retired session. */ }
    return retirement;
  }
  function freshness(): void {
    if (receiveTimer) clearTimeout(receiveTimer);
    receiveTimer = setTimeout(() => { void retire('receive-timeout').catch(() => {}); }, profile.receiveTimeoutMs);
  }
  async function start(request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> {
    if (phase !== 'idle') return failure(phase === 'connecting' || phase === 'ready' ? 'busy' : 'closed');
    const r = object(request, ['purpose','signal']), purpose = text(r.purpose);
    if (!genuineSignal(r.signal)) invalid(); caller = r.signal;
    phase = 'connecting'; reason = 'connecting'; const run = ++epoch;
    if (aborted(owner) || aborted(caller)) { await retire('cancelled'); return failure('cancelled'); }
    let approval: Record<string, unknown> | undefined;
    const authority = Object.freeze({ action: 'subscribe' as const, ...scope, endpoint, purpose, generation: run, profile, budgets: OPCUA_JSON_LIMITS });
    try { approval = object(authorize(authority), ['request','signal','expiresAt']); } catch { approval = undefined; }
    const now = performance.now();
    if (!approval || approval.request !== authority || !genuineSignal(approval.signal) || aborted(approval.signal) ||
      typeof approval.expiresAt !== 'number' || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= now ||
      approval.expiresAt > now + OPCUA_JSON_LIMITS.sessionMs || aborted(owner) || aborted(caller) || epoch !== run || phase !== 'connecting') {
      await retire('denied'); return failure('denied');
    }
    grant = approval.signal; expiresAt = approval.expiresAt;
    watch(owner, 'owner-aborted'); watch(caller, 'cancelled'); watch(grant, 'revoked');
    expiryTimer = setTimeout(() => { void retire('expired').catch(() => {}); }, Math.max(1, expiresAt - performance.now()));
    if (!current(run)) { await retire('cancelled'); return failure(reason); }
    try {
      const active = mqttConnect(endpoint, { protocolVersion: 5, clean: true, reconnectPeriod: 0, resubscribe: false,
        queueQoSZero: false, reconnectOnConnackError: false, connectTimeout: 5000, keepalive: 5,
        properties: { sessionExpiryInterval: 0, receiveMaximum: 1, maximumPacketSize: OPCUA_JSON_LIMITS.payloadBytes + 1024 } });
      client = active; nativeClients = 1;
      active.on('error', () => { void retire('transport-error').catch(() => {}); });
      active.on('close', () => { if (phase === 'ready' || phase === 'connecting') void retire('transport-closed').catch(() => {}); });
      active.on('message', (topic, bytes, packet) => {
        // Account current native epoch traffic before subscription activation.
        // A held SUBACK cannot turn the connecting phase into an unbounded inbox.
        if (epoch !== run || client !== active || phase !== 'connecting' && phase !== 'ready') return;
        messages++; receivedBytes += bytes.byteLength;
        if (messages > OPCUA_JSON_LIMITS.messages || receivedBytes > OPCUA_JSON_LIMITS.totalBytes) { void retire('quota').catch(() => {}); return; }
        if (!current(run, true)) { if (phase === 'ready') void retire('expired-or-revoked').catch(() => {}); return; }
        try {
          if (topic !== profile.topic || packet.qos !== 1 || packet.retain || packet.properties?.contentType !== 'application/json') invalid();
          const decoded = decodeOpcUaJsonTelemetry(bytes, profile), sequence = decoded.record.sourceSequence;
          const gap = lastSequence === undefined ? 0 : opcUaSequenceGap(lastSequence, sequence);
          if (gap === undefined || seen.has(decoded.messageId)) { rejectedMessages++; return; }
          const receivedAt = performance.now(); if (!current(run, true)) return;
          seen.add(decoded.messageId); lastSequence = sequence; localSequence++;
          const reading = Object.freeze({ ...decoded, record: Object.freeze({ ...decoded.record, missingMessages: gap }),
            localSequence, receivedAt, receiptClockId: 'opcua-gateway-monotonic', payloadSha256: createHash('sha256').update(bytes).digest('hex') });
          onReading(reading); if (!current(run, true)) return;
          delivered++; freshness();
        } catch { rejectedMessages++; void retire('protocol-or-callback').catch(() => {}); }
      });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { if (timer) clearTimeout(timer); active.off('connect', connected); active.off('close', closed); active.off('error', errored); };
        const connected = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new Error('closed')); }, errored = () => { cleanup(); reject(new Error('error')); };
        active.once('connect', connected); active.once('close', closed); active.once('error', errored);
        const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, Math.min(5000, Math.max(1, expiresAt - performance.now())));
      });
      if (!current(run)) throw new Error('stale');
      const grants = await new Promise<Awaited<ReturnType<MqttClient['subscribeAsync']>>>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: Awaited<ReturnType<MqttClient['subscribeAsync']>>) => {
          if (settled) return; settled = true; clearTimeout(timer); cancelSubscription = undefined;
          if (error || !value) reject(error ?? new Error('subscription-failed')); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('subscription-timeout')), Math.min(5000, Math.max(1, expiresAt - performance.now())));
        cancelSubscription = () => finish(new Error('subscription-retired'));
        active.subscribeAsync(profile.topic, { qos: 1, rh: 2, rap: true }).then(value => finish(undefined, value), () => finish(new Error('subscription-failed')));
      });
      if (!current(run) || grants.length !== 1 || grants[0]?.topic !== profile.topic || grants[0]?.qos !== 1) throw new Error('stale-subscription');
      phase = 'ready'; reason = 'ready'; freshness(); return Object.freeze({ ok: true });
    } catch { await retire(reason === 'connecting' ? 'connect-failed' : reason); return failure(reason); }
  }
  return Object.freeze({ start, stop: () => retire('stopped'), close: () => retire('closed'), status: () => Object.freeze({ phase, messages,
    receivedBytes, rejectedMessages, delivered, nativeClients, reason }) });
}
