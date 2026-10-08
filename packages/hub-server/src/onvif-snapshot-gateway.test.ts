import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { ClientRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { createOnvifSnapshotGateway, ONVIF_SNAPSHOT_LIMITS } from './onvif-snapshot-gateway.ts';

const red = Buffer.from('/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCe4CqYO//Z', 'base64');
const blue = Buffer.from('/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAYqm//Z', 'base64');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function soap(uri: string, change = ''): string { return `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body><trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${uri}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>0</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout>${change}</trt:MediaUri></trt:GetSnapshotUriResponse></s:Body></s:Envelope>`; }
async function body(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
function send(response: ServerResponse, mediaType: string, bytes: string | Buffer, status = 200, headers: Record<string, string> = {}): void {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); response.writeHead(status,
    { 'content-type': mediaType, 'content-length': String(payload.length), connection: 'close', ...headers }); response.end(payload);
}
async function fixture(custom?: (request: IncomingMessage, response: ServerResponse, uri: string) => void | Promise<void>) {
  const seen: { method?: string; url?: string; body: Buffer; headers: IncomingMessage['headers'] }[] = []; let frame = 0;
  const server = createServer(async (request, response) => {
    const requestBody = await body(request); seen.push({ method: request.method, url: request.url, body: requestBody, headers: request.headers });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const uri = `http://127.0.0.1:${address.port}/snapshot/profile-a.jpg`;
    if (custom) return custom(request, response, uri);
    if (request.method === 'POST' && request.url === '/onvif/media_service') send(response, 'application/soap+xml', soap(uri));
    else if (request.method === 'GET' && request.url === '/snapshot/profile-a.jpg') send(response, 'image/jpeg', frame++ % 2 ? blue : red);
    else send(response, 'text/plain', 'not found', 404);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const owner = new AbortController(), cameraGrant = new AbortController(), mediaGrant = new AbortController(); const approvals: unknown[] = [];
  const gateway = createOnvifSnapshotGateway({ ownerSignal: owner.signal,
    scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'session-a' },
    selectedCamera: { id: 'camera-a', port: address.port, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
    authorizeCamera(request) { approvals.push(request); return { request, signal: cameraGrant.signal, expiresAt: performance.now() + 4000 }; },
    authorizeMedia(request) { approvals.push(request); return { request, signal: mediaGrant.signal, expiresAt: performance.now() + 4000 }; } });
  return { gateway, server, owner, cameraGrant, mediaGrant, approvals, seen,
    async close() { await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const operation = () => ({ purpose: 'approved-snapshot', signal: new AbortController().signal, deadline: performance.now() + 2000 });

test('construction is inert and a denied control grant makes no request', async () => {
  const owner = new AbortController(); let calls = 0;
  const gateway = createOnvifSnapshotGateway({ ownerSignal: owner.signal,
    scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'session-a' },
    selectedCamera: { id: 'camera-a', port: 19001, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
    authorizeCamera: () => { calls++; return undefined; }, authorizeMedia: () => undefined });
  assert.equal(calls, 0); assert.deepEqual(await gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }), { ok: false, reason: 'denied' });
  assert.equal(calls, 1); await gateway.close();
});

test('selected profile resolves once and returns changing bounded JPEG bytes under fresh media grants', async () => {
  const value = await fixture();
  try {
    const deadline = performance.now() + 2000; const started = await value.gateway.start({ purpose: 'selected-camera', deadline }); assert.ok(started.ok);
    const first = await value.gateway.capture(started.value, operation()), second = await value.gateway.capture(started.value, operation()); assert.ok(first.ok && second.ok);
    assert.deepEqual([digest(first.value.bytes), digest(second.value.bytes)], ['f0f7d6d93d89697867d278fc92bfdacac7711f7218817fdea5663554d68ea303', '48f7f5bb7ac5a8daa3f23b7ed2da27567dcf0a6e327e7da0adf4c63a51b37ef4']);
    assert.equal(first.value.reference.mediaType, 'application/octet-stream'); assert.equal(first.value.mediaType, 'image/jpeg');
    assert.deepEqual(first.value.provenance, { provider: 'onvif-get-snapshot-uri', profileToken: 'profile-a', physicalSource: 'unverified', captureTimeKnown: false });
    assert.deepEqual(value.seen.map(item => `${item.method} ${item.url}`), ['POST /onvif/media_service', 'GET /snapshot/profile-a.jpg', 'GET /snapshot/profile-a.jpg']);
    assert.match(value.seen[0]!.body.toString(), /<trt:ProfileToken>profile-a<\/trt:ProfileToken>/);
    assert.match(String(value.seen[0]!.headers['content-type']), /GetSnapshotUri/); assert.equal((value.approvals[0] as { deadline: number }).deadline, deadline);
    assert.deepEqual((value.approvals as { action: string }[]).map(item => item.action), ['resolve-snapshot-uri', 'read-snapshot', 'read-snapshot']);
  } finally { await value.close(); }
});

test('selection rejects endpoint widening, query paths, accessors, and extra fields', () => {
  const base = { ownerSignal: new AbortController().signal, scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'session-a' }, authorizeCamera: () => undefined, authorizeMedia: () => undefined };
  for (const snapshotPath of ['http://192.0.2.1/frame.jpg', '/snapshot.jpg?next=1', '//other/frame.jpg', '/../secret',
    '/snapshot/%2e%2e/secret', '/snapshot/%2fother.jpg', '/snapshot\\other.jpg'])
    assert.throws(() => createOnvifSnapshotGateway({ ...base, selectedCamera: { id: 'camera-a', port: 19001, profileToken: 'profile-a', snapshotPath } }));
  assert.throws(() => createOnvifSnapshotGateway({ ...base, selectedCamera: { id: 'camera-a', port: 19001, profileToken: 'profile-a', snapshotPath: '/snapshot.jpg', extra: true } as never }));
  const selected = { id: 'camera-a', port: 19001, profileToken: 'profile-a' } as Record<string, unknown>; Object.defineProperty(selected, 'snapshotPath', { enumerable: true, get() { return '/snapshot.jpg'; } });
  assert.throws(() => createOnvifSnapshotGateway({ ...base, selectedCamera: selected as never }));
});

test('reentrant Stop during control authorization invalidates opening before SOAP is issued', async () => {
  let wire = 0; const server = createServer((_request, response) => { wire++; response.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  const owner = new AbortController(), grant = new AbortController();
  const gateway: ReturnType<typeof createOnvifSnapshotGateway> = createOnvifSnapshotGateway({ ownerSignal: owner.signal, scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'opening-stop' },
    selectedCamera: { id: 'camera-a', port: address.port, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
    authorizeCamera(request) { void gateway.stop(); return { request, signal: grant.signal, expiresAt: performance.now() + 1000 }; }, authorizeMedia: () => undefined });
  try { assert.deepEqual(await gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }), { ok: false, reason: 'denied' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(wire, 0); }
  finally { await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('an already-aborted caller is rejected before media authorization or GET reservation', async () => {
  const value = await fixture();
  try { const started = await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    const caller = new AbortController(); caller.abort();
    assert.deepEqual(await value.gateway.capture(started.value, { purpose: 'aborted', signal: caller.signal, deadline: performance.now() + 1000 }),
      { ok: false, reason: 'cancelled' });
    assert.deepEqual((value.approvals as { action: string }[]).map(item => item.action), ['resolve-snapshot-uri']);
    assert.equal(value.seen.filter(item => item.method === 'GET').length, 0); }
  finally { await value.close(); }
});

test('Stop owns capture through resource hashing and prevents post-retirement delivery', async () => {
  const value = await fixture(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), original = globalThis.crypto;
  let entered!: () => void, release!: () => void; const hashing = new Promise<void>(resolve => { entered = resolve; });
  const subtle = new Proxy(original.subtle, { get(target, property) { if (property !== 'digest') { const item = Reflect.get(target, property, target); return typeof item === 'function' ? item.bind(target) : item; }
    return (algorithm: AlgorithmIdentifier, data: BufferSource) => new Promise<ArrayBuffer>((resolve, reject) => { entered(); release = () => { original.subtle.digest(algorithm, data).then(resolve, reject); }; }); } });
  const crypto = new Proxy(original, { get(target, property) { return property === 'subtle' ? subtle : Reflect.get(target, property, target); } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto });
  try { const started = await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    const capturing = value.gateway.capture(started.value, operation()); await hashing; const stopping = value.gateway.stop();
    let stopped = false; void stopping.then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release(); await stopping; assert.deepEqual(await capturing, { ok: false, reason: 'cancelled', issued: true }); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else Reflect.deleteProperty(globalThis, 'crypto'); release?.(); await value.close(); }
});

test('control grant expiry clamps the live SOAP request deadline', async () => {
  let entered!: () => void; const posted = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer(async request => { await body(request); entered(); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address'); const owner = new AbortController(), grant = new AbortController();
  const gateway = createOnvifSnapshotGateway({ ownerSignal: owner.signal, scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'expiry' },
    selectedCamera: { id: 'camera-a', port: address.port, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
    authorizeCamera(request) { return { request, signal: grant.signal, expiresAt: performance.now() + 50 }; }, authorizeMedia: () => undefined });
  try { const starting = gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 4000 }); await posted;
    const result = await Promise.race([starting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('control expiry did not settle')), 500))]);
    assert.deepEqual(result, { ok: false, reason: 'expired', issued: true }); assert.equal(gateway.status().rawPending, 0); }
  finally { await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('invalid UTF-8 hidden in an otherwise permitted SOAP comment is rejected', async () => {
  const value = await fixture((_request, response, uri) => { const valid = Buffer.from(soap(uri).replace('<s:Body>', '<!--X--><s:Body>'));
    valid[valid.indexOf(Buffer.from('X'))] = 0xff; send(response, 'application/soap+xml', valid); });
  try { assert.deepEqual(await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }),
    { ok: false, reason: 'protocol', issued: true }); }
  finally { await value.close(); }
});

test('closed SOAP parsing rejects DTD, duplicate fields, wrong namespaces, changed URI, and extensions', async () => {
  const mutations = [(uri: string) => `<!DOCTYPE x [<!ENTITY e "x">]>${soap(uri)}`,
    (uri: string) => soap(uri).replace('</trt:MediaUri>', '<tt:Uri>'+uri+'</tt:Uri></trt:MediaUri>'),
    (uri: string) => soap(uri).replace('xmlns:tt="http://www.onvif.org/ver10/schema"', 'xmlns:tt="urn:wrong"'),
    () => soap('http://127.0.0.1:1/other.jpg'), (uri: string) => soap(uri, '<tt:Extension/>')];
  for (const mutate of mutations) {
    const value = await fixture((_request, response, uri) => send(response, 'application/soap+xml', mutate(uri)));
    try { assert.deepEqual(await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }), { ok: false, reason: 'protocol', issued: true }); assert.deepEqual(value.seen.map(item => item.method), ['POST']); }
    finally { await value.close(); }
  }
});

test('snapshot fetch rejects redirects, wrong media, encoding, oversize declarations, and non-JPEG', async () => {
  const variants = [(r: ServerResponse) => send(r, 'image/jpeg', red, 302, { location: '/other.jpg' }), (r: ServerResponse) => send(r, 'text/plain', red),
    (r: ServerResponse) => send(r, 'image/jpeg', red, 200, { 'content-encoding': 'gzip' }),
    (r: ServerResponse) => { r.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(ONVIF_SNAPSHOT_LIMITS.snapshotBytes + 1), connection: 'close' }); r.end(); },
    (r: ServerResponse) => send(r, 'image/jpeg', 'not-jpeg')];
  for (const variant of variants) {
    const value = await fixture((request, response, uri) => request.method === 'POST' ? send(response, 'application/soap+xml', soap(uri)) : variant(response));
    try { const started = await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok); const captured = await value.gateway.capture(started.value, operation()); assert.ok(!captured.ok); assert.ok(['protocol', 'server', 'transport'].includes(captured.reason)); }
    finally { await value.close(); }
  }
});

test('reentrant media authorization may Stop before any JPEG request is sent', async () => {
  const value = await fixture();
  try {
    const address = value.server.address(); if (!address || typeof address === 'string') throw new Error('address'); const owner = new AbortController(), grant = new AbortController();
    const gateway: ReturnType<typeof createOnvifSnapshotGateway> = createOnvifSnapshotGateway({ ownerSignal: owner.signal, scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'session-b' }, selectedCamera: { id: 'camera-a', port: address.port, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
      authorizeCamera(request) { return { request, signal: grant.signal, expiresAt: performance.now() + 2000 }; }, authorizeMedia(request) { void gateway.stop(); return { request, signal: grant.signal, expiresAt: performance.now() + 2000 }; } });
    const started = await gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    assert.deepEqual(await gateway.capture(started.value, operation()), { ok: false, reason: 'denied' }); assert.equal(value.seen.filter(item => item.method === 'GET').length, 0); await gateway.close();
  } finally { await value.close(); }
});

test('Stop aborts and joins an issued held JPEG request', async () => {
  let entered!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; });
  const value = await fixture((request, response, uri) => { if (request.method === 'POST') send(response, 'application/soap+xml', soap(uri)); else entered(); });
  try { const started = await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok); const capturing = value.gateway.capture(started.value, { ...operation(), deadline: performance.now() + 4000 }); await requested;
    await Promise.race([value.gateway.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('Stop did not join')), 1000))]); const result = await capturing; assert.ok(!result.ok); assert.equal(result.issued, true); assert.equal(value.gateway.status().rawPending, 0); }
  finally { await value.close(); }
});

test('revoking a fresh private media grant aborts its issued GET and frees the raw slot', async () => {
  let entered!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; });
  const value = await fixture((request, response, uri) => { if (request.method === 'POST') send(response, 'application/soap+xml', soap(uri)); else entered(); });
  try { const started = await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    const capturing = value.gateway.capture(started.value, { ...operation(), deadline: performance.now() + 4000 }); await requested; value.mediaGrant.abort();
    const result = await Promise.race([capturing, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('media revocation did not settle')), 1000))]);
    assert.deepEqual(result, { ok: false, reason: 'cancelled', issued: true }); assert.equal(value.gateway.status().rawPending, 0); }
  finally { await value.close(); }
});

test('synchronous native end fault retains raw ownership until assigned socket closes', async () => {
  const value = await fixture(); const descriptor = Object.getOwnPropertyDescriptor(ClientRequest.prototype, 'end'); const restore = () => descriptor ? Object.defineProperty(ClientRequest.prototype, 'end', descriptor) : Reflect.deleteProperty(ClientRequest.prototype, 'end');
  const socket = new EventEmitter() as EventEmitter & { destroy(): void }; socket.destroy = () => {}; let entered!: () => void; const atEnd = new Promise<void>(resolve => { entered = resolve; });
  try { const started = await value.gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    Object.defineProperty(ClientRequest.prototype, 'end', { configurable: true, writable: true, value: function(this: ClientRequest) { Object.defineProperty(this, 'socket', { configurable: true, value: socket }); this.emit('socket', socket); entered(); throw new Error('injected end failure'); } });
    const capturing = value.gateway.capture(started.value, operation()); await atEnd; restore(); let settled = false; void capturing.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(value.gateway.status().rawPending, 1); socket.emit('close'); const result = await capturing; assert.ok(!result.ok); assert.equal(result.issued, true); assert.equal(value.gateway.status().rawPending, 0); }
  finally { restore(); socket.emit('close'); await value.close(); }
});


test('live snapshot GET retires when its camera control grant expires', async () => {
  const value = await fixture((request, response, uri) => { if (request.method === 'POST') send(response, 'application/soap+xml', soap(uri)); });
  const address = value.server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const owner = new AbortController(), grant = new AbortController();
  const gateway = createOnvifSnapshotGateway({ ownerSignal: owner.signal,
    scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'capture-control-expiry' },
    selectedCamera: { id: 'camera-a', port: address.port, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
    authorizeCamera(request) { return { request, signal: grant.signal, expiresAt: performance.now() + 100 }; },
    authorizeMedia(request) { return { request, signal: grant.signal, expiresAt: performance.now() + 4000 }; } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    const result = await Promise.race([gateway.capture(started.value, { ...operation(), deadline: performance.now() + 4000 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GET remained live past control expiry')), 500); })]);
    assert.deepEqual(result, { ok: false, reason: 'expired', issued: true });
    assert.equal(gateway.status().rawPending, 0);
  } finally { clearTimeout(timer); await gateway.close(); await value.close(); }
});

test('closing a gateway releases its owner listener without removing unrelated owner listeners', async () => {
  const owner = new AbortController(), unrelated = () => {};
  owner.signal.addEventListener('abort', unrelated);
  const gateway = createOnvifSnapshotGateway({ ownerSignal: owner.signal,
    scope: { principalId: 'operator', applicationId: 'snapshot-test', sessionId: 'closed-owner' },
    selectedCamera: { id: 'camera-a', port: 19001, profileToken: 'profile-a', snapshotPath: '/snapshot/profile-a.jpg' },
    authorizeCamera: () => undefined, authorizeMedia: () => undefined });
  await gateway.close();
  assert.deepEqual(getEventListeners(owner.signal, 'abort'), [unrelated]);
});
