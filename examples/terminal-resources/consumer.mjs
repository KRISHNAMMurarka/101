import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createDisposableLoopbackSshHost, SSH_METADATA_SOURCE_SHA256, SSH_OPERATION_SOURCE_SHA256, SSH_FIXTURE_DOCUMENT_SHA256 } from './disposable-host.mjs';
import { createScopedLoopbackSshConnector } from './ssh-connector.mjs';

const key = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
  request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
const metadataSchema = { type: 'record', fields: {
  profile: { type: 'enum', values: ['loopback-openssh-metadata/1'] }, platform: { type: 'enum', values: ['darwin'] },
  arch: { type: 'enum', values: ['arm64'] }, sourceTime: { type: 'scalar', unit: 'ms', min: 0, max: 60000 },
} };
const summarySchema = { type: 'record', fields: {
  profile: { type: 'enum', values: ['loopback-openssh-fixture-summary/1'] }, fixtureId: { type: 'enum', values: ['reviewed-document'] },
  sha256: { type: 'enum', values: [SSH_FIXTURE_DOCUMENT_SHA256] }, bytes: { type: 'scalar', unit: 'byte', min: 1, max: 1024 }, lines: { type: 'scalar', unit: 'count', min: 1, max: 1024 },
  sourceTime: { type: 'scalar', unit: 'ms', min: 0, max: 60000 },
} };
const metadataProfile = Object.freeze({ profile: 'loopback-openssh-metadata/1', operation: 'metadata', method: 'readMetadata', schema: metadataSchema });
const summaryProfile = Object.freeze({ profile: 'loopback-openssh-fixture-summary/1', operation: 'fixture-summary', method: 'readFixtureSummary', schema: summarySchema });
async function until(check) { const end = performance.now() + 2000;
  while (!check()) { assert.ok(performance.now() < end, 'Selected native SSH operation did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

/** Explicit disposable native SSH selection. Ordinary public SDK routes and
 * current owner consent are separate from native host/client authentication.
 * Native output stays private until an independent result route AND owner
 * result approval are current. No interactive terminal or remote host API. */
async function runProfile({ signal = new AbortController().signal } = {}, selected) {
  assert.ok(signal instanceof AbortSignal);
  const checks = [], receipts = [], cleanup = []; let previousIdentity;
  function current() { if (signal.aborted) throw Error('Selected SSH caller cancelled'); }
  for (let session = 1; session <= 2; session++) {
    current(); const host = await createDisposableLoopbackSshHost();
    let connector, runtime, commandRoute, viewerRoute, stopListener;
    const approved = new Set(), commands = new Map(), views = new Map(), consent = new Map(), consentListeners = [];
    function revokeConsent() { for (const owner of consent.values()) owner.abort(); consent.clear(); }
    function approveOwner(route) {
      consent.get(route.id)?.abort(); const owner = new AbortController(); consent.set(route.id, owner);
      consentListeners.push(route.onClose(() => { owner.abort(); if (consent.get(route.id) === owner) consent.delete(route.id); }));
    }
    let pending, operation = 0, viewed, ownerResultCalls = 0, cancelNext = false;
    const scope = Object.freeze({ principalId: 'local-ssh-owner', applicationId: 'selected-ssh-client', sessionId: 'fresh-' + session });
    const clockDomain = 'ssh-client-receipt:' + session;
    try {
      current(); assert.notEqual(host.identity.id, previousIdentity); previousIdentity = host.identity.id;
      runtime = createDeviceRuntime({ clockDomain, now: () => performance.now(), maxRoutes: 2, maxPendingDeliveries: 1, maxPendingDeliveriesPerScope: 1,
        authorize(request) { return !signal.aborted && approved.has(key(request)) ? { expiresAt: performance.now() + 2000, maxAgeMs: 1000, maxHz: 20 } : undefined; } });
      connector = createScopedLoopbackSshConnector({ host, credential: host.credential, hostKey: host.identity.hostKey, scope,
        authorize(request) {
          if (request.phase === 'result') ownerResultCalls++;
          const route = (request.phase === 'operation' ? commands : views).get(request.route.routeId);
          const permitted = !signal.aborted && host.status().current && route?.status().state === 'active' && consent.has(request.route.routeId) &&
            request.profile === selected.profile && request.operation === selected.operation &&
            request.resourceId === selected.operation + (request.phase === 'operation' ? '-command' : '-result') &&
            request.hostId === host.identity.id && request.credentialId === host.credential.id && request.hostKey === host.identity.hostKey &&
            request.scope.principalId === scope.principalId && request.scope.applicationId === scope.applicationId && request.scope.sessionId === scope.sessionId;
          return permitted ? { request, expiresAt: request.expiresAt, signal: consent.get(request.route.routeId).signal } : undefined;
        }, onNative(event) {
          if (cancelNext && event.stage === 'spawned') {
            cancelNext = false; commandRoute.stop('selected-job-cancelled');
            assert.equal(connector.status().rawPending, 1); assert.equal(host.status().nativePending, 1);
          }
        } });
      stopListener = () => { approved.clear(); revokeConsent(); commandRoute?.stop('caller-cancelled'); viewerRoute?.stop('caller-cancelled'); connector.close(); host.stop().catch(() => {}); };
      signal.addEventListener('abort', stopListener, { once: true });
      const capability = (id, kind, value, permissions, reliable, schemaVersion = 1, ownership) => ({ id, semantic: 'example:ssh-' + selected.operation + '-' + (id === 'control' || id === 'command' ? 'command' : 'result'),
        schemaVersion, kind, value, permissions, delivery: reliable ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxAgeMs: 1000, maxHz: 20 }, ...(ownership ? { ownership } : {}) });
      const device = parseDeviceDescriptor({ schemaVersion: 1, id: host.identity.id, label: 'Explicit disposable SSH ' + selected.operation, revision: 1,
        adapter: { id: 'example:loopback-openssh-' + selected.operation, version: '1.0.0' }, runtime: { platform: 'macos-node-openssh' }, capabilities: [
          capability('control', 'event', { type: 'boolean' }, ['subscribe'], true),
          capability('command', 'job', { type: 'boolean' }, ['invoke'], true, 1, { mode: 'exclusive' }),
          capability('result', 'property', selected.schema, ['subscribe'], false, 2),
          capability('viewer', 'property', selected.schema, ['write'], false, 2, { mode: 'observe' }),
        ] });
      const control = runtime.registerSource({ device, capability: 'control' }), resultSource = runtime.registerSource({ device, capability: 'result' });
      const command = runtime.registerSink({ device, capability: 'command', async apply(observation, context) {
        const pendingOperation = pending; assert.ok(pendingOperation); assert.equal(context.operationId, pendingOperation.operationId); assert.equal(observation.value, true);
        const result = await connector[selected.method](context); pendingOperation.resolve(result);
        if (!result.ok || !context.isCurrent() || context.signal.aborted) throw Error('Selected SSH operation unavailable');
        context.reportEvidence('target-acknowledged');
      }, release() { runtime.setReadiness(resultSource, 'unavailable'); } });
      const viewer = runtime.registerSink({ device, capability: 'viewer', apply(observation, context) {
        assert.ok(context.isCurrent() && !context.signal.aborted); viewed = observation;
      }, release() { viewed = undefined; } });
      for (const endpoint of [control, command, viewer]) runtime.setReadiness(endpoint, 'available');
      function route(from, to, sourceOperation, sinkOperation, allow) {
        if (allow) approved.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, sourceOperation, sinkOperation]));
        return runtime.route({ from, to, ...scope, sourceOperation, queueCapacity: 1, leaseMs: 1000 });
      }
      function begin(allowRuntime, allowOwner) {
        commandRoute = route(control, command, 'subscribe', 'invoke', allowRuntime); const started = commandRoute.start();
        if (!started.ok) return started;
        commands.set(commandRoute.id, commandRoute); if (allowOwner) approveOwner(commandRoute);
        const done = deferred(); pending = { ...done, operationId: String(++operation) };
        assert.ok(runtime.publish(control, true, { operationId: pending.operationId, deadline: performance.now() + 1000 }).ok); runtime.flush(); return done.promise;
      }
      assert.equal(begin(false, true).ok, false); assert.equal(host.status().attempts, 0); checks.push('actual-runtime-denial-before-native-dispatch-' + session); commandRoute.stop();
      const ownerDenied = await begin(true, false); current(); assert.equal(ownerDenied.reason, 'denied'); assert.equal(host.status().attempts, 0);
      await until(() => commandRoute.operations().at(-1)?.handlerResult === 'failed'); commandRoute.stop(); pending = undefined;
      checks.push('independent-current-operation-owner-consent-' + session);
      if (selected === summaryProfile) {
        cancelNext = true; const cancelled = await begin(true, true); assert.equal(cancelled.ok, false);
        await connector.drain(); assert.equal(connector.status().rawPending, 0); assert.equal(host.status().nativePending, 0);
        assert.equal(connector.status().retainedResults, 0); assert.equal(connector.status().issued, connector.status().settled);
        checks.push('issued-declared-job-cancelled-and-native-close-joined-' + session);
      }
      const result = await begin(true, true); current(); assert.equal(result.ok, true); assert.equal(result.value, undefined);
      await until(() => commandRoute.operations().at(-1)?.handlerResult === 'returned');
      runtime.setReadiness(resultSource, 'available', performance.now() + 1000);
      viewerRoute = route(resultSource, viewer, 'subscribe', 'write', false); assert.equal(viewerRoute.start().ok, false);
      assert.equal(viewed, undefined); assert.equal(ownerResultCalls, 0); viewerRoute.stop(); checks.push('sensitive-result-runtime-subscribe-default-deny-' + session);
      viewerRoute = route(resultSource, viewer, 'subscribe', 'write', true); assert.ok(viewerRoute.start().ok); views.set(viewerRoute.id, viewerRoute);
      // Host instrumentation delegates currentness to the actual owned runtime
      // Connection. Every observed route revocation propagates through its real
      // signal; hidden booleans do not serve as mutable authority tokens.
      const readerAbort = new AbortController(), unsubscribe = viewerRoute.onClose(() => readerAbort.abort()), unsubscribeCommand = commandRoute.onClose(() => readerAbort.abort());
      consentListeners.push(unsubscribe, unsubscribeCommand);
      const readContext = { signal: readerAbort.signal, routeId: viewerRoute.id, generation: 1, operationId: pending.operationId,
        isCurrent: () => viewerRoute.status().state === 'active' && commandRoute.status().state === 'active' && !signal.aborted };
      assert.equal(connector.readResult(result.handle, readContext).reason, 'denied'); assert.equal(viewed, undefined); checks.push('sensitive-result-owner-read-default-deny-' + session);
      approveOwner(viewerRoute); const privateRead = connector.readResult(result.handle, readContext); assert.equal(privateRead.ok, true); current();
      assert.ok(privateRead.value.clockId.startsWith(host.identity.clockId + ':'));
      assert.equal(privateRead.value.profile, selected.profile);
      if (selected === metadataProfile) { assert.equal(privateRead.value.platform, 'darwin'); assert.equal(privateRead.value.arch, 'arm64'); }
      else {
        // Independent caller expectation; actual counts and digest come from the
        // native producer's fixed owned document read, not this caller value.
        const expected = '101 reviewed fixture\nA declared SSH job counts only this document.\n';
        assert.equal(privateRead.value.fixtureId, 'reviewed-document');
        assert.equal(privateRead.value.bytes, Buffer.byteLength(expected)); assert.equal(privateRead.value.lines, expected.split('\n').length - 1);
        assert.equal(privateRead.value.sha256, createHash('sha256').update(expected).digest('hex'));
      }
      const { clockId: sourceClock, ...typedValue } = privateRead.value;
      const receivedAt = performance.now(); assert.ok(runtime.publish(resultSource, typedValue, { timestamp: receivedAt, clockDomain,
        provenance: { sourceTime: privateRead.value.sourceTime, sourceClock, nativeAuthentication: 'openssh-publickey-pinned-host' } }).ok);
      runtime.flush(); assert.ok(viewed); assert.deepEqual(viewed.value, typedValue); assert.equal(viewed.quality, 'valid'); assert.equal(viewed.clockDomain, clockDomain);
      assert.equal(viewed.provenance.sourceClock, privateRead.value.clockId); assert.equal(commandRoute.operations().at(-1).effectEvidence, 'target-acknowledged');
      checks.push('genuine-native-typed-' + selected.operation + '-delivered-by-public-runtime-' + session, 'separate-source-and-receipt-clock-provenance-' + session);
      const viewerOwner = consent.get(viewerRoute.id);
      runtime.revoke(viewerRoute); assert.equal(viewed, undefined); assert.equal(readerAbort.signal.aborted, true); assert.equal(viewerOwner.signal.aborted, true); unsubscribe(); unsubscribeCommand();
      assert.equal(connector.readResult(result.handle, readContext).ok, false); checks.push('result-revocation-erases-and-refuses-stale-handle-' + session);
      const status = connector.status(); assert.equal(status.rawPending, 0); assert.equal(status.retainedResults, 0); assert.equal(status.timerArmed, false);
      assert.equal(host.status().attempts, selected === summaryProfile ? 2 : 1); assert.equal(status.issued, status.settled);
      receipts.push({ session, hostIdentity: { address: host.identity.address, hostFingerprint: host.identity.hostFingerprint }, sourceClock: privateRead.value.clockId,
        ...(selected === metadataProfile ? { metadata: privateRead.value } : { operation: selected.operation, result: privateRead.value }), receivedAt, runtimeOperation: commandRoute.operations().at(-1), connectorStatus: status,
        hostSoftware: host.status().software, producerSha256: SSH_METADATA_SOURCE_SHA256, dispatcherSha256: SSH_OPERATION_SOURCE_SHA256,
        ...(selected === summaryProfile ? { fixtureDocumentSha256: SSH_FIXTURE_DOCUMENT_SHA256 } : {}), ownerResultCalls, ownerGrantContract: 'exact-request-expiry-native-abort-signal',
        resultRuntimeGrant: { sourceOperation: 'subscribe', sinkOperation: 'write', leaseMs: 1000, queueCapacity: 1, publishedFrames: 1, explicitRevoke: true } });
    } finally {
      if (stopListener) signal.removeEventListener('abort', stopListener);
      revokeConsent(); approved.clear(); commandRoute?.stop(); viewerRoute?.stop(); for (const unsubscribe of consentListeners) unsubscribe(); await connector?.close(); runtime?.close(); await host.stop();
      cleanup.push(host.status());
    }
  }
  checks.push('fresh-native-host-identity-and-explicit-fresh-approvals');
  assert.ok(cleanup.every(value => value.removedOwnedRoot && value.nativePending === 0 && !value.timerArmed));
  return { result: 'pass', profile: selected.profile, kind: 'actual-native-openssh-public-runtime', node: process.version,
    receipts, checks, cleanup, limits: { hostMs: 15000, operationMs: 2500, outputBytes: 1024, stderrBytes: 4096, nativePending: 1, runtimePending: 1, routeQueue: 1, auditRows: 64,
      resultSourceOperation: 'subscribe', resultSinkOperation: 'write', resultLeaseMs: 1000, resultPublishedFrames: 1 },
    exclusions: ['remote-hosts', 'interactive-terminal', 'arbitrary-command-or-path', 'PTY', 'forwarding', 'agent', 'credential-persistence',
      'OS-account-sandbox', 'malicious-same-user-host-isolation', 'cross-clock-source-freshness-mapping', 'undo-of-issued-native-operation', 'physical-device-qualification'] };
}

export const runTerminalResourcesExample = options => runProfile(options, metadataProfile);
export const runTerminalAllowedOperationsExample = options => runProfile(options, summaryProfile);

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) console.log(JSON.stringify({ ...await runTerminalResourcesExample(), allowedOperations: await runTerminalAllowedOperationsExample() }));
