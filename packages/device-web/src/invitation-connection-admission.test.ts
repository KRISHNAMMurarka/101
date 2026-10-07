import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createEphemeralWebIdentity, createReceiverInvitation, encodeReceiverInvitation,
  createInvitationConnectionController, webEndpointCrypto, WSS_SUBPROTOCOL,
  AuthenticatedResourcePeer, SecureWebSocketTransport, authenticatedPeerScope } from '@101/connect';
import type { InvitationConnectionGrant, InvitationConnectionScope } from '@101/connect';
import type { WebSocketPort } from '@101/transport-websocket';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';

interface NativeSocket extends WebSocketPort {
  on(event: string, listener: (...args: unknown[]) => void): NativeSocket;
  terminate(): void;
}
interface NativeServer {
  clients: Set<NativeSocket>;
  on(event: 'connection', listener: (socket: NativeSocket) => void): NativeServer;
  close(callback: () => void): void;
}
const { WebSocket, WebSocketServer } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, protocol: string, options: object) => NativeSocket;
  WebSocketServer: new (options: object) => NativeServer;
};

test('disconnect in the final admission clock cannot issue approval or a native TLS socket', { timeout: 10000 }, async t => {
  const credentials = createCoordinatorFixtures();
  const server = createServer({ cert: credentials.server.certificatePem, key: credentials.server.privateKeyPem,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  const sockets = new Set<import('node:stream').Duplex>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, handleProtocols: () => WSS_SUBPROTOCOL });
  let accepted = 0, accept!: () => void;
  const connected = new Promise<void>(resolve => { accept = resolve; });
  wss.on('connection', () => { accepted++; accept(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `wss://127.0.0.1:${address.port}/owned-invitation`;
  const identity = await createEphemeralWebIdentity(), receiver = await createEphemeralWebIdentity();
  const at = Date.now(), invitation = createReceiverInvitation({ applicationId: 'admission-reading', sessionId: 'owned-session',
    now: at, randomBytes: webEndpointCrypto.randomBytes });
  let armed = false, reads = 0, approvals = 0, issued = 0;
  const controller = createInvitationConnectionController({ ownerId: 'owned-source', identity, crypto: webEndpointCrypto,
    now: () => { if (armed && ++reads === 4) controller.disconnect(); return at; },
    endpoints: [{ id: 'owned-receiver', endpoint, remoteKeyId: receiver.keyId, expiresAt: at + 600000, isCurrent: () => true,
      createSocket(url, protocol) { issued++; return new WebSocket(url, protocol, { ca: credentials.ca,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', followRedirects: false, handshakeTimeout: 2000 }); } }],
    authorizeConnect(scope) { approvals++; return { scope, expiresAt: scope.deadline, isCurrent: () => true }; } });
  const reviewed = controller.review(encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'owned-receiver' });
  assert.ok(reviewed.ok); armed = true;
  const connecting = controller.connect(reviewed.value);
  try {
    await nextTurn(); if (issued) await connected;
    const outcome = { approvals, issued, accepted, timerArmed: controller.snapshot().timerArmed };
    t.diagnostic(JSON.stringify(outcome));
    assert.deepEqual(outcome, { approvals: 0, issued: 0, accepted: 0, timerArmed: false });
  } finally {
    controller.close(); await connecting;
    wss.clients.forEach(socket => socket.terminate()); sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => wss.close(resolve)); await new Promise<void>(resolve => server.close(() => resolve()));
    credentials.close();
  }
});

async function until(check: () => boolean) {
  const began = performance.now();
  while (!check()) {
    if (performance.now() - began >= 5000) throw Error('Owned loopback operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function ownedTls(options: { holdReceiver?: boolean } = {}) {
  const credentials = createCoordinatorFixtures(), identity = await createEphemeralWebIdentity(), receiver = await createEphemeralWebIdentity();
  const server = createServer({ cert: credentials.server.certificatePem, key: credentials.server.privateKeyPem,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  const nativeSockets = new Set<import('node:stream').Duplex>();
  server.on('connection', socket => { nativeSockets.add(socket); socket.once('close', () => nativeSockets.delete(socket)); });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, handleProtocols: () => WSS_SUBPROTOCOL });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `wss://127.0.0.1:${address.port}/owned-admission`;
  let at = Date.now(), clockRead = 0, clockHook: ((read: number) => void) | undefined, enrollmentHook: (() => void) | undefined;
  let issued = 0, accepted = 0, serveReceiver = !options.holdReceiver, nativeCloseHook: (() => void) | undefined;
  const invitation = createReceiverInvitation({ applicationId: 'owned-admission', sessionId: 'owned-session', now: at,
    randomBytes: webEndpointCrypto.randomBytes });
  const scopes: InvitationConnectionScope[] = [];
  let authorize: (scope: InvitationConnectionScope) => InvitationConnectionGrant | undefined | Promise<InvitationConnectionGrant | undefined> = scope =>
    ({ scope, expiresAt: scope.deadline, isCurrent: () => true });
  const receivers = new Set<{ peer: AuthenticatedResourcePeer; timer: ReturnType<typeof setInterval> }>();
  wss.on('connection', socket => {
    accepted++; socket.on('error', () => {});
    if (!serveReceiver) return;
    const transport = new SecureWebSocketTransport({ side: 'server', socket, endpoint, now: () => at });
    const peer = new AuthenticatedResourcePeer({ transport, identity: receiver, crypto: webEndpointCrypto, ...invitation,
      role: 'receiver', expectedRemoteKeyId: identity.keyId, now: () => at });
    const timer = setInterval(() => { transport.tick(); peer.tick(); }, 5), record = { peer, timer };
    receivers.add(record); socket.on('close', () => { clearInterval(timer); peer.stop(); receivers.delete(record); });
    void transport.connect();
  });
  const controller = createInvitationConnectionController({ ownerId: 'owned-source', identity, crypto: webEndpointCrypto,
    now: () => { clockHook?.(++clockRead); return at; },
    endpoints: [{ id: 'owned-receiver', endpoint, remoteKeyId: receiver.keyId, expiresAt: at + 600000,
      isCurrent() { const effect = enrollmentHook; enrollmentHook = undefined; effect?.(); return true; },
      createSocket(url, protocol) { issued++; const socket = new WebSocket(url, protocol, { ca: credentials.ca,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', followRedirects: false, handshakeTimeout: 2000 }); socket.on('error', () => {});
        const close = socket.close.bind(socket); socket.close = () => { const effect = nativeCloseHook; nativeCloseHook = undefined; effect?.(); close(); };
        return socket; } }],
    authorizeConnect(scope) { scopes.push(scope); return authorize(scope); } });
  function review() {
    const reviewed = controller.review(encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'owned-receiver' });
    assert.ok(reviewed.ok, JSON.stringify(reviewed)); return reviewed.value;
  }
  return { controller, invitation, review, scopes, receiver,
    stats: () => ({ issued, accepted, approvals: scopes.length }), now: () => at, advance: (ms: number) => { at += ms; },
    onClock(effect: ((read: number) => void) | undefined) { clockRead = 0; clockHook = effect; },
    onEnrollment(effect: () => void) { enrollmentHook = effect; }, authorize(effect: typeof authorize) { authorize = effect; },
    onNativeClose(effect: () => void) { nativeCloseHook = effect; }, resumeReceiver() { serveReceiver = true; },
    async connected(handle = review()) {
      const result = await controller.connect(handle); assert.ok(result.ok, JSON.stringify(result));
      const peer = controller.connection(result.value); assert.ok(peer);
      assert.equal(authenticatedPeerScope(peer)?.remoteKeyId, receiver.keyId); return result.value;
    },
    async close() {
      controller.close(); for (const record of receivers) { clearInterval(record.timer); record.peer.stop(); }
      wss.clients.forEach(socket => socket.terminate()); nativeSockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => wss.close(resolve)); await new Promise<void>(resolve => server.close(() => resolve()));
      credentials.close();
    },
  };
}

test('disconnect or exact cancel at each review clock/enrollment callout cannot recreate a review', { timeout: 10000 }, async () => {
  const f = await ownedTls();
  try {
    for (const mode of ['disconnect', 'cancel'] as const) for (const site of [1, 2, 3, 4, 'enrollment'] as const) {
      f.advance(1000); const old = f.review();
      const cancel = () => mode === 'disconnect' ? f.controller.disconnect() : assert.equal(f.controller.cancel(old).ok, true);
      if (site === 'enrollment') f.onEnrollment(cancel);
      else f.onClock(read => { if (read === site) cancel(); });
      const result = f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' });
      f.onClock(undefined);
      assert.deepEqual(result, { ok: false, reason: 'cancelled' }, `${mode} at ${site}`);
      assert.equal(f.controller.snapshot().pending, undefined); assert.equal(f.controller.snapshot().timerArmed, false);
      assert.deepEqual(await f.controller.connect(old), { ok: false, reason: 'stale' });
      assert.deepEqual(f.stats(), { issued: 0, accepted: 0, approvals: 0 });
    }
    const connected = await f.connected(); assert.ok(f.controller.connection(connected));
    assert.deepEqual(f.stats(), { issued: 1, accepted: 1, approvals: 1 });
  } finally { await f.close(); }
});

test('disconnect or exact cancel at each connect admission callout cannot query approval or open TLS', { timeout: 10000 }, async () => {
  const f = await ownedTls();
  try {
    for (const mode of ['disconnect', 'cancel'] as const) for (const site of [1, 2, 3, 4, 'enrollment'] as const) {
      f.advance(1000); const reviewed = f.review();
      const cancel = () => mode === 'disconnect' ? f.controller.disconnect() : assert.equal(f.controller.cancel(reviewed).ok, true);
      if (site === 'enrollment') f.onEnrollment(cancel);
      else f.onClock(read => { if (read === site) cancel(); });
      const result = await f.controller.connect(reviewed); f.onClock(undefined);
      assert.deepEqual(result, { ok: false, reason: 'cancelled' }, `${mode} at ${site}`);
      assert.equal(f.controller.snapshot().timerArmed, false); assert.equal(f.controller.snapshot().issuedAttempts, 0);
      assert.deepEqual(await f.controller.connect(reviewed), { ok: false, reason: 'stale' });
      assert.deepEqual(f.stats(), { issued: 0, accepted: 0, approvals: 0 });
    }
    await f.connected(); assert.deepEqual(f.stats(), { issued: 1, accepted: 1, approvals: 1 });
  } finally { await f.close(); }
});

test('preview availability callout cannot recreate a disconnected or cancelled review', async () => {
  const identity = await createEphemeralWebIdentity(), invitation = createReceiverInvitation({ applicationId: 'preview-admission',
    sessionId: 'owned-session', now: 1000, randomBytes: webEndpointCrypto.randomBytes });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const available = globalThis.WebSocket;
  for (const mode of ['disconnect', 'cancel'] as const) {
    const controller = createInvitationConnectionController({ ownerId: 'owned-source', identity, crypto: webEndpointCrypto, now: () => 1000,
      endpoints: [{ id: 'owned-receiver', endpoint: 'wss://127.0.0.1:7443/preview', remoteKeyId: identity.keyId,
        expiresAt: 100000, isCurrent: () => true }], authorizeConnect: () => { throw Error('Preview must never query approval'); } });
    try {
      const first = controller.review(encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'owned-receiver' }); assert.ok(first.ok);
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, get() {
        if (mode === 'disconnect') controller.disconnect(); else assert.equal(controller.cancel(first.value).ok, true);
        return available;
      } });
      assert.deepEqual(controller.review(encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'owned-receiver' }),
        { ok: false, reason: 'cancelled' });
      assert.equal(controller.snapshot().timerArmed, false); assert.equal(controller.snapshot().pending, undefined);
      assert.deepEqual(await controller.connect(first.value), { ok: false, reason: 'stale' });
    } finally { controller.close(); if (original) Object.defineProperty(globalThis, 'WebSocket', original); else Reflect.deleteProperty(globalThis, 'WebSocket'); }
  }
});

test('cancelled replacement admission preserves the actual authenticated incumbent', { timeout: 10000 }, async () => {
  const f = await ownedTls();
  try {
    const incumbent = await f.connected(), peer = f.controller.connection(incumbent); assert.ok(peer);
    const replacement = f.review();
    f.onClock(read => { if (read === 4) assert.equal(f.controller.cancel(replacement).ok, true); });
    assert.deepEqual(await f.controller.connect(replacement), { ok: false, reason: 'cancelled' }); f.onClock(undefined);
    assert.equal(f.controller.connection(incumbent), peer); assert.ok(authenticatedPeerScope(peer));
    assert.equal(f.controller.snapshot().state, 'connected'); assert.equal(f.controller.snapshot().socketReservations, 1);
    assert.deepEqual(f.stats(), { issued: 1, accepted: 1, approvals: 1 });
    const fresh = f.review();
    f.onClock(read => { if (read === 4) assert.deepEqual(f.controller.cancel({ ...fresh }), { ok: false, reason: 'stale' }); });
    const accepted = await f.connected(fresh); f.onClock(undefined);
    assert.ok(f.controller.connection(accepted)); assert.equal(f.controller.connection(incumbent), undefined);
    assert.deepEqual(f.stats(), { issued: 2, accepted: 2, approvals: 2 });
  } finally { await f.close(); }
});

test('cancel retains returned authorization and native socket reservations until actual settlement', { timeout: 10000 }, async () => {
  const f = await ownedTls(); let settle!: (grant: InvitationConnectionGrant) => void, approved!: InvitationConnectionScope;
  try {
    f.authorize(scope => { approved = scope; return new Promise(resolve => { settle = resolve; }); });
    const review = f.review(), connecting = f.controller.connect(review);
    assert.equal(f.controller.snapshot().unsettledAuthorizations, 1); assert.equal(f.controller.cancel(review).ok, true);
    assert.deepEqual(await connecting, { ok: false, reason: 'cancelled' });
    assert.equal(f.controller.snapshot().unsettledAuthorizations, 1);
    settle({ scope: approved, expiresAt: approved.deadline, isCurrent: () => true });
    await until(() => f.controller.snapshot().unsettledAuthorizations === 0);
    assert.deepEqual(f.stats(), { issued: 0, accepted: 0, approvals: 1 });
    f.authorize(scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }));
    await f.connected(); assert.equal(f.controller.snapshot().socketReservations, 1);
    f.controller.disconnect(); assert.equal(f.controller.snapshot().socketReservations, 1);
    await until(() => f.controller.snapshot().socketReservations === 0);
    assert.equal(f.controller.snapshot().timerArmed, false);
    await f.connected(); assert.deepEqual(f.stats(), { issued: 2, accepted: 2, approvals: 3 });
  } finally { await f.close(); }
});

test('successful admission retains the original first-clock deadline after later clock calls', { timeout: 10000 }, async () => {
  const f = await ownedTls();
  try {
    const review = f.review(), born = f.now();
    f.onClock(read => { if (read === 4) f.advance(1000); });
    const connected = await f.connected(review); f.onClock(undefined);
    assert.equal(f.scopes[0]!.deadline, born + 60000); assert.equal(f.controller.snapshot().current?.deadline, born + 60000);
    f.advance(59000); f.controller.sweep(); assert.equal(f.controller.connection(connected), undefined);
    assert.equal(f.controller.snapshot().outcome, 'expired');
    await until(() => f.controller.snapshot().socketReservations === 0 && !f.controller.snapshot().timerArmed);
  } finally { await f.close(); }
});

test('Disconnect owns admission while the actual peer notifies Stop listeners', { timeout: 10000 }, async t => {
  const f = await ownedTls();
  let nestedReview: ReturnType<typeof f.controller.review> | undefined, nestedConnect: ReturnType<typeof f.controller.connect> | undefined;
  try {
    const connected = await f.connected(), peer = f.controller.connection(connected); assert.ok(peer);
    const before = f.stats(); let notifications = 0, heldRawDuringStop = 0;
    peer.onStateChange(state => {
      if (state !== 'disconnected' || notifications++) return;
      heldRawDuringStop = f.controller.snapshot().socketReservations;
      nestedReview = f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' });
      if (nestedReview.ok) nestedConnect = f.controller.connect(nestedReview.value);
    });
    f.controller.disconnect(); await nextTurn();
    if (f.stats().issued > before.issued) await until(() => f.stats().accepted > before.accepted);
    const snapshot = f.controller.snapshot(), stats = f.stats();
    const outcome = { notifications, nestedReview: nestedReview?.ok ? 'allowed' : nestedReview?.reason,
      approvalDelta: stats.approvals - before.approvals, issuedDelta: stats.issued - before.issued,
      acceptedDelta: stats.accepted - before.accepted, state: snapshot.state, reviewPresent: snapshot.pending !== undefined,
      timerArmed: snapshot.timerArmed };
    t.diagnostic(JSON.stringify(outcome));
    assert.deepEqual(outcome, { notifications: 1, nestedReview: 'busy', approvalDelta: 0, issuedDelta: 0, acceptedDelta: 0,
      state: 'unknown', reviewPresent: false, timerArmed: false });
    assert.equal(heldRawDuringStop, 1);
    await until(() => f.controller.snapshot().socketReservations === 0);
    const fresh = await f.connected(); assert.ok(f.controller.connection(fresh));
    assert.deepEqual(f.stats(), { issued: before.issued + 1, accepted: before.accepted + 1, approvals: before.approvals + 1 });
  } finally { await f.close(); await nestedConnect; }
});

test('successful Cancel owns admission through the actual native close callout', { timeout: 10000 }, async t => {
  const f = await ownedTls({ holdReceiver: true });
  let nestedReview: ReturnType<typeof f.controller.review> | undefined, nestedConnect: ReturnType<typeof f.controller.connect> | undefined;
  try {
    const review = f.review(), connecting = f.controller.connect(review);
    await until(() => f.stats().accepted === 1);
    const before = f.stats(); let callouts = 0, heldRawDuringClose = 0;
    f.onNativeClose(() => {
      callouts++;
      heldRawDuringClose = f.controller.snapshot().socketReservations;
      nestedReview = f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' });
      if (nestedReview.ok) nestedConnect = f.controller.connect(nestedReview.value);
    });
    assert.equal(f.controller.cancel(review).ok, true); assert.deepEqual(await connecting, { ok: false, reason: 'cancelled' });
    await nextTurn(); if (f.stats().issued > before.issued) await until(() => f.stats().accepted > before.accepted);
    const snapshot = f.controller.snapshot(), stats = f.stats();
    const outcome = { callouts, nestedReview: nestedReview?.ok ? 'allowed' : nestedReview?.reason,
      approvalDelta: stats.approvals - before.approvals, issuedDelta: stats.issued - before.issued,
      acceptedDelta: stats.accepted - before.accepted, state: snapshot.state, timerArmed: snapshot.timerArmed };
    t.diagnostic(JSON.stringify(outcome));
    assert.deepEqual(outcome, { callouts: 1, nestedReview: 'busy', approvalDelta: 0, issuedDelta: 0, acceptedDelta: 0,
      state: 'unknown', timerArmed: false });
    assert.equal(heldRawDuringClose, 1);
    assert.deepEqual(await f.controller.connect(review), { ok: false, reason: 'stale' });
    await until(() => f.controller.snapshot().socketReservations === 0);
    f.resumeReceiver(); const fresh = await f.connected(); assert.ok(f.controller.connection(fresh));
    assert.deepEqual(f.stats(), { issued: before.issued + 1, accepted: before.accepted + 1, approvals: before.approvals + 1 });
  } finally { await f.close(); await nestedConnect; }
});

test('withdrawal restores the original busy reservation when cancellation interrupts admission', { timeout: 10000 }, async () => {
  const f = await ownedTls();
  try {
    for (const mode of ['disconnect', 'cancel'] as const) {
      const reviewed = f.review(); let nested: ReturnType<typeof f.controller.review> | undefined;
      f.onClock(read => {
        if (read !== 1) return;
        if (mode === 'disconnect') f.controller.disconnect(); else assert.equal(f.controller.cancel(reviewed).ok, true);
        nested = f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' });
      });
      assert.deepEqual(await f.controller.connect(reviewed), { ok: false, reason: 'cancelled' }); f.onClock(undefined);
      assert.deepEqual(nested, { ok: false, reason: 'busy' });
      assert.equal(f.controller.snapshot().state, 'unknown'); assert.equal(f.controller.snapshot().timerArmed, false);
      assert.deepEqual(f.stats(), { issued: 0, accepted: 0, approvals: 0 });
    }
    await f.connected(); assert.deepEqual(f.stats(), { issued: 1, accepted: 1, approvals: 1 });
  } finally { await f.close(); }
});

test('withdrawal owns admission through timer disarm and permits later explicit retry', { timeout: 10000 }, async () => {
  const f = await ownedTls(), nativeClear = globalThis.clearTimeout;
  try {
    for (const mode of ['disconnect', 'cancel'] as const) {
      const reviewed = f.review(); let armed = true, nested: ReturnType<typeof f.controller.review> | undefined;
      globalThis.clearTimeout = token => {
        if (armed) {
          armed = false;
          nested = f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' });
        }
        nativeClear(token);
      };
      if (mode === 'disconnect') f.controller.disconnect(); else assert.equal(f.controller.cancel(reviewed).ok, true);
      globalThis.clearTimeout = nativeClear;
      assert.equal(armed, false); assert.deepEqual(nested, { ok: false, reason: 'busy' });
      assert.equal(f.controller.snapshot().state, 'unknown'); assert.equal(f.controller.snapshot().timerArmed, false);
      assert.deepEqual(f.stats(), { issued: 0, accepted: 0, approvals: 0 });
    }
    await f.connected(); assert.deepEqual(f.stats(), { issued: 1, accepted: 1, approvals: 1 });
  } finally { globalThis.clearTimeout = nativeClear; await f.close(); }
});
