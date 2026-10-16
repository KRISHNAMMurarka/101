// Bind a current native observation to independently provisioned owner configuration.
// Discovery metadata never supplies endpoint identity or resource authority.
import { assessDiscoveryCandidate, parseDiscoveryCandidate } from '@101/device-model';
import { createInvitationConnectionController } from '@101/connect';

/**
 * Compose an actual native snapshot row with an explicit, trusted owner mapping
 * to an independently provisioned endpoint. Neither service metadata nor a
 * mapping receipt supplies endpoint URL/key authenticity or resource authority.
 */
export function createNativeInvitationReview({ native, row, ownerMapping, endpoint, identity, crypto, now, authorizeConnect }) {
  if (!native || !row?.handle || !ownerMapping || !endpoint || typeof now !== 'function') throw new TypeError('Invalid review composition');

  const initial = native.snapshot();
  const issuedRow = initial.rows.find(current => current.handle === row.handle);
  // Pin the actual controller-issued row and candidate. A caller cannot pair a
  // valid opaque handle with a substituted candidate object.
  if (!issuedRow || row.candidate !== issuedRow.candidate) throw new TypeError('Native row is not the current issued snapshot');
  const observed = parseDiscoveryCandidate(issuedRow.candidate);
  if (observed.evidence.length !== 1 || observed.evidence[0].stage !== 'observed' || observed.evidence[0].kind !== 'observation' ||
      native.assess(issuedRow.handle)?.state !== 'observed') throw new TypeError('Native observation is stale or not issued by this controller');

  // Pin every scalar/function identity used to admit the enrollment. Live
  // callbacks may report currentness; they cannot replace these identities.
  const mappingPin = Object.freeze({
    object: ownerMapping,
    endpointId: ownerMapping.endpointId,
    ownerId: ownerMapping.ownerId,
    generation: ownerMapping.generation,
    expiresAt: ownerMapping.expiresAt,
    receiptId: ownerMapping.receiptId,
    isCurrent: ownerMapping.isCurrent,
  });
  const endpointPin = Object.freeze({
    object: endpoint,
    id: endpoint.id,
    endpoint: endpoint.endpoint,
    remoteKeyId: endpoint.remoteKeyId,
    expiresAt: endpoint.expiresAt,
    isCurrent: endpoint.isCurrent,
    createSocket: endpoint.createSocket,
  });
  if (mappingPin.endpointId !== endpointPin.id || !Number.isSafeInteger(mappingPin.generation) || mappingPin.generation < 1 ||
      !Number.isSafeInteger(mappingPin.expiresAt) || typeof mappingPin.isCurrent !== 'function' ||
      typeof mappingPin.receiptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(mappingPin.receiptId) ||
      typeof mappingPin.ownerId !== 'string' || typeof endpointPin.endpoint !== 'string' ||
      typeof endpointPin.remoteKeyId !== 'string' || !Number.isSafeInteger(endpointPin.expiresAt) ||
      typeof endpointPin.isCurrent !== 'function') throw new TypeError('Invalid owner mapping or endpoint snapshot');

  const observedEvidence = observed.evidence[0];
  const at = now();
  const identifiedExpiresAt = Math.min(observed.expiresAt, mappingPin.expiresAt, endpointPin.expiresAt);
  if (!Number.isSafeInteger(at) || at < observedEvidence.at || at >= identifiedExpiresAt) throw new TypeError('Owner mapping or endpoint expired');
  // Preserve the issued candidate expiry and first observation evidence bytes.
  // The new identity evidence carries the tighter effective deadline; the SDK
  // invitation controller takes the minimum across evidence/endpoint expiry.
  const candidate = parseDiscoveryCandidate({
    schemaVersion: 1,
    id: observed.id,
    scope: observed.scope,
    expiresAt: observed.expiresAt,
    recovery: { action: 'review-identity', hint: 'Review the saved receiver and invitation.' },
    evidence: [observedEvidence, {
      stage: 'identified', kind: 'identity', candidateId: observed.id, scope: observed.scope,
      receiptId: mappingPin.receiptId, at, expiresAt: identifiedExpiresAt,
    }],
  });

  let closed = false;
  function sameEndpointSnapshot() {
    return endpoint === endpointPin.object && endpoint.id === endpointPin.id && endpoint.endpoint === endpointPin.endpoint &&
      endpoint.remoteKeyId === endpointPin.remoteKeyId && endpoint.expiresAt === endpointPin.expiresAt &&
      endpoint.isCurrent === endpointPin.isCurrent && endpoint.createSocket === endpointPin.createSocket;
  }
  function sameMappingSnapshot() {
    return ownerMapping === mappingPin.object && ownerMapping.endpointId === mappingPin.endpointId &&
      ownerMapping.ownerId === mappingPin.ownerId && ownerMapping.generation === mappingPin.generation &&
      ownerMapping.expiresAt === mappingPin.expiresAt && ownerMapping.receiptId === mappingPin.receiptId &&
      ownerMapping.isCurrent === mappingPin.isCurrent;
  }
  function currentIssuedRow() {
    const current = native.snapshot().rows.find(value => value.handle === issuedRow.handle);
    return current === undefined ? undefined : current.handle === issuedRow.handle && current.candidate === issuedRow.candidate ? current : undefined;
  }
  const isCurrent = () => {
    if (closed || !sameEndpointSnapshot() || !sameMappingSnapshot()) return false;
    const nowAtCheck = now();
    if (!Number.isSafeInteger(nowAtCheck) || nowAtCheck < at || nowAtCheck >= identifiedExpiresAt) return false;
    const endpointCurrent = endpointPin.isCurrent() === true;
    const mappingCurrent = mappingPin.isCurrent() === true;
    if (!endpointCurrent || !mappingCurrent || !sameEndpointSnapshot() || !sameMappingSnapshot()) return false;
    const liveRow = currentIssuedRow();
    if (!liveRow || native.assess(liveRow.handle)?.state !== 'observed') return false;
    const assessment = assessDiscoveryCandidate(candidate, candidate.scope, nowAtCheck, (_candidate, evidence) => {
      if (!currentIssuedRow() || !sameEndpointSnapshot() || !sameMappingSnapshot()) return false;
      if (evidence.stage === 'observed') {
        return evidence.receiptId === observedEvidence.receiptId && evidence.at === observedEvidence.at &&
          evidence.expiresAt === observedEvidence.expiresAt && native.assess(issuedRow.handle)?.state === 'observed';
      }
      const endpointStillCurrent = endpointPin.isCurrent() === true;
      const mappingStillCurrent = mappingPin.isCurrent() === true;
      return evidence.stage === 'identified' && evidence.receiptId === mappingPin.receiptId &&
        evidence.expiresAt === identifiedExpiresAt && endpointStillCurrent && mappingStillCurrent &&
        sameEndpointSnapshot() && sameMappingSnapshot();
    });
    if (assessment.state !== 'identified') return false;
    // The evidence/currentness callbacks above are reentrant. Re-read the
    // issued row and its native assessment after the final callback before
    // returning true to the invitation controller, which only rechecks time.
    if (!sameEndpointSnapshot() || !sameMappingSnapshot()) return false;
    const finalRow = currentIssuedRow();
    if (!finalRow || native.assess(finalRow.handle)?.state !== 'observed') return false;
    return sameEndpointSnapshot() && sameMappingSnapshot() && currentIssuedRow() !== undefined;
  };
  if (!isCurrent()) throw new TypeError('Owner mapping is no longer current');

  const endpointEnrollment = Object.freeze({
    id: endpointPin.id,
    endpoint: endpointPin.endpoint,
    remoteKeyId: endpointPin.remoteKeyId,
    expiresAt: endpointPin.expiresAt,
    isCurrent: () => {
      if (!sameEndpointSnapshot()) return false;
      const current = endpointPin.isCurrent() === true;
      return current && sameEndpointSnapshot();
    },
    ...(endpointPin.createSocket ? { createSocket: endpointPin.createSocket } : {}),
  });
  const controller = createInvitationConnectionController({
    ownerId: mappingPin.ownerId, identity, crypto, now,
    endpoints: [endpointEnrollment],
    discoveryEnrollments: [{ endpointId: endpointPin.id, candidate, generation: mappingPin.generation, isCurrent }],
    authorizeConnect,
  });
  // Construction and all trusted host callbacks above can be reentrant. Recheck
  // before returning the adapter; SDK review/connect perform their own checks.
  if (!isCurrent()) { controller.close(); throw new TypeError('Owner mapping changed during review setup'); }
  return Object.freeze({ candidate,
    review(invitationText, source) {
      if (closed || !isCurrent()) return Object.freeze({ ok: false, reason: 'revoked' });
      return controller.reviewDiscovered(candidate, invitationText, { source, endpointId: endpointPin.id });
    },
    connect(review) { return closed ? Promise.resolve(Object.freeze({ ok: false, reason: 'closed' })) : controller.connect(review); },
    connection(handle) { return closed ? undefined : controller.connection(handle); },
    cancel(review) { return controller.cancel(review); },
    close() { if (closed) return; closed = true; controller.close(); },
    snapshot() { return controller.snapshot(); },
  });
}
