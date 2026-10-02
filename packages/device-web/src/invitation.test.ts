import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiverInvitation, decodeReceiverInvitation, decodeReceiverInvitationInput,
  encodeReceiverInvitation, encodeReceiverInvitationLink, receiverInvitationCurrent } from './invitation.ts';

const now = 1790916000000;
const scope = { applicationId: 'independent-pointer-surface', sessionId: 'owned-session' };
const make = () => createReceiverInvitation({ ...scope, now, randomBytes: length => new Uint8Array(length).fill(7) });

test('receiver invitations retain the locally chosen scope and bounded expiry as immutable data', () => {
  const value = make();
  assert.equal(value.epoch, '07'.repeat(16)); assert.equal(value.expiresAt, now + 300000);
  assert.equal(receiverInvitationCurrent(value, now), true);
  assert.equal(receiverInvitationCurrent(value, value.expiresAt), false);
  const parsed = decodeReceiverInvitation(encodeReceiverInvitation(value), now);
  assert.deepEqual(parsed, value); assert.ok(Object.isFrozen(parsed));
  assert.equal(parsed.applicationId, scope.applicationId); assert.equal(parsed.sessionId, scope.sessionId);
});

test('invitation parsing rejects stale, excessive, malformed and substituted envelopes', () => {
  const value = make();
  for (const override of [{ protocol: 'connect-manual' }, { version: 2 }, { epoch: '0'.repeat(31) },
    { applicationId: '' }, { sessionId: ' padded ' }, { expiresAt: now }, { expiresAt: now + 300001 }, { privateKey: 'ignored' }]) {
    assert.throws(() => decodeReceiverInvitation(JSON.stringify({ ...value, ...override }), now), TypeError);
  }
  assert.throws(() => decodeReceiverInvitation('x'.repeat(2049), now), TypeError);
  assert.throws(() => decodeReceiverInvitation(encodeReceiverInvitation(value), NaN), TypeError);
  assert.throws(() => createReceiverInvitation({ ...scope, now, randomBytes: () => new Uint8Array(15) }), TypeError);
  assert.throws(() => createReceiverInvitation({ ...scope, now: -1, randomBytes: length => new Uint8Array(length) }), TypeError);
});

test('shareable invitation links carry only the bounded fragment and still require review', () => {
  const invitation = make();
  const link = encodeReceiverInvitationLink(invitation, 'https://host.example/pointer-lab');
  const url = new URL(link);
  assert.equal(url.pathname, '/pointer-lab');
  assert.equal(url.search, '');
  assert.ok(url.hash.startsWith('#invite='));
  assert.deepEqual(decodeReceiverInvitationInput(link, now), invitation);
  assert.deepEqual(decodeReceiverInvitationInput(encodeReceiverInvitation(invitation), now), invitation);
  assert.throws(() => decodeReceiverInvitationInput(link, invitation.expiresAt), TypeError);
  for (const bad of [
    link.replace('/pointer-lab#', '/devices#'),
    link.replace('/pointer-lab#', '/pointer-lab?redirect=https://evil.example/#'),
    link.replace('#invite=', '#other='),
    link.replace('https://', 'javascript://'),
    link.replace('host.example/', 'user:secret@host.example/'),
    link + 'extra',
  ]) assert.throws(() => decodeReceiverInvitationInput(bad, now), TypeError);
  assert.throws(() => encodeReceiverInvitationLink(invitation, 'https://user:secret@host.example/pointer-lab'), TypeError);
  assert.throws(() => encodeReceiverInvitationLink(invitation, 'https://host.example/pointer-lab?x=1'), TypeError);
});
