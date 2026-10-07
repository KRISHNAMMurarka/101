import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvitationConnectionController } from './invitation-connection.ts';
import type { InvitationConnectionOptions, InvitationConnectionGrant, InvitationConnectionScope } from './invitation-connection.ts';
import { createReceiverInvitation, encodeReceiverInvitation } from './invitation.ts';
import { createEphemeralWebIdentity, webEndpointCrypto } from './web-identity.ts';
import type { WebSocketPort } from '@101/transport-websocket';
import { parseDiscoveryCandidate } from '@101/device-model';

const candidate = () => parseDiscoveryCandidate({ schemaVersion: 1, id: 'receiver-device', scope: { kind: 'directory', id: 'owned-directory' },
  expiresAt: 5000, recovery: { action: 'request-access', hint: 'Review this receiver.' },
  evidence: [{ stage: 'observed', kind: 'observation' }, { stage: 'identified', kind: 'identity' }].map(e => ({ ...e,
    candidateId: 'receiver-device', scope: { kind: 'directory', id: 'owned-directory' }, receiptId: 'host-receipt-generation-3', at: 1000, expiresAt: 5000 })) });
async function fixture(old = false) {
  let at = 1000, generation = 3, discovered = true, enrolled = true, approvals = 0, sockets = 0;
  let authorize: InvitationConnectionOptions['authorizeConnect'] = scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true });
  const identity = await createEphemeralWebIdentity(), hint = candidate();
  const invitation = createReceiverInvitation({ applicationId: 'owned-app', sessionId: 'owned-session', now: at, randomBytes: webEndpointCrypto.randomBytes });
  const options = { ownerId: 'owner', identity, crypto: webEndpointCrypto, now: () => at,
    endpoints: [{ id: 'receiver', endpoint: 'wss://127.0.0.1:7443/connect', remoteKeyId: '1'.repeat(64), expiresAt: 10000,
      isCurrent: () => enrolled, createSocket() { sockets++; let readyState = 0;
        const raw: WebSocketPort = { get readyState() { return readyState; }, protocol: '101-resource-wss-1', bufferedAmount: 0, binaryType: 'arraybuffer',
          onopen: null, onclose: null, onmessage: null, onerror: null, send() {}, close() { readyState = 3; raw.onclose?.({}); } }; return raw; } }],
    authorizeConnect(scope: InvitationConnectionScope) { approvals++; return authorize(scope); },
    ...(old ? {} : { discoveryEnrollments: [{ endpointId: 'receiver', candidate: hint, generation: 3, isCurrent: () => discovered && generation === 3 }] }) };
  const controller = createInvitationConnectionController(options);
  return { controller, hint, invitation, approvals: () => approvals, sockets: () => sockets,
    time(n: number) { at = n; }, lose() { discovered = false; }, generation(n: number) { generation = n; }, unenroll() { enrolled = false; },
    authorize(f: typeof authorize) { authorize = f; },
    review(input: unknown = hint) { return controller.reviewDiscovered(input, encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'receiver' }); } };
}

test('discovered receiver review needs an independently enrolled composition API', async () => {
  const f = await fixture(true);
  try { assert.equal(typeof f.controller.reviewDiscovered, 'function', 'OLD fixed invitation endpoints have no discovered-candidate composition'); }
  finally { f.controller.close(); }
});

test('candidate arrival and explicit review are inert and expose both independent enrollment and discovery pins', async () => {
  const f = await fixture();
  try { assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0); const reviewed = f.review(); assert.equal(reviewed.ok, true);
    assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0); assert.deepEqual(f.controller.snapshot().pending?.discovery,
      { candidateId: f.hint.id, scope: f.hint.scope, generation: 3, expiresAt: 5000 });
    assert.equal(f.controller.snapshot().pending?.endpoint, 'wss://127.0.0.1:7443/connect'); assert.equal(f.controller.snapshot().pending?.remoteKeyId, '1'.repeat(64));
  } finally { f.controller.close(); }
});

test('spoofed scope/receipt/lifetime/identity and unverified metadata cannot issue approval or socket', async () => {
  const f = await fixture();
  try { for (const hint of [{ ...f.hint, id: 'forged' }, { ...f.hint, scope: { kind: 'directory', id: 'other' } },
      { ...f.hint, expiresAt: 6000 }, { ...f.hint, evidence: f.hint.evidence.map(e => ({ ...e, receiptId: 'copied-unbound-receipt' })) },
      { ...f.hint, endpoint: 'wss://attacker.example/connect' }]) assert.equal(f.review(hint).ok, false);
    assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0);
  } finally { f.controller.close(); }
});

test('candidate expiry, generation loss and endpoint enrollment loss reject connection before approval', async () => {
  for (const loss of ['expiry', 'generation', 'endpoint'] as const) { const f = await fixture();
    try { const review = f.review(); assert.ok(review.ok); if (loss === 'expiry') f.time(5000); else if (loss === 'generation') f.generation(4); else f.unenroll();
      assert.equal((await f.controller.connect(review.value)).ok, false); assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0);
    } finally { f.controller.close(); }
  }
});

test('loss or Stop during held discovery approval fences socket and preserves raw approval accounting', async () => {
  for (const stop of [false, true]) { const f = await fixture(); let resolve!: (g: InvitationConnectionGrant) => void, captured!: InvitationConnectionScope;
    f.authorize(scope => { captured = scope; return new Promise(done => { resolve = done; }); });
    try { const review = f.review(); assert.ok(review.ok); const connecting = f.controller.connect(review.value);
      await Promise.resolve(); if (stop) f.controller.disconnect(); else { f.lose(); f.controller.sweep(); }
      assert.equal((await connecting).ok, false); assert.equal(f.controller.snapshot().unsettledAuthorizations, 1);
      resolve({ scope: captured, expiresAt: captured.deadline, isCurrent: () => true }); for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(f.sockets(), 0); assert.equal(f.controller.snapshot().unsettledAuthorizations, 0);
    } finally { f.controller.close(); }
  }
});

test('discovery generation checks cannot publish a review through reentrant Stop', async () => {
  const identity = await createEphemeralWebIdentity(); let stop = false;
  const hint = candidate(), invitation = createReceiverInvitation({ applicationId: 'app', sessionId: 'session', now: 1000, randomBytes: webEndpointCrypto.randomBytes });
  const controller = createInvitationConnectionController({ ownerId: 'owner', identity, crypto: webEndpointCrypto, now: () => 1000,
    endpoints: [{ id: 'receiver', endpoint: 'wss://127.0.0.1:7443/connect', remoteKeyId: '1'.repeat(64), expiresAt: 10000, isCurrent: () => true }],
    discoveryEnrollments: [{ endpointId: 'receiver', candidate: hint, generation: 3, isCurrent() { if (stop) controller.disconnect(); return true; } }],
    authorizeConnect: () => undefined });
  try { stop = true; assert.equal(controller.reviewDiscovered(hint, encodeReceiverInvitation(invitation), { source: 'manual', endpointId: 'receiver' }).ok, false);
    assert.equal(controller.snapshot().pending, undefined); assert.equal(controller.snapshot().timerArmed, false); assert.equal(controller.snapshot().issuedAttempts, 0);
  } finally { controller.close(); }
});
