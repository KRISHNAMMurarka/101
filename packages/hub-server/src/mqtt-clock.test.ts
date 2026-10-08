import assert from 'node:assert/strict';
import test from 'node:test';
import { createMqttClockAuthority, signMqttClockFrame } from './mqtt-clock.ts';

const topics = Object.freeze({ ping: '101/remote/clock/ping', pong: '101/remote/clock/pong',
  source: '101/remote/state/enabled', ack: '101/remote/acks/set-enabled', command: '101/remote/commands/set-enabled' });
const key = Buffer.alloc(32, 7);
const packet = { qos: 1, retain: false, properties: { messageExpiryInterval: 1 } };
const fixedSession = { clientId: '101-test', sessionNonce: 'a'.repeat(32) };

test('signed cross-origin exchange conservatively qualifies source and preserves original deadline', () => {
  let localNow = 1000;
  const owner = new AbortController(), grant = new AbortController();
  const clock = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
    producerClockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, key,
    topics, sourceResourceId: 'enabled', commandResourceId: 'set-enabled', now: () => localNow,
    authorize(request) { return { request, signal: grant.signal, expiresAt: 4000 }; } });
  assert.equal(clock.activate(owner.signal), true);
  assert.equal(clock.qualifySource(topics.source, signMqttClockFrame({ schemaVersion: 1, kind: 'sample', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, resourceId: 'enabled', sequence: 1, sourceAt: 451000, value: true }, key), packet), undefined);
  const ping = clock.beginPing(); assert.ok(ping);
  const nonce = JSON.parse(ping.payload.toString()).nonce;
  localNow = 1010;
  const pong = signMqttClockFrame({ schemaVersion: 1, kind: 'clock-pong', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, nonce, receivedAt: 451003, sentAt: 451004 }, key);
  assert.equal(clock.acceptPong(topics.pong, pong, packet), true);
  assert.equal(clock.acceptPong(topics.pong, pong, packet), false, 'replayed nonce is not an exchange');
  localNow = 1040;
  const source = signMqttClockFrame({ schemaVersion: 1, kind: 'sample', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, resourceId: 'enabled', sequence: 1, sourceAt: 451005, value: true }, key);
  const qualified = clock.qualifySource(topics.source, source, packet);
  assert.ok(qualified); assert.deepEqual(qualified.sourceTime, { clockId: 'remote:boot-1', at: 451005 });
  assert.equal(qualified.translatedAt.localClockId, 'mqtt-host-monotonic');
  assert.ok(qualified.translatedAt.earliest <= qualified.translatedAt.latest);
  assert.ok(qualified.translatedAt.latest <= localNow);
  assert.equal(clock.qualifySource(topics.source, source, packet), undefined, 'signed sequence cannot replay');
  const command = clock.prepareCommand('1', true, 1500); assert.ok(command);
  const body = JSON.parse(command.payload.toString());
  assert.equal(body.originalDeadlineLocal, 1500);
  assert.ok(body.expiresAtRemote < 451500, 'remote deadline is earlier than optimistic point translation');
  grant.abort(); assert.equal(clock.prepareCommand('2', true, 1500), undefined);
  clock.close();
});

test('forged, replayed, stale and unapproved clock evidence grants no source or command', () => {
  let localNow = 1000;
  const owner = new AbortController(), grant = new AbortController();
  const clock = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
    producerClockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, key,
    topics, sourceResourceId: 'enabled', commandResourceId: 'set-enabled', now: () => localNow,
    authorize(request) { return { request, signal: grant.signal, expiresAt: 10000 }; } });
  assert.equal(clock.activate(owner.signal), true);
  const ping = clock.beginPing(); assert.ok(ping);
  const nonce = JSON.parse(ping.payload.toString()).nonce;
  localNow = 1010;
  const pongBody = { schemaVersion: 1, kind: 'clock-pong', producerId: 'enrolled-producer', clockId: 'remote:boot-1',
    keyId: 'fixture-key', ...fixedSession, nonce, receivedAt: 451003, sentAt: 451004 };
  assert.equal(clock.acceptPong(topics.pong, signMqttClockFrame({ ...pongBody, nonce: '0'.repeat(32) }, key), packet), false);
  assert.equal(clock.acceptPong(topics.pong, signMqttClockFrame(pongBody, Buffer.alloc(32, 0)), packet), false);
  assert.equal(clock.acceptPong(topics.pong, signMqttClockFrame(pongBody, key), { ...packet, retain: true }), false);
  assert.equal(clock.acceptPong(topics.pong, signMqttClockFrame(pongBody, key), packet), true);
  localNow = 1040;
  const sampleBody = { schemaVersion: 1, kind: 'sample', producerId: 'enrolled-producer', clockId: 'remote:boot-1',
    keyId: 'fixture-key', ...fixedSession, resourceId: 'enabled', sequence: 1, sourceAt: 451005, value: true };
  const sample = signMqttClockFrame(sampleBody, key);
  assert.equal(clock.qualifySource('101/remote/other', sample, packet), undefined);
  assert.equal(clock.qualifySource(topics.source, sample, { ...packet, retain: true }), undefined);
  assert.equal(clock.qualifySource(topics.source, signMqttClockFrame(sampleBody, Buffer.alloc(32, 0)), packet), undefined);
  assert.equal(clock.qualifySource(topics.source, signMqttClockFrame({ ...sampleBody, sourceAt: 449000 }, key), packet), undefined);
  assert.equal(clock.qualifySource(topics.source, sample, packet)?.value, true);
  assert.equal(clock.prepareCommand('1', true, localNow), undefined, 'original deadline already elapsed');
  localNow = 5900;
  assert.equal(clock.prepareCommand('2', true, 6100), undefined, 'command cannot outlive mapping age');
  localNow = 6100;
  assert.equal(clock.qualifySource(topics.source, signMqttClockFrame({ ...sampleBody, sequence: 2 }, key), packet), undefined,
    'calibration exceeded its age bound');
  assert.equal(clock.prepareCommand('2', true, 6200), undefined);
  grant.abort(); assert.equal(clock.beginPing(), undefined);
  clock.close();
});

test('intrinsic abort and reentrant packet getters cannot extend clock authority', () => {
  let localNow = 1000;
  const owner = new AbortController(), maskedGrant = new AbortController();
  Object.defineProperty(maskedGrant.signal, 'aborted', { configurable: true, get() { return false; } });
  const masked = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
    producerClockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, key, topics, sourceResourceId: 'enabled',
    commandResourceId: 'set-enabled', now: () => localNow,
    authorize(request) { return { request, signal: maskedGrant.signal, expiresAt: 10000 }; } });
  assert.equal(masked.activate(owner.signal), true);
  maskedGrant.abort();
  assert.equal(masked.beginPing(), undefined, 'intrinsically aborted grant cannot be masked by an own getter');
  masked.close();

  const grant = new AbortController();
  const clock = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
    producerClockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, key, topics, sourceResourceId: 'enabled',
    commandResourceId: 'set-enabled', now: () => localNow,
    authorize(request) { return { request, signal: grant.signal, expiresAt: 10000 }; } });
  assert.equal(clock.activate(owner.signal), true);
  const ping = clock.beginPing(); assert.ok(ping);
  const nonce = JSON.parse(ping.payload.toString()).nonce;
  localNow = 1010;
  const pong = signMqttClockFrame({ schemaVersion: 1, kind: 'clock-pong', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, nonce, receivedAt: 451003, sentAt: 451004 }, key);
  assert.equal(clock.acceptPong(topics.pong, pong, { ...packet, get qos(): number { throw new Error('packet-getter'); } }), false);
  const revokingPacket = { ...packet, get qos() { grant.abort(); return 1; } };
  assert.equal(clock.acceptPong(topics.pong, pong, revokingPacket), false, 'packet inspection cannot outlive revocation');
  assert.equal(clock.status().active, false);
  clock.close();

  const sourceGrant = new AbortController();
  const sourceClock = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
    producerClockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, key, topics, sourceResourceId: 'enabled',
    commandResourceId: 'set-enabled', now: () => localNow,
    authorize(request) { return { request, signal: sourceGrant.signal, expiresAt: 10000 }; } });
  assert.equal(sourceClock.activate(owner.signal), true);
  localNow = 1000; const sourcePing = sourceClock.beginPing(); assert.ok(sourcePing);
  const sourceNonce = JSON.parse(sourcePing.payload.toString()).nonce;
  localNow = 1010;
  assert.equal(sourceClock.acceptPong(topics.pong, signMqttClockFrame({ schemaVersion: 1, kind: 'clock-pong',
    producerId: 'enrolled-producer', clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, nonce: sourceNonce,
    receivedAt: 451003, sentAt: 451004 }, key), packet), true);
  localNow = 1040;
  const source = signMqttClockFrame({ schemaVersion: 1, kind: 'sample', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, resourceId: 'enabled', sequence: 1, sourceAt: 451005, value: true }, key);
  const revokingSourcePacket = { ...packet, get retain() { sourceGrant.abort(); return false; } };
  assert.equal(sourceClock.qualifySource(topics.source, source, revokingSourcePacket), undefined);
  sourceClock.close();

  const commandGrant = new AbortController(); let commandCalls = 0, commandRevokeAt = 0;
  const commandClock = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
    producerClockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, key, topics, sourceResourceId: 'enabled',
    commandResourceId: 'set-enabled', now: () => { commandCalls++; if (commandCalls === commandRevokeAt) commandGrant.abort(); return localNow; },
    authorize(request) { return { request, signal: commandGrant.signal, expiresAt: 10000 }; } });
  localNow = 1000; assert.equal(commandClock.activate(owner.signal), true);
  const commandPing = commandClock.beginPing(); assert.ok(commandPing);
  const commandNonce = JSON.parse(commandPing.payload.toString()).nonce;
  localNow = 1010;
  assert.equal(commandClock.acceptPong(topics.pong, signMqttClockFrame({ schemaVersion: 1, kind: 'clock-pong',
    producerId: 'enrolled-producer', clockId: 'remote:boot-1', keyId: 'fixture-key', ...fixedSession, nonce: commandNonce,
    receivedAt: 451003, sentAt: 451004 }, key), packet), true);
  localNow = 1040; commandRevokeAt = commandCalls + 2;
  assert.equal(commandClock.prepareCommand('1', true, 1500), undefined, 'final clock read revoked approval');
  commandClock.close();
});

test('fresh approved session rejects recorded ACK and correlates the current command nonce', () => {
  let localNow = 1000;
  const session = (sessionNonce: string, clientId: string) => {
    const clock = createMqttClockAuthority({ producerId: 'enrolled-producer', localClockId: 'mqtt-host-monotonic',
      producerClockId: 'remote:boot-1', keyId: 'fixture-key', key, topics, sourceResourceId: 'enabled',
      commandResourceId: 'set-enabled', sessionNonce, clientId, now: () => localNow,
      authorize(request) { return { request, signal: new AbortController().signal, expiresAt: 4000 }; } });
    assert.equal(clock.activate(new AbortController().signal), true);
    const ping = clock.beginPing(); assert.ok(ping);
    const pingBody = JSON.parse(ping.payload.toString());
    assert.equal(pingBody.sessionNonce, sessionNonce);
    assert.equal(pingBody.clientId, clientId);
    localNow = 1010;
    const pong = signMqttClockFrame({ schemaVersion: 1, kind: 'clock-pong', producerId: 'enrolled-producer',
      clockId: 'remote:boot-1', keyId: 'fixture-key', clientId, sessionNonce,
      nonce: pingBody.nonce, receivedAt: 451003, sentAt: 451004 }, key);
    assert.equal(clock.acceptPong(topics.pong, pong, packet), true);
    localNow = 1040;
    return clock;
  };
  const first = session('a'.repeat(32), '101-first');
  const firstCommand = first.prepareCommand('1', true, 1500); assert.ok(firstCommand);
  const firstBody = JSON.parse(firstCommand.payload.toString());
  assert.match(firstBody.commandNonce, /^[0-9a-f]{32}$/);
  const oldAck = signMqttClockFrame({ schemaVersion: 1, kind: 'ack', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', clientId: '101-first', sessionNonce: 'a'.repeat(32),
    resourceId: 'set-enabled', commandId: '1', commandNonce: firstBody.commandNonce,
    sequence: 1, sourceAt: 451005 }, key);
  assert.equal(first.qualifySource(topics.ack, oldAck, packet)?.commandId, '1');
  assert.equal(first.prepareCommand('1', true, 1500), undefined, 'issued ID remains a tombstone for this session');
  first.close();
  localNow = 1000;
  const second = session('b'.repeat(32), '101-second');
  const secondCommand = second.prepareCommand('1', true, 1500); assert.ok(secondCommand);
  const secondBody = JSON.parse(secondCommand.payload.toString());
  assert.notEqual(secondBody.commandNonce, firstBody.commandNonce);
  assert.equal(second.qualifySource(topics.ack, oldAck, packet), undefined, 'old signed ACK cannot acknowledge reused ID');
  const currentAck = signMqttClockFrame({ schemaVersion: 1, kind: 'ack', producerId: 'enrolled-producer',
    clockId: 'remote:boot-1', keyId: 'fixture-key', clientId: '101-second', sessionNonce: 'b'.repeat(32),
    resourceId: 'set-enabled', commandId: '1', commandNonce: secondBody.commandNonce,
    sequence: 2, sourceAt: 451005 }, key);
  assert.equal(second.qualifySource(topics.ack, currentAck, packet)?.commandId, '1');
  assert.equal(second.qualifySource(topics.ack, currentAck, packet), undefined);
  second.close();
});
