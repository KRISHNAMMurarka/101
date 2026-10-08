import { connectAsync } from 'mqtt';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { signMqttClockFrame, verifyMqttClockFrame } from '../../packages/hub-server/src/mqtt-clock.ts';

export const REMOTE_CLOCK_TOPICS = Object.freeze({ ping: '101/remote/clock/ping', pong: '101/remote/clock/pong',
  source: '101/remote/state/enabled', ack: '101/remote/acks/set-enabled', command: '101/remote/commands/set-enabled' });
export const REMOTE_CLOCK_ID_PREFIX = 'remote:boot-';
export const REMOTE_PRODUCER_ID = 'enrolled-producer';
export const REMOTE_KEY_ID = 'fixture-key';
export const REMOTE_ORIGIN_OFFSET_MS = 450000;

const now = () => performance.now() + REMOTE_ORIGIN_OFFSET_MS;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exact = (row, fields) => row && typeof row === 'object' && !Array.isArray(row) &&
  Object.keys(row).length === fields.length && fields.every(field => Object.hasOwn(row, field));

/** One disposable key-enrolled software producer; no physical authorship claim. */
export async function runRemoteClockProducer(endpoint, keyHex) {
  if (typeof keyHex !== 'string' || !/^[0-9a-f]{64}$/.test(keyHex)) throw new TypeError('fixture-key');
  const key = Buffer.from(keyHex, 'hex');
  const clockId = `${REMOTE_CLOCK_ID_PREFIX}${randomBytes(12).toString('hex')}`;
  const client = await connectAsync(endpoint, { protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0 },
    reconnectPeriod: 0, resubscribe: false, queueQoSZero: false, connectTimeout: 3000,
    clientId: `101-remote-producer-${process.pid}` });
  const subscriptions = await client.subscribeAsync({ [REMOTE_CLOCK_TOPICS.ping]: { qos: 1 }, [REMOTE_CLOCK_TOPICS.command]: { qos: 1 } });
  if (subscriptions.length !== 2 || subscriptions.some(row => row.qos !== 1)) { await client.endAsync(true); throw Error('fixture-subscribe'); }
  let closed = false, effects = 0, rejected = 0, sourceSequence = 0, ackSequence = 0, enabled = false;
  let ackGate, releaseAckGate;
  let activeSession;
  const sessions = new Map(), pingNonces = new Set();
  const MAX_SESSIONS = 8, MAX_PINGS = 256;
  const identity = { producerId: REMOTE_PRODUCER_ID, clockId, keyId: REMOTE_KEY_ID };
  const packetOkay = packet => packet.qos === 1 && packet.retain === false &&
    Number.isInteger(packet.properties?.messageExpiryInterval) && packet.properties.messageExpiryInterval >= 1 &&
    packet.properties.messageExpiryInterval <= 3;
  const publish = (topic, body, expiry = 1) => client.publishAsync(topic, signMqttClockFrame(body, key),
    { qos: 1, retain: false, properties: { messageExpiryInterval: expiry } });
  async function emitSample(sourceAt = now(), session = activeSession) {
    const observedValue = enabled;
    await sleep(35);
    if (closed || !session) return;
    await publish(REMOTE_CLOCK_TOPICS.source, { schemaVersion: 1, kind: 'sample', ...identity,
      clientId: session.clientId, sessionNonce: session.sessionNonce,
      resourceId: 'enabled', sequence: ++sourceSequence, sourceAt, value: observedValue });
  }
  async function accept(topic, payload, packet) {
    if (closed || !packetOkay(packet) || (topic !== REMOTE_CLOCK_TOPICS.ping && topic !== REMOTE_CLOCK_TOPICS.command)) { rejected++; return; }
    const receivedAt = now(), body = verifyMqttClockFrame(payload, key);
    if (!body || body.schemaVersion !== 1 || body.producerId !== REMOTE_PRODUCER_ID || body.clockId !== clockId ||
      body.keyId !== REMOTE_KEY_ID) { rejected++; return; }
    if (topic === REMOTE_CLOCK_TOPICS.ping) {
      if (!exact(body, ['schemaVersion', 'kind', 'producerId', 'clockId', 'keyId', 'clientId', 'sessionNonce', 'nonce', 'sentAt', 'expiresAt']) ||
        body.kind !== 'clock-ping' || typeof body.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce) ||
        typeof body.clientId !== 'string' || !/^101-[A-Za-z0-9-]{1,100}$/.test(body.clientId) ||
        typeof body.sessionNonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.sessionNonce) ||
        typeof body.sentAt !== 'number' || !Number.isFinite(body.sentAt) ||
        typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt) || body.expiresAt <= body.sentAt ||
        body.expiresAt > body.sentAt + 200 || pingNonces.has(body.nonce) || pingNonces.size >= MAX_PINGS) { rejected++; return; }
      const existing = sessions.get(body.sessionNonce);
      if (existing && (existing.clientId !== body.clientId || existing.retired) ||
        !existing && sessions.size >= MAX_SESSIONS) { rejected++; return; }
      pingNonces.add(body.nonce);
      const session = existing ?? { clientId: body.clientId, sessionNonce: body.sessionNonce, watermark: 0, retired: false };
      if (!existing) sessions.set(body.sessionNonce, session);
      if (activeSession && activeSession !== session) activeSession.retired = true;
      activeSession = session;
      await publish(REMOTE_CLOCK_TOPICS.pong, { schemaVersion: 1, kind: 'clock-pong', ...identity,
        clientId: session.clientId, sessionNonce: session.sessionNonce,
        nonce: body.nonce, receivedAt, sentAt: now() });
      return;
    }
    const at = now();
    if (!exact(body, ['schemaVersion', 'kind', 'producerId', 'clockId', 'keyId', 'clientId', 'sessionNonce',
      'resourceId', 'commandId', 'commandNonce', 'value', 'originalDeadlineLocal', 'expiresAtRemote']) ||
      body.kind !== 'command' || body.resourceId !== 'set-enabled' || !activeSession ||
      body.clientId !== activeSession.clientId || body.sessionNonce !== activeSession.sessionNonce ||
      typeof body.commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(body.commandId) || typeof body.value !== 'boolean' ||
      typeof body.commandNonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.commandNonce) ||
      typeof body.originalDeadlineLocal !== 'number' || !Number.isFinite(body.originalDeadlineLocal) ||
      typeof body.expiresAtRemote !== 'number' || !Number.isFinite(body.expiresAtRemote) ||
      body.expiresAtRemote <= at || body.expiresAtRemote > at + 3000) { rejected++; return; }
    const session = activeSession, id = Number(body.commandId);
    if (id <= session.watermark) { rejected++; return; }
    session.watermark = id; enabled = body.value; effects++;
    const ackAt = now();
    await sleep(35);
    if (ackGate) { const gate = ackGate; ackGate = undefined; await gate; }
    await publish(REMOTE_CLOCK_TOPICS.ack, { schemaVersion: 1, kind: 'ack', ...identity,
      clientId: session.clientId, sessionNonce: session.sessionNonce,
      resourceId: 'set-enabled', commandId: body.commandId, commandNonce: body.commandNonce,
      sequence: ++ackSequence, sourceAt: ackAt });
    await emitSample(now(), session);
  }
  client.on('message', (topic, payload, packet) => { void accept(topic, payload, packet).catch(() => { rejected++; }); });
  client.on('error', () => { rejected++; });
  return Object.freeze({
    clockId,
    status: () => Object.freeze({ effects, rejected, watermark: activeSession?.watermark ?? 0,
      sessions: sessions.size, seenPings: pingNonces.size, enabled, remoteNow: now() }),
    emitSample,
    holdNextAck() { if (ackGate || releaseAckGate) throw new Error('ack-already-held');
      ackGate = new Promise(resolve => { releaseAckGate = resolve; }); },
    releaseHeldAck() { const release = releaseAckGate; releaseAckGate = undefined; release?.(); },
    async close() { if (closed) return; closed = true; releaseAckGate?.(); releaseAckGate = undefined;
      await client.endAsync(true); },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let producer;
  try {
    producer = await runRemoteClockProducer(process.env.MQTT_CLOCK_ENDPOINT, process.env.MQTT_CLOCK_KEY_HEX);
    process.send?.({ type: 'ready', pid: process.pid, clockId: producer.clockId, offsetMs: REMOTE_ORIGIN_OFFSET_MS });
    process.on('message', message => {
      if (message?.type === 'sample') void producer.emitSample().then(() => process.send?.({ type: 'sample-sent' }));
      if (message?.type === 'status') process.send?.({ type: 'status', value: producer.status() });
      if (message?.type === 'hold-ack') { producer.holdNextAck(); process.send?.({ type: 'ack-held' }); }
      if (message?.type === 'release-ack') { producer.releaseHeldAck(); process.send?.({ type: 'ack-released' }); }
      if (message?.type === 'close') void producer.close().then(() => process.exit(0));
    });
  } catch (error) {
    process.send?.({ type: 'error', reason: error instanceof Error ? error.message : 'producer-failed' });
    process.exitCode = 1;
  }
}
