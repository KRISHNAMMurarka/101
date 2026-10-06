import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiverInvitation, encodeReceiverInvitation, encodeReceiverInvitationLink } from './invitation.ts';
import { createEphemeralWebIdentity, webEndpointCrypto } from './web-identity.ts';
import { SecureWebSocketTransport } from '@101/transport-websocket';
import type { WebSocketPort } from '@101/transport-websocket';
import type { InvitationConnectionGrant, InvitationConnectionScope } from './invitation-connection.ts';
const api = await import('./invitation-connection.ts').catch(() => undefined);
const endpoint = 'wss://127.0.0.1:7443/owned-receiver', remoteKeyId = '1'.repeat(64);
const need = <T>(result: { ok: true; value: T } | { ok: false; reason: string }): T => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };
function port(): WebSocketPort {
  let state = 0;
  return { get readyState() { return state; }, protocol: '101-resource-wss-1', bufferedAmount: 0, binaryType: 'arraybuffer',
    onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() { state = 2; } };
}
async function fixture() {
  assert.ok(api, 'explicit invitation connection needs a real owned controller');
  let at = 1000, enrolled = true, allowed = true, authorizations = 0;
  let authorize: (scope: InvitationConnectionScope) => InvitationConnectionGrant | undefined | Promise<InvitationConnectionGrant | undefined> = scope =>
    allowed ? { scope, expiresAt: scope.deadline, isCurrent: () => allowed } : undefined;
  const issued: { url: string; socket: WebSocketPort }[] = [], identity = await createEphemeralWebIdentity();
  const invitation = createReceiverInvitation({ applicationId: 'actual:local-reading', sessionId: 'owned-session', now: at,
    randomBytes: webEndpointCrypto.randomBytes });
  const controller = api.createInvitationConnectionController({ ownerId: 'local-owner', identity, crypto: webEndpointCrypto, now: () => at,
    endpoints: [{ id: 'owned-receiver', endpoint, remoteKeyId, expiresAt: 500000, isCurrent: () => enrolled,
      createSocket(url) { const socket = port(); issued.push({ url, socket }); return socket; } }],
    authorizeConnect(scope) { authorizations++; return authorize(scope); } });
  return { controller, invitation, issued, time(value: number) { at = value; }, enroll(value: boolean) { enrolled = value; }, allow(value: boolean) { allowed = value; },
    authorize(value: typeof authorize) { authorize = value; }, authorizations: () => authorizations,
    review(input = encodeReceiverInvitation(invitation)) { return need(controller.review(input, { source: 'manual', endpointId: 'owned-receiver' })); } };
}

test('held consent cannot open an expired genuine invitation or release unresolved authorization reservations early', async () => {
  if (process.env.D02_UNSAFE_COMPOSITION_BASELINE === '1') {
    let at = 1000, sockets = 0;
    const invitation = createReceiverInvitation({ applicationId: 'actual:local-reading', sessionId: 'owned-session', now: at, randomBytes: webEndpointCrypto.randomBytes });
    const transport = new SecureWebSocketTransport({ endpoint, side: 'client', now: () => at, createSocket() { sockets++; return port(); } });
    // The existing helper has no invitation ownership. This deliberately unsafe composition
    // is a baseline, not a claim that the current pointer App has this defect.
    at = invitation.expiresAt; await transport.connect(); await transport.disconnect();
    assert.equal(sockets, 0, 'an expired invitation must not issue a socket after held consent'); return;
  }
  const f = await fixture(); let release!: (value: InvitationConnectionGrant | undefined) => void, captured!: InvitationConnectionScope;
  f.authorize(scope => { captured = scope; return new Promise(resolve => { release = resolve; }); });
  try {
    const review = f.review(), connecting = f.controller.connect(review);
    await new Promise(resolve => setTimeout(resolve, 0));
    f.time(f.invitation.expiresAt); f.controller.sweep();
    assert.equal((await connecting).ok, false); assert.equal(f.issued.length, 0);
    assert.equal(f.controller.snapshot().unsettledAuthorizations, 1);
    release({ scope: captured, expiresAt: captured.deadline, isCurrent: () => true }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.controller.snapshot().unsettledAuthorizations, 0); assert.equal(f.issued.length, 0);
  } finally { f.controller.close(); }
});

test('manual, link and QR text stay inert and use only the independently chosen enrolled endpoint', async () => {
  const f = await fixture();
  try {
    for (const source of ['manual', 'link', 'qr'] as const) {
      const input = source === 'manual' ? encodeReceiverInvitation(f.invitation) : encodeReceiverInvitationLink(f.invitation, 'https://carrier.example/pointer-lab');
      need(f.controller.review(input, { source, endpointId: 'owned-receiver' }));
    }
    assert.equal(f.authorizations(), 0); assert.equal(f.issued.length, 0);
    assert.equal(f.controller.snapshot().pending?.endpoint, endpoint); assert.equal(f.controller.snapshot().pending?.remoteKeyId, remoteKeyId);
    assert.equal(f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'unknown' }).ok, false);
    assert.equal(f.controller.snapshot().outcome, 'unsupported');
  } finally { f.controller.close(); }
});

test('denied consent, forged review handles and a copied grant cannot open any socket', async () => {
  const f = await fixture();
  try {
    const review = f.review(); assert.equal((await f.controller.connect({ ...review })).ok, false);
    f.allow(false); assert.deepEqual(await f.controller.connect(review), { ok: false, reason: 'denied' }); assert.equal(f.issued.length, 0);
    f.allow(true); f.authorize(scope => ({ scope: { ...scope, endpoint: 'wss://different.example/receiver' }, expiresAt: scope.deadline, isCurrent: () => true }));
    assert.equal((await f.controller.connect(f.review())).ok, false); assert.equal(f.issued.length, 0);
  } finally { f.controller.close(); }
});

test('cancel/close during held authorization fence late approval and permit only an explicitly reviewed retry', async () => {
  for (const closing of [false, true]) {
    const f = await fixture(); let resolve!: (value: InvitationConnectionGrant) => void, captured!: InvitationConnectionScope;
    f.authorize(scope => { captured = scope; return new Promise(done => { resolve = done; }); });
    const review = f.review(), pending = f.controller.connect(review);
    await new Promise(done => setTimeout(done, 0));
    if (closing) f.controller.close(); else need(f.controller.cancel(review));
    assert.equal((await pending).ok, false); resolve({ scope: captured, expiresAt: captured.deadline, isCurrent: () => true });
    await new Promise(done => setTimeout(done, 0)); assert.equal(f.issued.length, 0);
    if (!closing) { f.authorize(() => undefined); assert.equal((await f.controller.connect(f.review())).ok, false); }
    else assert.equal(f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' }).ok, false);
    f.controller.close();
  }
});

test('revocation closes an issued raw socket but honestly retains its reservation until the actual close event', async () => {
  const f = await fixture();
  try {
    const pending = f.controller.connect(f.review()); await new Promise(done => setTimeout(done, 0));
    assert.equal(f.issued[0]?.url, endpoint); assert.equal(f.controller.snapshot().socketReservations, 1);
    f.enroll(false); f.controller.sweep(); assert.equal((await pending).ok, false);
    assert.equal(f.issued[0]?.socket.readyState, 2); assert.equal(f.controller.snapshot().socketReservations, 1);
    f.issued[0]!.socket.onclose?.({}); assert.equal(f.controller.snapshot().socketReservations, 0);
  } finally { f.controller.close(); }
});


test('raw provider callback activation failure closes its already issued socket', async () => {
  assert.ok(api); const identity = await createEphemeralWebIdentity(); let closed = 0;
  const raw = port(); Object.defineProperty(raw, 'onmessage', { configurable: true, set() { throw new Error('native callback refused'); } });
  raw.close = () => { closed++; };
  const invitation = createReceiverInvitation({ applicationId: 'actual:local-reading', sessionId: 'owned-session', now: 1000, randomBytes: webEndpointCrypto.randomBytes });
  const controller = api.createInvitationConnectionController({ ownerId: 'local-owner', identity, crypto: webEndpointCrypto, now: () => 1000,
    endpoints: [{ id: 'owned-receiver', endpoint, remoteKeyId, expiresAt: 500000, isCurrent: () => true, createSocket: () => raw }],
    authorizeConnect: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  try { assert.equal((await controller.connect(need(controller.review(encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'owned-receiver' })))).ok, false);
    assert.equal(closed, 1, 'an issued native port cannot be abandoned after callback setter failure');
  } finally { controller.close(); }
});

test('closed endpoint records never invoke caller coercion during inert construction', async () => {
  assert.ok(api); const identity = await createEphemeralWebIdentity(); let coerced = 0;
  assert.throws(() => api.createInvitationConnectionController({ ownerId: 'local-owner', identity, crypto: webEndpointCrypto, now: () => 1000,
    endpoints: [{ id: 'owned-receiver', endpoint, remoteKeyId: { toString() { coerced++; return remoteKeyId; } } as unknown as string,
      expiresAt: 500000, isCurrent: () => true }], authorizeConnect: () => undefined }));
  assert.equal(coerced, 0);
});

test('approval snapshots reject accessor grants and reentrant closure before socket activation', async () => {
  for (const mode of ['accessor', 'close'] as const) {
    const f = await fixture(); let read = 0;
    f.authorize(scope => mode === 'accessor' ? { scope, get expiresAt() { read++; return scope.deadline; }, isCurrent: () => true } :
      { scope, expiresAt: scope.deadline, isCurrent: () => { f.controller.close(); return true; } });
    try { assert.equal((await f.controller.connect(f.review())).ok, false); assert.equal(f.issued.length, 0); assert.equal(read, 0); }
    finally { f.controller.close(); }
  }
});

test('one pending attempt, eight reviews per second, 32 lifetime attempts and 64 redacted transitions are enforced', async () => {
  const f = await fixture();
  try {
    f.authorize(() => undefined);
    for (let index = 0; index < 32; index++) { f.time(1000 + index * 1000); assert.equal((await f.controller.connect(f.review())).ok, false); }
    f.time(34000); assert.deepEqual(await f.controller.connect(f.review()), { ok: false, reason: 'capacity' });
    const state = f.controller.snapshot(); assert.equal(state.issuedAttempts, 32); assert.equal(state.transitions.length, 64);
    assert.ok(!JSON.stringify(state.transitions).includes(remoteKeyId));
    for (let index = 0; index < 7; index++) need(f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' }));
    assert.deepEqual(f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'owned-receiver' }), { ok: false, reason: 'capacity' });
  } finally { f.controller.close(); }
  const held = await fixture(); held.authorize(() => new Promise(() => {}));
  try { const review = held.review(), result = held.controller.connect(review);
    assert.deepEqual(await held.controller.connect(review), { ok: false, reason: 'busy' });
    held.controller.close(); assert.equal((await result).ok, false); assert.equal(held.controller.snapshot().unsettledAuthorizations, 1);
  } finally { held.controller.close(); }
});

test('a throwing or reentrant clock permanently closes owned work without arming a timer', async () => {
  assert.ok(api); const identity = await createEphemeralWebIdentity(); let failing = false;
  const controller = api.createInvitationConnectionController({ ownerId: 'local-owner', identity, crypto: webEndpointCrypto,
    now: () => { if (failing) { controller.close(); throw new Error('clock unavailable'); } return 1000; },
    endpoints: [{ id: 'owned-receiver', endpoint, remoteKeyId, expiresAt: 500000, isCurrent: () => true }], authorizeConnect: () => undefined });
  const invitation = createReceiverInvitation({ applicationId: 'actual:local-reading', sessionId: 'owned-session', now: 1000, randomBytes: webEndpointCrypto.randomBytes });
  failing = true; assert.equal(controller.review(encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'owned-receiver' }).ok, false);
  assert.equal(controller.snapshot().state, 'closed'); assert.equal(controller.snapshot().timerArmed, false);
});

test('an unsupported replacement review retires pending consent while retaining its raw reservation', async () => {
  const f = await fixture(); let release!: (value: InvitationConnectionGrant) => void, captured!: InvitationConnectionScope;
  f.authorize(scope => { captured = scope; return new Promise(resolve => { release = resolve; }); });
  try { const pending = f.controller.connect(f.review());
    assert.equal(f.controller.review(encodeReceiverInvitation(f.invitation), { source: 'manual', endpointId: 'unknown' }).ok, false);
    release({ scope: captured, expiresAt: captured.deadline, isCurrent: () => true }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.issued.length, 0, 'replaced pending review must not activate after a late approval');
    assert.equal((await pending).ok, false);
  } finally { f.controller.close(); }
});
