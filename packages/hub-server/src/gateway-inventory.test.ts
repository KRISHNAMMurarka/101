import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, createServer, type Server } from 'node:https';
import type { ClientRequest, RequestOptions } from 'node:http';
import { X509Certificate, createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { channel } from 'node:diagnostics_channel';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';
import { createHttpsCoordinator, createCoordinatorFetcher } from './https-coordinator.ts';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '../../pairing/src/index.ts';
import type { GatewayInventoryOptions, GatewayInventoryConnector, GatewayInventoryApprovalRequest } from './gateway-inventory.ts';

const api = await import('./gateway-inventory.ts').catch(() => undefined);

test('a selected gateway inventory needs a public read-only connector with current owner approval', () => {
  assert.equal(typeof api?.createGatewayInventoryConnector, 'function', 'Missing explicitly authorized inventory connector');
});

const fixture = createCoordinatorFixtures();
process.once('exit', () => fixture.close());
const origin = 'https://owned-gateway-inventory.example';
const pin = createHash('sha256').update(new X509Certificate(fixture.server.certificatePem).raw).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const end = performance.now() + 2000; while (!check()) { assert.ok(performance.now() < end); await pause(5); } }
function options(endpoint: string, signal: AbortSignal, authorizeInventory: GatewayInventoryOptions['authorizeInventory']): GatewayInventoryOptions {
  return { endpoint, origin, caCertificatePem: fixture.ca, certificatePem: fixture.clients[2]!.certificatePem,
    privateKeyPem: fixture.clients[2]!.privateKeyPem, serverCertificateSha256: pin, ownerId: 'owned-operator', gatewayId: 'owned-gateway',
    sessionId: 'GATEWAY-INVENTORY101', peerId: 'peer-a', token: 'a'.repeat(48), signal, authorizeInventory };
}
async function directory() {
  const coordinator = createHttpsCoordinator({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, allowedOrigins: [origin], enrollments: fixture.clients.slice(0, 3).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })), port: 0 });
  const endpoint = await coordinator.start();
  const caller = (index: number) => createCoordinatorFetcher({ endpoint, origin, caCertificatePem: fixture.ca,
    certificatePem: fixture.clients[index]!.certificatePem, privateKeyPem: fixture.clients[index]!.privateKeyPem });
  const host = caller(0), peer = caller(2);
  const session = await createHttpSignalingSession(endpoint, 'GATEWAY-INVENTORY101', { fetcher: host.fetch });
  const signaling = new HttpControllerSignalingClient(session.ticket, peer.fetch);
  const lease = await signaling.join({ deviceId: fixture.clients[2]!.deviceId, label: 'Inert display claim', capabilities: { touch: true } });
  return { endpoint, lease, close: async () => { host.close(); peer.close(); await coordinator.stop(); } };
}
async function negativeServer(reply: (response: import('node:http').ServerResponse) => void, credentials = fixture.server) {
  let requests = 0, authorization = '', path = '', method = '';
  const sockets = new Set<Duplex>();
  const server: Server = createServer({ key: credentials.privateKeyPem, cert: credentials.certificatePem, ca: fixture.ca,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, (request, response) => {
    requests++; authorization = request.headers.authorization ?? ''; path = request.url ?? ''; method = request.method ?? ''; reply(response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { endpoint: 'https://127.0.0.1:' + address.port, requests: () => requests, headers: () => ({ authorization, path, method }), sockets,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('construction and denied approval dispatch no native inventory request', async () => {
  assert.ok(api); const host = await directory(), owner = new AbortController();
  let requests = 0; const events = channel('http.client.request.start'), observe = () => { requests++; }; events.subscribe(observe);
  const connector = api.createGatewayInventoryConnector(options(host.endpoint, owner.signal, () => undefined));
  try {
    assert.equal(requests, 0); assert.equal((await connector.list({ purpose: 'review-inventory', signal: owner.signal })).ok, false);
    assert.equal(requests, 0); assert.equal(connector.status().rawPending, 0);
  } finally { await connector.close(); events.unsubscribe(observe); await host.close(); }
});

test('actual current mTLS directory returns only inert scoped metadata after exact owner approval', async () => {
  assert.ok(api); const host = await directory(), owner = new AbortController(), grant = new AbortController();
  let approved: GatewayInventoryApprovalRequest | undefined;
  const config = { ...options(host.endpoint, owner.signal, request => {
    approved = request; assert.ok(Object.isFrozen(request)); assert.equal(request.method, 'GET'); assert.equal(request.action, 'list');
    return { request, signal: grant.signal, expiresAt: performance.now() + 1500 };
  }), peerId: host.lease.peerId, token: host.lease.peerToken };
  const connector = api.createGatewayInventoryConnector(config); config.token = 'b'.repeat(48);
  try {
    const result = await connector.list({ purpose: 'review-inventory', signal: owner.signal }); assert.ok(result.ok);
    assert.equal(result.value.snapshot.scope.id, 'GATEWAY-INVENTORY101'); assert.deepEqual(result.value.snapshot.resources, []);
    assert.deepEqual(result.value.candidates, []); assert.equal(approved?.serverCertificateSha256, pin);
    assert.equal(approved?.peerId, host.lease.peerId); assert.equal(approved?.purpose, 'review-inventory');
    assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0);
    for (const secret of [host.lease.peerToken, fixture.clients[2]!.privateKeyPem, fixture.clients[2]!.certificatePem]) assert.ok(!JSON.stringify(result).includes(secret));
  } finally { await connector.close(); await host.close(); }
});

test('authorization reentry reserves the slot and cancellation before dispatch sends zero requests', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController();
  let nested: Promise<unknown> | undefined;
  const connector: GatewayInventoryConnector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => {
    nested = connector.list({ purpose: 'nested', signal: owner.signal }); connector.cancelPending();
    return { request, signal: owner.signal, expiresAt: performance.now() + 1000 };
  }));
  try {
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await nested, { ok: false, reason: 'busy' }); assert.equal(server.requests(), 0);
  } finally { await connector.close(); await server.close(); }
});

test('getters and forged or mismatched signals cannot authorize inventory transmission', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController(); let getters = 0;
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => ({ request: { ...request }, signal: owner.signal, expiresAt: performance.now() + 1000 })));
  try {
    const raw = { signal: owner.signal, get purpose() { getters++; return 'private-purpose'; } };
    assert.deepEqual(await connector.list(raw), { ok: false, reason: 'invalid' }); assert.equal(getters, 0);
    assert.deepEqual(await connector.list({ purpose: 'review', signal: Object.create(AbortSignal.prototype) }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'denied' });
    assert.equal(server.requests(), 0);
  } finally { await connector.close(); await server.close(); }
});

test('shadow accessors on genuine AbortSignals cannot hide revocation', async () => {
  assert.ok(api); const server = await negativeServer(() => {}), owner = new AbortController(), grant = new AbortController();
  Object.defineProperty(grant.signal, 'aborted', { get() { throw new Error('private getter must never run'); } });
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => ({ request, signal: grant.signal, expiresAt: performance.now() + 1500 })));
  try {
    const pending = connector.list({ purpose: 'review', signal: owner.signal }); await until(() => server.requests() === 1); grant.abort();
    assert.deepEqual(await pending, { ok: false, reason: 'cancelled' }); assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0);
    await until(() => server.sockets.size === 0);
  } finally { await connector.close(); await server.close(); }
});

test('cancel retains the actual raw slot until close and an explicit fresh request can retry', async () => {
  assert.ok(api); const server = await negativeServer(() => {}), owner = new AbortController();
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })));
  try {
    const pending = connector.list({ purpose: 'review', signal: owner.signal }); await until(() => server.requests() === 1);
    connector.cancelPending(); assert.equal(connector.status().rawPending, 1);
    assert.deepEqual(await connector.list({ purpose: 'overlap', signal: owner.signal }), { ok: false, reason: 'busy' });
    assert.deepEqual(await pending, { ok: false, reason: 'cancelled' }); assert.equal(connector.status().rawPending, 0);
    const fresh = connector.list({ purpose: 'fresh-review', signal: owner.signal }); await until(() => server.requests() === 2);
    connector.cancelPending(); assert.deepEqual(await fresh, { ok: false, reason: 'cancelled' });
  } finally { await connector.close(); await server.close(); }
});

test('immediate cancellation retains the native socket created before request attachment', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController();
  const sockets = new Set<Duplex>(), events = channel('net.client.socket');
  const observe = (event: unknown) => {
    const socket = (event as { socket: Duplex }).socket;
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  };
  events.subscribe(observe);
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal,
    request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })));
  try {
    const pending = connector.list({ purpose: 'immediate-cancel', signal: owner.signal });
    assert.equal(sockets.size, 1, 'Native socket creation precedes the asynchronous request socket event');
    connector.cancelPending(); assert.equal(connector.status().rawPending, 1);
    assert.deepEqual(await connector.list({ purpose: 'overlap', signal: owner.signal }), { ok: false, reason: 'busy' });
    assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
    assert.equal(sockets.size, 0, 'Actual native socket close must precede cancellation settlement');
    assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0);
    assert.equal(server.requests(), 0);
  } finally {
    await connector.close(); for (const socket of sockets) socket.destroy();
    await server.close(); events.unsubscribe(observe);
  }
});

test('request construction failure retains any genuinely created native socket until close', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController();
  const sockets = new Set<Duplex>(), events = channel('net.client.socket');
  const observe = (event: unknown) => {
    const socket = (event as { socket: Duplex }).socket;
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  };
  // Keep native request/socket creation intact, then model a constructor throw.
  // The injected failing constructor owns its otherwise unreachable request's error callback.
  const prototype = Agent.prototype as unknown as { addRequest(request: ClientRequest, options: RequestOptions): void };
  const original = prototype.addRequest;
  events.subscribe(observe);
  let connector: GatewayInventoryConnector | undefined;
  try {
    for (const createSocket of [false, true]) {
      prototype.addRequest = function (request, config) {
        request.on('error', () => {});
        if (createSocket) original.call(this, request, config);
        throw new Error('Injected request construction failure');
      };
      connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal,
        request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })));
      const pending = connector.list({ purpose: 'constructor-failure', signal: owner.signal });
      assert.equal(sockets.size, Number(createSocket));
      assert.equal(connector.status().rawPending, Number(createSocket));
      assert.deepEqual(await pending, { ok: false, reason: 'unavailable' });
      assert.equal(sockets.size, 0, 'Request constructor failure must await actual native socket close');
      assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0);
      await connector.close(); connector = undefined;
    }
    assert.equal(server.requests(), 0);
  } finally {
    prototype.addRequest = original; await connector?.close();
    for (const socket of sockets) socket.destroy(); await server.close(); events.unsubscribe(observe);
  }
});

test('actual stalled response expires its current grant and closes owned native work', async () => {
  assert.ok(api); const server = await negativeServer(response => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }), owner = new AbortController();
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 120 })));
  try {
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'expired' });
    assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0); await until(() => server.sockets.size === 0);
  } finally { await connector.close(); await server.close(); }
});

test('wrong exact server identity fails before bearer transmission', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController();
  const connector = api.createGatewayInventoryConnector({ ...options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })), serverCertificateSha256: 'f'.repeat(64) });
  try {
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'unavailable' });
    assert.equal(server.requests(), 0); assert.equal(server.headers().authorization, '');
  } finally { await connector.close(); await server.close(); }
});

test('a pinned but wrong-host native certificate cannot bypass ordinary hostname verification', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end(), fixture.wrongHost), owner = new AbortController();
  const wrongHostPin = createHash('sha256').update(new X509Certificate(fixture.wrongHost.certificatePem).raw).digest('hex');
  const connector = api.createGatewayInventoryConnector({ ...options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })), serverCertificateSha256: wrongHostPin });
  try {
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'unavailable' });
    assert.equal(server.requests(), 0); assert.equal(server.headers().authorization, '');
  } finally { await connector.close(); await server.close(); }
});

test('a pinned native server from another CA cannot receive the selected role bearer', async () => {
  assert.ok(api); const other = createCoordinatorFixtures();
  const server = await negativeServer(response => response.end(), other.server), owner = new AbortController();
  const otherPin = createHash('sha256').update(new X509Certificate(other.server.certificatePem).raw).digest('hex');
  const connector = api.createGatewayInventoryConnector({ ...options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })), serverCertificateSha256: otherPin });
  try {
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'unavailable' });
    assert.equal(server.requests(), 0); assert.equal(server.headers().authorization, '');
  } finally { await connector.close(); await server.close(); other.close(); }
});

test('the absolute native deadline settles a stalled request even with a longer owner grant', async () => {
  assert.ok(api); const server = await negativeServer(() => {}), owner = new AbortController();
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 5000 })));
  try {
    const at = performance.now(); assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'expired' });
    assert.ok(performance.now() - at < 3500); assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0);
  } finally { await connector.close(); await server.close(); }
});

test('redirect, oversized and malformed native inventory responses fail without forwarding credentials', async () => {
  assert.ok(api);
  for (const kind of ['redirect', 'oversized', 'utf8', 'extra', 'foreign-session', 'future'] as const) {
    const server = await negativeServer(response => {
      if (kind === 'redirect') { response.writeHead(302, { location: 'https://127.0.0.1:9/v1/foreign' }); response.end(); return; }
      response.setHeader('content-type', 'application/json');
      if (kind === 'oversized') { response.end('a'.repeat(65537)); return; }
      if (kind === 'utf8') { response.end(Buffer.from([255])); return; }
      const now = Date.now(), issued = now + Number(kind === 'future') * 60000;
      const value = { schemaVersion: 1, profile: 'provisioned-session-directory/1', scope: { kind: 'directory', id: kind === 'foreign-session' ? 'foreign' : 'GATEWAY-INVENTORY101' }, issuedAt: issued, expiresAt: issued + 1000, resources: [] };
      response.end(JSON.stringify(kind === 'extra' ? { ...value, credentials: 'private sentinel' } : value));
    });
    const owner = new AbortController(), connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1500 })));
    try {
      const result = await connector.list({ purpose: 'review', signal: owner.signal }); assert.equal(result.ok, false, kind);
      assert.equal(server.requests(), 1); assert.equal(server.headers().method, 'GET'); assert.equal(server.headers().path, '/v1/sessions/GATEWAY-INVENTORY101/peers/peer-a/directory');
      assert.equal(connector.status().networkRequests, 1); assert.equal(connector.status().rawPending, 0);
    } finally { await connector.close(); await server.close(); }
  }
});

test('an expired or closed owner cannot dispatch late approval work', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController();
  const connector: GatewayInventoryConnector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, request => { owner.abort(); return { request, signal: owner.signal, expiresAt: performance.now() + 1500 }; }));
  try {
    assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'closed' }); assert.equal(server.requests(), 0);
    await connector.close(); assert.equal(connector.status().pending, false); assert.equal(connector.status().timers, 0);
  } finally { await connector.close(); await server.close(); }
});

test('burst and lifetime attempts remain bounded while rejected grants do no native work', async () => {
  assert.ok(api); const server = await negativeServer(response => response.end()), owner = new AbortController(); let approvals = 0;
  const connector = api.createGatewayInventoryConnector(options(server.endpoint, owner.signal, () => { approvals++; return undefined; }));
  try {
    for (let index = 0; index < 64; index++) await connector.list({ purpose: 'review', signal: owner.signal });
    assert.equal(approvals, 4); assert.deepEqual(await connector.list({ purpose: 'review', signal: owner.signal }), { ok: false, reason: 'quota' });
    assert.equal(server.requests(), 0); assert.equal(connector.status().attempts, 64);
  } finally { await connector.close(); await server.close(); }
});

test('configuration is closed and cannot choose a remote host, path or execute a getter', () => {
  assert.ok(api); const owner = new AbortController(); let getters = 0;
  for (const endpoint of ['https://192.0.2.1:443', 'https://127.0.0.1:443/path', 'https://127.0.0.1:443?scan=all', 'https://user:secret@127.0.0.1:443']) {
    assert.throws(() => api.createGatewayInventoryConnector(options(endpoint, owner.signal, () => undefined)));
  }
  assert.throws(() => api.createGatewayInventoryConnector({ ...options('https://127.0.0.1:12345', owner.signal, () => undefined), get token() { getters++; return 'a'.repeat(48); } }));
  assert.equal(getters, 0);
});
