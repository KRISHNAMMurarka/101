import assert from 'node:assert/strict';
import test from 'node:test';
import * as protocol from './index.ts';

const now = 1_000;
const ticket = { version: 2, sessionId: 'PAIR101', endpoint: 'http://192.168.1.20:10101', joinToken: 't'.repeat(32), expiresAt: now + 60_000, hostName: 'Living Room', transport: 'webrtc' } as const;
const code = protocol.encodePairingTicket(ticket);
function envelope(extra: Record<string, unknown>) {
  const value = JSON.parse(Buffer.from(code.slice(6), 'base64url').toString()) as Record<string, unknown>;
  return `101L2.${Buffer.from(JSON.stringify({ ...value, ...extra })).toString('base64url')}`;
}

test('ticket decoding rejects invalid clocks, excessive future lifetime and additional envelope fields', () => {
  for (const clock of [NaN, Infinity, -1, 1.5]) assert.throws(() => protocol.decodePairingTicket(code, clock));
  assert.throws(() => protocol.decodePairingTicket(protocol.encodePairingTicket({ ...ticket, expiresAt: now + 86_400_001 }), now));
  assert.throws(() => protocol.decodePairingTicket(envelope({ endpointIdentity: 'copied-name' }), now));
});

test('ticket parsing rejects ambiguous endpoint paths, query credentials and getters without executing them', () => {
  for (const endpoint of ['http://localhost:10101/api', 'http://localhost:10101?token=secret', 'http://localhost:10101/%2e%2e', 'http://localhost:10101/\u0085']) assert.throws(() => protocol.encodePairingTicket({ ...ticket, endpoint }));
  let reads = 0;
  assert.throws(() => protocol.encodePairingTicket({ ...ticket, get joinToken() { reads++; return ticket.joinToken; } }));
  assert.equal(reads, 0);
});

test('bounded shared pairing intake returns immutable inert tickets for actual legacy links', () => {
  assert.equal(typeof protocol.parsePairingInput, 'function');
  assert.equal(typeof protocol.pairingCodeFromInput, 'function');
  const links = [code, `https://host.local/controller?pair=${code}&session=PAIR101`, `oneohone://pair?ticket=${code}`];
  for (const value of links) {
    assert.equal(protocol.pairingCodeFromInput(value), code);
    const decoded = protocol.parsePairingInput(value, now);
    assert.deepEqual(decoded, ticket);
    assert.ok(Object.isFrozen(decoded));
  }
  const bad = [`${code}${' '.repeat(4097)}`, `${' '.repeat(8193)}${code}`, `ftp://host/controller?pair=${code}`, `https://host/not-controller?pair=${code}`, `https://user:password@host/controller?pair=${code}`, `https://host/controller?pair=${code}&pair=${code}`, `oneohone://other?ticket=${code}`, `oneohone://pair?ticket=${code}&pair=${code}`, `https://host/controller?pair=${code}#credential`, `https://host/controller?pair=${code}&session=OTHER101`];
  for (const value of bad) assert.throws(() => protocol.parsePairingInput(value, now));
});
