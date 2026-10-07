import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '@101/pairing';
import { pointerSourceDescriptor } from '@101/device-web';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';
import { createHttpsCoordinator, createCoordinatorFetcher } from './https-coordinator.ts';
import { createPrivateDirectoryClient } from '@101/hub-server';
import { createCoordinatorDirectory } from './private-directory.ts';
import type { CoordinatorDirectoryAuthority } from './private-directory.ts';

const owners = [{ principalId: 'host-a', deviceId: 'device-host-a' }, { principalId: 'peer-a', deviceId: 'device-peer-a' },
  { principalId: 'peer-b', deviceId: 'device-peer-b' }];
const peers = new Map([['owner', 1], ['reader', 1]]);
const host = (overrides: Partial<CoordinatorDirectoryAuthority> = {}): CoordinatorDirectoryAuthority => ({ sessionId: 'ROOM101',
  ...owners[0]!, role: 'host', generation: 0, now: 1000, expiresAt: 61000, peers, current: () => true, ...overrides });
const owner = (overrides: Partial<CoordinatorDirectoryAuthority> = {}): CoordinatorDirectoryAuthority => host({ ...owners[1]!, role: 'peer', peerId: 'owner', generation: 1, ...overrides });
const reader = (overrides: Partial<CoordinatorDirectoryAuthority> = {}): CoordinatorDirectoryAuthority => host({ ...owners[2]!, role: 'peer', peerId: 'reader', generation: 1, ...overrides });
const publication = (revision = 1, expiresAt = 5000, generation = 1) => ({ generation,
  descriptor: { ...pointerSourceDescriptor('node'), id: 'device-peer-a', revision, metadata: { private: 'never-export' } },
  capabilityIds: ['position'], expiresAt, consent: true as const });

test('peer publication projects selected metadata and every accepted descriptor update retires old visibility', () => {
  const store = createCoordinatorDirectory(undefined, owners), input = publication();
  store.dispatch(owner(), 'POST', ['publication'], input); input.descriptor.label = 'changed';
  assert.deepEqual(store.dispatch(owner(), 'GET', []).body!.resources, []);
  assert.deepEqual(store.dispatch(reader(), 'GET', []).body!.resources, []);
  assert.equal(store.dispatch(host(), 'GET', []).body!.resources[0]!.label, 'Touch surface');
  store.dispatch(host(), 'PUT', ['members', 'reader'], { resourceIds: ['device-peer-a'], expiresAt: 4000 });
  const seen = store.dispatch(reader(), 'GET', []).body!;
  assert.deepEqual(seen.resources[0]!.capabilities.map(value => value.id), ['position']);
  assert.equal(JSON.stringify(seen).includes('never-export'), false);
  assert.throws(() => store.dispatch(owner(), 'PUT', ['publication'], publication(2, 5001)));
  assert.throws(() => store.dispatch(owner(), 'PUT', ['publication'], publication(1)));
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], publication(2)));
  assert.equal(store.dispatch(reader(), 'GET', []).body!.resources[0]!.revision, 1, 'rejected changes preserve original visibility');
  store.dispatch(owner(), 'PUT', ['publication'], { ...publication(2), capabilityIds: ['contact'] });
  assert.deepEqual(store.dispatch(reader(), 'GET', []).body!.resources, []);
  store.dispatch(host(), 'PUT', ['members', 'reader'], { resourceIds: ['device-peer-a'], expiresAt: 4000 });
  assert.deepEqual(store.dispatch(reader(), 'GET', []).body!.resources[0]!.capabilities.map(value => value.id), ['contact']);
  assert.equal(store.dispatch(reader(), 'GET', []).body!.resources[0]!.revision, 2);
});

test('revision-pinned removal, expiry, owner generation loss and departure revoke visibility without restoring old publications', () => {
  const store = createCoordinatorDirectory(undefined, owners);
  store.dispatch(owner(), 'POST', ['publication'], publication());
  const grant = (authority = host(), expiresAt = 5000) => store.dispatch(authority, 'PUT', ['members', 'reader'], { resourceIds: ['device-peer-a'], expiresAt });
  grant();
  assert.throws(() => store.dispatch(owner(), 'DELETE', ['publication', '1', '2']));
  assert.equal(store.dispatch(reader(), 'GET', []).body!.resources.length, 1);
  store.dispatch(owner(), 'DELETE', ['publication', '1', '1']);
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], publication()));
  store.dispatch(owner(), 'POST', ['publication'], publication(2));
  assert.deepEqual(store.dispatch(reader(), 'GET', []).body!.resources, []);
  grant();
  assert.deepEqual(store.dispatch(reader({ now: 5000 }), 'GET', []).body!.resources, []);
  assert.throws(() => store.dispatch(owner({ now: 5000 }), 'POST', ['publication'], publication(2, 6000)));
  store.dispatch(owner({ now: 5000 }), 'POST', ['publication'], publication(3, 6000));
  grant(host({ now: 5000 }), 6000);
  const nextPeers = new Map([['owner', 2], ['reader', 1]]);
  assert.deepEqual(store.dispatch(reader({ now: 5000, peers: nextPeers }), 'GET', []).body!.resources, []);
  assert.throws(() => store.dispatch(owner({ now: 5000, peers: nextPeers, generation: 2 }), 'POST', ['publication'], publication(4, 6000, 1)));
  store.dispatch(owner({ now: 5000, peers: nextPeers, generation: 2 }), 'POST', ['publication'], publication(1, 6000, 2));
  grant(host({ now: 5000, peers: nextPeers }), 6000);
  store.retirePeer('ROOM101', 'owner');
  assert.deepEqual(store.dispatch(reader({ now: 5000, peers: nextPeers }), 'GET', []).body!.resources, []);
  assert.throws(() => store.dispatch(host({ now: 5000, peers: nextPeers }), 'PUT', ['members', 'reader'], { resourceIds: ['device-peer-a'], expiresAt: 6000 }));
});

test('publication rejects non-enrolled owners, cross-device descriptors, stale generation and a retiring currentness callback', () => {
  const store = createCoordinatorDirectory(undefined, owners);
  for (const authority of [owner({ principalId: 'claimed' }), owner({ generation: 2 }), owner({ current: () => false })])
    assert.throws(() => store.dispatch(authority, 'POST', ['publication'], publication()));
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], { ...publication(), descriptor: { ...publication().descriptor, id: 'device-peer-b' } }));
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], { ...publication(), principalId: 'host-a' }));
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], publication(1, 61001)));
  let checks = 0;
  assert.throws(() => store.dispatch(owner({ current() { if (++checks === 2) store.retirePeer('ROOM101', 'owner'); return true; } }), 'POST', ['publication'], publication()));
  assert.deepEqual(store.dispatch(host(), 'GET', []).body!.resources, []);
});

test('peer publications reserve bounded current rows and revision floors while the provisioned catalog stays compatible', () => {
  const catalog = Array.from({ length: 16 }, (_, index) => ({ ...owners[0]!, descriptor: { ...pointerSourceDescriptor('node'), id: `catalog-${index}` }, capabilityIds: ['position'] }));
  const store = createCoordinatorDirectory(catalog, owners);
  for (const item of catalog) store.dispatch(host(), 'POST', ['resources'], { resourceId: item.descriptor.id, expiresAt: 5000 });
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], publication()));
  store.dispatch(host(), 'DELETE', ['resources', 'catalog-0']);
  store.dispatch(owner(), 'POST', ['publication'], publication());
  assert.equal(store.dispatch(host(), 'GET', []).body!.resources.length, 16);
  store.dispatch(host(), 'DELETE', ['resources', 'device-peer-a']);
  assert.throws(() => store.dispatch(owner(), 'POST', ['publication'], publication()), 'host removal retains the stale revision floor');
  const enrollments = Array.from({ length: 9 }, (_, index) => ({ principalId: `p${index}`, deviceId: `d${index}` }));
  const livePeers = new Map(enrollments.map(value => [value.principalId, 1])), bounded = createCoordinatorDirectory(undefined, enrollments);
  for (let index = 0; index < 8; index++) {
    const identity = enrollments[index]!, authority = owner({ ...identity, peerId: identity.principalId, peers: livePeers });
    bounded.dispatch(authority, 'POST', ['publication'], { ...publication(), descriptor: { ...publication().descriptor, id: identity.deviceId } });
    bounded.dispatch(authority, 'DELETE', ['publication', '1', '1']);
  }
  assert.throws(() => bounded.dispatch(owner({ ...enrollments[8]!, peerId: 'p8', peers: livePeers }), 'POST', ['publication'],
    { ...publication(), descriptor: { ...publication().descriptor, id: 'd8' } }));
  bounded.retirePeer('ROOM101', 'p0');
  bounded.dispatch(owner({ ...enrollments[8]!, peerId: 'p8', peers: livePeers }), 'POST', ['publication'],
    { ...publication(), descriptor: { ...publication().descriptor, id: 'd8' } });
});

test('an enrolled current peer can explicitly publish its actual software descriptor over native mTLS', async () => {
  const fixture = createCoordinatorFixtures(), origin = 'https://directory-peer.example';
  const coordinator = createHttpsCoordinator({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, allowedOrigins: [origin], enrollments: fixture.clients.slice(0, 4).map(({ principalId, deviceId, certificatePem }) =>
      ({ principalId, deviceId, certificatePem })), port: 0 });
  const callers: ReturnType<typeof createCoordinatorFetcher>[] = [];
  try {
    const endpoint = await coordinator.start();
    const caller = (index: number) => { const value = createCoordinatorFetcher({ endpoint, origin, caCertificatePem: fixture.ca,
      certificatePem: fixture.clients[index]!.certificatePem, privateKeyPem: fixture.clients[index]!.privateKeyPem }); callers.push(value); return value; };
    const host = caller(0), owner = caller(2);
    const session = await createHttpSignalingSession(endpoint, 'PEER-DIRECTORY101', { fetcher: host.fetch });
    const signaling = new HttpControllerSignalingClient(session.ticket, owner.fetch);
    const lease = await signaling.join({ deviceId: fixture.clients[2]!.deviceId, label: 'Owner', capabilities: { touch: true } });
    const response = await owner.fetch(`${endpoint}/v1/sessions/${session.ticket.sessionId}/peers/${lease.peerId}/directory/publication`, {
      method: 'POST', headers: { Authorization: `Bearer ${lease.peerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation: lease.generation, descriptor: { ...pointerSourceDescriptor('node'), id: fixture.clients[2]!.deviceId },
        capabilityIds: ['position'], expiresAt: Date.now() + 5000, consent: true }) });
    assert.equal(response.status, 201, 'current enrolled descriptor publication must succeed');
  } finally { callers.forEach(value => value.close()); await coordinator.stop(); fixture.close(); }
});

test('public native mTLS caller binds owner identity and generation, separates recipient grants, and retires changed or lost publications', async () => {
  const fixture = createCoordinatorFixtures(), origin = 'https://directory-peer.example';
  const coordinator = createHttpsCoordinator({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, allowedOrigins: [origin], enrollments: fixture.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) =>
      ({ principalId, deviceId, certificatePem })), port: 0 });
  const callers: { close(): void }[] = [];
  try {
    const endpoint = await coordinator.start();
    const credential = (index: number) => ({ endpoint, origin, caCertificatePem: fixture.ca,
      certificatePem: fixture.clients[index]!.certificatePem, privateKeyPem: fixture.clients[index]!.privateKeyPem });
    const fetchers = [0, 1, 2, 3, 4].map(index => createCoordinatorFetcher(credential(index))); callers.push(...fetchers);
    const session = await createHttpSignalingSession(endpoint, 'PEER-LIFECYCLE101', { fetcher: fetchers[0]!.fetch });
    const otherSession = await createHttpSignalingSession(endpoint, 'PEER-LIFECYCLE202', { fetcher: fetchers[1]!.fetch });
    const join = async (index: number) => {
      const signaling = new HttpControllerSignalingClient(session.ticket, fetchers[index]!.fetch);
      const lease = await signaling.join({ deviceId: fixture.clients[index]!.deviceId, label: 'host-a is a display claim', capabilities: { touch: true } });
      const directory = createPrivateDirectoryClient({ ...credential(index), sessionId: session.ticket.sessionId, role: 'peer', token: lease.peerToken, peerId: lease.peerId });
      callers.push(directory); return { signaling, lease, directory };
    };
    const publisher = await join(2), recipient = await join(3), denied = await join(4);
    const hostDirectory = createPrivateDirectoryClient({ ...credential(0), sessionId: session.ticket.sessionId, role: 'host', token: session.hostToken }); callers.push(hostDirectory);
    const expiry = Date.now() + 5000;
    const request = (revision = 1, expiresAt = expiry, generation = publisher.lease.generation) => ({ generation,
      descriptor: { ...pointerSourceDescriptor('node'), id: fixture.clients[2]!.deviceId, revision, metadata: { private: { a: { b: { c: { d: { e: { f: 'excluded-owner-detail' } } } } } } } },
      capabilityIds: ['position'], expiresAt, consent: true as const });
    await publisher.directory.publish(request());
    assert.deepEqual((await publisher.directory.list()).resources, []);
    assert.deepEqual((await recipient.directory.list()).resources, []);
    const ownPath = `/v1/sessions/${session.ticket.sessionId}/peers/${publisher.lease.peerId}/directory/publication`;
    const raw = (index: number, path: string, body: unknown, token = publisher.lease.peerToken) => fetchers[index]!.fetch(endpoint + path,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await raw(3, ownPath, request(2))).status, 404, 'copied bearer lacks enrolled owner authority');
    assert.equal((await raw(2, ownPath.replace(session.ticket.sessionId, otherSession.ticket.sessionId), request(2))).status, 404);
    assert.equal((await raw(2, ownPath, { ...request(2), principalId: 'host-a' })).status, 404);
    await assert.rejects(() => publisher.directory.update({ ...request(2), descriptor: { ...request(2).descriptor, id: fixture.clients[3]!.deviceId } }));
    await assert.rejects(() => hostDirectory.publish(request(2)));
    await assert.rejects(() => recipient.directory.allow(publisher.lease.peerId, [fixture.clients[2]!.deviceId], expiry));
    await hostDirectory.allow(recipient.lease.peerId, [fixture.clients[2]!.deviceId], expiry);
    const received = await recipient.directory.list();
    assert.equal(received.resources[0]!.id, fixture.clients[2]!.deviceId);
    assert.deepEqual(received.resources[0]!.capabilities.map(value => value.id), ['position']);
    for (const text of ['excluded-owner-detail', 'permissions', 'principalId', session.hostToken, publisher.lease.peerToken]) assert.equal(JSON.stringify(received).includes(text), false);
    assert.deepEqual((await denied.directory.list()).resources, []);
    await assert.rejects(() => publisher.directory.update(request(2, expiry + 1)));
    await publisher.directory.update({ ...request(2), capabilityIds: ['contact'] });
    assert.deepEqual((await recipient.directory.list()).resources, []);
    await assert.rejects(() => publisher.directory.unpublish(publisher.lease.generation, 1));
    await hostDirectory.allow(recipient.lease.peerId, [fixture.clients[2]!.deviceId], expiry);
    assert.deepEqual((await recipient.directory.list()).resources[0]!.capabilities.map(value => value.id), ['contact']);
    await publisher.directory.unpublish(publisher.lease.generation, 2);
    await assert.rejects(() => publisher.directory.publish(request(2)));
    await publisher.directory.publish(request(3));
    assert.deepEqual((await recipient.directory.list()).resources, []);
    await hostDirectory.allow(recipient.lease.peerId, [fixture.clients[2]!.deviceId], expiry);
    const replacement = await publisher.signaling.requestReconnect(publisher.lease);
    assert.deepEqual((await recipient.directory.list()).resources, []);
    await assert.rejects(() => publisher.directory.publish(request(4)), 'stale generation cannot republish after reconnect');
    const shortExpiry = Date.now() + 250;
    await publisher.directory.publish(request(1, shortExpiry, replacement.generation));
    await hostDirectory.allow(recipient.lease.peerId, [fixture.clients[2]!.deviceId], expiry);
    const shortSnapshot = await recipient.directory.list();
    assert.equal(shortSnapshot.resources[0]!.expiresAt, shortExpiry);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, shortExpiry - Date.now() + 30)));
    assert.deepEqual((await recipient.directory.list()).resources, []);
    await publisher.directory.publish(request(2, expiry, replacement.generation));
    await hostDirectory.allow(recipient.lease.peerId, [fixture.clients[2]!.deviceId], expiry);
    await publisher.signaling.leave(replacement);
    assert.deepEqual((await recipient.directory.list()).resources, []);
    await assert.rejects(() => publisher.directory.publish(request(3, expiry, replacement.generation)));
  } finally { callers.forEach(value => value.close()); await coordinator.stop(); fixture.close(); }
});
