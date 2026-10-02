import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeManualPeerCode, encodeManualPeerCode } from './manual-peer.ts';

const epoch = '0123456789abcdef0123456789abcdef';
const offer = { type: 'offer' as const, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n' };
test('manual descriptions round trip with the shared epoch and expected offer/answer', () => {
  const code = encodeManualPeerCode(epoch, offer);
  assert.deepEqual(decodeManualPeerCode(code, 'offer'), { protocol: 'connect-manual', version: 1, epoch, description: offer });
  assert.throws(() => decodeManualPeerCode(code, 'answer'));
  assert.throws(() => decodeManualPeerCode(code, 'offer', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  const answer = { ...offer, type: 'answer' as const };
  assert.equal(decodeManualPeerCode(encodeManualPeerCode(epoch, answer), 'answer', epoch).description.type, 'answer');
});
test('manual parser rejects malformed, versioned, oversized and authority-bearing envelopes', () => {
  const valid = JSON.parse(encodeManualPeerCode(epoch, offer));
  for (const changed of [ { ...valid, version: 2 }, { ...valid, endpoint: 'arbitrary-owner' }, { ...valid, epoch: '0'.repeat(33) },
    { ...valid, description: { ...offer, type: 'rollback' } }, { ...valid, description: { ...offer, principalId: 'owner' } },
    { ...valid, description: { ...offer, sdp: '' } }, { ...valid, description: { ...offer, sdp: 'é'.repeat(40000) } } ]) {
    assert.throws(() => decodeManualPeerCode(JSON.stringify(changed), 'offer'));
  }
  for (const code of ['', '{', 'null', '[]', ' '.repeat(65537)]) assert.throws(() => decodeManualPeerCode(code, 'offer'));
});
test('decoded descriptions are immutable and no identity assurance is encoded', () => {
  const decoded = decodeManualPeerCode(encodeManualPeerCode(epoch, offer), 'offer');
  assert.equal(Object.isFrozen(decoded), true); assert.equal(Object.isFrozen(decoded.description), true);
  assert.deepEqual(Object.keys(decoded).sort(), ['description', 'epoch', 'protocol', 'version']);
});
