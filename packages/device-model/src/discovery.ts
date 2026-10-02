import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import type { JsonObject, JsonValue } from './descriptor.ts';

export type DiscoveryStage = 'observed' | 'identified' | 'authenticated' | 'authorized' | 'ready';
export interface DiscoveryScope {
  readonly kind: 'local' | 'application' | 'session' | 'directory';
  readonly id: string;
}
export interface DiscoveryEvidence {
  readonly stage: DiscoveryStage;
  readonly kind: 'observation' | 'identity' | 'peer-proof' | 'resource-grant' | 'live-probe';
  readonly candidateId: string;
  readonly scope: DiscoveryScope;
  /** An opaque host receipt identifier, never a URL or credential to fetch. */
  readonly receiptId: string;
  readonly at: number;
  readonly expiresAt: number;
}
export interface DiscoveryRecovery {
  readonly action: 'rescan' | 'reinvite' | 'review-identity' | 'request-access' | 'retry-connection';
  readonly hint: string;
}
export interface DiscoveryCandidate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: DiscoveryScope;
  readonly expiresAt: number;
  readonly recovery: DiscoveryRecovery;
  /** Ordered claims. Parsing does not verify their receipt identifiers. */
  readonly evidence: readonly DiscoveryEvidence[];
}
export type DiscoveryAssessment = Readonly<{
  state: DiscoveryStage | 'unverified' | 'out-of-scope' | 'expired';
  recovery: DiscoveryRecovery;
}>;
export type DiscoveryReceiptVerifier = (candidate: DiscoveryCandidate, evidence: DiscoveryEvidence) => boolean;

const STAGES = ['observed', 'identified', 'authenticated', 'authorized', 'ready'] as const;
const KINDS = ['observation', 'identity', 'peer-proof', 'resource-grant', 'live-probe'] as const;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_LIFETIME_MS = 86_400_000;

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: JsonValue, path: string): JsonObject {
  if (input === null || Array.isArray(input) || typeof input !== 'object') fail('discovery-object', path);
  return input;
}
function closed(value: JsonObject, fields: readonly string[], path: string): void {
  if (Object.keys(value).length !== fields.length ||
      fields.some(field => !Object.hasOwn(value, field)) ||
      Object.keys(value).some(field => !fields.includes(field))) fail('discovery-fields', path);
}
function label(value: JsonValue, path: string, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value ||
      Array.from(value).some(character => { const code = character.charCodeAt(0);
        return code < 32 || code === 127 || code >= 128 && code <= 159; })) fail('discovery-label', path);
  return value;
}
function timestamp(value: JsonValue, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('discovery-time', path);
  return value;
}
function scope(input: JsonValue, path: string): DiscoveryScope {
  const value = object(input, path);
  closed(value, ['kind', 'id'], path);
  if (!['local', 'application', 'session', 'directory'].includes(value.kind as string))
    fail('discovery-scope', `${path}.kind`);
  label(value.id, `${path}.id`, 128);
  return value as unknown as DiscoveryScope;
}

/** Parses bounded, inert discovery claims. Receipt IDs have no authority until a host verifies them. */
export function parseDiscoveryCandidate(input: unknown): DiscoveryCandidate {
  const value = object(snapshotJson(input), '$');
  closed(value, ['schemaVersion', 'id', 'scope', 'expiresAt', 'recovery', 'evidence'], '$');
  if (value.schemaVersion !== 1) fail('discovery-version', '$.schemaVersion');
  const id = label(value.id, '$.id', 128);
  const candidateScope = scope(value.scope, '$.scope');
  const expiresAt = timestamp(value.expiresAt, '$.expiresAt');
  const recovery = object(value.recovery, '$.recovery');
  closed(recovery, ['action', 'hint'], '$.recovery');
  if (!['rescan', 'reinvite', 'review-identity', 'request-access', 'retry-connection'].includes(recovery.action as string))
    fail('discovery-recovery', '$.recovery.action');
  label(recovery.hint, '$.recovery.hint', 512);
  const evidence = value.evidence;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > STAGES.length)
    fail('discovery-evidence', '$.evidence');
  let previousAt = 0;
  evidence.forEach((entry, index) => {
    const path = `$.evidence[${index}]`;
    const item = object(entry, path);
    closed(item, ['stage', 'kind', 'candidateId', 'scope', 'receiptId', 'at', 'expiresAt'], path);
    if (item.stage !== STAGES[index] || item.kind !== KINDS[index]) fail('discovery-stage', path);
    if (item.candidateId !== id) fail('discovery-candidate', `${path}.candidateId`);
    const itemScope = scope(item.scope, `${path}.scope`);
    if (itemScope.kind !== candidateScope.kind || itemScope.id !== candidateScope.id)
      fail('discovery-scope', `${path}.scope`);
    const receiptId = label(item.receiptId, `${path}.receiptId`, 128);
    if (!RECEIPT_ID.test(receiptId)) fail('discovery-receipt', `${path}.receiptId`);
    const at = timestamp(item.at, `${path}.at`);
    const itemExpiry = timestamp(item.expiresAt, `${path}.expiresAt`);
    if (at < previousAt || at >= itemExpiry || itemExpiry > expiresAt)
      fail('discovery-time', path);
    previousAt = at;
  });
  const first = evidence[0] as JsonObject;
  if (expiresAt - (first.at as number) > MAX_LIFETIME_MS)
    fail('discovery-lifetime', '$.expiresAt');
  return value as unknown as DiscoveryCandidate;
}

/** Requires the caller's trusted verifier to bind every receipt to this candidate, scope and stage. */
export function assessDiscoveryCandidate(input: unknown, expectedScope: DiscoveryScope, now: number,
  verifyReceipt: DiscoveryReceiptVerifier): DiscoveryAssessment {
  const candidate = parseDiscoveryCandidate(input);
  const expected = scope(snapshotJson(expectedScope), '$.expectedScope');
  if (!Number.isSafeInteger(now) || now < 0) fail('discovery-time', '$.now');
  if (typeof verifyReceipt !== 'function') fail('discovery-verifier', '$.verifyReceipt');
  const result = (state: DiscoveryAssessment['state']): DiscoveryAssessment =>
    Object.freeze({ state, recovery: candidate.recovery });
  if (candidate.scope.kind !== expected.kind || candidate.scope.id !== expected.id) return result('out-of-scope');
  if (now >= candidate.expiresAt) return result('expired');
  let stage: DiscoveryAssessment['state'] = 'unverified';
  for (const evidence of candidate.evidence) {
    if (now < evidence.at || now >= evidence.expiresAt || verifyReceipt(candidate, evidence) !== true) break;
    stage = evidence.stage;
  }
  return result(stage);
}
