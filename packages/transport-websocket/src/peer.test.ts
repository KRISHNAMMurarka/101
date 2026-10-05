import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocketPort } from './ports.ts';
import type { SecureWebSocketOptions } from './peer.ts';

const implementation = await import('./peer.ts').catch(() => undefined);
function transport(options: SecureWebSocketOptions) {
  assert.ok(implementation?.SecureWebSocketTransport, 'secure WSS fallback implementation must exist');
  return new implementation.SecureWebSocketTransport(options);
}

// Exact browser socket surface. Sends copy their input and account buffered bytes
// synchronously; delivery is asynchronous and independent from local disposal.
class Socket implements WebSocketPort {
  readyState = 1; protocol = '101-resource-wss-1'; binaryType = 'arraybuffer'; bufferedAmount = 0;
  onopen: WebSocketPort['onopen'] = null; onmessage: WebSocketPort['onmessage'] = null;
  onclose: WebSocketPort['onclose'] = null; onerror: WebSocketPort['onerror'] = null;
  target?: Socket; sent: (string | ArrayBuffer)[] = []; queue: (() => void)[];
  constructor(queue: (() => void)[]) { this.queue = queue; }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 1) throw new Error('socket closed');
    const copy = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    const bytes = typeof copy === 'string' ? new TextEncoder().encode(copy).length : copy.byteLength;
    this.bufferedAmount += bytes; this.sent.push(copy);
    this.queue.push(() => { this.bufferedAmount -= bytes; this.target?.onmessage?.({ data: copy }); });
  }
  close() { this.readyState = 3; this.onclose?.({}); }
}
async function pair(options: { a?: Partial<Pick<SecureWebSocketOptions, 'endpoint' | 'limits'>>; b?: Partial<Pick<SecureWebSocketOptions, 'endpoint' | 'limits'>> } = {}) {
  const queue: (() => void)[] = [], left = new Socket(queue), right = new Socket(queue); left.target = right; right.target = left;
  let now = 100;
  const a = transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => now, createSocket: () => left, ...options.a });
  const b = transport({ endpoint: 'wss://localhost/connect', side: 'server', now: () => now, socket: right, ...options.b });
  const pump = async () => { for (let i = 0; i < 20; i++) { while (queue.length) queue.shift()!(); a.tick(); b.tick(); await new Promise<void>(resolve => setImmediate(resolve)); } };
  await a.connect(); await b.connect(); await pump();
  return { a, b, left, right, queue, pump, setTime(value: number) { now = value; }, async stop() { await a.disconnect(); await b.disconnect(); } };
}

test('insecure and credential endpoints are rejected before any socket is created', () => {
  for (const endpoint of ['ws://localhost/connect', 'https://localhost/connect', 'wss://user:password@localhost/connect',
    'wss://localhost/connect?token=secret', 'wss://localhost/connect#fragment', ' wss://localhost/connect', 'wss://localhost/a\nb']) {
    let created = 0;
    assert.throws(() => transport({ endpoint, side: 'client', now: () => 1, createSocket() { created++; return new Socket([]); } }), TypeError);
    assert.equal(created, 0);
  }
});

test('actual socket negotiation owns immutable session provenance and both resource lanes', async () => {
  const f = await pair({ b: { limits: { maxMessageBytes: 4096, reliableBufferLimit: 8192, latestBufferLimit: 1024 } } });
  assert.equal(f.a.state, 'connected'); assert.equal(f.b.state, 'connected');
  const binding = f.a.sessionBinding()!;
  assert.equal(binding.endpoint, 'wss://localhost/connect'); assert.equal(binding.subprotocol, '101-resource-wss-1');
  assert.equal(binding.limits.maxMessageBytes, 4096); assert.equal(binding.limits.latestBufferLimit, 1024);
  assert.equal(f.a.isCurrentSession(binding), true); assert.equal(f.a.isCurrentSession({ ...binding }), false);
  assert.equal(f.b.isCurrentSession(binding), false); assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.limits));
  const received: [string, string | ArrayBuffer][] = []; f.b.onData((lane, data) => received.push([lane, data]));
  assert.equal(f.a.send('reliable', 'edge'), true); assert.equal(f.a.send('disposable', new Uint8Array([7, 9])), true);
  await f.pump(); assert.equal(received[0]![0], 'reliable'); assert.equal(received[0]![1], 'edge');
  assert.equal(received[1]![0], 'disposable'); assert.deepEqual([...new Uint8Array(received[1]![1] as ArrayBuffer)], [7, 9]);
  await f.stop(); assert.equal(f.a.isCurrentSession(binding), false);
});

test('admission counts UTF8 and framing bytes and preserves reliable headroom without a hidden queue', async () => {
  const f = await pair({ a: { limits: { maxMessageBytes: 4096, reliableBufferLimit: 8192, latestBufferLimit: 1024 } } });
  f.left.bufferedAmount = 990;
  assert.equal(f.a.send('disposable', 'éé'), false); // Four payload bytes plus the connection/lane header exceed 1024.
  assert.equal(f.a.send('reliable', 'release'), true);
  assert.equal(f.a.send('reliable', new Uint8Array(4097)), false);
  f.left.bufferedAmount = 8180; assert.equal(f.a.send('reliable', 'release'), false);
  f.left.bufferedAmount = NaN; assert.equal(f.a.send('reliable', 'release'), false);
  assert.equal(f.a.status().pending, 0); await f.stop();
});

test('wrong negotiated protocol or endpoint never opens resource lanes', async () => {
  const socket = new Socket([]); socket.protocol = '';
  const raw = transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => 1, createSocket: () => socket });
  await raw.connect(); assert.equal(raw.state, 'failed'); assert.equal(raw.sessionBinding(), undefined);
  const f = await pair({ b: { endpoint: 'wss://localhost/another' } });
  assert.equal(f.a.isOpen('reliable'), false); assert.equal(f.b.isOpen('disposable'), false); await f.stop();
});

test('negotiation rejects extra controls and times out without granting a session', async () => {
  const queue: (() => void)[] = [], socket = new Socket(queue); let now = 1;
  const raw = transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => now, createSocket: () => socket });
  await raw.connect();
  socket.onmessage?.({ data: JSON.stringify({ protocol: 'connect-wss', version: 1, type: 'hello', side: 'server', extra: true }) });
  assert.equal(raw.state, 'failed'); assert.equal(raw.sessionBinding(), undefined);
  const waiting = transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => now, createSocket: () => new Socket([]) });
  await waiting.connect(); now = 5001; waiting.tick(); assert.equal(waiting.state, 'failed');
});

test('delayed frames cannot enter a new connection even when endpoint and application data are reused', async () => {
  const old = await pair(); old.a.send('disposable', 'old'); const frame = old.left.sent.at(-1)!;
  const binding = old.a.sessionBinding(); await old.stop();
  const fresh = await pair(); const values: unknown[] = []; fresh.b.onData((_lane, value) => values.push(value));
  fresh.right.onmessage?.({ data: frame }); await fresh.pump(); assert.deepEqual(values, []);
  assert.equal(fresh.a.isCurrentSession(binding), false); fresh.a.send('disposable', 'new'); await fresh.pump();
  assert.deepEqual(values, ['new']); await fresh.stop();
});

test('rollback and reentrant observer disposal revoke authority before any later callback', async () => {
  const f = await pair(); const values: unknown[] = [];
  f.b.onData(() => { void f.b.disconnect(); }); f.b.onData((_lane, value) => values.push(value));
  f.a.send('reliable', 'one'); await f.pump(); assert.deepEqual(values, []); assert.equal(f.b.state, 'disconnected');
  f.setTime(99); f.a.tick(); assert.equal(f.a.state, 'failed'); await f.stop();
});

test('cancellation inside the trusted clock cannot resume connection construction', async () => {
  let created = 0;
  const raw: ReturnType<typeof transport> = transport({ endpoint: 'wss://localhost/connect', side: 'client', now() { void raw.disconnect(); return 100; },
    createSocket() { created++; return new Socket([]); } });
  await raw.connect(); try { assert.equal(created, 0); assert.equal(raw.state, 'disconnected'); } finally { await raw.disconnect(); }
});

test('socket close callbacks cannot reconnect while retirement is still running', async () => {
  let created = 0;
  const raw = transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => 100,
    createSocket() { created++; const socket = new Socket([]); socket.close = () => { if (created < 2) void raw.connect(); }; return socket; } });
  await raw.connect(); await raw.disconnect(); try { assert.equal(created, 1); assert.equal(raw.state, 'disconnected'); } finally { await raw.disconnect(); }
});

test('a negotiation arriving after its trusted deadline cannot win a race with tick or the watchdog', async () => {
  const queue: (() => void)[] = [], left = new Socket(queue), right = new Socket(queue); left.target = right; right.target = left;
  let now = 100;
  const a = transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => now, createSocket: () => left });
  const b = transport({ endpoint: 'wss://localhost/connect', side: 'server', now: () => now, socket: right });
  await a.connect(); await b.connect(); now = 5100;
  for (let turn = 0; turn < 20; turn++) { while (queue.length) queue.shift()!(); await new Promise<void>(resolve => setImmediate(resolve)); }
  try { assert.equal(a.state, 'failed'); assert.equal(b.state, 'failed'); assert.equal(a.sessionBinding(), undefined); }
  finally { await a.disconnect(); await b.disconnect(); }
});

test('closed byte configuration rejects getters, nonfinite limits and unbounded requests', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'maxMessageBytes', { enumerable: true, get() { reads++; return 1024; } });
  for (const limits of [getter, { maxMessageBytes: Infinity }, { maxMessageBytes: 0 }, { reliableBufferLimit: 262145 },
    { latestBufferLimit: 65537 }, { latestBufferLimit: 131072 }, { maxMessageBytes: 131072, reliableBufferLimit: 131072 }])
    assert.throws(() => transport({ endpoint: 'wss://localhost/connect', side: 'client', now: () => 100, limits }), TypeError);
  assert.equal(reads, 0);
});

test('encoded and C1 controls cannot become a negotiated TLS endpoint path', () => {
  for (const endpoint of ['wss://localhost/a\u0085b', 'wss://localhost/a%0Db', 'wss://localhost/a%7Fb'])
    assert.throws(() => transport({ endpoint, side: 'client', now: () => 100 }), TypeError);
});
