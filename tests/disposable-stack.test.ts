import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinatorFixtures } from '../tools/qa-https-coordinator.mjs';
import { createEphemeralWebIdentity } from '@101/connect';
import { prepareOperatorStartup, createCoordinatorFetcher } from '@101/hub-server';
import { createAuthenticatedLoopbackRelay, connectAuthenticatedRelay } from '../packages/hub-server/src/loopback-relay.ts';

/** Faithful feature RED: both existing native dependencies work simultaneously. */
test('actual simultaneous coordinator and gateway producers need a combined disposable runner', async () => {
  const fixture = createCoordinatorFixtures(), owner = new AbortController();
  const credentials = [fixture.clients[0]!, fixture.clients[2]!], identities = await Promise.all([createEphemeralWebIdentity(), createEphemeralWebIdentity()]);
  const prepared = prepareOperatorStartup({ schemaVersion: 1, profile: 'operator-loopback-startup/1',
    identity: { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca,
      enrollments: credentials.map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
    origins: ['https://disposable-stack.example'], listener: { host: '127.0.0.1', port: 0 }, directory: { resources: [] },
    storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } });
  assert.equal(prepared.ok, true); if (!prepared.ok) throw Error('Native startup fixture invalid');
  const gateway = createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, origin: 'https://disposable-stack.example', signal: owner.signal,
    enrollments: credentials.map((value, index) => ({ principalId: value.principalId, deviceId: value.deviceId, certificatePem: value.certificatePem, endpointKeyId: identities[index]!.keyId })) });
  const clients: Awaited<ReturnType<typeof connectAuthenticatedRelay>>[] = []; let fetcher: ReturnType<typeof createCoordinatorFetcher> | undefined;
  try {
    const [started, endpoint] = await Promise.all([prepared.controller.start(), gateway.start()]); assert.equal(started.ok, true); if (!started.ok) throw Error('Native start failed');
    fetcher = createCoordinatorFetcher({ endpoint: started.endpoint, origin: 'https://disposable-stack.example', caCertificatePem: fixture.ca,
      certificatePem: credentials[0]!.certificatePem, privateKeyPem: credentials[0]!.privateKeyPem });
    const health = await fetcher.fetch(started.endpoint + '/v1/health'); assert.equal(health.status, 200);
    const ticket = gateway.issuePair({ selectedPath: 'authenticated-loopback-relay', applicationId: 'stack-prefix', sessionId: 'prefix', epoch: '1'.repeat(32),
      sourcePrincipalId: credentials[0]!.principalId, receiverPrincipalId: credentials[1]!.principalId, ttlMs: 5000 }, request => ({ request, expiresAt: request.expiresAt, signal: owner.signal }));
    const values = await Promise.all(credentials.map((value, index) => connectAuthenticatedRelay({ credential: index === 0 ? ticket.source : ticket.receiver,
      caCertificatePem: fixture.ca, certificatePem: value.certificatePem, privateKeyPem: value.privateKeyPem, identity: identities[index]!, signal: owner.signal }))); clients.push(...values);
    let actual = ''; const detach = values[1]!.peer.onData((_lane, data) => { if (typeof data === 'string') actual = data; });
    assert.equal(values[0]!.peer.send('reliable', 'owned-native-prefix=7'), true);
    for (let turn = 0; turn < 100 && !actual; turn++) await new Promise(resolve => setTimeout(resolve, 5)); detach();
    assert.equal(actual, 'owned-native-prefix=7'); assert.equal(prepared.controller.snapshot().phase, 'running'); assert.equal(gateway.snapshot().phase, 'active');
    console.log(JSON.stringify({ nativePrefix: 'pass', coordinatorHealth: health.status, gatewayAuthenticatedEffect: actual, selectedEndpointLoopback: new URL(endpoint).hostname === '127.0.0.1', simultaneouslyLive: true }));
    let runner: { runDisposableStack?: unknown } | undefined;
    try { runner = await import('../examples/coordinator/disposable-stack.mjs'); } catch { /* Missing runner is the intended new-feature regression. */ }
    assert.equal(typeof runner?.runDisposableStack, 'function', 'native components exist; combined disposable runner is missing');
  } finally {
    owner.abort(); fetcher?.close(); await Promise.all(clients.map(value => value.stop())); await gateway.stop(); await prepared.controller.stop(); fixture.close();
  }
});

import { Server, connect as nativeConnect } from 'node:net';
import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Owned native fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function noListener(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = nativeConnect({ host: '127.0.0.1', port }); socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Native listener probe timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(Error('Native listener remained')); }); socket.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
}

test('combined runner actually grants, denies, withdraws and recovers while every component is live', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs'); const owner = new AbortController(); const events: { event: string; coordinator?: string; gateway?: string }[] = [];
  const receipt = await runDisposableStack({ mode: 'exercise', signal: owner.signal, onEvent: (value: { event: string }) => { events.push(value); } });
  assert.equal(receipt.result, 'pass'); assert.equal(receipt.actualControllerGenerations, 2); assert.equal(receipt.actualSoftwareEffects, 4);
  assert.ok(receipt.sinkReleases >= 3); assert.equal(receipt.cleanup.nativeContexts, 0); assert.equal(receipt.cleanup.temporaryCredentialsRemoved, true);
  for (const ready of events.filter(value => value.event === 'ready')) { assert.ok(ready.coordinator && ready.gateway); await noListener(Number(new URL(ready.coordinator).port)); await noListener(Number(new URL(ready.gateway).port)); }
});

test('native first and second bind cancellation retires the owner without later effects or recovery', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs'); const original = Server.prototype.listen;
  for (const boundary of [1, 2]) {
    const owner = new AbortController(), ports: number[] = [], events: { event: string }[] = []; let binds = 0;
    Server.prototype.listen = function (this: Server, ...args: Parameters<typeof original>) {
      const value = Reflect.apply(original, this, args); if (args.includes('127.0.0.1' as never)) { binds++; this.once('listening', () => { const address = this.address(); assert.ok(address && typeof address !== 'string'); ports.push(address.port); if (ports.length === boundary) owner.abort(); }); } return value;
    } as typeof original;
    try {
      const receipt = await runDisposableStack({ mode: 'exercise', signal: owner.signal, onEvent: (value: { event: string }) => { events.push(value); } });
      assert.equal(receipt.result, 'cancelled'); assert.equal(receipt.actualSoftwareEffects, 0); assert.equal(receipt.actualControllerGenerations, 1); assert.ok(binds <= 2);
      assert.equal(events.some(value => value.event === 'exercised'), false); assert.equal(events.at(-1)?.event, 'removed');
      for (const port of ports) await noListener(port);
    } finally { Server.prototype.listen = original; }
  }
});

test('owned second native bind failure closes the successful component and removes newly owned PKI only', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs'), original = Server.prototype.listen;
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('101-coordinator-tls-'))), ports: number[] = []; let binds = 0;
  Server.prototype.listen = function (this: Server, ...args: Parameters<typeof original>) {
    if (args.includes('127.0.0.1' as never) && ++binds === 2) { process.nextTick(() => this.emit('error', Object.assign(Error('Owned fixture bind failure'), { code: 'EADDRINUSE' }))); return this; }
    const value = Reflect.apply(original, this, args); this.once('listening', () => { const address = this.address(); if (address && typeof address !== 'string') ports.push(address.port); }); return value;
  } as typeof original;
  try {
    await assert.rejects(runDisposableStack({ mode: 'exercise', signal: new AbortController().signal }), /Disposable stack exercise failed/);
    assert.equal(binds, 2); for (const port of ports) await noListener(port);
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('101-coordinator-tls-')).filter(name => !before.has(name)), []);
  } finally { Server.prototype.listen = original; }
});

test('observer abort, throw and reentry cannot activate another owner or report success', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs');
  for (const mode of ['abort', 'throw', 'reentry']) {
    const owner = new AbortController(), events: string[] = [], ports: number[] = []; let reentry: Promise<unknown> | undefined;
    const running = runDisposableStack({ mode: 'serve', signal: owner.signal, onEvent(value: { event: string; coordinator?: string; gateway?: string }) {
      events.push(value.event);
      if (value.event !== 'ready') return;
      ports.push(Number(new URL(value.coordinator!).port), Number(new URL(value.gateway!).port));
      if (mode === 'reentry') { reentry = runDisposableStack({ mode: 'serve', signal: owner.signal }); void reentry.catch(() => {}); }
      if (mode === 'throw') throw Error('Owned observer failure'); owner.abort();
    } });
    if (mode === 'throw') await assert.rejects(running, /Disposable stack exercise failed/); else assert.equal((await running).result, 'cancelled');
    if (reentry) await assert.rejects(reentry, /already active/);
    assert.equal(events.includes('exercised'), false); for (const port of ports) await noListener(port);
  }
});

test('actual TLS raw close and final async observer retain the single runner reservation', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs'); const owner = new AbortController(), sockets = new Set<Socket>(), dc = channel('net.client.socket');
  let issued = 0;
  const observer = (message: unknown) => { const socket = (message as { socket: Socket }).socket; issued++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  let release!: () => void, finalObserved!: () => void; const final = new Promise<void>(resolve => { finalObserved = resolve; });
  dc.subscribe(observer);
  const running = runDisposableStack({ mode: 'exercise', signal: owner.signal, onEvent(value: { event: string; generation?: number }) {
    if (value.event === 'ready' && value.generation === 2) owner.abort();
    if (value.event === 'removed') { assert.ok(issued > 0, 'actual owned TLS client sockets were issued'); assert.equal(sockets.size, 0); finalObserved(); return new Promise<void>(resolve => { release = resolve; }); }
  } });
  try { await within(final); await assert.rejects(runDisposableStack({ mode: 'serve', signal: new AbortController().signal }), /already active/); release(); assert.equal((await running).result, 'cancelled'); }
  finally { release?.(); try { await running; } finally { dc.unsubscribe(observer); } }
});

test('closed arguments, copied signal spoof and pre-aborted owner allocate no fixture or listener', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs');
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('101-coordinator-tls-'))), owner = new AbortController(); owner.abort();
  await assert.rejects(runDisposableStack({ mode: 'exercise', signal: { aborted: false } }));
  await assert.rejects(runDisposableStack({ mode: 'exercise', signal: owner.signal, endpoint: 'https://127.0.0.1' }));
  const result = await runDisposableStack({ mode: 'exercise', signal: owner.signal }); assert.equal(result.actualControllerGenerations, 0); assert.equal(result.actualNativeSocketAttempts, 0);
  for (const path of readdirSync(tmpdir()).filter(name => name.startsWith('101-coordinator-tls-') && !before.has(name))) assert.equal(existsSync(join(tmpdir(), path)), false);
});

test('cancellation closes native ports and PKI while ready observer remains held; reservation remains until settlement', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs'); const owner = new AbortController();
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('101-coordinator-tls-'))); let release!: () => void, observed!: () => void;
  const ready = new Promise<void>(resolve => { observed = resolve; }); let endpoints: string[] = [];
  const running = runDisposableStack({ mode: 'serve', signal: owner.signal, onEvent(value: { event: string; coordinator?: string; gateway?: string }) {
    if (value.event === 'ready') { endpoints = [value.coordinator!, value.gateway!]; observed(); return new Promise<void>(resolve => { release = resolve; }); }
  } });
  try {
    await within(ready); owner.abort();
    for (let turn = 0; turn < 200 && readdirSync(tmpdir()).some(name => name.startsWith('101-coordinator-tls-') && !before.has(name)); turn++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('101-coordinator-tls-') && !before.has(name)), []);
    for (const endpoint of endpoints) await noListener(Number(new URL(endpoint).port));
    await assert.rejects(runDisposableStack({ mode: 'serve', signal: new AbortController().signal }), /already active/);
    release(); assert.equal((await running).result, 'cancelled');
  } finally { release?.(); await running; }
});

import { createRequire } from 'node:module';
interface NativeFixtureSocket {
  readonly _isServer?: boolean;
  send(data: string | Uint8Array | ArrayBuffer, options: { binary: boolean }, callback?: (error?: Error) => void): void;
}
test('issued real native sample callback remains reserved through cancellation until actual callback settlement', async () => {
  const { runDisposableStack } = await import('../examples/coordinator/disposable-stack.mjs');
  const ws = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeFixtureSocket } }, original = ws.WebSocket.prototype.send;
  const owner = new AbortController(), events: string[] = []; let release: (() => void) | undefined, sampled!: () => void, settled = false;
  const issued = new Promise<void>(resolve => { sampled = resolve; });
  ws.WebSocket.prototype.send = function (data, options, callback) {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (!this._isServer && bytes.includes(Buffer.from('"type":"sample"')) && !release) {
      original.call(this, data, options, error => { release = () => callback?.(error); owner.abort(); sampled(); }); return;
    }
    original.call(this, data, options, callback);
  };
  const running = runDisposableStack({ mode: 'exercise', signal: owner.signal, onEvent: (value: { event: string }) => { events.push(value.event); } }).finally(() => { settled = true; });
  try {
    await within(issued); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false); assert.equal(events.includes('removed'), false);
    await assert.rejects(runDisposableStack({ mode: 'serve', signal: new AbortController().signal }), /already active/);
    release!(); release = undefined; const receipt = await running; assert.equal(receipt.result, 'cancelled'); assert.equal(receipt.cleanup.nativeContexts, 0);
  } finally { ws.WebSocket.prototype.send = original; release?.(); await running; }
});
