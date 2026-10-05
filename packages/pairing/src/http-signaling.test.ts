import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { MultiplexLinkTransport, type PairingTicket } from '@101/protocol';
import { AutomaticPairingHost, HttpControllerSignalingClient, HttpHostSignalingClient, LocalSignalingBroker, createHttpSignalingSession, type HostPeerSignal, type NegotiatedLinkTransport } from './index.ts';

const device = { deviceId: 'phone', label: 'Phone', capabilities: { touch: true } };
function fixture(endpoint = 'http://127.0.0.1:10101') {
  const now = Date.now(); let number = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++number).padEnd(32, 'a')}` });
  const created = broker.createSession({ sessionId: 'HTTP101', endpoint, ttlMs: 60_000 });
  return { now, broker, created, lease: broker.join(created.ticket, created.ticket.joinToken, device) };
}
function json(value: unknown) { return Response.json(value); }
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

test('controller dispatch snapshots the original ticket instead of following later mutation', async () => {
  const f = fixture(); const ticket: PairingTicket = { ...f.created.ticket }; const targets: string[] = [];
  const client = new HttpControllerSignalingClient(ticket, (async input => { targets.push(String(input)); return json(f.lease); }) as typeof fetch);
  ticket.endpoint = 'http://127.0.0.1:9999'; ticket.sessionId = 'OTHER101'; ticket.joinToken = 'z'.repeat(32);
  const lease = await client.join(device);
  assert.equal(targets[0], `${f.created.ticket.endpoint}/v1/sessions/HTTP101/peers`);
  assert.ok(Object.isFrozen(lease));
});

test('HTTP client authority is private and its selected binding cannot be replaced through public properties', async () => {
  const f = fixture(); const targets: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { targets.push(String(input)); return json([]); }) as typeof fetch;
  const host = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, fetcher);
  const controller = new HttpControllerSignalingClient(f.created.ticket, (async () => json(f.lease)) as typeof fetch);
  assert.equal(JSON.stringify(host).includes(f.created.hostToken), false);
  assert.equal(JSON.stringify(controller).includes(f.created.ticket.joinToken), false);
  assert.equal(Reflect.set(host, 'endpoint', 'http://127.0.0.1:9999'), false);
  await host.listPeers(); assert.equal(targets[0], `${f.created.ticket.endpoint}/v1/sessions/HTTP101/host/peers`);
});

test('closed requests and lease responses cannot execute caller getters or introduce credential-bearing fields', async () => {
  const f = fixture(); let calls = 0, reads = 0;
  const client = new HttpControllerSignalingClient(f.created.ticket, (async () => { calls++; return json({ ...f.lease, identity: 'spoofed' }); }) as typeof fetch);
  const invalid = { ...device, get label() { reads++; return 'secret'; } };
  await assert.rejects(() => client.join(invalid)); assert.equal(reads, 0); assert.equal(calls, 0);
  await assert.rejects(() => client.join(device)); assert.equal(calls, 1);
});

test('HTTP signaling refuses actual same-origin redirect credential forwarding', async () => {
  const f = fixture(); let forwarded = 0;
  const server = createServer((request, response) => {
    if (request.url === '/recipient') { if (request.headers.authorization) forwarded++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(f.lease)); }
    else { response.writeHead(307, { Location: '/recipient' }); response.end(); }
  });
  const endpoint = await listen(server);
  try {
    const client = new HttpControllerSignalingClient({ ...f.created.ticket, endpoint });
    await assert.rejects(() => client.join(device));
    assert.equal(forwarded, 0);
  } finally { await stop(server); }
});

test('dot-segment peer ids cannot normalize into a different credential-bearing HTTP route', async () => {
  const f = fixture(); const seen: Array<{ path: string | undefined; authorization: boolean }> = [];
  const server = createServer((request, response) => { seen.push({ path: request.url, authorization: !!request.headers.authorization }); response.writeHead(204); response.end(); });
  const endpoint = await listen(server);
  try {
    const host = new HttpHostSignalingClient(endpoint, 'HTTP101', f.created.hostToken);
    const outcomes = await Promise.allSettled(['.', '..'].map(peer => host.publishOffer(peer, 1, '101-offer-fixture')));
    assert.deepEqual(seen, []);
    assert.ok(outcomes.every(result => result.status === 'rejected'));
    const peer = f.broker.listPeers('HTTP101', f.created.hostToken)[0];
    const poisoned = new HttpHostSignalingClient(endpoint, 'HTTP101', f.created.hostToken, (async () => json([{ ...peer, peerId: '..' }])) as typeof fetch);
    await assert.rejects(() => poisoned.listPeers());
  } finally { await stop(server); }
});

test('session creation rejects a valid producer ticket substituted from another session or endpoint', async () => {
  const f = fixture();
  const wrong = f.broker.createSession({ sessionId: 'OTHER101', endpoint: 'http://127.0.0.1:9999' });
  await assert.rejects(() => createHttpSignalingSession(f.created.ticket.endpoint, 'HTTP101', { fetcher: (async () => json(wrong)) as typeof fetch }));
});

test('HTTP response admission rejects excessive peers and closed-shape violations', async () => {
  const f = fixture(); const peer = f.broker.listPeers('HTTP101', f.created.hostToken)[0];
  for (const value of [Array.from({ length: 65 }, (_, i) => ({ ...peer, peerId: `peer-${i}` })), [{ ...peer, endpointIdentity: 'forged' }]]) {
    const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, (async () => json(value)) as typeof fetch);
    await assert.rejects(() => client.listPeers());
  }
});

test('automatic host rejects excessive injected signaling peers before constructing any RTC transport', async () => {
  const f = fixture(); const peer = f.broker.listPeers('HTTP101', f.created.hostToken)[0]; let factories = 0;
  const peers: HostPeerSignal[] = Array.from({ length: 65 }, (_, i) => ({ ...peer, peerId: `peer-${i}` }));
  const host = new AutomaticPairingHost({ signaling: { async listPeers() { return peers; }, async publishOffer() {}, async resetPeer() {} }, transport: new MultiplexLinkTransport(),
    transportFactory() { factories++; return { state: 'connected', async connect() {}, async disconnect() {}, async createOfferCode() { return '101-offer-fixture'; }, onStateChange() { return () => {}; }, onMessage() { return () => {}; }, sendReliable() {}, sendRealtime() {} } as unknown as NegotiatedLinkTransport; } });
  try { await assert.rejects(() => host.start()); assert.equal(factories, 0); } finally { await host.stop(); }
});

test('pending reservation precedes a synchronous injected fetch reentry', async () => {
  const f = fixture(); let calls = 0, nested = false; const releases: Array<() => void> = []; const outcomes: Promise<boolean>[] = [];
  const fetcher = (() => {
    calls++;
    if (!nested) { nested = true; for (let i = 0; i < 4; i++) outcomes.push(client.listPeers().then(() => true, () => false)); }
    return new Promise<Response>(resolve => { releases.push(() => resolve(json([]))); });
  }) as typeof fetch;
  const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, fetcher);
  outcomes.push(client.listPeers().then(() => true, () => false));
  for (const release of releases) release();
  const results = await Promise.all(outcomes);
  assert.equal(calls, 4); assert.equal(results.filter(Boolean).length, 4);
});

test('streamed response bytes are bounded before JSON parsing', async () => {
  const f = fixture();
  const payload = new TextEncoder().encode(`${' '.repeat(1_048_577)}[]`);
  const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
  await assert.rejects(() => client.listPeers());
});

test('stream work is bounded even when a producer repeatedly delivers empty chunks', async () => {
  const f = fixture(); let chunks = 0;
  const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, (async () => new Response(new ReadableStream({ pull(controller) {
    if (++chunks <= 4097) controller.enqueue(new Uint8Array()); else { controller.enqueue(new TextEncoder().encode('[]')); controller.close(); }
  } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
  await assert.rejects(() => client.listPeers());
  assert.ok(chunks <= 4098);
});

test('cancel fences an ignored abort and leaves the same client reusable until close', async () => {
  const f = fixture(); let release!: (value: Response) => void; let first = true;
  const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, (() => {
    if (first) { first = false; return new Promise<Response>(resolve => { release = resolve; }); }
    return Promise.resolve(json([]));
  }) as typeof fetch);
  assert.equal(typeof client.cancelPending, 'function');
  const pending = client.listPeers(); const rejected = assert.rejects(pending);
  client.cancelPending(); await rejected; release(json([{ ...f.broker.listPeers('HTTP101', f.created.hostToken)[0] }]));
  assert.deepEqual(await client.listPeers(), []);
  client.close(); await assert.rejects(() => client.listPeers());
});

test('closing during response metadata conversion fences an empty acknowledgement', async () => {
  const f = fixture();
  const response = new Response(null, { status: 204 });
  Object.defineProperty(response, 'status', { get() { client.close(); return 204; } });
  const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, (async () => response) as typeof fetch);
  await assert.rejects(() => client.publishOffer(f.lease.peerId, 1, '101-offer-fixture'));
});

test('a real stalled HTTP response reaches the finite request deadline', async () => {
  const f = fixture(); let finish: (() => void) | undefined;
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.write('['); finish = () => response.end(']'); });
  const endpoint = await listen(server); const client = new HttpHostSignalingClient(endpoint, 'HTTP101', f.created.hostToken);
  try {
    const pending = client.listPeers().then(() => 'accepted', () => 'rejected');
    const outcome = await Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('still-stalled'), 2900))]);
    finish?.(); await pending;
    assert.equal(outcome, 'rejected');
  } finally { await stop(server); }
});

test('burst admission is finite and trusted clock rollback fails closed', async () => {
  const f = fixture(); let now = f.now; let calls = 0;
  const client = new HttpHostSignalingClient(f.created.ticket.endpoint, 'HTTP101', f.created.hostToken, (async () => { calls++; return json([]); }) as typeof fetch, { now: () => now });
  for (let i = 0; i < 128; i++) await client.listPeers();
  await assert.rejects(() => client.listPeers()); assert.equal(calls, 128);
  now += 1000; await client.listPeers(); assert.equal(calls, 129);
  now--; await assert.rejects(() => client.listPeers()); assert.equal(calls, 129);
});
