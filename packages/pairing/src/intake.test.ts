import assert from 'node:assert/strict';
import test from 'node:test';
import { createPairingIntake } from './intake.ts';
import { LocalSignalingBroker } from './index.ts';
import { encodePairingTicket, decodePairingTicket } from '@101/protocol';

function fixture() {
  let now = 10_000;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => 'a'.repeat(43) });
  const { ticket } = broker.createSession({ sessionId: 'ROOM101', endpoint: 'http://127.0.0.1:10101' });
  const code = encodePairingTicket(ticket);
  let parses = 0;
  const intake = createPairingIntake({ now: () => now, parse: (input, time) => { parses++; return decodePairingTicket(input, time); } });
  return { code, intake, get parses() { return parses; }, setNow(value: number) { now = value; } };
}

test('link and saved intake are inert; only the exact current reviewed candidate can be consumed once', () => {
  const f = fixture();
  const first = f.intake.receive(f.code, 'link');
  assert.equal(first.status, 'review');
  if (first.status !== 'review') throw Error('missing candidate');
  assert.equal(Object.isFrozen(first.candidate), true);
  assert.equal(Object.isFrozen(first.candidate.ticket), true);
  assert.equal(f.intake.approve({ ...first.candidate }), false);
  const next = f.intake.receive(f.code, 'saved');
  assert.equal(next.status, 'review');
  if (next.status !== 'review') throw Error('missing candidate');
  assert.equal(f.intake.approve(first.candidate), false);
  assert.equal(f.intake.approve(next.candidate), true);
  assert.equal(f.intake.approve(next.candidate), false);
});

test('repeated invalid camera scans and oversized outer inputs do not repeatedly invoke the decoder', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.intake.receive('unrelated camera QR', 'scan');
  assert.equal(f.parses, 1);
  f.setNow(11_000);
  for (let i = 0; i < 100; i++) f.intake.receive(`${' '.repeat(8193)}${f.code}`, 'scan');
  assert.equal(f.parses, 1);
  f.setNow(12_000);
  for (let i = 0; i < 100; i++) f.intake.receive(`different-${i}`, 'scan');
  assert.equal(f.parses, 9);
});

test('expiry, clock rollback and cancellation invalidate reviewed input before any caller can dispatch', () => {
  const f = fixture();
  let result = f.intake.receive(f.code, 'paste');
  if (result.status !== 'review') throw Error('missing candidate');
  f.setNow(result.candidate.ticket.expiresAt);
  assert.equal(f.intake.approve(result.candidate), false);
  f.setNow(10_000);
  assert.equal(f.intake.receive(f.code, 'link').status, 'invalid-clock');
  const other = fixture();
  result = other.intake.receive(other.code, 'link');
  if (result.status !== 'review') throw Error('missing candidate');
  other.intake.clear();
  assert.equal(other.intake.approve(result.candidate), false);
});

test('reentrant parser cancellation cannot leave an orphan candidate to approve', () => {
  const f = fixture();
  const intake = createPairingIntake({ now: () => 10_000, parse: (input, now) => { intake.clear(); return decodePairingTicket(input, now); } });
  assert.equal(intake.receive(f.code, 'link').status, 'cancelled');
});

test('parser accessors cannot change the reviewed expiry during a snapshot', () => {
  const f = fixture();
  let reads = 0;
  const intake = createPairingIntake({ now: () => 10_000, parse: (input, now) => {
    const ticket = decodePairingTicket(input, now);
    return Object.defineProperty({ ...ticket }, 'expiresAt', { enumerable: true, get() { reads++; return reads <= 2 ? 20_000 : 2_000_000_000_000; } });
  } });
  assert.equal(intake.receive(f.code, 'paste').status, 'invalid');
  assert.equal(reads, 0, 'accessors are not evaluated');
});

test('a new scan session can review the same still-live code without resetting its rate budget', () => {
  const f = fixture();
  assert.equal(f.intake.receive(f.code, 'scan').status, 'review');
  assert.equal(f.intake.receive(f.code, 'scan').status, 'unchanged');
  f.intake.clear();
  assert.equal(f.intake.receive(f.code, 'scan').status, 'review');
  for (let i = 0; i < 6; i++) { f.intake.clear(); f.intake.receive(f.code, 'scan'); }
  f.intake.clear();
  assert.equal(f.intake.receive(f.code, 'scan').status, 'rate-limited');
});
