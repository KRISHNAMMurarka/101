import assert from 'node:assert/strict';
import test from 'node:test';
import { assessDiscoveryCandidate, DeviceValidationError, parseDiscoveryCandidate } from './index.ts';

const scope = { kind: 'session', id: 'session-1' } as const;
const stages = ['observed', 'identified', 'authenticated', 'authorized', 'ready'] as const;
const kinds = ['observation', 'identity', 'peer-proof', 'resource-grant', 'live-probe'] as const;
const candidate = {
  schemaVersion: 1, id: 'candidate-1', scope, expiresAt: 1000,
  recovery: { action: 'rescan', hint: 'Scan for this device again.' },
  evidence: stages.map((stage, index) => ({
    stage, kind: kinds[index], candidateId: 'candidate-1', scope,
    receiptId: `trusted:${stage}`, at: 100 + index * 10, expiresAt: index === 4 ? 180 : 1000,
  })),
} as const;
const verify = (_candidate: unknown, evidence: { receiptId: string }) => evidence.receiptId.startsWith('trusted:');

test('candidate stages require scoped, fresh, host-verified evidence in sequence', () => {
  const parsed = parseDiscoveryCandidate(candidate);
  assert.deepEqual(parsed, candidate);
  assert.equal(Object.isFrozen(parsed.evidence[0]), true);
  assert.deepEqual(assessDiscoveryCandidate(parsed, scope, 150, verify),
    { state: 'ready', recovery: candidate.recovery });
  assert.deepEqual(assessDiscoveryCandidate(parsed, scope, 180, verify),
    { state: 'authorized', recovery: candidate.recovery });
  assert.deepEqual(assessDiscoveryCandidate(parsed, scope, 1000, verify),
    { state: 'expired', recovery: candidate.recovery });
  assert.deepEqual(assessDiscoveryCandidate(parsed, { kind: 'session', id: 'other' }, 150, verify),
    { state: 'out-of-scope', recovery: candidate.recovery });
  assert.deepEqual(assessDiscoveryCandidate(parsed, scope, 150, () => false),
    { state: 'unverified', recovery: candidate.recovery });
  assert.deepEqual(assessDiscoveryCandidate(parsed, scope, 150,
    (_c, e) => e.stage !== 'authenticated'), { state: 'identified', recovery: candidate.recovery });
});

test('later claims, copied receipts and skipped stages cannot promote a candidate', () => {
  for (const invalid of [
    { ...candidate, evidence: candidate.evidence.slice(1) },
    { ...candidate, evidence: [candidate.evidence[0], candidate.evidence[2]] },
    { ...candidate, evidence: [...candidate.evidence, candidate.evidence[4]] },
    { ...candidate, evidence: [{ ...candidate.evidence[0], candidateId: 'other' }] },
    { ...candidate, evidence: [{ ...candidate.evidence[0], scope: { kind: 'session', id: 'other' } }] },
    { ...candidate, evidence: [{ ...candidate.evidence[0], kind: 'resource-grant' }] },
    { ...candidate, evidence: [{ ...candidate.evidence[0], expiresAt: 1001 }] },
    { ...candidate, recovery: null },
    { ...candidate, extra: true },
  ]) assert.throws(() => parseDiscoveryCandidate(invalid), DeviceValidationError);
  const claimed = { ...candidate, evidence: [{ ...candidate.evidence[0], receiptId: 'untrusted:observed' }] };
  assert.equal(assessDiscoveryCandidate(claimed, scope, 150, verify).state, 'unverified');
});

test('discovery parsing is bounded and rejects getters without running them', () => {
  assert.throws(() => parseDiscoveryCandidate({ ...candidate, recovery: {
    ...candidate.recovery, hint: 'x'.repeat(513),
  } }), DeviceValidationError);
  assert.throws(() => parseDiscoveryCandidate({ ...candidate, expiresAt: 100 + 86_400_001 }), DeviceValidationError);
  assert.throws(() => assessDiscoveryCandidate(candidate, scope, Number.NaN, verify), DeviceValidationError);
  let reads = 0;
  const hostile = { ...candidate, get scope() { reads += 1; return scope; } };
  assert.throws(() => parseDiscoveryCandidate(hostile), DeviceValidationError);
  assert.equal(reads, 0);
});
