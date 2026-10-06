import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { createGatewayInventoryConnector, GATEWAY_INVENTORY_LIMITS, SCOPED_AGENT_IPC_SOURCE_SHA256 } from '@101/hub-server';
import { assessDiscoveryCandidate } from '@101/connect';
import { createOwnedNodeAgentGateway } from './node-agent-gateway.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Actual owned child -> current SDK read -> selected native mTLS inventory API.
 * Inventory grants and sensitive RSS read/delivery grants remain independent. */
export async function runGatewayInventoryExample(options) {
  const checks = [], instances = [], connectors = [], scopes = [];
  let allowResource = false, resourceGrant = new AbortController();
  const grantControllers = [];
  const makeGateway = () => {
    const owner = new AbortController(), registration = new AbortController(), read = new AbortController(), qualification = new AbortController(), visibility = new AbortController();
    grantControllers.push(owner, registration, read, qualification, visibility);
    const gateway = createOwnedNodeAgentGateway({ ...options, ownerId: 'owned-gateway-operator', ownerSignal: owner.signal,
      registrationSignal: registration.signal, readSignal: read.signal, qualificationSignal: qualification.signal, visibilitySignal: visibility.signal,
      authorizeResource(request) { if (!allowResource || resourceGrant.signal.aborted) return;
        return { request, signal: resourceGrant.signal, expiresAt: performance.now() + 500 }; } });
    instances.push(gateway); return gateway;
  };
  const serverPin = createHash('sha256').update(new X509Certificate(options.coordinator.serverCertificatePem).raw).digest('hex');
  function connector(state, allow = true, grant = new AbortController()) {
    const owner = new AbortController(); grantControllers.push(owner, grant);
    const api = createGatewayInventoryConnector({ endpoint: state.endpoint, origin: options.origin, caCertificatePem: options.coordinator.clientCaCertificatePem,
      certificatePem: options.peer.certificatePem, privateKeyPem: options.peer.privateKeyPem, serverCertificateSha256: serverPin,
      ownerId: 'owned-gateway-operator', gatewayId: 'owned-node-rss-gateway', sessionId: state.sessionId, peerId: state.peerId, token: state.token, signal: owner.signal,
      authorizeInventory(request) {
        if (!allow) return;
        assert.ok(Object.isFrozen(request)); assert.equal(request.endpoint, state.endpoint); assert.equal(request.sessionId, state.sessionId);
        assert.equal(request.peerId, state.peerId); assert.equal(request.serverCertificateSha256, serverPin);
        scopes.push({ action: request.action, method: request.method, profile: request.profile });
        return { request, signal: grant.signal, expiresAt: performance.now() + 1500 };
      } });
    connectors.push(api); return { api, owner, grant };
  }
  let nativeReads = 0, sdkQualificationReads = 0, actualResourceReads = 0;
  try {
    const gateway = makeGateway(); assert.equal(gateway.status().native.starts, 0);
    checks.push('construction-is-inert-no-native-child-or-gateway-listener');
    const state = await gateway.start(); nativeReads += gateway.status().rawQualificationReads; sdkQualificationReads += gateway.status().qualifiedRoutes;
    assert.equal(nativeReads, 1); assert.equal(sdkQualificationReads, 1);
    checks.push('separate-owned-native-child-own-memoryUsage-RSS-is-qualified-through-current-public-SDK-read');
    const denied = connector(state, false);
    assert.deepEqual(await denied.api.list({ purpose: 'review-owned-gateway', signal: denied.owner.signal }), { ok: false, reason: 'denied' });
    assert.equal(denied.api.status().networkRequests, 0); checks.push('inventory-owner-denial-dispatches-zero-native-HTTP');
    const visible = connector(state), result = await visible.api.list({ purpose: 'review-owned-gateway', signal: visible.owner.signal }); assert.ok(result.ok);
    assert.equal(result.value.snapshot.scope.id, state.sessionId); assert.equal(result.value.snapshot.resources.length, 1);
    const resource = result.value.snapshot.resources[0]; assert.equal(resource.id, state.resourceId);
    assert.deepEqual(resource.capabilities, [{ id: 'rss', semantic: 'example:owned-process-rss', kind: 'property', schemaVersion: 1 }]);
    assert.equal(resource.expiresAt, state.advertisedUntil);
    assert.equal(assessDiscoveryCandidate(result.value.candidates[0], result.value.snapshot.scope, result.value.snapshot.issuedAt, () => false).state, 'unverified');
    assert.equal(JSON.stringify(result.value).includes('rssBytes'), false); assert.equal(JSON.stringify(result.value).includes('sourceTime'), false);
    for (const secret of [state.token, options.peer.privateKeyPem, options.peer.certificatePem]) assert.equal(JSON.stringify(result).includes(secret), false);
    checks.push('actual-selected-mTLS-host-visibility-yields-only-closed-inert-resource-metadata', 'typed-label-and-capability-hints-never-authenticate-authorize-or-mark-ready',
      'native-RSS-reading-clocks-private-key-and-bearer-excluded-from-inventory-and-receipt');
    let received = 0;
    const sink = state.runtime.registerSink({ device: state.sinkDescriptor, capability: 'rss', apply(observation, context) {
      if (!context.signal.aborted && context.isCurrent() && !resourceGrant.signal.aborted) { assert.ok(state.sameActualSample(observation)); received++; }
    }, release() {} }); state.runtime.setReadiness(sink, 'available');
    const request = { from: state.source, to: sink, ...state.scope, sourceOperation: 'read', queueCapacity: 1, leaseMs: 500 };
    assert.equal(state.runtime.route(request).start().ok, false); assert.equal(received, 0);
    checks.push('inventory-visibility-cannot-create-sensitive-resource-read-or-result-delivery-grant');
    allowResource = true;
    const route = state.runtime.route(request), revoke = () => route.stop('separate-resource-grant-revoked'); resourceGrant.signal.addEventListener('abort', revoke, { once: true });
    assert.ok(route.start().ok); state.runtime.flush(); assert.equal(received, 1); actualResourceReads++;
    resourceGrant.abort(); route.stop(); resourceGrant.signal.removeEventListener('abort', revoke);
    assert.equal(state.runtime.route(request).start().ok, false); state.runtime.unregister(sink);
    checks.push('independent-current-resource-approval-delivers-actual-original-sample-and-clock-provenance', 'resource-revocation-remains-separate-from-metadata-visibility');
    await state.revokeVisibility(); const hidden = await visible.api.list({ purpose: 'review-after-revoke', signal: visible.owner.signal }); assert.ok(hidden.ok);
    assert.equal(hidden.value.snapshot.resources.length, 0); checks.push('actual-host-visibility-revoke-withdraws-resource');
    await state.crash(); assert.equal(gateway.status().sourceCurrent, false); assert.equal(gateway.status().native.nativeChildren, 0);
    assert.throws(() => state.runtime.registerSource({ device: state.device, capability: 'rss' }), 'Retired owned runtime cannot be re-opened');
    const unavailable = await visible.api.list({ purpose: 'review-after-loss', signal: visible.owner.signal }); assert.deepEqual(unavailable, { ok: false, reason: 'unavailable' });
    assert.equal(state.runtime.route(request).start().ok, false);
    checks.push('actual-child-crash-retires-source-epoch-and-owned-inventory-issuer', 'inaccessible-stopped-gateway-is-unavailable-no-fallback-or-scan');
    await gateway.close();
    allowResource = false; resourceGrant = new AbortController();
    const replacement = makeGateway(), freshState = await replacement.start(); nativeReads += replacement.status().rawQualificationReads; sdkQualificationReads += replacement.status().qualifiedRoutes;
    assert.notEqual(freshState.resourceId, state.resourceId); assert.notEqual(freshState.endpoint, state.endpoint); assert.notEqual(freshState.token, state.token);
    const fresh = connector(freshState), retried = await fresh.api.list({ purpose: 'fresh-reviewed-gateway', signal: fresh.owner.signal }); assert.ok(retried.ok);
    assert.equal(retried.value.snapshot.resources[0].id, freshState.resourceId);
    checks.push('fresh-explicit-agent-registration-qualification-session-visibility-and-inventory-grant-required');
    const untilExpiry = freshState.advertisedUntil - Date.now() + 20; if (untilExpiry > 0) await pause(untilExpiry);
    const expired = await fresh.api.list({ purpose: 'review-quiet-expiry', signal: fresh.owner.signal }); assert.ok(expired.ok); assert.equal(expired.value.snapshot.resources.length, 0);
    checks.push('actual-wall-clock-advertisement-expiry-yields-no-guessed-capabilities');
    fresh.grant.abort(); assert.equal((await fresh.api.list({ purpose: 'revoked-inventory-grant', signal: fresh.owner.signal })).ok, false);
    checks.push('revoked-inventory-approval-cannot-be-reused');
  } finally {
    resourceGrant.abort(); for (const grant of grantControllers) grant.abort();
    await Promise.all(connectors.map(connector => connector.close())); await Promise.all(instances.map(gateway => gateway.close()));
  }
  for (const connector of connectors) { assert.equal(connector.status().rawPending, 0); assert.equal(connector.status().timers, 0); }
  for (const gateway of instances) { const status = gateway.status(); assert.equal(status.native.nativeChildren, 0); assert.equal(status.native.nativePending, 0);
    assert.equal(status.native.timers, 0); assert.equal(status.native.cleanupVerified, true); }
  checks.push('all-owned-child-socket-directory-TLS-request-timer-and-runtime-resources-settled');
  return { result: 'pass', profile: 'authorized-node-agent-gateway-inventory/1', node: process.version, platform: process.platform,
    checks, nativeQualificationReads: nativeReads, SDKQualificationReads: sdkQualificationReads, separatelyApprovedSensitiveReads: actualResourceReads,
    childCodeSha256: SCOPED_AGENT_IPC_SOURCE_SHA256, approvalScopes: scopes, limits: GATEWAY_INVENTORY_LIMITS,
    syntheticPositiveResponses: false, cleanup: { nativeChildren: 0, nativePending: 0, requestTimers: 0, ownedListeners: 0, ownedDirectories: 0 },
    excluded: ['physical-router', 'vendor-router-API', 'LAN-scanning', 'isolated-network-reachability', 'remote', 'account-authentication', 'phone', 'UI', 'arbitrary-URL', 'physical-sensor'] };
}
