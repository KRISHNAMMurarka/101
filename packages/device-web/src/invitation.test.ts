import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiverInvitation, decodeReceiverInvitation, encodeReceiverInvitation, receiverInvitationCurrent } from './invitation.ts';

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
