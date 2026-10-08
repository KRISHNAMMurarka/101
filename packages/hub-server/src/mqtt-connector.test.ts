import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTrustedConnectorProfileRegistry } from '@101/connect';
import { connectAsync, MqttClient } from 'mqtt';
import { createMqttConnector, parseMqttConnectorProfile } from './mqtt-connector.ts';
import type { MqttConnectionRequest } from './mqtt-connector.ts';
import { createMqttExampleDecoder } from '../../../examples/mqtt-connector/decoder.mjs';
import { createMqttExampleProfile, createMqttTransportProfile } from '../../../examples/mqtt-connector/profile.mjs';
import { startMqttFixtureProducer } from '../../../examples/mqtt-connector/producer.mjs';
import { runMqttConnectorExample } from '../../../examples/mqtt-connector/caller.mjs';
import { startOwnedMqttBroker } from '../../../tools/qa-mqtt-connector.mjs';

const api = await import('./mqtt-connector.ts').catch(() => undefined);

test('A05 has a public reviewed MQTT5 connector and caller contract', () => {
  assert.equal(typeof api?.parseMqttConnectorProfile, 'function', 'missing strict MQTT profile validation');
  assert.equal(typeof api?.createMqttConnector, 'function', 'missing approved MQTT transport connector');
});

test('reviewed MQTT profile admits exact topic resources and only QoS 0/1', () => {
  const base = createMqttTransportProfile(), parsed = parseMqttConnectorProfile(base);
  assert.equal(parsed.topics.length, 4); assert.deepEqual(new Set(parsed.topics.map(topic => topic.qos)), new Set([0, 1]));
  assert.throws(() => parseMqttConnectorProfile({ ...base, unknown: true }));
  assert.throws(() => parseMqttConnectorProfile({ ...base, topics: base.topics.map((topic, index) => index ? topic : { ...topic, topic: '101/#' }) }));
  assert.throws(() => parseMqttConnectorProfile({ ...base, topics: [...base.topics, { ...base.topics[0]! }] }));
  assert.throws(() => parseMqttConnectorProfile({ ...base, topics: base.topics.map((topic, index) => index ? topic : { ...topic, qos: 2 }) }));
  assert.throws(() => parseMqttConnectorProfile({ ...base, topics: base.topics.map((topic, index) => index ? topic : { ...topic, retained: true }) }));
});

async function reviewedFixture() {
  const manifest = createMqttExampleProfile(), source = readFileSync(new URL('../../../examples/mqtt-connector/decoder.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.decoder.codeSha256);
  const registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source, factory: createMqttExampleDecoder });
  return { manifest, profile: createMqttTransportProfile(), binding: registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: manifest.decoder.codeSha256 }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const end = performance.now() + 2000;
  while (!predicate()) { assert.ok(performance.now() < end, 'held MQTT operation was not reached'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

test('approval exposes the exact reviewed topic authority map and decoder', async () => {
  const fixture = await reviewedFixture();
  const altered = { ...fixture.profile, topics: fixture.profile.topics.map((topic, index) =>
    index === 0 ? { ...topic, resourceId: 'enabled' } : index === 1 ? { ...topic, resourceId: 'temperature' } : topic) };
  const requests: MqttConnectionRequest[] = [];
  for (const profile of [fixture.profile, altered]) {
    const connector = createMqttConnector({ endpoint: 'mqtt://127.0.0.1:1', profile, binding: fixture.binding,
      clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic',
      authorizeConnection(request) { requests.push(request); return undefined; }, onSample() {}, onUnavailable() {} });
    await connector.connect({ purpose: 'review', signal: new AbortController().signal }); await connector.close();
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]!.decoder, fixture.profile.decoder);
  assert.deepEqual(requests[0]!.topics, fixture.profile.topics.map(topic => ({ ...topic, deadlineMs: topic.maxAgeMs })));
  assert.equal(requests[0]!.topics.find(topic => topic.direction === 'command')?.deadlineMs, 3000);
  assert.notDeepEqual(requests[0]!.topics, requests[1]!.topics);
  assert.ok(Object.isFrozen(requests[0]!.topics)); assert.ok(Object.isFrozen(requests[0]!.topics[0]));
});

test('mutable options cannot replace the reviewed binding or credentials during approval', async () => {
  const broker = await startOwnedMqttBroker();
  try {
    const fixture = await reviewedFixture();
    const options = { endpoint: broker.endpoint, profile: fixture.profile, binding: fixture.binding,
      clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic' as const, username: 'reviewed', password: 'reviewed',
      authorizeConnection(request: MqttConnectionRequest) {
        Object.assign(options, { binding: Object.create(null), username: { changed: true }, password: { changed: true } });
        return { request, signal: new AbortController().signal, expiresAt: performance.now() + 5000 };
      }, onSample() {}, onUnavailable() {} };
    const connector = createMqttConnector(options);
    assert.deepEqual(await connector.connect({ purpose: 'snapshot', signal: new AbortController().signal }), { ok: true });
    await connector.close();
  } finally { await broker.close(); }
});

test('held subscribe cannot activate after the absolute approval deadline', async () => {
  const broker = await startOwnedMqttBroker(), original = MqttClient.prototype.subscribeAsync;
  const held = deferred<void>(); let subscribing = false, clock = performance.now();
  MqttClient.prototype.subscribeAsync = async function (this: MqttClient, ...args) { subscribing = true; await held.promise; return Reflect.apply(original, this, args); };
  try {
    const fixture = await reviewedFixture();
    const connector = createMqttConnector({ endpoint: broker.endpoint, profile: fixture.profile, binding: fixture.binding,
      clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic', now: () => clock,
      authorizeConnection(request) { return { request, signal: new AbortController().signal, expiresAt: clock + 10000 }; },
      onSample() {}, onUnavailable() {} });
    const connecting = connector.connect({ purpose: 'expiry', signal: new AbortController().signal });
    await until(() => subscribing); clock += 10001; held.resolve();
    assert.deepEqual(await connecting, { ok: false, reason: 'connect-failed' });
    await connector.close();
  } finally { MqttClient.prototype.subscribeAsync = original; held.resolve(); await broker.close(); }
});

test('cancelled raw publish keeps its MQTT reservation until callback or transport retirement', async () => {
  const broker = await startOwnedMqttBroker(), original = MqttClient.prototype.publish;
  const callbacks: Array<(error?: Error) => void> = [];
  MqttClient.prototype.publish = function (this: MqttClient, ...args) { callbacks.push(args.at(-1) as (error?: Error) => void); return this; } as typeof original;
  try {
    const fixture = await reviewedFixture();
    const connector = createMqttConnector({ endpoint: broker.endpoint, profile: fixture.profile, binding: fixture.binding,
      clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic',
      authorizeConnection(request) { return { request, signal: new AbortController().signal, expiresAt: performance.now() + 5000 }; },
      onSample() {}, onUnavailable() {} });
    assert.deepEqual(await connector.connect({ purpose: 'raw-cap', signal: new AbortController().signal }), { ok: true });
    const cancellation = new AbortController();
    const delivery = { signal: cancellation.signal, routeId: 'route', generation: 1, operationId: '1', isCurrent: () => !cancellation.signal.aborted,
      reportEvidence() {} };
    const observation = { value: true, sequence: 1, timestamp: performance.now(), receivedAt: performance.now(),
      clockDomain: 'mqtt-demo-clock', quality: 'valid' as const, source: { registrationId: 'control', deviceId: 'owner', capabilityId: 'control' } };
    const applying = connector.apply('set-enabled', observation, delivery);
    await until(() => callbacks.length > 0); cancellation.abort(); await applying;
    assert.equal(connector.status().rawPending, 1);
    for (let index = 2; index <= 4; index++) {
      const next = new AbortController();
      const pending = connector.apply('set-enabled', { ...observation, sequence: index },
        { ...delivery, operationId: String(index), signal: next.signal, isCurrent: () => !next.signal.aborted });
      await until(() => callbacks.length === index); next.abort(); await pending;
    }
    assert.equal(connector.status().rawPending, 4);
    const fifth = new AbortController();
    await connector.apply('set-enabled', { ...observation, sequence: 5 },
      { ...delivery, operationId: '5', signal: fifth.signal, isCurrent: () => !fifth.signal.aborted });
    assert.equal(callbacks.length, 4); assert.equal(connector.status().rawPending, 4);
    for (const callback of callbacks) callback();
    await until(() => connector.status().rawPending === 0);
    const last = new AbortController();
    const retiring = connector.apply('set-enabled', { ...observation, sequence: 6 },
      { ...delivery, operationId: '6', signal: last.signal, isCurrent: () => !last.signal.aborted });
    await until(() => callbacks.length === 5); last.abort(); await retiring;
    assert.equal(connector.status().rawPending, 1);
    await connector.close();
    assert.equal(connector.status().rawPending, 0);
    callbacks[4]!(); assert.equal(connector.status().rawPending, 0);
  } finally { MqttClient.prototype.publish = original; await broker.close(); }
});

test('local producer rejects command frames without an unexpired original deadline', async () => {
  const broker = await startOwnedMqttBroker();
  try {
    const producer = await startMqttFixtureProducer(broker.endpoint);
    const publisher = await connectAsync(broker.endpoint, { protocolVersion: 5, clean: true, reconnectPeriod: 0,
      clientId: `101-expired-probe-${process.pid}` });
    try {
      const options = { qos: 1 as const, retain: false, properties: { messageExpiryInterval: 3 } };
      await publisher.publishAsync('101/demo/commands/set-enabled', JSON.stringify({ commandId: '900', value: true }), options);
      await publisher.publishAsync('101/demo/commands/set-enabled', JSON.stringify({ commandId: '901', value: true,
        expiresAt: performance.now() - 1 }), options);
      await until(() => producer.status().publishErrors + producer.status().effects >= 2);
      assert.equal(producer.status().publishErrors, 2);
      assert.equal(producer.status().effects, 0);
    } finally { await publisher.endAsync(true); await producer.close(); }
  } finally { await broker.close(); }
});

test('publish timeout keeps the raw slot until MQTT callback settles', async () => {
  const broker = await startOwnedMqttBroker(), original = MqttClient.prototype.publish;
  let callback: ((error?: Error) => void) | undefined;
  MqttClient.prototype.publish = function (this: MqttClient, ...args) { callback = args.at(-1) as (error?: Error) => void; return this; } as typeof original;
  try {
    const fixture = await reviewedFixture();
    const profile = { ...fixture.profile, topics: fixture.profile.topics.map(topic => topic.direction === 'command'
      ? { ...topic, expirySeconds: 1 } : topic) };
    const connector = createMqttConnector({ endpoint: broker.endpoint, profile, binding: fixture.binding,
      clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic',
      authorizeConnection(request) { return { request, signal: new AbortController().signal, expiresAt: performance.now() + 5000 }; },
      onSample() {}, onUnavailable() {} });
    assert.deepEqual(await connector.connect({ purpose: 'timeout-cap', signal: new AbortController().signal }), { ok: true });
    const controller = new AbortController();
    const pending = connector.apply('set-enabled', { value: true, sequence: 1, timestamp: performance.now(), receivedAt: performance.now(),
      clockDomain: 'mqtt-demo-clock', quality: 'valid', source: { registrationId: 'control', deviceId: 'owner', capabilityId: 'control' } },
    { signal: controller.signal, routeId: 'route', generation: 1, operationId: '1', isCurrent: () => true, reportEvidence() {} });
    await until(() => callback !== undefined); await pending;
    assert.equal(connector.status().rawPending, 1);
    callback!(); await until(() => connector.status().rawPending === 0);
    await connector.close();
  } finally { MqttClient.prototype.publish = original; await broker.close(); }
});

test('concurrent close waits for teardown already started by a failed session', async () => {
  const broker = await startOwnedMqttBroker(), original = MqttClient.prototype.endAsync;
  const held = deferred<void>(); let ending = false;
  MqttClient.prototype.endAsync = async function (this: MqttClient, ...args) { ending = true; await held.promise; return Reflect.apply(original, this, args); };
  try {
    const fixture = await reviewedFixture(), owner = new AbortController();
    const connector = createMqttConnector({ endpoint: broker.endpoint, profile: fixture.profile, binding: fixture.binding,
      clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic',
      authorizeConnection(request) { return { request, signal: new AbortController().signal, expiresAt: performance.now() + 5000 }; },
      onSample() {}, onUnavailable() {} });
    assert.deepEqual(await connector.connect({ purpose: 'teardown', signal: owner.signal }), { ok: true });
    owner.abort(); await until(() => ending);
    let closed = false; const closing = connector.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, false);
    held.resolve(); await closing; assert.equal(closed, true);
  } finally { MqttClient.prototype.endAsync = original; held.resolve(); await broker.close(); }
});

test('connection approval binds the exact identity, rejects forged signals, and denies before opening a socket', async () => {
  const fixture = await reviewedFixture(); let approvals = 0, approvedRequest: MqttConnectionRequest | undefined;
  const forgedConnector = createMqttConnector({ endpoint: 'mqtt://127.0.0.1:1', profile: fixture.profile, binding: fixture.binding,
    clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic', authorizeConnection(request) { approvals++; approvedRequest = request; return undefined; }, onSample() {}, onUnavailable() {} });
  const forged = Object.create(AbortSignal.prototype);
  assert.deepEqual(await forgedConnector.connect({ purpose: 'test', signal: forged }), { ok: false, reason: 'connect-failed' });
  assert.equal(approvals, 0); assert.equal(forgedConnector.status().rawPending, 0); await forgedConnector.close();
  const deniedConnector = createMqttConnector({ endpoint: 'mqtt://127.0.0.1:1', profile: fixture.profile, binding: fixture.binding,
    clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic', authorizeConnection(request) { approvals++; approvedRequest = request; return undefined; }, onSample() {}, onUnavailable() {} });
  assert.deepEqual(await deniedConnector.connect({ purpose: 'test', signal: new AbortController().signal }), { ok: false, reason: 'connect-failed' });
  assert.equal(approvals, 1); assert.ok(approvedRequest);
  assert.equal(approvedRequest.action, 'connect'); assert.equal(approvedRequest.endpoint, 'mqtt://127.0.0.1:1'); assert.equal(approvedRequest.topics.length, 4);
  await deniedConnector.close();
  assert.throws(() => createMqttConnector({ endpoint: 'mqtt://broker.example:1883', profile: fixture.profile, binding: fixture.binding,
    clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic', authorizeConnection() { return undefined; }, onSample() {}, onUnavailable() {} }));
  assert.throws(() => createMqttConnector({ endpoint: 'mqtts://user:secret@broker.example:8883', profile: fixture.profile, binding: fixture.binding,
    clockId: 'mqtt-demo-clock', sourceClockRelation: 'same-process-monotonic', authorizeConnection() { return undefined; }, onSample() {}, onUnavailable() {} }));
  assert.throws(() => createMqttConnector({ endpoint: 'mqtt://127.0.0.1:1', profile: fixture.profile, binding: fixture.binding,
    clockId: 'mqtt-demo-clock', sourceClockRelation: 'independent-process' as never, authorizeConnection() { return undefined; }, onSample() {}, onUnavailable() {} }));
});

test('local MQTT5 broker proves bounded telemetry, independent route grants, command ACK and observed feedback', { timeout: 20000 }, async () => {
  const broker = await startOwnedMqttBroker();
  try {
    const receipt = await runMqttConnectorExample(broker.endpoint);
    assert.equal(receipt.kind, 'local-mqtt5-software-connector');
    assert.equal(receipt.connector.state, 'connected'); assert.equal(receipt.connector.rejectedMessages, 3);
    assert.equal(receipt.producer.effects, 2); assert.equal(receipt.producer.duplicates, 2);
    assert.equal(receipt.producer.publishErrors, 0);
    assert.deepEqual(receipt.commandEvidence, ['observed']); assert.deepEqual(receipt.observedStates, [true, false]);
    assert.equal(broker.version, 'mosquitto version 2.1.2');
  } finally { await broker.close(); }
});
