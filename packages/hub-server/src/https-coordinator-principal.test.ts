import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, type TLSSocket } from 'node:tls';
import { connect as connectTcp } from 'node:net';
import { createHttpsCoordinator, createCoordinatorFetcher } from '@101/hub-server';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';

const origin = 'https://principal-capacity.example';
const fixtures = createCoordinatorFixtures();
process.once('exit', () => fixtures.close());
const configuration = () => ({ serverCertificatePem: fixtures.server.certificatePem, serverPrivateKeyPem: fixtures.server.privateKeyPem,
  clientCaCertificatePem: fixtures.ca, allowedOrigins: [origin], port: 0,
  enrollments: fixtures.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) });
function caller(endpoint: string, index: number) {
  return createCoordinatorFetcher({ endpoint, origin, caCertificatePem: fixtures.ca,
    certificatePem: fixtures.clients[index]!.certificatePem, privateKeyPem: fixtures.clients[index]!.privateKeyPem });
}
async function health(client: ReturnType<typeof caller>, endpoint: string) {
  try { return (await client.fetch(endpoint + '/v1/health')).status; } catch { return 'refused' as const; }
}
interface OwnedSocket { readonly socket: TLSSocket; readonly closed: Promise<void>; readonly ready: Promise<boolean> }
function openSocket(endpoint: string, credential: { certificatePem: string; privateKeyPem: string } | null = fixtures.clients[0]!): OwnedSocket {
  const url = new URL(endpoint);
  const socket = connect({ host: url.hostname, port: Number(url.port), ca: fixtures.ca,
    cert: credential?.certificatePem, key: credential?.privateKeyPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  const ready = new Promise<boolean>(resolve => {
    socket.once('secureConnect', () => resolve(true)); socket.once('error', () => resolve(false)); socket.once('close', () => resolve(false));
  });
  socket.setTimeout(5000, () => socket.destroy());
  return { socket, closed, ready };
}
function socketHealth(owned: OwnedSocket, endpoint: string): Promise<number | 'refused'> {
  const socket = owned.socket;
  if (socket.destroyed) return Promise.resolve('refused');
  return new Promise(resolve => {
    let bytes = '';
    const complete = (result: number | 'refused') => { socket.off('data', read); socket.off('close', lost); socket.off('error', lost); resolve(result); };
    const lost = () => complete('refused');
    const read = (chunk: Buffer) => {
      bytes += chunk.toString('utf8');
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headers = bytes.slice(0, end), length = /\r\nContent-Length: (\d+)/i.exec(headers);
      if (!length || Buffer.byteLength(bytes.slice(end + 4)) < Number(length[1])) return;
      complete(Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1]));
    };
    socket.on('data', read); socket.once('close', lost); socket.once('error', lost);
    socket.write(`GET /v1/health HTTP/1.1\r\nHost: ${new URL(endpoint).host}\r\nOrigin: ${origin}\r\nConnection: keep-alive\r\n\r\n`);
  });
}
async function destroySockets(sockets: readonly OwnedSocket[]) {
  sockets.forEach(owned => owned.socket.destroy()); await Promise.all(sockets.map(owned => owned.closed));
}

test('held authenticated channels count before HTTP and cannot exclude another enrolled principal', { timeout: 15000 }, async t => {
  const coordinator = createHttpsCoordinator(configuration());
  const endpoint = await coordinator.start();
  const sockets = Array.from({ length: 32 }, () => openSocket(endpoint));
  const other = caller(endpoint, 1);
  try {
    await Promise.all(sockets.map(owned => owned.ready));
    // All A channels remain owned and idle here; B is attempted before any A HTTP input.
    const otherOutcome = await health(other, endpoint);
    const outcomes = await Promise.all(sockets.map(owned => socketHealth(owned, endpoint)));
    const result = { admittedA: outcomes.filter(status => status === 200).length, refusedA: outcomes.filter(status => status === 'refused').length,
      otherOutcome };
    t.diagnostic(JSON.stringify(result));
    assert.deepEqual(result, { admittedA: 4, refusedA: 28, otherOutcome: 200 });
  } finally { other.close(); await destroySockets(sockets); await coordinator.stop(); }
});

test('HTTP reuse counts one channel and real close restores a public caller slot', { timeout: 10000 }, async () => {
  const coordinator = createHttpsCoordinator(configuration()); const endpoint = await coordinator.start();
  const sockets = [openSocket(endpoint)]; const same = caller(endpoint, 0), other = caller(endpoint, 1);
  try {
    await sockets[0]!.ready;
    for (let index = 0; index < 8; index++) assert.equal(await socketHealth(sockets[0]!, endpoint), 200);
    sockets.push(...Array.from({ length: 3 }, () => openSocket(endpoint))); await Promise.all(sockets.map(owned => owned.ready));
    assert.equal(await health(same, endpoint), 'refused'); assert.equal(await health(other, endpoint), 200);
    sockets[0]!.socket.end(); await sockets[0]!.closed;
    assert.equal(await health(same, endpoint), 200);
  } finally { same.close(); other.close(); await destroySockets(sockets); await coordinator.stop(); }
});

test('several enrolled principals each retain their own four idle TLS channels', { timeout: 10000 }, async () => {
  const coordinator = createHttpsCoordinator(configuration()); const endpoint = await coordinator.start();
  const sockets = fixtures.clients.slice(0, 5).flatMap(credential => Array.from({ length: 4 }, () => openSocket(endpoint, credential)));
  const extras = fixtures.clients.slice(0, 5).map((_, index) => caller(endpoint, index));
  try {
    await Promise.all(sockets.map(owned => owned.ready));
    assert.deepEqual(await Promise.all(extras.map(client => health(client, endpoint))), Array(5).fill('refused'));
    assert.deepEqual(await Promise.all(sockets.map(owned => socketHealth(owned, endpoint))), Array(20).fill(200));
  } finally { extras.forEach(client => client.close()); await destroySockets(sockets); await coordinator.stop(); }
});

test('unknown CA credentials retain HTTP 401 and invalid credentials acquire no authenticated slot', { timeout: 15000 }, async () => {
  const coordinator = createHttpsCoordinator(configuration()); const endpoint = await coordinator.start();
  const untrusted = createCoordinatorFixtures();
  const unknown = Array.from({ length: 6 }, () => openSocket(endpoint, fixtures.clients[5]));
  const invalid = [openSocket(endpoint, null), openSocket(endpoint, fixtures.expiredClient), openSocket(endpoint, untrusted.clients[0])];
  const known = Array.from({ length: 4 }, () => openSocket(endpoint));
  const sockets = [...unknown, ...invalid, ...known];
  try {
    await Promise.all(sockets.map(owned => owned.ready));
    assert.deepEqual(await Promise.all(unknown.map(owned => socketHealth(owned, endpoint))), Array(6).fill(401));
    assert.deepEqual(await Promise.all(invalid.map(owned => socketHealth(owned, endpoint))), Array(3).fill('refused'));
    assert.deepEqual(await Promise.all(known.map(owned => socketHealth(owned, endpoint))), Array(4).fill(200));
  } finally { await destroySockets(sockets); await coordinator.stop(); untrusted.close(); }
});

test('the global raw connection ceiling still applies before TLS identity is available', { timeout: 10000 }, async () => {
  const coordinator = createHttpsCoordinator(configuration()); const endpoint = await coordinator.start(); const url = new URL(endpoint);
  const sockets = Array.from({ length: 32 }, () => {
    const socket = connectTcp({ host: url.hostname, port: Number(url.port) });
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    const ready = new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.on('error', () => {}); return { socket, closed, ready };
  });
  const client = caller(endpoint, 0);
  try {
    await Promise.all(sockets.map(owned => owned.ready));
    assert.equal(await health(client, endpoint), 'refused');
    sockets[0]!.socket.end(); await sockets[0]!.closed;
    assert.equal(await health(client, endpoint), 200);
  } finally { client.close(); sockets.forEach(owned => owned.socket.destroy()); await Promise.all(sockets.map(owned => owned.closed)); await coordinator.stop(); }
});

test('Stop settles all owned idle and saturated channels without reopening authority', { timeout: 10000 }, async () => {
  const coordinator = createHttpsCoordinator(configuration()); const endpoint = await coordinator.start();
  const sockets = Array.from({ length: 32 }, () => openSocket(endpoint));
  try {
    await Promise.all(sockets.map(owned => owned.ready));
    const stopped = coordinator.stop();
    await Promise.all([stopped, ...sockets.map(owned => owned.closed)]);
    assert.ok(sockets.every(owned => owned.socket.destroyed));
    await assert.rejects(() => coordinator.start(), /closed/);
  } finally { await destroySockets(sockets); await coordinator.stop(); }
});


test('unenrolled TLS channels share the global raw budget without displacing an admitted incumbent', { timeout: 10000 }, async t => {
  const { HTTPS_COORDINATOR_LIMITS } = await import('@101/hub-server');
  const { channel } = await import('node:diagnostics_channel');
  const connections: { socket: import('node:net').Socket; closed: Promise<void> }[] = [];
  const created = channel('net.client.socket');
  const observe = (message: unknown) => {
    const socket = (message as { socket: import('node:net').Socket }).socket;
    connections.push({ socket, closed: new Promise<void>(resolve => socket.once('close', () => resolve())) });
  };
  const coordinator = createHttpsCoordinator(configuration());
  const endpoint = await coordinator.start();
  const sockets: OwnedSocket[] = [], client = caller(endpoint, 1);
  created.subscribe(observe);
  try {
    const incumbent = openSocket(endpoint); sockets.push(incumbent);
    assert.equal(await incumbent.ready, true); assert.equal(await socketHealth(incumbent, endpoint), 200);
    const unenrolled = Array.from({ length: HTTPS_COORDINATOR_LIMITS.connections - 1 }, () => openSocket(endpoint, fixtures.clients[5]!));
    sockets.push(...unenrolled);
    assert.deepEqual(await Promise.all(unenrolled.map(owned => owned.ready)), Array(unenrolled.length).fill(true));
    assert.ok(unenrolled.every(owned => !owned.socket.destroyed && owned.socket.authorized && owned.socket.getProtocol() === 'TLSv1.3'));
    assert.equal(sockets.length, HTTPS_COORDINATOR_LIMITS.connections);
    assert.equal(await health(client, endpoint), 'refused');
    assert.equal(await socketHealth(incumbent, endpoint), 200, 'An existing admitted channel remains usable while aggregate raw capacity is full');
    assert.ok(unenrolled.every(owned => !owned.socket.destroyed));
    unenrolled[0]!.socket.end(); await unenrolled[0]!.closed;
    assert.equal(await health(client, endpoint), 200, 'Only actual native close of one resident channel restores the next supported caller slot');
    assert.equal(await socketHealth(incumbent, endpoint), 200);
    t.diagnostic(JSON.stringify({ globalRawCeiling: HTTPS_COORDINATOR_LIMITS.connections,
      incumbentAdmittedChannels: 1, unenrolledValidCaTlsChannels: unenrolled.length,
      overflowPublicCaller: 'refused', incumbentStillServes: true, releasedUnenrolledNativeClose: true,
      freshPublicCallerAfterRelease: 200, tlsVersion: 'TLSv1.3', forcedTlsResumption: false,
      scope: 'Actual selected loopback native TLS coordinator/public caller admission; no handshake CPU fairness, OS-wide DoS, remote network or whole S11 qualification.' }));
  } finally {
    created.unsubscribe(observe); client.close(); await destroySockets(sockets); await coordinator.stop();
    await Promise.all(connections.map(value => value.closed));
    assert.ok(connections.every(value => value.socket.destroyed));
    t.diagnostic(JSON.stringify({ ownedNativeClientSockets: connections.length, allOwnedNativeClientClosesJoined: true, coordinatorStopped: true }));
  }
});
