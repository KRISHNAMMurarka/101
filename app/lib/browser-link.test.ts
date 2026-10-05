import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHubServer } from '@101/hub-server';
import { AutomaticPairingHost, HttpHostSignalingClient, createHttpSignalingSession } from '@101/pairing';
import { BrowserHostTransport, readBrowserHubCandidates } from './browser-link.ts';

function browser(endpoint: string, search = `?hub=${encodeURIComponent(endpoint)}`, hash = '') {
  const records = new Map<string, string>(), requests: { url: string; init?: RequestInit }[] = [];
  const names = ['window', 'document', 'localStorage', 'fetch'] as const;
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const realFetch = globalThis.fetch;
  const location = { origin: 'http://127.0.0.1:3000', pathname: '/', search, hash, get href() { return this.origin + this.pathname + this.search + this.hash; } };
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, history: { state: null, replaceState() { location.hash = ''; } }, localStorage: storage } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { title: 'Endpoint review' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => { requests.push({ url: String(input), init }); return realFetch(input, init); } });
  return { records, requests, location, realFetch, mock(fetcher: typeof fetch) { Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher }); }, restore() { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}
async function close(host: BrowserHostTransport) {
  const internal = host as unknown as { leaseCount: number; disconnectTimer?: ReturnType<typeof setTimeout>; closeIfUnused(): Promise<void> };
  internal.leaseCount = 0; clearTimeout(internal.disconnectTimer); await internal.closeIfUnused();
}
function prepare(host: BrowserHostTransport, endpoint?: string, options?: { signal?: AbortSignal; phoneEndpoint?: string }) {
  return (host.preparePairing as unknown as (endpoint?: string, options?: { signal?: AbortSignal; phoneEndpoint?: string }) => ReturnType<BrowserHostTransport['preparePairing']>)(endpoint, options);
}

test('a query candidate does not write storage or request a Hub without explicit selection', async () => {
  const b = browser('http://127.0.0.1:10101'), host = new BrowserHostTransport('REVIEW101');
  b.mock(async (input, init) => { b.requests.push({ url: String(input), init }); return new Response('{}', { status: 503 }); });
  try { await assert.rejects(() => prepare(host)); assert.equal(b.requests.length, 0); assert.equal(b.records.size, 0); }
  finally { await close(host); b.restore(); }
});

test('desktop bearer fragments are scrubbed immediately without an eager claim', async () => {
  const endpoint = 'http://127.0.0.1:10101';
  const b = browser(endpoint, `?session=DESKTOP101&hub=${encodeURIComponent(endpoint)}`, `#101-host-session=DESKTOP101&101-host-token=${'a'.repeat(43)}&101-host-hub=${encodeURIComponent(endpoint)}`);
  b.mock(async (input, init) => { b.requests.push({ url: String(input), init }); return new Response('{}', { status: 503 }); });
  const host = new BrowserHostTransport('DESKTOP101');
  try { assert.equal(b.location.hash, ''); assert.equal(b.requests.length, 0); assert.equal(b.records.size, 0); }
  finally { await close(host); b.restore(); }
});

test('malicious health cannot silently change the selected ticket or phone destination', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const b = browser(endpoint), host = new BrowserHostTransport('HEALTH101');
  b.mock(async (input, init) => String(input) === `${endpoint}/v1/health`
    ? new Response(JSON.stringify({ service: '101-hub', version: 1, endpoint: 'http://evil.example:10101', addresses: ['evil.example'] }))
    : b.realFetch(input, init));
  try { await assert.rejects(() => prepare(host, endpoint)); assert.equal(b.records.size, 0); }
  finally { await close(host); b.restore(); await server.stop(); }
});

test('duplicate and oversized original query candidates cannot reach the network', async () => {
  for (const search of ['?hub=http%3A%2F%2F127.0.0.1%3A10101&hub=http%3A%2F%2Fevil.example', '?hub=' + 'a'.repeat(9000)]) {
    const b = browser('http://127.0.0.1:10101', search), host = new BrowserHostTransport('BOUNDS101');
    b.mock(async (input, init) => { b.requests.push({ url: String(input), init }); return new Response('{}', { status: 503 }); });
    try { await assert.rejects(() => prepare(host)); assert.equal(b.requests.length, 0); assert.equal(b.records.size, 0); }
    finally { await close(host); b.restore(); }
  }
});

test('a canceled prepare cannot activate or persist when its obsolete health response arrives', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const b = browser(endpoint), host = new BrowserHostTransport('CANCEL101'), controller = new AbortController();
  let answer!: (response: Response) => void;
  b.mock((input, init) => String(input) === `${endpoint}/v1/health` ? new Promise(resolve => { answer = resolve; }) : b.realFetch(input, init));
  const pending = prepare(host, endpoint, { signal: controller.signal });
  try {
    while (!answer) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); answer(new Response(JSON.stringify({ service: '101-hub', version: 1, endpoint, addresses: ['127.0.0.1'] })));
    await assert.rejects(() => pending); assert.equal(b.records.size, 0);
  } finally { await close(host); b.restore(); await server.stop(); }
});

test('checking real health is read-only; only Connect persists the exact selected endpoint and enables pairing', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const b = browser(endpoint), host = new BrowserHostTransport('SELECT101');
  try {
    assert.equal(readBrowserHubCandidates()[0]?.endpoint, endpoint); assert.equal(b.requests.length, 0); assert.equal(b.records.size, 0);
    const review = await host.reviewEndpoint(endpoint); assert.equal(review.endpoint, endpoint);
    assert.equal(b.records.size, 0); assert.equal(b.requests.length, 1);
    const info = await prepare(host, endpoint);
    assert.equal(info.hubEndpoint, endpoint); assert.equal(info.ticket.endpoint, endpoint);
    assert.equal(new URL(info.controllerUrl).origin, 'http://127.0.0.1:3000');
    assert.equal(b.records.get('101.hub.endpoint'), endpoint);
    assert.ok([...b.records.keys()].some(key => key.startsWith('101.hub.host.')));
    for (const request of b.requests) { assert.equal(new URL(request.url).origin, endpoint); assert.equal(request.init?.credentials, 'omit'); assert.equal(request.init?.redirect, 'manual'); assert.ok(request.init?.signal); }
  } finally { await close(host); b.restore(); await server.stop(); }
});

test('an explicitly selected advertised LAN address changes the phone ticket/page without retargeting the connection', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start(), phone = endpoint.replace('127.0.0.1', '192.168.1.10');
  const b = browser(endpoint), host = new BrowserHostTransport('PHONE101');
  b.mock(async (input, init) => { b.requests.push({ url: String(input), init }); return String(input) === `${endpoint}/v1/health` ? Response.json({ service: '101-hub', version: 1, endpoint, addresses: ['192.168.1.10'] }) : b.realFetch(input, init); });
  try {
    assert.ok((await host.reviewEndpoint(endpoint)).phoneEndpoints.includes(phone));
    await assert.rejects(() => prepare(host, endpoint, { phoneEndpoint: 'http://192.168.1.11:10101' }));
    assert.equal(b.records.size, 0);
    const info = await prepare(host, endpoint, { phoneEndpoint: phone });
    assert.equal(info.ticket.endpoint, phone); assert.equal(info.hubEndpoint, endpoint);
    assert.equal(new URL(info.controllerUrl).origin, 'http://192.168.1.10:3000');
    assert.equal(b.records.get('101.hub.endpoint'), endpoint);
    assert.ok(b.requests.every(request => new URL(request.url).origin === endpoint));
  } finally { await close(host); b.restore(); await server.stop(); }
});

test('desktop selection claims and rotates genuine legacy authority; a reload resumes without exposing it in the QR URL', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const created = await createHttpSignalingSession(endpoint, 'CLAIM101', { hostName: 'Desktop Hub' });
  const b = browser(endpoint, `?session=CLAIM101&hub=${encodeURIComponent(endpoint)}`, `#101-host-session=CLAIM101&101-host-token=${created.hostToken}&101-host-hub=${encodeURIComponent(endpoint)}`);
  const host = new BrowserHostTransport('CLAIM101'); let reload: BrowserHostTransport | undefined;
  try {
    assert.equal(b.location.hash, ''); assert.equal(b.requests.length, 0); assert.equal(b.records.size, 0);
    const info = await prepare(host, endpoint); assert.equal(info.ticket.joinToken, created.ticket.joinToken);
    const key = [...b.records.keys()].find(key => key.startsWith('101.hub.host.'))!;
    const first = JSON.parse(b.records.get(key)!).hostToken as string;
    assert.notEqual(first, created.hostToken); assert.equal(info.controllerUrl.includes(created.hostToken), false); assert.equal(info.controllerUrl.includes(first), false);
    await assert.rejects(() => new HttpHostSignalingClient(endpoint, 'CLAIM101', created.hostToken).listPeers());
    await close(host); reload = new BrowserHostTransport('CLAIM101');
    const resumed = await prepare(reload, endpoint); assert.equal(resumed.ticket.joinToken, created.ticket.joinToken);
    assert.notEqual(JSON.parse(b.records.get(key)!).hostToken, first);
  } finally { await close(host); if (reload) await close(reload); b.restore(); await server.stop(); }
});

test('encoded desktop secret keys are scrubbed, and a cross-path claim redirect is never followed or persisted', async () => {
  const endpoint = 'http://127.0.0.1:10101';
  const fragment = `#101-host-session=REDIRECT101&101-host-token=${'a'.repeat(43)}&101-host-hub=${encodeURIComponent(endpoint)}`.replaceAll('101-host-', '%31%30%31%2dhost%2d');
  const b = browser(endpoint, `?session=REDIRECT101&hub=${encodeURIComponent(endpoint)}`, fragment);
  b.mock(async (input, init) => { b.requests.push({ url: String(input), init }); return String(input).endsWith('/health') ? Response.json({ service: '101-hub', version: 1, endpoint, addresses: [] }) : new Response('', { status: 302, headers: { Location: `${endpoint}/other-path` } }); });
  const host = new BrowserHostTransport('REDIRECT101');
  try {
    assert.equal(b.location.hash, ''); assert.equal(b.requests.length, 0);
    await assert.rejects(() => prepare(host, endpoint)); assert.equal(b.requests.length, 2); assert.equal(b.records.size, 0);
    assert.equal(b.requests[1]?.init?.redirect, 'manual'); assert.equal(b.requests[1]?.init?.credentials, 'omit');
  } finally { await close(host); b.restore(); }
});

test('a canceled initial poll cannot enable or persist even after a genuine session has been created', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const b = browser(endpoint), host = new BrowserHostTransport('POLL101'), controller = new AbortController();
  let answer!: (response: Response) => void;
  b.mock((input, init) => String(input).endsWith('/host/peers') && !answer ? new Promise(resolve => { answer = resolve; }) : b.realFetch(input, init));
  const pending = prepare(host, endpoint, { signal: controller.signal });
  try {
    while (!answer) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); answer(Response.json([])); await assert.rejects(() => pending);
    assert.equal(b.records.size, 0); assert.equal((host as unknown as { automatic?: unknown }).automatic, undefined);
    const recovered = await prepare(host, endpoint); assert.equal(recovered.ticket.sessionId, 'POLL101');
  } finally { await close(host); b.restore(); await server.stop(); }
});

test('a fresh prepare supersedes an obsolete pending prepare even at the same address', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const b = browser(endpoint), host = new BrowserHostTransport('FRESH101');
  let answer!: (response: Response) => void;
  b.mock((input, init) => String(input).endsWith('/health') && !answer ? new Promise(resolve => { answer = resolve; }) : b.realFetch(input, init));
  const old = prepare(host, endpoint); const rejected = assert.rejects(() => old);
  try {
    while (!answer) await new Promise(resolve => setImmediate(resolve));
    const current = await prepare(host, endpoint);
    answer(Response.json({ service: '101-hub', version: 1, endpoint, addresses: [] }));
    await rejected;
    assert.equal(current.ticket.sessionId, 'FRESH101'); assert.equal(b.records.get('101.hub.endpoint'), endpoint);
  } finally { await close(host); b.restore(); await server.stop(); }
});

test('genuine producer responses with a changed identity or excessive body never become browser authority', async () => {
  for (const mode of ['session', 'endpoint', 'bytes']) {
    const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
    const b = browser(endpoint), host = new BrowserHostTransport('IDENTITY101');
    b.mock(async (input, init) => {
      const response = await b.realFetch(input, init);
      if (init?.method !== 'POST') return response;
      const created = await response.json();
      if (mode === 'session') created.ticket.sessionId = 'OTHER101';
      if (mode === 'endpoint') created.ticket.endpoint = 'http://evil.example:10101';
      if (mode === 'bytes') created.extra = 'x'.repeat(5000);
      return Response.json(created);
    });
    try { await assert.rejects(() => prepare(host, endpoint)); assert.equal(b.records.size, 0); assert.equal((host as unknown as { automatic?: unknown }).automatic, undefined); }
    finally { await close(host); b.restore(); await server.stop(); }
  }
});

test('a replacement prepare waits for obsolete peer teardown before sharing its transport', async () => {
  const server = new LocalHubServer({ host: '127.0.0.1', port: 0 }), endpoint = await server.start();
  const b = browser(endpoint), host = new BrowserHostTransport('TEARDOWN101');
  let answer!: (response: Response) => void, release!: () => void, healthCalls = 0;
  const originalStop = AutomaticPairingHost.prototype.stop;
  let firstStop = true;
  AutomaticPairingHost.prototype.stop = async function () { if (firstStop) { firstStop = false; await new Promise<void>(resolve => { release = resolve; }); } await originalStop.call(this); };
  b.mock((input, init) => { if (String(input).endsWith('/health')) healthCalls += 1; return String(input).endsWith('/host/peers') && !answer ? new Promise(resolve => { answer = resolve; }) : b.realFetch(input, init); });
  const obsolete = prepare(host, endpoint); const rejected = assert.rejects(() => obsolete);
  let replacement: ReturnType<typeof prepare> | undefined;
  try {
    while (!answer) await new Promise(resolve => setImmediate(resolve));
    replacement = prepare(host, endpoint);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(healthCalls, 1, 'fresh work must wait until the old peer teardown has settled');
    release(); await rejected;
    assert.equal((await replacement).ticket.sessionId, 'TEARDOWN101');
  } finally {
    release?.(); answer?.(Response.json([])); await rejected;
    await replacement?.catch(() => undefined); AutomaticPairingHost.prototype.stop = originalStop;
    await close(host); b.restore(); await server.stop();
  }
});

test('a genuine desktop LAN ticket can be claimed through selected loopback for either reviewed phone origin', async () => {
  for (const shareLan of [false, true]) {
    const server = new LocalHubServer({ host: '127.0.0.1', advertisedHost: '192.168.1.10', port: 0 });
    const lanEndpoint = await server.start(), endpoint = lanEndpoint.replace('192.168.1.10', '127.0.0.1');
    const sessionId = shareLan ? 'NATIVE-LAN101' : 'NATIVE-LOCAL101';
    // The desktop's main.ts posts its selected LAN endpoint while launcher_url() hands off loopback.
    const created = await createHttpSignalingSession(endpoint, sessionId, { advertisedEndpoint: lanEndpoint, hostName: 'Desktop Hub' });
    const b = browser(endpoint, `?session=${sessionId}&hub=${encodeURIComponent(endpoint)}`,
      `#101-host-session=${sessionId}&101-host-token=${created.hostToken}&101-host-hub=${encodeURIComponent(endpoint)}`);
    // Health matches the Rust producer exactly; stateful claims/rotation still use the real HTTP broker.
    b.mock((input, init) => {
      b.requests.push({ url: String(input), init });
      return String(input) === `${endpoint}/v1/health`
        ? Promise.resolve(Response.json({ service: '101-hub', version: 2, endpoint,
          addresses: ['192.168.1.10'], mdns: false, sessionCount: 1, peerCount: 0 }))
        : b.realFetch(input, init);
    });
    const host = new BrowserHostTransport(sessionId); let reload: BrowserHostTransport | undefined;
    const phoneEndpoint = shareLan ? lanEndpoint : endpoint;
    try {
      assert.equal(b.location.hash, ''); assert.equal(b.requests.length, 0); assert.equal(b.records.size, 0);
      const checked = await host.reviewEndpoint(endpoint); assert.ok(checked.phoneEndpoints.includes(phoneEndpoint));
      const info = await prepare(host, endpoint, { phoneEndpoint });
      assert.equal(info.hubEndpoint, endpoint); assert.equal(info.ticket.endpoint, phoneEndpoint);
      assert.equal(info.ticket.joinToken, created.ticket.joinToken);
      assert.equal(new URL(info.controllerUrl).origin, shareLan ? 'http://192.168.1.10:3000' : 'http://127.0.0.1:3000');
      assert.ok(b.requests.every(request => new URL(request.url).origin === endpoint));
      const claim = b.requests.find(request => request.init?.method === 'POST')!;
      assert.equal(JSON.parse(String(claim.init?.body)).endpoint, phoneEndpoint, 'the initial claim must bind the separately reviewed phone origin');
      const authorityKey = [...b.records.keys()].find(key => key.startsWith('101.hub.host.'))!;
      const first = JSON.parse(b.records.get(authorityKey)!).hostToken as string;
      assert.notEqual(first, created.hostToken); assert.equal(info.controllerUrl.includes(first), false);
      await assert.rejects(() => new HttpHostSignalingClient(endpoint, sessionId, created.hostToken).listPeers());
      await close(host); reload = new BrowserHostTransport(sessionId);
      const resumed = await prepare(reload, endpoint, { phoneEndpoint });
      assert.equal(resumed.ticket.endpoint, phoneEndpoint); assert.equal(resumed.ticket.joinToken, created.ticket.joinToken);
      assert.notEqual(JSON.parse(b.records.get(authorityKey)!).hostToken, first);
    } finally { await close(host); if (reload) await close(reload); b.restore(); await server.stop(); }
  }
});
