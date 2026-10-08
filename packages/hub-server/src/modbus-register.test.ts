import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';
import test from 'node:test';

const api = await import('./modbus-register.ts').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return undefined;
});
test('a scoped Modbus register connector is implemented', () => {
  assert.equal(typeof api?.createModbusRegisterConnector, 'function');
});

if (api) {
  const { createModbusRegisterConnector } = api;
  async function fixture(reply?: (frame: Buffer, socket: Socket) => void) {
    const sockets = new Set<Socket>(), received: Buffer[] = [];
    let state = 37, connections = 0;
    const server = createServer(socket => {
      connections++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      let pending = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 12) {
          const frame = Buffer.from(pending.subarray(0, 12)); pending = pending.subarray(12); received.push(frame);
          if (reply) { reply(frame, socket); continue; }
          if (frame[7] === 6) { state = frame.readUInt16BE(10); socket.write(frame); }
          else {
            const response = Buffer.from([0, 0, 0, 0, 0, 5, 1, 3, 2, state >> 8, state & 255]);
            response.writeUInt16BE(frame.readUInt16BE(0));
            socket.write(response.subarray(0, 4)); setImmediate(() => socket.write(response.subarray(4)));
          }
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const owner = new AbortController(), grant = new AbortController();
    let allowed = true;
    const connector = createModbusRegisterConnector({ ownerSignal: owner.signal,
      scope: { principalId: 'operator', applicationId: 'modbus-reader', sessionId: 'local-test' },
      endpoint: { host: '127.0.0.1', port: address.port, transport: 'loopback' },
      profile: { id: 'example:register', revision: 1, unitId: 1, registers: [
        { id: 'state', address: 0, access: 'read', unit: '1', scale: 0.5, offset: 1 },
        { id: 'setting', address: 0, access: 'write', unit: '1', scale: 0.5, offset: 1 },
      ] }, authorize(request) { return allowed ? { request, signal: grant.signal, expiresAt: performance.now() + 10000 } : undefined; } });
    async function close() { await connector.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
    return { connector, owner, grant, received, connections: () => connections, allow(value: boolean) { allowed = value; }, close };
  }
  const request = () => ({ purpose: 'reviewed-register', signal: new AbortController().signal });
  test('construction and denied start are inert; scoped read and exact write use actual fragmented TCP replies', async () => {
    const f = await fixture();
    try {
      assert.equal(f.connections(), 0); f.allow(false);
      assert.deepEqual(await f.connector.start({ purpose: 'registers' }), { ok: false, reason: 'denied' });
      assert.equal(f.connections(), 0); f.allow(true);
      const start = await f.connector.start({ purpose: 'registers' }); assert.ok(start.ok);
      const read = await f.connector.read(start.value, 'state', request()); assert.ok(read.ok);
      assert.equal(read.value.rawValue, 37); assert.equal(read.value.value, 19.5); assert.equal(read.value.unit, '1');
      const write = await f.connector.write(start.value, 'setting', 22, request()); assert.ok(write.ok);
      assert.equal(write.value.evidence, 'target-acknowledged'); assert.equal(f.received[1]!.readUInt16BE(10), 42);
      const next = await f.connector.read(start.value, 'state', request()); assert.ok(next.ok); assert.equal(next.value.value, 22);
      assert.notEqual(read.value.sequence, next.value.sequence);
    } finally { await f.close(); }
  });
  test('register direction, unrepresentable values, copied handles and denied operation fail before transport effects', async () => {
    const f = await fixture();
    try {
      const start = await f.connector.start({ purpose: 'registers' }); assert.ok(start.ok);
      assert.equal((await f.connector.read(Object.freeze({ ...start.value }), 'state', request())).ok, false);
      assert.equal((await f.connector.read(start.value, 'setting', request())).ok, false);
      assert.equal((await f.connector.write(start.value, 'state', 2, request())).ok, false);
      assert.equal((await f.connector.write(start.value, 'setting', 1.1, request())).ok, false);
      f.allow(false); assert.equal((await f.connector.write(start.value, 'setting', 2, request())).ok, false);
      assert.equal(f.received.length, 0);
    } finally { await f.close(); }
  });
  test('wrong transaction, unit, function, length and extra response bytes retire the connection', async () => {
    for (const change of [0, 6, 7, 8, 11]) {
      const f = await fixture((frame, socket) => {
        const response = Buffer.from([frame[0]!, frame[1]!, 0, 0, 0, 5, 1, 3, 2, 0, 1]);
        if (change === 11) socket.write(Buffer.concat([response, Buffer.from([0])]));
        else { response[change] = response[change]! + 1; socket.write(response); }
      });
      try {
        const start = await f.connector.start({ purpose: 'registers' }); assert.ok(start.ok);
        const result = await f.connector.read(start.value, 'state', request()); assert.equal(result.ok, false);
        assert.equal(f.connector.status().phase, 'retiring'); await f.connector.stop();
        assert.equal(f.connector.status().nativeSockets, 0);
      } finally { await f.close(); }
    }
  });
  test('Modbus exception replies are failures, never a successful sample or retried command', async () => {
    const f = await fixture((frame, socket) => socket.write(Buffer.from([frame[0]!, frame[1]!, 0, 0, 0, 3, 1, 0x86, 2])));
    try {
      const start = await f.connector.start({ purpose: 'registers' }); assert.ok(start.ok);
      const result = await f.connector.write(start.value, 'setting', 2, request());
      assert.deepEqual(result, { ok: false, reason: 'exception', issued: true, uncertain: true });
      assert.equal(f.received.length, 1);
    } finally { await f.close(); }
  });
  test('revocation during an issued write fences its result and holds socket reservation until actual close', async () => {
    let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const f = await fixture(() => arrived());
    try {
      const start = await f.connector.start({ purpose: 'registers' }); assert.ok(start.ok);
      const result = f.connector.write(start.value, 'setting', 22, request()); await arrival; f.grant.abort();
      assert.deepEqual(await result, { ok: false, reason: 'cancelled', issued: true, uncertain: true });
      await f.connector.stop(); assert.equal(f.connector.status().nativeSockets, 0); assert.equal(f.connector.status().pendingTransactions, 0);
      assert.equal((await f.connector.read(start.value, 'state', request())).ok, false);
    } finally { await f.close(); }
  });
  test('Stop retires an old epoch; restart needs a fresh connection grant and never replays a command', async () => {
    const f = await fixture();
    try {
      const old = await f.connector.start({ purpose: 'registers' }); assert.ok(old.ok); await f.connector.stop();
      f.allow(false); assert.equal((await f.connector.start({ purpose: 'registers' })).ok, false);
      f.allow(true); const next = await f.connector.start({ purpose: 'registers' }); assert.ok(next.ok);
      assert.equal((await f.connector.read(old.value, 'state', request())).ok, false);
      assert.equal(f.received.length, 0); assert.ok((await f.connector.read(next.value, 'state', request())).ok);
    } finally { await f.close(); }
  });
  test('TLS verifies chain, name, validity and enrolled certificate before any register effect', async () => {
    const certificates = createCoordinatorFixtures();
    try {
      for (const variant of ['accepted', 'pin', 'name', 'ca', 'expired'] as const) {
        const sockets = new Set<Socket>(); let effects = 0;
        const certificate = variant === 'expired' ? certificates.expiredServer : certificates.server;
        const server = createTlsServer({ cert: certificate.certificatePem, key: certificate.privateKeyPem }, socket => {
          sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
          socket.on('data', () => { effects++; socket.destroy(); });
        });
        server.on('tlsClientError', () => {});
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const connector = createModbusRegisterConnector({ ownerSignal: new AbortController().signal,
          scope: { principalId: 'operator', applicationId: 'tls-registers', sessionId: 'owned-test' },
          profile: { id: 'example:register', revision: 1, unitId: 1, registers: [
            { id: 'state', address: 0, access: 'read', unit: '1', scale: 1, offset: 0 },
          ] }, endpoint: { host: '127.0.0.1', port: address.port, transport: 'tls', serverName: variant === 'name' ? 'wrong.invalid' : '127.0.0.1',
            ca: variant === 'ca' ? certificates.wrongHost.certificatePem : certificates.ca,
            certificateSha256: variant === 'pin' ? '0'.repeat(64) : new X509Certificate(certificate.certificatePem).fingerprint256.replaceAll(':', '').toLowerCase() },
          authorize(request) { return { request, signal: new AbortController().signal, expiresAt: performance.now() + 10000 }; } });
        try { assert.equal((await connector.start({ purpose: 'enrolled-tls-target' })).ok, variant === 'accepted'); assert.equal(effects, 0); }
        finally { await connector.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
      }
    } finally { certificates.close(); }
  });
  test('remote plain endpoints, accessor configuration and unreviewed register maps are rejected', () => {
    const configuration = { ownerSignal: new AbortController().signal,
      scope: { principalId: 'operator', applicationId: 'registers', sessionId: 'owned-test' },
      endpoint: { host: '192.0.2.1', port: 502, transport: 'loopback' as const },
      profile: { id: 'example:register', revision: 1, unitId: 1, registers: [
        { id: 'state', address: 0, access: 'read' as const, unit: '1', scale: 1, offset: 0 },
      ] }, authorize() { return undefined; } };
    assert.throws(() => createModbusRegisterConnector(configuration));
    const accessor = { ...configuration }; Object.defineProperty(accessor, 'ownerSignal', { get() { throw new Error('must not read getter'); } });
    assert.throws(() => createModbusRegisterConnector(accessor), /Invalid Modbus/);
    assert.throws(() => createModbusRegisterConnector({ ...configuration, endpoint: { host: '127.0.0.1', port: 502, transport: 'loopback' },
      profile: { ...configuration.profile, registers: [{ ...configuration.profile.registers[0]!, scale: Infinity }] } }));
  });
}
