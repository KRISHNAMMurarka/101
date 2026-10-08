import { connect } from 'mqtt';

const CLOCK = 'mqtt-demo-clock';
const COMMAND_TOPIC = '101/demo/commands/set-enabled';
const ACK_TOPIC = '101/demo/acks/set-enabled';
const STATE_TOPIC = '101/demo/state/enabled';
const TEMPERATURE_TOPIC = '101/demo/telemetry/temperature';

function connectOnce(endpoint) {
  const client = connect(endpoint, { protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0 }, reconnectPeriod: 0,
    resubscribe: false, queueQoSZero: false, connectTimeout: 3000, keepalive: 15, clientId: `101-producer-${process.pid}` });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.end(true); reject(new Error('fixture-connect-timeout')); }, 3500);
    const cleanup = () => { clearTimeout(timer); client.off('connect', connected); client.off('error', failed); client.off('close', closed); };
    const connected = () => { cleanup(); resolve(client); };
    const failed = () => { cleanup(); reject(new Error('fixture-connect-failed')); };
    const closed = () => { cleanup(); reject(new Error('fixture-connect-closed')); };
    client.once('connect', connected); client.once('error', failed); client.once('close', closed);
  });
}

/** Local test producer. Repeated application command IDs have no second effect. */
export async function startMqttFixtureProducer(endpoint) {
  const client = await connectOnce(endpoint);
  let closed = false, enabled = false, sampleSequence = 0, ackSequence = 0, effects = 0, duplicates = 0, watermark = 0;
  let publishErrors = 0;
  async function send(topic, frame, expirySeconds = 5, qos = 1) {
    if (closed) return;
    const packet = await client.publishAsync(topic, JSON.stringify(frame), { qos, retain: false,
      properties: { messageExpiryInterval: expirySeconds, payloadFormatIndicator: true, contentType: 'application/json' } }).catch(() => { publishErrors++; return undefined; });
    if (qos === 1 && !packet) publishErrors++;
  }
  const sample = (resourceId, value) => ({ kind: 'sample', resourceId, value, sequence: ++sampleSequence,
    sourceTime: { clockId: CLOCK, at: performance.now() }, quality: 'valid', calibration: resourceId === 'temperature'
      ? { revision: 1, unit: 'Cel', absoluteErrorBound: 0.5 } : null });
  const subscribed = await client.subscribeAsync({ [COMMAND_TOPIC]: { qos: 1 } });
  if (subscribed.length !== 1 || subscribed[0]?.topic !== COMMAND_TOPIC || subscribed[0]?.qos === 128) {
    await client.endAsync(true); throw new Error('fixture-subscribe-failed');
  }
  client.on('message', (topic, payload, packet) => {
    if (closed || topic !== COMMAND_TOPIC || packet.retain || packet.qos !== 1 || payload.byteLength > 1024 ||
      !Number.isInteger(packet.properties?.messageExpiryInterval) || packet.properties.messageExpiryInterval < 1 || packet.properties.messageExpiryInterval > 3) { publishErrors++; return; }
    try {
      const command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      const at = performance.now();
      if (!command || typeof command !== 'object' || Array.isArray(command) || Reflect.ownKeys(command).length !== 3 ||
        typeof command.commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(command.commandId) || typeof command.value !== 'boolean' ||
        typeof command.expiresAt !== 'number' || !Number.isFinite(command.expiresAt) || command.expiresAt <= at ||
        command.expiresAt > at + 3000) throw Error('fixture-command');
      const id = Number(command.commandId);
      if (id <= watermark) { duplicates++; return; }
      watermark = id; enabled = command.value; effects++;
      void send(ACK_TOPIC, { kind: 'ack', resourceId: 'set-enabled', commandId: command.commandId,
        sequence: ++ackSequence, sourceTime: { clockId: CLOCK, at: performance.now() } }, 3);
      void send(STATE_TOPIC, sample('enabled', enabled));
    } catch { publishErrors++; }
  });
  client.on('error', () => { publishErrors++; });
  await send(TEMPERATURE_TOPIC, sample('temperature', 22.5), 5, 0);
  const timer = setInterval(() => { if (!closed) void send(TEMPERATURE_TOPIC, sample('temperature', 22.5), 5, 0); }, 500);
  return Object.freeze({
    status: () => Object.freeze({ enabled, effects, duplicates, publishErrors, watermark }),
    /** Send the same business command ID twice through the actual broker fixture. */
    async duplicateCommand(commandId, value) {
      const payload = JSON.stringify({ commandId, value, expiresAt: performance.now() + 3000 });
      const options = { qos: 1, retain: false, properties: { messageExpiryInterval: 3, payloadFormatIndicator: true, contentType: 'application/json' } };
      await client.publishAsync(COMMAND_TOPIC, payload, options); await client.publishAsync(COMMAND_TOPIC, payload, options);
    },
    async retainedProbe() {
      const frame = sample('temperature', 21);
      await client.publishAsync(TEMPERATURE_TOPIC, JSON.stringify(frame), { qos: 1, retain: true,
        properties: { messageExpiryInterval: 5, payloadFormatIndicator: true, contentType: 'application/json' } });
      await client.publishAsync(TEMPERATURE_TOPIC, Buffer.alloc(0), { qos: 1, retain: true });
    },
    async staleProbe() {
      const frame = sample('temperature', 19); frame.sourceTime.at -= 10000;
      await client.publishAsync(TEMPERATURE_TOPIC, JSON.stringify(frame), { qos: 1, retain: false,
        properties: { messageExpiryInterval: 5, payloadFormatIndicator: true, contentType: 'application/json' } });
    },
    async retainedAckProbe(commandId) {
      const frame = { kind: 'ack', resourceId: 'set-enabled', commandId, sequence: ++ackSequence,
        sourceTime: { clockId: CLOCK, at: performance.now() } };
      await client.publishAsync(ACK_TOPIC, JSON.stringify(frame), { qos: 1, retain: true,
        properties: { messageExpiryInterval: 3, payloadFormatIndicator: true, contentType: 'application/json' } });
      await client.publishAsync(ACK_TOPIC, Buffer.alloc(0), { qos: 1, retain: true });
    },
    async close() { if (closed) return; closed = true; clearInterval(timer); await client.endAsync(true); },
  });
}
