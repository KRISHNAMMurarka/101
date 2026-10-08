import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MqttClient } from 'mqtt';
import { createTrustedConnectorProfileRegistry, parseConnectorProfileManifest } from '@101/connect';
import { createClockedMqttConnector } from './mqtt-clocked-connector.ts';
import type { ClockedMqttConnectionRequest } from './mqtt-clocked-connector.ts';
import { createMqttExampleDecoder } from '../../../examples/mqtt-connector/decoder.mjs';
import { createMqttExampleProfile, MQTT_EXAMPLE_DECODER_SOURCE } from '../../../examples/mqtt-connector/profile.mjs';
import { REMOTE_CLOCK_TOPICS, runRemoteClockProducer } from '../../../examples/mqtt-connector/remote-clock-producer.mjs';
import { startOwnedMqttBroker } from '../../../tools/qa-mqtt-connector.mjs';

test('clocked MQTT connector exposes a separate explicit factory', () => {
  assert.equal(typeof createClockedMqttConnector, 'function');
});

async function bindingFor(clockId: string) {
  const base = createMqttExampleProfile();
  const manifest = parseConnectorProfileManifest({ ...base, id: 'example:mqtt-remote-enabled',
    identityFilters: [{ field: 'backendId', equals: 'mqtt5' }, { field: 'wireVersion', equals: 1 },
      { field: 'clockId', equals: clockId }] });
  const registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source: MQTT_EXAMPLE_DECODER_SOURCE, factory: createMqttExampleDecoder });
  return registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: manifest.decoder.codeSha256 });
}

test('connection denial happens before a socket and binds exact profile, key and topic authority', async () => {
  const clockId = 'remote:boot-test', binding = await bindingFor(clockId), key = randomBytes(32);
  let requestSeen: ClockedMqttConnectionRequest | undefined, clockApprovalCalls = 0, replacementCalls = 0;
  const options = { endpoint: 'mqtt://127.0.0.1:1', binding, producerId: 'producer', producerClockId: clockId,
    localClockId: 'host-clock', keyId: 'enrolled-key', key, topics: REMOTE_CLOCK_TOPICS,
    authorizeConnection(request: ClockedMqttConnectionRequest) { requestSeen = request; return undefined; },
    authorizeClock() { clockApprovalCalls++; return undefined; }, onSample() {}, onUnavailable() {} };
  const connector = createClockedMqttConnector(options);
  options.authorizeConnection = () => { replacementCalls++; return undefined; };
  assert.deepEqual(await connector.connect({ purpose: 'exact authority', signal: new AbortController().signal }),
    { ok: false, reason: 'connect-failed' });
  assert.equal(replacementCalls, 0);
  assert.equal(clockApprovalCalls, 0);
  assert.equal(requestSeen?.producerClockId, clockId);
  assert.equal(requestSeen?.keyId, 'enrolled-key');
  assert.equal(requestSeen?.profileId, binding.manifest.id);
  assert.equal(requestSeen?.decoder.codeSha256, binding.manifest.decoder.codeSha256);
  assert.deepEqual(requestSeen?.topics.map((row: { topic: string }) => row.topic), Object.values(REMOTE_CLOCK_TOPICS));
  assert.ok(Object.isFrozen(requestSeen?.topics));
  assert.ok(requestSeen?.topics.every((row: { qos: number; deadlineMs: number; expirySeconds: number }) =>
    row.qos === 1 && row.deadlineMs > 0 && row.expirySeconds > 0));
  await connector.close();
});

test('held ping PUBACK occupies one raw slot and concurrent synchronization joins it', async () => {
  const broker = await startOwnedMqttBroker(), key = randomBytes(32);
  const producer = await runRemoteClockProducer(broker.endpoint, key.toString('hex'));
  const binding = await bindingFor(producer.clockId);
  const owner = new AbortController(), connectionGrant = new AbortController(), clockGrant = new AbortController();
  const connector = createClockedMqttConnector({ endpoint: broker.endpoint, binding,
    producerId: 'enrolled-producer', producerClockId: producer.clockId, localClockId: 'mqtt-host-monotonic',
    keyId: 'fixture-key', key, topics: REMOTE_CLOCK_TOPICS,
    authorizeConnection(request) { return { request, signal: connectionGrant.signal, expiresAt: performance.now() + 10000 }; },
    authorizeClock(request) { return { request, signal: clockGrant.signal, expiresAt: performance.now() + 10000 }; },
    onSample() {}, onUnavailable() {} });
  const original = MqttClient.prototype.publish;
  const held: Array<() => void> = [];
  let pings = 0;
  try {
    assert.deepEqual(await connector.connect({ purpose: 'held-ping', signal: owner.signal }), { ok: true });
    const attemptsBefore = connector.status().attempts;
    MqttClient.prototype.publish = function (this: MqttClient, ...args) {
      if (args[0] === REMOTE_CLOCK_TOPICS.ping) {
        pings++;
        const callback = args.at(-1) as (error?: Error) => void;
        args[args.length - 1] = ((error?: Error) => { held.push(() => callback(error)); }) as typeof callback;
      }
      return Reflect.apply(original, this, args);
    } as typeof original;
    const synchronized = Array.from({ length: 8 }, () => connector.synchronize());
    const end = performance.now() + 1000;
    while (held.length === 0 && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(held.length > 0, 'first ping reached broker and callback was held');
    await new Promise(resolve => setTimeout(resolve, 250));
    const later = Array.from({ length: 8 }, () => connector.synchronize());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(pings, 1, 'concurrent calls share one physical ping');
    assert.equal(connector.status().rawPending, 1, 'held ping consumes raw capacity');
    assert.equal(connector.status().attempts, attemptsBefore + 1, 'ping consumes shared attempt quota');
    for (const release of held.splice(0)) release();
    assert.deepEqual(await Promise.all([...synchronized, ...later]), Array(16).fill(false));
    assert.equal(connector.status().rawPending, 0);
    MqttClient.prototype.publish = original;
    assert.equal(await connector.synchronize(), true, 'fresh explicit exchange works after raw settlement');
    assert.equal(connector.status().attempts, attemptsBefore + 2);
  } finally {
    MqttClient.prototype.publish = original;
    for (const release of held.splice(0)) release();
    owner.abort(); connectionGrant.abort(); clockGrant.abort();
    await connector.close(); await producer.close(); await broker.close();
  }
});
