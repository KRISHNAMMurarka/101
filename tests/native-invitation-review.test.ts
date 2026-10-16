// Actual native/invitation controllers; the provider callback is a cooperative local fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeDiscoveryController, NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE } from '@101/device-runtime';
import { createNativeInvitationReview } from '../examples/native-discovery/invitation-review.mjs';
import { createInvitationConnectionController } from '../packages/device-web/src/invitation-connection.ts';
import { createEphemeralWebIdentity, webEndpointCrypto } from '../packages/device-web/src/web-identity.ts';
import { createReceiverInvitation, encodeReceiverInvitation } from '../packages/device-web/src/invitation.ts';
import type { InvitationConnectionScope } from '../packages/device-web/src/invitation-connection.ts';
import type { NativeDiscoveryProvider, NativeDiscoveryScope } from '@101/device-runtime';

const serviceType = '_101l2e8b429e._tcp';
const scope: NativeDiscoveryScope = { ownerId: 'owner', applicationId: 'local-software', sessionId: 'selected-session',
  serviceType, domain: 'local.', interfaceIndex: 14, profile: NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE, operation: 'observe' };

function nativeFixture() {
  let now = 1000, callbacks: Parameters<NativeDiscoveryProvider['open']>[1] | undefined;
  const provider: NativeDiscoveryProvider = { profile: NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE,
    open(_scope, value) { callbacks = value; return { stop() {} }; } };
  const native = createNativeDiscoveryController({ scope, now: () => now, provider,
    authorize(request) { return { scope: request, expiresAt: now + 20_000, isCurrent: () => true }; } });
  assert.equal(native.start().ok, true);
  callbacks?.event({ version: 1, type: 'resolved', interfaceIndex: 14, name: 'owned._101l2e8b429e._tcp.local.',
    serviceType, domain: 'local.', target: 'host.example.', port: 50927, txtHex: '0970726f66696c653d31' });
  const row = native.snapshot().rows[0]; assert.ok(row);
  return { native, row, now(value: number) { now = value; } };
}

async function fixture() {
  const n = nativeFixture(), identity = await createEphemeralWebIdentity();
  const invitation = createReceiverInvitation({ applicationId: 'owned-app', sessionId: 'owned-session', now: 1000,
    randomBytes: webEndpointCrypto.randomBytes });
  let mappingCurrent = true, endpointCurrent = true, approvals = 0, sockets = 0;
  const mapping = { endpointId: 'receiver', ownerId: 'owner', generation: 3, expiresAt: 9000,
    receiptId: 'owner-mapping-generation-3', isCurrent: () => mappingCurrent };
  const endpoint = { id: 'receiver', endpoint: 'wss://127.0.0.1:7443/connect', remoteKeyId: '1'.repeat(64), expiresAt: 9500,
    isCurrent: () => endpointCurrent, createSocket() { sockets++; throw new Error('No connect expected in review test'); } };
  const adapter = createNativeInvitationReview({ native: n.native, row: n.row, ownerMapping: mapping, endpoint,
    identity, crypto: webEndpointCrypto, now: () => 1000,
    authorizeConnect(scope: InvitationConnectionScope) { approvals++; return { scope, expiresAt: scope.deadline, isCurrent: () => true }; } });
  return { ...n, mapping, endpoint, adapter, invitation, approvals: () => approvals, sockets: () => sockets,
    mappingCurrent(value: boolean) { mappingCurrent = value; }, endpointCurrent(value: boolean) { endpointCurrent = value; } };
}

test('one-stage native observation remains refused by the existing invitation API before approval/socket', async () => {
  const f = await fixture(), identity = await createEphemeralWebIdentity();
  try {
    assert.equal(f.row.candidate.evidence.length, 1);
    assert.throws(() => createInvitationConnectionController({ ownerId: 'owner', identity, crypto: webEndpointCrypto,
      now: () => 1000, endpoints: [f.endpoint], discoveryEnrollments: [{ endpointId: 'receiver', candidate: f.row.candidate,
        generation: 3, isCurrent: () => true }], authorizeConnect(scope) { throw new Error('must not authorize ' + scope.endpointId); } }));
    assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0);
  } finally { f.adapter.close(); f.native.close(); }
});

test('explicit mapping preserves native observation and uses boolean identified currentness with effective expiry', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.row.candidate.evidence[0]);
    assert.equal(f.adapter.candidate.expiresAt, f.row.candidate.expiresAt);
    assert.equal(JSON.stringify(f.adapter.candidate.evidence[0]), before);
    assert.equal(f.adapter.candidate.evidence[1]?.expiresAt, Math.min(f.row.candidate.expiresAt, f.mapping.expiresAt, f.endpoint.expiresAt));
    assert.equal(f.adapter.candidate.evidence[1]?.stage, 'identified');
    const result = f.adapter.review(encodeReceiverInvitation(f.invitation), 'manual');
    assert.equal(result.ok, true); assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0);
    f.mappingCurrent(false);
    assert.deepEqual(f.adapter.review(encodeReceiverInvitation(f.invitation), 'manual'), { ok: false, reason: 'revoked' });
    assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0);
  } finally { f.adapter.close(); f.native.close(); }
});

test('valid opaque handle paired with a substituted candidate object is refused', async () => {
  const f = await fixture(), identity = await createEphemeralWebIdentity();
  try {
    const substituted = { ...f.row, candidate: { ...f.row.candidate, id: 'substituted-candidate' } };
    assert.throws(() => createNativeInvitationReview({ native: f.native, row: substituted, ownerMapping: f.mapping,
      endpoint: f.endpoint, identity, crypto: webEndpointCrypto, now: () => 1000,
      authorizeConnect: () => undefined }), /current issued snapshot/);
    assert.equal(f.approvals(), 0); assert.equal(f.sockets(), 0);
  } finally { f.adapter.close(); f.native.close(); }
});


test('final mapping callback cannot withdraw native row and still authorize socket', async () => {
  const f = await fixture(), identity = await createEphemeralWebIdentity();
  let armed = false, calls = 0, sockets = 0;
  const mapping = { ...f.mapping, isCurrent() { if (armed && ++calls === 4) f.native.stop(); return true; } };
  const endpoint = { ...f.endpoint, createSocket() { sockets++; throw new Error('stale native row must refuse before socket'); } };
  const adapter = createNativeInvitationReview({ native: f.native, row: f.row, ownerMapping: mapping,
    endpoint, identity, crypto: webEndpointCrypto, now: () => 1000, authorizeConnect: () => ({ scope: {}, expiresAt: 9000, isCurrent: () => true }) });
  try {
    armed = true; calls = 0;
    const staleReview = adapter.review(encodeReceiverInvitation(f.invitation), 'manual');
    assert.notEqual(staleReview.ok, true);
    assert.equal(sockets, 0);
  } finally { adapter.close(); f.adapter.close(); f.native.close(); }
});
