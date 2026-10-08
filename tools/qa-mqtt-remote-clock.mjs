import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connectAsync } from 'mqtt';
import { pathToFileURL } from 'node:url';
import { createMqttClockAuthority, signMqttClockFrame } from '../packages/hub-server/src/mqtt-clock.ts';
import { REMOTE_CLOCK_ID_PREFIX, REMOTE_CLOCK_TOPICS, REMOTE_KEY_ID, REMOTE_ORIGIN_OFFSET_MS, REMOTE_PRODUCER_ID } from '../examples/mqtt-connector/remote-clock-producer.mjs';
import { startOwnedMqttBroker } from './qa-mqtt-connector.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 3000) {
  const end = performance.now() + timeoutMs;
  while (!predicate()) { assert.ok(performance.now() < end, label); await delay(5); }
}
function childMessage(child, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`producer-${type}-timeout`)); }, timeoutMs);
    const receive = message => {
      if (message?.type === 'error') { cleanup(); reject(new Error(message.reason)); }
      else if (message?.type === type) { cleanup(); resolve(message); }
    };
    const exit = () => { cleanup(); reject(new Error(`producer-exited-before-${type}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); };
    child.on('message', receive); child.once('exit', exit);
  });
}

/** Actual process-separated software proof over one owned disposable loopback MQTT5 broker. */
export async function runMqttRemoteClockQa() {
  const broker = await startOwnedMqttBroker();
  const key = randomBytes(32), owner = new AbortController(), grant = new AbortController();
  const clientId = `101-remote-host-${process.pid}`, sessionNonce = randomBytes(16).toString('hex');
  let client, child, childExited, authority, childLog = '';
  const qualified = [], failures = { rejectedSource: 0, invalidPong: 0 };
  try {
    child = fork(new URL('../examples/mqtt-connector/remote-clock-producer.mjs', import.meta.url), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MQTT_CLOCK_ENDPOINT: broker.endpoint, MQTT_CLOCK_KEY_HEX: key.toString('hex') } });
    child.stdout?.on('data', chunk => { childLog = (childLog + chunk.toString()).slice(-2048); });
    child.stderr?.on('data', chunk => { childLog = (childLog + chunk.toString()).slice(-2048); });
    childExited = new Promise(resolve => child.once('exit', resolve));
    const ready = await childMessage(child, 'ready');
    assert.equal(ready.offsetMs, REMOTE_ORIGIN_OFFSET_MS); assert.notEqual(ready.pid, process.pid);
    assert.ok(ready.clockId.startsWith(REMOTE_CLOCK_ID_PREFIX));
    assert.match(ready.clockId, /^remote:boot-[0-9a-f]{24}$/);
    authority = createMqttClockAuthority({ producerId: REMOTE_PRODUCER_ID, localClockId: 'mqtt-host-monotonic', producerClockId: ready.clockId,
      keyId: REMOTE_KEY_ID, clientId, sessionNonce, key, topics: REMOTE_CLOCK_TOPICS,
      sourceResourceId: 'enabled', commandResourceId: 'set-enabled',
      now: () => performance.now(), authorize(request) {
        assert.equal(request.action, 'mqtt-remote-clock'); assert.equal(request.keyId, REMOTE_KEY_ID);
        assert.equal(request.producerClockId, ready.clockId);
        assert.deepEqual(request.topics.map(topic => topic.topic), Object.values(REMOTE_CLOCK_TOPICS));
        assert.ok(request.topics.every(topic => topic.qos === 1));
        return { request, signal: grant.signal, expiresAt: performance.now() + 10000 };
      } });
    assert.equal(authority.activate(owner.signal), true);
    assert.equal(authority.prepareCommand('1', true, performance.now() + 500), undefined, 'no command before mapping');
    client = await connectAsync(broker.endpoint, { protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0 },
      reconnectPeriod: 0, resubscribe: false, queueQoSZero: false, connectTimeout: 3000,
      clientId });
    const inbound = [REMOTE_CLOCK_TOPICS.pong, REMOTE_CLOCK_TOPICS.source, REMOTE_CLOCK_TOPICS.ack];
    const grants = await client.subscribeAsync(Object.fromEntries(inbound.map(topic => [topic, { qos: 1 }])));
    assert.equal(grants.length, inbound.length); assert.ok(grants.every(row => row.qos === 1 && inbound.includes(row.topic)));
    client.on('message', (topic, payload, packet) => {
      if (topic === REMOTE_CLOCK_TOPICS.pong) { if (!authority.acceptPong(topic, payload, packet)) failures.invalidPong++; return; }
      const admitted = authority.qualifySource(topic, payload, packet);
      if (admitted) qualified.push(admitted); else failures.rejectedSource++;
    });
    const ping = authority.beginPing(); assert.ok(ping);
    await client.publishAsync(ping.topic, ping.payload, { qos: ping.qos, retain: ping.retain,
      properties: { messageExpiryInterval: ping.messageExpiryInterval } });
    await until(() => authority.status().mapped, 'signed cross-process clock pong');
    const sent = childMessage(child, 'sample-sent'); child.send({ type: 'sample' }); await sent;
    await until(() => qualified.some(row => row.kind === 'sample'), 'qualified remote source');
    const firstSample = qualified.find(row => row.kind === 'sample');
    assert.equal(firstSample.sourceTime.clockId, ready.clockId);
    assert.ok(firstSample.sourceTime.at > REMOTE_ORIGIN_OFFSET_MS);
    assert.ok(firstSample.translatedAt.latest <= firstSample.receivedAt);
    const beforeForgery = qualified.length;
    const forged = signMqttClockFrame({ schemaVersion: 1, kind: 'sample', producerId: REMOTE_PRODUCER_ID,
      clockId: ready.clockId, keyId: REMOTE_KEY_ID, clientId, sessionNonce, resourceId: 'enabled', sequence: 900,
      sourceAt: performance.now() + REMOTE_ORIGIN_OFFSET_MS, value: false }, Buffer.alloc(32, 0));
    await client.publishAsync(REMOTE_CLOCK_TOPICS.source, forged, { qos: 1, retain: false,
      properties: { messageExpiryInterval: 1 } });
    await until(() => failures.rejectedSource > 0, 'forged key holder rejected');
    assert.equal(qualified.length, beforeForgery);
    const command = authority.prepareCommand('1', true, performance.now() + 1000); assert.ok(command);
    await client.publishAsync(command.topic, command.payload, { qos: command.qos, retain: command.retain,
      properties: { messageExpiryInterval: command.messageExpiryInterval } });
    await until(() => qualified.some(row => row.kind === 'ack' && row.commandId === '1') &&
      qualified.some(row => row.kind === 'sample' && row.value === true), 'signed ACK and observed state');
    const statusWait = childMessage(child, 'status'); child.send({ type: 'status' }); const producerStatus = (await statusWait).value;
    assert.equal(producerStatus.effects, 1); assert.equal(producerStatus.enabled, true);
    assert.ok(producerStatus.remoteNow - performance.now() > 400000, 'different monotonic origin');
    const late = authority.prepareCommand('2', false, performance.now() + 100); assert.ok(late);
    await delay(150);
    await client.publishAsync(late.topic, late.payload, { qos: late.qos, retain: late.retain,
      properties: { messageExpiryInterval: late.messageExpiryInterval } });
    await delay(50);
    const afterWait = childMessage(child, 'status'); child.send({ type: 'status' }); const afterLate = (await afterWait).value;
    assert.equal(afterLate.effects, 1, 'producer enforced original remote expiry before effect');
    assert.ok(afterLate.rejected > producerStatus.rejected);
    grant.abort(); assert.equal(authority.prepareCommand('3', false, performance.now() + 500), undefined);
    return Object.freeze({ kind: 'separate-process-mqtt-clock-software-proof', broker: broker.version,
      producerPid: ready.pid, producerClockId: ready.clockId, hostPid: process.pid, remoteOriginOffsetMs: REMOTE_ORIGIN_OFFSET_MS,
      qualifiedSamples: qualified.filter(row => row.kind === 'sample').length,
      qualifiedAcks: qualified.filter(row => row.kind === 'ack').length, rejectedSource: failures.rejectedSource,
      effects: afterLate.effects, lateRejected: true, sameProcessClockAssumption: false,
      authorship: 'enrolled HMAC key holder only; anonymous loopback broker supplies no physical device identity',
      physicalDevice: 'not tested', remoteBroker: 'not tested' });
  } catch (error) {
    let producerStatus;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { const waiting = childMessage(child, 'status', 500); child.send({ type: 'status' }); producerStatus = (await waiting).value; } catch { /* diagnostic only */ }
    }
    throw new Error(`${error instanceof Error ? error.message : 'remote-clock-qa-failed'} ${JSON.stringify({
      qualified: qualified.map(row => ({ kind: row.kind, resourceId: row.resourceId, commandId: row.commandId, value: row.value })),
      failures, producerStatus, childLog })}`);
  }
  finally {
    owner.abort(); grant.abort(); authority?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const closing = childMessage(child, 'unused', 500).catch(() => undefined);
      child.send({ type: 'close' });
      await Promise.race([childExited, closing]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([childExited, delay(1000)]); }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await childExited; }
    }
    await client?.endAsync(true); await broker.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runMqttRemoteClockQa())); }
  catch (error) { console.error(JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : 'remote-clock-qa-failed' })); process.exitCode = 1; }
}
